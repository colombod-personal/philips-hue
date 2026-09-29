"""Bridge discovery: mDNS, the Signify cloud endpoint, and direct identification."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from ..errors import HueError
from .cloud import discover_via_cloud
from .identify import fetch_bridge_config, identify_bridge
from .mdns import discover_via_mdns
from .types import DiscoveredBridge, DiscoverySource

__all__ = [
    "DiscoveredBridge",
    "DiscoveryReport",
    "DiscoverySource",
    "discover_bridges",
    "discover_bridges_detailed",
    "discover_via_cloud",
    "discover_via_mdns",
    "fetch_bridge_config",
    "identify_bridge",
    "merge_bridges",
]

_RANK: dict[str, int] = {"mdns": 0, "manual": 1, "cloud": 2}


@dataclass(slots=True)
class DiscoveryReport:
    bridges: list[DiscoveredBridge]
    #: Per-method failures; discovery still returns whatever the other methods found.
    errors: dict[str, HueError] = field(default_factory=dict)


def merge_bridges(found: list[DiscoveredBridge]) -> list[DiscoveredBridge]:
    """Merges hits by bridge id, preferring mDNS (proves link-local reachability) over cloud."""
    by_id: dict[str, DiscoveredBridge] = {}
    for b in found:
        key = b.id.lower()
        existing = by_id.get(key)
        if existing is None:
            by_id[key] = b.copy_with(id=key)
            continue
        prefer_new = _RANK.get(b.sources[0], 2) < _RANK.get(existing.sources[0], 2)
        primary, secondary = (b, existing) if prefer_new else (existing, b)
        merged = primary.copy_with(id=key)
        merged.sources = list(dict.fromkeys([*primary.sources, *secondary.sources]))
        merged.name = primary.name or secondary.name
        merged.model_id = primary.model_id or secondary.model_id
        merged.config = primary.config or secondary.config
        merged.certificate = primary.certificate or secondary.certificate
        by_id[key] = merged
    return list(by_id.values())


def discover_bridges_detailed(
    *,
    methods: tuple[str, ...] = ("mdns", "cloud"),
    mdns_timeout_s: float = 3.0,
    cloud_timeout_s: float = 5.0,
    verify: bool = True,
) -> DiscoveryReport:
    """Runs the requested methods concurrently, merges by bridge id and (optionally) confirms each hit."""
    errors: dict[str, HueError] = {}
    tasks: dict[str, object] = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        if "mdns" in methods:
            tasks["mdns"] = pool.submit(discover_via_mdns, timeout_s=mdns_timeout_s)
        if "cloud" in methods:
            tasks["cloud"] = pool.submit(discover_via_cloud, timeout_s=cloud_timeout_s)
        found: list[DiscoveredBridge] = []
        for name, fut in tasks.items():
            try:
                found.extend(fut.result())  # type: ignore[attr-defined]
            except HueError as err:
                errors[name] = err
            except Exception as err:
                errors[name] = HueError("discovery_failed", str(err))
    merged = merge_bridges(found)
    if verify:
        for bridge in merged:
            try:
                config, certificate = fetch_bridge_config(bridge.host, port=bridge.port)
            except HueError:
                continue  # leave unverified; caller can still try
            bridge.config = config
            bridge.name = config.get("name")
            bridge.model_id = config.get("modelid")
            bridge.certificate = certificate
            reported = str(config.get("bridgeid", "")).lower()
            if reported and reported != bridge.id:
                bridge.id = reported  # cloud cache can be stale; trust the bridge itself
    return DiscoveryReport(bridges=merged, errors=errors)


def discover_bridges(**kwargs: object) -> list[DiscoveredBridge]:
    return discover_bridges_detailed(**kwargs).bridges  # type: ignore[arg-type]
