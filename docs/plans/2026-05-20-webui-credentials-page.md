# WebUI Credentials Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an Agent-column credentials page that visualizes and starts skill/tool authentication flows without exposing secrets.

**Architecture:** WebUI BFF will expose a redacted skill credential status endpoint for the authenticated request profile. The first version adapts Lark-cli via the existing Feishu UAT broker flow and detects Keep-record, kep-cli, and GitLab through profile-local skill/runtime artifacts without reading token contents. Status labels are intentionally strict: only tool-verified auth is `authenticated`, GitLab readable materialized token is `configured`, and local credential files that have not been live-verified stay `unknown`. The Vue page renders generic skill credential entries and uses typed action metadata so future skills can plug in without custom layout rewrites.

**Tech Stack:** Koa 2 TypeScript BFF, Vue 3, vue-router, Pinia, Naive UI, Vitest, existing Feishu UAT BFF proxy.

### Task 1: Server Status API

**Files:**
- Create: `packages/server/src/services/hermes/skill-credentials.ts`
- Modify: `packages/server/src/controllers/auth.ts`
- Modify: `packages/server/src/routes/auth.ts`
- Modify: `packages/server/src/services/request-context.ts`
- Test: `tests/server/skill-credentials.test.ts`

**Steps:**
1. Write a failing test that calls the service/controller for a fake profile containing `skills/Keep/keep-record`, `home/.keepai/.env`, `home/.kep-cli/keyring-fallback/token-key:online:profile`, and `workspace/credentials/gitlab.token`; assert tool-verified auth is `authenticated`, readable GitLab token material is `configured`, unverified Keep-record local files are `unknown`, and no raw token strings appear.
2. Run `pnpm vitest run tests/server/skill-credentials.test.ts` and verify it fails because the module/route does not exist.
3. Implement redacted status entries: `lark-cli`, `keep-record`, `kep-cli`, `gitlab`.
4. Allow `/api/auth/skill-credentials` in chat plane.
5. Run the same test and verify it passes.

### Task 2: Server Start Actions

**Files:**
- Modify: `packages/server/src/services/hermes/skill-credentials.ts`
- Modify: `packages/server/src/controllers/auth.ts`
- Test: `tests/server/skill-credentials.test.ts`

**Steps:**
1. Write a failing test that `startSkillCredentialAuth("lark-cli")` returns a Feishu device-flow action shape by delegating to the existing auth start path.
2. Add tests for Keep-record/kep-cli/GitLab returning safe `skill_flow` or `manual` action metadata only, never secret values.
3. Implement minimal action responses. Keep-record can expose a QR-capable flow descriptor; kep-cli/GitLab can expose guided action metadata until their CLI/token write flows have a dedicated backend.
4. Run the server focused test again.

### Task 3: Client API And Route

**Files:**
- Create: `packages/client/src/api/skillCredentials.ts`
- Create: `packages/client/src/views/hermes/CredentialsView.vue`
- Modify: `packages/client/src/router/index.ts`
- Test: `tests/client/credentials-view.test.ts`

**Steps:**
1. Write a failing test that mounts `CredentialsView` with mocked API status entries and verifies Lark-cli, Keep-record, kep-cli, and GitLab render as skill credentials, with account hints but no token strings.
2. Run `pnpm vitest run tests/client/credentials-view.test.ts` and verify it fails because the component/API does not exist.
3. Implement typed client API and the Vue view with compact operational UI.
4. Run the client focused test and verify it passes.

### Task 4: Agent Column Navigation

**Files:**
- Modify: `packages/client/src/components/layout/AppSidebar.vue`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Test: `tests/client/sidebar-search.test.ts`

**Steps:**
1. Add a failing sidebar test that expects a credentials nav item in the Agent group and route key `hermes.credentials`.
2. Run the sidebar test and verify it fails.
3. Add the Agent-column nav item and localized labels.
4. Run the sidebar focused test and verify it passes.

### Task 5: Verification And Docs

**Files:**
- Modify: `ARCHITECTURE-GUIDE.md`
- Modify: Obsidian Hermes docs if behavior changes warrant it.

**Steps:**
1. Run focused tests: server skill credentials, credentials view, sidebar.
2. Run `pnpm run build`.
3. Update living docs with the new WebUI credentials page contract and secret-free boundary.
4. Run `ftask state webui-credentials-page --note "..."`
