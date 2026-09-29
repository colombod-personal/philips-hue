/**
 * Bridge digital twin: a local server that behaves like a Hue bridge, backed by
 * a {@link Recording}.
 *
 * - Serves the same endpoints a real bridge does: `GET /api/0/config`,
 *   `POST /api` (pairing, with a virtual link button), the CLIP v2 resource
 *   endpoints and the `/eventstream/clip/v2` SSE stream, over HTTPS with a
 *   certificate whose CN is the recorded bridge id (or plain HTTP).
 * - Replays the recorded event timeline at configurable speed, applying each
 *   event to its state so `GET`s and the stream stay consistent.
 * - Applies writes (`PUT light/…`, `PUT grouped_light/…`, scene recall) to the
 *   state and echoes them as events, like the real bridge.
 * - Exposes a control API under `/__twin/*` (press the button, inject events,
 *   drive the replay, reset, export the current state as a new recording) so
 *   tests and agents can script scenarios from outside the process.
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceIndex } from '../model/index-store.js';
import type { BaseResource, HueEvent, LightResource, SceneResource } from '../types.js';
import { cloneRecording, RECORDING_VERSION, type RecordedEvent, type RecordedRequest, type Recording } from './recording.js';

export interface ReplayOptions {
  /** Start replaying the recorded timeline as soon as the server is up (default true). */
  autoStart?: boolean | undefined;
  /** 1 = real time, 10 = ten times faster, 0.5 = half speed (default 1). */
  speed?: number | undefined;
  /** Restart from the beginning (with the initial state) when the timeline ends (default false). */
  loop?: boolean | undefined;
}

export interface SimulatorOptions {
  recording: Recording;
  scheme?: 'https' | 'http' | undefined;
  /** 0 picks a free port (default). */
  port?: number | undefined;
  host?: string | undefined;
  /** Application key the twin accepts. Generated when omitted. */
  applicationKey?: string | undefined;
  /** Start with the link button already pressed (default false). */
  linkButtonPressed?: boolean | undefined;
  replay?: ReplayOptions | undefined;
  /** Enable the `/__twin/*` control API (default true). */
  controlApi?: boolean | undefined;
  /** Use a provided certificate instead of generating one. */
  certificate?: { cert: string; key: string } | undefined;
  /**
   * Directory in which to persist the generated certificate (`cert.pem`, `key.pem`)
   * so the twin keeps the same fingerprint across restarts and pinned
   * credentials stay valid. When omitted a temporary certificate is generated.
   */
  certificateDir?: string | undefined;
  /** Artificial response latency in ms (default 0). */
  latencyMs?: number | undefined;
}

export interface ReplayState {
  running: boolean;
  /** Virtual position on the recorded timeline, in ms. */
  positionMs: number;
  speed: number;
  loop: boolean;
  totalEvents: number;
  nextEventIndex: number;
  durationMs: number;
}

export class BridgeSimulator {
  readonly host: string;
  readonly port: number;
  readonly scheme: 'https' | 'http';
  readonly bridgeId: string;
  readonly applicationKey: string;
  /** SHA-256 fingerprint (hex, no colons, upper-case) of the served certificate; empty for HTTP. */
  readonly fingerprint: string;
  readonly certPem: string;
  /** Every request the twin has served. */
  readonly requests: RecordedRequest[] = [];
  /** Every event the twin has broadcast (replayed, echoed or injected). */
  readonly emitted: RecordedEvent[] = [];
  readonly index = new ResourceIndex();

  private readonly recording: Recording;
  private readonly initialResources: BaseResource[];
  private readonly server: Server;
  private readonly streams = new Set<ServerResponse>();
  private readonly sockets = new Set<Socket>();
  private readonly tmpDir: string | undefined;
  private readonly options: SimulatorOptions;
  private linkButton: boolean;
  private eventCounter = 0;
  private readonly startedAt = Date.now();

  // replay engine
  private replayRunning = false;
  private replayAnchorWall = 0;
  private replayAnchorPos = 0;
  private replaySpeed: number;
  private replayLoop: boolean;
  private nextEventIndex = 0;
  private replayTimer: NodeJS.Timeout | undefined;

