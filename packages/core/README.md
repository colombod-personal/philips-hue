# @hue-sdk/core

Device-centric Philips Hue SDK (CLIP v2) with zero runtime dependencies. Node ≥ 20.

```ts
import { discoverBridges, pairBridge, HueBridge, FileCredentialStore } from '@hue-sdk/core';
```

- `discoverBridges()` / `discoverBridgesDetailed()` — mDNS + cloud, merged; `identifyBridge(host)` for a known address.
- `pairBridge(host, { appName })` — link-button flow; returns `BridgeCredentials` with the pinned certificate fingerprint.
- `HueBridge.connect(creds)` — `devices`, `findDevices()`, `resolveDevice()`, `lights`, `resolveLight()`, `sensors()`, `rooms`, `zones`, `scenes`, `snapshot()`, `watch()`.
- `HueClient` — raw resource access (`list`, `get`, `update`, `create`, `delete`, `events()`).
- `FileCredentialStore` / `MemoryCredentialStore` / `resolveConnection()`.
- Colour helpers: `rgbToXy`, `xyToRgb`, `kelvinToMirek`, `lightLevelToLux`.
- `@hue-sdk/core/test-support` — `startFakeBridge()` for hardware-free tests.

See the repository README and `docs/architecture.md` for the full picture.
