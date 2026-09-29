# Architecture

```
  humans / agents / apps
           │  dataclass snapshots (to_dict() → JSON)
  ┌────────▼──────────────────────────────┐
  │ model/   HueBridge                    │  device-centric view:
  │          ├─ HueDevice                 │  device → lights + sensors,
  │          │    ├─ HueLight             │  rooms / zones / scenes,
  │          │    └─ sensors()            │  live index fed by events
  │          ├─ HueGroup / HueScene       │
  │          └─ ResourceIndex             │
  ├───────────────────────────────────────┤
  │ client.py     HueClient               │  typed CLIP v2 resources + write rate limiting
  │ events.py     HueEventStream          │  SSE on a daemon thread, reconnect with backoff
  │ pairing.py / discovery/               │  link button, mDNS, cloud, identify
  │ transport.py + tls.py                 │  http.client, pinning, CA + CN check
  └────────────────┬──────────────────────┘
                   │ HTTPS 443
        ┌──────────▼──────────┐      ┌──────────────────────────────┐
        │     Hue Bridge      │  or  │  twin/  BridgeSimulator       │ ← Recording (hue-twin record)
        └─────────────────────┘      └──────────────────────────────┘
```

## Layers

1. **Transport** (`transport.py`, `tls.py`): `http.client` with a subclassed HTTPS connection that verifies the peer certificate right after the handshake (fingerprint pin, optional CA + CN check, explicit insecure). Maps failures to `HueError` codes. `scheme="http"` exists only for emulators.
2. **Protocol** (`client.py`, `events.py`, `pairing.py`, `discovery/`): resource CRUD on `/clip/v2/resource`, the SSE stream with backoff on a background thread, pairing with certificate capture, and discovery that merges mDNS + cloud + manual hosts.
3. **Model** (`model/`): `HueBridge` loads every resource once into a thread-safe `ResourceIndex`, exposes `devices`, `rooms`, `zones`, `scenes`, `lights` and `sensors()` as live views, and (after `watch()`) applies event deltas so the views stay current and emits `change` / `sensor` callbacks. Every object has `snapshot()` returning the dataclasses in `model/snapshot.py`.
4. **Twin** (`twin/`): the recorder and the simulator; see `docs/digital-twin.md`.

## Why device-centric

CLIP v2 is resource-centric: a motion sensor is four resources (`motion`, `temperature`, `light_level`, `device_power`) plus connectivity. People and agents reason about *things* ("the hallway sensor", "the desk lamp"), so the model resolves services under their owning `device`, normalises sensor readings into `SensorSnapshot(type, value, unit, changed)` and classifies devices (`light`, `plug`, `sensor`, `switch`, `bridge`). Raw resources remain reachable (`device.services()`, `HueClient`) for anything the model does not wrap.

## Why synchronous

The public API is plain synchronous Python: it reads naturally in a REPL, a notebook, a script or an agent tool function, and it needs no event loop to be threaded through a host application. The only long-lived activity, the event stream, runs on a daemon thread and delivers callbacks; `HueEventStream` is also iterable for pull-style consumers. An asyncio façade can be layered on later without changing the model.

## Credentials

`BridgeCredentials` = host + application key + certificate fingerprint (+ optional Entertainment client key). Stored by `FileCredentialStore` (0600 JSON) or any object implementing `CredentialStore`; overridable via `HUE_*` environment variables. `resolve_connection()` is the single entry point.

## Extending

- New resource type: if it is a sensor, add a case to `model/sensor.py` and the `SENSOR_SERVICE_TYPES` set; otherwise it is already reachable as a raw resource.
- New consumer surface (CLI, MCP, HTTP): consume `HueBridge` snapshots; do not re-implement resource parsing.