  private constructor(options: SimulatorOptions, server: Server, tls: { certPem: string; keyPem: string; fingerprint: string; tmpDir?: string }) {
    this.options = options;
    this.recording = cloneRecording(options.recording);
    this.initialResources = structuredClone(this.recording.resources);
    this.index.replaceAll(structuredClone(this.initialResources));
    this.bridgeId = this.recording.bridge.config.bridgeid.toLowerCase();
    this.applicationKey = options.applicationKey ?? generateKey();
    this.linkButton = options.linkButtonPressed ?? false;
    this.scheme = options.scheme ?? 'https';
    this.host = options.host ?? '127.0.0.1';
    this.server = server;
    this.certPem = tls.certPem;
    this.fingerprint = tls.fingerprint;
    if (tls.tmpDir !== undefined) this.tmpDir = tls.tmpDir;
    this.replaySpeed = options.replay?.speed ?? 1;
    this.replayLoop = options.replay?.loop ?? false;
    this.port = (server.address() as AddressInfo).port;
  }

  static async start(options: SimulatorOptions): Promise<BridgeSimulator> {
    const scheme = options.scheme ?? 'https';
    const host = options.host ?? '127.0.0.1';
    let tls: { certPem: string; keyPem: string; fingerprint: string; tmpDir?: string } = { certPem: '', keyPem: '', fingerprint: '' };
    if (scheme === 'https') {
      tls = options.certificate
        ? { certPem: options.certificate.cert, keyPem: options.certificate.key, fingerprint: fingerprintOf(options.certificate.cert) }
        : loadOrGenerateCertificate(options.recording.bridge.config.bridgeid.toLowerCase(), options.certificateDir);
    }
    let sim: BridgeSimulator | undefined;
    const handler = (req: IncomingMessage, res: ServerResponse) => sim?.handle(req, res);
    const server = scheme === 'https' ? createHttpsServer({ cert: tls.certPem, key: tls.keyPem }, handler) : createHttpServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    sim = new BridgeSimulator(options, server, tls);
    server.on('connection', (s) => {
      sim!.sockets.add(s);
      s.on('close', () => sim!.sockets.delete(s));
    });
    if (options.replay?.autoStart ?? true) sim.replay.start();
    return sim;
  }

  get url(): string {
    return `${this.scheme}://${this.host}:${this.port}`;
  }

  get linkButtonPressed(): boolean {
    return this.linkButton;
  }

  /** Simulates pressing the physical link button (valid for the next pairing request). */
  pressLinkButton(): void {
    this.linkButton = true;
  }

  get resources(): BaseResource[] {
    return this.index.all();
  }

  /* ---------- scripted interaction ---------- */

  /** Broadcasts an event and applies it to the state. */
  emit(event: HueEvent): void {
    this.applyAndBroadcast(event);
  }

  /** Applies a partial update to a resource and emits the matching `update` event. */
  updateResource(type: string, id: string, patch: Record<string, unknown>): void {
    const existing = this.index.get(type, id);
    const data: BaseResource = { ...(patch as Record<string, unknown>), id, type } as BaseResource;
    if (existing?.owner && !data.owner) data.owner = existing.owner;
    this.applyAndBroadcast({ id: this.nextEventId(), creationtime: new Date().toISOString(), type: 'update', data: [data] });
  }

  /** Closes every open event stream (simulates the bridge dropping connections). */
  dropStreams(): void {
    for (const s of this.streams) s.destroy();
    this.streams.clear();
  }

  /** Restores the initial state and rewinds the replay (keeps pairing state). */
  reset(): void {
    this.replay.pause();
    this.index.replaceAll(structuredClone(this.initialResources));
    this.nextEventIndex = 0;
    this.replayAnchorPos = 0;
    this.emitted.length = 0;
    this.requests.length = 0;
  }

  /** Exports the current state plus everything emitted since start as a new recording. */
  exportRecording(label?: string): Recording {
    const out: Recording = {
      version: RECORDING_VERSION,
      recordedAt: new Date(this.startedAt).toISOString(),
      durationMs: Date.now() - this.startedAt,
      bridge: { config: structuredClone(this.recording.bridge.config), host: this.host },
      resources: structuredClone(this.index.all()),
      events: structuredClone(this.emitted),
      requests: structuredClone(this.requests),
    };
    if (label) out.label = label;
    if (this.recording.bridge.certificate) out.bridge.certificate = this.recording.bridge.certificate;
    return out;
  }

  /* ---------- replay ---------- */

