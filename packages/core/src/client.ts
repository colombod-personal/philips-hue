/**
 * Resource-level CLIP v2 client. Thin, typed access to
 * `/clip/v2/resource/{type}[/{id}]` plus the event stream.
 *
 * Prefer {@link HueBridge} (see `model/`) for a device-centric view; use this
 * class when you need raw resources or endpoints the model does not wrap.
 */

import { HueError } from './errors.js';
import { HueEventStream, type EventStreamOptions } from './events.js';
import type { BridgeCredentials } from './pairing.js';
import { HttpTransport, type TransportOptions } from './transport.js';
import type { TlsOptions } from './tls.js';
import type { BaseResource, BridgeConfig, ClipResponse, ResourceIdentifier, ResourceOf, ResourceType } from './types.js';

export interface RateLimitOptions {
  /** Minimum spacing between writes to individual lights (default 100 ms ≈ 10/s, per Signify guidance). */
  lightWriteIntervalMs?: number | undefined;
  /** Minimum spacing between writes to grouped lights (default 1000 ms ≈ 1/s). */
  groupWriteIntervalMs?: number | undefined;
}

export interface HueClientOptions extends Omit<TransportOptions, 'tls'> {
  tls?: TlsOptions | undefined;
  /** Bridge id; enables certificate CN validation when a CA is given, and is reported by {@link HueClient.bridgeId}. */
  bridgeId?: string | undefined;
  rateLimit?: RateLimitOptions | undefined;
}

export class HueClient {
  readonly transport: HttpTransport;
  readonly bridgeId: string | undefined;
  private readonly lightGate: Gate;
  private readonly groupGate: Gate;

  constructor(options: HueClientOptions) {
    const tls: TlsOptions = { ...(options.tls ?? {}) };
    if (options.bridgeId && tls.ca && !tls.bridgeId) tls.bridgeId = options.bridgeId;
    const { bridgeId, rateLimit, ...transportOptions } = options;
    this.transport = new HttpTransport({ ...transportOptions, tls });
    this.bridgeId = bridgeId?.toLowerCase();
    this.lightGate = new Gate(rateLimit?.lightWriteIntervalMs ?? 100);
    this.groupGate = new Gate(rateLimit?.groupWriteIntervalMs ?? 1000);
  }

  /** Builds a client from stored credentials, pinning the certificate seen at pairing time. */
  static fromCredentials(creds: BridgeCredentials, extra: Partial<HueClientOptions> = {}): HueClient {
    const tls: TlsOptions = { ...(extra.tls ?? {}) };
    if (creds.fingerprint && !tls.fingerprint && !tls.ca && !tls.insecure) tls.fingerprint = creds.fingerprint;
    return new HueClient({
      host: creds.host,
      port: creds.port,
      scheme: creds.scheme ?? 'https',
      applicationKey: creds.applicationKey,
      bridgeId: creds.bridgeId,
      ...extra,
      tls,
    });
  }

  get host(): string {
    return this.transport.host;
  }

  close(): void {
    this.transport.close();
  }

  /** Unauthenticated bridge config (name, model, firmware, bridge id). */
  async getConfig(): Promise<BridgeConfig> {
    const res = await this.transport.request<BridgeConfig>('GET', '/api/0/config');
    if (res.status !== 200 || typeof res.body !== 'object') throw this.errorFromStatus(res.status, res.body, 'GET /api/0/config');
    return res.body;
  }

  /** Every resource on the bridge in one call (`GET /clip/v2/resource`). */
  async listAll(signal?: AbortSignal): Promise<BaseResource[]> {
    return this.clip<BaseResource>('GET', '/clip/v2/resource', undefined, signal);
  }

  async list<T extends ResourceType>(type: T, signal?: AbortSignal): Promise<ResourceOf<T>[]> {
    return this.clip<ResourceOf<T>>('GET', `/clip/v2/resource/${type}`, undefined, signal);
  }

  async get<T extends ResourceType>(type: T, id: string, signal?: AbortSignal): Promise<ResourceOf<T>> {
    const data = await this.clip<ResourceOf<T>>('GET', `/clip/v2/resource/${type}/${encodeURIComponent(id)}`, undefined, signal);
    const first = data[0];
    if (!first) throw new HueError('not_found', `${type} ${id} not found.`, { status: 404 });
    return first;
  }

  /** `PUT` a partial update. Returns the identifiers of the updated resources. */
  async update<T extends ResourceType>(type: T, id: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ResourceIdentifier[]> {
    const gate = type === 'light' ? this.lightGate : type === 'grouped_light' ? this.groupGate : undefined;
    const run = () => this.clip<ResourceIdentifier>('PUT', `/clip/v2/resource/${type}/${encodeURIComponent(id)}`, body, signal);
    return gate ? gate.run(run) : run();
  }

  async create<T extends ResourceType>(type: T, body: Record<string, unknown>, signal?: AbortSignal): Promise<ResourceIdentifier[]> {
    return this.clip<ResourceIdentifier>('POST', `/clip/v2/resource/${type}`, body, signal);
  }

  async delete<T extends ResourceType>(type: T, id: string, signal?: AbortSignal): Promise<ResourceIdentifier[]> {
    return this.clip<ResourceIdentifier>('DELETE', `/clip/v2/resource/${type}/${encodeURIComponent(id)}`, undefined, signal);
  }

  /** Creates (but does not start) an event stream subscription. */
  events(options: EventStreamOptions = {}): HueEventStream {
    return new HueEventStream(this.transport, options);
  }

  private async clip<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T[]> {
    const res = await this.transport.request<ClipResponse<T> | unknown>(method, path, { body, signal });
    const payload = res.body as Partial<ClipResponse<T>> | undefined;
    if (res.status >= 400 || !payload || typeof payload !== 'object') {
      throw this.errorFromStatus(res.status, res.body, `${method} ${path}`);
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const description = payload.errors.map((e) => e.description).join('; ');
      throw new HueError('bridge_error', `Bridge reported an error for ${method} ${path}: ${description}`, { status: res.status, details: payload.errors });
    }
    return Array.isArray(payload.data) ? payload.data : [];
  }

  private errorFromStatus(status: number, body: unknown, context: string): HueError {
    const details = body;
    const description = extractDescription(body);
    const suffix = description ? `: ${description}` : '';
    switch (status) {
      case 401:
      case 403:
        return new HueError('unauthorized', `Bridge rejected the application key for ${context}${suffix}. Re-pair the bridge.`, { status, details });
      case 404:
        return new HueError('not_found', `Resource not found for ${context}${suffix}.`, { status, details });
      case 429:
        return new HueError('rate_limited', `Bridge is rate limiting ${context}${suffix}. Slow down writes.`, { status, details });
      case 400:
      case 405:
      case 406:
      case 409:
        return new HueError('bad_request', `Bridge rejected ${context}${suffix}.`, { status, details });
      default:
        return new HueError('bridge_error', `Bridge returned HTTP ${status} for ${context}${suffix}.`, { status, details });
    }
  }
}

function extractDescription(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body.length < 200 ? body : undefined;
  const errors = (body as Partial<ClipResponse>).errors;
  if (Array.isArray(errors) && errors.length) return errors.map((e) => e.description).join('; ');
  return undefined;
}

/** Serialises calls so consecutive ones are at least `intervalMs` apart. */
class Gate {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly intervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
