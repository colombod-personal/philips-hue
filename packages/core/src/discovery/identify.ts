/**
 * Contact a bridge directly to confirm it is a Hue bridge, read its public
 * config (`GET /api/0/config`, no key required) and capture the TLS
 * certificate so it can be pinned.
 */

import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { HueError } from '../errors.js';
import { summarizeCertificate, type CertificateSummary } from '../tls.js';
import type { BridgeConfig } from '../types.js';
import type { DiscoveredBridge } from './types.js';

export interface IdentifyOptions {
  port?: number | undefined;
  scheme?: 'https' | 'http' | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface IdentifyResult {
  config: BridgeConfig;
  certificate?: CertificateSummary;
}

/**
 * Fetches the unauthenticated bridge config. TLS is *not* verified here on
 * purpose: this is the step that learns which certificate to trust.
 */
export function fetchBridgeConfig(host: string, options: IdentifyOptions = {}): Promise<IdentifyResult> {
  const scheme = options.scheme ?? 'https';
  const port = options.port ?? (scheme === 'https' ? 443 : 80);
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const req = (scheme === 'https' ? request : httpRequest)({
      host,
      port,
      path: '/api/0/config',
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'hue-sdk' },
      rejectUnauthorized: false,
      servername: '',
      agent: false,
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new HueError('network', `Timed out contacting ${host}:${port}.`));
    });
    req.on('error', (err) => reject(err instanceof HueError ? err : new HueError('network', `Could not reach ${host}:${port}: ${err.message}`, { cause: err })));
    options.signal?.addEventListener('abort', () => req.destroy(new HueError('aborted', 'Identify aborted.')), { once: true });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', (err) => reject(new HueError('network', err.message, { cause: err })));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let config: unknown;
        try {
          config = JSON.parse(text);
        } catch {
          reject(new HueError('invalid_response', `${host} did not return JSON for /api/0/config; probably not a Hue bridge.`, { status: res.statusCode }));
          return;
        }
        if (!isBridgeConfig(config)) {
          reject(new HueError('invalid_response', `${host} answered /api/0/config but without a bridge id; probably not a Hue bridge.`, { details: config }));
          return;
        }
        const result: IdentifyResult = { config };
        const socket = res.socket as TLSSocket | undefined;
        if (scheme === 'https' && socket && typeof socket.getPeerCertificate === 'function') {
          const cert = socket.getPeerCertificate();
          if (cert && Object.keys(cert).length > 0) result.certificate = summarizeCertificate(cert);
        }
        resolve(result);
      });
    });
    req.end();
  });
}

function isBridgeConfig(value: unknown): value is BridgeConfig {
  return typeof value === 'object' && value !== null && typeof (value as BridgeConfig).bridgeid === 'string';
}

/** Builds a {@link DiscoveredBridge} for a known host, confirming it is a bridge. */
export async function identifyBridge(host: string, options: IdentifyOptions = {}): Promise<DiscoveredBridge> {
  const { config, certificate } = await fetchBridgeConfig(host, options);
  const bridge: DiscoveredBridge = {
    id: config.bridgeid.toLowerCase(),
    host,
    port: options.port ?? ((options.scheme ?? 'https') === 'https' ? 443 : 80),
    sources: ['manual'],
    name: config.name,
    modelId: config.modelid,
    config,
  };
  if (certificate) bridge.certificate = certificate;
  return bridge;
}
