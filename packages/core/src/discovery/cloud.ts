/**
 * Cloud-assisted discovery via `https://discovery.meethue.com/`.
 *
 * Each bridge periodically reports its LAN address to Signify; the endpoint
 * returns the bridges registered from the caller's public IP. It answers
 * `[]` when the bridge and the caller are behind different public IPs and
 * `429` when polled too often (Signify suggests at most once per 15 minutes).
 */

import { HueError } from '../errors.js';
import type { DiscoveredBridge } from './types.js';

export const CLOUD_DISCOVERY_URL = 'https://discovery.meethue.com/';

export interface CloudDiscoveryOptions {
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Override the endpoint (tests / proxies). */
  url?: string | undefined;
  /** Injectable fetch (defaults to global fetch). */
  fetch?: typeof fetch | undefined;
}

interface CloudEntry {
  id: string;
  internalipaddress: string;
  port?: number;
}

export async function discoverViaCloud(options: CloudDiscoveryOptions = {}): Promise<DiscoveredBridge[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new HueError('discovery_failed', 'fetch is not available in this runtime.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await doFetch(options.url ?? CLOUD_DISCOVERY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'hue-sdk' },
    });
    if (res.status === 429) {
      throw new HueError('rate_limited', 'discovery.meethue.com rate limit hit; retry in a few minutes.', { status: 429 });
    }
    if (!res.ok) {
      throw new HueError('discovery_failed', `discovery.meethue.com responded with HTTP ${res.status}.`, { status: res.status });
    }
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) throw new HueError('invalid_response', 'Unexpected payload from discovery.meethue.com.', { details: json });
    return json
      .filter((e): e is CloudEntry => typeof e === 'object' && e !== null && typeof (e as CloudEntry).id === 'string' && typeof (e as CloudEntry).internalipaddress === 'string')
      .map((e) => ({ id: e.id.toLowerCase(), host: e.internalipaddress, port: e.port ?? 443, sources: ['cloud'] as const }))
      .map((b) => ({ ...b, sources: [...b.sources] }));
  } catch (err) {
    if (err instanceof HueError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HueError('discovery_failed', `Cloud discovery failed: ${message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
