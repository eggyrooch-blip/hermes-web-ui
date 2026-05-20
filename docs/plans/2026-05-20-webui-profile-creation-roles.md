# WebUI Profile Creation And Role Presets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let normal WebUI users create and switch owner-scoped Hermes profiles from the web page, with upstream-style profile creation and role presets backed by Hermes core `profile.yaml.description`.

**Architecture:** Keep upstream WebUI as the UX source of truth: reuse `ProfileCreateModal`, `ProfileSelector`, `profiles` store, and `/api/hermes/profiles` with minimal additive props/fields. Do not introduce a new WebUI-only role table or enum; role presets only prefill the existing Hermes CLI `--description` field, which persists in `<profile>/profile.yaml` and is already used by Kanban/profile routing. Do not modify Hermes core source; consume existing CLI/profile behavior from WebUI and put all owner-scoped compatibility into multitenancy.

**Tech Stack:** Vue 3 + Pinia + Naive UI, Koa controllers/routes, Hermes CLI `hermes profile create`, multitenancy Run Broker sidecar, SQLite `multitenancy_routing`, Vitest, pytest.

## Non-Negotiable Boundaries

- Respect upstream: inherit the upstream profile manager/create modal shape where possible.
- Do not fork/rewrite upstream WebUI profile UX. Prefer small additive fields and feature gates over replacing upstream components.
- Do not modify Hermes core source under the local Hermes checkout. The only Hermes-facing change is WebUI calling already-supported CLI flags such as `--description` and `--no-alias`.
- Roles are descriptions, not a new schema. Presets like `coder`, `researcher`, `writer`, and `operator` map to text descriptions.
- User-mode profile creation is owner-scoped. A logged-in openid can create, list, switch to, and run only profiles owned by that openid.
- User-mode must not expose admin operations by default: profile import/export/delete/rename/gateway restart remain admin-plane until explicitly requested.
- Do not copy raw UAT tokens or credential vault rows into child profiles.
- In chat-plane, avoid creating shell wrapper aliases for every web-created profile. Use Hermes CLI `--no-alias` for WebUI-owned child profiles unless admin plane explicitly keeps upstream behavior.
- Production is not touched by this plan. Local verification first.

## Desired UX

In user-mode sidebar:

- The existing profile selector remains visible and follows upstream layout as closely as possible.
- If upstream `ProfileSelector` already has a profile-manager modal in the current upstream, port that component rather than designing a new one. If not, keep the existing select and add only a small upstream-style `+` action.
- The modal lists owner-scoped profiles and has a `+` create button.
- Create modal fields:
  - Profile name.
  - Role preset segmented control:
    - Coder: "Software engineering agent for coding, debugging, tests, repo navigation, and pull request work."
    - Researcher: "Research agent for web/source investigation, synthesis, citations, and structured reports."
    - Writer: "Writing agent for drafts, editing, summaries, proposals, and polished long-form documents."
    - Operator: "Operations agent for recurring tasks, Feishu/workflow execution, checklists, and status tracking."
    - Custom: editable description textarea.
  - Clone from current profile toggle, preserving upstream smart cleanup behavior.
- After create, the new profile appears in the selector and can be switched to immediately.

Admin-mode `/hermes/profiles`:

- Preserve upstream manager behavior as much as possible.
- It may continue to expose import/export/delete/rename/avatar/runtime controls according to upstream.
- Any additional role/description field should be additive and backed by Hermes CLI.

## Division Of Responsibility

WebUI owns:

- Upstream-compatible UI affordances.
- Passing `name`, `clone`, and optional `description` to `/api/hermes/profiles`.
- Calling a multitenancy compatibility endpoint after profile creation in chat-plane.
- Falling back to the existing direct `registerOwnedProfile()` only while the multitenancy endpoint is unavailable in local development.

Multitenancy owns:

- Creating/upserting owner-scoped `multitenancy_routing` rows.
- Generating stable `agent_id` for WebUI child profiles.
- Enforcing owner immutability and cross-owner rejection.
- Skill inheritance/secret boundary decisions for child profiles.
- Any future cleanup/delete semantics for owner-owned child profiles.

Hermes core owns:

