"""TLS handling for Hue bridges.

Hue bridges only speak HTTPS. Newer bridges carry a certificate issued by
Signify's private "root-bridge" CA whose subject CN is the bridge id; older
bridges still use a self-signed certificate. Neither validates against the
system trust store, so callers pick one of three strategies:

1. **Fingerprint pinning (recommended, trust-on-first-use).** Record the
   SHA-256 fingerprint of the certificate seen during pairing and refuse any
   other certificate afterwards. Works for self-signed and CA-signed bridges.
2. **CA + bridge id.** Provide the Signify Hue bridge root CA (PEM) and the
   bridge id; the chain is verified and the certificate CN must equal the
   bridge id. The CA PEM is published on the Hue developer portal (login
   required) and is intentionally not vendored here.
3. **Insecure.** Skip verification. Only for exploration and tests.

Any combination of 1 and 2 is allowed; all configured checks must pass.

Certificates are inspected with a minimal DER parser (subject/issuer CN and
validity) so the SDK stays dependency-free.
"""

from __future__ import annotations

import hashlib
import ssl
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from .errors import TlsError

_OID_CN = bytes.fromhex("550403")  # 2.5.4.3 commonName


@dataclass(slots=True)
class TlsOptions:
    #: SHA-256 fingerprint of the bridge leaf certificate (hex, colons optional, case-insensitive).
    fingerprint: str | None = None
    #: Bridge id (16 hex characters). When set, the certificate CN must match it.
    bridge_id: str | None = None
    #: PEM encoded CA bundle used to verify the certificate chain.
    ca: str | None = None
    #: Skip all verification. Never use in production.
    insecure: bool = False

    def is_unverified(self) -> bool:
        return self.insecure or not (self.fingerprint or self.ca or self.bridge_id)


def normalize_fingerprint(fp: str) -> str:
    """Normalises a fingerprint so ``AB:CD`` and ``abcd`` compare equal."""
    return "".join(c for c in fp if c in "0123456789abcdefABCDEF").upper()


def fingerprint_of(der: bytes) -> str:
    return hashlib.sha256(der).hexdigest().upper()


@dataclass(slots=True)
class ParsedCertificate:
    subject_cn: str | None
    issuer_cn: str | None
    not_before: datetime | None
    not_after: datetime | None


@dataclass(slots=True)
class CertificateSummary:
    subject_cn: str | None
    issuer_cn: str | None
    fingerprint256: str
    valid_from: str | None
    valid_to: str | None
    self_signed: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CertificateSummary:
        return cls(
            subject_cn=data.get("subject_cn"),
            issuer_cn=data.get("issuer_cn"),
            fingerprint256=normalize_fingerprint(str(data.get("fingerprint256", ""))),
            valid_from=data.get("valid_from"),
            valid_to=data.get("valid_to"),
            self_signed=bool(data.get("self_signed", False)),
        )


# ---------- minimal DER walker ----------


def _tlv(buf: bytes, pos: int) -> tuple[int, int, int]:
    """Returns (tag, content_start, content_end) for the TLV at ``pos``."""
    if pos + 2 > len(buf):
        raise ValueError("DER truncated")
    tag = buf[pos]
    length = buf[pos + 1]
    pos += 2
    if length & 0x80:
        n = length & 0x7F
        if n == 0 or n > 4 or pos + n > len(buf):
            raise ValueError("DER bad length")
        length = int.from_bytes(buf[pos : pos + n], "big")
        pos += n
    if pos + length > len(buf):
        raise ValueError("DER truncated content")
    return tag, pos, pos + length


def _children(buf: bytes, start: int, end: int) -> list[tuple[int, int, int]]:
    out: list[tuple[int, int, int]] = []
    pos = start
    while pos < end:
        tag, cstart, cend = _tlv(buf, pos)
        out.append((tag, cstart, cend))
        pos = cend
    return out


