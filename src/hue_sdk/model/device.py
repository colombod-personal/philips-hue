"""Device-centric view: a physical Hue device (bulb, plug, motion sensor,
dimmer switch, the bridge itself) with its services resolved."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from ..types import Resource
from .index_store import ResourceIndex
from .light import HueLight, light_snapshot
from .sensor import is_sensor_type, sensor_snapshot
from .snapshot import BatteryState, DeviceKind, DeviceSnapshot, GroupRef, ProductInfo, SensorSnapshot

if TYPE_CHECKING:
    from ..client import HueClient

_SENSOR_KIND_TYPES = {"motion", "temperature", "light_level", "contact", "tamper", "camera_motion"}


def classify_device(resource: Resource | None, services: list[str]) -> DeviceKind:
    if resource is None:
        return "other"
    archetype = str((resource.get("product_data") or {}).get("product_archetype") or (resource.get("metadata") or {}).get("archetype") or "")
    if "bridge" in services or archetype.startswith("bridge"):
        return "bridge"
    if "light" in services:
        return "plug" if archetype == "plug" else "light"
    if {"button", "relative_rotary", "bell_button"} & set(services):
        return "switch"
    if _SENSOR_KIND_TYPES & set(services):
        return "sensor"
    if "entertainment" in services:
        return "entertainment"
    return "other"


class HueDevice:
    def __init__(self, client: HueClient, index: ResourceIndex, device_id: str, locate: Callable[[str], tuple[GroupRef | None, list[GroupRef]]]) -> None:
        self._client = client
        self._index = index
        self._locate = locate
        self.id = device_id

    @property
    def resource(self) -> Resource | None:
        return self._index.get("device", self.id)

    @property
    def name(self) -> str:
        return str(((self.resource or {}).get("metadata") or {}).get("name", ""))

    @property
    def model_id(self) -> str | None:
        return ((self.resource or {}).get("product_data") or {}).get("model_id")

    @property
    def kind(self) -> DeviceKind:
        return classify_device(self.resource, self.service_types())

    def service_types(self) -> list[str]:
        """Types of the services this device exposes."""
        return list(dict.fromkeys(str(s.get("rtype")) for s in (self.resource or {}).get("services", [])))

    def services(self) -> list[Resource]:
        """Resolved service resources (only those present in the index)."""
        out: list[Resource] = []
        for ref in (self.resource or {}).get("services", []):
            r = self._index.resolve(ref)
            if r is not None:
                out.append(r)
        return out

    def service(self, rtype: str) -> list[Resource]:
        return [s for s in self.services() if s.get("type") == rtype]

    @property
    def lights(self) -> list[HueLight]:
        return [self._light_view(str(s["id"])) for s in self.service("light")]

    def _light_view(self, light_id: str) -> HueLight:
        return HueLight(self._client, lambda: self._index.get("light", light_id), light_id)

    def sensors(self) -> list[SensorSnapshot]:
        """Normalised sensor readings for every sensor-like service on the device."""
        out: list[SensorSnapshot] = []
        for s in self.services():
            if is_sensor_type(str(s.get("type"))):
                snap = sensor_snapshot(s)
                if snap is not None:
                    out.append(snap)
        return out

    def sensor(self, rtype: str) -> SensorSnapshot | None:
        return next((s for s in self.sensors() if s.type == rtype), None)

    @property
    def connectivity(self) -> str | None:
        for s in self.services():
            if s.get("type") in ("zigbee_connectivity", "zgp_connectivity", "zigbee_bridge_connectivity"):
                return s.get("status")
        return None

    @property
    def battery(self) -> BatteryState | None:
        for s in self.services():
            if s.get("type") == "device_power":
                power = s.get("power_state") or {}
                return BatteryState(level=power.get("battery_level"), state=power.get("battery_state"))
        return None

    @property
    def room(self) -> GroupRef | None:
        return self._locate(self.id)[0]

    @property
    def zones(self) -> list[GroupRef]:
        return self._locate(self.id)[1]

    def identify(self) -> None:
        """Blinks the device's lights (or triggers the device identify action)."""
        lights = self.lights
        if lights:
            for light in lights:
                light.identify()
            return
        self._client.update("device", self.id, {"identify": {"action": "identify"}})

    def rename(self, name: str) -> None:
        self._client.update("device", self.id, {"metadata": {"name": name}})

    def snapshot(self) -> DeviceSnapshot:
        r = self.resource or {}
        product: dict[str, Any] = r.get("product_data") or {}
        room, zones = self._locate(self.id)
        return DeviceSnapshot(
            id=self.id,
            name=self.name,
            kind=self.kind,
            id_v1=r.get("id_v1"),
            product=ProductInfo(
                model_id=product.get("model_id"),
                manufacturer=product.get("manufacturer_name"),
                product_name=product.get("product_name"),
                archetype=product.get("product_archetype") or (r.get("metadata") or {}).get("archetype"),
                software_version=product.get("software_version"),
                certified=product.get("certified"),
            ),
            room=room,
            zones=zones,
            services=self.service_types(),
            connectivity=self.connectivity,
            battery=self.battery,
            lights=[light_snapshot(s) for s in self.service("light")],
            sensors=self.sensors(),
        )

    def to_dict(self) -> dict[str, Any]:
        return self.snapshot().to_dict()

    def __repr__(self) -> str:
        return f"HueDevice(id={self.id!r}, name={self.name!r}, kind={self.kind!r})"
