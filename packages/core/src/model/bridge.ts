/**
 * {@link HueBridge}: the aggregate root. Loads every resource once, exposes
 * devices / rooms / zones / scenes as live views over an in-memory index, and
 * keeps that index current through the event stream when {@link HueBridge.watch}
 * is called.
 */

import { EventEmitter } from 'node:events';
import { HueClient, type HueClientOptions } from '../client.js';
import { HueError } from '../errors.js';
import type { EventStreamOptions, HueEventStream } from '../events.js';
import type { BridgeCredentials } from '../pairing.js';
import type { BaseResource, BridgeResource, HueEvent, ResourceType } from '../types.js';
import { HueDevice } from './device.js';
import { HueGroup, HueScene } from './group.js';
import { ResourceIndex } from './index-store.js';
import { HueLight } from './light.js';
import { isSensorType } from './sensor.js';
import type { DeviceKind, DeviceSnapshot, HomeSnapshot, RoomRef, SensorSnapshot } from './snapshot.js';

export interface DeviceQuery {
  /** Case-insensitive substring match on the device name. */
  name?: string | undefined;
  /** Room name (case-insensitive) or room id. */
  room?: string | undefined;
  /** Zone name (case-insensitive) or zone id. */
  zone?: string | undefined;
  kind?: DeviceKind | DeviceKind[] | undefined;
  /** Device must expose this service type (e.g. `motion`, `light`). */
  service?: ResourceType | undefined;
  modelId?: string | undefined;
}

export interface ChangeEvent {
  event: HueEvent;
  /** Resources touched by the event (merged state). */
  resources: BaseResource[];
  /** Devices whose services were touched. */
  devices: HueDevice[];
}

export interface HueBridgeEvents {
  change: [change: ChangeEvent];
  sensor: [reading: SensorSnapshot, device: HueDevice];
  connected: [info: { reconnect: boolean }];
  disconnected: [error: HueError | undefined];
  error: [error: HueError];
}

export class HueBridge extends EventEmitter<HueBridgeEvents> {
  readonly client: HueClient;
  readonly index = new ResourceIndex();
  private stream: HueEventStream | undefined;
  private loadedAt: Date | undefined;

  constructor(client: HueClient) {
    super();
    this.client = client;
  }

  /** Creates a bridge from stored credentials and loads all resources. */
  static async connect(creds: BridgeCredentials, options: Partial<HueClientOptions> = {}): Promise<HueBridge> {
    const bridge = new HueBridge(HueClient.fromCredentials(creds, options));
    await bridge.refresh();
    return bridge;
  }

  get host(): string {
    return this.client.host;
  }

  get isLoaded(): boolean {
    return this.loadedAt !== undefined;
  }

  /** The bridge's own `bridge` resource. */
  get info(): BridgeResource | undefined {
    return this.index.list('bridge')[0];
  }

  /** Re-fetches every resource from the bridge. */
  async refresh(signal?: AbortSignal): Promise<void> {
    const all = await this.client.listAll(signal);
    this.index.replaceAll(all);
    this.loadedAt = new Date();
  }

  /* ---------- devices ---------- */

  get devices(): HueDevice[] {
    return this.index.list('device').map((d) => this.deviceView(d.id));
  }

  device(id: string): HueDevice | undefined {
    return this.index.get('device', id) ? this.deviceView(id) : undefined;
  }

  /** Finds the device that owns a service (e.g. a light or motion resource id). */
  deviceForService(rid: string): HueDevice | undefined {
    for (const r of this.index.all()) {
      if (r.id === rid && r.owner?.rtype === 'device') return this.device(r.owner.rid);
    }
    return undefined;
  }

