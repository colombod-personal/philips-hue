/**
 * Philips Hue CLIP v2 resource types.
 *
 * These are hand-written from the public CLIP v2 API shape (as documented by
 * the Hue developer program and the OpenHue OpenAPI project) and are
 * deliberately permissive: the bridge adds fields over time, so every resource
 * keeps an index signature and unknown fields are preserved verbatim.
 */

/** All resource types the bridge can expose at `/clip/v2/resource/{type}`. */
export type ResourceType =
  | 'device'
  | 'bridge_home'
  | 'room'
  | 'zone'
  | 'light'
  | 'button'
  | 'relative_rotary'
  | 'temperature'
  | 'light_level'
  | 'motion'
  | 'camera_motion'
  | 'entertainment'
  | 'contact'
  | 'tamper'
  | 'grouped_light'
  | 'grouped_motion'
  | 'grouped_light_level'
  | 'device_power'
  | 'zigbee_bridge_connectivity'
  | 'zigbee_connectivity'
  | 'zgp_connectivity'
  | 'zigbee_device_discovery'
  | 'bridge'
  | 'device_software_update'
  | 'homekit'
  | 'matter'
  | 'matter_fabric'
  | 'scene'
  | 'smart_scene'
  | 'entertainment_configuration'
  | 'public_image'
  | 'auth_v1'
  | 'behavior_script'
  | 'behavior_instance'
  | 'geofence_client'
  | 'geolocation'
  | 'convenience_area_motion'
  | 'security_area_motion'
  | 'motion_area_candidate'
  | 'motion_area_configuration'
  | 'bell_button'
  | (string & {});

/** Service types that carry *sensor* readings (read-only state). */
export const SENSOR_SERVICE_TYPES = [
  'motion',
  'temperature',
  'light_level',
  'contact',
  'tamper',
  'camera_motion',
  'device_power',
  'button',
  'relative_rotary',
  'bell_button',
  'grouped_motion',
  'grouped_light_level',
  'convenience_area_motion',
  'security_area_motion',
] as const satisfies readonly ResourceType[];

export type SensorServiceType = (typeof SENSOR_SERVICE_TYPES)[number];

export interface ResourceIdentifier<T extends ResourceType = ResourceType> {
  rid: string;
  rtype: T;
}

export interface BaseResource {
  id: string;
  type: ResourceType;
  /** Legacy v1 path such as `/lights/3` or `/sensors/12`. */
  id_v1?: string;
  owner?: ResourceIdentifier;
  [key: string]: unknown;
}

export interface ProductData {
  model_id?: string;
  manufacturer_name?: string;
  product_name?: string;
  product_archetype?: string;
  certified?: boolean;
  software_version?: string;
  hardware_platform_type?: string;
  [key: string]: unknown;
}

export interface Metadata {
  name?: string;
  archetype?: string;
  [key: string]: unknown;
}

export interface DeviceResource extends BaseResource {
  type: 'device';
  product_data?: ProductData;
  metadata?: Metadata;
  services: ResourceIdentifier[];
  identify?: Record<string, unknown>;
  usertest?: { status?: string; usertest?: boolean };
}

export interface XY {
  x: number;
  y: number;
}

export interface Gamut {
  red: XY;
  green: XY;
  blue: XY;
}

export interface LightResource extends BaseResource {
  type: 'light';
  metadata?: Metadata & { function?: string; fixed_mired?: number };
  on?: { on: boolean };
  dimming?: { brightness: number; min_dim_level?: number };
  color_temperature?: {
    mirek: number | null;
    mirek_valid?: boolean;
    mirek_schema?: { mirek_minimum: number; mirek_maximum: number };
  };
  color?: { xy: XY; gamut?: Gamut; gamut_type?: 'A' | 'B' | 'C' | 'other' };
  dynamics?: { status?: string; status_values?: string[]; speed?: number; speed_valid?: boolean };
  alert?: { action_values?: string[] };
  signaling?: { signal_values?: string[]; status?: unknown };
  mode?: 'normal' | 'streaming';
  gradient?: unknown;
  effects?: unknown;
  effects_v2?: unknown;
  timed_effects?: unknown;
  powerup?: unknown;
  service_id?: number;
}

