/**
 * mDNS (DNS-SD) discovery of Hue bridges advertising `_hue._tcp.local`.
 *
 * Implemented on `node:dgram` with no dependencies. Notes for real networks:
 *  - mDNS is link-local multicast; it never crosses routers/VLANs and fails
 *    silently (empty result) inside many containers. Combine with cloud
 *    discovery or a manual host for those cases.
 *  - We ask for unicast responses (QU bit) so replies reach an ephemeral port
 *    even when port 5353 is owned by avahi/Bonjour; when we *can* bind 5353 we
 *    also join the multicast group to catch multicast replies.
 */

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { decodeMessage, encodeQuery, TYPE_A, TYPE_PTR, TYPE_SRV, TYPE_TXT, type DnsRecord } from './dns.js';
import type { DiscoveredBridge } from './types.js';

export const HUE_SERVICE = '_hue._tcp.local';
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

export interface MdnsOptions {
  /** How long to listen for responses (default 3000 ms). */
  timeoutMs?: number | undefined;
  /** Re-send the query every N ms while waiting (default 1000). */
  queryIntervalMs?: number | undefined;
  /** Bind to a specific interface address (default: all IPv4 interfaces). */
  interfaceAddress?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Called for every raw DNS record seen; useful for debugging. */
  onRecord?: ((record: DnsRecord, from: string) => void) | undefined;
}

interface Candidate {
  instance: string;
  target?: string;
  port?: number;
  txt?: Record<string, string>;
  addresses: string[];
}

export async function discoverViaMdns(options: MdnsOptions = {}): Promise<DiscoveredBridge[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const queryIntervalMs = options.queryIntervalMs ?? 1000;
  const candidates = new Map<string, Candidate>();
  const hostAddresses = new Map<string, string[]>();
  const socket = await openSocket(options.interfaceAddress);

  const query = encodeQuery([{ name: HUE_SERVICE, type: TYPE_PTR, unicastResponse: true }]);
  const send = () => {
    socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDR, () => {
      /* errors surface via 'error' event; ignore here */
    });
  };
  const askForDetails = (instance: string) => {
    const q = encodeQuery([
      { name: instance, type: TYPE_SRV, unicastResponse: true },
      { name: instance, type: TYPE_TXT, unicastResponse: true },
    ]);
    socket.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR, () => {});
  };
  const askForAddress = (target: string) => {
    const q = encodeQuery([{ name: target, type: TYPE_A, unicastResponse: true }]);
    socket.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR, () => {});
  };

  const candidateFor = (instance: string): Candidate => {
    let c = candidates.get(instance);
    if (!c) {
      c = { instance, addresses: [] };
      candidates.set(instance, c);
    }
    return c;
  };

  socket.on('message', (msg, rinfo) => {
    let decoded;
    try {
      decoded = decodeMessage(msg);
    } catch {
      return;
    }
    if (!decoded.isResponse) return;
    const records = [...decoded.answers, ...decoded.additionals];
    for (const r of records) {
      options.onRecord?.(r, rinfo.address);
      const name = r.name.toLowerCase();
      if (r.kind === 'PTR' && name === HUE_SERVICE) {
        const instance = r.data.toLowerCase();
        if (!candidates.has(instance)) {
          candidateFor(instance);
          askForDetails(r.data);
        }
      } else if (r.kind === 'SRV' && candidates.has(name)) {
        const c = candidateFor(name);
        const target = r.data.target.toLowerCase();
        c.target = target;
        c.port = r.data.port;
        if (!hostAddresses.has(target)) askForAddress(r.data.target);
      } else if (r.kind === 'TXT' && candidates.has(name)) {
        candidateFor(name).txt = r.data;
      } else if (r.kind === 'A' || r.kind === 'AAAA') {
        const list = hostAddresses.get(name) ?? [];
        if (!list.includes(r.data)) list.push(r.data);
        hostAddresses.set(name, list);
      }
    }
  });

  send();
  const interval = setInterval(send, queryIntervalMs);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    options.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  clearInterval(interval);
  socket.close();

  const results: DiscoveredBridge[] = [];
  for (const c of candidates.values()) {
    const addresses = c.target ? (hostAddresses.get(c.target) ?? []) : [];
    const ipv4 = addresses.find((a) => a.includes('.'));
    const host = ipv4 ?? addresses[0];
    const idRaw = c.txt?.['bridgeid'];
    if (!host || !idRaw) continue; // incomplete record set; another method may still find it
    const bridge: DiscoveredBridge = {
      id: idRaw.toLowerCase(),
      host,
      port: c.port ?? 443,
      sources: ['mdns'],
    };
    const name = instanceDisplayName(c.instance);
    if (name) bridge.name = name;
    const modelId = c.txt?.['modelid'];
    if (modelId) bridge.modelId = modelId;
    results.push(bridge);
  }
  return results;
}

function instanceDisplayName(instance: string): string | undefined {
  const suffix = `.${HUE_SERVICE}`;
  return instance.endsWith(suffix) ? instance.slice(0, -suffix.length) : undefined;
}

async function openSocket(interfaceAddress: string | undefined): Promise<Socket> {
  // Prefer the well-known port + multicast membership; fall back to an ephemeral port with QU replies.
  const attempt = (port: number) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', reject);
      socket.bind(port, interfaceAddress ?? '0.0.0.0', () => {
        socket.removeListener('error', reject);
        socket.on('error', () => {
          /* keep discovery alive on transient send errors */
        });
        try {
          socket.setMulticastTTL(255);
          if (port === MDNS_PORT) {
            for (const addr of localIpv4Addresses(interfaceAddress)) {
              try {
                socket.addMembership(MDNS_ADDR, addr);
              } catch {
                /* interface may not support multicast */
              }
            }
          }
        } catch {
          /* ignore; unicast responses still work */
        }
        resolve(socket);
      });
    });
  try {
    return await attempt(MDNS_PORT);
  } catch {
    return attempt(0);
  }
}

function localIpv4Addresses(only: string | undefined): string[] {
  if (only) return [only];
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out.length ? out : ['0.0.0.0'];
}
