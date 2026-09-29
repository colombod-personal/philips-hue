/**
 * Built-in sample recording: a small home (bridge, colour bulb, plug, motion
 * sensor with temperature/light level/battery, dimmer switch, a room, a zone,
 * a scene) plus a 20 s scripted timeline. It mirrors the shape of real
 * recordings so tests and demos run without hardware; replace it with a real
 * capture from `hue-twin record` as soon as you have one.
 */

import type { HueEvent } from '../types.js';
import { fixtureResources, IDS, BRIDGE_ID } from '../test-support/fixtures.js';
import { RECORDING_VERSION, type Recording } from './recording.js';

function update(offsetMs: number, data: HueEvent['data']): { offsetMs: number; event: HueEvent } {
  return { offsetMs, event: { id: `sample-${offsetMs}`, creationtime: '2026-09-28T09:00:00Z', type: 'update', data } };
}

export function sampleRecording(): Recording {
  const owner = (rid: string) => ({ rid, rtype: 'device' as const });
  return {
    version: RECORDING_VERSION,
    recordedAt: '2026-09-28T09:00:00.000Z',
    durationMs: 20_000,
    label: 'sample: office, someone walks in, presses the dimmer, leaves',
    bridge: {
      config: {
        name: 'Philips hue',
        datastoreversion: '170',
        swversion: '1966060010',
        apiversion: '1.66.0',
        mac: '00:17:88:12:34:56',
        bridgeid: BRIDGE_ID.toUpperCase(),
        factorynew: false,
        replacesbridgeid: null,
        modelid: 'BSB002',
        starterkitid: '',
      },
    },
    resources: fixtureResources(),
    events: [
      update(1_000, [{ id: IDS.motion, type: 'motion', owner: owner(IDS.motionDevice), motion: { motion: true, motion_report: { changed: '2026-09-28T09:00:01Z', motion: true } } }]),
      update(1_500, [{ id: IDS.lightLevel, type: 'light_level', owner: owner(IDS.motionDevice), light: { light_level: 24000, light_level_report: { changed: '2026-09-28T09:00:01Z', light_level: 24000 } } }]),
      update(4_000, [{ id: IDS.switchButton1, type: 'button', owner: owner(IDS.switchDevice), button: { button_report: { updated: '2026-09-28T09:00:04Z', event: 'initial_press' } } }]),
      update(4_200, [{ id: IDS.switchButton1, type: 'button', owner: owner(IDS.switchDevice), button: { button_report: { updated: '2026-09-28T09:00:04Z', event: 'short_release' } } }]),
      update(4_300, [
        { id: IDS.bulbLight, type: 'light', owner: owner(IDS.bulbDevice), on: { on: true }, dimming: { brightness: 100 } },
        { id: IDS.roomGroupedLight, type: 'grouped_light', owner: { rid: IDS.room, rtype: 'room' }, on: { on: true }, dimming: { brightness: 100 } },
      ]),
      update(9_000, [{ id: IDS.motion, type: 'motion', owner: owner(IDS.motionDevice), motion: { motion: false, motion_report: { changed: '2026-09-28T09:00:09Z', motion: false } } }]),
      update(12_000, [{ id: IDS.temperature, type: 'temperature', owner: owner(IDS.motionDevice), temperature: { temperature: 21.6, temperature_report: { changed: '2026-09-28T09:00:12Z', temperature: 21.6 } } }]),
      update(15_000, [{ id: 'z0000000-0000-4000-8000-000000000012', type: 'zigbee_connectivity', owner: owner(IDS.bulbDevice), status: 'connectivity_issue' }]),
      update(17_000, [{ id: 'z0000000-0000-4000-8000-000000000012', type: 'zigbee_connectivity', owner: owner(IDS.bulbDevice), status: 'connected' }]),
      update(19_000, [{ id: IDS.bulbLight, type: 'light', owner: owner(IDS.bulbDevice), on: { on: false } }, { id: IDS.roomGroupedLight, type: 'grouped_light', owner: { rid: IDS.room, rtype: 'room' }, on: { on: false } }]),
    ],
  };
}
