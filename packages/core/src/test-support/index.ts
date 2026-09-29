/**
 * Test support: an in-process fake Hue bridge and fixture data. Exported as
 * `@hue-sdk/core/test-support` so downstream packages (CLI, MCP, your agent)
 * can run their tests without real hardware. Requires `openssl` on PATH for
 * the HTTPS variant.
 */
export { startFakeBridge, type FakeBridge, type FakeBridgeOptions } from './fake-bridge.js';
export { fixtureResources, IDS as FIXTURE_IDS, BRIDGE_ID as FIXTURE_BRIDGE_ID } from './fixtures.js';
