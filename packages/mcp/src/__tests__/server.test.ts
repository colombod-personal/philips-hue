import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryCredentialStore } from '@hue-sdk/core';
import { startFakeBridge, FIXTURE_IDS, type FakeBridge } from '@hue-sdk/core/test-support';
import { createHueMcpServer } from '../server.js';

describe('hue mcp server', () => {
  let fake: FakeBridge;
  let client: Client;
  let close: () => void;
  before(async () => {
    fake = await startFakeBridge();
    const store = new MemoryCredentialStore();
    await store.save({ bridgeId: fake.bridgeId, host: fake.host, port: fake.port, applicationKey: fake.applicationKey, fingerprint: fake.fingerprint, pairedAt: 't', deviceType: 'test#ci' });
    const created = createHueMcpServer({ store, env: {} });
    close = created.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await created.server.connect(serverTransport);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
  });
  after(async () => {
    await client.close();
    close();
    await fake.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    return { isError: Boolean(res.isError), data: JSON.parse(text) as Record<string, unknown> };
  };

  test('lists the expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.ok(names.includes('hue_read_sensors'));
    assert.ok(names.includes('hue_set_light'));
    assert.ok(names.includes('hue_wait_for_event'));
    assert.equal(names.length, 15);
  });

  test('snapshot and device queries', async () => {
    const snap = await call('hue_get_home_snapshot');
    assert.equal((snap.data['devices'] as unknown[]).length, 5);
    const sensors = await call('hue_read_sensors', { type: 'temperature' });
    const list = sensors.data['sensors'] as Array<{ value: number; unit: string; device: { name: string } }>;
    assert.equal(list[0]?.value, 21.4);
    assert.equal(list[0]?.device.name, 'Hallway sensor');
    const missing = await call('hue_get_device', { device: 'nothing here' });
    assert.equal(missing.isError, true);
    assert.equal((missing.data['error'] as { code: string }).code, 'not_found');
  });

  test('set light validates input and applies changes', async () => {
    const bad = await client.callTool({ name: 'hue_set_light', arguments: { light: 'Desk lamp', brightness: 500 } });
    assert.equal(bad.isError, true);
    const ok = await call('hue_set_light', { light: 'Desk lamp', brightness: 33, kelvin: 4000 });
    assert.equal(ok.isError, false);
    assert.equal(ok.data['brightness'], 33);
    const put = fake.requests.filter((r) => r.method === 'PUT').at(-1)!;
    assert.equal(put.path, `/clip/v2/resource/light/${FIXTURE_IDS.bulbLight}`);
  });

  test('wait_for_event resolves on a matching sensor event', async () => {
    const pending = call('hue_wait_for_event', { resourceType: 'motion', timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    fake.updateResource('motion', FIXTURE_IDS.motion, { owner: { rid: FIXTURE_IDS.motionDevice, rtype: 'device' }, motion: { motion: true, motion_report: { changed: '2026-09-28T11:00:00Z', motion: true } } });
    const res = await pending;
    assert.equal(res.data['timedOut'], false);
    const changes = res.data['changes'] as Array<{ reading: { value: boolean }; device: { name: string } }>;
    assert.equal(changes[0]?.reading.value, true);
    assert.equal(changes[0]?.device.name, 'Hallway sensor');
    const timeout = await call('hue_wait_for_event', { resourceType: 'contact', timeoutMs: 150 });
    assert.equal(timeout.data['timedOut'], true);
  });
});