  findDevices(query: DeviceQuery = {}): HueDevice[] {
    const name = query.name?.toLowerCase();
    const kinds = query.kind === undefined ? undefined : Array.isArray(query.kind) ? query.kind : [query.kind];
    const room = query.room ? this.rooms.find((r) => matchesGroup(r, query.room!)) : undefined;
    const zone = query.zone ? this.zones.find((z) => matchesGroup(z, query.zone!)) : undefined;
    if (query.room && !room) return [];
    if (query.zone && !zone) return [];
    const roomIds = room ? new Set(room.deviceIds()) : undefined;
    const zoneIds = zone ? new Set(zone.deviceIds()) : undefined;
    return this.devices.filter((d) => {
      if (name && !d.name.toLowerCase().includes(name)) return false;
      if (kinds && !kinds.includes(d.kind)) return false;
      if (query.service && !d.serviceTypes().includes(query.service)) return false;
      if (query.modelId && d.modelId?.toLowerCase() !== query.modelId.toLowerCase()) return false;
      if (roomIds && !roomIds.has(d.id)) return false;
      if (zoneIds && !zoneIds.has(d.id)) return false;
      return true;
    });
  }

  /** Finds one device by id or exact/unique name (case-insensitive). */
  resolveDevice(idOrName: string): HueDevice | undefined {
    const byId = this.device(idOrName);
    if (byId) return byId;
    const lower = idOrName.toLowerCase();
    const exact = this.devices.filter((d) => d.name.toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    const partial = this.devices.filter((d) => d.name.toLowerCase().includes(lower));
    return partial.length === 1 ? partial[0] : undefined;
  }

  /* ---------- lights ---------- */

  get lights(): HueLight[] {
    return this.index.list('light').map((l) => new HueLight(this.client, () => this.index.get('light', l.id), l.id));
  }

  light(id: string): HueLight | undefined {
    return this.index.get('light', id) ? new HueLight(this.client, () => this.index.get('light', id), id) : undefined;
  }

  /** Finds one light by id or exact/unique name (case-insensitive), or by its device's name. */
  resolveLight(idOrName: string): HueLight | undefined {
    const byId = this.light(idOrName);
    if (byId) return byId;
    const lower = idOrName.toLowerCase();
    const lights = this.lights;
    const exact = lights.filter((l) => l.name.toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    const partial = lights.filter((l) => l.name.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    const device = this.resolveDevice(idOrName);
    return device && device.lights.length === 1 ? device.lights[0] : undefined;
  }

  /* ---------- sensors ---------- */

  /** Every sensor reading on the bridge, with its owning device. */
  sensors(type?: ResourceType): Array<{ device: HueDevice; reading: SensorSnapshot }> {
    const out: Array<{ device: HueDevice; reading: SensorSnapshot }> = [];
    for (const device of this.devices) {
      for (const reading of device.sensors()) {
        if (!type || reading.type === type) out.push({ device, reading });
      }
    }
    return out;
  }

  /* ---------- groups & scenes ---------- */

  get rooms(): HueGroup[] {
    return this.index.list('room').map((r) => new HueGroup(this.client, this.index, 'room', r.id));
  }

  get zones(): HueGroup[] {
    return this.index.list('zone').map((z) => new HueGroup(this.client, this.index, 'zone', z.id));
  }

  get home(): HueGroup | undefined {
    const h = this.index.list('bridge_home')[0];
    return h ? new HueGroup(this.client, this.index, 'bridge_home', h.id) : undefined;
  }

  group(idOrName: string): HueGroup | undefined {
    return [...this.rooms, ...this.zones].find((g) => matchesGroup(g, idOrName));
  }

  get scenes(): HueScene[] {
    return this.index.list('scene').map((s) => new HueScene(this.client, this.index, s.id));
  }

  scene(idOrName: string, groupIdOrName?: string): HueScene | undefined {
    const group = groupIdOrName ? this.group(groupIdOrName) : undefined;
    if (groupIdOrName && !group) return undefined;
    const pool = group ? group.scenes : this.scenes;
    const lower = idOrName.toLowerCase();
    return pool.find((s) => s.id === idOrName) ?? pool.find((s) => s.name.toLowerCase() === lower);
  }

  /* ---------- snapshots ---------- */

  snapshot(): HomeSnapshot {
    const info = this.info;
    const bridgeDevice = info ? this.deviceForService(info.id) : undefined;
    return {
      bridge: {
        id: info?.bridge_id?.toLowerCase() ?? this.client.bridgeId ?? null,
        name: bridgeDevice?.name ?? null,
        modelId: bridgeDevice?.modelId ?? null,
        softwareVersion: bridgeDevice?.resource?.product_data?.software_version ?? null,
        host: this.host,
      },
      capturedAt: new Date().toISOString(),
      devices: this.devices.map((d) => d.snapshot()),
      rooms: this.rooms.map((r) => r.snapshot()),
      zones: this.zones.map((z) => z.snapshot()),
      scenes: this.scenes.map((s) => s.snapshot()),
    };
  }

  /* ---------- live updates ---------- */

  /**
   * Subscribes to the bridge event stream and keeps the model current.
   * Emits `change` (any resource), `sensor` (normalised sensor readings),
   * `connected` / `disconnected` / `error`. Returns the underlying stream.
   */
  async watch(options: EventStreamOptions = {}): Promise<HueEventStream> {
    if (this.stream) return this.stream;
    const stream = this.client.events(options);
    this.stream = stream;
    stream.on('event', (event) => {
      const resources = this.index.apply(event);
      const devices = new Map<string, HueDevice>();
      for (const r of resources) {
        const ownerId = r.owner?.rtype === 'device' ? r.owner.rid : r.type === 'device' ? r.id : undefined;
        if (ownerId && !devices.has(ownerId)) {
          const d = this.device(ownerId);
          if (d) devices.set(ownerId, d);
        }
      }
      const change: ChangeEvent = { event, resources, devices: [...devices.values()] };
      this.emit('change', change);
      if (event.type === 'update') {
        for (const r of resources) {
          if (!isSensorType(r.type) || r.owner?.rtype !== 'device') continue;
          const device = devices.get(r.owner.rid);
          const reading = device?.sensors().find((s) => s.id === r.id);
          if (device && reading) this.emit('sensor', reading, device);
        }
      }
    });
    stream.on('connected', (info) => {
      this.emit('connected', info);
      if (info.reconnect) void this.refresh().catch((err: unknown) => this.emit('error', err as HueError));
    });
    stream.on('disconnected', (err) => this.emit('disconnected', err));
    stream.on('error', (err) => this.emit('error', err));
    stream.on('end', () => {
      if (this.stream === stream) this.stream = undefined;
    });
    await stream.start();
    return stream;
  }

  /** Stops watching (if active) and releases sockets. */
  close(): void {
    this.stream?.stop();
    this.stream = undefined;
    this.client.close();
  }

  /* ---------- internals ---------- */

  private deviceView(id: string): HueDevice {
    return new HueDevice(this.client, this.index, id, (deviceId) => this.locate(deviceId));
  }

  private locate(deviceId: string): { room: RoomRef | null; zones: RoomRef[] } {
    let room: RoomRef | null = null;
    for (const r of this.index.list('room')) {
      if (r.children.some((c) => c.rtype === 'device' && c.rid === deviceId)) {
        room = { id: r.id, name: r.metadata?.name ?? '', type: 'room' };
        break;
      }
    }
    const lightIds = new Set((this.index.get('device', deviceId)?.services ?? []).filter((s) => s.rtype === 'light').map((s) => s.rid));
    const zones: RoomRef[] = [];
    for (const z of this.index.list('zone')) {
      if (z.children.some((c) => (c.rtype === 'device' && c.rid === deviceId) || (c.rtype === 'light' && lightIds.has(c.rid)))) {
        zones.push({ id: z.id, name: z.metadata?.name ?? '', type: 'zone' });
      }
    }
    return { room, zones };
  }
}

function matchesGroup(g: HueGroup, idOrName: string): boolean {
  return g.id === idOrName || g.name.toLowerCase() === idOrName.toLowerCase();
}

export type { DeviceSnapshot };
