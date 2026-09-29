# Contributing

Thanks for helping. This project is MIT licensed; by contributing you agree your contribution is licensed under the same terms.

- Runtime dependencies are not accepted; the SDK is stdlib only. Dev dependencies must be MIT/BSD/Apache-2.0 compatible with MIT (we do not copy Apache-2.0 *code* into the repo).
- Run `uv run ruff check . && uv run ruff format . && uv run mypy && uv run pytest` before opening a pull request.
- Add tests against the digital twin (`hue_sdk.twin.BridgeSimulator`) rather than requiring hardware. If a real bridge behaves differently from the twin, capture it with `hue-twin record` and commit the recording under `recordings/`.
- Keep the device-centric public surface stable: additions to snapshots are fine, renames are breaking.
- If you have a real bridge, note the bridge model and firmware version in your PR when a change touches protocol behaviour.
