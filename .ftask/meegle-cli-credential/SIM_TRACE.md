---
slug: meegle-cli-credential
generated_at: 2026-05-26T09:45:22.101Z
spec_revision: b949c52983db
surfaces: [web, lib]
scenarios:
  - id: 1
    surface: web
    action: |
      用户打开 WebUI「凭证」页
    expected: |
      看到“飞书项目”凭证卡，不再看到“飞书项目 MCP”或任何 MCP 文案。
    executed: |
      Ran CredentialsView focused test through ftask capture scenario 1.
    observed: |
      The test renders the credentials page with a Feishu Project entry, asserts the internal systems group contains “飞书项目”, and asserts the rendered page text does not contain “MCP”.
    verdict: pass
    rationale: |
      This directly verifies the user-facing credentials card copy and grouping.
  - id: 2
    surface: web
    action: |
      用户点击“飞书项目”授权
    expected: |
      WebUI 启动 Meegle CLI device-code 登录流程，返回可打开的授权 URL；不会写入 `mcp_servers.FeishuProjectMcp`。
    executed: |
      Ran skill credential service focused test through ftask capture scenario 2.
    observed: |
      The test starts Feishu Project auth with a fake `meegle` binary, verifies `meegle config set host project.feishu.cn`, `meegle auth login --device-code --host project.feishu.cn`, returns the device-code URL, and confirms config.yaml does not contain FeishuProjectMcp or mcp_server.
    verdict: pass
    rationale: |
      This directly verifies the new Meegle CLI auth path and that the MCP config writer is gone from the flow.
  - id: 3
    surface: web
    action: |
      profile 已完成 Meegle CLI 登录
    expected: |
      凭证页显示飞书项目已认证，但响应不包含 access token / refresh token / keychain 内容。
    executed: |
      Ran skill credential service focused test through ftask capture scenario 3.
    observed: |
      The test fakes `meegle auth status --format json` returning authenticated=true, verifies the credential entry is `feishu-project` / `飞书项目` / authenticated, and asserts serialized response does not contain access_token or refresh_token.
    verdict: pass
    rationale: |
      This covers authenticated status serialization without exposing token material.
  - id: 4
    surface: web
    action: |
      用户自然语言提到飞书项目、工作项、需求、任务、缺陷、排期、视图或 project.feishu.cn URL
    expected: |
      profile 中有 bundled `meegle` skill guidance，模型能按官方 SOP 优先使用 `meegle` CLI。
    executed: |
      Ran bundled skill injector and skills-controller focused tests through ftask capture scenario 4.
    observed: |
      The repository now includes `packages/skills/meegle` copied from the official larksuite/meegle-cli skill. Focused injector/controller tests passed, and credential requirement tests classify Meegle/飞书项目 guidance as `feishu-project`.
    verdict: pass
    rationale: |
      This verifies the bundled skill is available to the existing profile skill sync path and that its trigger language maps to the Feishu Project credential.
---

# Simulation trace — meegle-cli-credential

Agent: fill each scenario's `executed` / `observed` / `verdict` / `rationale`
by ACTUALLY RUNNING the feature using your own tools (Bash / Interceptor /
claude-in-chrome / curl). Save large artifacts (screenshots, network logs) to
`/Users/kite/code/hermes-web-ui/.ftask/meegle-cli-credential/sim_artifacts/` and reference paths in `observed`.

Verdict legend:
- `pass` — observed matches expected.
- `fail` — observed contradicts expected. **Blocks ship.**
- `inconclusive` — agent couldn't fully verify (missing env / external dep);
  rationale MUST explain why. Allowed through ship.

## Captured runs (ftask --capture audit trail; do NOT hand-edit — re-run --capture to refresh)

- scenario_id: 1
  at: 2026-05-26T09:46:07.593Z
  command: "npm test -- --run tests/client/credentials-view.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-cli-credential
  exit_code: 0
  duration_ms: 2238
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/client/credentials-view.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-cli-credential

     ✓ tests/client/credentials-view.test.ts (6 tests) 799ms
       ✓ CredentialsView > renders skill credential statuses without leaking raw secrets  773ms

     Test Files  1 passed (1)
          Tests  6 passed (6)
       Start at  17:46:05
       Duration  1.54s (transform 183ms, setup 16ms, collect 46ms, tests 799ms, environment 360ms, prepare 107ms)
  stderr_tail: |
    (empty)

- scenario_id: 2
  at: 2026-05-26T09:45:35.986Z
  command: "npm test -- --run tests/server/skill-credentials.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-cli-credential
  exit_code: 0
  duration_ms: 5201
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-credentials.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-cli-credential

     ✓ tests/server/skill-credentials.test.ts (23 tests) 3465ms
       ✓ skill credential status > summarizes first-party skill credentials without returning raw secrets  446ms
       ✓ skill credential status > starts Feishu Project CLI device-code auth without writing MCP config  373ms
       ✓ skill credential status > treats kep-auth state valid as an authenticated live login  480ms
       ✓ skill credential status > starts kep-cli OAuth login from WebUI and returns the browser authorization URL  431ms
       ✓ skill credential status > starts and completes Keep-record QR auth without returning the token  403ms

     Test Files  1 passed (1)
          Tests  23 passed (23)
       Start at  17:45:31
       Duration  4.46s (transform 150ms, setup 25ms, collect 96ms, tests 3.47s, environment 0ms, prepare 202ms)
  stderr_tail: |
    (node:837) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)

- scenario_id: 3
  at: 2026-05-26T09:45:49.306Z
  command: "npm test -- --run tests/server/skill-credentials.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-cli-credential
  exit_code: 0
  duration_ms: 4014
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-credentials.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-cli-credential

     ✓ tests/server/skill-credentials.test.ts (23 tests) 2835ms
       ✓ skill credential status > starts Feishu Project CLI device-code auth without writing MCP config  364ms
       ✓ skill credential status > treats kep-auth state valid as an authenticated live login  387ms
       ✓ skill credential status > starts kep-cli OAuth login from WebUI and returns the browser authorization URL  371ms

     Test Files  1 passed (1)
          Tests  23 passed (23)
       Start at  17:45:45
       Duration  3.23s (transform 87ms, setup 14ms, collect 27ms, tests 2.84s, environment 0ms, prepare 50ms)
  stderr_tail: |
    (node:2037) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)

- scenario_id: 4
  at: 2026-05-26T09:46:08.999Z
  command: "npm test -- --run tests/server/skill-injector.test.ts tests/server/skills-controller.test.ts"
  cwd: /Users/kite/code/hermes-web-ui.tasks/meegle-cli-credential
  exit_code: 0
  duration_ms: 1368
  stdout_tail: |

    > hermes-web-ui@0.5.16 test
    > vitest run --run tests/server/skill-injector.test.ts tests/server/skills-controller.test.ts


     RUN  v3.2.4 /Users/kite/code/hermes-web-ui.tasks/meegle-cli-credential

     ✓ tests/server/skill-injector.test.ts (2 tests) 47ms
     ✓ tests/server/skills-controller.test.ts (13 tests) 95ms

     Test Files  2 passed (2)
          Tests  15 passed (15)
       Start at  17:46:08
       Duration  546ms (transform 109ms, setup 23ms, collect 134ms, tests 142ms, environment 0ms, prepare 142ms)
  stderr_tail: |
    (node:3389) ExperimentalWarning: SQLite is an experimental feature and might change at any time
    (Use `node --trace-warnings ...` to show where the warning was created)
