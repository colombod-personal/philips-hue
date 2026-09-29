/**
 * Bridge discovery façade: runs mDNS and cloud discovery concurrently, merges
 * by bridge id (preferring mDNS, which proves link-local reachability) and
 * optionally confirms each hit by contacting the bridge.
 */

import { HueError } from '../errors.js';
import { discoverViaCloud, type CloudDiscoveryOptions } from './cloud.js';
import { fetchBridgeConfig, identifyBridge, type IdentifyOptions } from './identify.js';
import { discoverViaMdns, type MdnsOptions } from './mdns.js';
import type { DiscoveredBridge, DiscoverySource } from './types.js';

export interface DiscoverOptions {
  /** Methods to run (default: both mDNS and cloud). */
  methods?: Array<'mdns' | 'cloud'> | undefined;
  mdns?: MdnsOptions | undefined;
  cloud?: CloudDiscoveryOptions | undefined;
  /** Contact each bridge for its config + certificate (default true). */
  verify?: boolean | undefined;
  identify?: IdentifyOptions | undefined;
  signal?: AbortSignal | undefined;
}

export interface DiscoveryReport {
  bridges: DiscoveredBridge[];
  /** Per-method failures; discovery still returns whatever the other methods found. */
  errors: Partial<Record<'mdns' | 'cloud', HueError>>;
}

export async function discoverBridges(options: DiscoverOptions = {}): Promise<DiscoveredBridge[]> {
  return (await discoverBridgesDetailed(options)).bridges;
}

export async function discoverBridgesDetailed(options: DiscoverOptions = {}): Promise<DiscoveryReport> {
  const methods = options.methods ?? ['mdns', 'cloud'];
  const errors: DiscoveryReport['errors'] = {};
  const tasks: Array<Promise<DiscoveredBridge[]>> = [];
  if (methods.includes('mdns')) {
    tasks.push(
      discoverViaMdns({ ...(options.mdns ?? {}), signal: options.signal }).catch((err: unknown) => {
        errors.mdns = toHueError(err);
        return [];
      }),
    );
  }
  if (methods.includes('cloud')) {
    tasks.push(
      discoverViaCloud({ ...(options.cloud ?? {}), signal: options.signal }).catch((err: unknown) => {
        errors.cloud = toHueError(err);
        return [];
      }),
    );
  }
  const found = (await Promise.all(tasks)).flat();
  const merged = mergeBridges(found);
  if (options.verify ?? true) {
    await Promise.all(
      merged.map(async (bridge) => {
        try {
          const { config, certificate } = await fetchBridgeConfig(bridge.host, { ...(options.identify ?? {}), port: bridge.port, signal: options.signal });
          bridge.config = config;
          bridge.name = config.name;
          bridge.modelId = config.modelid;
          if (certificate) bridge.certificate = certificate;
          if (config.bridgeid.toLowerCase() !== bridge.id) {
            // Cloud cache can be stale (DHCP moved the address): trust what the bridge itself says.
            bridge.id = config.bridgeid.toLowerCase();
          }
        } catch {
          /* leave unverified; caller can still try */
        }
      }),
    );
  }
  return { bridges: merged, errors };
}

export function mergeBridges(list: DiscoveredBridge[]): DiscoveredBridge[] {
  const byId = new Map<string, DiscoveredBridge>();
  const rank: Record<DiscoverySource, number> = { mdns: 0, manual: 1, cloud: 2 };
  for (const b of list) {
    const key = b.id.toLowerCase();
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, { ...b, id: key, sources: [...b.sources] });
      continue;
    }
    const preferNew = rank[b.sources[0] ?? 'cloud'] < rank[existing.sources[0] ?? 'cloud'];
    const primary = preferNew ? b : existing;
    const secondary = preferNew ? existing : b;
    byId.set(key, {
      ...secondary,
      ...primary,
      id: key,
      sources: [...new Set([...primary.sources, ...secondary.sources])],
    });
  }
  return [...byId.values()];
}

function toHueError(err: unknown): HueError {
  if (err instanceof HueError) return err;
  return new HueError('discovery_failed', err instanceof Error ? err.message : String(err), { cause: err });
}

export { discoverViaCloud, discoverViaMdns, identifyBridge, fetchBridgeConfig };
export type { CloudDiscoveryOptions, MdnsOptions, IdentifyOptions, DiscoveredBridge, DiscoverySource };
export type { IdentifyResult } from './identify.js';
