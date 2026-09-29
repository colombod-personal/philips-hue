from __future__ import annotations

import pytest

from hue_sdk import HueBridge, HueClient, HueError, LinkButtonNotPressedError, PairingTimeoutError, SensorSnapshot, TlsOptions, identify_bridge, pair_bridge, pair_once
from hue_sdk.transport import HttpTransport
from hue_sdk.twin import FIXTURE_IDS as IDS
from hue_sdk.twin import BridgeSimulator

from .conftest import creds_for, wait_for


def test_identify_reads_config_and_certificate(twin: BridgeSimulator) -> None:
    info = identify_bridge(twin.host, port=twin.port)
    assert info.id == twin.bridge_id and info.model_id == "BSB002"
    assert info.certificate is not None
    assert info.certificate.fingerprint256 == twin.fingerprint
    assert info.certificate.self_signed and info.certificate.subject_cn == twin.bridge_id


def test_fingerprint_pinning(twin: BridgeSimulator) -> None:
    wrong = HttpTransport(twin.host, port=twin.port, tls=TlsOptions(fingerprint="00" * 32))
    with pytest.raises(HueError) as exc:
        wrong.request("GET", "/api/0/config")
    assert exc.value.code == "tls" and "fingerprint mismatch" in exc.value.message
    right = HttpTransport(twin.host, port=twin.port, tls=TlsOptions(fingerprint=twin.fingerprint.lower()))
    res = right.request("GET", "/api/0/config")
    assert res.status == 200 and res.body["bridgeid"].lower() == twin.bridge_id
    right.close()


def test_ca_and_bridge_id_verification(twin: BridgeSimulator) -> None:
    ok = HttpTransport(twin.host, port=twin.port, tls=TlsOptions(ca=twin.cert_pem, bridge_id=twin.bridge_id))
    assert ok.request("GET", "/api/0/config").status == 200
    ok.close()
    bad = HttpTransport(twin.host, port=twin.port, tls=TlsOptions(ca=twin.cert_pem, bridge_id="ffffffffffffffff"))
    with pytest.raises(HueError) as exc:
        bad.request("GET", "/api/0/config")
    assert exc.value.code == "tls"


def test_pairing_waits_for_link_button(twin: BridgeSimulator) -> None:
    t = HttpTransport(twin.host, port=twin.port, tls=TlsOptions(fingerprint=twin.fingerprint))
    with pytest.raises(LinkButtonNotPressedError):
        pair_once(t, "hue-sdk#test")
    t.close()
    with pytest.raises(PairingTimeoutError):
        pair_bridge(twin.host, port=twin.port, timeout_s=0.25, interval_s=0.05)

    attempts = 0

    def waiting(_p: object) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            twin.press_link_button()

    creds = pair_bridge(twin.host, port=twin.port, app_name="hue sdk tests", instance_name="ci", timeout_s=5, interval_s=0.02, on_waiting=waiting)
    assert attempts >= 2
    assert creds.bridge_id == twin.bridge_id and creds.application_key == twin.application_key
    assert creds.client_key and len(creds.client_key) == 32
    assert creds.fingerprint == twin.fingerprint and creds.device_type == "hue-sdk-tests#ci" and creds.model_id == "BSB002"


def test_client_error_mapping(twin: BridgeSimulator) -> None:
    bad = HueClient(twin.host, port=twin.port, application_key="nope", tls=TlsOptions(fingerprint=twin.fingerprint))
    with pytest.raises(HueError) as exc:
        bad.list("light")
    assert exc.value.code == "unauthorized" and exc.value.status == 403
    bad.close()
    good = HueClient.from_credentials(creds_for(twin))
    with pytest.raises(HueError) as exc2:
        good.get("light", "missing")
    assert exc2.value.code == "not_found"
    with pytest.raises(HueError) as exc3:
        good.update("light", IDS["plug_light"], {"color_temperature": {"mirek": 200}})
    assert exc3.value.code == "bad_request"
    assert len(good.list("light")) == 2
    good.close()


