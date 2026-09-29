"""Built-in sample recording: the fixture home plus a 20 s scripted timeline
(someone walks in, presses the dimmer, leaves). It mirrors the shape of real
recordings so tests and demos run without hardware; replace it with a real
capture from ``hue-twin record`` as soon as you have one."""

from __future__ import annotations

from ..types import HueEvent, Resource
from .fixtures import BRIDGE_ID, IDS, fixture_resources
from .recording import RecordedEvent, Recording


def _update(offset_ms: int, data: list[Resource]) -> RecordedEvent:
    event: HueEvent = {"id": f"sample-{offset_ms}", "creationtime": "2026-09-28T09:00:00Z", "type": "update", "data": data}
    return RecordedEvent(offset_ms=offset_ms, event=event)


def sample_recording() -> Recording:
    i = IDS

    def owner(rid: str) -> dict[str, str]:
        return {"rid": rid, "rtype": "device"}

    room_owner = {"rid": i["room"], "rtype": "room"}
    return Recording(
        version=1,
        recorded_at="2026-09-28T09:00:00+00:00",
        duration_ms=20_000,
        label="sample: office, someone walks in, presses the dimmer, leaves",
        config={
            "name": "Philips hue",
            "datastoreversion": "170",
            "swversion": "1966060010",
            "apiversion": "1.66.0",
            "mac": "00:17:88:12:34:56",
            "bridgeid": BRIDGE_ID.upper(),
            "factorynew": False,
            "replacesbridgeid": None,
            "modelid": "BSB002",
            "starterkitid": "",
        },
        resources=fixture_resources(),
        events=[
            _update(
                1_000,
                [
                    {
                        "id": i["motion"],
                        "type": "motion",
                        "owner": owner(i["motion_device"]),
                        "motion": {"motion": True, "motion_report": {"changed": "2026-09-28T09:00:01Z", "motion": True}},
                    }
                ],
            ),
            _update(
                1_500,
                [
                    {
                        "id": i["light_level"],
                        "type": "light_level",
                        "owner": owner(i["motion_device"]),
                        "light": {"light_level": 24000, "light_level_report": {"changed": "2026-09-28T09:00:01Z", "light_level": 24000}},
                    }
                ],
            ),
            _update(
                4_000,
                [
                    {
                        "id": i["switch_button1"],
                        "type": "button",
                        "owner": owner(i["switch_device"]),
                        "button": {"button_report": {"updated": "2026-09-28T09:00:04Z", "event": "initial_press"}},
                    }
                ],
            ),
            _update(
                4_200,
                [
                    {
                        "id": i["switch_button1"],
                        "type": "button",
                        "owner": owner(i["switch_device"]),
                        "button": {"button_report": {"updated": "2026-09-28T09:00:04Z", "event": "short_release"}},
                    }
                ],
            ),
            _update(
                4_300,
                [
                    {"id": i["bulb_light"], "type": "light", "owner": owner(i["bulb_device"]), "on": {"on": True}, "dimming": {"brightness": 100}},
                    {"id": i["room_grouped_light"], "type": "grouped_light", "owner": room_owner, "on": {"on": True}, "dimming": {"brightness": 100}},
                ],
            ),
            _update(
                9_000,
                [
                    {
                        "id": i["motion"],
                        "type": "motion",
                        "owner": owner(i["motion_device"]),
                        "motion": {"motion": False, "motion_report": {"changed": "2026-09-28T09:00:09Z", "motion": False}},
                    }
                ],
            ),
            _update(
                12_000,
                [
                    {
                        "id": i["temperature"],
                        "type": "temperature",
                        "owner": owner(i["motion_device"]),
                        "temperature": {"temperature": 21.6, "temperature_report": {"changed": "2026-09-28T09:00:12Z", "temperature": 21.6}},
                    }
                ],
            ),
            _update(15_000, [{"id": i["bulb_zigbee"], "type": "zigbee_connectivity", "owner": owner(i["bulb_device"]), "status": "connectivity_issue"}]),
            _update(17_000, [{"id": i["bulb_zigbee"], "type": "zigbee_connectivity", "owner": owner(i["bulb_device"]), "status": "connected"}]),
            _update(
                19_000,
                [
                    {"id": i["bulb_light"], "type": "light", "owner": owner(i["bulb_device"]), "on": {"on": False}},
                    {"id": i["room_grouped_light"], "type": "grouped_light", "owner": room_owner, "on": {"on": False}},
                ],
            ),
        ],
    )