def _name_cn(buf: bytes, start: int, end: int) -> str | None:
    # Name ::= SEQUENCE OF SET OF SEQUENCE { OID, value }
    for _tag, sstart, send in _children(buf, start, end):
        for _t2, astart, aend in _children(buf, sstart, send):
            parts = _children(buf, astart, aend)
            if len(parts) >= 2:
                oid_tag, ostart, oend = parts[0]
                if oid_tag == 0x06 and buf[ostart:oend] == _OID_CN:
                    _vt, vstart, vend = parts[1]
                    return buf[vstart:vend].decode("utf-8", "replace")
    return None


def _time(buf: bytes, tag: int, start: int, end: int) -> datetime | None:
    raw = buf[start:end].decode("ascii", "replace")
    try:
        if tag == 0x17:  # UTCTime YYMMDDHHMMSSZ
            dt = datetime.strptime(raw, "%y%m%d%H%M%SZ")
        elif tag == 0x18:  # GeneralizedTime YYYYMMDDHHMMSSZ
            dt = datetime.strptime(raw[:14] + "Z", "%Y%m%d%H%M%SZ")
        else:
            return None
    except ValueError:
        return None
    return dt.replace(tzinfo=UTC)


def parse_certificate(der: bytes) -> ParsedCertificate:
    """Extracts subject CN, issuer CN and validity from a DER X.509 certificate."""
    _tag, cstart, _cend = _tlv(der, 0)  # Certificate
    tbs_tag, tstart, tend = _tlv(der, cstart)  # tbsCertificate
    if tbs_tag != 0x30:
        raise ValueError("not an X.509 certificate")
    fields = _children(der, tstart, tend)
    idx = 0
    if fields and fields[0][0] == 0xA0:  # explicit version
        idx = 1
    # serial, signature algorithm, issuer, validity, subject
    issuer = fields[idx + 2]
    validity = fields[idx + 3]
    subject = fields[idx + 4]
    times = _children(der, validity[1], validity[2])
    not_before = _time(der, *times[0]) if len(times) > 0 else None
    not_after = _time(der, *times[1]) if len(times) > 1 else None
    return ParsedCertificate(
        subject_cn=_name_cn(der, subject[1], subject[2]),
        issuer_cn=_name_cn(der, issuer[1], issuer[2]),
        not_before=not_before,
        not_after=not_after,
    )


def summarize_certificate(der: bytes) -> CertificateSummary:
    try:
        parsed = parse_certificate(der)
    except (ValueError, IndexError):
        parsed = ParsedCertificate(None, None, None, None)
    return CertificateSummary(
        subject_cn=parsed.subject_cn,
        issuer_cn=parsed.issuer_cn,
        fingerprint256=fingerprint_of(der),
        valid_from=parsed.not_before.isoformat() if parsed.not_before else None,
        valid_to=parsed.not_after.isoformat() if parsed.not_after else None,
        self_signed=parsed.subject_cn is not None and parsed.subject_cn == parsed.issuer_cn,
    )


def verify_bridge_certificate(der: bytes | None, options: TlsOptions) -> TlsError | None:
    """Returns ``None`` when the certificate satisfies the configured checks, else a ``TlsError``."""
    if options.insecure:
        return None
    if not der:
        return TlsError("Bridge did not present a certificate.")
    if options.fingerprint:
        expected = normalize_fingerprint(options.fingerprint)
        actual = fingerprint_of(der)
        if expected != actual:
            return TlsError(
                f"Bridge certificate fingerprint mismatch (expected {expected}, got {actual}). "
                "The bridge certificate changed or you are talking to a different device. Re-pair to trust the new certificate."
            )
    if options.bridge_id:
        try:
            cn = parse_certificate(der).subject_cn
        except (ValueError, IndexError):
            cn = None
        if (cn or "").lower() != options.bridge_id.lower():
            return TlsError(f'Bridge certificate CN "{cn or ""}" does not match bridge id "{options.bridge_id}".')
    return None


def build_ssl_context(options: TlsOptions) -> ssl.SSLContext:
    """SSL context for a bridge connection. Chain verification only when a CA is given;
    pinning and CN checks are applied by the transport after the handshake."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False  # the CN is the bridge id, never the IP we connect to
    if options.ca and not options.insecure:
        ctx.load_verify_locations(cadata=options.ca)
        ctx.verify_mode = ssl.CERT_REQUIRED
    else:
        ctx.verify_mode = ssl.CERT_NONE
    return ctx
