"""Cloud-assisted discovery via ``https://discovery.meethue.com/``.

Each bridge periodically reports its LAN address to Signify; the endpoint
returns the bridges registered from the caller's public IP. It answers ``[]``
when the bridge and the caller are behind different public IPs and ``429`` when
polled too often (Signify suggests at most once per 15 minutes).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable

from ..errors import HueError
from .types import DiscoveredBridge

CLOUD_DISCOVERY_URL = "https://discovery.meethue.com/"

Fetcher = Callable[[str, float], tuple[int, bytes]]


def _default_fetch(url: str, timeout_s: float) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "hue-sdk"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as res:
            return int(res.status), bytes(res.read())
    except urllib.error.HTTPError as err:
        return int(err.code), b""


def discover_via_cloud(*, timeout_s: float = 5.0, url: str = CLOUD_DISCOVERY_URL, fetch: Fetcher = _default_fetch) -> list[DiscoveredBridge]:
    try:
        status, raw = fetch(url, timeout_s)
    except Exception as err:
        raise HueError("discovery_failed", f"Cloud discovery failed: {err}") from err
    if status == 429:
        raise HueError("rate_limited", "discovery.meethue.com rate limit hit; retry in a few minutes.", status=429)
    if status >= 400:
        raise HueError("discovery_failed", f"discovery.meethue.com responded with HTTP {status}.", status=status)
    try:
        payload = json.loads(raw or b"[]")
    except json.JSONDecodeError as err:
        raise HueError("invalid_response", "Unexpected payload from discovery.meethue.com.") from err
    if not isinstance(payload, list):
        raise HueError("invalid_response", "Unexpected payload from discovery.meethue.com.", details=payload)
    out: list[DiscoveredBridge] = []
    for entry in payload:
        if isinstance(entry, dict) and isinstance(entry.get("id"), str) and isinstance(entry.get("internalipaddress"), str):
            out.append(DiscoveredBridge(id=entry["id"].lower(), host=entry["internalipaddress"], port=int(entry.get("port", 443)), sources=["cloud"]))
    return out
