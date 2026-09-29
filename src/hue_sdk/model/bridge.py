"""``HueBridge``: the aggregate root. Loads every resource once, exposes
devices / rooms / zones / scenes as live views over an in-memory index, and
keeps that index current through the event stream when ``watch()`` is called.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ..client import HueClient
from ..errors import HueError
from ..events import Emitter, HueEventStream
from ..pairing import BridgeCredentials
from ..tls import TlsOptions
from ..types import HueEvent, Resource
from .device import HueDevice
from .group import HueGroup, HueScene
from .index_store import ResourceIndex
from .light import HueLight
from .sensor import is_sensor_type
from .snapshot import BridgeInfo, DeviceKind, GroupRef, HomeSnapshot, SensorSnapshot


@dataclass(slots=True)
class ChangeEvent:
    event: HueEvent
    #: Resources touched by the event (merged state).
    resources: list[Resource]
    #: Devices whose services were touched.
    devices: list[HueDevice] = field(default_factory=list)


class HueBridge(Emitter):
    """Device-centric view of one bridge.

    Callbacks (``bridge.on(name, fn)``): ``change(ChangeEvent)``,
    ``sensor(SensorSnapshot, HueDevice)``, ``connected(dict)``,
    ``disconnected(HueError | None)``, ``error(HueError)``.
    """

    def __init__(self, client: HueClient) -> None:
        super().__init__()
        self.client = client
        self.index = ResourceIndex()
        self._stream: HueEventStream | None = None
        self._loaded_at: datetime | None = None

    @classmethod
    def connect(cls, creds: BridgeCredentials, *, tls: TlsOptions | None = None, **client_kwargs: Any) -> HueBridge:
        """Creates a bridge from credentials and loads all resources."""
        bridge = cls(HueClient.from_credentials(creds, tls=tls, **client_kwargs))
        bridge.refresh()
        return bridge

    @property
    def host(self) -> str:
        return self.client.host

    @property
    def is_loaded(self) -> bool:
        return self._loaded_at is not None

    @property
    def info(self) -> Resource | None:
        """The bridge's own ``bridge`` resource."""
        items = self.index.list("bridge")
        return items[0] if items else None

    def refresh(self) -> None:
        """Re-fetches every resource from the bridge."""
        self.index.replace_all(self.client.list_all())
        self._loaded_at = datetime.now(UTC)

    # ---------- devices ----------

    @property
    def devices(self) -> list[HueDevice]:
        return [self._device_view(str(d["id"])) for d in self.index.list("device")]

    def device(self, device_id: str) -> HueDevice | None:
        return self._device_view(device_id) if self.index.get("device", device_id) else None

    def device_for_service(self, rid: str) -> HueDevice | None:
        """Finds the device that owns a service (e.g. a light or motion resource id)."""
        for r in self.index.all():
            if r.get("id") == rid:
                owner = r.get("owner")
                if isinstance(owner, dict) and owner.get("rtype") == "device":
                    return self.device(str(owner["rid"]))
        return None

    def find_devices(
        self,
        *,
        name: str | None = None,
        room: str | None = None,
        zone: str | None = None,
        kind: DeviceKind | list[DeviceKind] | None = None,
        service: str | None = None,
        model_id: str | None = None,
    ) -> list[HueDevice]:
        """Filters devices. ``name`` is a case-insensitive substring; ``room``/``zone`` accept a name or id."""
        kinds = None if kind is None else ([kind] if isinstance(kind, str) else list(kind))
        room_group = self._match_group(self.rooms, room) if room else None
        zone_group = self._match_group(self.zones, zone) if zone else None
        if (room and room_group is None) or (zone and zone_group is None):
            return []
        room_ids = set(room_group.device_ids()) if room_group else None
        zone_ids = set(zone_group.device_ids()) if zone_group else None
        lower = name.lower() if name else None
        out: list[HueDevice] = []
        for d in self.devices:
            if lower and lower not in d.name.lower():
                continue
            if kinds and d.kind not in kinds:
                continue
            if service and service not in d.service_types():
                continue
            if model_id and (d.model_id or "").lower() != model_id.lower():
                continue
            if room_ids is not None and d.id not in room_ids:
                continue
            if zone_ids is not None and d.id not in zone_ids:
                continue
            out.append(d)
        return out

    def resolve_device(self, id_or_name: str) -> HueDevice | None:
        """One device by id, exact name, or unique partial name (case-insensitive)."""
        by_id = self.device(id_or_name)
        if by_id is not None:
            return by_id
        lower = id_or_name.lower()
        devices = self.devices
        exact = [d for d in devices if d.name.lower() == lower]
        if len(exact) == 1:
            return exact[0]
        partial = [d for d in devices if lower in d.name.lower()]
        return partial[0] if len(partial) == 1 else None

    # ---------- lights ----------

    @property
    def lights(self) -> list[HueLight]:
        return [self._light_view(str(r["id"])) for r in self.index.list("light")]

    def light(self, light_id: str) -> HueLight | None:
        return self._light_view(light_id) if self.index.get("light", light_id) else None

    def resolve_light(self, id_or_name: str) -> HueLight | None:
        """One light by id, exact/unique name, or by its device's name."""
        by_id = self.light(id_or_name)
        if by_id is not None:
            return by_id
        lower = id_or_name.lower()
        lights = self.lights
        exact = [x for x in lights if x.name.lower() == lower]
        if len(exact) == 1:
            return exact[0]
        partial = [x for x in lights if lower in x.name.lower()]
        if len(partial) == 1:
            return partial[0]
        device = self.resolve_device(id_or_name)
        if device is not None and len(device.lights) == 1:
            return device.lights[0]
        return None

    # ---------- sensors ----------

    def sensors(self, rtype: str | None = None) -> list[tuple[HueDevice, SensorSnapshot]]:
        """Every sensor reading on the bridge with its owning device, optionally filtered by type."""
        return [(d, s) for d in self.devices for s in d.sensors() if rtype is None or s.type == rtype]

    # ---------- groups & scenes ----------

    @property
    def rooms(self) -> list[HueGroup]:
        return [HueGroup(self.client, self.index, "room", str(r["id"])) for r in self.index.list("room")]

    @property
    def zones(self) -> list[HueGroup]:
        return [HueGroup(self.client, self.index, "zone", str(z["id"])) for z in self.index.list("zone")]

    @property
    def home(self) -> HueGroup | None:
        items = self.index.list("bridge_home")
        return HueGroup(self.client, self.index, "bridge_home", str(items[0]["id"])) if items else None

    def group(self, id_or_name: str) -> HueGroup | None:
        return self._match_group([*self.rooms, *self.zones], id_or_name)

    @property
    def scenes(self) -> list[HueScene]:
        return [HueScene(self.client, self.index, str(s["id"])) for s in self.index.list("scene")]

    def scene(self, id_or_name: str, group: str | None = None) -> HueScene | None:
        """A scene by id or name, optionally within a room/zone (names repeat across rooms)."""
        g = self.group(group) if group else None
        if group and g is None:
            return None
        pool = g.scenes if g else self.scenes
        lower = id_or_name.lower()
        return next((s for s in pool if s.id == id_or_name), None) or next((s for s in pool if s.name.lower() == lower), None)

    # ---------- snapshots ----------

    def snapshot(self) -> HomeSnapshot:
        info = self.info
        bridge_device = self.device_for_service(str(info["id"])) if info else None
        return HomeSnapshot(
            bridge=BridgeInfo(
                id=str(info.get("bridge_id", "")).lower() if info and info.get("bridge_id") else self.client.bridge_id,
                name=bridge_device.name if bridge_device else None,
                model_id=bridge_device.model_id if bridge_device else None,
                software_version=((bridge_device.resource or {}).get("product_data") or {}).get("software_version") if bridge_device else None,
                host=self.host,
            ),
            captured_at=datetime.now(UTC).isoformat(),
            devices=[d.snapshot() for d in self.devices],
            rooms=[r.snapshot() for r in self.rooms],
            zones=[z.snapshot() for z in self.zones],
            scenes=[s.snapshot() for s in self.scenes],
        )

    def to_dict(self) -> dict[str, Any]:
        return self.snapshot().to_dict()

    # ---------- live updates ----------

    def watch(self, **options: Any) -> HueEventStream:
        """Subscribes to the event stream and keeps the model current. Emits ``change``, ``sensor``,
        ``connected``, ``disconnected``, ``error``. Returns the underlying stream."""
        if self._stream is not None:
            return self._stream
        stream = self.client.events(**options)
        self._stream = stream
        stream.on("event", self._on_event)
        stream.on("connected", self._on_connected)
        stream.on("disconnected", lambda err: self.emit("disconnected", err))
        stream.on("error", lambda err: self.emit("error", err))
        stream.start()
        return stream

    def _on_event(self, event: HueEvent) -> None:
        resources = self.index.apply(event)
        devices: dict[str, HueDevice] = {}
        for r in resources:
            owner = r.get("owner")
            owner_id = owner["rid"] if isinstance(owner, dict) and owner.get("rtype") == "device" else (r["id"] if r.get("type") == "device" else None)
            if owner_id and owner_id not in devices:
                d = self.device(str(owner_id))
                if d is not None:
                    devices[str(owner_id)] = d
        self.emit("change", ChangeEvent(event=event, resources=resources, devices=list(devices.values())))
        if event.get("type") == "update":
            for r in resources:
                owner = r.get("owner")
                if not is_sensor_type(str(r.get("type"))) or not (isinstance(owner, dict) and owner.get("rtype") == "device"):
                    continue
                device = devices.get(str(owner["rid"]))
                reading = next((s for s in device.sensors() if s.id == r["id"]), None) if device else None
                if device is not None and reading is not None:
                    self.emit("sensor", reading, device)

    def _on_connected(self, info: dict[str, Any]) -> None:
        self.emit("connected", info)
        if info.get("reconnect"):
            try:
                self.refresh()
            except HueError as err:
                self.emit("error", err)

    def close(self) -> None:
        """Stops watching (if active) and releases sockets."""
        if self._stream is not None:
            self._stream.stop()
            self._stream = None
        self.client.close()

    def __enter__(self) -> HueBridge:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---------- internals ----------

    def _device_view(self, device_id: str) -> HueDevice:
        return HueDevice(self.client, self.index, device_id, self._locate)

    def _light_view(self, light_id: str) -> HueLight:
        return HueLight(self.client, lambda: self.index.get("light", light_id), light_id)

    def _locate(self, device_id: str) -> tuple[GroupRef | None, list[GroupRef]]:
        room: GroupRef | None = None
        for r in self.index.list("room"):
            if any(c.get("rtype") == "device" and c.get("rid") == device_id for c in r.get("children", [])):
                room = GroupRef(id=str(r["id"]), name=str((r.get("metadata") or {}).get("name", "")), type="room")
                break
        light_ids = {str(s["rid"]) for s in (self.index.get("device", device_id) or {}).get("services", []) if s.get("rtype") == "light"}
        zones: list[GroupRef] = []
        for z in self.index.list("zone"):
            children = z.get("children", [])
            if any((c.get("rtype") == "device" and c.get("rid") == device_id) or (c.get("rtype") == "light" and c.get("rid") in light_ids) for c in children):
                zones.append(GroupRef(id=str(z["id"]), name=str((z.get("metadata") or {}).get("name", "")), type="zone"))
        return room, zones

    @staticmethod
    def _match_group(groups: list[HueGroup], id_or_name: str) -> HueGroup | None:
        lower = id_or_name.lower()
        return next((g for g in groups if g.id == id_or_name or g.name.lower() == lower), None)
