"""Bridge digital twin: a local server that behaves like a Hue bridge, backed by
a :class:`Recording`.

- Serves the same endpoints a real bridge does: ``GET /api/0/config``,
  ``POST /api`` (pairing, with a virtual link button), the CLIP v2 resource
  endpoints and the ``/eventstream/clip/v2`` SSE stream, over HTTPS with a
  certificate whose CN is the recorded bridge id (or plain HTTP).
- Replays the recorded event timeline at configurable speed, applying each
  event to its state so ``GET``\\ s and the stream stay consistent.
- Applies writes (``PUT light/...``, ``PUT grouped_light/...``, scene recall)
  to the state and echoes them as events, like the real bridge.
- Exposes a control API under ``/__twin/*`` (press the button, inject events,
  drive the replay, reset, export the current state as a new recording) so
  tests and agents can script scenarios from outside the process.
"""

from __future__ import annotations

import copy
import json
import secrets
import ssl
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from ..model.index_store import ResourceIndex
from ..tls import fingerprint_of, parse_certificate
from ..types import HueEvent, Resource
from .recording import RECORDING_VERSION, RecordedEvent, RecordedRequest, Recording

_TRANSIENT_FIELDS = frozenset({"dynamics", "alert", "identify", "recall", "dimming_delta", "color_temperature_delta"})
_CAPABILITY_FIELDS = ("color_temperature", "color", "dimming")
Sender = Callable[[int, Any], None]


@dataclass(slots=True)
class ReplayState:
    running: bool
    #: Virtual position on the recorded timeline, in ms.
    position_ms: int
    speed: float
    loop: bool
    total_events: int
    next_event_index: int
    duration_ms: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _pem_to_der(pem: str) -> bytes:
    return ssl.PEM_cert_to_DER_cert(pem)


def generate_certificate(bridge_id: str, directory: Path) -> tuple[Path, Path]:
    """Generates a self-signed EC certificate with CN = bridge id using the ``openssl`` binary."""
    directory.mkdir(parents=True, exist_ok=True)
    cert_path, key_path = directory / "cert.pem", directory / "key.pem"
    try:
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:prime256v1",
                "-nodes",
                "-keyout",
                str(key_path),
                "-out",
                str(cert_path),
                "-days",
                "3650",
                "-subj",
                f"/C=NL/O=Philips Hue/CN={bridge_id}",
            ],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as err:
        raise RuntimeError(f"Could not generate a certificate with openssl ({err}). Install openssl or use scheme='http'.") from err
    return cert_path, key_path


def load_or_generate_certificate(bridge_id: str, directory: Path | None) -> tuple[Path, Path, Path | None]:
    """Reuses ``cert.pem``/``key.pem`` in ``directory`` when they match the bridge id and are valid;
    otherwise generates new ones. Returns (cert, key, temp dir to clean up or None)."""
    if directory is None:
        tmp = Path(tempfile.mkdtemp(prefix="hue-twin-"))
        cert, key = generate_certificate(bridge_id, tmp)
        return cert, key, tmp
    cert_path, key_path = directory / "cert.pem", directory / "key.pem"
    if cert_path.exists() and key_path.exists():
        try:
            parsed = parse_certificate(_pem_to_der(cert_path.read_text("utf-8")))
            if (parsed.subject_cn or "").lower() == bridge_id and (parsed.not_after is None or parsed.not_after > datetime.now(UTC)):
                return cert_path, key_path, None
        except (ValueError, IndexError):
            pass
    cert, key = generate_certificate(bridge_id, directory)
    return cert, key, None


