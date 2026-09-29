/**
 * Digital-twin recording format.
 *
 * A recording is everything needed to stand up a faithful local replica of a
 * bridge: its public config, the certificate it presented, every CLIP v2
 * resource, and the event stream captured over a period of time (each event
 * stamped with its offset from the start of the recording). The simulator
 * replays the events on the same timeline, so a motion sensor that fired at
 * +12.4 s in the real home fires at +12.4 s in the twin.
 *
 * Recordings never contain application keys: the recorder strips them and the
 * simulator issues its own.
 */

import type { CertificateSummary } from '../tls.js';
import type { BaseResource, BridgeConfig, HueEvent } from '../types.js';

export const RECORDING_VERSION = 1 as const;

export interface RecordedEvent {
  /** Milliseconds since the recording started. */
  offsetMs: number;
  event: HueEvent;
}

export interface RecordedRequest {
  offsetMs: number;
  method: string;
  path: string;
  body?: unknown;
  status?: number;
}

export interface Recording {
  version: typeof RECORDING_VERSION;
  /** ISO timestamp of when the capture started. */
  recordedAt: string;
  /** Total capture length in ms (events beyond this are not expected). */
  durationMs: number;
  /** Free-form label, e.g. "office, weekday evening". */
  label?: string;
  bridge: {
    /** `GET /api/0/config` as the bridge reported it. */
    config: BridgeConfig;
    certificate?: CertificateSummary;
    host?: string;
  };
  /** Full resource set at the start of the recording. */
  resources: BaseResource[];
  /** Event-stream events in chronological order. */
  events: RecordedEvent[];
  /** Optional: writes the recording client performed, for reproducing sessions. */
  requests?: RecordedRequest[];
}

/** Deep-copies a recording so a simulator can mutate its state freely. */
export function cloneRecording(recording: Recording): Recording {
  return structuredClone(recording);
}

export function isRecording(value: unknown): value is Recording {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<Recording>;
  return r.version === RECORDING_VERSION && typeof r.bridge?.config?.bridgeid === 'string' && Array.isArray(r.resources) && Array.isArray(r.events);
}

/** Replaces every occurrence of the given secrets in string values. */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  const active = secrets.filter((s) => s.length >= 8);
  if (active.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const s of active) out = out.split(s).join('<redacted>');
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Resource types that must never be persisted (credential-bearing). */
export const EXCLUDED_RESOURCE_TYPES = new Set(['auth_v1']);
