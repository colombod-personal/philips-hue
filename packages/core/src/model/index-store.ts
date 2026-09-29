/**
 * In-memory index of bridge resources, keyed by type and id. Updated from
 * full fetches and from event-stream deltas.
 */

import type { BaseResource, HueEvent, ResourceIdentifier, ResourceOf, ResourceType } from '../types.js';

export class ResourceIndex {
  private readonly byType = new Map<string, Map<string, BaseResource>>();
  private readonly ownerIndex = new Map<string, Set<string>>(); // owner rid -> "type:id"

  clear(): void {
    this.byType.clear();
    this.ownerIndex.clear();
  }

  replaceAll(resources: BaseResource[]): void {
    this.clear();
    for (const r of resources) this.set(r);
  }

  set(resource: BaseResource): void {
    let bucket = this.byType.get(resource.type);
    if (!bucket) {
      bucket = new Map();
      this.byType.set(resource.type, bucket);
    }
    bucket.set(resource.id, resource);
    const owner = resource.owner?.rid;
    if (owner) {
      let set = this.ownerIndex.get(owner);
      if (!set) {
        set = new Set();
        this.ownerIndex.set(owner, set);
      }
      set.add(`${resource.type}:${resource.id}`);
    }
  }

  delete(type: string, id: string): BaseResource | undefined {
    const bucket = this.byType.get(type);
    const existing = bucket?.get(id);
    if (!bucket || !existing) return undefined;
    bucket.delete(id);
    const owner = existing.owner?.rid;
    if (owner) this.ownerIndex.get(owner)?.delete(`${type}:${id}`);
    return existing;
  }

  get<T extends ResourceType>(type: T, id: string): ResourceOf<T> | undefined {
    return this.byType.get(type)?.get(id) as ResourceOf<T> | undefined;
  }

  resolve<T extends ResourceType>(ref: ResourceIdentifier<T> | ResourceIdentifier): ResourceOf<T> | undefined {
    return this.get(ref.rtype as T, ref.rid);
  }

  list<T extends ResourceType>(type: T): ResourceOf<T>[] {
    return [...(this.byType.get(type)?.values() ?? [])] as ResourceOf<T>[];
  }

  all(): BaseResource[] {
    const out: BaseResource[] = [];
    for (const bucket of this.byType.values()) out.push(...bucket.values());
    return out;
  }

  /** Every resource whose `owner` is the given rid (a device's services, usually). */
  ownedBy(rid: string): BaseResource[] {
    const keys = this.ownerIndex.get(rid);
    if (!keys) return [];
    const out: BaseResource[] = [];
    for (const key of keys) {
      const sep = key.indexOf(':');
      const r = this.byType.get(key.slice(0, sep))?.get(key.slice(sep + 1));
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Applies an event. Returns the resources touched (post-merge) so callers
   * can map them back to devices.
   */
  apply(event: HueEvent): BaseResource[] {
    const touched: BaseResource[] = [];
    for (const partial of event.data) {
      if (!partial || typeof partial.id !== 'string' || typeof partial.type !== 'string') continue;
      if (event.type === 'delete') {
        const removed = this.delete(partial.type, partial.id);
        if (removed) touched.push(removed);
        continue;
      }
      const existing = this.get(partial.type, partial.id);
      const merged = existing ? deepMerge(existing, partial) : (partial as BaseResource);
      this.set(merged);
      touched.push(merged);
    }
    return touched;
  }
}

/** Recursively merges `patch` into a copy of `base`; arrays and primitives are replaced. */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) out[key] = deepMerge(current, value);
    else out[key] = value;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
