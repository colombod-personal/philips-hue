# Architecture

```
                 ┌────────────────────────────┐
  agents / apps  │  @hue-sdk/mcp  (MCP tools)  │
                 │  @hue-sdk/cli  (hue …)      │
                 └──────────────┬─────────────┘
                                │ snapshots (plain JSON)
                 ┌──────────────▼─────────────┐
                 │  model/  HueBridge          │  device-centric view:
                 │          ├─ HueDevice       │  device → lights + sensors,
                 │          │    ├─ HueLight   │  rooms/zones/scenes,
                 │          │    └─ sensors()  │  live index fed by events
                 │          ├─ HueGroup/Scene  │
                 │          └─ ResourceIndex   │
                 └──────────────┬─────────────┘
                 ┌──────────────▼─────────────┐
                 │  client.ts  HueClient       │  typed CLIP v2 resources
                 │  events.ts  HueEventStream  │  SSE + reconnect
                 │  pairing.ts / discovery/    │  link button, mDNS, cloud
                 │  transport.ts + tls.ts      │  node:https, pinning, CA
                 └──────────────┬─────────────┘
                                │ HTTPS 443
                        ┌───────▼───────┐
                        │   Hue Bridge  │
                        └───────────────┘
```

## Layers

1. **Transport** (`transport.ts`, `tls.ts`): `node:https` with a custom agent that enforces the TLS policy (fingerprint pin, optional CA + CN check, explicit insecure). Handles timeouts, JSON parsing and maps failures to `HueError` codes. `scheme: 'http'` exists only for emulators.
2. **Protocol** (`client.ts`, `events.ts`, `pairing.ts`, `discovery/`): resource CRUD on `/clip/v2/resource`, the SSE stream with backoff, pairing with certificate capture, and discovery that merges mDNS + cloud + manual hosts.
3. **Model** (`model/`): the device-centric view. `HueBridge` loads every resource once into a `ResourceIndex`, exposes `devices`, `rooms`, `zones`, `scenes`, `lights` and `sensors()` as live views, and (after `watch()`) applies event deltas so the views stay current. Every object has a `snapshot()` returning the plain JSON shapes in `model/snapshot.ts`.
4. **Surfaces**: the CLI and the MCP server are thin: they resolve credentials, call the model, and print snapshots.

## Why device-centric

CLIP v2 is resource-centric: a motion sensor is four resources (`motion`, `temperature`, `light_level`, `device_power`) plus connectivity. Agents reason about *things* ("the hallway sensor", "the desk lamp"), so the model resolves services under their owning `device`, normalises sensor readings into `{type, value, unit, changed}` and classifies devices (`light`, `plug`, `sensor`, `switch`, `bridge`). Raw resources remain reachable (`device.services()`, `HueClient`) for anything the model does not wrap.

## Credentials

`BridgeCredentials` = host + application key + certificate fingerprint (+ optional Entertainment client key). Stored by `FileCredentialStore` (0600 JSON) or any custom `CredentialStore`; overridable via `HUE_*` environment variables. `resolveConnection()` is the single entry point used by the CLI and MCP server.

## Testing: the digital twin

`@hue-sdk/core/twin` ships the twin: `recordBridge()` captures a real bridge (config, certificate, resources, timed events) into a `Recording`, and `BridgeSimulator` serves a recording as a local bridge (HTTPS with a certificate for the recorded bridge id, pairing with a virtual link button, CLIP v2 reads/writes, SSE, timeline replay, control API). `@hue-sdk/core/test-support` wraps it as `startFakeBridge()` for tests. See `docs/digital-twin.md`.

## Extending

- New resource type: add the interface in `types.ts`, map it in `ResourceOf`, and (if it is a sensor) add a case to `model/sensor.ts` and the `SENSOR_SERVICE_TYPES` list.
- New agent surface: consume `HueBridge` snapshots; do not re-implement resource parsing.
