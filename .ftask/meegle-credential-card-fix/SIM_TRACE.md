---
slug: meegle-credential-card-fix
generated_at: 2026-05-26T12:49:04.133Z
spec_revision: 944312414c35
surfaces: [web, api, lib]
scenarios:
  - id: 1
    surface: web
    action: |
      user opens WebUI `/hermes/credentials` with no global `meegle` binary but `npx` available
    expected: |
      “飞书项目” card is not “未安装”; action button can start the official Meegle device-code flow through the npm package path.
    executed: |
      Ran `npm test -- --run tests/server/skill-credentials.test.ts`.
    observed: |
      Server focused tests include `treats Feishu Project CLI as installable through the official npm package when npx is available` and `starts Feishu Project auth through npx when no global meegle command is installed`; both passed.
    verdict: pass
    rationale: |
      This verifies status no longer reports missing when only npx is available, and the start flow uses `npx -y @lark-project/meegle` for the device-code URL.
  - id: 2
    surface: web
    action: |
      user opens WebUI `/hermes/credentials` with mixed Keep/Lark skills installed
    expected: |
      “飞书项目” card required_by only includes the bundled `meegle` skill or true Meegle/Feishu Project skills, not `kep-*` or `lark-*` skills.
    executed: |
      Ran `npm test -- --run tests/server/skill-credentials.test.ts`.
    observed: |
      Server focused tests include classifier checks proving `kep-prd-analysis` maps only to `kep-cli`, `lark-base` maps only to `lark-cli`, and a mixed profile reports Feishu Project `required_by` as only `meegle`.
    verdict: pass
    rationale: |
      This verifies the over-broad Chinese generic terms no longer pollute the Feishu Project credential card.
  - id: 3
    surface: web
    action: |
      user checks credentials API response
    expected: |
      no `MCP` user-facing title/detail and no access/refresh token material.
    executed: |
      Ran `npm test -- --run tests/server/skill-credentials.test.ts tests/client/credentials-view.test.ts`.
    observed: |
      Server tests assert serialized credential responses do not contain `MCP`, `access_token`, or `refresh_token`; client tests render the credentials page and verify the Feishu Project card text/action without raw secret leakage.
    verdict: pass
    rationale: |
      This covers the API and rendered credentials surface for the sensitive wording/token regression.
---

# Simulation trace — meegle-credential-card-fix

Agent: fill each scenario's `executed` / `observed` / `verdict` / `rationale`
by ACTUALLY RUNNING the feature using your own tools (Bash / Interceptor /
claude-in-chrome / curl). Save large artifacts (screenshots, network logs) to
`/Users/kite/code/hermes-web-ui/.ftask/meegle-credential-card-fix/sim_artifacts/` and reference paths in `observed`.

Verdict legend:
- `pass` — observed matches expected.
- `fail` — observed contradicts expected. **Blocks ship.**
- `inconclusive` — agent couldn't fully verify (missing env / external dep);
  rationale MUST explain why. Allowed through ship.

## Captured runs (ftask --capture audit trail; do NOT hand-edit — re-run --capture to refresh)

- scenario_id: 1
  at: 2026-05-26T12:49:15.724Z
  command: "npm test -- --run tests/server/skill-credentials.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-credential-card-fix
  exit_code: 0
  duration_ms: 5569
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-credentials.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-credential-card-fix

     ✓ tests/server/skill-credentials.test.ts (25 tests) 4537ms
       ✓ skill credential status > summarizes first-party skill credentials without returning raw secrets  401ms
       ✓ skill credential status > starts Feishu Project CLI device-code auth without writing MCP config  420ms
       ✓ skill credential status > starts Feishu Project auth through npx when no global meegle command is installed  416ms
       ✓ skill credential status > treats kep-auth state valid as an authenticated live login  448ms
       ✓ skill credential status > starts kep-cli OAuth login from WebUI and returns the browser authorization URL  468ms
       ✓ skill credential status > rewrites kep-cli OAuth callback through the public WebUI origin and proxies back to the active local listener  539ms
       ✓ skill credential status > starts and completes Keep-record QR auth without returning the token  368ms

     Test Files  1 passed (1)
          Tests  25 passed (25)
       Start at  20:49:10
       Duration  4.86s (transform 92ms, setup 13ms, collect 29ms, tests 4.54s, environment 0ms, prepare 74ms)
  stderr_tail: |
    (node:72591) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)

- scenario_id: 2
  at: 2026-05-26T12:49:28.191Z
  command: "npm test -- --run tests/server/skill-credentials.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-credential-card-fix
  exit_code: 0
  duration_ms: 5126
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-credentials.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-credential-card-fix

     ✓ tests/server/skill-credentials.test.ts (25 tests) 4180ms
       ✓ skill credential status > summarizes first-party skill credentials without returning raw secrets  487ms
       ✓ skill credential status > starts Feishu Project CLI device-code auth without writing MCP config  445ms
       ✓ skill credential status > starts Feishu Project auth through npx when no global meegle command is installed  391ms
       ✓ skill credential status > treats SkillHub-installed skills as kep-cli-backed even without text markers  597ms
       ✓ skill credential status > treats kep-auth state valid as an authenticated live login  402ms
       ✓ skill credential status > starts kep-cli OAuth login from WebUI and returns the browser authorization URL  401ms

     Test Files  1 passed (1)
          Tests  25 passed (25)
       Start at  20:49:23
       Duration  4.51s (transform 86ms, setup 12ms, collect 27ms, tests 4.18s, environment 0ms, prepare 49ms)
  stderr_tail: |
    (node:72965) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)

- scenario_id: 3
  at: 2026-05-26T12:49:39.687Z
  command: "npm test -- --run tests/server/skill-credentials.test.ts tests/client/credentials-view.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-credential-card-fix
  exit_code: 0
  duration_ms: 6233
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-credentials.test.ts tests/client/credentials-view.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-credential-card-fix

     ✓ tests/client/credentials-view.test.ts (6 tests) 989ms
       ✓ CredentialsView > renders skill credential statuses without leaking raw secrets  963ms
     ✓ tests/server/skill-credentials.test.ts (25 tests) 5128ms
       ✓ skill credential status > summarizes first-party skill credentials without returning raw secrets  516ms
       ✓ skill credential status > reports Feishu Project CLI auth status without exposing token material or MCP wording  409ms
       ✓ skill credential status > starts Feishu Project CLI device-code auth without writing MCP config  407ms
       ✓ skill credential status > starts Feishu Project auth through npx when no global meegle command is installed  522ms
       ✓ skill credential status > detects credential adapters from installed skill metadata instead of fixed folders  405ms
       ✓ skill credential status > reports needs_auth for SkillHub installs without a concrete kep-cli skill when kep-auth is not logged in  460ms
       ✓ skill credential status > checks kep-auth live status instead of treating keyring material as connected  405ms
       ✓ skill credential status > treats kep-auth state valid as an authenticated live login  409ms
       ✓ skill credential status > starts kep-cli OAuth login from WebUI and returns the browser authorization URL  409ms
       ✓ skill credential status > rewrites kep-cli OAuth callback through the public WebUI origin and proxies back to the active local listener  410ms

     Test Files  2 passed (2)
          Tests  31 passed (31)
       Start at  20:49:33
       Duration  5.59s (transform 274ms, setup 20ms, collect 72ms, tests 6.12s, environment 433ms, prepare 132ms)
  stderr_tail: |
    (node:73406) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)