def test_device_model(twin: BridgeSimulator) -> None:
    with HueBridge.connect(creds_for(twin)) as bridge:
        assert len(bridge.devices) == 5
        kinds = {d.name: d.kind for d in bridge.devices}
        assert kinds == {"Philips hue": "bridge", "Desk lamp": "light", "Heater plug": "plug", "Hallway sensor": "sensor", "Bedroom dimmer": "switch"}

        sensor_device = bridge.resolve_device("hallway")
        assert sensor_device is not None
        assert sensor_device.room is not None and sensor_device.room.name == "Office"
        assert sensor_device.battery is not None and (sensor_device.battery.level, sensor_device.battery.state) == (87, "normal")
        assert sensor_device.connectivity == "connected"
        readings = {s.type: s for s in sensor_device.sensors()}
        assert readings["motion"].value is False
        assert (readings["temperature"].value, readings["temperature"].unit) == (21.4, "°C")
        assert (readings["light_level"].value, readings["light_level"].unit) == (99.98, "lux")
        assert readings["device_power"].value == 87

        lamp = bridge.resolve_device("Desk lamp")
        assert lamp is not None and len(lamp.lights) == 1
        assert [z.name for z in lamp.zones] == ["Downstairs"]
        snap = lamp.snapshot()
        assert snap.lights[0].color_temperature is not None and snap.lights[0].color_temperature.kelvin == 2732
        assert snap.lights[0].capabilities.color and snap.product.model_id == "LCA001"
        assert isinstance(snap.to_dict()["lights"][0]["color"]["hex"], str)

        assert [d.name for d in bridge.find_devices(room="office", kind="sensor")] == ["Hallway sensor"]
        assert [d.name for d in bridge.find_devices(service="button")] == ["Bedroom dimmer"]
        assert sorted(d.name for d in bridge.find_devices(zone="Downstairs")) == ["Desk lamp", "Heater plug"]
        assert bridge.find_devices(room="nope") == []

        office = bridge.group("Office")
        assert office is not None
        assert sorted(office.device_ids()) == sorted([IDS["bulb_device"], IDS["motion_device"]])
        assert [s.name for s in office.scenes] == ["Concentrate"]
        assert len(bridge.zones[0].device_ids()) == 2

        home = bridge.snapshot()
        assert home.bridge.id == twin.bridge_id and home.bridge.model_id == "BSB002"
        assert home.rooms[0].light is not None and home.rooms[0].light.brightness == 63.24
        assert len(home.scenes) == 1
        assert len(bridge.sensors("temperature")) == 1
        assert len(bridge.sensors()) == 7  # motion, temperature, light_level, device_power, 2 buttons, switch device_power


def test_commands_and_live_updates(twin: BridgeSimulator) -> None:
    with HueBridge.connect(creds_for(twin)) as bridge:
        sensor_events: list[SensorSnapshot] = []
        changes: list[str] = []
        bridge.on("sensor", lambda reading, _device: sensor_events.append(reading))
        bridge.on("change", lambda c: changes.extend(r["type"] for r in c.resources))
        bridge.watch()

        lamp = bridge.resolve_light("desk")
        assert lamp is not None
        lamp.set(brightness=20, hex="#0000ff", transition_ms=100)
        put = [r for r in twin.requests if r.method == "PUT"][-1]
        assert put.path == f"/clip/v2/resource/light/{IDS['bulb_light']}"
        assert put.body["dimming"]["brightness"] == 20 and put.body["on"]["on"] is True and put.body["color"]["xy"]["x"] < 0.2

        office = bridge.group("Office")
        assert office is not None
        office.turn_off()
        assert [r for r in twin.requests if r.method == "PUT"][-1].path == f"/clip/v2/resource/grouped_light/{IDS['room_grouped_light']}"
        office.activate_scene("concentrate")
        scene_put = [r for r in twin.requests if r.method == "PUT"][-1]
        assert scene_put.path == f"/clip/v2/resource/scene/{IDS['scene']}" and scene_put.body == {"recall": {"action": "active"}}

        twin.update_resource("motion", IDS["motion"], {"motion": {"motion": True, "motion_report": {"changed": "2026-09-28T10:00:00Z", "motion": True}}})
        wait_for(lambda: any(s.type == "motion" and s.value is True for s in sensor_events))
        hallway = bridge.resolve_device("Hallway sensor")
        assert hallway is not None
        motion = hallway.sensor("motion")
        assert motion is not None and motion.value is True and motion.changed == "2026-09-28T10:00:00Z"
        wait_for(lambda: "scene" in changes)
        assert lamp.brightness == 100  # scene recall set it, as the real bridge would


def test_event_stream_reconnects(twin: BridgeSimulator) -> None:
    client = HueClient.from_credentials(creds_for(twin))
    stream = client.events(backoff_s=0.02, max_backoff_s=0.05)
    connects: list[bool] = []
    disconnects: list[object] = []
    stream.on("connected", lambda info: connects.append(info["reconnect"]))
    stream.on("disconnected", lambda err: disconnects.append(err))
    stream.start()
    twin.drop_streams()
    wait_for(lambda: len(connects) >= 2)
    assert connects[:2] == [False, True] and disconnects
    twin.emit({"id": "x", "creationtime": "t", "type": "update", "data": [{"id": IDS["plug_light"], "type": "light", "on": {"on": True}}]})
    first = next(iter(stream))
    assert first["data"][0]["id"] == IDS["plug_light"]
    stream.stop()
    assert list(stream) == []
    client.close()


def test_http_scheme_for_emulators(http_twin: BridgeSimulator) -> None:
    client = HueClient(http_twin.host, port=http_twin.port, scheme="http", application_key=http_twin.application_key)
    assert client.get_config()["modelid"] == "BSB002"
    assert len(client.list("device")) == 5
    client.close()
