from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any, Literal

from ..tls import CertificateSummary
from ..types import BridgeConfig

DiscoverySource = Literal["mdns", "cloud", "manual"]


@dataclass(slots=True)
class DiscoveredBridge:
    #: Bridge id, 16 hex characters, lower-cased (e.g. ``001788fffe123456``).
    id: str
    #: IPv4/IPv6 address or hostname to reach the bridge.
    host: str
    port: int = 443
    #: Which methods reported this bridge.
    sources: list[str] = field(default_factory=list)
    #: Human readable name, when known (mDNS instance name or config name).
    name: str | None = None
    #: Bridge model id (BSB001 = v1 square, BSB002 = v2 round).
    model_id: str | None = None
    #: Populated when the bridge was contacted directly.
    config: BridgeConfig | None = None
    #: TLS certificate presented by the bridge, when contacted directly.
    certificate: CertificateSummary | None = None

    def copy_with(self, **changes: Any) -> DiscoveredBridge:
        out = replace(self, **changes)
        out.sources = list(self.sources)
        return out

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