  readonly replay = {
    start: (): void => {
      if (this.replayRunning) return;
      this.replayRunning = true;
      this.replayAnchorWall = Date.now();
      this.scheduleNext();
    },
    pause: (): void => {
      if (!this.replayRunning) return;
      this.replayAnchorPos = this.replay.position();
      this.replayRunning = false;
      if (this.replayTimer) clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    },
    /** Jumps to an offset; events before it are applied silently (state only, no broadcast). */
    seek: (offsetMs: number): void => {
      const wasRunning = this.replayRunning;
      this.replay.pause();
      if (offsetMs < this.replayAnchorPos) {
        this.index.replaceAll(structuredClone(this.initialResources));
        this.nextEventIndex = 0;
      }
      while (this.nextEventIndex < this.recording.events.length && (this.recording.events[this.nextEventIndex]?.offsetMs ?? Infinity) <= offsetMs) {
        this.index.apply(this.recording.events[this.nextEventIndex]!.event);
        this.nextEventIndex += 1;
      }
      this.replayAnchorPos = offsetMs;
      if (wasRunning) this.replay.start();
    },
    setSpeed: (speed: number): void => {
      if (!(speed > 0)) throw new Error('speed must be > 0');
      const wasRunning = this.replayRunning;
      this.replay.pause();
      this.replaySpeed = speed;
      if (wasRunning) this.replay.start();
    },
    position: (): number => (this.replayRunning ? this.replayAnchorPos + (Date.now() - this.replayAnchorWall) * this.replaySpeed : this.replayAnchorPos),
    state: (): ReplayState => ({
      running: this.replayRunning,
      positionMs: Math.round(this.replay.position()),
      speed: this.replaySpeed,
      loop: this.replayLoop,
      totalEvents: this.recording.events.length,
      nextEventIndex: this.nextEventIndex,
      durationMs: this.recording.durationMs,
    }),
  };

  private scheduleNext(): void {
    if (!this.replayRunning) return;
    const next = this.recording.events[this.nextEventIndex];
    if (!next) {
      const end = Math.max(this.recording.durationMs, this.recording.events.at(-1)?.offsetMs ?? 0);
      const remaining = Math.max(0, (end - this.replay.position()) / this.replaySpeed);
      if (this.replayLoop) {
        this.replayTimer = setTimeout(() => {
          this.replay.pause();
          this.index.replaceAll(structuredClone(this.initialResources));
          this.nextEventIndex = 0;
          this.replayAnchorPos = 0;
          this.replay.start();
        }, remaining);
        this.replayTimer.unref?.();
      } else {
        this.replayTimer = setTimeout(() => this.replay.pause(), remaining);
        this.replayTimer.unref?.();
      }
      return;
    }
    const delay = Math.max(0, (next.offsetMs - this.replay.position()) / this.replaySpeed);
    this.replayTimer = setTimeout(() => {
      this.nextEventIndex += 1;
      const event = structuredClone(next.event);
      event.creationtime = new Date().toISOString();
      this.applyAndBroadcast(event);
      this.scheduleNext();
    }, delay);
    this.replayTimer.unref?.();
  }

  /* ---------- HTTP ---------- */

