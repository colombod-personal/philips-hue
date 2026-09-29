# Contributing

Thanks for helping. This project is MIT licensed; by contributing you agree your contribution is licensed under the same terms.

- Dependencies must be MIT-compatible (MIT, BSD, ISC, Apache-2.0 is acceptable for *dependencies* but we do not copy Apache-2.0 code into this repo). `packages/core` stays dependency-free.
- Run `pnpm build && pnpm test && pnpm typecheck` before opening a pull request.
- Add tests against the fake bridge (`packages/core/src/test-support`) rather than requiring hardware.
- Keep the device-centric public surface stable: additions to snapshots are fine, renames are breaking.
- If you have a real bridge, note the bridge model and firmware version in your PR when a change touches protocol behaviour.
