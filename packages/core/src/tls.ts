/**
 * TLS handling for Hue bridges.
 *
 * Hue bridges only speak HTTPS. Newer bridges carry a certificate issued by
 * Signify's private "root-bridge" CA whose subject CN is the bridge id; older
 * bridges still use a self-signed certificate. Neither validates against the
 * system trust store, so callers pick one of three strategies:
 *
 *  1. **Fingerprint pinning (recommended, trust-on-first-use).** Record the
 *     SHA-256 fingerprint of the certificate seen during pairing and refuse any
 *     other certificate afterwards. Works for self-signed and CA-signed bridges.
 *  2. **CA + bridge id.** Provide the Signify Hue bridge root CA (PEM) and the
 *     bridge id; the chain is verified and the certificate CN must equal the
 *     bridge id. The CA PEM is published on the Hue developer portal (login
 *     required) and is intentionally not vendored here.
 *  3. **Insecure.** Skip verification. Only for exploration and tests.
 *
 * Any combination of 1 and 2 is allowed; all configured checks must pass.
 */

import { Agent as HttpsAgent, type AgentOptions } from 'node:https';
import type { ClientRequestArgs } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TLSSocket, PeerCertificate } from 'node:tls';
import { TlsError } from './errors.js';

export interface TlsOptions {
  /** SHA-256 fingerprint of the bridge leaf certificate (hex, colons optional, case-insensitive). */
  fingerprint?: string | undefined;
  /** Bridge id (16 hex characters). When set, the certificate CN must match it. */
  bridgeId?: string | undefined;
  /** PEM encoded CA bundle used to verify the certificate chain. */
  ca?: string | Buffer | undefined;
  /** Skip all verification. Never use in production. */
  insecure?: boolean | undefined;
}

/** Normalises a fingerprint so `AB:CD` and `abcd` compare equal. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

export interface CertificateSummary {
  subjectCN: string | undefined;
  issuerCN: string | undefined;
  fingerprint256: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function summarizeCertificate(cert: PeerCertificate): CertificateSummary {
  const subjectCN = firstString(cert.subject?.CN);
  const issuerCN = firstString(cert.issuer?.CN);
  return {
    subjectCN,
    issuerCN,
    fingerprint256: normalizeFingerprint(cert.fingerprint256),
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
    selfSigned: subjectCN !== undefined && subjectCN === issuerCN,
  };
}

/**
 * Returns `undefined` when the certificate satisfies the configured checks,
 * otherwise a `TlsError` describing the first failed check.
 */
export function verifyBridgeCertificate(cert: PeerCertificate, options: TlsOptions): TlsError | undefined {
  if (options.insecure) return undefined;
  if (!cert || Object.keys(cert).length === 0) {
    return new TlsError('Bridge did not present a certificate.');
  }
  if (options.fingerprint) {
    const expected = normalizeFingerprint(options.fingerprint);
    const actual = normalizeFingerprint(cert.fingerprint256);
    if (expected !== actual) {
      return new TlsError(
        `Bridge certificate fingerprint mismatch (expected ${expected}, got ${actual}). ` +
          'The bridge certificate changed or you are talking to a different device. Re-pair to trust the new certificate.',
      );
    }
  }
  if (options.bridgeId) {
    const cn = firstString(cert.subject?.CN)?.toLowerCase();
    if (cn !== options.bridgeId.toLowerCase()) {
      return new TlsError(`Bridge certificate CN "${cn ?? ''}" does not match bridge id "${options.bridgeId}".`);
    }
  }
  return undefined;
}

/** True when the options require no verification at all (nothing to verify against). */
export function isUnverified(options: TlsOptions | undefined): boolean {
  if (!options) return true;
  if (options.insecure) return true;
  return !options.fingerprint && !options.ca && !options.bridgeId;
}

/**
 * An `https.Agent` that enforces {@link TlsOptions} on every new connection.
 *
 * Chain verification (`rejectUnauthorized`) is only enabled when a CA is given;
 * pinning and CN checks run on `secureConnect` and destroy the socket before
 * any application data can leave the process when they fail.
 */
export class HueTlsAgent extends HttpsAgent {
  readonly tlsOptions: TlsOptions;

  constructor(tlsOptions: TlsOptions = {}, agentOptions: AgentOptions = {}) {
    const merged: AgentOptions = {
      keepAlive: true,
      maxSockets: 2, // bridges throttle at ~3 concurrent connections; leave room for the event stream
      // Resumed TLS sessions do not re-present the certificate, so pinning could not run; force full handshakes.
      maxCachedSessions: 0,
      ...agentOptions,
      rejectUnauthorized: Boolean(tlsOptions.ca) && !tlsOptions.insecure,
    };
    if (tlsOptions.ca) merged.ca = tlsOptions.ca;
    if (tlsOptions.ca && tlsOptions.bridgeId && !tlsOptions.insecure) {
      // Node only runs checkServerIdentity when chain verification succeeded.
      merged.checkServerIdentity = (_host: string, cert: PeerCertificate) => verifyBridgeCertificate(cert, tlsOptions);
    }
    super(merged);
    this.tlsOptions = tlsOptions;
  }

  // http.Agent calls createConnection(options, callback); https.Agent returns the TLSSocket synchronously.
  override createConnection(options: ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex {
    const superCreate = (HttpsAgent.prototype as unknown as {
      createConnection: (o: ClientRequestArgs, cb?: unknown) => TLSSocket;
    }).createConnection;
    const socket = superCreate.call(this, options, callback);
    const tlsOptions = this.tlsOptions;
    socket.once('secureConnect', () => {
      // A resumed session was already verified when it was first established (Node applies the same rule).
      if (socket.isSessionReused()) return;
      const cert = socket.getPeerCertificate();
      const failure = verifyBridgeCertificate(cert, tlsOptions);
      if (failure) socket.destroy(failure);
    });
    return socket;
  }
}
