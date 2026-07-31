# Superseded — do not install

The file in this folder is **prototype work that is not the production backend.**

Lead storage will use **Convex**. See `docs/CONVEX_LEAD_CAPTURE_SPEC.md`.

It has been renamed with a `.reference` extension so WordPress cannot load it even if the
folder is copied into `wp-content/plugins/` by accident.

## Why it is kept

It is a working reference for four things the Convex implementation still needs:

- server-side validation of every field
- honeypot handling that accepts and discards rather than returning an error
- IP-hash rate limiting that tolerates carrier-grade NAT
- CSV export escaping that neutralises formula injection (`= + - @`)

Read it for those patterns. Do not run it.
