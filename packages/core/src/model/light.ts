/**
 * Light control over a `light` (or `grouped_light`) resource.
 */

import { GAMUT_C, kelvinToMirek, mirekToKelvin, parseHexColor, rgbToHex, rgbToXy, xyToRgb, clamp, type RGB } from '../color.js';
import type { HueClient } from '../client.js';
import type { GroupedLightResource, LightResource, LightUpdate, XY } from '../types.js';
import type { LightSnapshot } from './snapshot.js';

export interface ColorInput {
  /** `#rrggbb` */
  hex?: string | undefined;
  rgb?: RGB | undefined;
  xy?: XY | undefined;
  /** Colour temperature in kelvin (2000–6500). */
  kelvin?: number | undefined;
  /** Colour temperature in mirek (153–500). */
  mirek?: number | undefined;
}

export interface LightCommand extends ColorInput {
  on?: boolean | undefined;
  /** 0–100 */
  brightness?: number | undefined;
  /** Transition duration in ms. */
  transitionMs?: number | undefined;
  /** Make the light breathe once (visual identification). */
  alert?: boolean | undefined;
}

/** Translates a friendly command into a CLIP `light` PUT body. */
export function buildLightUpdate(command: LightCommand, resource?: LightResource | GroupedLightResource): LightUpdate {
  const body: LightUpdate = {};
  if (command.on !== undefined) body.on = { on: command.on };
  if (command.brightness !== undefined) {
    body.dimming = { brightness: clamp(command.brightness, 0, 100) };
    if (command.on === undefined && command.brightness > 0) body.on = { on: true };
  }
  const gamut = (resource as LightResource | undefined)?.color?.gamut ?? GAMUT_C;
  if (command.xy) body.color = { xy: command.xy };
  else if (command.rgb || command.hex) {
    const rgb = command.rgb ?? parseHexColor(command.hex!);
    body.color = { xy: rgbToXy(rgb, gamut).xy };
  }
  if (command.mirek !== undefined || command.kelvin !== undefined) {
    let mirek = command.mirek ?? kelvinToMirek(command.kelvin!);
    const schema = (resource as LightResource | undefined)?.color_temperature?.mirek_schema;
    mirek = clamp(mirek, schema?.mirek_minimum ?? 153, schema?.mirek_maximum ?? 500);
    body.color_temperature = { mirek };
  }
  if ((body.color || body.color_temperature || body.dimming) && command.on === undefined && !body.on) body.on = { on: true };
  if (command.transitionMs !== undefined) body.dynamics = { duration: Math.max(0, Math.round(command.transitionMs)) };
  if (command.alert) body.alert = { action: 'breathe' };
  return body;
}

export function lightSnapshot(r: LightResource): LightSnapshot {
  const gamut = r.color?.gamut ?? GAMUT_C;
  const brightness = r.dimming?.brightness ?? null;
  const mirek = r.color_temperature?.mirek ?? null;
  const ctValid = r.color_temperature?.mirek_valid !== false;
  return {
    id: r.id,
    name: r.metadata?.name ?? '',
    on: r.on?.on ?? null,
    brightness,
    colorTemperature: r.color_temperature
      ? {
          mirek: ctValid ? mirek : null,
          kelvin: ctValid && mirek ? mirekToKelvin(mirek) : null,
          min: r.color_temperature.mirek_schema?.mirek_minimum ?? null,
          max: r.color_temperature.mirek_schema?.mirek_maximum ?? null,
        }
      : null,
    color: r.color?.xy
      ? { xy: r.color.xy, hex: rgbToHex(xyToRgb(r.color.xy, brightness ?? 100, gamut)), gamutType: r.color.gamut_type ?? null }
      : null,
    capabilities: {
      dimming: r.dimming !== undefined,
      colorTemperature: r.color_temperature !== undefined,
      color: r.color !== undefined,
      effects: r.effects !== undefined || r.effects_v2 !== undefined,
      gradient: r.gradient !== undefined,
    },
    mode: r.mode ?? null,
    archetype: r.metadata?.archetype ?? null,
    function: r.metadata?.function ?? null,
  };
}

/** Live view over a `light` resource. */
export class HueLight {
  constructor(
    private readonly client: HueClient,
    private readonly read: () => LightResource | undefined,
    readonly id: string,
  ) {}

  get resource(): LightResource | undefined {
    return this.read();
  }

  get name(): string {
    return this.resource?.metadata?.name ?? '';
  }

  get isOn(): boolean | null {
    return this.resource?.on?.on ?? null;
  }

  get brightness(): number | null {
    return this.resource?.dimming?.brightness ?? null;
  }

  snapshot(): LightSnapshot | undefined {
    const r = this.resource;
    return r ? lightSnapshot(r) : undefined;
  }

  /** Sends a friendly command (on/off, brightness, colour, temperature, transition). */
  async set(command: LightCommand): Promise<void> {
    await this.client.update('light', this.id, buildLightUpdate(command, this.resource));
  }

  turnOn(command: Omit<LightCommand, 'on'> = {}): Promise<void> {
    return this.set({ ...command, on: true });
  }

  turnOff(transitionMs?: number): Promise<void> {
    return this.set(transitionMs === undefined ? { on: false } : { on: false, transitionMs });
  }

  /** Makes the light breathe once so a human can find it. */
  identify(): Promise<void> {
    return this.set({ alert: true });
  }

  /** Raw CLIP update for anything the friendly command does not cover (effects, gradients, ...). */
  async update(body: LightUpdate): Promise<void> {
    await this.client.update('light', this.id, body);
  }
}
