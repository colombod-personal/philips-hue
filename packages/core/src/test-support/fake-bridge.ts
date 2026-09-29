/**
 * A minimal in-process Hue bridge emulator for tests: HTTPS with a freshly
 * generated self-signed certificate (like older real bridges), the v1
 * pairing endpoint with a "link button", the CLIP v2 resource endpoints and
 * the SSE event stream.
 */

import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { BaseResource, HueEvent } from '../types.js';
import { BRIDGE_ID, fixtureResources } from './fixtures.js';

export interface FakeBridgeOptions {
  /** Use plain HTTP (no certificate generation). */
  http?: boolean;
  bridgeId?: string;
  applicationKey?: string;
  resources?: BaseResource[];
}

export interface FakeBridge {
  host: string;
  port: number;
  scheme: 'https' | 'http';
  bridgeId: string;
  applicationKey: string;
  /** SHA-256 fingerprint of the server certificate (hex, no colons, upper-case). */
  fingerprint: string;
  /** PEM of the self-signed certificate (usable as `ca`). */
  certPem: string;
  linkButtonPressed: boolean;
  pressLinkButton(): void;
  resources: BaseResource[];
  /** Pushes an event to every connected event-stream client. */
  emit(event: HueEvent): void;
  /** Applies a partial update to a resource and emits the matching event. */
  updateResource(type: string, id: string, patch: Record<string, unknown>): void;
  /** Requests seen by the server (method + path + parsed body). */
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }>;
  /** Closes all event streams (simulates a dropped connection). */
  dropStreams(): void;
  close(): Promise<void>;
  server: Server;
}

export async function startFakeBridge(options: FakeBridgeOptions = {}): Promise<FakeBridge> {
  const bridgeId = options.bridgeId ?? BRIDGE_ID;
  const applicationKey = options.applicationKey ?? 'test-application-key-0123456789abcdef';
  const resources = options.resources ?? fixtureResources();
  const streams = new Set<ServerResponse>();
  const requests: FakeBridge['requests'] = [];
  let eventCounter = 0;
  const state = { linkButtonPressed: false };

  let certPem = '';
  let keyPem = '';
  let fingerprint = '';
  let tmp: string | undefined;
  if (!options.http) {
    tmp = mkdtempSync(join(tmpdir(), 'hue-fake-bridge-'));
    const keyPath = join(tmp, 'key.pem');
    const certPath = join(tmp, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', `/C=NL/O=Philips Hue/CN=${bridgeId}`,
    ], { stdio: 'ignore' });
    certPem = readFileSync(certPath, 'utf8');
    keyPem = readFileSync(keyPath, 'utf8');
    fingerprint = new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toUpperCase();
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          /* keep raw */
        }
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body });
      route(req, res, url.pathname, body);
    });
  };

  const json = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const route = (req: IncomingMessage, res: ServerResponse, path: string, body: unknown) => {
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/api/0/config') {
      return json(res, 200, {
        name: 'Fake hue',
        datastoreversion: '170',
        swversion: '1966060010',
        apiversion: '1.66.0',
        mac: '00:17:88:12:34:56',
        bridgeid: bridgeId.toUpperCase(),
        factorynew: false,
        replacesbridgeid: null,
        modelid: 'BSB002',
        starterkitid: '',
      });
    }
    if (method === 'POST' && path === '/api') {
      const b = body as { devicetype?: string; generateclientkey?: boolean };
      if (!b || typeof b.devicetype !== 'string') return json(res, 200, [{ error: { type: 2, address: '/', description: 'body contains invalid json' } }]);
      if (!state.linkButtonPressed) return json(res, 200, [{ error: { type: 101, address: '/', description: 'link button not pressed' } }]);
      state.linkButtonPressed = false;
      const success: Record<string, string> = { username: applicationKey };
      if (b.generateclientkey) success['clientkey'] = 'ABCDEF0123456789ABCDEF0123456789';
      return json(res, 200, [{ success }]);
    }
    const key = req.headers['hue-application-key'];
    if (key !== applicationKey) return json(res, 403, { errors: [{ description: 'Unauthorized' }], data: [] });

    if (method === 'GET' && path === '/eventstream/clip/v2') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    const m = /^\/clip\/v2\/resource(?:\/([a-z_]+)(?:\/([^/]+))?)?$/.exec(path);
    if (!m) return json(res, 404, { errors: [{ description: 'Not Found' }], data: [] });
    const [, type, id] = m;
    if (method === 'GET') {
      let data = resources;
      if (type) data = data.filter((r) => r.type === type);
      if (id) data = data.filter((r) => r.id === id);
      if (id && data.length === 0) return json(res, 404, { errors: [{ description: `resource ${type}/${id} not found` }], data: [] });
      return json(res, 200, { errors: [], data });
    }
    if (method === 'PUT' && type && id) {
      const target = resources.find((r) => r.type === type && r.id === id);
      if (!target) return json(res, 404, { errors: [{ description: 'Not Found' }], data: [] });
      const patch = body as Record<string, unknown>;
      if (type === 'light' && patch['color_temperature'] && target['color_temperature'] === undefined) {
        return json(res, 400, { errors: [{ description: 'invalid value, color_temperature, for parameter, ...' }], data: [] });
      }
      applyPatch(target, patch);
      broadcast({ id: `evt-${++eventCounter}`, creationtime: new Date().toISOString(), type: 'update', data: [{ id, type, ...patch }] });
      return json(res, 200, { errors: [], data: [{ rid: id, rtype: type }] });
    }
    return json(res, 405, { errors: [{ description: 'Method Not Allowed' }], data: [] });
  };

  const broadcast = (event: HueEvent) => {
    const frame = `id: ${Date.now()}:0\ndata: ${JSON.stringify([event])}\n\n`;
    for (const s of streams) s.write(frame);
  };

  const server = options.http ? createHttpServer(handler) : createHttpsServer({ cert: certPem, key: keyPem }, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return {
    host: '127.0.0.1',
    port,
    scheme: options.http ? 'http' : 'https',
    bridgeId,
    applicationKey,
    fingerprint,
    certPem,
    get linkButtonPressed() {
      return state.linkButtonPressed;
    },
    pressLinkButton: () => {
      state.linkButtonPressed = true;
    },
    resources,
    emit: broadcast,
    updateResource: (type, id, patch) => {
      const target = resources.find((r) => r.type === type && r.id === id);
      if (target) applyPatch(target, patch);
      broadcast({ id: `evt-${++eventCounter}`, creationtime: new Date().toISOString(), type: 'update', data: [{ id, type, ...patch }] });
    },
    requests,
    dropStreams: () => {
      for (const s of streams) s.destroy();
      streams.clear();
    },
    server: server as Server,
    close: async () => {
      for (const s of streams) s.destroy();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    const current = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && current && typeof current === 'object' && !Array.isArray(current)) {
      applyPatch(current as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}
