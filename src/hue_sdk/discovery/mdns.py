"""mDNS (DNS-SD) discovery of Hue bridges advertising ``_hue._tcp.local``.

Implemented on plain sockets with no dependencies. Notes for real networks:

- mDNS is link-local multicast; it never crosses routers/VLANs and fails
  silently (empty result) inside many containers. Combine with cloud discovery
  or a manual host for those cases.
- We ask for unicast responses (QU bit) so replies reach an ephemeral port even
  when port 5353 is owned by avahi/Bonjour; when we *can* bind 5353 we also
  join the multicast group to catch multicast replies.
"""

from __future__ import annotations

import select
import socket
import struct
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from .dns import TYPE_A, TYPE_PTR, TYPE_SRV, TYPE_TXT, DnsQuestion, DnsRecord, decode_message, encode_query
from .types import DiscoveredBridge

HUE_SERVICE = "_hue._tcp.local"
MDNS_ADDR = "224.0.0.251"
MDNS_PORT = 5353


@dataclass(slots=True)
class _Candidate:
    instance: str
    target: str | None = None
    port: int | None = None
    txt: dict[str, str] = field(default_factory=dict)


def _open_socket(interface_address: str | None) -> socket.socket:
    def attempt(port: int) -> socket.socket:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass
        sock.bind((interface_address or "0.0.0.0", port))
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        if port == MDNS_PORT:
            try:
                mreq = struct.pack("4s4s", socket.inet_aton(MDNS_ADDR), socket.inet_aton(interface_address or "0.0.0.0"))
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            except OSError:
                pass
        return sock

    try:
        return attempt(MDNS_PORT)
    except OSError:
        return attempt(0)


def discover_via_mdns(
    *,
    timeout_s: float = 3.0,
    query_interval_s: float = 1.0,
    interface_address: str | None = None,
    on_record: Callable[[DnsRecord, str], None] | None = None,
) -> list[DiscoveredBridge]:
    sock = _open_socket(interface_address)
    candidates: dict[str, _Candidate] = {}
    addresses: dict[str, list[str]] = {}

    def send(questions: list[DnsQuestion]) -> None:
        try:
            sock.sendto(encode_query(questions), (MDNS_ADDR, MDNS_PORT))
        except OSError:
            pass

    def ask_details(instance: str) -> None:
        send([DnsQuestion(instance, TYPE_SRV, True), DnsQuestion(instance, TYPE_TXT, True)])

    deadline = time.monotonic() + timeout_s
    next_query = 0.0
    try:
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            if now >= next_query:
                send([DnsQuestion(HUE_SERVICE, TYPE_PTR, True)])
                next_query = now + query_interval_s
            ready, _, _ = select.select([sock], [], [], min(0.2, deadline - now))
            if not ready:
                continue
            try:
                data, (addr, _port) = sock.recvfrom(9000)
                msg = decode_message(data)
            except (OSError, ValueError):
                continue
            if not msg.is_response:
                continue
            for rec in [*msg.answers, *msg.additionals]:
                if on_record:
                    on_record(rec, addr)
                name = rec.name.lower()
                if rec.kind == "PTR" and name == HUE_SERVICE:
                    instance = str(rec.data).lower()
                    if instance not in candidates:
                        candidates[instance] = _Candidate(instance)
                        ask_details(str(rec.data))
                elif rec.kind == "SRV" and name in candidates:
                    c = candidates[name]
                    c.target = str(rec.data["target"]).lower()
                    c.port = int(rec.data["port"])
                    if c.target not in addresses:
                        send([DnsQuestion(str(rec.data["target"]), TYPE_A, True)])
                elif rec.kind == "TXT" and name in candidates:
                    candidates[name].txt = dict(rec.data)
                elif rec.kind in ("A", "AAAA"):
                    addresses.setdefault(name, [])
                    if rec.data not in addresses[name]:
                        addresses[name].append(str(rec.data))
    finally:
        sock.close()

    results: list[DiscoveredBridge] = []
    for c in candidates.values():
        addrs = addresses.get(c.target or "", [])
        host = next((a for a in addrs if "." in a), addrs[0] if addrs else None)
        bridge_id = c.txt.get("bridgeid")
        if not host or not bridge_id:
            continue  # incomplete record set; another method may still find it
        suffix = f".{HUE_SERVICE}"
        results.append(
            DiscoveredBridge(
                id=bridge_id.lower(),
                host=host,
                port=c.port or 443,
                sources=["mdns"],
                name=c.instance[: -len(suffix)] if c.instance.endswith(suffix) else None,
                model_id=c.txt.get("modelid"),
            )
        )
    return results
