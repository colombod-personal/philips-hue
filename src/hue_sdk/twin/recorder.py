"""Records a real bridge into a :class:`Recording`: config + certificate, the
full resource set, and the event stream for ``duration_s``."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from ..client import HueClient
from ..discovery.identify import fetch_bridge_config
from ..pairing import BridgeCredentials
from ..tls import TlsOptions
from ..types import HueEvent
from .recording import EXCLUDED_RESOURCE_TYPES, RecordedEvent, Recording, redact_secrets


def record_bridge(
    creds: BridgeCredentials,
    *,
    duration_s: float = 60.0,
    label: str | None = None,
    tls: TlsOptions | None = None,
    stop: threading.Event | None = None,
    on_event: Callable[[RecordedEvent], None] | None = None,
    on_status: Callable[[str], None] | None = None,
    secrets: list[str] | None = None,
) -> Recording:
    """Captures the bridge. ``duration_s = 0`` captures state only. Set ``stop`` to end the capture early."""
    client = HueClient.from_credentials(creds, tls=tls)
    to_scrub = [creds.application_key, *([creds.client_key] if creds.client_key else []), *(secrets or [])]
    status = on_status or (lambda _m: None)
    try:
        status(f"Reading bridge config from {creds.host}…")
        config, certificate = fetch_bridge_config(creds.host, port=creds.port, scheme=creds.scheme)
        status("Fetching all resources…")
        resources = [r for r in client.list_all() if r.get("type") not in EXCLUDED_RESOURCE_TYPES]
        recorded_at = datetime.now(UTC)
        events: list[RecordedEvent] = []
        if duration_s > 0:
            status(f"Capturing events for {duration_s:g} s…")
            started = time.monotonic()
            stream = client.events(reconnect=True)

            def capture(event: HueEvent) -> None:
                rec = RecordedEvent(offset_ms=int((time.monotonic() - started) * 1000), event=event)
                events.append(rec)
                if on_event:
                    on_event(rec)

            stream.on("event", capture)
            stream.on("error", lambda err: status(f"stream error: {err.message}"))
            stream.start()
            waiter = stop or threading.Event()
            waiter.wait(duration_s)
            stream.stop()
        recording = Recording(
            config=config,
            resources=resources,
            events=events,
            duration_ms=int(duration_s * 1000),
            recorded_at=recorded_at.isoformat(),
            label=label,
            host=creds.host,
            certificate=certificate,
        )
        scrubbed: dict[str, Any] = redact_secrets(recording.to_dict(), to_scrub)
        return Recording.from_dict(scrubbed)
    finally:
        client.close()
