"""hue_sdk: device-centric Philips Hue SDK (CLIP v2) for humans and agents.

Typical flow::

    from hue_sdk import discover_bridges, pair_bridge, FileCredentialStore, HueBridge

    found = discover_bridges()[0]
    creds = pair_bridge(found.host, app_name="my-agent")   # press the link button
    FileCredentialStore().save(creds)

    bridge = HueBridge.connect(creds)
    for device in bridge.devices:
        print(device.name, device.kind, device.sensors())
    bridge.resolve_light("Desk lamp").turn_on(brightness=40, kelvin=2700)
    print(bridge.snapshot().to_dict())      # everything as plain data
"""

from .client import HueClient
from .color import GAMUT_C, RGB, kelvin_to_mirek, light_level_to_lux, mirek_to_kelvin, parse_hex_color, rgb_to_xy, xy_to_rgb
from .credentials import (
    CredentialStore,
    FileCredentialStore,
    MemoryCredentialStore,
    ResolvedConnection,
    default_credentials_path,
    resolve_connection,
)
from .discovery import (
    DiscoveredBridge,
    DiscoveryReport,
    discover_bridges,
    discover_bridges_detailed,
    discover_via_cloud,
    discover_via_mdns,
    fetch_bridge_config,
    identify_bridge,
)
from .errors import HueError, HueErrorCode, LinkButtonNotPressedError, PairingTimeoutError, TlsError
from .events import HueEventStream, SseParser, parse_hue_events
from .model import (
    BatteryState,
    BridgeInfo,
    ChangeEvent,
    DeviceKind,
    DeviceSnapshot,
    GroupRef,
    GroupSnapshot,
    HomeSnapshot,
    HueBridge,
    HueDevice,
    HueGroup,
    HueLight,
    HueScene,
    LightCommand,
    LightSnapshot,
    ResourceIndex,
    SceneSnapshot,
    SensorSnapshot,
    build_light_update,
)
from .pairing import BridgeCredentials, PairingProgress, build_device_type, pair_bridge, pair_once
from .tls import CertificateSummary, TlsOptions, normalize_fingerprint, summarize_certificate, verify_bridge_certificate
from .transport import HttpTransport, TransportResponse
from .types import SENSOR_SERVICE_TYPES, BridgeConfig, HueEvent, Resource, ResourceIdentifier

__version__ = "0.1.0"

__all__ = [
    "GAMUT_C",
    "RGB",
    "SENSOR_SERVICE_TYPES",
    "BatteryState",
    "BridgeConfig",
    "BridgeCredentials",
    "BridgeInfo",
    "CertificateSummary",
    "ChangeEvent",
    "CredentialStore",
    "DeviceKind",
    "DeviceSnapshot",
    "DiscoveredBridge",
    "DiscoveryReport",
    "FileCredentialStore",
    "GroupRef",
    "GroupSnapshot",
    "HomeSnapshot",
    "HttpTransport",
    "HueBridge",
    "HueClient",
    "HueDevice",
    "HueError",
    "HueErrorCode",
    "HueEvent",
    "HueEventStream",
    "HueGroup",
    "HueLight",
    "HueScene",
    "LightCommand",
    "LightSnapshot",
    "LinkButtonNotPressedError",
    "MemoryCredentialStore",
    "PairingProgress",
    "PairingTimeoutError",
    "ResolvedConnection",
    "Resource",
    "ResourceIdentifier",
    "ResourceIndex",
    "SceneSnapshot",
    "SensorSnapshot",
    "SseParser",
    "TlsError",
    "TlsOptions",
    "TransportResponse",
    "build_device_type",
    "build_light_update",
    "default_credentials_path",
    "discover_bridges",
    "discover_bridges_detailed",
    "discover_via_cloud",
    "discover_via_mdns",
    "fetch_bridge_config",
    "identify_bridge",
    "kelvin_to_mirek",
    "light_level_to_lux",
    "mirek_to_kelvin",
    "normalize_fingerprint",
    "pair_bridge",
    "pair_once",
    "parse_hex_color",
    "parse_hue_events",
    "resolve_connection",
    "rgb_to_xy",
    "summarize_certificate",
    "verify_bridge_certificate",
    "xy_to_rgb",
]
