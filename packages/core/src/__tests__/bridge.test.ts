import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeBridge, type FakeBridge } from '../test-support/index.js';
import { IDS } from '../test-support/fixtures.js';
import { HueClient } from '../client.js';
import { HueBridge } from '../model/bridge.js';
import { pairBridge, pairOnce } from '../pairing.js';
import { identifyBridge } from '../discovery/identify.js';
import { HttpTransport } from '../transport.js';
import { HueError, LinkButtonNotPressedError, PairingTimeoutError } from '../errors.js';
import type { SensorSnapshot } from '../model/snapshot.js';

describe('against a fake HTTPS bridge', () => {
  let fake: FakeBridge;
  before(async () => {
    fake = await startFakeBridge();
  });
  after(async () => {
    await fake.close();
  });

  test('identify reads config and captures the certificate fingerprint', async () => {
    const info = await identifyBridge(fake.host, { port: fake.port });
    assert.equal(info.id, fake.bridgeId);
    assert.equal(info.modelId, 'BSB002');
    assert.equal(info.certificate?.fingerprint256, fake.fingerprint);
    assert.equal(info.certificate?.selfSigned, true);
    assert.equal(info.certificate?.subjectCN, fake.bridgeId);
  });

  test('fingerprint pinning rejects a different certificate and accepts the right one', async () => {
    const wrong = new HttpTransport({ host: fake.host, port: fake.port, tls: { fingerprint: '00'.repeat(32) } });
    await assert.rejects(wrong.request('GET', '/api/0/config'), (err: HueError) => err.code === 'tls' && /fingerprint mismatch/.test(err.message));
    wrong.close();

    const right = new HttpTransport({ host: fake.host, port: fake.port, tls: { fingerprint: fake.fingerprint.toLowerCase() } });
    const res = await right.request<{ bridgeid: string }>('GET', '/api/0/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.bridgeid.toLowerCase(), fake.bridgeId);
    right.close();
  });

  test('CA + bridge id verification works with the self-signed cert as CA', async () => {
    const ok = new HttpTransport({ host: fake.host, port: fake.port, tls: { ca: fake.certPem, bridgeId: fake.bridgeId } });
    const res = await ok.request('GET', '/api/0/config');
    assert.equal(res.status, 200);
    ok.close();
    const badId = new HttpTransport({ host: fake.host, port: fake.port, tls: { ca: fake.certPem, bridgeId: 'ffffffffffffffff' } });
    await assert.rejects(badId.request('GET', '/api/0/config'), (err: HueError) => err.code === 'tls');
    badId.close();
  });

  test('unverified TLS (no options) is refused by default-safe callers but works when explicitly insecure', async () => {
    const insecure = new HttpTransport({ host: fake.host, port: fake.port, tls: { insecure: true } });
    const res = await insecure.request('GET', '/api/0/config');
    assert.equal(res.status, 200);
    insecure.close();
  });

  test('pairing waits for the link button, then returns pinned credentials', async () => {
    const t = new HttpTransport({ host: fake.host, port: fake.port, tls: { fingerprint: fake.fingerprint } });
    await assert.rejects(pairOnce(t, 'hue-sdk#test'), LinkButtonNotPressedError);
    t.close();

    await assert.rejects(pairBridge(fake.host, { port: fake.port, timeoutMs: 250, intervalMs: 50 }), PairingTimeoutError);

    let attempts = 0;
    const creds = await pairBridge(fake.host, {
      port: fake.port,
      appName: 'hue sdk tests',
      instanceName: 'ci',
      timeoutMs: 5000,
      intervalMs: 20,
      onWaiting: () => {
        attempts += 1;
        if (attempts === 2) fake.pressLinkButton();
      },
    });
    assert.ok(attempts >= 2);
    assert.equal(creds.bridgeId, fake.bridgeId);
    assert.equal(creds.applicationKey, fake.applicationKey);
    assert.match(creds.clientKey ?? '', /^[A-Z0-9]{32}$/);
    assert.equal(creds.fingerprint, fake.fingerprint);
    assert.equal(creds.deviceType, 'hue-sdk-tests#ci');
    assert.equal(creds.modelId, 'BSB002');
  });

  test('client maps HTTP errors to HueError codes', async () => {
    const bad = new HueClient({ host: fake.host, port: fake.port, applicationKey: 'nope', tls: { fingerprint: fake.fingerprint } });
    await assert.rejects(bad.list('light'), (err: HueError) => err.code === 'unauthorized' && err.status === 403);
    bad.close();
    const good = HueClient.fromCredentials({ bridgeId: fake.bridgeId, host: fake.host, port: fake.port, applicationKey: fake.applicationKey, fingerprint: fake.fingerprint, pairedAt: '', deviceType: 't' });
    await assert.rejects(good.get('light', 'missing'), (err: HueError) => err.code === 'not_found');
    await assert.rejects(good.update('light', IDS.plugLight, { color_temperature: { mirek: 200 } }), (err: HueError) => err.code === 'bad_request');
    const lights = await good.list('light');
    assert.equal(lights.length, 2);
    good.close();
  });

  test('device-centric model: devices, kinds, rooms, sensors, snapshots', async () => {
    const bridge = await HueBridge.connect({ bridgeId: fake.bridgeId, host: fake.host, port: fake.port, applicationKey: fake.applicationKey, fingerprint: fake.fingerprint, pairedAt: '', deviceType: 't' });
    try {
      assert.equal(bridge.devices.length, 5);
      const kinds = Object.fromEntries(bridge.devices.map((d) => [d.name, d.kind]));
      assert.deepEqual(kinds, { 'Philips hue': 'bridge', 'Desk lamp': 'light', 'Heater plug': 'plug', 'Hallway sensor': 'sensor', 'Bedroom dimmer': 'switch' });

      const sensorDevice = bridge.resolveDevice('hallway')!;
      assert.equal(sensorDevice.room?.name, 'Office');
      assert.deepEqual(sensorDevice.battery, { level: 87, state: 'normal' });
      assert.equal(sensorDevice.connectivity, 'connected');
      const readings = Object.fromEntries(sensorDevice.sensors().map((s) => [s.type, s]));
      assert.equal(readings['motion']?.value, false);
      assert.equal(readings['temperature']?.value, 21.4);
      assert.equal(readings['temperature']?.unit, '°C');
      assert.equal(readings['light_level']?.value, 99.98); // 10^((20000-1)/10000)
      assert.equal(readings['light_level']?.unit, 'lux');
      assert.equal(readings['device_power']?.value, 87);

      const lamp = bridge.resolveDevice('Desk lamp')!;
      assert.equal(lamp.lights.length, 1);
      assert.deepEqual(lamp.zones.map((z) => z.name), ['Downstairs']);
      const lampSnap = lamp.snapshot();
      assert.equal(lampSnap.lights[0]?.colorTemperature?.kelvin, 2732);
      assert.equal(lampSnap.lights[0]?.capabilities.color, true);
      assert.equal(lampSnap.product.modelId, 'LCA001');

      assert.deepEqual(bridge.findDevices({ room: 'office', kind: 'sensor' }).map((d) => d.name), ['Hallway sensor']);
      assert.deepEqual(bridge.findDevices({ service: 'button' }).map((d) => d.name), ['Bedroom dimmer']);
      assert.deepEqual(bridge.findDevices({ zone: 'Downstairs' }).map((d) => d.name).sort(), ['Desk lamp', 'Heater plug']);
      assert.equal(bridge.findDevices({ room: 'nope' }).length, 0);

      const office = bridge.group('Office')!;
      assert.deepEqual(office.deviceIds().sort(), [IDS.bulbDevice, IDS.motionDevice].sort());
      assert.deepEqual(office.scenes.map((s) => s.name), ['Concentrate']);
      assert.equal(bridge.zones[0]?.deviceIds().length, 2);

      const snap = bridge.snapshot();
      assert.equal(snap.bridge.id, fake.bridgeId);
      assert.equal(snap.bridge.modelId, 'BSB002');
      assert.equal(snap.rooms[0]?.light?.brightness, 63.24);
      assert.equal(snap.scenes.length, 1);
      assert.equal(bridge.sensors('temperature').length, 1);
      assert.equal(bridge.sensors().length, 7); // motion, temperature, light_level, device_power, 2 buttons, switch device_power
    } finally {
      bridge.close();
    }
  });

  test('light + group commands hit the right endpoints and events update the model', async () => {
    const bridge = await HueBridge.connect({ bridgeId: fake.bridgeId, host: fake.host, port: fake.port, applicationKey: fake.applicationKey, fingerprint: fake.fingerprint, pairedAt: '', deviceType: 't' });
    try {
      const sensorEvents: SensorSnapshot[] = [];
      bridge.on('sensor', (reading) => sensorEvents.push(reading));
      const changes: string[] = [];
      bridge.on('change', (c) => changes.push(...c.resources.map((r) => r.type)));
      await bridge.watch();

      const lamp = bridge.resolveLight('desk')!;
      await lamp.set({ brightness: 20, hex: '#0000ff', transitionMs: 100 });
      const put = fake.requests.filter((r) => r.method === 'PUT').at(-1)!;
      assert.equal(put.path, `/clip/v2/resource/light/${IDS.bulbLight}`);
      const body = put.body as { dimming: { brightness: number }; on: { on: boolean }; color: { xy: { x: number; y: number } } };
      assert.equal(body.dimming.brightness, 20);
      assert.equal(body.on.on, true);
      assert.ok(body.color.xy.x < 0.2);

      await bridge.group('Office')!.turnOff();
      const groupPut = fake.requests.filter((r) => r.method === 'PUT').at(-1)!;
      assert.equal(groupPut.path, `/clip/v2/resource/grouped_light/${IDS.roomGroupedLight}`);

      await bridge.group('Office')!.activateScene('concentrate');
      const scenePut = fake.requests.filter((r) => r.method === 'PUT').at(-1)!;
      assert.equal(scenePut.path, `/clip/v2/resource/scene/${IDS.scene}`);
      assert.deepEqual(scenePut.body, { recall: { action: 'active' } });

      // Sensor event from the bridge updates the model and emits a normalised reading.
      fake.updateResource('motion', IDS.motion, { owner: { rid: IDS.motionDevice, rtype: 'device' }, motion: { motion: true, motion_report: { changed: '2026-09-28T10:00:00Z', motion: true } } });
      await waitFor(() => sensorEvents.some((s) => s.type === 'motion' && s.value === true));
      assert.equal(bridge.resolveDevice('Hallway sensor')!.sensor('motion')?.value, true);
      assert.equal(bridge.resolveDevice('Hallway sensor')!.sensor('motion')?.changed, '2026-09-28T10:00:00Z');
      assert.ok(changes.includes('light')); // our own PUTs were echoed as events
      assert.equal(lamp.brightness, 100); // the Concentrate scene recall above set the lamp to 100, as the real bridge would
    } finally {
      bridge.close();
    }
  });

  test('event stream reconnects after the bridge drops the connection', async () => {
    const client = HueClient.fromCredentials({ bridgeId: fake.bridgeId, host: fake.host, port: fake.port, applicationKey: fake.applicationKey, fingerprint: fake.fingerprint, pairedAt: '', deviceType: 't' });
    const stream = client.events({ backoffMs: 20, maxBackoffMs: 50 });
    const connects: boolean[] = [];
    stream.on('connected', (i) => connects.push(i.reconnect));
    let disconnects = 0;
    stream.on('disconnected', () => disconnects++);
    await stream.start();
    fake.dropStreams();
    await waitFor(() => connects.length >= 2);
    assert.deepEqual(connects.slice(0, 2), [false, true]);
    assert.ok(disconnects >= 1);

    // async iteration yields events
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    fake.emit({ id: 'x', creationtime: 't', type: 'update', data: [{ id: IDS.plugLight, type: 'light', on: { on: true } }] });
    const { value } = await pending;
    assert.equal(value?.data[0]?.id, IDS.plugLight);
    stream.stop();
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    client.close();
  });
});

describe('against a plain-http emulator', () => {
  test('scheme http works for emulators', async () => {
    const fake = await startFakeBridge({ http: true });
    try {
      const client = new HueClient({ host: fake.host, port: fake.port, scheme: 'http', applicationKey: fake.applicationKey });
      const config = await client.getConfig();
      assert.equal(config.modelid, 'BSB002');
      const devices = await client.list('device');
      assert.equal(devices.length, 5);
      client.close();
    } finally {
      await fake.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
