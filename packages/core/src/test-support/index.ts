/**
 * Test support, exported as `@hue-sdk/core/test-support`.
 *
 * `startFakeBridge()` starts the digital twin ({@link BridgeSimulator}) on the
 * built-in sample recording with the replay paused, which gives tests a
 * deterministic bridge they can drive by hand (`pressLinkButton`,
 * `updateResource`, `emit`, `dropStreams`). Load a real recording with
 * `BridgeSimulator.start({ recording })` for scenario tests.
 */

import { BridgeSimulator, type SimulatorOptions } from '../twin/simulator.js';
import { sampleRecording } from '../twin/sample.js';
import type { Recording } from '../twin/recording.js';

export interface FakeBridgeOptions extends Partial<Omit<SimulatorOptions, 'recording' | 'scheme'>> {
  /** Use plain HTTP (no certificate generation). */
  http?: boolean | undefined;
  recording?: Recording | undefined;
}

export type FakeBridge = BridgeSimulator;

export async function startFakeBridge(options: FakeBridgeOptions = {}): Promise<BridgeSimulator> {
  const { http, recording, ...rest } = options;
  return BridgeSimulator.start({
    recording: recording ?? sampleRecording(),
    scheme: http ? 'http' : 'https',
    replay: { autoStart: false },
    ...rest,
  });
}

export { BridgeSimulator, sampleRecording };
export { fixtureResources, IDS as FIXTURE_IDS, BRIDGE_ID as FIXTURE_BRIDGE_ID } from './fixtures.js';
