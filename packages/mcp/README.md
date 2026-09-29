# @hue-sdk/mcp

`hue-mcp` — a stdio MCP server that exposes Philips Hue devices, sensors, lights, groups and scenes as tools, including `hue_wait_for_event` for reacting to motion/button/contact changes.

```json
{ "mcpServers": { "hue": { "command": "hue-mcp" } } }
```

Credentials are shared with the `hue` CLI (`hue pair …`) or taken from `HUE_BRIDGE_HOST` / `HUE_APPLICATION_KEY`.
