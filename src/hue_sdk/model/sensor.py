"""Normalises sensor-style services into :class:`SensorSnapshot`."""

from __future__ import annotations

from typing import Any

from ..color import light_level_to_lux
from ..types import SENSOR_SERVICE_TYPES, Resource
from .snapshot import SensorSnapshot


def is_sensor_type(rtype: str) -> bool:
    return rtype in SENSOR_SERVICE_TYPES


def _get(d: Any, *path: str) -> Any:
    for key in path:
        if not isinstance(d, dict):
            return None
        d = d.get(key)
    return d


def sensor_snapshot(resource: Resource) -> SensorSnapshot | None:
    rtype = resource["type"]
    enabled = resource.get("enabled") if isinstance(resource.get("enabled"), bool) else None
    base: dict[str, Any] = {"id": resource["id"], "type": rtype, "enabled": enabled}

    if rtype in ("motion", "camera_motion", "grouped_motion", "convenience_area_motion", "security_area_motion"):
        report = _get(resource, "motion", "motion_report")
        if isinstance(report, dict):
            value, changed = report.get("motion"), report.get("changed")
        else:
            value = None if _get(resource, "motion", "motion_valid") is False else _get(resource, "motion", "motion")
            changed = None
        detail = {"sensitivity": resource["sensitivity"]} if isinstance(resource.get("sensitivity"), dict) else {}
        return SensorSnapshot(**base, value=value, unit="boolean", changed=changed, detail=detail)

    if rtype == "temperature":
        report = _get(resource, "temperature", "temperature_report")
        if isinstance(report, dict):
            value, changed = report.get("temperature"), report.get("changed")
        else:
            value = None if _get(resource, "temperature", "temperature_valid") is False else _get(resource, "temperature", "temperature")
            changed = None
        return SensorSnapshot(**base, value=value, unit="°C", changed=changed)

    if rtype in ("light_level", "grouped_light_level"):
        report = _get(resource, "light", "light_level_report")
        if isinstance(report, dict):
            raw, changed = report.get("light_level"), report.get("changed")
        else:
            raw = None if _get(resource, "light", "light_level_valid") is False else _get(resource, "light", "light_level")
            changed = None
        lux = light_level_to_lux(raw) if isinstance(raw, int | float) else None
        return SensorSnapshot(**base, value=lux, unit="lux", changed=changed, detail={"light_level": raw})

    if rtype == "contact":
        report = resource.get("contact_report")
        return SensorSnapshot(**base, value=_get(report, "state"), unit="state", changed=_get(report, "changed"))

    if rtype == "tamper":
        reports = [r for r in resource.get("tamper_reports", []) if isinstance(r, dict)]
        latest = max(reports, key=lambda r: str(r.get("changed", "")), default=None)
        return SensorSnapshot(**base, value=_get(latest, "state"), unit="state", changed=_get(latest, "changed"), detail={"reports": reports})

    if rtype == "device_power":
        return SensorSnapshot(
            **base,
            value=_get(resource, "power_state", "battery_level"),
            unit="%",
            changed=None,
            detail={"battery_state": _get(resource, "power_state", "battery_state")},
        )

    if rtype in ("button", "bell_button"):
        report = _get(resource, "button", "button_report")
        value = _get(report, "event") if isinstance(report, dict) else _get(resource, "button", "last_event")
        return SensorSnapshot(
            **base,
            value=value,
            unit="event",
            changed=_get(report, "updated"),
            detail={"control_id": _get(resource, "metadata", "control_id"), "event_values": _get(resource, "button", "event_values") or []},
        )

    if rtype == "relative_rotary":
        report = _get(resource, "relative_rotary", "rotary_report")
        if isinstance(report, dict):
            rotation = report.get("rotation") or {}
            steps = rotation.get("steps")
            direction = rotation.get("direction")
            value = (steps if direction == "clock_wise" else -steps) if isinstance(steps, int | float) else None
            detail = {"action": report.get("action"), "direction": direction, "duration": rotation.get("duration")}
            return SensorSnapshot(**base, value=value, unit="steps", changed=report.get("updated"), detail=detail)
        return SensorSnapshot(**base, value=None, unit="steps", changed=None)

    return None
