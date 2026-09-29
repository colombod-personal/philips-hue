# philips-hue

A **device-centric Philips Hue SDK** for agents and applications, plus a CLI, an MCP server and an agent skill. MIT licensed, TypeScript, and the core has **zero runtime dependencies**.

| Package | What it is |
| --- | --- |
| [`@hue-sdk/core`](packages/core) | Discovery (mDNS + cloud), pairing (link button), TLS pinning, CLIP v2 client, event stream, and the device model: `HueBridge → HueDevice → lights / sensors`. |
| [`@hue-sdk/cli`](packages/cli) | `hue` command with `--json` on every command. |
| [`@hue-sdk/mcp`](packages/mcp) | `hue-mcp`, a stdio [Model Context Protocol](https://modelcontextprotocol.io) server exposing devices, sensors, lights, scenes and a "wait for event" tool. |
| [`skills/hue`](skills/hue/SKILL.md) | OpenClaw / Claude Code style skill that teaches an agent to use the CLI. |

## Quick start

```sh
pnpm install && pnpm build

# 1. find the bridge (mDNS + Signify cloud); pass the IP manually if your network blocks both
node packages/cli/dist/bin.js discover

# 2. pair: press the round button on the bridge when asked
node packages/cli/dist/bin.js pair 192.168.1.20

# 3. look around
node packages/cli/dist/bin.js devices
node packages/cli/dist/bin.js sensors --json
node packages/cli/dist/bin.js light "Desk lamp" --on --brightness 40 --kelvin 2700
node packages/cli/dist/bin.js watch --type motion
```

(`pnpm hue …` runs the same binary from the repo root.)

## Library

```ts
import { discoverBridges, pairBridge, FileCredentialStore, HueBridge } from '@hue-sdk/core';

const [found] = await discoverBridges();                         // { id, host, port, certificate, … }
const creds = await pairBridge(found.host, { appName: 'my-agent' }); // waits for the link button
await new FileCredentialStore().save(creds);                     // 0600 file, fingerprint pinned

const bridge = await HueBridge.connect(creds);
for (const device of bridge.devices) {
  console.log(device.name, device.kind, device.room?.name, device.sensors());
  // "Hallway sensor" "sensor" "Office" [{ type: 'motion', value: false, unit: 'boolean', changed: '…' }, { type: 'temperature', value: 21.4, unit: '°C', … }, …]
}

await bridge.resolveLight('Desk lamp')?.turnOn({ brightness: 40, kelvin: 2700, transitionMs: 500 });
await bridge.group('Office')?.activateScene('Concentrate');

await bridge.watch();                                            // SSE stream, auto-reconnect
bridge.on('sensor', (reading, device) => console.log(device.name, reading.type, reading.value));

console.log(JSON.stringify(bridge.snapshot()));                 // everything, as plain JSON for agents
```

Everything an agent needs is available as plain JSON via `snapshot()` (see `packages/core/src/model/snapshot.ts`), and raw CLIP v2 resources remain reachable through `HueClient` when you need something the model does not wrap.

## Digital twin

Development and tests run against a **digital twin** of your bridge, not a hand-written mock: `hue-twin record` captures the real bridge (config, certificate, all resources, and the event stream over time) into a recording; `hue-twin serve` replays it as a local bridge with the same endpoints, timeline replay at any speed, write handling and a control API for scripting scenarios. See [docs/digital-twin.md](docs/digital-twin.md).

```sh
node packages/core/dist/twin/cli.js record --out recordings/home.json --duration 600
node packages/core/dist/twin/cli.js serve --recording recordings/home.json --speed 10
```

## MCP server

```json
{
  "mcpServers": {
    "hue": { "command": "node", "args": ["/path/to/philips-hue/packages/mcp/dist/bin.js"] }
  }
}
```

Tools: `hue_discover_bridges`, `hue_pair_bridge`, `hue_list_bridges`, `hue_get_home_snapshot`, `hue_list_devices`, `hue_get_device`, `hue_read_sensors`, `hue_list_lights`, `hue_set_light`, `hue_set_group`, `hue_list_groups`, `hue_list_scenes`, `hue_activate_scene`, `hue_identify_device`, `hue_wait_for_event`.

## Configuration

Credentials are stored in `~/.config/hue-sdk/credentials.json` (or `HUE_CREDENTIALS_FILE`). Environment variables override the store:

| Variable | Purpose |
| --- | --- |
| `HUE_BRIDGE_HOST`, `HUE_APPLICATION_KEY` | Connect without the store (containers, CI). |
| `HUE_BRIDGE_ID`, `HUE_BRIDGE_PORT` | Optional bridge id / port. |
| `HUE_BRIDGE_FINGERPRINT` | SHA-256 fingerprint of the bridge certificate to pin. |
| `HUE_CA_FILE` | PEM of the Signify Hue bridge root CA (from the Hue developer portal) for chain + CN verification. |
| `HUE_TLS_INSECURE=1` | Disable verification (exploration only). |

## Security

Pairing pins the bridge certificate and every later connection refuses any other certificate; see [SECURITY.md](SECURITY.md).

## Development

```sh
pnpm build      # core first; cli/mcp import it through workspace links
pnpm test       # node:test against an in-process fake bridge (needs openssl)
pnpm typecheck
```

Docs: [architecture](docs/architecture.md) · [research & licensing](docs/research.md) · [contributing](CONTRIBUTING.md).

## Licence

[MIT](LICENSE). Philips Hue is a trademark of Signify; this project is not affiliated with Signify.
