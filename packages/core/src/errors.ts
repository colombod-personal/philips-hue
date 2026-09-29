/**
 * Error hierarchy for the Hue SDK.
 *
 * Every error carries a machine-readable `code` so agents can branch on it
 * without parsing messages.
 */

export type HueErrorCode =
  | 'link_button_not_pressed'
  | 'pairing_timeout'
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'bridge_error'
  | 'network'
  | 'tls'
  | 'discovery_failed'
  | 'invalid_response'
  | 'stream_closed'
  | 'aborted';

export interface HueErrorOptions {
  cause?: unknown;
  /** HTTP status code, when the error came from an HTTP response. */
  status?: number | undefined;
  /** Raw error payload from the bridge (`errors[]` in CLIP v2, or v1 error objects). */
  details?: unknown;
}

export class HueError extends Error {
  readonly code: HueErrorCode;
  readonly status: number | undefined;
  readonly details: unknown;

  constructor(code: HueErrorCode, message: string, options: HueErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HueError';
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }

  /** Plain-object representation, handy for agents / JSON output. */
  toJSON(): { name: string; code: HueErrorCode; message: string; status?: number; details?: unknown } {
    const out: { name: string; code: HueErrorCode; message: string; status?: number; details?: unknown } = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.status !== undefined) out.status = this.status;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export class LinkButtonNotPressedError extends HueError {
  constructor(details?: unknown) {
    super('link_button_not_pressed', 'Link button not pressed. Press the round button on the Hue bridge and retry within 30 seconds.', {
      details,
    });
    this.name = 'LinkButtonNotPressedError';
  }
}

export class PairingTimeoutError extends HueError {
  constructor(timeoutMs: number) {
    super('pairing_timeout', `Pairing timed out after ${timeoutMs} ms without the link button being pressed.`);
    this.name = 'PairingTimeoutError';
  }
}

export class TlsError extends HueError {
  constructor(message: string, cause?: unknown) {
    super('tls', message, { cause });
    this.name = 'TlsError';
  }
}

export function isHueError(value: unknown): value is HueError {
  return value instanceof HueError;
}
