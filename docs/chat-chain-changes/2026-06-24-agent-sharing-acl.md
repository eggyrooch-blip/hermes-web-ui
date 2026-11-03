---
date: 2026-06-24
feature: Shared agent ACL
impact: WebUI users can receive a shared Hermes agent with viewer, editor, or manager permissions without exposing owner secrets or unrelated profile state.
---

`/api/hermes/agents/*/shares` is a BFF proxy over the multitenancy Run Broker. The browser never calls the broker directly; the server stamps the authenticated Feishu actor as `X-Hermes-Owner-Open-Id`.

Shared agents appear in the profile selector with their `agentId` and role. Chat-run sockets, session collections, and safe settings requests carry `X-Hermes-Agent-Id`; the server asks the Run Broker for the actor's current role before deciding access. Viewers and editors see only their own WebUI sessions for the shared agent. Managers see all WebUI sessions for that agent and can manage members.

Editor config writes are deliberately narrow: only chat-plane-safe sections `display`, `session_reset`, and `privacy` can be read/written through `/api/hermes/config`. Model/provider/credentials/auxiliary config and profile metadata remain outside the shared surface.

Validation: full Vitest, client/server TypeScript checks, and production build passed locally. This change is not production-released by itself.
