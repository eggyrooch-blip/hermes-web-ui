# Connector catalog card actions

feature: owner-bound connector catalog actions
impact: All 642 source and 330 canonical cards open a real detail surface and expose an admitted action: 18 direct
connect, 243 manual/OAuth authorize, 21 owner-isolated CLI authorize, and 360 sandbox install. The final catalog has
zero incompatible and zero rejected source rows.

The browser submits only the frozen `row_key`. The BFF derives the trusted profile and Feishu principal, rejects
extra identity fields, and forwards owner headers to Run Broker. Returned owner-scoped installations drive the
Connected state after refresh. Canonical rows select their source view because an aggregate row is not itself a
runnable connector. Feishu remains on the existing owner-routed lark-cli device flow and exact-owner revoke path;
it never falls back to ambient terminal identity.

The UI renders Connected only for an owner installation in `ready`, except Feishu where the registered owner broker
supplies the live ready result. Merely persisting an installation is insufficient: Run Broker lists the approved
read-only tools, calls one zero-input read-only probe, and rolls failed verification back.

Header credentials are rendered from the exact server schema. Standard MCP OAuth opens the upstream authorization
URL and completes through a public BFF callback; the browser never supplies owner identity or sees tokens. Access
tokens refresh owner-bound on expiry and abandoned callbacks expire after five minutes. Stdio rows use the existing
pinned sandbox runtime; vendor/local-only rows use the shared owner-supplied HTTPS MCP adapter. Production is unchanged.
