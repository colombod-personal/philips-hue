"""Resource-level CLIP v2 client: thin, typed access to ``/clip/v2/resource/{type}[/{id}]``
plus the event stream.

Prefer :class:`hue_sdk.HueBridge` for a device-centric view; use this class when
you need raw resources or endpoints the model does not wrap.
"""

from __future__ import annotations

import builtins
import threading
import time
from collections.abc import Callable
from typing import Any, TypeVar

from .errors import HueError
from .events import HueEventStream
from .pairing import BridgeCredentials
from .tls import TlsOptions
from .transport import HttpTransport
from .types import BridgeConfig, Resource, ResourceIdentifier

T = TypeVar("T")


class _Gate:
    """Serialises calls so consecutive ones are at least ``interval_s`` apart."""

    def __init__(self, interval_s: float) -> None:
        self._interval = interval_s
        self._last = 0.0
        self._lock = threading.Lock()

    def run(self, fn: Callable[[], T]) -> T:
        with self._lock:
            wait = self._last + self._interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            return fn()


class HueClient:
    def __init__(
        self,
        host: str,
        *,
        port: int | None = None,
        scheme: str = "https",
        tls: TlsOptions | None = None,
        application_key: str | None = None,
        bridge_id: str | None = None,
        timeout_s: float = 10.0,
        light_write_interval_s: float = 0.1,
        group_write_interval_s: float = 1.0,
    ) -> None:
        tls = tls or TlsOptions()
        if bridge_id and tls.ca and not tls.bridge_id:
            tls.bridge_id = bridge_id
        self.transport = HttpTransport(host, port=port, scheme=scheme, tls=tls, timeout_s=timeout_s, application_key=application_key)
        self.bridge_id = bridge_id.lower() if bridge_id else None
        self._light_gate = _Gate(light_write_interval_s)
        self._group_gate = _Gate(group_write_interval_s)

    @classmethod
    def from_credentials(cls, creds: BridgeCredentials, *, tls: TlsOptions | None = None, **kwargs: Any) -> HueClient:
        """Builds a client from stored credentials, pinning the certificate seen at pairing time."""
        tls = tls or TlsOptions()
        if creds.fingerprint and not tls.fingerprint and not tls.ca and not tls.insecure:
            tls.fingerprint = creds.fingerprint
        return cls(creds.host, port=creds.port, scheme=creds.scheme, tls=tls, application_key=creds.application_key, bridge_id=creds.bridge_id, **kwargs)

    @property
    def host(self) -> str:
        return self.transport.host

    def close(self) -> None:
        self.transport.close()

    # ---------- endpoints ----------

    def get_config(self) -> BridgeConfig:
        """Unauthenticated bridge config (name, model, firmware, bridge id)."""
        res = self.transport.request("GET", "/api/0/config")
        if res.status != 200 or not isinstance(res.body, dict):
            raise self._error_from_status(res.status, res.body, "GET /api/0/config")
        return res.body  # type: ignore[return-value]

    def list_all(self) -> builtins.list[Resource]:
        """Every resource on the bridge in one call (``GET /clip/v2/resource``)."""
        return self._clip("GET", "/clip/v2/resource")

    def list(self, rtype: str) -> builtins.list[Resource]:
        return self._clip("GET", f"/clip/v2/resource/{rtype}")

    def get(self, rtype: str, rid: str) -> Resource:
        data = self._clip("GET", f"/clip/v2/resource/{rtype}/{rid}")
        if not data:
            raise HueError("not_found", f"{rtype} {rid} not found.", status=404)
        first: Resource = data[0]
        return first

    def update(self, rtype: str, rid: str, body: dict[str, Any]) -> builtins.list[ResourceIdentifier]:
        """``PUT`` a partial update. Returns the identifiers of the updated resources."""

        def run() -> builtins.list[ResourceIdentifier]:
            return self._clip("PUT", f"/clip/v2/resource/{rtype}/{rid}", body)  # type: ignore[return-value]

        if rtype == "light":
            return self._light_gate.run(run)
        if rtype == "grouped_light":
            return self._group_gate.run(run)
        return run()

    def create(self, rtype: str, body: dict[str, Any]) -> builtins.list[ResourceIdentifier]:
        return self._clip("POST", f"/clip/v2/resource/{rtype}", body)  # type: ignore[return-value]

    def delete(self, rtype: str, rid: str) -> builtins.list[ResourceIdentifier]:
        return self._clip("DELETE", f"/clip/v2/resource/{rtype}/{rid}")  # type: ignore[return-value]

    def events(self, **options: Any) -> HueEventStream:
        """Creates (but does not start) an event stream subscription."""
        return HueEventStream(self.transport, **options)

    # ---------- internals ----------

    def _clip(self, method: str, path: str, body: Any = None) -> builtins.list[Resource]:
        res = self.transport.request(method, path, body=body)
        payload = res.body
        if res.status >= 400 or not isinstance(payload, dict):
            raise self._error_from_status(res.status, payload, f"{method} {path}")
        errors = payload.get("errors")
        if isinstance(errors, list) and errors:
            description = "; ".join(str(e.get("description", "")) for e in errors if isinstance(e, dict))
            raise HueError("bridge_error", f"Bridge reported an error for {method} {path}: {description}", status=res.status, details=errors)
        data = payload.get("data")
        return data if isinstance(data, list) else []

    @staticmethod
    def _error_from_status(status: int, body: Any, context: str) -> HueError:
        description = ""
        if isinstance(body, dict) and isinstance(body.get("errors"), list) and body["errors"]:
            description = ": " + "; ".join(str(e.get("description", "")) for e in body["errors"] if isinstance(e, dict))
        elif isinstance(body, str) and 0 < len(body) < 200:
            description = f": {body}"
        if status in (401, 403):
            return HueError("unauthorized", f"Bridge rejected the application key for {context}{description}. Re-pair the bridge.", status=status, details=body)
        if status == 404:
            return HueError("not_found", f"Resource not found for {context}{description}.", status=status, details=body)
        if status == 429:
            return HueError("rate_limited", f"Bridge is rate limiting {context}{description}. Slow down writes.", status=status, details=body)
        if status in (400, 405, 406, 409):
            return HueError("bad_request", f"Bridge rejected {context}{description}.", status=status, details=body)
        return HueError("bridge_error", f"Bridge returned HTTP {status} for {context}{description}.", status=status, details=body)
