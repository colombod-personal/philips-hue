# Security

## Threat model

- The Hue application key is a bearer secret. Whoever holds it controls every light and reads every sensor on the bridge.
- Bridges only speak HTTPS but their certificates do not chain to public roots (Signify private CA on newer firmware, self-signed on older bridges), so naïve clients disable verification and are open to on-path attackers.

## What this SDK does

- **Pairing pins the certificate.** `pairBridge` reads the certificate before requesting a key and sends the pairing request only to that certificate. The SHA-256 fingerprint is stored with the credentials and enforced on every later connection.
- **Optional CA verification.** Supply the Signify Hue bridge root CA (from the Hue developer portal) via `tls.ca` / `HUE_CA_FILE` and the certificate CN is checked against the bridge id as well.
- **No silent insecure mode.** Verification is skipped only when `insecure: true` / `HUE_TLS_INSECURE=1` is set explicitly; `identify` intentionally connects unverified once, to learn the certificate, and never sends a key.
- **Credentials at rest.** The file store writes `0600` files under `~/.config/hue-sdk/` (or `HUE_CREDENTIALS_FILE`). The CLI and MCP server redact keys in output.
- **Least surprise for agents.** Write operations are explicit tools/commands; sensor reads never mutate state.

## Reporting

Open a private security advisory on GitHub or contact the maintainers before disclosing publicly.
