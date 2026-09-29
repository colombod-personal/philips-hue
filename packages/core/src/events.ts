/**
 * Server-Sent Events client for `/eventstream/clip/v2`.
 *
 * The bridge pushes `update` / `add` / `delete` / `error` events whenever any
 * resource changes (a light toggled by the app, a motion sensor firing, a
 * button pressed). Polling the REST API for changes is discouraged by Signify;
 * this stream is the right way to stay current.
 *
 * The bridge sends no keep-alives, so a silently dead connection looks exactly
 * like an idle one. {@link HueEventStream} therefore reconnects on any socket
 * close/error with exponential backoff and lets callers refresh state after
 * each reconnect via the `connected` event.
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { HueError } from './errors.js';
import type { HttpTransport } from './transport.js';
import type { BaseResource, HueEvent } from './types.js';

export const EVENTSTREAM_PATH = '/eventstream/clip/v2';

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

/** Incremental SSE line parser. Feed chunks, drain complete messages. */
export class SseParser {
  private buffer = '';
  private current: { id?: string; event?: string; data: string[] } = { data: [] };

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buffer.slice(0, idx);
      const sep = this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(idx + sep);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') {
      if (this.current.data.length === 0 && this.current.id === undefined && this.current.event === undefined) return undefined;
      const msg: SseMessage = { data: this.current.data.join('\n') };
      if (this.current.id !== undefined) msg.id = this.current.id;
      if (this.current.event !== undefined) msg.event = this.current.event;
      this.current = { data: [] };
      return msg;
    }
    if (line.startsWith(':')) return undefined; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.current.data.push(value);
        break;
      case 'id':
        this.current.id = value;
        break;
      case 'event':
        this.current.event = value;
        break;
      default:
        break; // retry:, unknown fields ignored
    }
    return undefined;
  }
}

/** Parses the JSON payload of one SSE message into Hue events. */
export function parseHueEvents(data: string): HueEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    throw new HueError('invalid_response', 'Event stream delivered malformed JSON.', { cause, details: data });
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(isHueEvent);
}

function isHueEvent(value: unknown): value is HueEvent {
  return typeof value === 'object' && value !== null && Array.isArray((value as HueEvent).data) && typeof (value as HueEvent).type === 'string';
}

export interface EventStreamOptions {
  /** Reconnect automatically (default true). */
  reconnect?: boolean | undefined;
  /** Initial backoff (default 1000 ms); doubles up to `maxBackoffMs`. */
  backoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface EventStreamEvents {
  event: [event: HueEvent];
  resource: [resource: BaseResource, event: HueEvent];
  connected: [info: { reconnect: boolean }];
  disconnected: [error: HueError | undefined];
  error: [error: HueError];
  end: [];
}

/**
 * Long-lived subscription to the bridge event stream.
 *
 * Use as an EventEmitter (`stream.on('event', …)`) or as an async iterable
 * (`for await (const ev of stream)`). Call {@link HueEventStream.stop} to end it.
 */
export class HueEventStream extends EventEmitter<EventStreamEvents> implements AsyncIterable<HueEvent> {
  private readonly transport: HttpTransport;
  private readonly options: EventStreamOptions;
  private controller: AbortController | undefined;
  private response: IncomingMessage | undefined;
  private started = false;
  private stopped = false;
  private everConnected = false;
  private lastEventId: string | undefined;
  private readonly queue: HueEvent[] = [];
  private waiters: Array<(result: IteratorResult<HueEvent>) => void> = [];

  constructor(transport: HttpTransport, options: EventStreamOptions = {}) {
    super();
    this.transport = transport;
    this.options = options;
    options.signal?.addEventListener('abort', () => this.stop(), { once: true });
  }

  get isConnected(): boolean {
    return this.response !== undefined && !this.response.destroyed;
  }

  /** Opens the stream (idempotent). Resolves once the first connection is established. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    await this.connect(false);
  }

  /** Closes the stream and ends async iteration. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    this.response?.destroy();
    this.response = undefined;
    this.flushWaiters({ value: undefined, done: true });
    this.emit('end');
  }

  private async connect(reconnect: boolean): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    const headers: Record<string, string> = {};
    if (this.lastEventId) headers['last-event-id'] = this.lastEventId;
    let res: IncomingMessage;
    try {
      res = await this.transport.stream(EVENTSTREAM_PATH, { signal: controller.signal, headers });
    } catch (err) {
      const error = err instanceof HueError ? err : new HueError('network', String(err), { cause: err });
      this.emit('error', error);
      if (reconnect) {
        this.scheduleReconnect();
        return;
      }
      throw error;
    }
    if (res.statusCode !== 200) {
      res.resume();
      const error = new HueError(res.statusCode === 401 || res.statusCode === 403 ? 'unauthorized' : 'bridge_error', `Event stream request failed with HTTP ${res.statusCode}.`, {
        status: res.statusCode,
      });
      this.emit('error', error);
      if (reconnect && error.code !== 'unauthorized') {
        this.scheduleReconnect();
        return;
      }
      throw error;
    }
    this.response = res;
    this.backoff = this.options.backoffMs ?? 1000;
    this.emit('connected', { reconnect: this.everConnected });
    this.everConnected = true;

    const parser = new SseParser();
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      for (const msg of parser.push(chunk)) {
        if (msg.id) this.lastEventId = msg.id;
        if (!msg.data) continue;
        let events: HueEvent[];
        try {
          events = parseHueEvents(msg.data);
        } catch (err) {
          this.emit('error', err as HueError);
          continue;
        }
        for (const ev of events) this.dispatch(ev);
      }
    });
    const onClose = (err?: Error) => {
      if (this.response !== res) return;
      this.response = undefined;
      const error = err instanceof HueError ? err : err ? new HueError('stream_closed', `Event stream closed: ${err.message}`, { cause: err }) : undefined;
      this.emit('disconnected', error);
      if (!this.stopped && (this.options.reconnect ?? true)) this.scheduleReconnect();
      else if (!this.stopped) this.stop();
    };
    res.on('error', (err) => onClose(err));
    res.on('end', () => onClose());
    res.on('close', () => onClose());
  }

  private backoff = 1000;
  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 30_000);
    const timer = setTimeout(() => void this.connect(true), delay);
    timer.unref?.();
  }

  private dispatch(ev: HueEvent): void {
    this.emit('event', ev);
    for (const resource of ev.data) this.emit('resource', resource, ev);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: ev, done: false });
    else this.queue.push(ev);
  }

  private flushWaiters(result: IteratorResult<HueEvent>): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(result);
  }

  [Symbol.asyncIterator](): AsyncIterator<HueEvent> {
    if (!this.started) void this.start().catch((err) => this.emit('error', err as HueError));
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.stopped) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.stop();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