- Existing `hermes profile create` behavior.
- Existing `--description`, `--clone`, `--no-alias`, `profile.yaml`, bundled skill seeding, and SOUL bootstrap behavior.
- No Hermes core source change is planned.

## Task 1: WebUI API Contract For Profile Description

**Files:**
- Modify: `packages/client/src/api/hermes/profiles.ts`
- Modify: `packages/client/src/stores/hermes/profiles.ts`
- Modify: `packages/server/src/services/hermes/hermes-cli.ts`
- Modify: `packages/server/src/controllers/hermes/profiles.ts`
- Test: `tests/server/profiles-routes.test.ts`

**Step 1: Write failing server test**

Add a controller-level test that calls `create()` with:

```ts
ctx.request.body = {
  name: 'web_coder',
  clone: true,
  description: 'Software engineering agent for coding and tests.',
}
ctx.state.user = { openid: 'ou_owner', profile: 'feishu_g41a5b5g' }
```

Expected before implementation: `hermesCli.createProfile` is called without description.

Expected after implementation:

```ts
expect(hermesCli.createProfile).toHaveBeenCalledWith('web_coder', {
  clone: true,
  description: 'Software engineering agent for coding and tests.',
  noAlias: true,
})
```

For admin-plane/non-chat tests, preserve current behavior:

```ts
expect(hermesCli.createProfile).toHaveBeenCalledWith('admin_profile', {
  clone: false,
  description: undefined,
  noAlias: false,
})
```

**Step 2: Run failing test**

Run:

```bash
pnpm vitest run tests/server/profiles-routes.test.ts
```

Expected: fails because `createProfile` only accepts `(name, clone)`.

**Step 3: Extend TypeScript API types**

Change `createProfile` client signature from:

```ts
export async function createProfile(name: string, clone?: boolean)
```

to:

```ts
export interface CreateProfileOptions {
  clone?: boolean
  description?: string
}

export async function createProfile(name: string, options: CreateProfileOptions = {})
```

Send:

```ts
body: JSON.stringify({
  name,
  clone: !!options.clone,
  description: options.description?.trim() || undefined,
})
```

Update Pinia store similarly:

```ts
async function createProfile(name: string, options?: profilesApi.CreateProfileOptions) {
  const res = await profilesApi.createProfile(name, options)
  if (res.success) await fetchProfiles()
  return res
}
```

**Step 4: Extend WebUI's Hermes CLI wrapper only**

Do not edit Hermes core. This step modifies only WebUI's TypeScript wrapper that shells out to the existing Hermes CLI.

Change server wrapper to accept:

```ts
export interface CreateHermesProfileOptions {
  clone?: boolean
  description?: string
  noAlias?: boolean
}
```

Build CLI args:

```ts
const args = ['profile', 'create']
if (options.clone) args.push('--clone')
if (options.noAlias) args.push('--no-alias')
const description = options.description?.trim()
if (description) args.push('--description', description)
args.push('--', name)
```

Keep `validateProfileName(name)`.

**Step 5: Extend profile controller**

Parse:

```ts
const { name, clone, description } = ctx.request.body as {
  name?: string
  clone?: boolean
  description?: string
}
```

For chat-plane user mode:

```ts
const userMode = config.webPlane === 'chat' && !!user?.openid
const output = await hermesCli.createProfile(name, {
  clone: !!clone,
  description: typeof description === 'string' ? description : undefined,
  noAlias: userMode,
})
```

For admin plane, use `noAlias: false`.

**Step 6: Run tests**

Run:

```bash
pnpm vitest run tests/server/profiles-routes.test.ts
```

Expected: pass.

**Step 7: Commit**

```bash
git add packages/client/src/api/hermes/profiles.ts packages/client/src/stores/hermes/profiles.ts packages/server/src/services/hermes/hermes-cli.ts packages/server/src/controllers/hermes/profiles.ts tests/server/profiles-routes.test.ts
git commit -m "feat(profiles): pass role descriptions through profile creation"
```

## Task 2: User-Mode Profile Create Modal With Role Presets

**Files:**
- Modify: `packages/client/src/components/hermes/profiles/ProfileCreateModal.vue`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Modify if present/needed: `packages/client/src/i18n/locales/zh-TW.ts`
- Test: `tests/client/profile-create-modal.test.ts`

