#!/usr/bin/env node
/**
 * `hue-twin` — record a real bridge into a recording, or serve a recording as
 * a local digital twin.
 *
 *   hue-twin record  --out office.json [--duration 600] [--bridge <id>] [--label "..."]
 *   hue-twin serve   [--recording office.json] [--port 8443] [--http] [--speed 10] [--loop] [--paused]
 *   hue-twin sample  > sample.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveConnection } from '../credentials.js';
import { recordBridge } from './recorder.js';
import { isRecording } from './recording.js';
import { sampleRecording } from './sample.js';
import { BridgeSimulator } from './simulator.js';

const USAGE = `hue-twin — Hue bridge digital twin

  hue-twin record --out <file> [--duration <seconds>] [--bridge <bridge-id>] [--label <text>]
      Capture config, certificate, all resources and the event stream of the paired bridge
      (credentials from HUE_* env vars or the hue credential store). Keys are never written.

  hue-twin serve [--recording <file>] [--port <n>] [--host <addr>] [--http] [--speed <x>] [--loop] [--paused] [--key <application-key>] [--cert-dir <dir> | --ephemeral-cert]
      Serve a recording as a local bridge (default: built-in sample, HTTPS on a random port).
      The certificate is persisted per bridge id under ~/.config/hue-sdk/twin/ so pinned credentials survive restarts.
      Control API: GET /__twin/state, POST /__twin/link-button, POST /__twin/emit, POST /__twin/replay, POST /__twin/reset, GET /__twin/recording

  hue-twin sample
      Print the built-in sample recording as JSON.
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      out: { type: 'string' },
      duration: { type: 'string' },
      bridge: { type: 'string' },
      label: { type: 'string' },
      recording: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      http: { type: 'boolean', default: false },
      speed: { type: 'string' },
      loop: { type: 'boolean', default: false },
      paused: { type: 'boolean', default: false },
      key: { type: 'string' },
      'cert-dir': { type: 'string' },
      'ephemeral-cert': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  switch (command) {
    case 'sample':
      process.stdout.write(JSON.stringify(sampleRecording(), null, 2) + '\n');
      return 0;
    case 'record': {
      if (!values.out) {
        process.stderr.write('record: --out <file> is required\n');
        return 2;
      }
      const resolved = await resolveConnection({ bridgeId: values.bridge });
      if (!resolved) {
        process.stderr.write('No bridge credentials found. Pair first (hue pair <host>) or set HUE_BRIDGE_HOST / HUE_APPLICATION_KEY.\n');
        return 3;
      }
      const durationMs = values.duration ? Number(values.duration) * 1000 : 60_000;
      const controller = new AbortController();
      process.on('SIGINT', () => {
        process.stderr.write('\nStopping capture early…\n');
        controller.abort();
      });
      let count = 0;
      const recording = await recordBridge(resolved.credentials, {
        durationMs,
        label: values.label,
        signal: controller.signal,
        client: { tls: resolved.tls },
        onStatus: (m) => process.stderr.write(`${m}\n`),
        onEvent: (e) => {
          count += 1;
          const types = e.event.data.map((d) => d.type).join(',');
          process.stderr.write(`  +${(e.offsetMs / 1000).toFixed(1)}s ${e.event.type} ${types}\n`);
        },
      });
      await writeFile(values.out, JSON.stringify(recording, null, 2) + '\n');
      process.stderr.write(`Wrote ${values.out}: ${recording.resources.length} resources, ${count} events, bridge ${recording.bridge.config.bridgeid}.\n`);
      return 0;
    }
    case 'serve': {
      let recording = sampleRecording();
      if (values.recording) {
        const parsed: unknown = JSON.parse(await readFile(values.recording, 'utf8'));
        if (!isRecording(parsed)) {
          process.stderr.write(`${values.recording} is not a hue-twin recording.\n`);
          return 2;
        }
        recording = parsed;
      }
      const bridgeId = recording.bridge.config.bridgeid.toLowerCase();
      const configHome = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
      const certificateDir = values['ephemeral-cert'] ? undefined : (values['cert-dir'] ?? join(configHome, 'hue-sdk', 'twin', bridgeId));
      const sim = await BridgeSimulator.start({
        recording,
        certificateDir,
        scheme: values.http ? 'http' : 'https',
        port: values.port ? Number(values.port) : 0,
        host: values.host,
        applicationKey: values.key,
        replay: { autoStart: !values.paused, speed: values.speed ? Number(values.speed) : 1, loop: values.loop },
      });
      process.stderr.write(
        [
          `Hue digital twin for bridge ${sim.bridgeId} (${recording.label ?? 'unlabelled'})`,
          `  URL:              ${sim.url}`,
          `  application key:  ${sim.applicationKey}`,
          sim.fingerprint ? `  cert fingerprint: ${sim.fingerprint}${certificateDir ? ` (persisted in ${certificateDir})` : ' (ephemeral)'}` : '  TLS:              off (http)',
          `  timeline:         ${recording.events.length} events over ${(recording.durationMs / 1000).toFixed(1)}s, speed ${sim.replay.state().speed}x${values.loop ? ', looping' : ''}${values.paused ? ', paused' : ''}`,
          '',
          '  Point the SDK at it:',
          `    HUE_BRIDGE_HOST=${sim.host} HUE_BRIDGE_PORT=${sim.port} HUE_APPLICATION_KEY=${sim.applicationKey}${sim.fingerprint ? ` HUE_BRIDGE_FINGERPRINT=${sim.fingerprint}` : ' HUE_BRIDGE_SCHEME=http'}`,
          '  Or pair against it: POST /__twin/link-button, then hue pair ' + sim.host + (sim.port !== 443 ? ` (port ${sim.port})` : ''),
          '',
        ].join('\n'),
      );
      await new Promise<void>((resolve) => process.once('SIGINT', resolve).once('SIGTERM', resolve));
      await sim.close();
      return 0;
    }
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
