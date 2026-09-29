# hue-sdk

A **device-centric Philips Hue SDK for humans and agents**, in Python, with a **digital twin** of the bridge for development and testing. MIT licensed, `Typing :: Typed`, **zero runtime dependencies** (Python 3.11+).

The Hue CLIP v2 API is resource-centric: a motion sensor is four resources, a light is owned by a device, rooms hold devices but zones hold lights. This SDK folds that back into the things people and agents reason about: **devices** with **lights** and **sensors**, grouped into **rooms** and **zones**, with **scenes**, all readable as plain data and updated live from the bridge's event stream.

## Install

```sh
uv add hue-sdk        # or: pip install hue-sdk
```

## Five minutes with a real bridge

```python
from hue_sdk import discover_bridges, pair_bridge, FileCredentialStore, HueBridge

found = discover_bridges()[0]  # mDNS + Signify cloud; pass an IP to identify_bridge() otherwise
creds = pair_bridge(found.host, app_name="my-agent")  # press the round button on the bridge when asked
FileCredentialStore().save(creds)  # ~/.config/hue-sdk/credentials.json, mode 0600, certificate pinned

bridge = HueBridge.connect(creds)
for device in bridge.devices:
    print(device.name, device.kind, device.room and device.room.name, [(s.type, s.value, s.unit) for s in device.sensors()])
# Hallway sensor sensor Office [('motion', False, 'boolean'), ('temperature', 21.4, '°C'), ('light_level', 99.98, 'lux'), ('device_power', 87, '%')]

bridge.resolve_light("Desk lamp").turn_on(brightness=40, kelvin=2700, transition_ms=500)
bridge.group("Office").activate_scene("Concentrate")

bridge.on("sensor", lambda reading, device: print(device.name, reading.type, reading.value))
bridge.watch()  # background event stream, auto-reconnect
```

Later sessions: `resolve_connection()` finds the stored credentials (or `HUE_BRIDGE_HOST` + `HUE_APPLICATION_KEY` from the environment) and `HueBridge.connect(resolved.credentials, tls=resolved.tls)` reconnects with the pinned certificate.

## The API, top down

| Layer | What you get |
| --- | --- |
| `HueBridge` | Aggregate root. `devices`, `find_devices(...)`, `resolve_device(name)`, `lights`, `resolve_light(name)`, `sensors(type)`, `rooms`, `zones`, `group(name)`, `scenes`, `scene(name, group)`, `snapshot()`, `watch()`, `on(event, fn)`. |
| `HueDevice` | One physical thing. `kind` (`light`, `plug`, `sensor`, `switch`, `bridge`), `lights`, `sensors()`, `sensor(type)`, `battery`, `connectivity`, `room`, `zones`, `identify()`, `rename()`, `snapshot()`. |
| `HueLight` | `is_on`, `brightness`, `set(on=, brightness=, hex=, kelvin=, mirek=, transition_ms=)`, `turn_on()`, `turn_off()`, `identify()`, `update(raw)`. |
| `HueGroup` / `HueScene` | Room or zone: `device_ids()`, `set(...)`, `turn_on()`, `turn_off()`, `scenes`, `activate_scene(name)`; scene: `activate(dynamic=)`. |
| Snapshots | `HomeSnapshot`, `DeviceSnapshot`, `LightSnapshot`, `SensorSnapshot`, ... Frozen dataclasses with `to_dict()`: the JSON an agent reads. Sensor readings are normalised (`motion` bool, `temperature` °C, `light_level` lux, `device_power` %, `button` last event, `contact` state) with `changed` timestamps. |
| `HueClient` | Raw CLIP v2: `list_all()`, `list(type)`, `get(type, id)`, `update(type, id, body)`, `create`, `delete`, `events()`. Write rate limiting built in. |
| Protocol | `discover_bridges()`, `identify_bridge(host)`, `pair_bridge(host)`, `HueEventStream`, `HttpTransport`, `TlsOptions`. |
| Storage | `FileCredentialStore`, `MemoryCredentialStore`, `resolve_connection()`. |

Every error is a `HueError` with a stable `code` (`unauthorized`, `not_found`, `link_button_not_pressed`, `tls`, `network`, ...) and `to_dict()`.

## The digital twin

You do not need hardware to develop against this SDK, and you should not develop against a hand-written mock either. The twin **records** a real bridge (config, certificate, every resource, and the event stream over time) and **replays** it as a local bridge with the same endpoints:

```sh
hue-twin pair 192.168.1.20                                  # once; press the button
hue-twin record --out recordings/home.json --duration 600   # walk around, press switches, use the app
hue-twin serve --recording recordings/home.json --speed 10  # local HTTPS bridge replaying that timeline
```

`serve` prints the `HUE_*` variables that point the SDK at the twin. Writes (`light.set(...)`, scene recall) mutate the twin's state and are echoed as events like the real bridge; the timeline can be paused, sought and looped; a control API under `/__twin/` lets tests and agents inject events or press the virtual link button. In code:

```python
from hue_sdk.twin import BridgeSimulator, Recording

twin = BridgeSimulator.start(Recording.load("recordings/home.json"), autostart_replay=False)
twin.replay_seek(30_000)  # jump 30 s into the scenario
twin.press_link_button()
```

Details: [docs/digital-twin.md](docs/digital-twin.md). A hand-written `sample_recording()` ships for the test suite until you commit a real capture.

## Security

Pairing captures the bridge certificate before requesting a key and pins its SHA-256 fingerprint in the saved credentials; every later connection refuses any other certificate. Optionally verify against the Signify root CA (`TlsOptions(ca=..., bridge_id=...)` or `HUE_CA_FILE`). Nothing is verified only when you say `insecure=True` / `HUE_TLS_INSECURE=1`. See [SECURITY.md](SECURITY.md).

## Configuration

| Variable | Purpose |
| --- | --- |
| `HUE_BRIDGE_HOST`, `HUE_APPLICATION_KEY` | Connect without the credential store (containers, CI, the twin). |
| `HUE_BRIDGE_ID`, `HUE_BRIDGE_PORT`, `HUE_BRIDGE_SCHEME=http` | Optional bridge id, port, plain HTTP for emulators. |
| `HUE_BRIDGE_FINGERPRINT` | SHA-256 fingerprint to pin. |
| `HUE_CA_FILE` | PEM of the Signify Hue bridge root CA for chain + CN verification. |
| `HUE_TLS_INSECURE=1` | Disable verification (exploration only). |
| `HUE_CREDENTIALS_FILE` | Credential store path (default `~/.config/hue-sdk/credentials.json`). |

## Development

```sh
uv sync --dev
uv run pytest            # everything runs against the twin; needs `openssl` on PATH for HTTPS
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

Docs: [architecture](docs/architecture.md) · [digital twin](docs/digital-twin.md) · [research & licensing](docs/research.md) · [contributing](CONTRIBUTING.md).

## Licence

[MIT](LICENSE). Philips Hue is a trademark of Signify; this project is not affiliated with Signify.
