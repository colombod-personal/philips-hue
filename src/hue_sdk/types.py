"""CLIP v2 shapes.

Resources are kept as plain ``dict`` objects on purpose: the bridge adds fields
over firmware releases and a permissive representation preserves them. The
``TypedDict``s below document the well-known keys for editors and type
checkers without rejecting unknown ones (all are ``total=False``).
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

Resource = dict[str, Any]
"""A CLIP v2 resource: always has ``id`` and ``type``; usually ``owner``."""

ResourceType = str

SENSOR_SERVICE_TYPES: frozenset[str] = frozenset(
    {
        "motion",
        "temperature",
        "light_level",
        "contact",
        "tamper",
        "camera_motion",
        "device_power",
        "button",
        "relative_rotary",
        "bell_button",
        "grouped_motion",
        "grouped_light_level",
        "convenience_area_motion",
        "security_area_motion",
    }
)
"""Service types that carry sensor readings (read-only state)."""

GROUP_TYPES: frozenset[str] = frozenset({"room", "zone", "bridge_home"})


class ResourceIdentifier(TypedDict):
    rid: str
    rtype: str


class XY(TypedDict):
    x: float
    y: float


class Gamut(TypedDict):
    red: XY
    green: XY
    blue: XY


class BridgeConfig(TypedDict, total=False):
    """Unauthenticated ``GET /api/0/config`` payload."""

    name: str
    datastoreversion: str
    swversion: str
    apiversion: str
    mac: str
    bridgeid: str
    factorynew: bool
    replacesbridgeid: str | None
    modelid: str
    starterkitid: str


HueEventType = Literal["update", "add", "delete", "error"]


class HueEvent(TypedDict):
    id: str
    creationtime: str
    type: str
    data: list[Resource]


class ClipResponse(TypedDict, total=False):
    errors: list[dict[str, Any]]
    data: list[Resource]
