"""Server-Sent Events client for ``/eventstream/clip/v2``.

The bridge pushes ``update`` / ``add`` / ``delete`` / ``error`` events whenever
any resource changes (a light toggled by the app, a motion sensor firing, a
button pressed). Polling the REST API for changes is discouraged by Signify;
this stream is the right way to stay current.

The bridge sends no keep-alives, so a silently dead connection looks exactly
like an idle one. :class:`HueEventStream` therefore reconnects on any socket
close/error with exponential backoff and lets callers refresh state after each
reconnect via the ``connected`` callback.
"""

from __future__ import annotations

import json
import queue
import re
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any, cast

from .errors import HueError, HueErrorCode
from .transport import HttpTransport, StreamHandle
from .types import HueEvent, Resource

EVENTSTREAM_PATH = "/eventstream/clip/v2"
_LINE_BREAK = re.compile(r"\r\n|\n|\r")


@dataclass(slots=True)
class SseMessage:
    data: str
    id: str | None = None
    event: str | None = None


@dataclass(slots=True)
class SseParser:
    """Incremental SSE line parser. Feed chunks, drain complete messages."""

    _buffer: str = ""
    _data: list[str] = field(default_factory=list)
    _id: str | None = None
    _event: str | None = None

    def push(self, chunk: str) -> list[SseMessage]:
        self._buffer += chunk
        out: list[SseMessage] = []
        while True:
            m = _LINE_BREAK.search(self._buffer)
            if not m:
                break
            line = self._buffer[: m.start()]
            self._buffer = self._buffer[m.end() :]
            msg = self._line(line)
            if msg is not None:
                out.append(msg)
        return out

    def _line(self, line: str) -> SseMessage | None:
        if line == "":
            if not self._data and self._id is None and self._event is None:
                return None
            msg = SseMessage(data="\n".join(self._data), id=self._id, event=self._event)
            self._data, self._id, self._event = [], None, None
            return msg
        if line.startswith(":"):
            return None  # comment / keep-alive
        field_name, _sep, value = line.partition(":")
        value = value.removeprefix(" ")
        if field_name == "data":
            self._data.append(value)
        elif field_name == "id":
            self._id = value
        elif field_name == "event":
            self._event = value
        return None


def parse_hue_events(data: str) -> list[HueEvent]:
    """Parses the JSON payload of one SSE message into Hue events."""
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError as err:
        raise HueError("invalid_response", "Event stream delivered malformed JSON.", details=data) from err
    items = parsed if isinstance(parsed, list) else [parsed]
    return [cast(HueEvent, e) for e in items if isinstance(e, dict) and isinstance(e.get("type"), str) and isinstance(e.get("data"), list)]


Listener = Callable[..., None]


class Emitter:
    """Tiny synchronous event emitter (``on`` / ``off`` / ``emit``)."""

    def __init__(self) -> None:
        self._listeners: dict[str, list[Listener]] = {}
        self._lock = threading.Lock()

    def on(self, name: str, listener: Listener) -> Listener:
        with self._lock:
            self._listeners.setdefault(name, []).append(listener)
        return listener

    def off(self, name: str, listener: Listener) -> None:
        with self._lock:
            if name in self._listeners and listener in self._listeners[name]:
                self._listeners[name].remove(listener)

    def emit(self, name: str, *args: Any) -> None:
        with self._lock:
            listeners = list(self._listeners.get(name, []))
        for fn in listeners:
            try:
                fn(*args)
            except Exception:
                pass


