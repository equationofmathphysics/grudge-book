# Security and privacy

This is a small self-hosted application, not an end-to-end encrypted vault.
Operators with database or server access can read notebooks. Use HTTPS, a
restricted persistent volume, encrypted backups and a trusted reverse proxy.
Read the authentication and aggregate-privacy limitations in the README before
inviting other users. Aggregate statistics can be disabled with
`ENABLE_AGGREGATE=false`.

Do not publish real notebook exports, credentials, session cookies, database
files, production logs or private deployment identifiers in issues or pull
requests. Reproduce problems with synthetic data.

For a suspected vulnerability, use GitHub's private vulnerability reporting
option if it is enabled on this repository. If it is unavailable, open an issue
requesting a private reporting channel without exploit details or personal data.
Do not assume a response-time guarantee or an independent security audit.

Before upgrading, make and verify an encrypted backup. Apply new SQL migrations
in order; do not edit migrations already deployed. Test restoration separately.
The application has no password reset, account recovery or user-deletion UI.