**Step 1: Write failing client tests**

Create tests that mount `ProfileCreateModal` and verify:

- Default role preset is `coder`.
- Selecting `researcher` changes the submitted description.
- Selecting `custom` allows editing description.
- Existing clone toggle still submits `clone: true`.

Expected submit payload:

```ts
expect(profilesStore.createProfile).toHaveBeenCalledWith('web_coder', {
  clone: true,
  description: expect.stringContaining('Software engineering'),
})
```

**Step 2: Run failing test**

Run:

```bash
pnpm vitest run tests/client/profile-create-modal.test.ts
```

Expected: fails because modal only sends `(name, clone)`.

**Step 3: Add role preset model**

Inside `ProfileCreateModal.vue`:

```ts
const rolePresets = computed(() => [
  { label: t('profiles.roles.coder'), value: 'coder', description: t('profiles.roleDescriptions.coder') },
  { label: t('profiles.roles.researcher'), value: 'researcher', description: t('profiles.roleDescriptions.researcher') },
  { label: t('profiles.roles.writer'), value: 'writer', description: t('profiles.roleDescriptions.writer') },
  { label: t('profiles.roles.operator'), value: 'operator', description: t('profiles.roleDescriptions.operator') },
  { label: t('profiles.roles.custom'), value: 'custom', description: '' },
])
```

Use `NRadioGroup` or `NSegmented` if available locally. Prefer a compact segmented control if Naive UI supports it in the current dependency.

**Step 4: Submit description**

Update `handleSave()`:

```ts
const preset = rolePresets.value.find(item => item.value === selectedRole.value)
const description = selectedRole.value === 'custom'
  ? customDescription.value.trim()
  : preset?.description || ''

const res = await profilesStore.createProfile(name.value.trim(), {
  clone: clone.value,
  description,
})
```

**Step 5: Keep upstream modal shape**

Keep:

- Same modal width/card preset.
- Name validation.
- Clone cleanup notice.
- Existing success/error messages.

Add only the role preset and optional description field.

**Step 6: Run client test**

Run:

```bash
pnpm vitest run tests/client/profile-create-modal.test.ts
```

Expected: pass.

**Step 7: Commit**

```bash
git add packages/client/src/components/hermes/profiles/ProfileCreateModal.vue packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts packages/client/src/i18n/locales/zh-TW.ts tests/client/profile-create-modal.test.ts
git commit -m "feat(profiles): add role presets to profile creation"
```

## Task 3: Restore Upstream-Style Profile Manager Entry In User Mode

**Files:**
- Modify: `packages/client/src/components/layout/ProfileSelector.vue`
- Possibly reuse from upstream: `packages/client/src/components/hermes/profiles/ProfileAvatar.vue`
- Possibly modify: `packages/client/src/api/hermes/profiles.ts`
- Test: `tests/client/sidebar-search.test.ts` or new `tests/client/profile-selector-user-mode.test.ts`

**Step 1: Write failing user-mode selector test**

Given owner-scoped profiles in `profilesStore.profiles`, assert sidebar profile selector shows:

- Current active profile.
- A control to open the profile manager modal.
- A create button inside the modal.
- No import/export/delete/gateway restart controls in user-mode.

Expected after opening modal:

```ts
expect(wrapper.text()).toContain('Profiles')
expect(wrapper.find('[data-testid="profile-create-button"]').exists()).toBe(true)
expect(wrapper.text()).not.toContain('Import')
expect(wrapper.text()).not.toContain('Restart Gateway')
```

**Step 2: Run failing test**

Run:

```bash
pnpm vitest run tests/client/sidebar-search.test.ts
```

or the new focused test file.

**Step 3: Implement modal entry with upstream-first rule**

Use upstream `ProfileSelector` as the source. Port it with the smallest possible local edits:

- Display active profile and avatar if avatar support is present.
- Click opens the same upstream-style modal listing `profilesStore.profiles`, if upstream currently has one.
- Add `+` button opens `ProfileCreateModal`.
- Switch profile still uses `profilesStore.switchProfile(name)` and reloads.
- In user-mode, hide admin runtime controls.
- Avoid redesigning the list/modal; only filter actions by plane/owner.

