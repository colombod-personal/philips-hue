"""Light control over a ``light`` (or ``grouped_light``) resource."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..color import GAMUT_C, RGB, clamp, kelvin_to_mirek, mirek_to_kelvin, parse_hex_color, rgb_to_xy, xy_to_rgb
from ..types import XY, Resource
from .snapshot import ColorState, ColorTemperatureState, LightCapabilities, LightSnapshot

if TYPE_CHECKING:
    from ..client import HueClient


@dataclass(slots=True)
class LightCommand:
    """A friendly light command. Only set fields are sent."""

    on: bool | None = None
    #: 0-100. Implies ``on`` unless ``on`` is given.
    brightness: float | None = None
    #: ``#rrggbb``
    hex: str | None = None
    rgb: RGB | None = None
    xy: XY | None = None
    #: Colour temperature in kelvin (2000-6500).
    kelvin: float | None = None
    #: Colour temperature in mirek (153-500).
    mirek: float | None = None
    #: Transition duration in ms.
    transition_ms: float | None = None
    #: Make the light breathe once (visual identification).
    alert: bool = False

    def is_empty(self) -> bool:
        return all(v is None for v in (self.on, self.brightness, self.hex, self.rgb, self.xy, self.kelvin, self.mirek, self.transition_ms)) and not self.alert


def build_light_update(command: LightCommand, resource: Resource | None = None) -> dict[str, Any]:
    """Translates a :class:`LightCommand` into a CLIP ``light`` PUT body."""
    body: dict[str, Any] = {}
    if command.on is not None:
        body["on"] = {"on": command.on}
    if command.brightness is not None:
        body["dimming"] = {"brightness": clamp(command.brightness, 0, 100)}
    gamut = (resource or {}).get("color", {}).get("gamut") if resource else None
    if command.xy is not None:
        body["color"] = {"xy": command.xy}
    elif command.rgb is not None or command.hex is not None:
        rgb = command.rgb if command.rgb is not None else parse_hex_color(command.hex or "")
        body["color"] = {"xy": rgb_to_xy(rgb, gamut or GAMUT_C)[0]}
    if command.mirek is not None or command.kelvin is not None:
        mirek = command.mirek if command.mirek is not None else kelvin_to_mirek(command.kelvin or 4000)
        schema = ((resource or {}).get("color_temperature") or {}).get("mirek_schema") or {}
        body["color_temperature"] = {"mirek": int(clamp(mirek, schema.get("mirek_minimum", 153), schema.get("mirek_maximum", 500)))}
    if ("color" in body or "color_temperature" in body or "dimming" in body) and command.on is None:
        body["on"] = {"on": True}
    if command.transition_ms is not None:
        body["dynamics"] = {"duration": max(0, round(command.transition_ms))}
    if command.alert:
        body["alert"] = {"action": "breathe"}
    return body


def light_snapshot(r: Resource) -> LightSnapshot:
    gamut = (r.get("color") or {}).get("gamut") or GAMUT_C
    brightness = (r.get("dimming") or {}).get("brightness")
    ct = r.get("color_temperature")
    color = r.get("color")
    ct_state: ColorTemperatureState | None = None
    if isinstance(ct, dict):
        mirek = ct.get("mirek") if ct.get("mirek_valid", True) else None
        schema = ct.get("mirek_schema") or {}
        ct_state = ColorTemperatureState(
            mirek=mirek,
            kelvin=mirek_to_kelvin(mirek) if mirek else None,
            min_mirek=schema.get("mirek_minimum"),
            max_mirek=schema.get("mirek_maximum"),
        )
    color_state: ColorState | None = None
    if isinstance(color, dict) and isinstance(color.get("xy"), dict):
        color_state = ColorState(
            xy=color["xy"],
            hex=xy_to_rgb(color["xy"], brightness if brightness is not None else 100, gamut).to_hex(),
            gamut_type=color.get("gamut_type"),
        )
    metadata = r.get("metadata") or {}
    return LightSnapshot(
        id=r["id"],
        name=metadata.get("name", ""),
        on=(r.get("on") or {}).get("on"),
        brightness=brightness,
        color_temperature=ct_state,
        color=color_state,
        capabilities=LightCapabilities(
            dimming="dimming" in r,
            color_temperature="color_temperature" in r,
            color="color" in r,
            effects="effects" in r or "effects_v2" in r,
            gradient="gradient" in r,
        ),
        mode=r.get("mode"),
        archetype=metadata.get("archetype"),
        function=metadata.get("function"),
    )


class HueLight:
    """Live view over a ``light`` resource."""

    def __init__(self, client: HueClient, read: Callable[[], Resource | None], light_id: str) -> None:
        self._client = client
        self._read = read
        self.id = light_id

    @property
    def resource(self) -> Resource | None:
        return self._read()

    @property
    def name(self) -> str:
        return str(((self.resource or {}).get("metadata") or {}).get("name", ""))

    @property
    def is_on(self) -> bool | None:
        return ((self.resource or {}).get("on") or {}).get("on")

    @property
    def brightness(self) -> float | None:
        return ((self.resource or {}).get("dimming") or {}).get("brightness")

    def snapshot(self) -> LightSnapshot | None:
        r = self.resource
        return light_snapshot(r) if r is not None else None

    def set(self, command: LightCommand | None = None, **kwargs: Any) -> None:
        """Sends a friendly command: ``light.set(on=True, brightness=40, kelvin=2700)``."""
        cmd = command if command is not None else LightCommand(**kwargs)
        self._client.update("light", self.id, build_light_update(cmd, self.resource))

    def turn_on(self, **kwargs: Any) -> None:
        self.set(LightCommand(on=True, **kwargs))

    def turn_off(self, transition_ms: float | None = None) -> None:
        self.set(LightCommand(on=False, transition_ms=transition_ms))

    def identify(self) -> None:
        """Makes the light breathe once so a human can find it."""
        self.set(LightCommand(alert=True))

    def update(self, body: dict[str, Any]) -> None:
        """Raw CLIP update for anything the friendly command does not cover (effects, gradients, ...)."""
        self._client.update("light", self.id, body)

    def __repr__(self) -> str:
        return f"HueLight(id={self.id!r}, name={self.name!r}, on={self.is_on!r}, brightness={self.brightness!r})"
