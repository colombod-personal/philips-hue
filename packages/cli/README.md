# @hue-sdk/cli

`hue` — command-line access to a Philips Hue bridge with `--json` on every command. Run `hue --help` for the full list: `discover`, `pair`, `bridges`, `snapshot`, `devices`, `device`, `sensors`, `lights`, `rooms`, `zones`, `scenes`, `light`, `room`, `zone`, `scene`, `identify`, `watch`, `raw`.

```sh
hue discover
hue pair 192.168.1.20          # press the bridge button
hue devices --room Office --json
hue sensors --type motion
hue light "Desk lamp" --on --brightness 40 --kelvin 2700
hue watch --type button
```
