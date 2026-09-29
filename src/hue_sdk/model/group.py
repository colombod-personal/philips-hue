"""Rooms, zones and scenes."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from ..errors import HueError
from ..types import Resource
from .index_store import ResourceIndex
from .light import LightCommand, build_light_update
from .snapshot import GroupLightState, GroupSnapshot, SceneSnapshot

if TYPE_CHECKING:
    from ..client import HueClient


class HueScene:
    def __init__(self, client: HueClient, index: ResourceIndex, scene_id: str) -> None:
        self._client = client
        self._index = index
        self.id = scene_id

    @property
    def resource(self) -> Resource | None:
        return self._index.get("scene", self.id)

    @property
    def name(self) -> str:
        return str(((self.resource or {}).get("metadata") or {}).get("name", ""))

    @property
    def group_id(self) -> str | None:
        return ((self.resource or {}).get("group") or {}).get("rid")

    def activate(self, *, dynamic: bool = False, transition_ms: float | None = None) -> None:
        """Recalls the scene. ``dynamic`` starts the scene's dynamic palette when it has one."""
        recall: dict[str, Any] = {"action": "dynamic_palette" if dynamic else "active"}
        if transition_ms is not None:
            recall["duration"] = round(transition_ms)
        self._client.update("scene", self.id, {"recall": recall})

    def snapshot(self) -> SceneSnapshot:
        r = self.resource or {}
        group = r.get("group") or {}
        return SceneSnapshot(
            id=self.id,
            name=self.name,
            group_id=str(group.get("rid", "")),
            group_type=str(group.get("rtype", "room")),
            active=(r.get("status") or {}).get("active"),
        )

    def to_dict(self) -> dict[str, Any]:
        return self.snapshot().to_dict()

    def __repr__(self) -> str:
        return f"HueScene(id={self.id!r}, name={self.name!r})"


class HueGroup:
    """A room, zone or the bridge home group."""

    def __init__(self, client: HueClient, index: ResourceIndex, gtype: Literal["room", "zone", "bridge_home"], group_id: str) -> None:
        self._client = client
        self._index = index
        self.type: Literal["room", "zone", "bridge_home"] = gtype
        self.id = group_id

    @property
    def resource(self) -> Resource | None:
        return self._index.get(self.type, self.id)

    @property
    def name(self) -> str:
        name = ((self.resource or {}).get("metadata") or {}).get("name")
        return str(name) if name else ("Home" if self.type == "bridge_home" else "")

    def device_ids(self) -> list[str]:
        """Devices in this group. Rooms list devices directly; zones list light services, resolved to their device."""
        ids: dict[str, None] = {}
        for child in (self.resource or {}).get("children", []):
            if child.get("rtype") == "device":
                ids[str(child["rid"])] = None
            else:
                owner = (self._index.resolve(child) or {}).get("owner")
                if isinstance(owner, dict) and owner.get("rtype") == "device":
                    ids[str(owner["rid"])] = None
        return list(ids)

    def light_ids(self) -> list[str]:
        ids: dict[str, None] = {}
        for child in (self.resource or {}).get("children", []):
            if child.get("rtype") == "light":
                ids[str(child["rid"])] = None
            elif child.get("rtype") == "device":
                for s in (self._index.get("device", str(child["rid"])) or {}).get("services", []):
                    if s.get("rtype") == "light":
                        ids[str(s["rid"])] = None
        return list(ids)

    @property
    def grouped_light(self) -> Resource | None:
        for s in (self.resource or {}).get("services", []):
            if s.get("rtype") == "grouped_light":
                return self._index.get("grouped_light", str(s["rid"]))
        return None

    @property
    def scenes(self) -> list[HueScene]:
        return [HueScene(self._client, self._index, str(s["id"])) for s in self._index.list("scene") if (s.get("group") or {}).get("rid") == self.id]

    def set(self, command: LightCommand | None = None, **kwargs: Any) -> None:
        """Controls every light in the group at once via its grouped_light service."""
        gl = self.grouped_light
        if gl is None:
            raise HueError("not_found", f"{self.type} {self.name or self.id} has no grouped_light service.")
        cmd = command if command is not None else LightCommand(**kwargs)
        self._client.update("grouped_light", str(gl["id"]), build_light_update(cmd, gl))

    def turn_on(self, **kwargs: Any) -> None:
        self.set(LightCommand(on=True, **kwargs))

    def turn_off(self, transition_ms: float | None = None) -> None:
        self.set(LightCommand(on=False, transition_ms=transition_ms))

    def activate_scene(self, name_or_id: str, *, dynamic: bool = False, transition_ms: float | None = None) -> HueScene:
        lower = name_or_id.lower()
        scene = next((s for s in self.scenes if s.id == name_or_id), None) or next((s for s in self.scenes if s.name.lower() == lower), None)
        if scene is None:
            raise HueError("not_found", f'Scene "{name_or_id}" not found in {self.type} {self.name or self.id}.')
        scene.activate(dynamic=dynamic, transition_ms=transition_ms)
        return scene

    def snapshot(self) -> GroupSnapshot:
        gl = self.grouped_light
        return GroupSnapshot(
            id=self.id,
            name=self.name,
            type=self.type,
            archetype=((self.resource or {}).get("metadata") or {}).get("archetype"),
            device_ids=self.device_ids(),
            light=GroupLightState(id=str(gl["id"]), on=(gl.get("on") or {}).get("on"), brightness=(gl.get("dimming") or {}).get("brightness")) if gl else None,
            scene_ids=[s.id for s in self.scenes],
        )

    def to_dict(self) -> dict[str, Any]:
        return self.snapshot().to_dict()

    def __repr__(self) -> str:
        return f"HueGroup(type={self.type!r}, id={self.id!r}, name={self.name!r})"
