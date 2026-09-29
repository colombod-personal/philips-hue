/**
 * Records a real bridge into a {@link Recording}: config + certificate, the
 * full resource set, and the event stream for `durationMs`.
 *
 * Usage (also exposed as `hue-twin record`):
 *
 * ```ts
 * const recording = await recordBridge(credentials, { durationMs: 10 * 60_000 });
 * await writeFile('office.json', JSON.stringify(recording));
 * ```
 */

import { HueClient, type HueClientOptions } from '../client.js';
import { fetchBridgeConfig } from '../discovery/identify.js';
import type { BridgeCredentials } from '../pairing.js';
import type { HueEvent } from '../types.js';
import { EXCLUDED_RESOURCE_TYPES, RECORDING_VERSION, redactSecrets, type RecordedEvent, type Recording } from './recording.js';

export interface RecordOptions {
  /** How long to capture events (default 60 000 ms). 0 captures state only. */
  durationMs?: number | undefined;
  label?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Called for every captured event (progress display). */
  onEvent?: ((recorded: RecordedEvent) => void) | undefined;
  onStatus?: ((message: string) => void) | undefined;
  client?: Partial<HueClientOptions> | undefined;
  /** Extra secrets to scrub from the output (the application/client keys always are). */
  secrets?: string[] | undefined;
}

export async function recordBridge(creds: BridgeCredentials, options: RecordOptions = {}): Promise<Recording> {
  const durationMs = options.durationMs ?? 60_000;
  const client = HueClient.fromCredentials(creds, options.client ?? {});
  const secrets = [creds.applicationKey, ...(creds.clientKey ? [creds.clientKey] : []), ...(options.secrets ?? [])];
  try {
    options.onStatus?.(`Reading bridge config from ${creds.host}…`);
    const { config, certificate } = await fetchBridgeConfig(creds.host, { port: creds.port, scheme: creds.scheme ?? 'https', signal: options.signal });
    options.onStatus?.('Fetching all resources…');
    const resources = (await client.listAll(options.signal)).filter((r) => !EXCLUDED_RESOURCE_TYPES.has(r.type));
    const recordedAt = new Date();
    const events: RecordedEvent[] = [];

    if (durationMs > 0) {
      options.onStatus?.(`Capturing events for ${Math.round(durationMs / 1000)} s…`);
      const stream = client.events({ reconnect: true, signal: options.signal });
      const started = Date.now();
      stream.on('event', (event: HueEvent) => {
        const recorded: RecordedEvent = { offsetMs: Date.now() - started, event };
        events.push(recorded);
        options.onEvent?.(recorded);
      });
      stream.on('error', (err) => options.onStatus?.(`stream error: ${err.message}`));
      await stream.start();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, durationMs);
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      stream.stop();
    }

    const recording: Recording = {
      version: RECORDING_VERSION,
      recordedAt: recordedAt.toISOString(),
      durationMs,
      bridge: { config, host: creds.host },
      resources,
      events,
    };
    if (options.label) recording.label = options.label;
    if (certificate) recording.bridge.certificate = certificate;
    return redactSecrets(recording, secrets);
  } finally {
    client.close();
  }
}
