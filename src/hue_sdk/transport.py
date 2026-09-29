"""Minimal HTTP transport for talking to a Hue bridge.

Built on ``http.client`` so certificate pinning and custom CA handling work
without third-party dependencies. Connections are verified right after the TLS
handshake, before any request bytes leave the process.
"""

from __future__ import annotations

import http.client
import json
import socket
import ssl
import threading
from dataclasses import dataclass, field
from typing import Any

from .errors import HueError
from .tls import CertificateSummary, TlsOptions, build_ssl_context, summarize_certificate, verify_bridge_certificate

HttpMethod = str
DEFAULT_TIMEOUT_S = 10.0


@dataclass(slots=True)
class TransportResponse:
    status: int
    headers: dict[str, str]
    #: Parsed JSON when the response is JSON, else the raw text.
    body: Any
    text: str


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection that enforces :class:`TlsOptions` on connect."""

    def __init__(self, host: str, port: int, *, tls: TlsOptions, timeout: float | None) -> None:
        super().__init__(host, port, timeout=timeout, context=build_ssl_context(tls))
        self._tls = tls
        self.peer_certificate: CertificateSummary | None = None

    def connect(self) -> None:
        super().connect()
        sock = self.sock
        assert isinstance(sock, ssl.SSLSocket)
        der = sock.getpeercert(binary_form=True)
        failure = verify_bridge_certificate(der, self._tls)
        if failure is not None:
            self.close()
            raise failure
        self.peer_certificate = summarize_certificate(der) if der else None


@dataclass(slots=True)
class StreamHandle:
    """An open streaming response (event stream). Close it to stop."""

    connection: http.client.HTTPConnection
    response: http.client.HTTPResponse
    _closed: bool = field(default=False, init=False)

    def readline(self) -> bytes:
        return self.response.readline()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            sock = self.connection.sock
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        finally:
            self.connection.close()

    @property
    def closed(self) -> bool:
        return self._closed


class HttpTransport:
    def __init__(
        self,
        host: str,
        *,
        port: int | None = None,
        scheme: str = "https",
        tls: TlsOptions | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        application_key: str | None = None,
        headers: dict[str, str] | None = None,
        user_agent: str = "hue-sdk",
    ) -> None:
        if scheme not in ("https", "http"):
            raise ValueError("scheme must be 'https' or 'http'")
        self.host = host
        self.scheme = scheme
        self.port = port if port is not None else (443 if scheme == "https" else 80)
        self.tls = tls or TlsOptions()
        self.timeout_s = timeout_s
        self._application_key = application_key
        self._base_headers = {"accept": "application/json", "user-agent": user_agent, **(headers or {})}
        self._conn: http.client.HTTPConnection | None = None
        self._lock = threading.Lock()
        #: Certificate presented by the bridge on the most recent HTTPS connection.
        self.peer_certificate: CertificateSummary | None = None

    @property
    def base_url(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{self.scheme}://{host}:{self.port}"

    def set_application_key(self, key: str | None) -> None:
        self._application_key = key

    @property
    def application_key(self) -> str | None:
        return self._application_key

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    # ---------- requests ----------

    def request(
        self,
        method: HttpMethod,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, str] | None = None,
        timeout_s: float | None = None,
    ) -> TransportResponse:
        payload, all_headers = self._prepare(body, headers)
        with self._lock:
            conn = self._connection(timeout_s or self.timeout_s)
            try:
                res = self._send(conn, method, path, payload, all_headers)
                raw = res.read()
            except HueError:
                self._drop()
                raise
            except (http.client.HTTPException, OSError) as err:
                # Stale keep-alive connection: retry once on a fresh one.
                self._drop()
                conn = self._connection(timeout_s or self.timeout_s)
                try:
                    res = self._send(conn, method, path, payload, all_headers)
                    raw = res.read()
                except (http.client.HTTPException, OSError) as err2:
                    self._drop()
                    raise self._network_error(err2) from err
            if res.getheader("connection", "").lower() == "close":
                self._drop()
        text = raw.decode("utf-8", "replace")
        parsed: Any = text
        content_type = res.getheader("content-type", "") or ""
        if text and ("json" in content_type or text.lstrip()[:1] in ("{", "[")):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as err:
                raise HueError("invalid_response", f"Bridge returned malformed JSON for {method} {path}", status=res.status) from err
        return TransportResponse(status=res.status, headers={k.lower(): v for k, v in res.getheaders()}, body=parsed, text=text)

    def stream(self, path: str, *, headers: dict[str, str] | None = None) -> StreamHandle:
        """Opens a streaming response (used for ``/eventstream/clip/v2``). The caller owns the handle."""
        _payload, all_headers = self._prepare(None, {"accept": "text/event-stream", **(headers or {})})
        conn = self._new_connection(None)
        try:
            res = self._send(conn, "GET", path, None, all_headers)
        except HueError:
            conn.close()
            raise
        except (http.client.HTTPException, OSError) as err:
            conn.close()
            raise self._network_error(err) from err
        return StreamHandle(connection=conn, response=res)

    # ---------- internals ----------

    def _prepare(self, body: Any, headers: dict[str, str] | None) -> tuple[bytes | None, dict[str, str]]:
        all_headers = {**self._base_headers, **(headers or {})}
        if self._application_key and "hue-application-key" not in all_headers:
            all_headers["hue-application-key"] = self._application_key
        payload: bytes | None = None
        if body is not None:
            payload = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
            all_headers["content-type"] = "application/json"
        return payload, all_headers

    def _new_connection(self, timeout_s: float | None) -> http.client.HTTPConnection:
        if self.scheme == "https":
            return _PinnedHTTPSConnection(self.host, self.port, tls=self.tls, timeout=timeout_s)
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout_s)

    def _connection(self, timeout_s: float) -> http.client.HTTPConnection:
        if self._conn is None:
            self._conn = self._new_connection(timeout_s)
        else:
            self._conn.timeout = timeout_s
        return self._conn

    def _drop(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def _send(self, conn: http.client.HTTPConnection, method: str, path: str, payload: bytes | None, headers: dict[str, str]) -> http.client.HTTPResponse:
        try:
            conn.request(method, path, body=payload, headers=headers)
            res = conn.getresponse()
        except ssl.SSLError as err:
            raise HueError("tls", f"TLS handshake with {self.host} failed: {err}") from err
        except TimeoutError as err:
            raise HueError("network", f"Request to {self.host}:{self.port} timed out.") from err
        if isinstance(conn, _PinnedHTTPSConnection) and conn.peer_certificate is not None:
            self.peer_certificate = conn.peer_certificate
        return res

    def _network_error(self, err: Exception) -> HueError:
        if isinstance(err, TimeoutError | socket.timeout):
            return HueError("network", f"Request to {self.host}:{self.port} timed out.")
        return HueError("network", f"Could not reach bridge at {self.host}:{self.port}: {err}")
