"""In-memory index of bridge resources keyed by type and id, updated from full
fetches and from event-stream deltas. Thread-safe: the event stream writes
from its own thread while callers read."""

from __future__ import annotations

import builtins
import copy
import threading
from typing import Any

from ..types import HueEvent, Resource, ResourceIdentifier


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Recursively merges ``patch`` into a copy of ``base``; lists and scalars are replaced."""
    out = dict(base)
    for key, value in patch.items():
        current = out.get(key)
        if isinstance(value, dict) and isinstance(current, dict):
            out[key] = deep_merge(current, value)
        else:
            out[key] = value
    return out


class ResourceIndex:
    def __init__(self) -> None:
        self._by_type: dict[str, dict[str, Resource]] = {}
        self._owner: dict[str, set[tuple[str, str]]] = {}
        self._lock = threading.RLock()

    def clear(self) -> None:
        with self._lock:
            self._by_type.clear()
            self._owner.clear()

    def replace_all(self, resources: builtins.list[Resource]) -> None:
        with self._lock:
            self.clear()
            for r in resources:
                self.set(r)

    def set(self, resource: Resource) -> None:
        with self._lock:
            bucket = self._by_type.setdefault(resource["type"], {})
            bucket[resource["id"]] = resource
            owner = resource.get("owner")
            if isinstance(owner, dict) and "rid" in owner:
                self._owner.setdefault(owner["rid"], set()).add((resource["type"], resource["id"]))

    def delete(self, rtype: str, rid: str) -> Resource | None:
        with self._lock:
            existing = self._by_type.get(rtype, {}).pop(rid, None)
            if existing is None:
                return None
            owner = existing.get("owner")
            if isinstance(owner, dict) and owner.get("rid") in self._owner:
                self._owner[owner["rid"]].discard((rtype, rid))
            return existing

    def get(self, rtype: str, rid: str) -> Resource | None:
        with self._lock:
            return self._by_type.get(rtype, {}).get(rid)

    def resolve(self, ref: ResourceIdentifier | dict[str, Any]) -> Resource | None:
        return self.get(str(ref.get("rtype")), str(ref.get("rid")))

    def list(self, rtype: str) -> builtins.list[Resource]:
        with self._lock:
            return list(self._by_type.get(rtype, {}).values())

    def all(self) -> builtins.list[Resource]:
        with self._lock:
            return [r for bucket in self._by_type.values() for r in bucket.values()]

    def owned_by(self, rid: str) -> builtins.list[Resource]:
        """Every resource whose ``owner`` is the given rid (a device's services, usually)."""
        with self._lock:
            out: builtins.list[Resource] = []
            for rtype, rid2 in self._owner.get(rid, ()):
                r = self._by_type.get(rtype, {}).get(rid2)
                if r is not None:
                    out.append(r)
            return out

    def apply(self, event: HueEvent) -> builtins.list[Resource]:
        """Applies an event. Returns the resources touched (post-merge)."""
        touched: builtins.list[Resource] = []
        with self._lock:
            for partial in event.get("data", []):
                if not isinstance(partial, dict) or not isinstance(partial.get("id"), str) or not isinstance(partial.get("type"), str):
                    continue
                if event.get("type") == "delete":
                    removed = self.delete(partial["type"], partial["id"])
                    if removed is not None:
                        touched.append(removed)
                    continue
                existing = self.get(partial["type"], partial["id"])
                merged = deep_merge(existing, partial) if existing is not None else copy.deepcopy(partial)
                self.set(merged)
                touched.append(merged)
        return touched
