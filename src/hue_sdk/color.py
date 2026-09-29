"""Colour helpers: CIE 1931 xy <-> sRGB (with gamut clamping) and mirek <-> kelvin.

The xy conversion follows the well-known Hue approach: linearise sRGB,
transform to XYZ with the Wide RGB D65 matrix, normalise to xy, then clamp to
the light's gamut triangle so the bridge never rejects the value.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .types import XY, Gamut

GAMUT_C: Gamut = {"red": {"x": 0.6915, "y": 0.3083}, "green": {"x": 0.17, "y": 0.7}, "blue": {"x": 0.1532, "y": 0.0475}}
"""Default gamut (Hue "C" gamut) used when a light does not report one."""


@dataclass(frozen=True, slots=True)
class RGB:
    r: float
    g: float
    b: float

    def to_hex(self) -> str:
        return "#" + "".join(f"{round(clamp(v, 0, 255)):02x}" for v in (self.r, self.g, self.b))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def parse_hex_color(value: str) -> RGB:
    clean = value.strip().lstrip("#")
    if len(clean) == 3:
        clean = "".join(c * 2 for c in clean)
    if len(clean) != 6 or any(c not in "0123456789abcdefABCDEF" for c in clean):
        raise ValueError(f"Invalid hex colour: {value}")
    return RGB(int(clean[0:2], 16), int(clean[2:4], 16), int(clean[4:6], 16))


def _linearise(c: float) -> float:
    v = c / 255
    return ((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92


def _delinearise(v: float) -> float:
    c = 12.92 * v if v <= 0.0031308 else 1.055 * (v ** (1 / 2.4)) - 0.055
    return clamp(c, 0, 1) * 255


def rgb_to_xy(rgb: RGB, gamut: Gamut = GAMUT_C) -> tuple[XY, float]:
    """Converts sRGB (0-255) to xy clamped to ``gamut``. Also returns a brightness hint (0-100)."""
    r, g, b = _linearise(rgb.r), _linearise(rgb.g), _linearise(rgb.b)
    x_ = r * 0.664511 + g * 0.154324 + b * 0.162028
    y_ = r * 0.283881 + g * 0.668433 + b * 0.047685
    z_ = r * 0.000088 + g * 0.07231 + b * 0.986039
    total = x_ + y_ + z_
    xy: XY = {"x": 0.3127, "y": 0.329} if total == 0 else {"x": x_ / total, "y": y_ / total}
    return clamp_to_gamut(xy, gamut), clamp(y_ * 100, 0, 100)


def xy_to_rgb(xy: XY, brightness: float = 100, gamut: Gamut = GAMUT_C) -> RGB:
    """Converts xy + brightness (0-100) back to sRGB (0-255)."""
    p = clamp_to_gamut(xy, gamut)
    x, y = p["x"], p["y"]
    y_ = clamp(brightness, 0, 100) / 100
    if y == 0:
        return RGB(0, 0, 0)
    x_ = (y_ / y) * x
    z_ = (y_ / y) * (1 - x - y)
    r = x_ * 1.656492 - y_ * 0.354851 - z_ * 0.255038
    g = -x_ * 0.707196 + y_ * 1.655397 + z_ * 0.036152
    b = x_ * 0.051713 - y_ * 0.121364 + z_ * 1.01153
    top = max(r, g, b)
    if top > 1:
        r, g, b = r / top, g / top, b / top
    return RGB(_delinearise(max(r, 0)), _delinearise(max(g, 0)), _delinearise(max(b, 0)))


def _cross(a: XY, b: XY) -> float:
    return a["x"] * b["y"] - a["y"] * b["x"]


def is_in_gamut(p: XY, gamut: Gamut) -> bool:
    red, green, blue = gamut["red"], gamut["green"], gamut["blue"]
    v1: XY = {"x": green["x"] - red["x"], "y": green["y"] - red["y"]}
    v2: XY = {"x": blue["x"] - red["x"], "y": blue["y"] - red["y"]}
    q: XY = {"x": p["x"] - red["x"], "y": p["y"] - red["y"]}
    denom = _cross(v1, v2)
    if denom == 0:
        return False
    s = _cross(q, v2) / denom
    t = _cross(v1, q) / denom
    return s >= 0 and t >= 0 and s + t <= 1


def _closest_on_segment(a: XY, b: XY, p: XY) -> XY:
    apx, apy = p["x"] - a["x"], p["y"] - a["y"]
    abx, aby = b["x"] - a["x"], b["y"] - a["y"]
    ab2 = abx * abx + aby * aby
    t = 0.0 if ab2 == 0 else clamp((apx * abx + apy * aby) / ab2, 0, 1)
    return {"x": a["x"] + abx * t, "y": a["y"] + aby * t}


def clamp_to_gamut(p: XY, gamut: Gamut) -> XY:
    if is_in_gamut(p, gamut):
        return p
    candidates = [
        _closest_on_segment(gamut["red"], gamut["green"], p),
        _closest_on_segment(gamut["blue"], gamut["red"], p),
        _closest_on_segment(gamut["green"], gamut["blue"], p),
    ]
    best = min(candidates, key=lambda c: math.hypot(p["x"] - c["x"], p["y"] - c["y"]))
    return {"x": round(best["x"], 4), "y": round(best["y"], 4)}


def mirek_to_kelvin(mirek: float) -> int:
    """Mirek (micro reciprocal kelvin) to kelvin. Hue lights span ~153 (6500 K) to ~500 (2000 K)."""
    return round(1_000_000 / mirek)


def kelvin_to_mirek(kelvin: float) -> int:
    return round(1_000_000 / kelvin)


def light_level_to_lux(light_level: float) -> float:
    """Hue light-level sensors report ``10000 * log10(lux) + 1``; invert it."""
    return round(10 ** ((light_level - 1) / 10000), 2)