**Step 4: Add data-testids**

Use stable test ids:

```vue
data-testid="profile-selector-current"
data-testid="profile-manager-modal"
data-testid="profile-create-button"
```

**Step 5: Run tests**

Run:

```bash
pnpm vitest run tests/client/sidebar-search.test.ts tests/client/profile-create-modal.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add packages/client/src/components/layout/ProfileSelector.vue tests/client/sidebar-search.test.ts tests/client/profile-selector-user-mode.test.ts
git commit -m "feat(profiles): expose owner profile manager in user mode"
```

## Task 4: Multitenancy Provisioning API For Owned WebUI Profiles

**Repository:** `/Users/kite/code/hermes-multitenancy`

**Files:**
- Create or modify: `hermes_multitenancy/profile_provisioning.py`
- Modify: `hermes_multitenancy/webui_broker_server.py`
- Modify: `hermes_multitenancy/routing.py`
- Test: `tests/test_webui_profile_provisioning.py`

**Step 1: Start an ftask worktree for multitenancy**

Run from `/Users/kite/code/hermes-multitenancy`:

```bash
bun ~/.claude/PAI/TOOLS/ftask.ts new webui-profile-provisioning --repo /Users/kite/code/hermes-multitenancy
```

Fill/approve the ftask spec before code, per repo rules.

**Step 2: Write failing pytest**

Test an authenticated WebUI sidecar endpoint:

```python
def test_webui_profile_provisioning_creates_owned_agent_route(tmp_path, monkeypatch):
    # Given owner ou_owner and profile web_coder
    # POST /api/run-broker/profiles with X-Hermes-Owner-Open-Id
    # creates/updates routing row:
    # kind='agent'
    # provenance='webui-agent'
    # owner_open_id='ou_owner'
    # upstream_profile='feishu_g41a5b5g'
    # agent_id='webui:ou_owner:web_coder' or another stable unique id
    # display_label='web_coder'
```

Also assert:

- Missing owner header returns 403.
- A different owner cannot claim an existing active child route.
- No credential vault/UAT rows are copied.

**Step 3: Implement profile provisioning helper as the compatibility layer**

Add a helper:

```python
def provision_webui_owned_profile(
    *,
    owner_open_id: str,
    profile_name: str,
    upstream_profile: str | None,
    display_label: str | None = None,
    description: str | None = None,
) -> RoutingRow:
```

It should:

- Validate owner and profile identifiers.
- Insert/update `multitenancy_routing`.
- Set stable `agent_id`.
- Set `kind='agent'`, `provenance='webui-agent'`.
- Preserve owner immutability for existing active rows.
- Not copy secrets.
- Reuse existing group/child profile inheritance helpers where available instead of adding a separate WebUI-only inheritance model.
- Avoid assumptions about WebUI internals; this endpoint should be a generic owner-child profile provisioning primitive.

**Step 4: Add Run Broker endpoint**

Add sidecar route:

```http
POST /api/run-broker/profiles
X-Hermes-Owner-Open-Id: <trusted openid>
Authorization: Bearer <broker key>
```

Payload:

```json
{
  "profile_name": "web_coder",
  "upstream_profile": "feishu_g41a5b5g",
  "display_label": "web_coder",
  "description": "Software engineering agent..."
}
```

Response:

```json
{
  "profile_name": "web_coder",
  "agent_id": "webui:ou_owner:web_coder",
  "owner_open_id": "ou_owner"
}
```

**Step 5: Tests**

Run:

```bash
pytest tests/test_webui_profile_provisioning.py tests/test_webui_broker_server.py tests/test_group_routing.py -q
```

Expected: pass.

**Step 6: Commit**

```bash
git add hermes_multitenancy/profile_provisioning.py hermes_multitenancy/webui_broker_server.py hermes_multitenancy/routing.py tests/test_webui_profile_provisioning.py
git commit -m "feat(webui): provision owner-scoped profiles"
```

## Task 5: WebUI Uses Multitenancy Provisioning When Available

**Repository:** `/Users/kite/code/hermes-web-ui.tasks/webui-upstream-0530`