export interface GroupedLightResource extends BaseResource {
  type: 'grouped_light';
  on?: { on: boolean };
  dimming?: { brightness: number };
  color_temperature?: { mirek?: number | null; mirek_valid?: boolean };
  color?: { xy?: XY };
  alert?: { action_values?: string[] };
  signaling?: unknown;
}

export interface GroupResource extends BaseResource {
  type: 'room' | 'zone' | 'bridge_home';
  children: ResourceIdentifier[];
  services: ResourceIdentifier[];
  metadata?: Metadata;
}

export interface RoomResource extends GroupResource {
  type: 'room';
}

export interface ZoneResource extends GroupResource {
  type: 'zone';
}

export interface BridgeHomeResource extends GroupResource {
  type: 'bridge_home';
}

export interface BridgeResource extends BaseResource {
  type: 'bridge';
  bridge_id: string;
  time_zone?: { time_zone: string };
}

export interface SceneResource extends BaseResource {
  type: 'scene';
  metadata?: Metadata & { image?: ResourceIdentifier; appdata?: string };
  group: ResourceIdentifier<'room' | 'zone'>;
  actions?: unknown[];
  palette?: unknown;
  speed?: number;
  auto_dynamic?: boolean;
  status?: { active?: 'inactive' | 'static' | 'dynamic_palette' };
}

/* ---------- Sensor services ---------- */

export interface MotionResource extends BaseResource {
  type: 'motion' | 'camera_motion' | 'grouped_motion' | 'convenience_area_motion' | 'security_area_motion';
  enabled?: boolean;
  motion?: {
    /** @deprecated use motion_report */
    motion?: boolean;
    /** @deprecated use motion_report */
    motion_valid?: boolean;
    motion_report?: { changed: string; motion: boolean };
  };
  sensitivity?: { status?: string; sensitivity?: number; sensitivity_max?: number };
}

export interface TemperatureResource extends BaseResource {
  type: 'temperature';
  enabled?: boolean;
  temperature?: {
    /** @deprecated use temperature_report */
    temperature?: number;
    /** @deprecated use temperature_report */
    temperature_valid?: boolean;
    temperature_report?: { changed: string; temperature: number };
  };
}

export interface LightLevelResource extends BaseResource {
  type: 'light_level' | 'grouped_light_level';
  enabled?: boolean;
  light?: {
    /** @deprecated use light_level_report */
    light_level?: number;
    /** @deprecated use light_level_report */
    light_level_valid?: boolean;
    light_level_report?: { changed: string; light_level: number };
  };
}

export interface ContactResource extends BaseResource {
  type: 'contact';
  enabled?: boolean;
  contact_report?: { changed: string; state: 'contact' | 'no_contact' };
}

export interface TamperResource extends BaseResource {
  type: 'tamper';
  tamper_reports?: Array<{ changed: string; source: string; state: 'tampered' | 'not_tampered' }>;
}

export interface DevicePowerResource extends BaseResource {
  type: 'device_power';
  power_state?: {
    battery_state?: 'normal' | 'low' | 'critical';
    battery_level?: number;
  };
}

export type ButtonEvent =
  | 'initial_press'
  | 'repeat'
  | 'short_release'
  | 'long_release'
  | 'double_short_release'
  | 'long_press'
  | (string & {});

export interface ButtonResource extends BaseResource {
  type: 'button' | 'bell_button';
  metadata?: { control_id?: number };
  button?: {
    /** @deprecated use button_report */
    last_event?: ButtonEvent;
    button_report?: { updated: string; event: ButtonEvent };
    repeat_interval?: number;
    event_values?: ButtonEvent[];
  };
}

export interface RelativeRotaryResource extends BaseResource {
  type: 'relative_rotary';
  relative_rotary?: {
    rotary_report?: {
      updated: string;
      action: 'start' | 'repeat' | (string & {});
      rotation: { direction: 'clock_wise' | 'counter_clock_wise'; steps: number; duration: number };
    };
    /** @deprecated */
    last_event?: unknown;
  };
}

export interface ZigbeeConnectivityResource extends BaseResource {
  type: 'zigbee_connectivity' | 'zgp_connectivity' | 'zigbee_bridge_connectivity';
  status?: 'connected' | 'disconnected' | 'connectivity_issue' | 'unidirectional_incoming' | (string & {});
  mac_address?: string;
  channel?: unknown;
}

