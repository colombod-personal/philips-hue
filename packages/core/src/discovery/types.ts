import type { BridgeConfig } from '../types.js';
import type { CertificateSummary } from '../tls.js';

export type DiscoverySource = 'mdns' | 'cloud' | 'manual';

export interface DiscoveredBridge {
  /** Bridge id, 16 hex characters, lower-cased (e.g. `001788fffe123456`). */
  id: string;
  /** IPv4/IPv6 address or hostname to reach the bridge. */
  host: string;
  port: number;
  /** Which methods reported this bridge. */
  sources: DiscoverySource[];
  /** Human readable name, when known (mDNS instance name or config name). */
  name?: string;
  /** Bridge model id (BSB001 = v1 square, BSB002 = v2 round). */
  modelId?: string;
  /** Populated when the bridge was contacted directly (`identify`). */
  config?: BridgeConfig;
  /** TLS certificate presented by the bridge, when contacted directly. */
  certificate?: CertificateSummary;
}
