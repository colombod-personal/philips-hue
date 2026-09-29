"""Credential persistence.

Application keys are bearer secrets: anyone holding one controls the bridge.
The default store writes a ``0600`` JSON file under the user's config
directory; agents/hosts can plug in their own :class:`CredentialStore`.

Environment variables override the store, which is convenient for containers
and CI::

    HUE_BRIDGE_HOST, HUE_APPLICATION_KEY, HUE_BRIDGE_ID (optional),
    HUE_BRIDGE_FINGERPRINT (optional, SHA-256), HUE_BRIDGE_PORT (optional),
    HUE_BRIDGE_SCHEME=http (optional, emulators), HUE_TLS_INSECURE=1 (optional),
    HUE_CA_FILE (optional PEM path), HUE_CREDENTIALS_FILE (optional store path)
"""

from __future__ import annotations

import builtins
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from .pairing import BridgeCredentials
from .tls import TlsOptions


class CredentialStore(Protocol):
    def save(self, creds: BridgeCredentials, *, make_default: bool = False) -> None: ...
    def get(self, bridge_id: str | None = None) -> BridgeCredentials | None: ...
    def remove(self, bridge_id: str) -> None: ...
    def list(self) -> builtins.list[BridgeCredentials]: ...


def default_credentials_path(env: Mapping[str, str] | None = None) -> Path:
    env = env if env is not None else os.environ
    if env.get("HUE_CREDENTIALS_FILE"):
        return Path(env["HUE_CREDENTIALS_FILE"])
    base = Path(env.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "hue-sdk" / "credentials.json"


class FileCredentialStore:
    """JSON file store: ``{"version": 1, "default": <bridge id>, "bridges": {<bridge id>: {...}}}``."""

    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else default_credentials_path()

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return {"version": 1, "bridges": {}}
        if not isinstance(data, dict) or not isinstance(data.get("bridges"), dict):
            return {"version": 1, "bridges": {}}
        return data

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.path.parent.chmod(0o700)
        except OSError:
            pass
        tmp = self.path.with_suffix(f".{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, self.path)

    def save(self, creds: BridgeCredentials, *, make_default: bool = False) -> None:
        data = self._load()
        data["bridges"][creds.bridge_id] = creds.to_dict()
        if make_default or not data.get("default"):
            data["default"] = creds.bridge_id
        self._write(data)

    def get(self, bridge_id: str | None = None) -> BridgeCredentials | None:
        data = self._load()
        bridges: dict[str, Any] = data["bridges"]
        key = bridge_id.lower() if bridge_id else (data.get("default") or next(iter(bridges), None))
        raw = bridges.get(key) if key else None
        return BridgeCredentials.from_dict(raw) if isinstance(raw, dict) else None

    def remove(self, bridge_id: str) -> None:
        data = self._load()
        data["bridges"].pop(bridge_id.lower(), None)
        if data.get("default") == bridge_id.lower():
            remaining = next(iter(data["bridges"]), None)
            if remaining:
                data["default"] = remaining
            else:
                data.pop("default", None)
        self._write(data)

    def list(self) -> builtins.list[BridgeCredentials]:
        return [BridgeCredentials.from_dict(v) for v in self._load()["bridges"].values() if isinstance(v, dict)]


class MemoryCredentialStore:
    """In-memory store for tests and ephemeral agents."""

    def __init__(self) -> None:
        self._bridges: dict[str, BridgeCredentials] = {}
        self._default: str | None = None

    def save(self, creds: BridgeCredentials, *, make_default: bool = False) -> None:
        self._bridges[creds.bridge_id] = creds
        if make_default or self._default is None:
            self._default = creds.bridge_id

    def get(self, bridge_id: str | None = None) -> BridgeCredentials | None:
        key = bridge_id.lower() if bridge_id else (self._default or next(iter(self._bridges), None))
        return self._bridges.get(key) if key else None

    def remove(self, bridge_id: str) -> None:
        self._bridges.pop(bridge_id.lower(), None)
        if self._default == bridge_id.lower():
            self._default = next(iter(self._bridges), None)

    def list(self) -> builtins.list[BridgeCredentials]:
        return list(self._bridges.values())


@dataclass(slots=True)
class ResolvedConnection:
    credentials: BridgeCredentials
    tls: TlsOptions
    source: Literal["env", "store"]


def resolve_connection(
    *,
    store: CredentialStore | None = None,
    bridge_id: str | None = None,
    env: Mapping[str, str] | None = None,
) -> ResolvedConnection | None:
    """Resolves connection details from environment variables first, then the credential store."""
    env = env if env is not None else os.environ
    tls = TlsOptions()
    if env.get("HUE_TLS_INSECURE") in ("1", "true"):
        tls.insecure = True
    if env.get("HUE_CA_FILE"):
        tls.ca = Path(env["HUE_CA_FILE"]).read_text("utf-8")

    host, key = env.get("HUE_BRIDGE_HOST"), env.get("HUE_APPLICATION_KEY")
    if host and key:
        creds = BridgeCredentials(
            bridge_id=(env.get("HUE_BRIDGE_ID") or "env").lower(),
            host=host,
            port=int(env["HUE_BRIDGE_PORT"]) if env.get("HUE_BRIDGE_PORT") else 443,
            scheme="http" if env.get("HUE_BRIDGE_SCHEME") == "http" else "https",
            application_key=key,
            fingerprint=env.get("HUE_BRIDGE_FINGERPRINT"),
            device_type="env",
        )
        if creds.fingerprint and not tls.insecure:
            tls.fingerprint = creds.fingerprint
        if env.get("HUE_BRIDGE_ID") and tls.ca:
            tls.bridge_id = env["HUE_BRIDGE_ID"]
        return ResolvedConnection(creds, tls, "env")

    store = store if store is not None else FileCredentialStore(default_credentials_path(env))
    stored = store.get(bridge_id)
    if stored is None:
        return None
    if stored.fingerprint and not tls.insecure:
        tls.fingerprint = stored.fingerprint
    if tls.ca:
        tls.bridge_id = stored.bridge_id
    return ResolvedConnection(stored, tls, "store")
