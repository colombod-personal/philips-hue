"""Error hierarchy for the Hue SDK.

Every error carries a machine-readable ``code`` so agents can branch on it
without parsing messages.
"""

from __future__ import annotations

from typing import Any, Literal

HueErrorCode = Literal[
    "link_button_not_pressed",
    "pairing_timeout",
    "unauthorized",
    "not_found",
    "bad_request",
    "rate_limited",
    "bridge_error",
    "network",
    "tls",
    "discovery_failed",
    "invalid_response",
    "stream_closed",
    "aborted",
]


class HueError(Exception):
    """Base class for all SDK errors."""

    def __init__(self, code: HueErrorCode, message: str, *, status: int | None = None, details: Any = None) -> None:
        super().__init__(message)
        self.code: HueErrorCode = code
        self.message = message
        self.status = status
        self.details = details

    def to_dict(self) -> dict[str, Any]:
        """Plain-dict representation, handy for agents / JSON output."""
        out: dict[str, Any] = {"name": type(self).__name__, "code": self.code, "message": self.message}
        if self.status is not None:
            out["status"] = self.status
        if self.details is not None:
            out["details"] = self.details
        return out

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, message={self.message!r})"


class LinkButtonNotPressedError(HueError):
    def __init__(self, details: Any = None) -> None:
        super().__init__(
            "link_button_not_pressed",
            "Link button not pressed. Press the round button on the Hue bridge and retry within 30 seconds.",
            details=details,
        )


class PairingTimeoutError(HueError):
    def __init__(self, timeout_s: float) -> None:
        super().__init__("pairing_timeout", f"Pairing timed out after {timeout_s:g} s without the link button being pressed.")


class TlsError(HueError):
    def __init__(self, message: str) -> None:
        super().__init__("tls", message)
