/**
 * Minimal HTTP transport for talking to a Hue bridge.
 *
 * Built on `node:https` (rather than `fetch`) so that certificate pinning and
 * custom CA handling work without third-party dependencies.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https';
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { HueError } from './errors.js';
import { HueTlsAgent, type TlsOptions } from './tls.js';

export interface TransportOptions {
  /** Bridge host (IP address or hostname). */
  host: string;
  /** Defaults to 443 (or 80 for `scheme: 'http'`). */
  port?: number | undefined;
  /**
   * `https` (default) is what real bridges speak. `http` exists only for
   * emulators (e.g. diyHue) and tests.
   */
  scheme?: 'https' | 'http' | undefined;
  tls?: TlsOptions | undefined;
  /** Per-request timeout in ms (default 10 000). */
  timeoutMs?: number | undefined;
  /** Sent as the `hue-application-key` header on every request when set. */
  applicationKey?: string | undefined;
  /** Extra headers added to every request. */
  headers?: Record<string, string> | undefined;
  /** Optional User-Agent (defaults to `hue-sdk`). */
  userAgent?: string | undefined;
}

export interface RequestInit {
  body?: unknown;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** Override the transport-level timeout for this request. */
  timeoutMs?: number | undefined;
}

export interface TransportResponse<T = unknown> {
  status: number;
  headers: IncomingMessage['headers'];
  /** Parsed JSON when the response is JSON, else the raw text. */
  body: T;
  text: string;
}

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

const DEFAULT_TIMEOUT = 10_000;

export class HttpTransport {
  readonly host: string;
  readonly port: number;
  readonly scheme: 'https' | 'http';
  readonly baseUrl: string;
  private readonly agent: HueTlsAgent | HttpAgent;
  private readonly timeoutMs: number;
  private readonly baseHeaders: Record<string, string>;
  private applicationKey: string | undefined;

  constructor(options: TransportOptions) {
    this.host = options.host;
    this.scheme = options.scheme ?? 'https';
    this.port = options.port ?? (this.scheme === 'https' ? 443 : 80);
    this.baseUrl = `${this.scheme}://${formatHost(this.host)}:${this.port}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.applicationKey = options.applicationKey;
    this.baseHeaders = {
      accept: 'application/json',
      'user-agent': options.userAgent ?? 'hue-sdk',
      ...(options.headers ?? {}),
    };
    this.agent = this.scheme === 'https' ? new HueTlsAgent(options.tls ?? {}) : new HttpAgent({ keepAlive: true, maxSockets: 2 });
  }

  /** Updates the key used for authenticated requests (e.g. right after pairing). */
  setApplicationKey(key: string | undefined): void {
    this.applicationKey = key;
  }

  getApplicationKey(): string | undefined {
    return this.applicationKey;
  }

  /** Releases keep-alive sockets. */
  close(): void {
    this.agent.destroy();
  }

  async request<T = unknown>(method: HttpMethod, path: string, init: RequestInit = {}): Promise<TransportResponse<T>> {
    const res = await this.open(method, path, init, false);
    const text = await readBody(res, init.signal);
    let body: unknown = text;
    const contentType = String(res.headers['content-type'] ?? '');
    if (text.length > 0 && (contentType.includes('json') || looksLikeJson(text))) {
      try {
        body = JSON.parse(text);
      } catch (cause) {
        throw new HueError('invalid_response', `Bridge returned malformed JSON for ${method} ${path}`, { cause, status: res.statusCode });
      }
    }
    return { status: res.statusCode ?? 0, headers: res.headers, body: body as T, text };
  }

  /**
   * Opens a streaming response (used for `/eventstream/clip/v2`). The caller
   * owns the returned message and must consume or destroy it.
   */
  async stream(path: string, init: RequestInit = {}): Promise<IncomingMessage> {
    return this.open('GET', path, { ...init, headers: { accept: 'text/event-stream', ...(init.headers ?? {}) } }, true);
  }

  private open(method: HttpMethod, path: string, init: RequestInit, streaming: boolean): Promise<IncomingMessage> {
    const headers: Record<string, string> = { ...this.baseHeaders, ...(init.headers ?? {}) };
    if (this.applicationKey && !('hue-application-key' in headers)) headers['hue-application-key'] = this.applicationKey;

    let payload: Buffer | undefined;
    if (init.body !== undefined) {
      payload = Buffer.from(typeof init.body === 'string' ? init.body : JSON.stringify(init.body), 'utf8');
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.byteLength);
    }

    const options: RequestOptions = {
      host: this.host,
      port: this.port,
      method,
      path,
      headers,
      agent: this.agent,
      // Bridges present a certificate for the bridge id, not the IP; SNI must not be an IP literal anyway.
      servername: isIpLiteral(this.host) ? '' : this.host,
    };
    const timeoutMs = streaming ? 0 : (init.timeoutMs ?? this.timeoutMs);

    return new Promise<IncomingMessage>((resolve, reject) => {
      if (init.signal?.aborted) {
        reject(new HueError('aborted', 'Request aborted before it started.'));
        return;
      }
      const req = this.scheme === 'https' ? httpsRequest(options) : httpRequest(options);
      let settled = false;
      const fail = (err: HueError) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };
      const onAbort = () => fail(new HueError('aborted', 'Request aborted.'));
      init.signal?.addEventListener('abort', onAbort, { once: true });

      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => fail(new HueError('network', `Request to ${this.host} timed out after ${timeoutMs} ms.`)));
      }
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof HueError) {
          fail(err);
        } else if (isTlsFailure(err)) {
          fail(new HueError('tls', `TLS handshake with ${this.host} failed: ${err.message}`, { cause: err }));
        } else {
          fail(new HueError('network', `Could not reach bridge at ${this.host}:${this.port}: ${err.message}`, { cause: err }));
        }
      });
      req.on('response', (res) => {
        if (settled) {
          res.resume();
          return;
        }
        settled = true;
        init.signal?.removeEventListener('abort', onAbort);
        if (streaming && init.signal) {
          init.signal.addEventListener('abort', () => res.destroy(new HueError('aborted', 'Stream aborted.')), { once: true });
        }
        resolve(res);
      });
      req.end(payload);
    });
  }
}

function readBody(res: IncomingMessage, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', (err) => reject(new HueError('network', `Connection dropped while reading response: ${err.message}`, { cause: err })));
    signal?.addEventListener('abort', () => res.destroy(new HueError('aborted', 'Request aborted.')), { once: true });
  });
}

function looksLikeJson(text: string): boolean {
  const c = text.trimStart()[0];
  return c === '{' || c === '[';
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function isTlsFailure(err: NodeJS.ErrnoException): boolean {
  const code = err.code ?? '';
  return (
    code.startsWith('ERR_TLS') ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    code === 'ERR_OSSL_EVP_UNSUPPORTED' ||
    /certificate|handshake|ssl/i.test(err.message)
  );
}