export interface DeviceSoftwareUpdateResource extends BaseResource {
  type: 'device_software_update';
  state?: string;
  problems?: string[];
}

export type SensorResource =
  | MotionResource
  | TemperatureResource
  | LightLevelResource
  | ContactResource
  | TamperResource
  | DevicePowerResource
  | ButtonResource
  | RelativeRotaryResource;

export type AnyResource =
  | DeviceResource
  | LightResource
  | GroupedLightResource
  | RoomResource
  | ZoneResource
  | BridgeHomeResource
  | BridgeResource
  | SceneResource
  | SensorResource
  | ZigbeeConnectivityResource
  | DeviceSoftwareUpdateResource
  | BaseResource;

/** Maps a resource type string to its TypeScript shape (falls back to BaseResource). */
export type ResourceOf<T extends ResourceType> = T extends 'device'
  ? DeviceResource
  : T extends 'light'
    ? LightResource
    : T extends 'grouped_light'
      ? GroupedLightResource
      : T extends 'room'
        ? RoomResource
        : T extends 'zone'
          ? ZoneResource
          : T extends 'bridge_home'
            ? BridgeHomeResource
            : T extends 'bridge'
              ? BridgeResource
              : T extends 'scene'
                ? SceneResource
                : T extends 'motion' | 'camera_motion' | 'grouped_motion' | 'convenience_area_motion' | 'security_area_motion'
                  ? MotionResource
                  : T extends 'temperature'
                    ? TemperatureResource
                    : T extends 'light_level' | 'grouped_light_level'
                      ? LightLevelResource
                      : T extends 'contact'
                        ? ContactResource
                        : T extends 'tamper'
                          ? TamperResource
                          : T extends 'device_power'
                            ? DevicePowerResource
                            : T extends 'button' | 'bell_button'
                              ? ButtonResource
                              : T extends 'relative_rotary'
                                ? RelativeRotaryResource
                                : T extends 'zigbee_connectivity' | 'zgp_connectivity' | 'zigbee_bridge_connectivity'
                                  ? ZigbeeConnectivityResource
                                  : T extends 'device_software_update'
                                    ? DeviceSoftwareUpdateResource
                                    : BaseResource;

/* ---------- Envelope / errors ---------- */

export interface ClipError {
  description: string;
  [key: string]: unknown;
}

export interface ClipResponse<T = BaseResource> {
  errors: ClipError[];
  data: T[];
}

/* ---------- Event stream ---------- */

export type HueEventType = 'update' | 'add' | 'delete' | 'error';

export interface HueEvent<T = BaseResource> {
  id: string;
  creationtime: string;
  type: HueEventType;
  data: T[];
}

/* ---------- Bridge info (discovery / config) ---------- */

/** Unauthenticated `GET /api/0/config` payload. */
export interface BridgeConfig {
  name: string;
  datastoreversion?: string;
  swversion: string;
  apiversion: string;
  mac?: string;
  bridgeid: string;
  factorynew?: boolean;
  replacesbridgeid?: string | null;
  modelid: string;
  starterkitid?: string;
  [key: string]: unknown;
}

/* ---------- Light write payloads ---------- */

export interface LightUpdate {
  on?: { on: boolean };
  dimming?: { brightness: number };
  dimming_delta?: { action: 'up' | 'down' | 'stop'; brightness_delta?: number };
  color_temperature?: { mirek: number };
  color_temperature_delta?: { action: 'up' | 'down' | 'stop'; mirek_delta?: number };
  color?: { xy: XY };
  dynamics?: { duration?: number; speed?: number };
  alert?: { action: 'breathe' };
  signaling?: { signal: 'no_signal' | 'on_off' | 'on_off_color' | 'alternating'; duration?: number; colors?: Array<{ xy: XY }> };
  identify?: { action: 'identify' };
  effects?: { effect: string };
  effects_v2?: unknown;
  timed_effects?: unknown;
  gradient?: unknown;
  metadata?: Metadata;
  [key: string]: unknown;
}

export type GroupedLightUpdate = LightUpdate;
