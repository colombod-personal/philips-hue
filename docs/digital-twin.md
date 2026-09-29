# Digital twin

The twin is a local server that behaves like your Hue bridge, driven by a **recording** captured from the real one. It is how this project is developed and tested: the SDK, agents and any application talk to the twin exactly as they would to the bridge, and scenarios (someone walks in, a button is pressed, a light drops off Zigbee) are replayed deterministically.

```
real bridge ──hue-twin record──▶ recording.json ──hue-twin serve──▶ twin (HTTPS + SSE + control API)
                                                                         ▲
                                                 SDK / agents / tests ───┘
```

## Recording format

`Recording` (`packages/core/src/twin/recording.ts`):

| Field | Content |
| --- | --- |
| `bridge.config` | `GET /api/0/config` as reported (name, model, firmware, bridge id, MAC). |
| `bridge.certificate` | Subject/issuer CN, SHA-256 fingerprint, validity, self-signed flag. |
| `resources` | Every CLIP v2 resource at the start of the capture. |
| `events[]` | Event-stream events with `offsetMs` from the start. |
| `requests[]` | Optional: requests seen (populated by the twin's export). |

Application keys are never written: the recorder scrubs the pairing key and client key from every string, and credential-bearing resource types are dropped. The bridge id and MAC are kept because the twin needs them to present a matching certificate.

## Capture your bridge

```sh
pnpm build
node packages/cli/dist/bin.js pair <bridge-ip>          # once; press the button
node packages/core/dist/twin/cli.js record --out recordings/home.json --duration 900 --label "evening"
```

While it captures, walk around, press switches, toggle lights from the Hue app: every event is stamped and stored. Stop early with Ctrl-C; what was captured so far is written.

## Run the twin

```sh
node packages/core/dist/twin/cli.js serve --recording recordings/home.json --port 8443 --speed 10
```

It prints the URL, the application key it accepts, the certificate fingerprint, and the `HUE_*` variables that point the SDK at it. Pairing works too: `POST /__twin/link-button` then `hue pair 127.0.0.1` (port as printed). Flags: `--http` (no TLS), `--loop`, `--paused`, `--key <fixed key>`.

## Control API

Unauthenticated, local only, under `/__twin/`:

| Endpoint | Purpose |
| --- | --- |
| `GET /__twin/state` | Bridge id, link button, replay position/speed, open streams, counts. |
| `POST /__twin/link-button` | Press the virtual button (next `POST /api` succeeds). |
| `POST /__twin/emit` | Inject a Hue event `{type, data:[…]}` or a patch `{resourceType, id, patch}`. |
| `POST /__twin/replay` | `{action: start \| pause \| seek, offsetMs \| speed, speed}`. |
| `POST /__twin/reset` | Back to the initial state, replay rewound. |
| `POST /__twin/drop-streams` | Kill open event streams (tests reconnect logic). |
| `GET /__twin/recording` | Export current state + everything emitted as a new recording. |
| `GET /__twin/requests` | Requests served so far. |

## Behaviour model

- Replayed events are applied to the twin's state before being broadcast, so `GET` and the stream never disagree.
- `PUT light/…` and `PUT grouped_light/…` update state and are echoed as `update` events, like the bridge. Transient fields (`dynamics`, `alert`, `identify`) are accepted but not stored. Writing `color_temperature`/`color`/`dimming` to a light that lacks the capability returns HTTP 400.
- Scene recall applies the scene's `actions` to its lights, marks it `static` (or `dynamic_palette`) and flips sibling scenes to `inactive`.
- `seek` applies skipped events to state without broadcasting; rewinding restores the initial resources.

## In tests

```ts
import { BridgeSimulator, sampleRecording } from '@hue-sdk/core/twin';
const twin = await BridgeSimulator.start({ recording: sampleRecording(), replay: { autoStart: false } });
const bridge = await HueBridge.connect({ host: twin.host, port: twin.port, applicationKey: twin.applicationKey, fingerprint: twin.fingerprint, … });
twin.replay.seek(5000);            // jump the scenario forward
twin.updateResource('motion', id, { motion: { motion: true } });
```

The built-in `sampleRecording()` is a hand-written stand-in with realistic shapes. Replace it with a real capture as soon as you have one and commit that under `recordings/`; scenario tests should be written against real captures.
