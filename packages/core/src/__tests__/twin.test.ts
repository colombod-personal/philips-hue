import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeSimulator } from '../twin/simulator.js';
import { recordBridge } from '../twin/recorder.js';
import { sampleRecording } from '../twin/sample.js';
import { isRecording, redactSecrets } from '../twin/recording.js';
import { IDS } from '../test-support/fixtures.js';
import { HueBridge } from '../model/bridge.js';
import { HueClient } from '../client.js';
import type { HueEvent } from '../types.js';

const creds = (sim: BridgeSimulator) => ({ bridgeId: sim.bridgeId, host: sim.host, port: sim.port, applicationKey: sim.applicationKey, fingerprint: sim.fingerprint, pairedAt: '', deviceType: 't' });

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('digital twin', () => {
  test('replays the recorded timeline in order at the requested speed and keeps state consistent', async () => {
    const sim = await BridgeSimulator.start({ recording: sampleRecording(), scheme: 'http', replay: { autoStart: false, speed: 50 } });
    try {
      const client = new HueClient({ host: sim.host, port: sim.port, scheme: 'http', applicationKey: sim.applicationKey });
      const stream = client.events();
      const seen: HueEvent[] = [];
      stream.on('event', (e) => seen.push(e));
      await stream.start();

      const t0 = Date.now();
      sim.replay.start();
      await waitFor(() => seen.length >= 10, 5000); // 10 recorded events over 20 s virtual = 0.4 s at 50x
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2500, `replay took ${elapsed} ms`);
      const types = seen.map((e) => e.data.map((d) => d.type).join('+'));
      assert.deepEqual(types.slice(0, 4), ['motion', 'light_level', 'button', 'button']);

      // State followed the timeline: the bulb ended up off, temperature updated.
      const light = await client.get('light', IDS.bulbLight);
      assert.equal(light.on?.on, false);
      const temp = await client.get('temperature', IDS.temperature);
      assert.equal(temp.temperature?.temperature_report?.temperature, 21.6);
      const state = sim.replay.state();
      assert.equal(state.nextEventIndex, state.totalEvents);
      await waitFor(() => !sim.replay.state().running, 3000);

      stream.stop();
      client.close();
    } finally {
      await sim.close();
    }
  });

  test('seek applies earlier events silently and rewinding restores the initial state', async () => {
    const sim = await BridgeSimulator.start({ recording: sampleRecording(), scheme: 'http', replay: { autoStart: false } });
    try {
      sim.replay.seek(5_000);
      assert.equal(sim.index.get('light', IDS.bulbLight)?.dimming?.brightness, 100);
      assert.equal(sim.index.get('motion', IDS.motion)?.motion?.motion, true);
      assert.equal(sim.emitted.length, 0);
      sim.replay.seek(0);
      assert.equal(sim.index.get('light', IDS.bulbLight)?.dimming?.brightness, 63.24);
      assert.equal(sim.replay.state().nextEventIndex, 0);
    } finally {
      await sim.close();
    }
  });

  test('writes mutate state and are echoed; scene recall applies the scene actions', async () => {
    const sim = await BridgeSimulator.start({ recording: sampleRecording(), replay: { autoStart: false } });
    try {
      const bridge = await HueBridge.connect(creds(sim));
      const seen: string[] = [];
      bridge.on('change', (c) => seen.push(...c.resources.map((r) => r.type)));
      await bridge.watch();
      await bridge.resolveLight('Desk lamp')!.set({ brightness: 10, transitionMs: 300 });
      await waitFor(() => seen.includes('light'));
      assert.equal(sim.index.get('light', IDS.bulbLight)?.dimming?.brightness, 10);
      assert.equal(sim.index.get('light', IDS.bulbLight)?.['dynamics'] !== undefined, true); // original field kept
      await bridge.group('Office')!.activateScene('Concentrate');
      await waitFor(() => seen.includes('scene'));
      assert.equal(sim.index.get('light', IDS.bulbLight)?.dimming?.brightness, 100);
      assert.equal(sim.index.get('light', IDS.bulbLight)?.color_temperature?.mirek, 233);
      assert.equal(sim.index.get('scene', IDS.scene)?.status?.active, 'static');
      assert.equal(bridge.scene('Concentrate')?.snapshot().active, 'static');
      bridge.close();
    } finally {
      await sim.close();
    }
  });

  test('control API drives the twin from outside the process', async () => {
    const sim = await BridgeSimulator.start({ recording: sampleRecording(), scheme: 'http', replay: { autoStart: false } });
    try {
      const base = sim.url;
      const state = (await (await fetch(`${base}/__twin/state`)).json()) as { linkButtonPressed: boolean; replay: { running: boolean } };
      assert.equal(state.linkButtonPressed, false);
      assert.equal(state.replay.running, false);

      await fetch(`${base}/__twin/link-button`, { method: 'POST' });
      const pair = (await (await fetch(`${base}/api`, { method: 'POST', body: JSON.stringify({ devicetype: 'x#y' }) })).json()) as Array<{ success?: { username: string } }>;
      assert.equal(pair[0]?.success?.username, sim.applicationKey);

      await fetch(`${base}/__twin/emit`, { method: 'POST', body: JSON.stringify({ resourceType: 'motion', id: IDS.motion, patch: { motion: { motion: true } } }) });
      assert.equal(sim.index.get('motion', IDS.motion)?.motion?.motion, true);

      const replay = (await (await fetch(`${base}/__twin/replay`, { method: 'POST', body: JSON.stringify({ action: 'seek', offsetMs: 13_000 }) })).json()) as { nextEventIndex: number };
      assert.equal(replay.nextEventIndex, 7);

      const exported = (await (await fetch(`${base}/__twin/recording`)).json()) as unknown;
      assert.ok(isRecording(exported));
      assert.equal((exported as { events: unknown[] }).events.length, 1); // only the injected event was broadcast

      await fetch(`${base}/__twin/reset`, { method: 'POST' });
      assert.equal(sim.index.get('motion', IDS.motion)?.motion?.motion, false);
      assert.equal(sim.emitted.length, 0);
    } finally {
      await sim.close();
    }
  });

  test('recorder captures a bridge (state, certificate, timed events) and never persists keys', async () => {
    const source = await BridgeSimulator.start({ recording: sampleRecording(), replay: { autoStart: false, speed: 100 } });
    try {
      const promise = recordBridge(creds(source), { durationMs: 700, label: 'round trip' });
      await new Promise((r) => setTimeout(r, 150));
      source.replay.start(); // 20 s of timeline at 100x = 200 ms
      const recording = await promise;
      assert.ok(isRecording(recording));
      assert.equal(recording.label, 'round trip');
      assert.equal(recording.bridge.config.bridgeid.toLowerCase(), source.bridgeId);
      assert.equal(recording.bridge.certificate?.fingerprint256, source.fingerprint);
      assert.equal(recording.resources.length, sampleRecording().resources.length);
      assert.equal(recording.events.length, sampleRecording().events.length);
      const offsets = recording.events.map((e) => e.offsetMs);
      assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
      assert.ok(!JSON.stringify(recording).includes(source.applicationKey));

      // The recording can itself power a twin.
      const twin = await BridgeSimulator.start({ recording, scheme: 'http', replay: { autoStart: false } });
      try {
        const bridge = await HueBridge.connect({ ...creds(twin), scheme: 'http' }, { tls: { insecure: true } });
        assert.equal(bridge.devices.length, 5);
        assert.equal(bridge.resolveDevice('Desk lamp')?.lights[0]?.isOn, true); // resources = state at capture start
        twin.replay.seek(recording.durationMs);
        await bridge.refresh();
        assert.equal(bridge.resolveDevice('Desk lamp')?.lights[0]?.isOn, false); // timeline end reproduces what happened
        bridge.close();
      } finally {
        await twin.close();
      }
    } finally {
      await source.close();
    }
  });

  test('redactSecrets scrubs keys anywhere in a structure', () => {
    const out = redactSecrets({ a: 'key=SECRETKEY123', b: ['SECRETKEY123', { c: 'x' }] }, ['SECRETKEY123', 'short']);
    assert.deepEqual(out, { a: 'key=<redacted>', b: ['<redacted>', { c: 'x' }] });
  });
});
