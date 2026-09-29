from __future__ import annotations

import json
import time
import urllib.request
from typing import Any

from hue_sdk import HueBridge, HueClient, HueEvent, TlsOptions
from hue_sdk.twin import FIXTURE_IDS as IDS
from hue_sdk.twin import BridgeSimulator, Recording, is_recording, record_bridge, sample_recording

from .conftest import creds_for, wait_for


def _call(url: str, method: str = "GET", body: Any = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read())


def test_replay_order_speed_and_state() -> None:
    sim = BridgeSimulator.start(sample_recording(), autostart_replay=False, scheme="http", replay_speed=50)
    try:
        client = HueClient(sim.host, port=sim.port, scheme="http", application_key=sim.application_key)
        stream = client.events()
        seen: list[HueEvent] = []
        stream.on("event", seen.append)
        stream.start()
        t0 = time.monotonic()
        sim.replay_start()
        wait_for(lambda: len(seen) >= 10)  # 10 events over 20 s virtual = 0.4 s at 50x
        assert time.monotonic() - t0 < 2.5
        types = ["+".join(d["type"] for d in e["data"]) for e in seen]
        assert types[:4] == ["motion", "light_level", "button", "button"]
        assert client.get("light", IDS["bulb_light"])["on"]["on"] is False
        assert client.get("temperature", IDS["temperature"])["temperature"]["temperature_report"]["temperature"] == 21.6
        state = sim.replay_state()
        assert state.next_event_index == state.total_events
        wait_for(lambda: not sim.replay_state().running, 3)
        stream.stop()
        client.close()
    finally:
        sim.close()


def test_seek_and_rewind(http_twin: BridgeSimulator) -> None:
    http_twin.replay_seek(5_000)
    assert http_twin.index.get("light", IDS["bulb_light"])["dimming"]["brightness"] == 100  # type: ignore[index]
    assert http_twin.index.get("motion", IDS["motion"])["motion"]["motion"] is True  # type: ignore[index]
    assert http_twin.emitted == []
    http_twin.replay_seek(0)
    assert http_twin.index.get("light", IDS["bulb_light"])["dimming"]["brightness"] == 63.24  # type: ignore[index]
    assert http_twin.replay_state().next_event_index == 0


def test_writes_and_scene_recall(twin: BridgeSimulator) -> None:
    with HueBridge.connect(creds_for(twin)) as bridge:
        seen: list[str] = []
        bridge.on("change", lambda c: seen.extend(r["type"] for r in c.resources))
        bridge.watch()
        lamp = bridge.resolve_light("Desk lamp")
        assert lamp is not None
        lamp.set(brightness=10, transition_ms=300)
        wait_for(lambda: "light" in seen)
        light = twin.index.get("light", IDS["bulb_light"])
        assert light is not None and light["dimming"]["brightness"] == 10 and "dynamics" in light
        office = bridge.group("Office")
        assert office is not None
        office.activate_scene("Concentrate")
        wait_for(lambda: "scene" in seen)
        light = twin.index.get("light", IDS["bulb_light"])
        assert light is not None and light["dimming"]["brightness"] == 100 and light["color_temperature"]["mirek"] == 233
        scene = twin.index.get("scene", IDS["scene"])
        assert scene is not None and scene["status"]["active"] == "static"
        found = bridge.scene("Concentrate")
        assert found is not None and found.snapshot().active == "static"


def test_control_api(http_twin: BridgeSimulator) -> None:
    base = http_twin.url
    state = _call(f"{base}/__twin/state")
    assert state["link_button_pressed"] is False and state["replay"]["running"] is False
    _call(f"{base}/__twin/link-button", "POST")
    pair = _call(f"{base}/api", "POST", {"devicetype": "x#y"})
    assert pair[0]["success"]["username"] == http_twin.application_key
    _call(f"{base}/__twin/emit", "POST", {"resource_type": "motion", "id": IDS["motion"], "patch": {"motion": {"motion": True}}})
    assert http_twin.index.get("motion", IDS["motion"])["motion"]["motion"] is True  # type: ignore[index]
    replay = _call(f"{base}/__twin/replay", "POST", {"action": "seek", "offset_ms": 13_000})
    assert replay["next_event_index"] == 7
    exported = _call(f"{base}/__twin/recording")
    assert is_recording(exported) and len(exported["events"]) == 1
    _call(f"{base}/__twin/reset", "POST")
    assert http_twin.index.get("motion", IDS["motion"])["motion"]["motion"] is False  # type: ignore[index]
    assert http_twin.emitted == []


def test_recorder_round_trip() -> None:
    source = BridgeSimulator.start(sample_recording(), autostart_replay=False, replay_speed=100)
    try:
        import threading

        result: dict[str, Recording] = {}

        def run() -> None:
            result["rec"] = record_bridge(creds_for(source), duration_s=0.7, label="round trip")

        t = threading.Thread(target=run)
        t.start()
        wait_for(lambda: source.open_streams == 1)  # recorder subscribed; now play the 20 s timeline at 100x (200 ms)
        source.replay_start()
        t.join(10)
        recording = result["rec"]
        assert recording.label == "round trip" and recording.bridge_id == source.bridge_id
        assert recording.certificate is not None and recording.certificate.fingerprint256 == source.fingerprint
        assert len(recording.resources) == len(sample_recording().resources)
        assert len(recording.events) == len(sample_recording().events)
        offsets = [e.offset_ms for e in recording.events]
        assert offsets == sorted(offsets)
        assert source.application_key not in recording.to_json()

        # A recording can itself power a twin and round-trips through JSON.
        reloaded = Recording.from_dict(json.loads(recording.to_json()))
        twin = BridgeSimulator.start(reloaded, autostart_replay=False, scheme="http")
        try:
            bridge = HueBridge.connect(creds_for(twin), tls=TlsOptions(insecure=True))
            assert len(bridge.devices) == 5
            lamp = bridge.resolve_device("Desk lamp")
            assert lamp is not None and lamp.lights[0].is_on is True  # resources = state at capture start
            twin.replay_seek(reloaded.duration_ms)
            bridge.refresh()
            assert lamp.lights[0].is_on is False  # timeline end reproduces what happened
            bridge.close()
        finally:
            twin.close()
    finally:
        source.close()


def test_certificate_persists_across_restarts(tmp_path) -> None:  # type: ignore[no-untyped-def]
    first = BridgeSimulator.start(sample_recording(), autostart_replay=False, certificate_dir=tmp_path)
    fp = first.fingerprint
    first.close()
    second = BridgeSimulator.start(sample_recording(), autostart_replay=False, certificate_dir=tmp_path)
    try:
        assert second.fingerprint == fp
    finally:
        second.close()
