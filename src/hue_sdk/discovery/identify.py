"""Contact a bridge directly to confirm it is a Hue bridge, read its public
config (``GET /api/0/config``, no key required) and capture the TLS certificate
so it can be pinned."""

from __future__ import annotations

from ..errors import HueError
from ..tls import CertificateSummary, TlsOptions
from ..transport import HttpTransport
from ..types import BridgeConfig
from .types import DiscoveredBridge


def fetch_bridge_config(host: str, *, port: int | None = None, scheme: str = "https", timeout_s: float = 5.0) -> tuple[BridgeConfig, CertificateSummary | None]:
    """Fetches the unauthenticated bridge config. TLS is *not* verified here on purpose:
    this is the step that learns which certificate to trust."""
    transport = HttpTransport(host, port=port, scheme=scheme, tls=TlsOptions(insecure=True), timeout_s=timeout_s)
    try:
        res = transport.request("GET", "/api/0/config")
    finally:
        transport.close()
    if not isinstance(res.body, dict):
        raise HueError("invalid_response", f"{host} did not return JSON for /api/0/config; probably not a Hue bridge.", status=res.status)
    if not isinstance(res.body.get("bridgeid"), str):
        raise HueError("invalid_response", f"{host} answered /api/0/config but without a bridge id; probably not a Hue bridge.", details=res.body)
    config: BridgeConfig = res.body  # type: ignore[assignment]
    return config, transport.peer_certificate


def identify_bridge(host: str, *, port: int | None = None, scheme: str = "https", timeout_s: float = 5.0) -> DiscoveredBridge:
    """Builds a :class:`DiscoveredBridge` for a known host, confirming it is a bridge."""
    config, certificate = fetch_bridge_config(host, port=port, scheme=scheme, timeout_s=timeout_s)
    return DiscoveredBridge(
        id=config["bridgeid"].lower(),
        host=host,
        port=port if port is not None else (443 if scheme == "https" else 80),
        sources=["manual"],
        name=config.get("name"),
        model_id=config.get("modelid"),
        config=config,
        certificate=certificate,
    )
