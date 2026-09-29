/**
 * Plain-JSON snapshots. These are the shapes agents and other applications
 * consume: stable, self-describing, and free of class instances.
 */

import type { ButtonEvent, ResourceType, XY } from '../types.js';

export type DeviceKind = 'bridge' | 'light' | 'plug' | 'sensor' | 'switch' | 'entertainment' | 'other';

export interface RoomRef {
  id: string;
  name: string;
  type: 'room' | 'zone';
}

export interface LightSnapshot {
  id: string;
  name: string;
  on: boolean | null;
  /** 0–100, when dimmable. */
  brightness: number | null;
  colorTemperature: { mirek: number | null; kelvin: number | null; min: number | null; max: number | null } | null;
  color: { xy: XY; hex: string; gamutType: string | null } | null;
  /** Light capabilities derived from the resource. */
  capabilities: { dimming: boolean; colorTemperature: boolean; color: boolean; effects: boolean; gradient: boolean };
  /** `streaming` while an entertainment session owns the light. */
  mode: string | null;
  archetype: string | null;
  function: string | null;
}

export type SensorUnit = 'boolean' | '°C' | 'lux' | '%' | 'event' | 'state' | 'steps' | 'string';

export interface SensorSnapshot {
  id: string;
  /** Service type, e.g. `motion`, `temperature`, `light_level`, `device_power`, `button`. */
  type: ResourceType;
  /** Normalised reading. `null` when the bridge marks it invalid/unknown. */
  value: boolean | number | string | null;
  unit: SensorUnit;
  /** Extra detail per sensor type (raw light level, battery state, button control id, rotary steps...). */
  detail: Record<string, unknown>;
  /** ISO timestamp of the last change reported by the bridge. */
  changed: string | null;
  enabled: boolean | null;
}

export interface DeviceSnapshot {
  id: string;
  name: string;
  kind: DeviceKind;
  /** Legacy v1 path (e.g. `/lights/3`, `/sensors/12`), useful for cross-referencing old integrations. */
  idV1: string | null;
  product: {
    modelId: string | null;
    manufacturer: string | null;
    productName: string | null;
    archetype: string | null;
    softwareVersion: string | null;
    certified: boolean | null;
  };
  room: RoomRef | null;
  zones: RoomRef[];
  /** Service types exposed by the device. */
  services: ResourceType[];
  connectivity: string | null;
  battery: { level: number | null; state: string | null } | null;
  lights: LightSnapshot[];
  sensors: SensorSnapshot[];
}

export interface GroupSnapshot {
  id: string;
  name: string;
  type: 'room' | 'zone' | 'bridge_home';
  archetype: string | null;
  deviceIds: string[];
  /** Aggregate light state for the group when it has a grouped_light service. */
  light: { id: string; on: boolean | null; brightness: number | null } | null;
  sceneIds: string[];
}

export interface SceneSnapshot {
  id: string;
  name: string;
  groupId: string;
  groupType: 'room' | 'zone';
  active: string | null;
}

export interface HomeSnapshot {
  bridge: { id: string | null; name: string | null; modelId: string | null; softwareVersion: string | null; host: string };
  capturedAt: string;
  devices: DeviceSnapshot[];
  rooms: GroupSnapshot[];
  zones: GroupSnapshot[];
  scenes: SceneSnapshot[];
}

export type ButtonEventName = ButtonEvent;
