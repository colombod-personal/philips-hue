# hue-sdk — working notes for coding agents

Device-centric Philips Hue SDK (CLIP v2) for humans and agents, in Python, plus a bridge digital twin. MIT licensed; only MIT-compatible dependencies are allowed (see `docs/research.md`) and the runtime package has none.

## Layout

- `src/hue_sdk/` — the SDK. Protocol layer: `tls.py`, `transport.py`, `discovery/`, `pairing.py`, `events.py`, `client.py`, `credentials.py`, `color.py`. Model layer: `model/` (`HueBridge` → `HueDevice` → `HueLight` / sensor snapshots, `HueGroup`, `HueScene`, `snapshot.py` dataclasses).
- `src/hue_sdk/twin/` — the digital twin: `recording.py` (format), `recorder.py` (`record_bridge`), `simulator.py` (`BridgeSimulator`), `sample.py`/`fixtures.py` (hand-written stand-in), `cli.py` (`hue-twin pair|record|serve|sample`).
- `tests/` — pytest; every test runs against `BridgeSimulator` (fixtures in `tests/conftest.py`).
- `recordings/` — twin recordings; commit real captures here.
- `docs/` — architecture, digital twin, research notes, security model.

## Commands

```sh
uv sync --dev
uv run pytest
uv run ruff check . && uv run ruff format . && uv run mypy
uv run hue-twin serve --speed 10      # local bridge to poke at
```

## Conventions

- Python 3.11+, stdlib only at runtime. `mypy --strict` and `ruff` must pass; format with `ruff format`.
- Raw CLIP v2 resources stay plain `dict`s (`hue_sdk.types.Resource`); the bridge adds fields across firmware releases, so never drop unknown keys.
- Anything humans or agents consume is a dataclass in `model/snapshot.py` with `to_dict()`. Add fields there; do not expose class internals.
- Errors are `HueError` with a stable `code`; never raise bare strings or generic exceptions from public APIs.
- Never log or print application keys. Recordings must be scrubbed (`redact_secrets`).
- Tests must not need hardware: use the twin. Prefer real captures under `recordings/` over `sample_recording()`; extend `fixtures.py` only for shapes no capture covers yet.
- No `CERT_NONE` without pinning outside `fetch_bridge_config` (which exists to learn the certificate to pin) and the explicit `insecure` option.
- The SDK is synchronous by design (simple for humans and REPLs); the event stream runs on a daemon thread and `HueBridge` emits callbacks. Keep it that way unless an async layer is added as a separate module.