  private handle(req: IncomingMessage, res: ServerResponse): void {
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
      const entry: RecordedRequest = { offsetMs: Date.now() - this.startedAt, method: req.method ?? 'GET', path: url.pathname };
      if (raw) entry.body = body;
      this.requests.push(entry);
      const respond = () => this.route(req, res, url.pathname, body, entry);
      if (this.options.latencyMs) setTimeout(respond, this.options.latencyMs);
      else respond();
    });
  }

  private route(req: IncomingMessage, res: ServerResponse, path: string, body: unknown, entry: RecordedRequest): void {
    const method = req.method ?? 'GET';
    const json = (status: number, payload: unknown) => {
      entry.status = status;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (this.options.controlApi ?? true) {
      if (path.startsWith('/__twin/')) return this.control(method, path, body, json);
    }
    if (method === 'GET' && path === '/api/0/config') return json(200, this.publicConfig());
    if (method === 'POST' && path === '/api') return this.pair(body, json);

    const key = req.headers['hue-application-key'];
    if (key !== this.applicationKey) return json(403, { errors: [{ description: 'Unauthorized' }], data: [] });

    if (method === 'GET' && path === `/api/${this.applicationKey}/config`) return json(200, { ...this.publicConfig(), linkbutton: this.linkButton });

    if (method === 'GET' && path === '/eventstream/clip/v2') {
      entry.status = 200;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      return;
    }

    const m = /^\/clip\/v2\/resource(?:\/([a-z_]+)(?:\/([^/]+))?)?$/.exec(path);
    if (!m) return json(404, { errors: [{ description: 'Not Found' }], data: [] });
    const [, type, id] = m;
    if (method === 'GET') {
      let data = type ? this.index.list(type) : this.index.all();
      if (id) data = data.filter((r) => r.id === id);
      if (id && data.length === 0) return json(404, { errors: [{ description: `resource ${type}/${id} not found` }], data: [] });
      return json(200, { errors: [], data });
    }
    if (method === 'PUT' && type && id) return this.put(type, id, body as Record<string, unknown>, json);
    if (method === 'DELETE' && type && id) {
      const removed = this.index.delete(type, id);
      if (!removed) return json(404, { errors: [{ description: 'Not Found' }], data: [] });
      this.applyAndBroadcast({ id: this.nextEventId(), creationtime: new Date().toISOString(), type: 'delete', data: [{ id, type }] });
      return json(200, { errors: [], data: [{ rid: id, rtype: type }] });
    }
    return json(405, { errors: [{ description: 'Method Not Allowed' }], data: [] });
  }

  private publicConfig(): Record<string, unknown> {
    return { ...this.recording.bridge.config, bridgeid: this.recording.bridge.config.bridgeid.toUpperCase() };
  }

  private pair(body: unknown, json: (status: number, payload: unknown) => void): void {
    const b = body as { devicetype?: string; generateclientkey?: boolean } | undefined;
    if (!b || typeof b.devicetype !== 'string') return json(200, [{ error: { type: 2, address: '/', description: 'body contains invalid json' } }]);
    if (!this.linkButton) return json(200, [{ error: { type: 101, address: '/', description: 'link button not pressed' } }]);
    this.linkButton = false;
    const success: Record<string, string> = { username: this.applicationKey };
    if (b.generateclientkey) success['clientkey'] = generateKey().toUpperCase().slice(0, 32);
    return json(200, [{ success }]);
  }

  private put(type: string, id: string, patch: Record<string, unknown>, json: (status: number, payload: unknown) => void): void {
    const target = this.index.get(type, id);
    if (!target) return json(404, { errors: [{ description: `resource ${type}/${id} not found` }], data: [] });
    if (!patch || typeof patch !== 'object') return json(400, { errors: [{ description: 'invalid json body' }], data: [] });

    if (type === 'light') {
      const light = target as LightResource;
      const unsupported = ['color_temperature', 'color', 'dimming'].filter((k) => patch[k] !== undefined && light[k] === undefined);
      if (unsupported.length) return json(400, { errors: unsupported.map((k) => ({ description: `invalid value, ${k}, for parameter, ${k}` })), data: [] });
    }
    if (type === 'scene' && patch['recall']) {
      this.recallScene(target as SceneResource, patch['recall'] as { action?: string });
      return json(200, { errors: [], data: [{ rid: id, rtype: type }] });
    }
    const change = stripTransient(patch);
    if (Object.keys(change).length > 0) {
      const data: BaseResource = { ...change, id, type } as BaseResource;
      if (target.owner) data.owner = target.owner;
      this.applyAndBroadcast({ id: this.nextEventId(), creationtime: new Date().toISOString(), type: 'update', data: [data] });
    }
    return json(200, { errors: [], data: [{ rid: id, rtype: type }] });
  }

  private recallScene(scene: SceneResource, recall: { action?: string }): void {
    const data: BaseResource[] = [];
    for (const action of (scene.actions ?? []) as Array<{ target?: { rid: string; rtype: string }; action?: Record<string, unknown> }>) {
      if (!action.target || action.target.rtype !== 'light' || !action.action) continue;
      const light = this.index.get('light', action.target.rid);
      if (!light) continue;
      const change = stripTransient(action.action);
      for (const k of ['color_temperature', 'color', 'dimming']) if (light[k] === undefined) delete change[k];
      const d: BaseResource = { ...change, id: light.id, type: 'light' };
      if (light.owner) d.owner = light.owner;
      data.push(d);
    }
    const active = recall.action === 'dynamic_palette' ? 'dynamic_palette' : 'static';
    data.push({ id: scene.id, type: 'scene', status: { active } });
    // Other scenes in the same group go inactive.
    for (const other of this.index.list('scene')) {
      if (other.id !== scene.id && other.group?.rid === scene.group?.rid && other.status?.active && other.status.active !== 'inactive') {
        data.push({ id: other.id, type: 'scene', status: { active: 'inactive' } });
      }
    }
    this.applyAndBroadcast({ id: this.nextEventId(), creationtime: new Date().toISOString(), type: 'update', data });
  }

  private control(method: string, path: string, body: unknown, json: (status: number, payload: unknown) => void): void {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    switch (`${method} ${path}`) {
      case 'GET /__twin/state':
        return json(200, {
          bridgeId: this.bridgeId,
          url: this.url,
          linkButtonPressed: this.linkButton,
          applicationKey: this.applicationKey,
          fingerprint: this.fingerprint || null,
          replay: this.replay.state(),
          openStreams: this.streams.size,
          requests: this.requests.length,
          emitted: this.emitted.length,
          resources: this.index.all().length,
        });
      case 'POST /__twin/link-button':
        this.pressLinkButton();
        return json(200, { linkButtonPressed: true });
      case 'POST /__twin/emit': {
        if (Array.isArray(b['data']) && typeof b['type'] === 'string') {
          const given = b as unknown as Partial<HueEvent>;
          this.emit({ ...given, id: typeof given.id === 'string' ? given.id : this.nextEventId(), creationtime: given.creationtime ?? new Date().toISOString() } as HueEvent);
          return json(200, { ok: true });
        }
        if (typeof b['resourceType'] === 'string' && typeof b['id'] === 'string' && b['patch'] && typeof b['patch'] === 'object') {
          this.updateResource(b['resourceType'], b['id'], b['patch'] as Record<string, unknown>);
          return json(200, { ok: true });
        }
        return json(400, { error: 'Send a Hue event {type,data:[...]} or {resourceType,id,patch}.' });
      }
      case 'POST /__twin/replay': {
        const action = b['action'];
        if (action === 'start') this.replay.start();
        else if (action === 'pause') this.replay.pause();
        else if (action === 'seek' && typeof b['offsetMs'] === 'number') this.replay.seek(b['offsetMs']);
        else if (action === 'speed' && typeof b['speed'] === 'number') this.replay.setSpeed(b['speed']);
        else return json(400, { error: 'action must be start | pause | seek {offsetMs} | speed {speed}' });
        return json(200, this.replay.state());
      }
      case 'POST /__twin/reset':
        this.reset();
        return json(200, { ok: true });
      case 'POST /__twin/drop-streams':
        this.dropStreams();
        return json(200, { ok: true });
      case 'GET /__twin/recording':
        return json(200, this.exportRecording(typeof b['label'] === 'string' ? b['label'] : undefined));
      case 'GET /__twin/requests':
        return json(200, { requests: this.requests });
      default:
        return json(404, { error: 'Unknown control endpoint' });
    }
  }

  /* ---------- internals ---------- */

  private applyAndBroadcast(event: HueEvent): void {
    this.index.apply(event);
    this.emitted.push({ offsetMs: Date.now() - this.startedAt, event });
    const frame = `id: ${Date.now()}:0\ndata: ${JSON.stringify([event])}\n\n`;
    for (const s of this.streams) s.write(frame);
  }

  private nextEventId(): string {
    this.eventCounter += 1;
    return `twin-${this.eventCounter.toString().padStart(6, '0')}`;
  }

  async close(): Promise<void> {
    this.replay.pause();
    this.dropStreams();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.tmpDir) rmSync(this.tmpDir, { recursive: true, force: true });
  }
}

