"""``hue-twin`` command line: pair with a bridge, record it, or serve a recording as a local twin."""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
from pathlib import Path

from ..credentials import FileCredentialStore, resolve_connection
from ..discovery.identify import identify_bridge
from ..errors import HueError
from ..pairing import PairingProgress, pair_bridge
from .recorder import record_bridge
from .recording import Recording
from .sample import sample_recording
from .simulator import BridgeSimulator


def _err(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def cmd_pair(args: argparse.Namespace) -> int:
    scheme = "http" if args.http else "https"
    info = identify_bridge(args.host, port=args.port, scheme=scheme)
    _err(f"Found {info.name or 'bridge'} ({info.model_id or '?'}, id {info.id}) at {args.host}.")
    _err("Press the round link button on the bridge now…")

    def waiting(p: PairingProgress) -> None:
        sys.stderr.write(f"  waiting for the button… {int(p.remaining_s) + 1}s left\r")

    creds = pair_bridge(args.host, port=args.port, scheme=scheme, app_name=args.app_name, timeout_s=args.timeout, on_waiting=waiting)
    store = FileCredentialStore()
    store.save(creds, make_default=True)
    _err(f"\nPaired with {creds.name or creds.bridge_id}. Credentials saved to {store.path} (mode 0600).")
    _err(f"Certificate fingerprint pinned: {creds.fingerprint or '(none, http)'}")
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    resolved = resolve_connection(bridge_id=args.bridge)
    if resolved is None:
        _err("No bridge credentials found. Pair first (hue-twin pair <host>) or set HUE_BRIDGE_HOST / HUE_APPLICATION_KEY.")
        return 3
    stop = threading.Event()

    def on_sigint(*_a: object) -> None:
        _err("\nStopping capture early…")
        stop.set()

    signal.signal(signal.SIGINT, on_sigint)
    count = 0

    def on_event(rec: object) -> None:
        nonlocal count
        count += 1
        from .recording import RecordedEvent

        assert isinstance(rec, RecordedEvent)
        types = ",".join(str(d.get("type")) for d in rec.event["data"])
        _err(f"  +{rec.offset_ms / 1000:.1f}s {rec.event['type']} {types}")

    recording = record_bridge(resolved.credentials, duration_s=args.duration, label=args.label, tls=resolved.tls, stop=stop, on_event=on_event, on_status=_err)
    recording.save(args.out)
    _err(f"Wrote {args.out}: {len(recording.resources)} resources, {count} events, bridge {recording.bridge_id}.")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    recording = Recording.load(args.recording) if args.recording else sample_recording()
    config_home = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    cert_dir = None if args.ephemeral_cert else Path(args.cert_dir) if args.cert_dir else config_home / "hue-sdk" / "twin" / recording.bridge_id
    sim = BridgeSimulator.start(
        recording,
        autostart_replay=not args.paused,
        scheme="http" if args.http else "https",
        host=args.host,
        port=args.port,
        application_key=args.key,
        replay_speed=args.speed,
        replay_loop=args.loop,
        certificate_dir=cert_dir,
    )
    env = f"HUE_BRIDGE_HOST={sim.host} HUE_BRIDGE_PORT={sim.port} HUE_APPLICATION_KEY={sim.application_key}"
    env += f" HUE_BRIDGE_FINGERPRINT={sim.fingerprint}" if sim.fingerprint else " HUE_BRIDGE_SCHEME=http"
    _err(
        "\n".join(
            [
                f"Hue digital twin for bridge {sim.bridge_id} ({recording.label or 'unlabelled'})",
                f"  URL:              {sim.url}",
                f"  application key:  {sim.application_key}",
                (f"  cert fingerprint: {sim.fingerprint}" + (f" (persisted in {cert_dir})" if cert_dir else " (ephemeral)"))
                if sim.fingerprint
                else "  TLS:              off (http)",
                f"  timeline:         {len(recording.events)} events over {recording.duration_ms / 1000:.1f}s, speed {args.speed:g}x"
                + (", looping" if args.loop else "")
                + (", paused" if args.paused else ""),
                "",
                "  Point the SDK at it:",
                f"    {env}",
                f"  Or pair against it: POST {sim.url}/__twin/link-button, then hue-twin pair {sim.host} --port {sim.port}",
                "",
            ]
        )
    )
    done = threading.Event()
    signal.signal(signal.SIGINT, lambda *_a: done.set())
    signal.signal(signal.SIGTERM, lambda *_a: done.set())
    done.wait()
    sim.close()
    return 0


def cmd_sample(_args: argparse.Namespace) -> int:
    sys.stdout.write(sample_recording().to_json())
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hue-twin", description="Hue bridge digital twin: pair, record a real bridge, serve a recording locally.")
    sub = p.add_subparsers(dest="command", required=True)

    pair = sub.add_parser("pair", help="Pair with a bridge (real or twin); press the round button when asked.")
    pair.add_argument("host")
    pair.add_argument("--port", type=int)
    pair.add_argument("--http", action="store_true", help="Plain HTTP (emulators only).")
    pair.add_argument("--app-name", default="hue-sdk")
    pair.add_argument("--timeout", type=float, default=60.0, help="Seconds to wait for the button.")
    pair.set_defaults(fn=cmd_pair)

    rec = sub.add_parser("record", help="Capture config, certificate, resources and the event stream of the paired bridge.")
    rec.add_argument("--out", required=True)
    rec.add_argument("--duration", type=float, default=60.0, help="Seconds of events to capture (0 = state only).")
    rec.add_argument("--bridge", help="Bridge id when several are paired.")
    rec.add_argument("--label")
    rec.set_defaults(fn=cmd_record)

    serve = sub.add_parser("serve", help="Serve a recording as a local bridge (default: built-in sample).")
    serve.add_argument("--recording")
    serve.add_argument("--port", type=int, default=0)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--http", action="store_true")
    serve.add_argument("--speed", type=float, default=1.0)
    serve.add_argument("--loop", action="store_true")
    serve.add_argument("--paused", action="store_true")
    serve.add_argument("--key", help="Fixed application key to accept.")
    serve.add_argument("--cert-dir", help="Where to persist the certificate (default ~/.config/hue-sdk/twin/<bridge id>).")
    serve.add_argument("--ephemeral-cert", action="store_true")
    serve.set_defaults(fn=cmd_serve)

    sample = sub.add_parser("sample", help="Print the built-in sample recording as JSON.")
    sample.set_defaults(fn=cmd_sample)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.fn(args))
    except HueError as err:
        _err(f"error ({err.code}): {err.message}")
        return 3 if err.code in ("unauthorized", "link_button_not_pressed", "pairing_timeout") else 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