class BridgeSimulator:
    """See module docstring. Create with :meth:`start`; stop with :meth:`close`."""

    def __init__(
        self,
        recording: Recording,
        *,
        scheme: str = "https",
        host: str = "127.0.0.1",
        port: int = 0,
        application_key: str | None = None,
        link_button_pressed: bool = False,
        replay_speed: float = 1.0,
        replay_loop: bool = False,
        control_api: bool = True,
        certificate_dir: Path | str | None = None,
        certificate: tuple[Path, Path] | None = None,
        latency_s: float = 0.0,
    ) -> None:
        self.recording = recording.clone()
        self._initial_resources = copy.deepcopy(self.recording.resources)
        self.index = ResourceIndex()
        self.index.replace_all(copy.deepcopy(self._initial_resources))
        self.bridge_id = self.recording.bridge_id
        self.scheme = scheme
        self.host = host
        self._port = port
        self.application_key = application_key or secrets.token_urlsafe(30)
        self._link_button = link_button_pressed
        self.control_api = control_api
        self.latency_s = latency_s
        self._certificate_dir = Path(certificate_dir) if certificate_dir else None
        self._certificate = certificate
        self._tmp_dir: Path | None = None
        self.fingerprint = ""
        self.cert_pem = ""
        self.requests: list[RecordedRequest] = []
        self.emitted: list[RecordedEvent] = []
        self._streams: set[Any] = set()
        self._lock = threading.RLock()
        self._started_at = time.monotonic()
        self._event_counter = 0
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        # replay engine
        self._replay_running = False
        self._replay_anchor_wall = 0.0
        self._replay_anchor_pos = 0.0
        self._replay_speed = replay_speed
        self._replay_loop = replay_loop
        self._next_event_index = 0
        self._replay_timer: threading.Timer | None = None

    # ---------- lifecycle ----------

    @classmethod
    def start(cls, recording: Recording, *, autostart_replay: bool = True, **kwargs: Any) -> BridgeSimulator:
        sim = cls(recording, **kwargs)
        sim.serve()
        if autostart_replay:
            sim.replay_start()
        return sim

    def serve(self) -> None:
        if self._server is not None:
            return
        sim = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args: Any) -> None:  # silence
                return

            def do_GET(self) -> None:
                sim._handle(self)

            def do_POST(self) -> None:
                sim._handle(self)

            def do_PUT(self) -> None:
                sim._handle(self)

            def do_DELETE(self) -> None:
                sim._handle(self)

        server = ThreadingHTTPServer((self.host, self._port), Handler)
        server.daemon_threads = True
        if self.scheme == "https":
            if self._certificate is not None:
                cert_path, key_path = self._certificate
            else:
                cert_path, key_path, self._tmp_dir = load_or_generate_certificate(self.bridge_id, self._certificate_dir)
            self.cert_pem = cert_path.read_text("utf-8")
            self.fingerprint = fingerprint_of(_pem_to_der(self.cert_pem))
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(str(cert_path), str(key_path))
            server.socket = ctx.wrap_socket(server.socket, server_side=True)
        self._server = server
        self._thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, name="hue-twin", daemon=True)
        self._thread.start()

    @property
    def port(self) -> int:
        assert self._server is not None, "simulator not started"
        return int(self._server.server_address[1])

    @property
    def url(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}"

    def close(self) -> None:
        self.replay_pause()
        self.drop_streams()
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._tmp_dir is not None:
            for p in self._tmp_dir.iterdir():
                p.unlink(missing_ok=True)
            self._tmp_dir.rmdir()
            self._tmp_dir = None

    def __enter__(self) -> BridgeSimulator:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---------- scripted interaction ----------

    @property
    def link_button_pressed(self) -> bool:
        return self._link_button

    def press_link_button(self) -> None:
        """Simulates pressing the physical link button (valid for the next pairing request)."""
        self._link_button = True

    @property
    def resources(self) -> list[Resource]:
        return self.index.all()

    def emit(self, event: HueEvent) -> None:
        """Broadcasts an event and applies it to the state."""
        self._apply_and_broadcast(event)

    def update_resource(self, rtype: str, rid: str, patch: dict[str, Any]) -> None:
        """Applies a partial update to a resource and emits the matching ``update`` event."""
        existing = self.index.get(rtype, rid)
        data: Resource = {**patch, "id": rid, "type": rtype}
        if existing is not None and existing.get("owner") is not None and "owner" not in data:
            data["owner"] = existing["owner"]
        self._apply_and_broadcast(self._event("update", [data]))

    def drop_streams(self) -> None:
        """Closes every open event stream (simulates the bridge dropping connections)."""
        with self._lock:
            streams = list(self._streams)
            self._streams.clear()
        for handler in streams:
            try:
                handler.connection.shutdown(2)
            except OSError:
                pass

    def reset(self) -> None:
        """Restores the initial state and rewinds the replay (keeps pairing state)."""
        self.replay_pause()
        with self._lock:
            self.index.replace_all(copy.deepcopy(self._initial_resources))
            self._next_event_index = 0
            self._replay_anchor_pos = 0.0
            self.emitted.clear()
            self.requests.clear()

    def export_recording(self, label: str | None = None) -> Recording:
        """Exports the current state plus everything emitted since start as a new recording."""
        return Recording(
            version=RECORDING_VERSION,
            recorded_at=datetime.now(UTC).isoformat(),
            duration_ms=int((time.monotonic() - self._started_at) * 1000),
            label=label,
            config=copy.deepcopy(self.recording.config),
            host=self.host,
            certificate=self.recording.certificate,
            resources=copy.deepcopy(self.index.all()),
            events=copy.deepcopy(self.emitted),
            requests=copy.deepcopy(self.requests),
        )

    # ---------- replay ----------

    def replay_position(self) -> float:
        if self._replay_running:
            return self._replay_anchor_pos + (time.monotonic() - self._replay_anchor_wall) * 1000 * self._replay_speed
        return self._replay_anchor_pos

    def replay_state(self) -> ReplayState:
        return ReplayState(
            running=self._replay_running,
            position_ms=round(self.replay_position()),
            speed=self._replay_speed,
            loop=self._replay_loop,
            total_events=len(self.recording.events),
            next_event_index=self._next_event_index,
            duration_ms=self.recording.duration_ms,
        )

    def replay_start(self) -> None:
        with self._lock:
            if self._replay_running:
                return
            self._replay_running = True
            self._replay_anchor_wall = time.monotonic()
            self._schedule_next()

    def replay_pause(self) -> None:
        with self._lock:
            if not self._replay_running:
                return
            self._replay_anchor_pos = self.replay_position()
            self._replay_running = False
            if self._replay_timer is not None:
                self._replay_timer.cancel()
                self._replay_timer = None

    def replay_seek(self, offset_ms: float) -> None:
        """Jumps to an offset; events before it are applied silently (state only, no broadcast)."""
        with self._lock:
            was_running = self._replay_running
            self.replay_pause()
            if offset_ms < self._replay_anchor_pos:
                self.index.replace_all(copy.deepcopy(self._initial_resources))
                self._next_event_index = 0
            events = self.recording.events
            while self._next_event_index < len(events) and events[self._next_event_index].offset_ms <= offset_ms:
                self.index.apply(events[self._next_event_index].event)
                self._next_event_index += 1
            self._replay_anchor_pos = float(offset_ms)
            if was_running:
                self.replay_start()

    def replay_set_speed(self, speed: float) -> None:
        if speed <= 0:
            raise ValueError("speed must be > 0")
        with self._lock:
            was_running = self._replay_running
            self.replay_pause()
            self._replay_speed = speed
            if was_running:
                self.replay_start()

    def _schedule_next(self) -> None:
        if not self._replay_running:
            return
        events = self.recording.events
        if self._next_event_index >= len(events):
            end = max(self.recording.duration_ms, events[-1].offset_ms if events else 0)
            remaining_s = max(0.0, (end - self.replay_position()) / 1000 / self._replay_speed)

            def finish() -> None:
                with self._lock:
                    if not self._replay_running:
                        return
                    self.replay_pause()
                    if self._replay_loop:
                        self.index.replace_all(copy.deepcopy(self._initial_resources))
                        self._next_event_index = 0
                        self._replay_anchor_pos = 0.0
                        self.replay_start()

            self._replay_timer = threading.Timer(remaining_s, finish)
        else:
            nxt = events[self._next_event_index]
            delay_s = max(0.0, (nxt.offset_ms - self.replay_position()) / 1000 / self._replay_speed)

            def fire() -> None:
                with self._lock:
                    if not self._replay_running:
                        return
                    self._next_event_index += 1
                    event = copy.deepcopy(nxt.event)
                    event["creationtime"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
                    self._apply_and_broadcast(event)
                    self._schedule_next()

            self._replay_timer = threading.Timer(delay_s, fire)
        self._replay_timer.daemon = True
        self._replay_timer.start()

    # ---------- HTTP ----------

    def _handle(self, h: BaseHTTPRequestHandler) -> None:
        length = int(h.headers.get("content-length") or 0)
        raw = h.rfile.read(length) if length else b""
        body: Any = raw.decode("utf-8", "replace") if raw else None
        if raw:
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                pass
        path = h.path.split("?", 1)[0]
        entry = RecordedRequest(offset_ms=int((time.monotonic() - self._started_at) * 1000), method=h.command, path=path, body=body)
        with self._lock:
            self.requests.append(entry)
        if self.latency_s:
            time.sleep(self.latency_s)

        def send(status: int, payload: Any) -> None:
            entry.status = status
            data = json.dumps(payload).encode("utf-8")
            h.send_response(status)
            h.send_header("content-type", "application/json")
            h.send_header("content-length", str(len(data)))
            h.end_headers()
            h.wfile.write(data)

        method = h.command
        if self.control_api and path.startswith("/__twin/"):
            return self._control(method, path, body, send)
        if method == "GET" and path == "/api/0/config":
            return send(200, self._public_config())
        if method == "POST" and path == "/api":
            return self._pair(body, send)

        if h.headers.get("hue-application-key") != self.application_key:
            return send(403, {"errors": [{"description": "Unauthorized"}], "data": []})

        if method == "GET" and path == f"/api/{self.application_key}/config":
            return send(200, {**self._public_config(), "linkbutton": self._link_button})

        if method == "GET" and path == "/eventstream/clip/v2":
            entry.status = 200
            h.send_response(200)
            h.send_header("content-type", "text/event-stream")
            h.send_header("cache-control", "no-cache")
            h.send_header("connection", "keep-alive")
            h.end_headers()
            h.wfile.write(b": hi\n\n")
            h.wfile.flush()
            with self._lock:
                self._streams.add(h)
            # Keep the handler thread alive until the connection drops.
            try:
                while h in self._streams and self._server is not None:
                    time.sleep(0.2)
            finally:
                with self._lock:
                    self._streams.discard(h)
            return None

        parts = path.strip("/").split("/")
        if len(parts) < 3 or parts[0] != "clip" or parts[1] != "v2" or parts[2] != "resource":
            return send(404, {"errors": [{"description": "Not Found"}], "data": []})
        rtype = parts[3] if len(parts) > 3 else None
        rid = parts[4] if len(parts) > 4 else None
        if method == "GET":
            data = self.index.list(rtype) if rtype else self.index.all()
            if rid:
                data = [r for r in data if r["id"] == rid]
                if not data:
                    return send(404, {"errors": [{"description": f"resource {rtype}/{rid} not found"}], "data": []})
            return send(200, {"errors": [], "data": data})
        if method == "PUT" and rtype and rid:
            return self._put(rtype, rid, body, send)
        if method == "DELETE" and rtype and rid:
            removed = self.index.delete(rtype, rid)
            if removed is None:
                return send(404, {"errors": [{"description": "Not Found"}], "data": []})
            self._apply_and_broadcast(self._event("delete", [{"id": rid, "type": rtype}]))
            return send(200, {"errors": [], "data": [{"rid": rid, "rtype": rtype}]})
        return send(405, {"errors": [{"description": "Method Not Allowed"}], "data": []})

    def _public_config(self) -> dict[str, Any]:
        return {**self.recording.config, "bridgeid": str(self.recording.config.get("bridgeid", "")).upper()}

    def _pair(self, body: Any, send: Sender) -> None:
        if not isinstance(body, dict) or not isinstance(body.get("devicetype"), str):
            return send(200, [{"error": {"type": 2, "address": "/", "description": "body contains invalid json"}}])
        if not self._link_button:
            return send(200, [{"error": {"type": 101, "address": "/", "description": "link button not pressed"}}])
        self._link_button = False
        success: dict[str, str] = {"username": self.application_key}
        if body.get("generateclientkey"):
            success["clientkey"] = secrets.token_hex(16).upper()
        return send(200, [{"success": success}])

    def _put(self, rtype: str, rid: str, patch: Any, send: Sender) -> None:
        target = self.index.get(rtype, rid)
        if target is None:
            return send(404, {"errors": [{"description": f"resource {rtype}/{rid} not found"}], "data": []})
        if not isinstance(patch, dict):
            return send(400, {"errors": [{"description": "invalid json body"}], "data": []})
        if rtype == "light":
            unsupported = [k for k in _CAPABILITY_FIELDS if k in patch and k not in target]
            if unsupported:
                return send(400, {"errors": [{"description": f"invalid value, {k}, for parameter, {k}"} for k in unsupported], "data": []})
        if rtype == "scene" and isinstance(patch.get("recall"), dict):
            self._recall_scene(target, patch["recall"])
            return send(200, {"errors": [], "data": [{"rid": rid, "rtype": rtype}]})
        change = {k: v for k, v in patch.items() if k not in _TRANSIENT_FIELDS}
        if change:
            data: Resource = {**change, "id": rid, "type": rtype}
            if target.get("owner") is not None:
                data["owner"] = target["owner"]
            self._apply_and_broadcast(self._event("update", [data]))
        return send(200, {"errors": [], "data": [{"rid": rid, "rtype": rtype}]})

    def _recall_scene(self, scene: Resource, recall: dict[str, Any]) -> None:
        data: list[Resource] = []
        for action in scene.get("actions", []):
            target = action.get("target") or {}
            change = action.get("action")
            if target.get("rtype") != "light" or not isinstance(change, dict):
                continue
            light = self.index.get("light", str(target.get("rid")))
            if light is None:
                continue
            filtered = {k: v for k, v in change.items() if k not in _TRANSIENT_FIELDS and not (k in _CAPABILITY_FIELDS and k not in light)}
            d: Resource = {**filtered, "id": light["id"], "type": "light"}
            if light.get("owner") is not None:
                d["owner"] = light["owner"]
            data.append(d)
        active = "dynamic_palette" if recall.get("action") == "dynamic_palette" else "static"
        data.append({"id": scene["id"], "type": "scene", "status": {"active": active}})
        for other in self.index.list("scene"):
            same_group = (other.get("group") or {}).get("rid") == (scene.get("group") or {}).get("rid")
            if other["id"] != scene["id"] and same_group and (other.get("status") or {}).get("active") not in (None, "inactive"):
                data.append({"id": other["id"], "type": "scene", "status": {"active": "inactive"}})
        self._apply_and_broadcast(self._event("update", data))

    def _control(self, method: str, path: str, body: Any, send: Sender) -> None:
        b: dict[str, Any] = body if isinstance(body, dict) else {}
        key = f"{method} {path}"
        if key == "GET /__twin/state":
            return send(
                200,
                {
                    "bridge_id": self.bridge_id,
                    "url": self.url,
                    "link_button_pressed": self._link_button,
                    "application_key": self.application_key,
                    "fingerprint": self.fingerprint or None,
                    "replay": self.replay_state().to_dict(),
                    "open_streams": len(self._streams),
                    "requests": len(self.requests),
                    "emitted": len(self.emitted),
                    "resources": len(self.index.all()),
                },
            )
        if key == "POST /__twin/link-button":
            self.press_link_button()
            return send(200, {"link_button_pressed": True})
        if key == "POST /__twin/emit":
            if isinstance(b.get("data"), list) and isinstance(b.get("type"), str):
                event: HueEvent = {
                    "id": b.get("id") or self._next_event_id(),
                    "creationtime": b.get("creationtime") or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "type": b["type"],
                    "data": b["data"],
                }
                self.emit(event)
                return send(200, {"ok": True})
            if isinstance(b.get("resource_type"), str) and isinstance(b.get("id"), str) and isinstance(b.get("patch"), dict):
                self.update_resource(b["resource_type"], b["id"], b["patch"])
                return send(200, {"ok": True})
            return send(400, {"error": "Send a Hue event {type,data:[...]} or {resource_type,id,patch}."})
        if key == "POST /__twin/replay":
            action = b.get("action")
            if action == "start":
                self.replay_start()
            elif action == "pause":
                self.replay_pause()
            elif action == "seek" and isinstance(b.get("offset_ms"), int | float):
                self.replay_seek(float(b["offset_ms"]))
            elif action == "speed" and isinstance(b.get("speed"), int | float):
                self.replay_set_speed(float(b["speed"]))
            else:
                return send(400, {"error": "action must be start | pause | seek {offset_ms} | speed {speed}"})
            return send(200, self.replay_state().to_dict())
        if key == "POST /__twin/reset":
            self.reset()
            return send(200, {"ok": True})
        if key == "POST /__twin/drop-streams":
            self.drop_streams()
            return send(200, {"ok": True})
        if key == "GET /__twin/recording":
            return send(200, self.export_recording(b.get("label")).to_dict())
        if key == "GET /__twin/requests":
            return send(200, {"requests": [asdict(r) for r in self.requests]})
        return send(404, {"error": "Unknown control endpoint"})

    # ---------- internals ----------

    def _event(self, etype: str, data: list[Resource]) -> HueEvent:
        return {"id": self._next_event_id(), "creationtime": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "type": etype, "data": data}

    def _next_event_id(self) -> str:
        self._event_counter += 1
        return f"twin-{self._event_counter:06d}"

    def _apply_and_broadcast(self, event: HueEvent) -> None:
        with self._lock:
            self.index.apply(event)
            self.emitted.append(RecordedEvent(offset_ms=int((time.monotonic() - self._started_at) * 1000), event=event))
            frame = f"id: {int(time.time() * 1000)}:0\ndata: {json.dumps([event])}\n\n".encode()
            dead: list[Any] = []
            for handler in self._streams:
                try:
                    handler.wfile.write(frame)
                    handler.wfile.flush()
                except OSError:
                    dead.append(handler)
            for handler in dead:
                self._streams.discard(handler)
