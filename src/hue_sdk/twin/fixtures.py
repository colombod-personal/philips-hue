"""Hand-written CLIP v2 fixture data modelled on real bridge payloads: a bridge,
a colour bulb in a room, a smart plug, a motion sensor (motion + temperature +
light level + battery), a dimmer switch, a zone and a scene. Used by the
built-in sample recording; real captures should replace it."""

from __future__ import annotations

from ..types import Resource

BRIDGE_ID = "001788fffe123456"

IDS: dict[str, str] = {
    "bridge_device": "b0000000-0000-4000-8000-000000000001",
    "bridge": "b0000000-0000-4000-8000-000000000002",
    "bridge_zigbee": "zb000000-0000-4000-8000-000000000003",
    "bulb_device": "d0000000-0000-4000-8000-000000000010",
    "bulb_light": "l0000000-0000-4000-8000-000000000011",
    "bulb_zigbee": "z0000000-0000-4000-8000-000000000012",
    "bulb_entertainment": "e0000000-0000-4000-8000-000000000013",
    "plug_device": "d0000000-0000-4000-8000-000000000020",
    "plug_light": "l0000000-0000-4000-8000-000000000021",
    "motion_device": "d0000000-0000-4000-8000-000000000030",
    "motion": "s0000000-0000-4000-8000-000000000031",
    "temperature": "s0000000-0000-4000-8000-000000000032",
    "light_level": "s0000000-0000-4000-8000-000000000033",
    "motion_power": "s0000000-0000-4000-8000-000000000034",
    "motion_zigbee": "z0000000-0000-4000-8000-000000000035",
    "switch_device": "d0000000-0000-4000-8000-000000000040",
    "switch_button1": "s0000000-0000-4000-8000-000000000041",
    "switch_button2": "s0000000-0000-4000-8000-000000000042",
    "switch_power": "s0000000-0000-4000-8000-000000000043",
    "room": "r0000000-0000-4000-8000-000000000050",
    "room_grouped_light": "g0000000-0000-4000-8000-000000000051",
    "zone": "r0000000-0000-4000-8000-000000000060",
    "zone_grouped_light": "g0000000-0000-4000-8000-000000000061",
    "home": "r0000000-0000-4000-8000-000000000070",
    "home_grouped_light": "g0000000-0000-4000-8000-000000000071",
    "scene": "c0000000-0000-4000-8000-000000000080",
}


def _dev(rid: str) -> dict[str, str]:
    return {"rid": rid, "rtype": "device"}


