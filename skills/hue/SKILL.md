---
name: hue
description: Inspect and control Philips Hue devices through a local Hue Bridge — list devices, read sensors (motion, temperature, light level, battery, buttons), control lights, rooms, zones and scenes, and react to live events. Also handles bridge discovery and pairing (link button). Use when the user mentions Hue, Philips lights, smart bulbs, motion/temperature sensors on Hue, or asks to change lighting.
homepage: https://github.com/colombod-personal/philips-hue
user-invocable: true
metadata: { "openclaw": { "emoji": "💡", "requires": { "bins": ["hue"] }, "install": [{ "id": "node", "kind": "node", "package": "@hue-sdk/cli", "bins": ["hue"], "label": "Install the hue CLI (npm)" }] } }
---

# Philips Hue (device-centric)

Use the `hue` CLI. Always pass `--json` when you need to parse the output; omit it when showing results to a human.

## First-time setup (once per bridge)

1. `hue discover --json` — finds bridges (mDNS + Signify cloud). If nothing is found, ask the user for the bridge IP (router page or Hue app → Settings → My Hue system → bridge → *i*).
2. Tell the user: **"Press the round button on the Hue bridge now."** Then run `hue pair <host>` (waits up to 60 s for the button). Credentials are saved to `~/.config/hue-sdk/credentials.json` (mode 0600) with the bridge certificate pinned. Never print the application key.
3. `hue bridges` shows what is paired. Environment overrides: `HUE_BRIDGE_HOST` + `HUE_APPLICATION_KEY` (+ `HUE_BRIDGE_FINGERPRINT`).

## Read (safe, no side effects)

```sh
hue snapshot --json                  # whole home: devices (with lights + sensor readings), rooms, zones, scenes
hue devices --json [--room "Office"] [--kind sensor|light|plug|switch] [--service motion] [--name lamp]
hue device "Hallway sensor" --json   # one device: product, room, zones, connectivity, battery, lights, sensors
hue sensors --json [--type temperature|motion|light_level|device_power|button|contact]
hue lights --json
hue rooms --json | hue zones --json | hue scenes --json [--room "Office"]
```

Sensor readings are normalised: `motion` → boolean, `temperature` → °C, `light_level` → lux, `device_power` → battery %, `button` → last event (`initial_press`, `short_release`, `long_press`…), `contact` → `contact|no_contact`. Each reading has `changed` (ISO timestamp) — use it to judge staleness.

## Control

```sh
hue light "Desk lamp" --on --brightness 40 --kelvin 2700 --transition 500
hue light "Desk lamp" --color "#3399ff"          # colour-capable lights only (see capabilities.color)
hue light "Desk lamp" --off
hue room "Office" --on --brightness 30            # every light in the room
hue zone "Downstairs" --off
hue scene "Relax" --room "Bedroom"               # scene names repeat across rooms: always pass --room
hue identify "Hallway sensor"                    # blink so the user can find it
```

Names resolve case-insensitively; if a name is ambiguous the command fails with `not_found` — list first and use the id.

## Live events

`hue watch --json [--type motion]` streams NDJSON lines (`{at, eventType, resourceType, device, reading, change}`) until interrupted. Use it for "tell me when the door opens / motion stops" tasks; run it in the background and read lines as they arrive.

## Presets

- Bedtime: `hue room "Bedroom" --on --brightness 15 --kelvin 2200`
- Focus: `hue room "Office" --on --brightness 100 --kelvin 4500`
- Movie: `hue room "Living room" --on --brightness 10`

## Notes

- Bridges rate-limit writes (~10/s per light, ~1/s per group); do not loop rapid commands.
- Errors are JSON `{ "error": { "code": ..., "message": ... } }` with codes like `unauthorized` (re-pair), `not_found`, `link_button_not_pressed`, `network`, `tls` (certificate changed — re-pair if the user replaced the bridge).
- `hue raw GET /clip/v2/resource/<type>` is an escape hatch for anything not wrapped.
- An MCP server (`hue-mcp`, package `@hue-sdk/mcp`) exposes the same operations as tools when the host supports MCP.
