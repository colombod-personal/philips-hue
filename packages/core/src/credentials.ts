/**
 * Credential persistence.
 *
 * Application keys are bearer secrets: anyone holding one controls the
 * bridge. The default store writes a `0600` JSON file under the user's config
 * directory; agents/hosts can plug in their own {@link CredentialStore}.
 *
 * Environment variables override the store, which is convenient for
 * containers and CI:
 *
 *   HUE_BRIDGE_HOST, HUE_APPLICATION_KEY, HUE_BRIDGE_ID (optional),
 *   HUE_BRIDGE_FINGERPRINT (optional, SHA-256), HUE_BRIDGE_PORT (optional),
 *   HUE_TLS_INSECURE=1 (optional, disables verification), HUE_CA_FILE (optional PEM path)
 */

import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BridgeCredentials } from './pairing.js';
import type { TlsOptions } from './tls.js';

export interface StoredCredentials {
  version: 1;
  /** Bridge id of the default bridge when several are paired. */
  default?: string;
  bridges: Record<string, BridgeCredentials>;
}

export interface CredentialStore {
  load(): Promise<StoredCredentials>;
  save(creds: BridgeCredentials, options?: { makeDefault?: boolean }): Promise<void>;
  get(bridgeId?: string): Promise<BridgeCredentials | undefined>;
  remove(bridgeId: string): Promise<void>;
  list(): Promise<BridgeCredentials[]>;
}

export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env['HUE_CREDENTIALS_FILE']) return env['HUE_CREDENTIALS_FILE'];
  const base = env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(base, 'hue-sdk', 'credentials.json');
}

export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(path: string = defaultCredentialsPath()) {
    this.path = path;
  }

  async load(): Promise<StoredCredentials> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<StoredCredentials>;
      if (parsed && typeof parsed === 'object' && parsed.bridges && typeof parsed.bridges === 'object') {
        const out: StoredCredentials = { version: 1, bridges: parsed.bridges };
        if (parsed.default) out.default = parsed.default;
        return out;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return { version: 1, bridges: {} };
  }

  async save(creds: BridgeCredentials, options: { makeDefault?: boolean } = {}): Promise<void> {
    const data = await this.load();
    data.bridges[creds.bridgeId] = creds;
    if (options.makeDefault || !data.default) data.default = creds.bridgeId;
    await this.write(data);
  }

  async get(bridgeId?: string): Promise<BridgeCredentials | undefined> {
    const data = await this.load();
    const id = bridgeId?.toLowerCase() ?? data.default ?? Object.keys(data.bridges)[0];
    return id ? data.bridges[id] : undefined;
  }

  async remove(bridgeId: string): Promise<void> {
    const data = await this.load();
    delete data.bridges[bridgeId.toLowerCase()];
    if (data.default === bridgeId.toLowerCase()) {
      const next = Object.keys(data.bridges)[0];
      if (next) data.default = next;
      else delete data.default;
    }
    await this.write(data);
  }

  async list(): Promise<BridgeCredentials[]> {
    return Object.values((await this.load()).bridges);
  }

  private async write(data: StoredCredentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, this.path);
  }
}

/** In-memory store for tests and ephemeral agents. */
export class MemoryCredentialStore implements CredentialStore {
  private data: StoredCredentials = { version: 1, bridges: {} };
  async load(): Promise<StoredCredentials> {
    return structuredClone(this.data);
  }
  async save(creds: BridgeCredentials, options: { makeDefault?: boolean } = {}): Promise<void> {
    this.data.bridges[creds.bridgeId] = creds;
    if (options.makeDefault || !this.data.default) this.data.default = creds.bridgeId;
  }
  async get(bridgeId?: string): Promise<BridgeCredentials | undefined> {
    const id = bridgeId?.toLowerCase() ?? this.data.default ?? Object.keys(this.data.bridges)[0];
    return id ? this.data.bridges[id] : undefined;
  }
  async remove(bridgeId: string): Promise<void> {
    delete this.data.bridges[bridgeId.toLowerCase()];
    if (this.data.default === bridgeId.toLowerCase()) delete this.data.default;
  }
  async list(): Promise<BridgeCredentials[]> {
    return Object.values(this.data.bridges);
  }
}

export interface ResolvedConnection {
  credentials: BridgeCredentials;
  tls: TlsOptions;
  source: 'env' | 'store';
}

/**
 * Resolves connection details from environment variables first, then the
 * credential store. Returns `undefined` when nothing is configured.
 */
export async function resolveConnection(
  options: { store?: CredentialStore | undefined; bridgeId?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): Promise<ResolvedConnection | undefined> {
  const env = options.env ?? process.env;
  const tls: TlsOptions = {};
  if (env['HUE_TLS_INSECURE'] === '1' || env['HUE_TLS_INSECURE'] === 'true') tls.insecure = true;
  if (env['HUE_CA_FILE']) tls.ca = await readFile(env['HUE_CA_FILE']);

  const host = env['HUE_BRIDGE_HOST'];
  const key = env['HUE_APPLICATION_KEY'];
  if (host && key) {
    const credentials: BridgeCredentials = {
      bridgeId: (env['HUE_BRIDGE_ID'] ?? 'env').toLowerCase(),
      host,
      port: env['HUE_BRIDGE_PORT'] ? Number(env['HUE_BRIDGE_PORT']) : 443,
      applicationKey: key,
      pairedAt: '',
      deviceType: 'env',
    };
    if (env['HUE_BRIDGE_FINGERPRINT']) {
      credentials.fingerprint = env['HUE_BRIDGE_FINGERPRINT'];
      tls.fingerprint = env['HUE_BRIDGE_FINGERPRINT'];
    }
    if (env['HUE_BRIDGE_ID'] && tls.ca) tls.bridgeId = env['HUE_BRIDGE_ID'];
    if (env['HUE_BRIDGE_SCHEME'] === 'http') credentials.scheme = 'http';
    return { credentials, tls, source: 'env' };
  }

  const store = options.store ?? new FileCredentialStore();
  const credentials = await store.get(options.bridgeId);
  if (!credentials) return undefined;
  if (credentials.fingerprint && !tls.insecure) tls.fingerprint = credentials.fingerprint;
  if (tls.ca) tls.bridgeId = credentials.bridgeId;
  return { credentials, tls, source: 'store' };
}
