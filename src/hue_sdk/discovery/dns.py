"""Tiny DNS wire-format encoder/decoder, just enough for mDNS service discovery
(PTR / SRV / TXT / A / AAAA with name compression)."""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any

TYPE_A = 1
TYPE_PTR = 12
TYPE_TXT = 16
TYPE_AAAA = 28
TYPE_SRV = 33
CLASS_IN = 1
QU_FLAG = 0x8000
"""'QU' bit: ask the responder to reply via unicast to the sender's port."""


@dataclass(slots=True)
class DnsQuestion:
    name: str
    type: int
    unicast_response: bool = False


@dataclass(slots=True)
class DnsRecord:
    #: One of ``PTR``, ``SRV``, ``TXT``, ``A``, ``AAAA``, ``OTHER``.
    kind: str
    name: str
    type: int
    ttl: int
    #: ``str`` for PTR/A/AAAA, ``dict`` for SRV (priority, weight, port, target) and TXT, ``bytes`` otherwise.
    data: Any


@dataclass(slots=True)
class DnsMessage:
    id: int
    is_response: bool
    questions: list[DnsQuestion] = field(default_factory=list)
    answers: list[DnsRecord] = field(default_factory=list)
    authorities: list[DnsRecord] = field(default_factory=list)
    additionals: list[DnsRecord] = field(default_factory=list)


def encode_name(name: str) -> bytes:
    out = bytearray()
    for label in name.rstrip(".").split("."):
        if not label:
            continue
        raw = label.encode("utf-8")
        if len(raw) > 63:
            raise ValueError(f"DNS label too long: {label}")
        out.append(len(raw))
        out += raw
    out.append(0)
    return bytes(out)


def encode_query(questions: list[DnsQuestion], msg_id: int = 0) -> bytes:
    out = bytearray(struct.pack(">HHHHHH", msg_id, 0, len(questions), 0, 0, 0))
    for q in questions:
        out += encode_name(q.name)
        out += struct.pack(">HH", q.type, CLASS_IN | (QU_FLAG if q.unicast_response else 0))
    return bytes(out)


def decode_name(buf: bytes, offset: int) -> tuple[str, int]:
    labels: list[str] = []
    pos = offset
    nxt = -1
    hops = 0
    while True:
        if pos >= len(buf):
            raise ValueError("DNS name overflows message")
        length = buf[pos]
        if length == 0:
            pos += 1
            break
        if length & 0xC0 == 0xC0:
            if pos + 1 >= len(buf):
                raise ValueError("DNS pointer overflows message")
            pointer = ((length & 0x3F) << 8) | buf[pos + 1]
            if nxt == -1:
                nxt = pos + 2
            pos = pointer
            hops += 1
            if hops > 64:
                raise ValueError("DNS name compression loop")
            continue
        labels.append(buf[pos + 1 : pos + 1 + length].decode("utf-8", "replace"))
        pos += 1 + length
    return ".".join(labels), (pos if nxt == -1 else nxt)


def _decode_record(buf: bytes, name: str, rtype: int, ttl: int, start: int, end: int) -> DnsRecord:
    if rtype == TYPE_PTR:
        return DnsRecord("PTR", name, rtype, ttl, decode_name(buf, start)[0])
    if rtype == TYPE_SRV:
        priority, weight, port = struct.unpack(">HHH", buf[start : start + 6])
        return DnsRecord("SRV", name, rtype, ttl, {"priority": priority, "weight": weight, "port": port, "target": decode_name(buf, start + 6)[0]})
    if rtype == TYPE_TXT:
        data: dict[str, str] = {}
        p = start
        while p < end:
            length = buf[p]
            entry = buf[p + 1 : p + 1 + length].decode("utf-8", "replace")
            p += 1 + length
            if not entry:
                continue
            key, sep, value = entry.partition("=")
            data[key.lower()] = value if sep else ""
        return DnsRecord("TXT", name, rtype, ttl, data)
    if rtype == TYPE_A and end - start == 4:
        return DnsRecord("A", name, rtype, ttl, ".".join(str(b) for b in buf[start:end]))
    if rtype == TYPE_AAAA and end - start == 16:
        groups = [f"{(buf[i] << 8) | buf[i + 1]:x}" for i in range(start, end, 2)]
        return DnsRecord("AAAA", name, rtype, ttl, ":".join(groups))
    return DnsRecord("OTHER", name, rtype, ttl, bytes(buf[start:end]))


def decode_message(buf: bytes) -> DnsMessage:
    if len(buf) < 12:
        raise ValueError("DNS message too short")
    msg_id, flags, qd, an, ns, ar = struct.unpack(">HHHHHH", buf[:12])
    offset = 12
    msg = DnsMessage(id=msg_id, is_response=bool(flags & 0x8000))
    for _ in range(qd):
        name, nxt = decode_name(buf, offset)
        qtype, qclass = struct.unpack(">HH", buf[nxt : nxt + 4])
        msg.questions.append(DnsQuestion(name, qtype, bool(qclass & QU_FLAG)))
        offset = nxt + 4

    def read_records(count: int) -> list[DnsRecord]:
        nonlocal offset
        out: list[DnsRecord] = []
        for _ in range(count):
            name, nxt = decode_name(buf, offset)
            rtype, _cls, ttl, rdlen = struct.unpack(">HHIH", buf[nxt : nxt + 10])
            start, end = nxt + 10, nxt + 10 + rdlen
            if end > len(buf):
                raise ValueError("DNS record overflows message")
            out.append(_decode_record(buf, name, rtype, ttl, start, end))
            offset = end
        return out

    msg.answers = read_records(an)
    msg.authorities = read_records(ns)
    msg.additionals = read_records(ar)
    return msg