def fixture_resources() -> list[Resource]:
    i = IDS
    signify = "Signify Netherlands B.V."
    gamut_c = {"red": {"x": 0.6915, "y": 0.3083}, "green": {"x": 0.17, "y": 0.7}, "blue": {"x": 0.1532, "y": 0.0475}}
    return [
        {
            "id": i["bridge_device"],
            "type": "device",
            "product_data": {
                "model_id": "BSB002",
                "manufacturer_name": signify,
                "product_name": "Philips hue",
                "product_archetype": "bridge_v2",
                "certified": True,
                "software_version": "1.66.1966060010",
            },
            "metadata": {"name": "Philips hue", "archetype": "bridge_v2"},
            "identify": {},
            "services": [{"rid": i["bridge"], "rtype": "bridge"}, {"rid": i["bridge_zigbee"], "rtype": "zigbee_connectivity"}],
        },
        {"id": i["bridge"], "type": "bridge", "owner": _dev(i["bridge_device"]), "bridge_id": BRIDGE_ID, "time_zone": {"time_zone": "Europe/Amsterdam"}},
        {"id": i["bridge_zigbee"], "type": "zigbee_connectivity", "owner": _dev(i["bridge_device"]), "status": "connected"},
        {
            "id": i["bulb_device"],
            "type": "device",
            "id_v1": "/lights/3",
            "product_data": {
                "model_id": "LCA001",
                "manufacturer_name": signify,
                "product_name": "Hue color lamp",
                "product_archetype": "sultan_bulb",
                "certified": True,
                "software_version": "1.104.2",
            },
            "metadata": {"name": "Desk lamp", "archetype": "sultan_bulb"},
            "identify": {},
            "services": [
                {"rid": i["bulb_light"], "rtype": "light"},
                {"rid": i["bulb_zigbee"], "rtype": "zigbee_connectivity"},
                {"rid": i["bulb_entertainment"], "rtype": "entertainment"},
            ],
        },
        {
            "id": i["bulb_light"],
            "type": "light",
            "id_v1": "/lights/3",
            "owner": _dev(i["bulb_device"]),
            "metadata": {"name": "Desk lamp", "archetype": "sultan_bulb", "function": "mixed"},
            "on": {"on": True},
            "dimming": {"brightness": 63.24, "min_dim_level": 0.2},
            "color_temperature": {"mirek": 366, "mirek_valid": True, "mirek_schema": {"mirek_minimum": 153, "mirek_maximum": 500}},
            "color": {"xy": {"x": 0.4575, "y": 0.4101}, "gamut": gamut_c, "gamut_type": "C"},
            "dynamics": {"status": "none", "status_values": ["none", "dynamic_palette"], "speed": 0, "speed_valid": False},
            "alert": {"action_values": ["breathe"]},
            "mode": "normal",
            "effects": {"status_values": ["no_effect", "candle", "fire"], "status": "no_effect", "effect_values": ["no_effect", "candle", "fire"]},
        },
        {"id": i["bulb_zigbee"], "type": "zigbee_connectivity", "owner": _dev(i["bulb_device"]), "status": "connected", "mac_address": "00:17:88:01:0b:aa:bb:cc"},
        {
            "id": i["plug_device"],
            "type": "device",
            "id_v1": "/lights/7",
            "product_data": {
                "model_id": "LOM001",
                "manufacturer_name": signify,
                "product_name": "Hue smart plug",
                "product_archetype": "plug",
                "certified": True,
                "software_version": "1.104.2",
            },
            "metadata": {"name": "Heater plug", "archetype": "plug"},
            "services": [{"rid": i["plug_light"], "rtype": "light"}],
        },
        {
            "id": i["plug_light"],
            "type": "light",
            "owner": _dev(i["plug_device"]),
            "metadata": {"name": "Heater plug", "archetype": "plug"},
            "on": {"on": False},
            "mode": "normal",
        },
        {
            "id": i["motion_device"],
            "type": "device",
            "id_v1": "/sensors/12",
            "product_data": {
                "model_id": "SML001",
                "manufacturer_name": signify,
                "product_name": "Hue motion sensor",
                "product_archetype": "unknown_archetype",
                "certified": True,
                "software_version": "6.1.1.27575",
            },
            "metadata": {"name": "Hallway sensor", "archetype": "unknown_archetype"},
            "services": [
                {"rid": i["motion"], "rtype": "motion"},
                {"rid": i["temperature"], "rtype": "temperature"},
                {"rid": i["light_level"], "rtype": "light_level"},
                {"rid": i["motion_power"], "rtype": "device_power"},
                {"rid": i["motion_zigbee"], "rtype": "zigbee_connectivity"},
            ],
        },
        {
            "id": i["motion"],
            "type": "motion",
            "id_v1": "/sensors/12",
            "owner": _dev(i["motion_device"]),
            "enabled": True,
            "motion": {"motion": False, "motion_valid": True, "motion_report": {"changed": "2026-09-28T09:15:02Z", "motion": False}},
            "sensitivity": {"status": "set", "sensitivity": 2, "sensitivity_max": 4},
        },
        {
            "id": i["temperature"],
            "type": "temperature",
            "id_v1": "/sensors/13",
            "owner": _dev(i["motion_device"]),
            "enabled": True,
            "temperature": {"temperature": 21.4, "temperature_valid": True, "temperature_report": {"changed": "2026-09-28T09:10:00Z", "temperature": 21.4}},
        },
        {
            "id": i["light_level"],
            "type": "light_level",
            "id_v1": "/sensors/14",
            "owner": _dev(i["motion_device"]),
            "enabled": True,
            "light": {"light_level": 20000, "light_level_valid": True, "light_level_report": {"changed": "2026-09-28T09:12:00Z", "light_level": 20000}},
        },
        {"id": i["motion_power"], "type": "device_power", "owner": _dev(i["motion_device"]), "power_state": {"battery_state": "normal", "battery_level": 87}},
        {"id": i["motion_zigbee"], "type": "zigbee_connectivity", "owner": _dev(i["motion_device"]), "status": "connected"},
        {
            "id": i["switch_device"],
            "type": "device",
            "id_v1": "/sensors/20",
            "product_data": {
                "model_id": "RWL022",
                "manufacturer_name": signify,
                "product_name": "Hue dimmer switch",
                "product_archetype": "unknown_archetype",
                "certified": True,
                "software_version": "2.47.8",
            },
            "metadata": {"name": "Bedroom dimmer", "archetype": "unknown_archetype"},
            "services": [
                {"rid": i["switch_button1"], "rtype": "button"},
                {"rid": i["switch_button2"], "rtype": "button"},
                {"rid": i["switch_power"], "rtype": "device_power"},
            ],
        },
        {
            "id": i["switch_button1"],
            "type": "button",
            "owner": _dev(i["switch_device"]),
            "metadata": {"control_id": 1},
            "button": {
                "last_event": "short_release",
                "button_report": {"updated": "2026-09-27T22:01:10Z", "event": "short_release"},
                "repeat_interval": 800,
                "event_values": ["initial_press", "repeat", "short_release", "long_release", "long_press"],
            },
        },
        {
            "id": i["switch_button2"],
            "type": "button",
            "owner": _dev(i["switch_device"]),
            "metadata": {"control_id": 2},
            "button": {"event_values": ["initial_press", "repeat", "short_release", "long_release", "long_press"]},
        },
        {"id": i["switch_power"], "type": "device_power", "owner": _dev(i["switch_device"]), "power_state": {"battery_state": "low", "battery_level": 12}},
        {
            "id": i["room"],
            "type": "room",
            "id_v1": "/groups/1",
            "children": [_dev(i["bulb_device"]), _dev(i["motion_device"])],
            "services": [{"rid": i["room_grouped_light"], "rtype": "grouped_light"}],
            "metadata": {"name": "Office", "archetype": "office"},
        },
        {
            "id": i["room_grouped_light"],
            "type": "grouped_light",
            "id_v1": "/groups/1",
            "owner": {"rid": i["room"], "rtype": "room"},
            "on": {"on": True},
            "dimming": {"brightness": 63.24},
            "alert": {"action_values": ["breathe"]},
        },
        {
            "id": i["zone"],
            "type": "zone",
            "id_v1": "/groups/2",
            "children": [{"rid": i["bulb_light"], "rtype": "light"}, {"rid": i["plug_light"], "rtype": "light"}],
            "services": [{"rid": i["zone_grouped_light"], "rtype": "grouped_light"}],
            "metadata": {"name": "Downstairs", "archetype": "downstairs"},
        },
        {"id": i["zone_grouped_light"], "type": "grouped_light", "owner": {"rid": i["zone"], "rtype": "zone"}, "on": {"on": True}, "dimming": {"brightness": 31.62}},
        {
            "id": i["home"],
            "type": "bridge_home",
            "id_v1": "/groups/0",
            "children": [_dev(i["bridge_device"]), _dev(i["bulb_device"]), _dev(i["plug_device"]), _dev(i["motion_device"]), _dev(i["switch_device"])],
            "services": [{"rid": i["home_grouped_light"], "rtype": "grouped_light"}],
        },
        {"id": i["home_grouped_light"], "type": "grouped_light", "owner": {"rid": i["home"], "rtype": "bridge_home"}, "on": {"on": True}},
        {
            "id": i["scene"],
            "type": "scene",
            "id_v1": "/scenes/abc123",
            "metadata": {"name": "Concentrate"},
            "group": {"rid": i["room"], "rtype": "room"},
            "actions": [
                {
                    "target": {"rid": i["bulb_light"], "rtype": "light"},
                    "action": {"on": {"on": True}, "dimming": {"brightness": 100}, "color_temperature": {"mirek": 233}},
                }
            ],
            "speed": 0.5,
            "auto_dynamic": False,
            "status": {"active": "inactive"},
        },
    ]
