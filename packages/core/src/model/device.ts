/**
 * Device-centric view: a physical Hue device (bulb, plug, motion sensor,
 * dimmer switch, the bridge itself) with its services resolved.
 */

import type { HueClient } from '../client.js';
import type { BaseResource, DevicePowerResource, DeviceResource, LightResource, ResourceType, ZigbeeConnectivityResource } from '../types.js';
import type { ResourceIndex } from './index-store.js';
import { HueLight, lightSnapshot } from './light.js';
import { isSensorType, sensorSnapshot } from './sensor.js';
import type { DeviceKind, DeviceSnapshot, RoomRef, SensorSnapshot } from './snapshot.js';

export class HueDevice {
  constructor(
    private readonly client: HueClient,
    private readonly index: ResourceIndex,
    readonly id: string,
    private readonly locate: (deviceId: string) => { room: RoomRef | null; zones: RoomRef[] },
  ) {}

  get resource(): DeviceResource | undefined {
    return this.index.get('device', this.id);
  }

  get name(): string {
    return this.resource?.metadata?.name ?? '';
  }

  get modelId(): string | undefined {
    return this.resource?.product_data?.model_id;
  }

  get kind(): DeviceKind {
    return classifyDevice(this.resource, this.serviceTypes());
  }

  /** Types of the services this device exposes. */
  serviceTypes(): ResourceType[] {
    return [...new Set((this.resource?.services ?? []).map((s) => s.rtype))];
  }

  /** Resolved service resources (only those present in the index). */
  services(): BaseResource[] {
    const out: BaseResource[] = [];
    for (const ref of this.resource?.services ?? []) {
      const r = this.index.resolve(ref);
      if (r) out.push(r);
    }
    return out;
  }

  service<T extends ResourceType>(type: T): BaseResource[] {
    return this.services().filter((s) => s.type === type);
  }

  get lights(): HueLight[] {
    return this.service('light').map((l) => new HueLight(this.client, () => this.index.get('light', l.id), l.id));
  }

  /** Normalised sensor readings for every sensor-like service on the device. */
  sensors(): SensorSnapshot[] {
    const out: SensorSnapshot[] = [];
    for (const s of this.services()) {
      if (!isSensorType(s.type)) continue;
      const snap = sensorSnapshot(s);
      if (snap) out.push(snap);
    }
    return out;
  }

  sensor(type: ResourceType): SensorSnapshot | undefined {
    return this.sensors().find((s) => s.type === type);
  }

  get connectivity(): string | null {
    const conn = this.services().find((s): s is ZigbeeConnectivityResource =>
      s.type === 'zigbee_connectivity' || s.type === 'zgp_connectivity' || s.type === 'zigbee_bridge_connectivity',
    );
    return conn?.status ?? null;
  }

  get battery(): { level: number | null; state: string | null } | null {
    const power = this.services().find((s): s is DevicePowerResource => s.type === 'device_power');
    if (!power) return null;
    return { level: power.power_state?.battery_level ?? null, state: power.power_state?.battery_state ?? null };
  }

  get room(): RoomRef | null {
    return this.locate(this.id).room;
  }

  get zones(): RoomRef[] {
    return this.locate(this.id).zones;
  }

  /** Blinks the device's lights (or triggers the device identify action). */
  async identify(): Promise<void> {
    const lights = this.lights;
    if (lights.length) {
      await Promise.all(lights.map((l) => l.identify()));
      return;
    }
    await this.client.update('device', this.id, { identify: { action: 'identify' } });
  }

  /** Renames the device in the bridge. */
  async rename(name: string): Promise<void> {
    await this.client.update('device', this.id, { metadata: { name } });
  }

  snapshot(): DeviceSnapshot {
    const r = this.resource;
    const { room, zones } = this.locate(this.id);
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      idV1: r?.id_v1 ?? null,
      product: {
        modelId: r?.product_data?.model_id ?? null,
        manufacturer: r?.product_data?.manufacturer_name ?? null,
        productName: r?.product_data?.product_name ?? null,
        archetype: r?.product_data?.product_archetype ?? r?.metadata?.archetype ?? null,
        softwareVersion: r?.product_data?.software_version ?? null,
        certified: r?.product_data?.certified ?? null,
      },
      room,
      zones,
      services: this.serviceTypes(),
      connectivity: this.connectivity,
      battery: this.battery,
      lights: this.service('light').map((l) => lightSnapshot(l as LightResource)),
      sensors: this.sensors(),
    };
  }

  toJSON(): DeviceSnapshot {
    return this.snapshot();
  }
}

export function classifyDevice(resource: DeviceResource | undefined, services: ResourceType[]): DeviceKind {
  if (!resource) return 'other';
  const archetype = resource.product_data?.product_archetype ?? resource.metadata?.archetype ?? '';
  if (services.includes('bridge') || archetype.startsWith('bridge')) return 'bridge';
  if (services.includes('light')) return archetype === 'plug' ? 'plug' : 'light';
  if (services.includes('button') || services.includes('relative_rotary') || services.includes('bell_button')) return 'switch';
  if (services.some((s) => ['motion', 'temperature', 'light_level', 'contact', 'tamper', 'camera_motion'].includes(s))) return 'sensor';
  if (services.includes('entertainment')) return 'entertainment';
  return 'other';
}
