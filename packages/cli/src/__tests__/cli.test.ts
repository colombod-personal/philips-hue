import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeBridge, type FakeBridge } from '@hue-sdk/core/test-support';
import { main } from '../cli.js';

function capture(): { out: string[]; err: string[]; io: { stdout: { write(c: string): boolean }; stderr: { write(c: string): boolean } } } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
    stdout: { write: (c: string) => (out.push(String(c)), true) },
    stderr: { write: (c: string) => (err.push(String(c)), true) },
    },
  };
}

describe('cli', () => {
  let fake: FakeBridge;
  let dir: string;
  const env = process.env;
  before(async () => {
    fake = await startFakeBridge();
    dir = mkdtempSync(join(tmpdir(), 'hue-cli-'));
    process.env = { ...env, HUE_CREDENTIALS_FILE: join(dir, 'creds.json'), HUE_BRIDGE_HOST: fake.host, HUE_BRIDGE_PORT: String(fake.port), HUE_APPLICATION_KEY: fake.applicationKey, HUE_BRIDGE_FINGERPRINT: fake.fingerprint, HUE_BRIDGE_ID: fake.bridgeId };
  });
  after(async () => {
    process.env = env;
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('help prints usage', async () => {
    const c = capture();
    assert.equal(await main(['--help'], c.io), 0);
    assert.match(c.out.join(''), /hue discover/);
  });

  test('devices --json lists devices from env credentials', async () => {
    const c = capture();
    assert.equal(await main(['devices', '--json', '--kind', 'sensor'], c.io), 0);
    const parsed = JSON.parse(c.out.join('')) as { devices: Array<{ name: string; sensors: unknown[] }> };
    assert.equal(parsed.devices.length, 1);
    assert.equal(parsed.devices[0]?.name, 'Hallway sensor');
    assert.equal(parsed.devices[0]?.sensors.length, 4);
  });

  test('light control sends a PUT and prints the new state', async () => {
    const c = capture();
    assert.equal(await main(['light', 'Desk lamp', '--on', '--brightness', '42', '--json'], c.io), 0);
    const parsed = JSON.parse(c.out.join('')) as { brightness: number; on: boolean };
    assert.equal(parsed.brightness, 42);
    assert.equal(parsed.on, true);
  });

  test('unknown device yields a not_found error in JSON', async () => {
    const c = capture();
    assert.equal(await main(['device', 'does-not-exist', '--json'], c.io), 1);
    const parsed = JSON.parse(c.out.join('')) as { error: { code: string } };
    assert.equal(parsed.error.code, 'not_found');
  });

  test('sensors table renders units', async () => {
    const c = capture();
    assert.equal(await main(['sensors', '--type', 'temperature'], c.io), 0);
    assert.match(c.out.join(''), /21\.4 °C/);
  });
});