/** Fields a bridge accepts in a PUT but does not persist on the resource. */
function stripTransient(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'dynamics' || k === 'alert' || k === 'identify' || k === 'recall' || k === 'dimming_delta' || k === 'color_temperature_delta') continue;
    out[k] = v;
  }
  return out;
}

function generateKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 40; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toUpperCase();
}

function loadOrGenerateCertificate(bridgeId: string, dir: string | undefined): { certPem: string; keyPem: string; fingerprint: string; tmpDir?: string } {
  if (!dir) return generateCertificate(bridgeId, mkdtempSync(join(tmpdir(), 'hue-twin-')), true);
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) {
    const certPem = readFileSync(certPath, 'utf8');
    const cert = new X509Certificate(certPem);
    const cn = /CN=([^,\n]+)/.exec(cert.subject)?.[1]?.trim().toLowerCase();
    if (cn === bridgeId && new Date(cert.validTo).getTime() > Date.now()) {
      return { certPem, keyPem: readFileSync(keyPath, 'utf8'), fingerprint: fingerprintOf(certPem) };
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return generateCertificate(bridgeId, dir, false);
}

function generateCertificate(bridgeId: string, dir: string, ephemeral: boolean): { certPem: string; keyPem: string; fingerprint: string; tmpDir?: string } {
  const tmpDir = dir;
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '3650', '-subj', `/C=NL/O=Philips Hue/CN=${bridgeId}`],
      { stdio: 'ignore' },
    );
  } catch (err) {
    if (ephemeral) rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`Could not generate a certificate with openssl (${(err as Error).message}). Install openssl, pass \`certificate\`, or use scheme: 'http'.`);
  }
  const certPem = readFileSync(certPath, 'utf8');
  const keyPem = readFileSync(keyPath, 'utf8');
  const out: { certPem: string; keyPem: string; fingerprint: string; tmpDir?: string } = { certPem, keyPem, fingerprint: fingerprintOf(certPem) };
  if (ephemeral) out.tmpDir = tmpDir;
  return out;
}
