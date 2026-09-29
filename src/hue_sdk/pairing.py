"""Pairing ("link button") flow.

The bridge only issues application keys to clients that prove physical access:
``POST /api`` succeeds solely within ~30 s of the round button on the bridge
being pressed; before that it answers with error type 101.

:func:`pair_bridge` identifies the bridge first (config + certificate), pins
that certificate for the pairing request itself, then polls until the key is
granted or the timeout elapses. The returned :class:`BridgeCredentials` carry
everything needed to reconnect securely later: host, application key, and the
certificate fingerprint.
"""

from __future__ import annotations

import re
import socket
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from .discovery.identify import fetch_bridge_config
from .errors import HueError, LinkButtonNotPressedError, PairingTimeoutError
from .tls import TlsOptions
from .transport import HttpTransport


@dataclass(slots=True)
class BridgeCredentials:
    #: Bridge id, lower-cased hex.
    bridge_id: str
    host: str
    #: The ``hue-application-key`` (a.k.a. v1 "username"). Treat as a secret.
    application_key: str
    port: int = 443
    scheme: str = "https"
    #: PSK for the Entertainment (DTLS) API when requested. Treat as a secret.
    client_key: str | None = None
    #: SHA-256 fingerprint of the bridge certificate at pairing time; used for pinning.
    fingerprint: str | None = None
    name: str | None = None
    model_id: str | None = None
    #: ISO timestamp.
    paired_at: str = ""
    #: The ``devicetype`` value the key was issued to.
    device_type: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def redacted(self) -> dict[str, Any]:
        out = self.to_dict()
        out["application_key"] = "<redacted>"
        if out.get("client_key"):
            out["client_key"] = "<redacted>"
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BridgeCredentials:
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass(slots=True)
class PairingProgress:
    attempt: int
    elapsed_s: float
    remaining_s: float


def build_device_type(app_name: str = "hue-sdk", instance_name: str | None = None) -> str:
    """``application_name#devicename`` (max 20 + 19 chars), as the bridge requires."""

    def sanitize(value: str) -> str:
        return re.sub(r"^-+|-+$", "", re.sub(r"[^\w.-]+", "-", value))

    app = sanitize(app_name)[:20] or "hue-sdk"
    inst = sanitize(instance_name or socket.gethostname())[:19] or "default"
    return f"{app}#{inst}"


def pair_once(transport: HttpTransport, device_type: str, *, generate_client_key: bool = True) -> tuple[str, str | None]:
    """Single pairing attempt. Raises :class:`LinkButtonNotPressedError` when the button has not been pressed yet."""
    res = transport.request("POST", "/api", body={"devicetype": device_type, "generateclientkey": generate_client_key})
    body = res.body
    if not isinstance(body, list) or not body:
        raise HueError("invalid_response", "Unexpected pairing response from bridge.", status=res.status, details=body)
    first = body[0] if isinstance(body[0], dict) else {}
    success = first.get("success")
    if isinstance(success, dict) and isinstance(success.get("username"), str):
        return success["username"], success.get("clientkey")
    error = first.get("error")
    if isinstance(error, dict):
        if error.get("type") == 101:
            raise LinkButtonNotPressedError(error)
        description = error.get("description") or f"error {error.get('type')}"
        raise HueError("bridge_error", f"Bridge refused pairing: {description}", status=res.status, details=error)
    raise HueError("invalid_response", "Unexpected pairing response from bridge.", status=res.status, details=body)


def pair_bridge(
    host: str,
    *,
    port: int | None = None,
    scheme: str = "https",
    app_name: str = "hue-sdk",
    instance_name: str | None = None,
    generate_client_key: bool = True,
    timeout_s: float = 60.0,
    interval_s: float = 2.0,
    on_waiting: Callable[[PairingProgress], None] | None = None,
    tls: TlsOptions | None = None,
) -> BridgeCredentials:
    """Full pairing flow: identify -> pin certificate -> poll ``POST /api`` until the link button is pressed."""
    port = port if port is not None else (443 if scheme == "https" else 80)
    device_type = build_device_type(app_name, instance_name)
    config, certificate = fetch_bridge_config(host, port=port, scheme=scheme)
    if tls is None:
        tls = TlsOptions(fingerprint=certificate.fingerprint256) if certificate else TlsOptions(insecure=True)
    transport = HttpTransport(host, port=port, scheme=scheme, tls=tls)
    started = time.monotonic()
    attempt = 0
    try:
        while True:
            attempt += 1
            try:
                application_key, client_key = pair_once(transport, device_type, generate_client_key=generate_client_key)
            except LinkButtonNotPressedError:
                elapsed = time.monotonic() - started
                remaining = timeout_s - elapsed
                if remaining <= 0:
                    raise PairingTimeoutError(timeout_s) from None
                if on_waiting:
                    on_waiting(PairingProgress(attempt=attempt, elapsed_s=elapsed, remaining_s=remaining))
                time.sleep(min(interval_s, remaining))
                continue
            return BridgeCredentials(
                bridge_id=str(config["bridgeid"]).lower(),
                host=host,
                port=port,
                scheme=scheme,
                application_key=application_key,
                client_key=client_key,
                fingerprint=certificate.fingerprint256 if certificate else None,
                name=config.get("name"),
                model_id=config.get("modelid"),
                paired_at=datetime.now(UTC).isoformat(),
                device_type=device_type,
            )
    finally:
        transport.close()
