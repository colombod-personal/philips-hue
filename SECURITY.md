# Security

## Threat model

- The Hue application key is a bearer secret. Whoever holds it controls every light and reads every sensor on the bridge.
- Bridges only speak HTTPS but their certificates do not chain to public roots (Signify private CA on newer firmware, self-signed on older bridges), so naïve clients disable verification and are open to on-path attackers.

## What this SDK does

- **Pairing pins the certificate.** `pair_bridge` reads the certificate before requesting a key and sends the pairing request only to that certificate. The SHA-256 fingerprint is stored with the credentials and enforced on every later connection, right after the TLS handshake and before any request bytes are sent.
- **Optional CA verification.** Supply the Signify Hue bridge root CA (from the Hue developer portal) via `TlsOptions(ca=...)` / `HUE_CA_FILE` and the certificate CN is checked against the bridge id as well.
- **No silent insecure mode.** Verification is skipped only when `insecure=True` / `HUE_TLS_INSECURE=1` is set explicitly; `fetch_bridge_config` intentionally connects unverified once, to learn the certificate, and never sends a key.
- **Credentials at rest.** The file store writes `0600` files under `~/.config/hue-sdk/` (or `HUE_CREDENTIALS_FILE`). `BridgeCredentials.redacted()` exists for logging.
- **Recordings carry no secrets.** The recorder scrubs application and client keys from everything it writes and drops credential-bearing resource types; the twin issues its own key.

## Reporting

Open a private security advisory on GitHub or contact the maintainers before disclosing publicly.
