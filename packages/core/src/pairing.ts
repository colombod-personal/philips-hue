/**
 * Pairing ("link button") flow.
 *
 * The bridge only issues application keys to clients that prove physical
 * access: `POST /api` succeeds solely within ~30 s of the round button on the
 * bridge being pressed; before that it answers with error type 101.
 *
 * {@link pairBridge} identifies the bridge first (config + certificate), pins
 * that certificate for the pairing request itself, then polls until the key is
 * granted or the timeout elapses. The returned {@link BridgeCredentials} carry
 * everything needed to reconnect securely later: host, application key, and
 * the certificate fingerprint.
 */

import { hostname } from 'node:os';
import { HueError, LinkButtonNotPressedError, PairingTimeoutError } from './errors.js';
import { fetchBridgeConfig } from './discovery/identify.js';
import { HttpTransport } from './transport.js';
import type { TlsOptions } from './tls.js';

export interface BridgeCredentials {
  /** Bridge id, lower-cased hex. */
  bridgeId: string;
  host: string;
  port: number;
  scheme?: 'https' | 'http';
  /** The `hue-application-key` (a.k.a. v1 "username"). Treat as a secret. */
  applicationKey: string;
  /** PSK for the Entertainment (DTLS) API when requested. Treat as a secret. */
  clientKey?: string;
  /** SHA-256 fingerprint of the bridge certificate at pairing time; used for pinning. */
  fingerprint?: string;
  name?: string;
  modelId?: string;
  /** ISO timestamp. */
  pairedAt: string;
  /** The `devicetype` value the key was issued to. */
  deviceType: string;
}

export interface PairOptions {
  port?: number | undefined;
  scheme?: 'https' | 'http' | undefined;
  /** Shown in the Hue app's list of connected apps. Max 20 chars. Default `hue-sdk`. */
  appName?: string | undefined;
  /** Distinguishes installs of the same app. Max 19 chars. Defaults to the machine hostname. */
  instanceName?: string | undefined;
  /** Also request an Entertainment API client key (default true). */
  generateClientKey?: boolean | undefined;
  /** Give up after this long (default 60 000 ms). */
  timeoutMs?: number | undefined;
  /** Delay between attempts (default 2000 ms). */
  intervalMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Invoked after each failed attempt while waiting for the button. */
  onWaiting?: ((info: { attempt: number; elapsedMs: number; remainingMs: number }) => void) | undefined;
  /**
   * TLS policy for the pairing requests. By default the certificate observed
   * while identifying the bridge is pinned so the key is never sent elsewhere.
   */
  tls?: TlsOptions | undefined;
}

export function buildDeviceType(appName = 'hue-sdk', instanceName = hostname()): string {
  const app = sanitize(appName).slice(0, 20) || 'hue-sdk';
  const inst = sanitize(instanceName).slice(0, 19) || 'default';
  return `${app}#${inst}`;
}

function sanitize(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

interface PairSuccess {
  success: { username: string; clientkey?: string };
}
interface PairFailure {
  error: { type: number; address?: string; description?: string };
}

/**
 * Single pairing attempt. Throws {@link LinkButtonNotPressedError} when the
 * button has not been pressed yet.
 */
export async function pairOnce(
  transport: HttpTransport,
  deviceType: string,
  generateClientKey = true,
  signal?: AbortSignal,
): Promise<{ applicationKey: string; clientKey?: string }> {
  const res = await transport.request<unknown>('POST', '/api', {
    body: { devicetype: deviceType, generateclientkey: generateClientKey },
    signal,
  });
  const body = res.body;
  if (!Array.isArray(body) || body.length === 0) {
    throw new HueError('invalid_response', 'Unexpected pairing response from bridge.', { status: res.status, details: body });
  }
  const first = body[0] as Partial<PairSuccess & PairFailure>;
  if (first.success?.username) {
    const out: { applicationKey: string; clientKey?: string } = { applicationKey: first.success.username };
    if (first.success.clientkey) out.clientKey = first.success.clientkey;
    return out;
  }
  if (first.error) {
    if (first.error.type === 101) throw new LinkButtonNotPressedError(first.error);
    throw new HueError('bridge_error', `Bridge refused pairing: ${first.error.description ?? `error ${first.error.type}`}`, {
      status: res.status,
      details: first.error,
    });
  }
  throw new HueError('invalid_response', 'Unexpected pairing response from bridge.', { status: res.status, details: body });
}

/**
 * Full pairing flow: identify → pin certificate → poll `POST /api` until the
 * link button is pressed.
 */
export async function pairBridge(host: string, options: PairOptions = {}): Promise<BridgeCredentials> {
  const scheme = options.scheme ?? 'https';
  const port = options.port ?? (scheme === 'https' ? 443 : 80);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2000;
  const deviceType = buildDeviceType(options.appName, options.instanceName);

  const { config, certificate } = await fetchBridgeConfig(host, { port, scheme, signal: options.signal });
  const tls: TlsOptions = options.tls ?? (certificate ? { fingerprint: certificate.fingerprint256 } : { insecure: true });
  const transport = new HttpTransport({ host, port, scheme, tls });

  const started = Date.now();
  let attempt = 0;
  try {
    for (;;) {
      attempt += 1;
      try {
        const { applicationKey, clientKey } = await pairOnce(transport, deviceType, options.generateClientKey ?? true, options.signal);
        const creds: BridgeCredentials = {
          bridgeId: config.bridgeid.toLowerCase(),
          host,
          port,
          applicationKey,
          pairedAt: new Date().toISOString(),
          deviceType,
          name: config.name,
          modelId: config.modelid,
        };
        if (scheme !== 'https') creds.scheme = scheme;
        if (clientKey) creds.clientKey = clientKey;
        if (certificate) creds.fingerprint = certificate.fingerprint256;
        return creds;
      } catch (err) {
        if (!(err instanceof LinkButtonNotPressedError)) throw err;
        const elapsedMs = Date.now() - started;
        const remainingMs = timeoutMs - elapsedMs;
        if (remainingMs <= 0) throw new PairingTimeoutError(timeoutMs);
        options.onWaiting?.({ attempt, elapsedMs, remainingMs });
        await sleep(Math.min(intervalMs, remainingMs), options.signal);
      }
    }
  } finally {
    transport.close();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HueError('aborted', 'Pairing aborted.'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new HueError('aborted', 'Pairing aborted.'));
      },
      { once: true },
    );
  });
}
