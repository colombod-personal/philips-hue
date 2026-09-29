/**
 * Rooms, zones and scenes.
 */

import type { HueClient } from '../client.js';
import type { GroupedLightResource, GroupResource, SceneResource } from '../types.js';
import type { ResourceIndex } from './index-store.js';
import { buildLightUpdate, type LightCommand } from './light.js';
import type { GroupSnapshot, SceneSnapshot } from './snapshot.js';

export class HueScene {
  constructor(
    private readonly client: HueClient,
    private readonly index: ResourceIndex,
    readonly id: string,
  ) {}

  get resource(): SceneResource | undefined {
    return this.index.get('scene', this.id);
  }

  get name(): string {
    return this.resource?.metadata?.name ?? '';
  }

  get groupId(): string | undefined {
    return this.resource?.group?.rid;
  }

  /** Recalls the scene. `dynamic` starts the scene's dynamic palette when it has one. */
  async activate(options: { dynamic?: boolean; transitionMs?: number } = {}): Promise<void> {
    const recall: Record<string, unknown> = { action: options.dynamic ? 'dynamic_palette' : 'active' };
    if (options.transitionMs !== undefined) recall['duration'] = Math.round(options.transitionMs);
    await this.client.update('scene', this.id, { recall });
  }

  snapshot(): SceneSnapshot {
    const r = this.resource;
    return {
      id: this.id,
      name: this.name,
      groupId: r?.group?.rid ?? '',
      groupType: (r?.group?.rtype as 'room' | 'zone') ?? 'room',
      active: r?.status?.active ?? null,
    };
  }

  toJSON(): SceneSnapshot {
    return this.snapshot();
  }
}

/** A room, zone or the bridge home group. */
export class HueGroup {
  constructor(
    private readonly client: HueClient,
    private readonly index: ResourceIndex,
    readonly type: 'room' | 'zone' | 'bridge_home',
    readonly id: string,
  ) {}

  get resource(): GroupResource | undefined {
    return this.index.get(this.type, this.id) as GroupResource | undefined;
  }

  get name(): string {
    return this.resource?.metadata?.name ?? (this.type === 'bridge_home' ? 'Home' : '');
  }

  /**
   * Device ids in this group. Rooms list devices directly; zones list light
   * services, which are resolved to their owning device.
   */
  deviceIds(): string[] {
    const ids = new Set<string>();
    for (const child of this.resource?.children ?? []) {
      if (child.rtype === 'device') ids.add(child.rid);
      else {
        const owner = this.index.resolve(child)?.owner;
        if (owner?.rtype === 'device') ids.add(owner.rid);
      }
    }
    return [...ids];
  }

  /** Light service ids contained in the group (through its devices or direct children). */
  lightIds(): string[] {
    const ids = new Set<string>();
    for (const child of this.resource?.children ?? []) {
      if (child.rtype === 'light') ids.add(child.rid);
      else if (child.rtype === 'device') {
        for (const s of this.index.get('device', child.rid)?.services ?? []) if (s.rtype === 'light') ids.add(s.rid);
      }
    }
    return [...ids];
  }

  get groupedLight(): GroupedLightResource | undefined {
    const ref = this.resource?.services.find((s) => s.rtype === 'grouped_light');
    return ref ? this.index.get('grouped_light', ref.rid) : undefined;
  }

  get scenes(): HueScene[] {
    return this.index
      .list('scene')
      .filter((s) => s.group?.rid === this.id)
      .map((s) => new HueScene(this.client, this.index, s.id));
  }

  /** Controls every light in the group at once via its grouped_light service. */
  async set(command: LightCommand): Promise<void> {
    const gl = this.groupedLight;
    if (!gl) throw new Error(`${this.type} ${this.name || this.id} has no grouped_light service.`);
    await this.client.update('grouped_light', gl.id, buildLightUpdate(command, gl));
  }

  turnOn(command: Omit<LightCommand, 'on'> = {}): Promise<void> {
    return this.set({ ...command, on: true });
  }

  turnOff(transitionMs?: number): Promise<void> {
    return this.set(transitionMs === undefined ? { on: false } : { on: false, transitionMs });
  }

  async activateScene(nameOrId: string, options: { dynamic?: boolean; transitionMs?: number } = {}): Promise<HueScene> {
    const scene = this.scenes.find((s) => s.id === nameOrId) ?? this.scenes.find((s) => s.name.toLowerCase() === nameOrId.toLowerCase());
    if (!scene) throw new Error(`Scene "${nameOrId}" not found in ${this.type} ${this.name || this.id}.`);
    await scene.activate(options);
    return scene;
  }

  snapshot(): GroupSnapshot {
    const gl = this.groupedLight;
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      archetype: this.resource?.metadata?.archetype ?? null,
      deviceIds: this.deviceIds(),
      light: gl ? { id: gl.id, on: gl.on?.on ?? null, brightness: gl.dimming?.brightness ?? null } : null,
      sceneIds: this.scenes.map((s) => s.id),
    };
  }

  toJSON(): GroupSnapshot {
    return this.snapshot();
  }
}
