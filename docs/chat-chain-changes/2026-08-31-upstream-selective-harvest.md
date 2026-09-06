# 2026-08-31 Upstream selective harvest

Seven low-conflict Hermes Studio improvements were ported without importing Studio runtime or changing local
identity/profile/Run Broker/file-access boundaries:

1. Path containment rejects only the exact `..` segment, allowing legal `..hidden` and `...` children.
2. Workspace diffs ignore SQLite/DB WAL, SHM, rollback-journal, and `.sqlite3` sidecars.
3. A session-list response cannot override a New Chat selected while the request was in flight; local session
   object identity and messages are retained; empty local chats do not leak into another profile's list.
4. Workspace file cards strip terminal numeric `:line[:column]` references.
5. Markdown keeps ASCII quotes, double dashes, and ellipses by disabling typographer rewrites.
6. Session changes focus the exposed composer on desktop without stealing an already focused form field;
   mobile does not request focus.
7. `HERMES_MAX_UPLOAD_SIZE` configures a bounded decimal positive upload limit (maximum 1 GiB, default 50 MiB), and an
   oversized request is drained with a two-minute ceiling before the 413 response.

The existing cross-profile, symlink, download, chat-plane upload target, Run Broker, history pagination,
Feishu, cron, and multitenancy seams are unchanged.

Verification: 155 focused follow-up assertions passed after independent review, alongside the earlier 213/213
harvest suite; client/server typecheck, production build, and diff check passed. Browser visual QA was not run.
The final session-race follow-up removes the selection-epoch bump from the shared clear helper; explicit
selection still bumps through `switchSession`, and the clear-during-load fallback regression passes in the
73-test chat-store file.

Released in MR !54 / pipeline 542957 as WebUI
`d0d64957ea0f17b7784b75fde6d3bbc0e92482d1` under `release-20260831-03`. The executor passed 12/12 probes;
services, ports, HTTP auth boundaries, database quick-check, and 44244/44244 non-empty mirrored session rows
were read back. Feishu WS remained connected; no cron job, employee message, model call, or production data
mutation was used for verification. Desktop/mobile focus still lacks screenshot-backed browser verification.
