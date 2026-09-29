/**
 * Normalises sensor-style services into {@link SensorSnapshot}s.
 */

import { lightLevelToLux } from '../color.js';
import type {
  BaseResource,
  ButtonResource,
  ContactResource,
  DevicePowerResource,
  LightLevelResource,
  MotionResource,
  RelativeRotaryResource,
  ResourceType,
  TamperResource,
  TemperatureResource,
} from '../types.js';
import { SENSOR_SERVICE_TYPES } from '../types.js';
import type { SensorSnapshot } from './snapshot.js';

export function isSensorType(type: ResourceType): boolean {
  return (SENSOR_SERVICE_TYPES as readonly string[]).includes(type);
}

export function sensorSnapshot(resource: BaseResource): SensorSnapshot | undefined {
  const base = {
    id: resource.id,
    type: resource.type,
    enabled: typeof resource['enabled'] === 'boolean' ? (resource['enabled'] as boolean) : null,
  };
  switch (resource.type) {
    case 'motion':
    case 'camera_motion':
    case 'grouped_motion':
    case 'convenience_area_motion':
    case 'security_area_motion': {
      const r = resource as MotionResource;
      const report = r.motion?.motion_report;
      const legacyValid = r.motion?.motion_valid;
      const value = report ? report.motion : legacyValid === false ? null : (r.motion?.motion ?? null);
      const detail: Record<string, unknown> = {};
      if (r.sensitivity) detail['sensitivity'] = r.sensitivity;
      return { ...base, value, unit: 'boolean', detail, changed: report?.changed ?? null };
    }
    case 'temperature': {
      const r = resource as TemperatureResource;
      const report = r.temperature?.temperature_report;
      const legacyValid = r.temperature?.temperature_valid;
      const value = report ? report.temperature : legacyValid === false ? null : (r.temperature?.temperature ?? null);
      return { ...base, value, unit: '°C', detail: {}, changed: report?.changed ?? null };
    }
    case 'light_level':
    case 'grouped_light_level': {
      const r = resource as LightLevelResource;
      const report = r.light?.light_level_report;
      const legacyValid = r.light?.light_level_valid;
      const raw = report ? report.light_level : legacyValid === false ? null : (r.light?.light_level ?? null);
      return {
        ...base,
        value: raw === null ? null : lightLevelToLux(raw),
        unit: 'lux',
        detail: { lightLevel: raw },
        changed: report?.changed ?? null,
      };
    }
    case 'contact': {
      const r = resource as ContactResource;
      return { ...base, value: r.contact_report?.state ?? null, unit: 'state', detail: {}, changed: r.contact_report?.changed ?? null };
    }
    case 'tamper': {
      const r = resource as TamperResource;
      const latest = [...(r.tamper_reports ?? [])].sort((a, b) => (a.changed < b.changed ? 1 : -1))[0];
      return { ...base, value: latest?.state ?? null, unit: 'state', detail: { reports: r.tamper_reports ?? [] }, changed: latest?.changed ?? null };
    }
    case 'device_power': {
      const r = resource as DevicePowerResource;
      return {
        ...base,
        value: r.power_state?.battery_level ?? null,
        unit: '%',
        detail: { batteryState: r.power_state?.battery_state ?? null },
        changed: null,
      };
    }
    case 'button':
    case 'bell_button': {
      const r = resource as ButtonResource;
      const report = r.button?.button_report;
      const value = report?.event ?? r.button?.last_event ?? null;
      return {
        ...base,
        value,
        unit: 'event',
        detail: { controlId: r.metadata?.control_id ?? null, eventValues: r.button?.event_values ?? [] },
        changed: report?.updated ?? null,
      };
    }
    case 'relative_rotary': {
      const r = resource as RelativeRotaryResource;
      const report = r.relative_rotary?.rotary_report;
      const steps = report ? (report.rotation.direction === 'clock_wise' ? 1 : -1) * report.rotation.steps : null;
      return {
        ...base,
        value: steps,
        unit: 'steps',
        detail: report ? { action: report.action, direction: report.rotation.direction, duration: report.rotation.duration } : {},
        changed: report?.updated ?? null,
      };
    }
    default:
      return undefined;
  }
}