class HueEventStream(Emitter):
    """Long-lived subscription to the bridge event stream, running on a background thread.

    Callbacks: ``event(HueEvent)``, ``resource(Resource, HueEvent)``,
    ``connected({"reconnect": bool})``, ``disconnected(HueError | None)``,
    ``error(HueError)``, ``end()``. Also iterable: ``for ev in stream: ...``.
    """

    def __init__(self, transport: HttpTransport, *, reconnect: bool = True, backoff_s: float = 1.0, max_backoff_s: float = 30.0) -> None:
        super().__init__()
        self._transport = transport
        self._reconnect = reconnect
        self._backoff_s = backoff_s
        self._max_backoff_s = max_backoff_s
        self._handle: StreamHandle | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._start_error: HueError | None = None
        self._ever_connected = False
        self._queue: queue.Queue[HueEvent | None] = queue.Queue()
        self.last_event_id: str | None = None

    @property
    def connected(self) -> bool:
        return self._handle is not None and not self._handle.closed

    def start(self, *, wait_s: float = 10.0) -> None:
        """Opens the stream (idempotent). Blocks until the first connection is established or fails."""
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="hue-eventstream", daemon=True)
        self._thread.start()
        if not self._ready.wait(wait_s):
            raise HueError("network", "Timed out opening the event stream.")
        if self._start_error is not None:
            raise self._start_error

    def stop(self) -> None:
        """Closes the stream and ends iteration."""
        if self._stop.is_set():
            return
        self._stop.set()
        handle = self._handle
        if handle is not None:
            handle.close()
        self._queue.put(None)
        self.emit("end")

    def __iter__(self) -> Iterator[HueEvent]:
        if self._thread is None:
            self.start()
        while True:
            item = self._queue.get()
            if item is None:
                return
            yield item

    # ---------- worker ----------

    def _run(self) -> None:
        backoff = self._backoff_s
        first = True
        while not self._stop.is_set():
            try:
                headers = {"last-event-id": self.last_event_id} if self.last_event_id else None
                handle = self._transport.stream(EVENTSTREAM_PATH, headers=headers)
            except HueError as err:
                self._on_connect_failure(err, first)
                if first or not self._reconnect or err.code == "unauthorized":
                    return
                self._sleep(backoff)
                backoff = min(backoff * 2, self._max_backoff_s)
                continue
            if handle.response.status != 200:
                handle.close()
                code: HueErrorCode = "unauthorized" if handle.response.status in (401, 403) else "bridge_error"
                failure = HueError(code, f"Event stream request failed with HTTP {handle.response.status}.", status=handle.response.status)
                self._on_connect_failure(failure, first)
                if first or not self._reconnect or code == "unauthorized":
                    return
                self._sleep(backoff)
                backoff = min(backoff * 2, self._max_backoff_s)
                continue
            self._handle = handle
            backoff = self._backoff_s
            self.emit("connected", {"reconnect": self._ever_connected})
            self._ever_connected = True
            if first:
                first = False
                self._ready.set()
            error = self._consume(handle)
            self._handle = None
            handle.close()
            if self._stop.is_set():
                return
            self.emit("disconnected", error)
            if not self._reconnect:
                self.stop()
                return
            self._sleep(backoff)
            backoff = min(backoff * 2, self._max_backoff_s)

    def _on_connect_failure(self, err: HueError, first: bool) -> None:
        self.emit("error", err)
        if first:
            self._start_error = err
            self._ready.set()
            self._queue.put(None)

    def _consume(self, handle: StreamHandle) -> HueError | None:
        parser = SseParser()
        try:
            while not self._stop.is_set():
                line = handle.readline()
                if not line:
                    return HueError("stream_closed", "Event stream closed by the bridge.")
                for msg in parser.push(line.decode("utf-8", "replace")):
                    if msg.id:
                        self.last_event_id = msg.id
                    if not msg.data:
                        continue
                    try:
                        events = parse_hue_events(msg.data)
                    except HueError as err:
                        self.emit("error", err)
                        continue
                    for ev in events:
                        self._dispatch(ev)
        except OSError as err:
            if self._stop.is_set():
                return None
            return HueError("stream_closed", f"Event stream closed: {err}")
        return None

    def _dispatch(self, event: HueEvent) -> None:
        self.emit("event", event)
        for resource in event["data"]:
            self.emit("resource", resource, event)
        self._queue.put(event)

    def _sleep(self, seconds: float) -> None:
        self._stop.wait(seconds)


__all__ = ["EVENTSTREAM_PATH", "Emitter", "HueEventStream", "Resource", "SseMessage", "SseParser", "parse_hue_events"]
