from __future__ import annotations

import struct

import pytest

from hue_sdk import (
    GAMUT_C,
    BridgeCredentials,
    HueError,
    LightCommand,
    MemoryCredentialStore,
    build_device_type,
    build_light_update,
    kelvin_to_mirek,
    light_level_to_lux,
    mirek_to_kelvin,
    normalize_fingerprint,
    parse_hex_color,
    parse_hue_events,
    resolve_connection,
    rgb_to_xy,
    xy_to_rgb,
)
from hue_sdk.color import clamp_to_gamut, is_in_gamut
from hue_sdk.discovery import DiscoveredBridge, merge_bridges
from hue_sdk.discovery.cloud import discover_via_cloud
from hue_sdk.discovery.dns import TYPE_A, TYPE_PTR, TYPE_SRV, TYPE_TXT, DnsQuestion, decode_message, encode_name, encode_query
from hue_sdk.events import SseParser
from hue_sdk.model import ResourceIndex, deep_merge
from hue_sdk.tls import TlsOptions, verify_bridge_certificate
from hue_sdk.twin import redact_secrets


def _rr(rtype: int, data: bytes) -> bytes:
    return struct.pack(">HHIH", rtype, 1, 120, len(data)) + data


class TestDns:
    def test_round_trip_and_compression(self) -> None:
        query = encode_query([DnsQuestion("_hue._tcp.local", TYPE_PTR, True)], 7)
        decoded = decode_message(query)
        assert decoded.id == 7 and not decoded.is_response
        assert decoded.questions[0].name == "_hue._tcp.local" and decoded.questions[0].unicast_response

        header = struct.pack(">HHHHHH", 0, 0x8400, 0, 4, 0, 0)
        service = encode_name("_hue._tcp.local")  # at offset 12
        instance_label = bytes([16]) + b"Philips Hue - AB" + bytes([0xC0, 12])
        ptr = service + _rr(TYPE_PTR, instance_label)
        instance_offset = 12 + len(service) + 10
        instance_ptr = bytes([0xC0, instance_offset])
        target = encode_name("Philips-hue.local")
        srv = instance_ptr + _rr(TYPE_SRV, struct.pack(">HHH", 0, 0, 443) + target)
        txt_entries = [b"bridgeid=001788FFFE123456", b"modelid=BSB002"]
        txt = instance_ptr + _rr(TYPE_TXT, b"".join(bytes([len(e)]) + e for e in txt_entries))
        a = target + _rr(TYPE_A, bytes([192, 168, 1, 20]))
        msg = decode_message(header + ptr + srv + txt + a)
        assert msg.is_response and len(msg.answers) == 4
        p, s, t, addr = msg.answers
        assert p.kind == "PTR" and p.data == "Philips Hue - AB._hue._tcp.local"
        assert s.kind == "SRV" and s.name == "Philips Hue - AB._hue._tcp.local" and s.data["port"] == 443 and s.data["target"] == "Philips-hue.local"
        assert t.kind == "TXT" and t.data == {"bridgeid": "001788FFFE123456", "modelid": "BSB002"}
        assert addr.kind == "A" and addr.data == "192.168.1.20"

    def test_rejects_compression_loops(self) -> None:
        header = struct.pack(">HHHHHH", 0, 0, 1, 0, 0, 0)
        with pytest.raises(ValueError):
            decode_message(header + bytes([0xC0, 12, 0, 12, 0, 1]))


class TestSse:
    def test_parses_chunks_comments_and_crlf(self) -> None:
        p = SseParser()
        assert p.push(": hi\n\n") == []
        assert p.push("id: 12:0\r\ndata: [1]\r\n") == []
        msgs = p.push('\r\nid: 13:0\ndata: {"b":\ndata: 2}\n\n')
        assert [(m.id, m.data) for m in msgs] == [("12:0", "[1]"), ("13:0", '{"b":\n2}')]

    def test_parse_hue_events_filters_and_wraps(self) -> None:
        events = parse_hue_events('[{"id":"e1","creationtime":"t","type":"update","data":[{"id":"x","type":"light"}]},{"nope":true}]')
        assert len(events) == 1 and events[0]["type"] == "update"
        with pytest.raises(HueError):
            parse_hue_events("not json")


class TestColor:
    def test_rgb_xy_round_trip(self) -> None:
        xy, _ = rgb_to_xy(parse_hex_color("#ff4000"))
        assert is_in_gamut(xy, GAMUT_C)
        back = xy_to_rgb(xy, 100)
        assert back.r > 200 and back.g < 120 and back.b < 40

    def test_clamp_and_conversions(self) -> None:
        clamped = clamp_to_gamut({"x": 0.9, "y": 0.05}, GAMUT_C)
        assert is_in_gamut(clamped, GAMUT_C) or abs(clamped["x"] - 0.6915) < 0.01
        assert mirek_to_kelvin(500) == 2000
        assert kelvin_to_mirek(6500) == 154
        assert light_level_to_lux(1) == 1
        assert light_level_to_lux(40001) == 10000
        assert parse_hex_color("#0f0").to_hex() == "#00ff00"