**Files:**
- Modify: `packages/server/src/controllers/hermes/profiles.ts`
- Modify or create: `packages/server/src/services/hermes/owned-profile-provisioning.ts`
- Modify: `packages/server/src/services/hermes/agent-ownership.ts`
- Test: `tests/server/user-mode-controllers.test.ts`
- Test: `tests/server/profiles-routes.test.ts`

**Step 1: Write failing tests**

In chat-plane create flow, mock Run Broker sidecar endpoint and assert WebUI calls it:

```ts
expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8876/api/run-broker/profiles', expect.objectContaining({
  method: 'POST',
  headers: expect.objectContaining({
    'X-Hermes-Owner-Open-Id': 'ou_owner',
  }),
  body: expect.stringContaining('"profile_name":"web_coder"'),
}))
```

Also assert fallback still calls `registerOwnedProfile()` if broker returns 404 or is unavailable, so local dev is not blocked.

**Step 2: Implement service wrapper**

Create:

```ts
export async function provisionOwnedProfileViaBroker(options: {
  ownerOpenId: string
  profileName: string
  upstreamProfile?: string
  displayLabel?: string
  description?: string
}): Promise<boolean>
```

Use `config.runBrokerUrl` and `config.runBrokerKey`.

Headers:

```ts
{
  'Content-Type': 'application/json',
  ...(config.runBrokerKey ? { Authorization: `Bearer ${config.runBrokerKey}` } : {}),
  'X-Hermes-Owner-Open-Id': ownerOpenId,
}
```

**Step 3: Controller integration keeps direct DB writes transitional**

After `hermesCli.createProfile(...)`, in chat-plane:

```ts
const brokerOk = await provisionOwnedProfileViaBroker(...)
if (!brokerOk) registerOwnedProfile(user.openid, name, user.profile)
```

Keep `registerOwnedProfile` as compatibility only.

Add a TODO/comment near fallback:

```ts
// Transitional fallback for local dev while older multitenancy sidecars do not
// expose /api/run-broker/profiles. The broker endpoint is the owner of routing
// semantics once available.
```

**Step 4: Tests**

Run:

```bash
pnpm vitest run tests/server/user-mode-controllers.test.ts tests/server/profiles-routes.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add packages/server/src/controllers/hermes/profiles.ts packages/server/src/services/hermes/owned-profile-provisioning.ts packages/server/src/services/hermes/agent-ownership.ts tests/server/user-mode-controllers.test.ts tests/server/profiles-routes.test.ts
git commit -m "feat(profiles): provision owner routes through broker"
```

## Task 6: Role Description Visibility And Group Agent Reuse

**Files:**
- Modify: `packages/client/src/api/hermes/profiles.ts`
- Modify: `packages/server/src/services/hermes/hermes-cli.ts`
- Modify: `packages/server/src/controllers/hermes/profiles.ts`
- Modify if needed: `packages/client/src/components/hermes/group-chat/*`
- Test: `tests/client/group-chat-view.test.ts`
- Test: `tests/server/group-chat-isolation.test.ts`

**Step 1: Extend profile list/detail to include description without Hermes core edits**

Hermes CLI `profile list` may not expose description in table output. Do not change Hermes core for this. Prefer one of:

1. Use `profile show` / existing CLI output if it exposes description in the installed version.
2. Add a WebUI-side safe reader for `<profile>/profile.yaml` for profiles the current owner is already allowed to see.
3. Defer list-level description and only pass description at creation time.

Recommended first implementation: option 3 for minimal drift. Add list-level description only if group add-agent UX needs it.

Minimal API type:

```ts
description?: string
descriptionAuto?: boolean
```

**Step 2: Use description in group add-agent UI**

When adding a profile to a group room:

- Default agent display name = profile display label or profile name.
- Default agent description = profile description.
- User may override name/description in the add-agent modal.

**Step 3: Tests**

Run:

```bash
pnpm vitest run tests/client/group-chat-view.test.ts tests/server/group-chat-isolation.test.ts
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/client/src/api/hermes/profiles.ts packages/server/src/services/hermes/hermes-cli.ts packages/server/src/controllers/hermes/profiles.ts packages/client/src/components/hermes/group-chat tests/client/group-chat-view.test.ts tests/server/group-chat-isolation.test.ts
git commit -m "feat(group-chat): reuse profile descriptions for agents"
```

