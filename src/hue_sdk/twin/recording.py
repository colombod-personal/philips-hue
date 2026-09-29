"""Digital-twin recording format.

A recording is everything needed to stand up a faithful local replica of a
bridge: its public config, the certificate it presented, every CLIP v2
resource, and the event stream captured over a period of time (each event
stamped with its offset from the start of the recording). The simulator
replays the events on the same timeline, so a motion sensor that fired at
+12.4 s in the real home fires at +12.4 s in the twin.

Recordings never contain application keys: the recorder strips them and the
simulator issues its own.
"""

from __future__ import annotations

import copy
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..tls import CertificateSummary
from ..types import BridgeConfig, HueEvent, Resource

RECORDING_VERSION = 1

EXCLUDED_RESOURCE_TYPES: frozenset[str] = frozenset({"auth_v1"})
"""Resource types that must never be persisted (credential-bearing)."""


@dataclass(slots=True)
class RecordedEvent:
    #: Milliseconds since the recording started.
    offset_ms: int
    event: HueEvent


@dataclass(slots=True)
class RecordedRequest:
    offset_ms: int
    method: str
    path: str
    body: Any = None
    status: int | None = None


@dataclass(slots=True)
class Recording:
    #: ``GET /api/0/config`` as the bridge reported it.
    config: BridgeConfig
    #: Full resource set at the start of the recording.
    resources: list[Resource]
    #: Event-stream events in chronological order.
    events: list[RecordedEvent] = field(default_factory=list)
    #: Total capture length in ms.
    duration_ms: int = 0
    #: ISO timestamp of when the capture started.
    recorded_at: str = ""
    #: Free-form label, e.g. "office, weekday evening".
    label: str | None = None
    host: str | None = None
    certificate: CertificateSummary | None = None
    #: Writes the recording client performed, for reproducing sessions.
    requests: list[RecordedRequest] = field(default_factory=list)
    version: int = RECORDING_VERSION

    @property
    def bridge_id(self) -> str:
        return str(self.config.get("bridgeid", "")).lower()

    def to_dict(self) -> dict[str, Any]:
        out = asdict(self)
        return out

    def to_json(self, indent: int | None = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent) + "\n"

    def save(self, path: Path | str) -> None:
        Path(path).write_text(self.to_json(), encoding="utf-8")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Recording:
        if not is_recording(data):
            raise ValueError("not a hue-sdk recording")
        cert = data.get("certificate")
        return cls(
            version=int(data.get("version", RECORDING_VERSION)),
            config=data["config"],
            resources=list(data["resources"]),
            events=[RecordedEvent(int(e["offset_ms"]), e["event"]) for e in data.get("events", [])],
            duration_ms=int(data.get("duration_ms", 0)),
            recorded_at=str(data.get("recorded_at", "")),
            label=data.get("label"),
            host=data.get("host"),
            certificate=CertificateSummary.from_dict(cert) if isinstance(cert, dict) else None,
            requests=[RecordedRequest(int(r["offset_ms"]), r["method"], r["path"], r.get("body"), r.get("status")) for r in data.get("requests", [])],
        )

    @classmethod
    def load(cls, path: Path | str) -> Recording:
        return cls.from_dict(json.loads(Path(path).read_text("utf-8")))

    def clone(self) -> Recording:
        return copy.deepcopy(self)


def is_recording(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("version") == RECORDING_VERSION
        and isinstance(value.get("config"), dict)
        and isinstance(value["config"].get("bridgeid"), str)
        and isinstance(value.get("resources"), list)
        and isinstance(value.get("events"), list)
    )


def redact_secrets(value: Any, secrets: list[str]) -> Any:
    """Replaces every occurrence of the given secrets in string values."""
    active = [s for s in secrets if s and len(s) >= 8]
    if not active:
        return value

    def walk(v: Any) -> Any:
        if isinstance(v, str):
            for s in active:
                v = v.replace(s, "<redacted>")
            return v
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v

    return walk(value)