class TestTls:
    def test_fingerprint_normalisation_and_verification(self, twin) -> None:  # type: ignore[no-untyped-def]
        import ssl

        der = ssl.PEM_cert_to_DER_cert(twin.cert_pem)
        assert normalize_fingerprint("aa:bb:cc") == "AABBCC"
        assert verify_bridge_certificate(der, TlsOptions(fingerprint=twin.fingerprint.lower(), bridge_id=twin.bridge_id)) is None
        assert "fingerprint mismatch" in str(verify_bridge_certificate(der, TlsOptions(fingerprint="00" * 32)))
        assert "does not match bridge id" in str(verify_bridge_certificate(der, TlsOptions(bridge_id="ffff")))
        assert verify_bridge_certificate(None, TlsOptions(insecure=True)) is None
        assert verify_bridge_certificate(None, TlsOptions(fingerprint="aa")) is not None


class TestDiscovery:
    def test_merge_prefers_mdns(self) -> None:
        merged = merge_bridges(
            [
                DiscoveredBridge(id="001788FFFE000001", host="10.0.0.5", sources=["cloud"]),
                DiscoveredBridge(id="001788fffe000001", host="192.168.1.5", sources=["mdns"], name="Philips Hue - 01"),
                DiscoveredBridge(id="001788fffe000002", host="192.168.1.6", sources=["cloud"]),
            ]
        )
        assert len(merged) == 2
        first = next(b for b in merged if b.id == "001788fffe000001")
        assert first.host == "192.168.1.5" and first.sources == ["mdns", "cloud"] and first.name == "Philips Hue - 01"

    def test_cloud_parsing_and_rate_limit(self) -> None:
        payload = b'[{"id":"001788FFFE000001","internalipaddress":"192.168.1.5","port":443}]'
        bridges = discover_via_cloud(fetch=lambda _u, _t: (200, payload))
        assert [(b.id, b.host, b.port, b.sources) for b in bridges] == [("001788fffe000001", "192.168.1.5", 443, ["cloud"])]
        with pytest.raises(HueError) as exc:
            discover_via_cloud(fetch=lambda _u, _t: (429, b""))
        assert exc.value.code == "rate_limited"


class TestPairingHelpers:
    def test_build_device_type(self) -> None:
        assert build_device_type("my agent!!", "host name") == "my-agent#host-name"
        assert build_device_type("a" * 30, "b" * 30) == "a" * 20 + "#" + "b" * 19


class TestLightCommand:
    def test_brightness_implies_on_and_kelvin_is_clamped(self) -> None:
        body = build_light_update(
            LightCommand(brightness=50, kelvin=10000, transition_ms=400),
            {"id": "l", "type": "light", "color_temperature": {"mirek": 300, "mirek_schema": {"mirek_minimum": 153, "mirek_maximum": 500}}},
        )
        assert body["on"] == {"on": True} and body["dimming"] == {"brightness": 50}
        assert body["color_temperature"] == {"mirek": 153} and body["dynamics"] == {"duration": 400}

    def test_explicit_off_wins(self) -> None:
        body = build_light_update(LightCommand(on=False, hex="#00ff00"))
        assert body["on"] == {"on": False} and "xy" in body["color"]


class TestIndex:
    def test_deep_merge_and_apply(self) -> None:
        assert deep_merge({"a": {"b": 1, "c": [1]}, "d": 2}, {"a": {"c": [2], "e": 3}}) == {"a": {"b": 1, "c": [2], "e": 3}, "d": 2}
        idx = ResourceIndex()
        idx.replace_all([{"id": "l1", "type": "light", "owner": {"rid": "d1", "rtype": "device"}, "on": {"on": False}}])
        idx.apply({"id": "e", "creationtime": "t", "type": "update", "data": [{"id": "l1", "type": "light", "on": {"on": True}}]})
        assert idx.get("light", "l1")["on"] == {"on": True}  # type: ignore[index]
        idx.apply({"id": "e2", "creationtime": "t", "type": "add", "data": [{"id": "m1", "type": "motion", "owner": {"rid": "d1", "rtype": "device"}}]})
        assert len(idx.owned_by("d1")) == 2
        idx.apply({"id": "e3", "creationtime": "t", "type": "delete", "data": [{"id": "m1", "type": "motion"}]})
        assert len(idx.owned_by("d1")) == 1


class TestCredentials:
    def test_env_overrides_store(self) -> None:
        store = MemoryCredentialStore()
        store.save(BridgeCredentials(bridge_id="abc", host="1.2.3.4", application_key="k", fingerprint="AABB", device_type="x#y"))
        from_store = resolve_connection(store=store, env={})
        assert from_store is not None and from_store.source == "store" and from_store.tls.fingerprint == "AABB"
        from_env = resolve_connection(store=store, env={"HUE_BRIDGE_HOST": "9.9.9.9", "HUE_APPLICATION_KEY": "envkey", "HUE_TLS_INSECURE": "1"})
        assert from_env is not None and from_env.source == "env" and from_env.credentials.host == "9.9.9.9" and from_env.tls.insecure
        assert resolve_connection(store=MemoryCredentialStore(), env={}) is None

    def test_redact_secrets(self) -> None:
        out = redact_secrets({"a": "key=SECRETKEY123", "b": ["SECRETKEY123", {"c": "x"}]}, ["SECRETKEY123", "short"])
        assert out == {"a": "key=<redacted>", "b": ["<redacted>", {"c": "x"}]}