## Task 7: End-To-End Verification

**Files:**
- Update: `ARCHITECTURE-GUIDE.md`
- Update: `/Users/kite/Library/Mobile Documents/iCloud~md~obsidian/Documents/My-Second-Brain/hermes/ARCHITECTURE-GUIDE.md`
- Update: `/Users/kite/Library/Mobile Documents/iCloud~md~obsidian/Documents/My-Second-Brain/hermes/生产环境的实况.md`

**Step 1: Run WebUI focused tests**

```bash
pnpm vitest run \
  tests/client/profile-create-modal.test.ts \
  tests/client/sidebar-search.test.ts \
  tests/server/profiles-routes.test.ts \
  tests/server/user-mode-controllers.test.ts \
  tests/server/group-chat-isolation.test.ts
```

Expected: all pass.

**Step 2: Run WebUI build**

```bash
pnpm run build
```

Expected: pass; existing dynamic import / chunk warnings are acceptable.

**Step 3: Run multitenancy focused tests**

From the multitenancy task worktree:

```bash
pytest tests/test_webui_profile_provisioning.py tests/test_webui_broker_server.py tests/test_group_routing.py -q
```

Expected: pass.

**Step 4: Restart local services**

```bash
launchctl kickstart -k gui/$(id -u)/com.hermes.multitenancy-run-broker
launchctl kickstart -k gui/$(id -u)/com.hermes.ekko-webui-upstream-0530
```

**Step 5: Manual local canary**

In `http://localhost:8648/#/hermes/chat`:

1. Open profile selector.
2. Create profile `web_coder_canary` with Coder role.
3. Confirm it appears in selector.
4. Switch to it.
5. Send a WebUI message; verify Run Broker accepts owner + agent identity.
6. Add it to a group room; mention it; verify reply renders in Web group chat.

DB checks:

```sql
SELECT profile_name, owner_open_id, kind, provenance, agent_id, display_label
FROM multitenancy_routing
WHERE profile_name = 'web_coder_canary';
```

Expected:

- `owner_open_id` is current user openid.
- `kind='agent'`.
- `provenance='webui-agent'`.
- `agent_id` is populated.

**Step 6: Cleanup canary**

If no delete UI is opened in user-mode, cleanup from local test DB/profile manually only after recording evidence. Do not touch production.

**Step 7: Docs**

Update architecture docs with:

- Upstream WebUI profile creation inherited.
- Role preset semantics = Hermes core `profile.yaml.description`.
- multitenancy owns owner-scoped route provisioning.
- user-mode admin operations still hidden.
- production not published.

**Step 8: Final checks**

```bash
git diff --check
git status --short
```

Expected: clean except intended docs before final commit.

**Step 9: ftask state**

```bash
bun ~/.claude/PAI/TOOLS/ftask.ts state webui-upstream-0530 --note "Planned/implemented owner-scoped WebUI profile creation with role descriptions; production unchanged."
```

For multitenancy:

```bash
bun ~/.claude/PAI/TOOLS/ftask.ts state webui-profile-provisioning --note "Implemented broker-side owner profile provisioning for WebUI-created profiles; production unchanged."
```

## Rollout Notes

- Local only first.
- Do not publish to 66 until WebUI and multitenancy branches are both shipped to their canonical main branches and local canary is green.
- Production publish requires the normal path: GitHub push, production `git pull --ff-only`, WebUI build, systemd restart, health/log/canary verification.
- If multitenancy endpoint is not ready, WebUI may keep compatibility fallback, but mark it as transitional in docs.
- Do not patch `/Users/kite/.hermes/hermes-feishu-uat` for this feature. If Hermes core lacks a capability, stop and re-scope rather than forking it.

## Open Decisions Before Implementation

1. Preset labels: start with `Coder / Researcher / Writer / Operator`, or include `Assistant` as a generic default?
2. In user-mode, should profile creation clone current profile by default, or default to fresh profile with bundled skills? Recommended: default clone off, but keep toggle visible.
3. Should users be allowed to rename/delete their own child profiles later? Recommended: not in this iteration.
