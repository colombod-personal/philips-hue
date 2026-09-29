"""Plain-data snapshots. These are the shapes humans and agents consume:
stable, self-describing dataclasses that serialise to JSON-friendly dicts via
``to_dict()``. Nothing here holds a reference to the bridge."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from ..types import XY

DeviceKind = Literal["bridge", "light", "plug", "sensor", "switch", "entertainment", "other"]
SensorUnit = Literal["boolean", "°C", "lux", "%", "event", "state", "steps", "string"]


class _Dict:
    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = asdict(self)  # type: ignore[call-overload]
        return result


@dataclass(slots=True)
class GroupRef(_Dict):
    id: str
    name: str
    type: Literal["room", "zone"]


@dataclass(slots=True)
class ColorTemperatureState(_Dict):
    mirek: int | None
    kelvin: int | None
    min_mirek: int | None
    max_mirek: int | None


@dataclass(slots=True)
class ColorState(_Dict):
    xy: XY
    hex: str
    gamut_type: str | None


@dataclass(slots=True)
class LightCapabilities(_Dict):
    dimming: bool
    color_temperature: bool
    color: bool
    effects: bool
    gradient: bool


@dataclass(slots=True)
class LightSnapshot(_Dict):
    id: str
    name: str
    on: bool | None
    #: 0-100 when dimmable.
    brightness: float | None
    color_temperature: ColorTemperatureState | None
    color: ColorState | None
    capabilities: LightCapabilities
    #: ``streaming`` while an entertainment session owns the light.
    mode: str | None
    archetype: str | None
    function: str | None


@dataclass(slots=True)
class SensorSnapshot(_Dict):
    id: str
    #: Service type, e.g. ``motion``, ``temperature``, ``light_level``, ``device_power``, ``button``.
    type: str
    #: Normalised reading. ``None`` when the bridge marks it invalid/unknown.
    value: bool | float | str | None
    unit: SensorUnit
    #: ISO timestamp of the last change reported by the bridge.
    changed: str | None
    enabled: bool | None
    #: Extra detail per sensor type (raw light level, battery state, button control id, rotary steps...).
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ProductInfo(_Dict):
    model_id: str | None
    manufacturer: str | None
    product_name: str | None
    archetype: str | None
    software_version: str | None
    certified: bool | None


@dataclass(slots=True)
class BatteryState(_Dict):
    level: float | None
    state: str | None


@dataclass(slots=True)
class DeviceSnapshot(_Dict):
    id: str
    name: str
    kind: DeviceKind
    #: Legacy v1 path (e.g. ``/lights/3``), useful for cross-referencing old integrations.
    id_v1: str | None
    product: ProductInfo
    room: GroupRef | None
    zones: list[GroupRef]
    #: Service types exposed by the device.
    services: list[str]
    connectivity: str | None
    battery: BatteryState | None
    lights: list[LightSnapshot]
    sensors: list[SensorSnapshot]


@dataclass(slots=True)
class GroupLightState(_Dict):
    id: str
    on: bool | None
    brightness: float | None


@dataclass(slots=True)
class GroupSnapshot(_Dict):
    id: str
    name: str
    type: Literal["room", "zone", "bridge_home"]
    archetype: str | None
    device_ids: list[str]
    #: Aggregate light state for the group when it has a grouped_light service.
    light: GroupLightState | None
    scene_ids: list[str]


@dataclass(slots=True)
class SceneSnapshot(_Dict):
    id: str
    name: str
    group_id: str
    group_type: str
    active: str | None


@dataclass(slots=True)
class BridgeInfo(_Dict):
    id: str | None
    name: str | None
    model_id: str | None
    software_version: str | None
    host: str


@dataclass(slots=True)
class HomeSnapshot(_Dict):
    bridge: BridgeInfo
    captured_at: str
    devices: list[DeviceSnapshot]
    rooms: list[GroupSnapshot]
    zones: list[GroupSnapshot]
    scenes: list[SceneSnapshot]
