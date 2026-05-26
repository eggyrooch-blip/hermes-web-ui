---
slug: meegle-launchd-npx-path
generated_at: 2026-05-26T13:09:18.293Z
spec_revision: 4244d267630e
surfaces: [cli, lib]
scenarios:
  - id: 1
    surface: cli
    action: |
      WebUI server runs with PATH `/usr/bin:/bin:/usr/sbin:/sbin`, while `npx` exists at `/opt/homebrew/bin/npx`
    expected: |
      飞书项目 credential status reports installed/needs_auth, not missing.
    executed: |
      Ran `npm test -- --run tests/server/skill-credentials.test.ts`.
    observed: |
      Server focused tests include `finds the official npm package launcher when launchd starts WebUI with a narrow PATH`; it passed with PATH set to a launchd-like directory and `HERMES_MEEGLE_EXTRA_PATHS` pointing at a fake Homebrew bin.
    verdict: pass
    rationale: |
      This verifies credential status can discover the common-bin npx fallback without executing npx.
  - id: 2
    surface: cli
    action: |
      User clicks Feishu Project authorization under narrow PATH
    expected: |
      start flow resolves `/opt/homebrew/bin/npx -y @lark-project/meegle ...` and returns the device-code URL.
    executed: |
      Ran `npm test -- --run tests/server/skill-credentials.test.ts`.
    observed: |
      Server focused tests include `starts Feishu Project auth through the common-bin npx fallback under a narrow launchd PATH`; it passed and asserted the returned device-code URL and `@lark-project/meegle` invocation.
    verdict: pass
    rationale: |
      This verifies user-initiated authorization uses the common-bin npx fallback under narrow PATH.
  - id: 3
    surface: cli
    action: |
      Machine has neither PATH nor common-bin `meegle/npx`
    expected: |
      card still reports missing with readable error on start.
    executed: |
      Ran `npm test -- --run tests/server/skill-credentials.test.ts`.
    observed: |
      Existing missing-bin test still passed, confirming no PATH/common-bin `meegle` or `npx` returns a 502 readable error for start and status remains missing.
    verdict: pass
    rationale: |
      This preserves the no-launcher failure mode while adding the launchd fallback.
---

# Simulation trace — meegle-launchd-npx-path

Agent: fill each scenario's `executed` / `observed` / `verdict` / `rationale`
by ACTUALLY RUNNING the feature using your own tools (Bash / Interceptor /
claude-in-chrome / curl). Save large artifacts (screenshots, network logs) to
`/Users/kite/code/hermes-web-ui/.ftask/meegle-launchd-npx-path/sim_artifacts/` and reference paths in `observed`.

Verdict legend:
- `pass` — observed matches expected.
- `fail` — observed contradicts expected. **Blocks ship.**
- `inconclusive` — agent couldn't fully verify (missing env / external dep);
  rationale MUST explain why. Allowed through ship.

## Captured runs (ftask --capture audit trail; do NOT hand-edit — re-run --capture to refresh)

- scenario_id: 1
  at: 2026-05-26T13:09:32.792Z
  command: "npm test -- --run tests/server/skill-credentials.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-launchd-npx-path
  exit_code: 0
  duration_ms: 5903
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-credentials.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-launchd-npx-path

     ✓ tests/server/skill-credentials.test.ts (27 tests) 4878ms
       ✓ skill credential status > summarizes first-party skill credentials without returning raw secrets  333ms
       ✓ skill credential status > starts Feishu Project CLI device-code auth without writing MCP config  499ms
       ✓ skill credential status > starts Feishu Project auth through npx when no global meegle command is installed  470ms
       ✓ skill credential status > starts Feishu Project auth through the common-bin npx fallback under a narrow launchd PATH  448ms
       ✓ skill credential status > shows which installed skills require lark-cli and kep-cli credentials  327ms
       ✓ skill credential status > checks kep-auth live status instead of treating keyring material as connected  356ms
       ✓ skill credential status > treats kep-auth state valid as an authenticated live login  444ms
       ✓ skill credential status > starts kep-cli OAuth login from WebUI and returns the browser authorization URL  421ms
       ✓ skill credential status > rewrites kep-cli OAuth callback through the public WebUI origin and proxies back to the active local listener  390ms

     Test Files  1 passed (1)
          Tests  27 passed (27)
       Start at  21:09:27
       Duration  5.20s (transform 77ms, setup 13ms, collect 28ms, tests 4.88s, environment 0ms, prepare 40ms)
  stderr_tail: |
    (node:6040) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)

- scenario_id: 2
  at: 2026-05-26T13:09:44.159Z
  command: "npm test -- --run tests/server/skill-credentials.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-launchd-npx-path
  exit_code: 0
  duration_ms: 5485
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-credentials.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-launchd-npx-path

     ✓ tests/server/skill-credentials.test.ts (27 tests) 4546ms
       ✓ skill credential status > summarizes first-party skill credentials without returning raw secrets  320ms
       ✓ skill credential status > starts Feishu Project CLI device-code auth without writing MCP config  407ms
       ✓ skill credential status > starts Feishu Project auth through npx when no global meegle command is installed  447ms
       ✓ skill credential status > starts Feishu Project auth through the common-bin npx fallback under a narrow launchd PATH  628ms
       ✓ skill credential status > reports needs_auth for SkillHub installs without a concrete kep-cli skill when kep-auth is not logged in  312ms
       ✓ skill credential status > treats kep-auth state valid as an authenticated live login  531ms
       ✓ skill credential status > starts kep-cli OAuth login from WebUI and returns the browser authorization URL  400ms

     Test Files  1 passed (1)
          Tests  27 passed (27)
       Start at  21:09:39
       Duration  4.87s (transform 77ms, setup 12ms, collect 26ms, tests 4.55s, environment 0ms, prepare 41ms)
  stderr_tail: |
    (node:6400) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)

- scenario_id: 3
  at: 2026-05-26T13:09:55.160Z
  command: "npm test -- --run tests/server/skill-credentials.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-launchd-npx-path
  exit_code: 0
  duration_ms: 5220
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-credentials.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-launchd-npx-path

     ✓ tests/server/skill-credentials.test.ts (27 tests) 4255ms
       ✓ skill credential status > starts Feishu Project CLI device-code auth without writing MCP config  427ms
       ✓ skill credential status > starts Feishu Project auth through npx when no global meegle command is installed  414ms
       ✓ skill credential status > starts Feishu Project auth through the common-bin npx fallback under a narrow launchd PATH  395ms
       ✓ skill credential status > reports needs_auth for SkillHub installs without a concrete kep-cli skill when kep-auth is not logged in  442ms
       ✓ skill credential status > treats kep-auth state valid as an authenticated live login  405ms
       ✓ skill credential status > starts kep-cli OAuth login from WebUI and returns the browser authorization URL  406ms

     Test Files  1 passed (1)
          Tests  27 passed (27)
       Start at  21:09:50
       Duration  4.57s (transform 87ms, setup 14ms, collect 34ms, tests 4.25s, environment 0ms, prepare 50ms)
  stderr_tail: |
    (node:6756) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)
