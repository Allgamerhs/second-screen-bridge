# Security policy

## Supported versions

Security fixes are applied to the latest version on the default branch. Older snapshots may not receive updates.

## Report a vulnerability

Please do **not** open a public issue containing exploit details, live pairing codes, tokens, or personal data. Use GitHub's private vulnerability reporting for this repository when available. If that feature is unavailable, contact the maintainer through a private channel listed on their GitHub profile and include a safe way to reproduce the issue. We will acknowledge reports as soon as practical and coordinate disclosure after a fix is available.

## Intended trust boundary

Second Screen Bridge is designed for one trusted local network. It rejects clients outside its allowed local network and uses expiring, single-use pairing codes and short-lived, IP-bound phone sessions. These controls do not replace TLS or a full authentication system. The service uses plain HTTP: anyone able to observe or alter traffic on the local network may see or tamper with text, URLs, pairing codes, or session tokens.

Cross-origin receiver pages must be explicitly listed in `ALLOWED_ORIGINS`. Local `file://` pages require `ALLOW_FILE_ORIGIN=1`, which is disabled by default. Browsers may also use the opaque `null` origin for sandboxed documents, so enable this option only when the local network and content loaded by the receiver are trusted.

Do not expose the HTTP port to the public Internet. Do not put secrets in text sent through the bridge. If you use it through a VPN, reverse proxy, or other network boundary, review the proxy's client IP, origin, HTTPS, and authentication configuration separately.

Do not include private IP addresses, real pairing codes, tokens, or captured user input in public issue reports.
