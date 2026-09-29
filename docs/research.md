# Research notes (September 2026)

What was checked before designing this SDK, and the decisions that followed.

## Hue API landscape

- **CLIP v2** (`/clip/v2/resource/{type}`) is the current local API. Everything is a *resource* with a UUID; physical devices are `device` resources whose `services` point at `light`, `motion`, `temperature`, `light_level`, `device_power`, `button`, `relative_rotary`, `contact`, `tamper`, `camera_motion`, `zigbee_connectivity`, … Rooms/zones/`bridge_home` group devices or services and expose a `grouped_light`. The v1 API (`/api/<username>/lights/…`) is legacy; only its `POST /api` pairing endpoint and `GET /api/0/config` are still needed.
- **Auth**: header `hue-application-key`, obtained by `POST /api {"devicetype":"app#instance","generateclientkey":true}` within ~30 s of pressing the bridge's link button (error type 101 otherwise). `generateclientkey` also returns the DTLS PSK for the Entertainment API.
- **Events**: Server-Sent Events at `/eventstream/clip/v2`; Signify explicitly discourages polling. No keep-alives are sent, so clients must detect dead sockets and reconnect (we back off exponentially and refetch the full state after a reconnect).
- **Transport**: HTTPS only; HTTP was removed from firmware in 2025 (RED compliance). Certificates are issued by Signify's private "root-bridge" CA with CN = bridge id; older bridges are self-signed. The CA PEM is published on the developer portal behind a login, so it is not vendored here — we pin the certificate fingerprint learned at pairing time and optionally verify against a user-supplied CA. Bridges also cap concurrent connections (~3), so the agent keeps at most two sockets plus the event stream.
- **Discovery**: mDNS `_hue._tcp.local` (TXT `bridgeid`, `modelid`) and `https://discovery.meethue.com/` (returns bridges that reported the same public IP; rate limited, ~1 call per 15 min). UPnP/SSDP was deprecated in 2022. Both fail in common setups (VLANs, containers, double NAT), so the SDK runs both concurrently, merges by bridge id, and always allows a manual host.
- **Rate limits**: Signify guidance is ~10 light commands/s and ~1 group command/s; the client serialises writes accordingly.
- **Light level**: sensors report `10000·log10(lux)+1`; the SDK converts to lux.

## OpenClaw's Hue skill

OpenClaw does not ship a Hue integration in its core; the community skill `openhue` (ClawHub) is a `SKILL.md` that drives the **OpenHue CLI** (`openhue discover`, `openhue setup`, `openhue get light --json`, `openhue set light … --on --brightness 50 --rgb #3399FF`, `openhue set scene …`). Discovery there is mDNS with a `discovery.meethue.com` fallback (Go, `grandcat/zeroconf`); pairing is the same link-button flow. It is light-centric (lights, rooms, scenes) and has no sensor or event support.

What we took from it:

- The skill format and gating (`metadata.openclaw.requires.bins`, `install` specs) — `skills/hue/SKILL.md` follows the same conventions so it can be published to ClawHub.
- The command vocabulary agents already know (`discover`, `setup`/`pair`, `get`/`set`, `--json`).
- The "press the button during setup" UX note.

What we did differently: devices and sensors are first-class, events are streamed, certificate pinning is on by default, and everything is available as a library and as MCP tools, not only a CLI.

## Licensing

| Component | Licence | Use here |
| --- | --- | --- |
| OpenHue CLI / openhue-go / openhue-api | Apache-2.0 | Reference only; no code copied (Apache-2.0 code would drag its NOTICE/patent terms into an MIT repo). |
| hue-ex (Elixir) | Apache-2.0 | Design reference (pairing retry loop, fingerprint persistence, dead-stream detection). |
| `@modelcontextprotocol/sdk` | MIT | Runtime dependency of `@hue-sdk/mcp`. |
| `zod` | MIT | Runtime dependency of `@hue-sdk/mcp`. |
| `typescript`, `tsx`, `@types/node` | Apache-2.0 / MIT / MIT | Dev-only. |
| Signify Hue bridge root CA | Signify, developer-portal terms | Not vendored; user-supplied via `HUE_CA_FILE`. |

`@hue-sdk/core` and `@hue-sdk/cli` have **no runtime dependencies**.

## Sources

- Philips Hue developer program: New Hue API announcement, application design guidance (discovery, HTTPS, rate limits), CLIP v2 core concepts.
- OpenHue project (openhue.io, github.com/openhue) — API docs and CLI.
- ClawHub / OpenClaw skill format docs and the `openhue` skill listing.
- Community write-ups on bridge certificates (IoTech blog, Hue developer forum) and on cloud discovery behaviour behind NAT.
