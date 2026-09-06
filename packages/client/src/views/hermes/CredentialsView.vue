<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NAlert, NButton, NFormItem, NInput, NModal, NSelect, NSpin, useMessage } from 'naive-ui'
import { completeSkillCredentialAuth, fetchSkillCredentials, pollFeishuUatSession, startSkillCredentialAuth } from '@/api/skillCredentials'
import { revokeGithubToken, submitGithubToken, submitGitlabToken } from '@/api/skillCredentials'
import type { SkillCredentialEntry, SkillCredentialsResponse } from '@/api/skillCredentials'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { readCachedConnectorStatus, writeCachedConnectorStatus } from '@/utils/connector-status-cache'
import ConnectorCatalogPanel from '@/components/hermes/connectors/ConnectorCatalogPanel.vue'

const message = useMessage()
const { t } = useI18n()
const route = useRoute()
const profilesStore = useProfilesStore()
const props = withDefaults(defineProps<{
  embedded?: boolean
  preferActiveProfile?: boolean
}>(), {
  embedded: false,
  preferActiveProfile: false,
})
const loading = ref(false)
const startingId = ref('')
const completingId = ref('')
const error = ref('')
const data = ref<SkillCredentialsResponse | null>(null)
const qrDialog = ref<{
  id: string
  title: string
  qrcodeId: string
  qrcodeUrl: string
  redirectUrl?: string
} | null>(null)
const oauthPollingId = ref('')
// The auth popup we open (window.open) — kept so we can auto-close it once the
// credential reaches an authenticated state (the kep-auth success page can't close
// itself; we opened it, so we can). Tagged with a per-ATTEMPT token (not just the
// connector id) so an older poll cannot close a newer popup — even for the same
// connector started twice. `authWindowOwnerId` records which connector the current
// popup belongs to (for the focus handler); `authWindowToken` is the live attempt.
let authWindow: Window | null = null
let authWindowOwnerId = ''
let authWindowToken = 0
let authWindowSessionId = ''
let attemptSeq = 0
// Set on unmount so an in-flight poll stops touching a torn-down component.
let pollAbort = false
// Monotonic load id — a late response from a superseded load (e.g. after a profile
// switch) must not overwrite the current panel.
let loadSeq = 0

const credentials = computed(() => data.value?.credentials || [])
const routeProfile = computed(() => typeof route.query.profile === 'string' ? route.query.profile.trim() : '')
const requestedCredentialId = computed(() => typeof route.query.open_credential === 'string' ? route.query.open_credential.trim() : '')
const larkAuthRequired = computed(() => route.query.lark_auth === 'required')
const requestedProfile = computed(() => {
  const activeProfile = profilesStore.activeProfileName || ''
  return props.preferActiveProfile ? activeProfile : routeProfile.value || activeProfile
})
let profileWatchReady = false
const internalCredentialIds = new Set(['lark-cli', 'feishu-project', 'keep-record', 'kep-cli-online', 'kep-cli-pre', 'kep-cli', 'keep-cli'])
const credentialGroups = computed(() => {
  const internal = credentials.value.filter(entry => internalCredentialIds.has(entry.id))
  const other = credentials.value.filter(entry => !internalCredentialIds.has(entry.id))
  return [
    internal.length ? { id: 'internal-systems', title: t('skillCredentials.groups.internalSystems'), entries: internal } : null,
    other.length ? { id: 'other-credentials', title: t('skillCredentials.groups.otherCredentials'), entries: other } : null,
  ].filter(Boolean) as Array<{ id: string; title: string; entries: SkillCredentialEntry[] }>
})

function statusLabel(status: SkillCredentialEntry['status']) {
  if (status === 'authenticated') return '已认证'
  if (status === 'configured') return 'Token 可读'
  if (status === 'needs_auth') return '未认证'
  if (status === 'unknown') return '待验证'
  if (status === 'missing') return '未安装'
  if (status === 'error') return '检测失败'
  return '未知'
}

function statusClass(status: SkillCredentialEntry['status']) {
  return `status-${status.replace('_', '-')}`
}

// --- instant render (stale-while-revalidate) --------------------------------
// The panel does ~5 live CLI checks server-side (~2s cold), so a fresh open used to
// block on a spinner. Instead we paint the LAST-KNOWN status (from a prior visit)
// immediately and refresh in the background. The cache read/write live in a shared
// util so the background pre-warm (on app init / profile switch) uses the same format.
function hydrateFromCache(profile: string) {
  if (data.value) return
  const cached = readCachedConnectorStatus(profile)
  if (cached) data.value = cached
}

function persistToCache(profile: string) {
  writeCachedConnectorStatus(profile, data.value)
}

async function loadCredentials(opts?: { fresh?: boolean }) {
  // Paint last-known instantly, then revalidate. The blocking spinner only shows on a
  // true cold first visit (no cached data) — see <NSpin :show="loading && !data">.
  hydrateFromCache(requestedProfile.value)
  // Own a load id so a SUPERSEDED load (e.g. after a profile switch) can't write back
  // data, error, or loading over the current one — including via the error channel.
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    await ensureProfileSelection()
    await refreshCredentials(opts?.fresh, seq)
  } catch (err: any) {
    // Only the current load may set the error, and never over a good cached view.
    if (seq === loadSeq && !data.value) error.value = err?.message || '连接器状态加载失败'
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function ensureProfileSelection() {
  if (!requestedProfile.value && (!profilesStore.activeProfileName || profilesStore.profiles.length === 0)) {
    await profilesStore.fetchProfiles()
  }
}

async function refreshCredentials(fresh = false, seq?: number) {
  // Cached load keeps the single-arg call shape; only the fresh path passes options.
  // `seq` is the owning load's id when called from loadCredentials. Background callers
  // (poll/focus) omit it and SNAPSHOT the current seq — they must NOT bump it, or they'd
  // steal an in-flight loadCredentials' loading/error ownership and strand the spinner.
  // Only loadCredentials increments loadSeq.
  const profile = requestedProfile.value
  const mySeq = seq ?? loadSeq
  const result = fresh
    ? await fetchSkillCredentials(profile, { fresh: true })
    : await fetchSkillCredentials(profile)
  // Drop a stale response: a newer load superseded this one (seq), OR the profile changed
  // under us (covers a switch during the initial mount load, before the watcher is ready,
  // where loadSeq wasn't bumped). Either way, never write another profile's data here.
  if (mySeq !== loadSeq || profile !== requestedProfile.value) return
  data.value = result
  persistToCache(profile)  // remember for the next visit's instant paint
}

function closeAuthWindow(token?: number) {
  // When called with a token (from a poll/focus), only close if that attempt still
  // owns the popup — guards against an older poll closing a newer popup, even for the
  // same connector re-started. Called with no token (explicit cleanup before a new
  // attempt) it always closes.
  if (token !== undefined && token !== authWindowToken) return
  if (authWindow && !authWindow.closed) {
    try { authWindow.close() } catch { /* best-effort: cross-origin window we opened */ }
  }
  authWindow = null
  authWindowOwnerId = ''
  authWindowToken = 0
  authWindowSessionId = ''
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function credentialReachedTerminalAuthState(id: string) {
  // "settled" — stop polling. Includes `unknown` (待验证): an indeterminate result
  // we won't keep retrying. NOTE: this is NOT the same as success — see below.
  const credential = credentials.value.find(item => item.id === id)
  return credential?.status === 'authenticated' || credential?.status === 'configured' || credential?.status === 'unknown'
}

function credentialAuthSucceeded(id: string) {
  // Genuine success only — used to AUTO-CLOSE the popup. `unknown`/待验证 must NOT
  // close it, or we'd hide a failed/indeterminate auth as if it were done.
  const credential = credentials.value.find(item => item.id === id)
  return credential?.status === 'authenticated' || credential?.status === 'configured'
}

async function pollCredentialAfterOAuth(id: string, token: number, sessionId = '') {
  oauthPollingId.value = id
  try {
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await sleep(2_500)
      if (pollAbort) return  // component unmounted — stop touching it
      if (token !== attemptSeq) return  // superseded by a newer attempt or a profile switch
      if (sessionId && id === 'lark-cli') {
        const session = await pollFeishuUatSession(sessionId, requestedProfile.value)
        if (pollAbort) return
        if (token !== attemptSeq) return
        if (session.status === 'pending') continue
        if (session.status === 'success') {
          await refreshCredentials(true)
          if (credentialAuthSucceeded(id)) closeAuthWindow(token)
          return
        }
        message.error(session.error || 'Lark-cli 授权未完成，请重试')
        return
      }
      await refreshCredentials(true)  // fresh: bypass the broker cache to see the new login
      if (credentialAuthSucceeded(id)) {
        closeAuthWindow(token)  // close only THIS attempt's popup, on genuine success
        return
      }
      if (credentialReachedTerminalAuthState(id)) return  // settled but not success (待验证) → stop, leave popup
    }
  } catch (err: any) {
    if (sessionId && id === 'lark-cli' && !pollAbort && token === attemptSeq) {
      message.error(err?.message || 'Lark-cli 授权状态检查失败，请重试')
    }
    // The manual refresh button remains available if a background poll fails.
  } finally {
    // Only clear the indicator if THIS poll is still the current attempt — a superseded
    // poll must not hide a newer poll's loading state.
    if (oauthPollingId.value === id && token === attemptSeq) oauthPollingId.value = ''
  }
}

const gitlabDialog = ref<{ title: string } | null>(null)
/** GitLab 建 token 页要勾的 scope，与档位一一对应。文案里明写出来，否则员工在 GitLab
 *  那一长串 checkbox 里根本不知道该勾哪几个（sunke 2026-08-05 反馈：卡片没指引）。 */
const GITLAB_TIER_SCOPES: Record<'read' | 'write', string[]> = {
  read: ['read_api', 'read_repository'],
  write: ['api', 'write_repository'],
}
const gitlabScopes = computed(() => GITLAB_TIER_SCOPES[gitlabForm.value.tier] || [])
/** 建 token 页基址来自服务端运行时配置（未配置则为空 → 不渲染链接）。
 *  绝不写死内网域名：本仓有 GitHub 远端。 */
const gitlabBaseUrl = ref('')
/** 直达建 token 页，并预填 name 与该档位的 scopes —— GitLab 支持这两个 query 参数。 */
const gitlabTokenUrl = computed(() => {
  if (!gitlabBaseUrl.value) return ''
  const params = new URLSearchParams({ name: 'hermes', scopes: gitlabScopes.value.join(',') })
  return `${gitlabBaseUrl.value}/-/profile/personal_access_tokens?${params.toString()}`
})
const gitlabForm = ref({ tier: 'read' as 'read' | 'write', token: '' })
const gitlabSubmitting = ref(false)
const gitlabError = ref('')
const githubDialog = ref<{ title: string } | null>(null)
const githubToken = ref('')
const githubSubmitting = ref(false)
const githubRevoking = ref(false)
const githubRevokeDialog = ref(false)
const githubError = ref('')
let githubAttempt = 0

/** Which entries open the personal-token form instead of an interactive auth flow.
 *
 * Keyed on provider + manual action, NOT on a literal id: the broker splits GitLab
 * into two rows (`gitlab` = the admin-placed global token, `gitlab-personal` = the
 * employee's own), and an `id === 'gitlab'` check would leave the personal card's
 * button doing nothing — which is the exact bug this card exists to fix.
 * The global row never reaches here: the broker sends no action for it and `coerceAction`
 * passes that absence through, so its button is never rendered in the first place.
 *
 * 判据只看 provider，不再叠 `action.kind === 'manual'`：kind 是一路 broker → 适配层
 * 传下来的数据，任何一环漂了(降级卡、旧缓存、reader 改字段)这个条件就悄悄变假，按钮
 * 掉进 startCredential，员工只看到一句「认证流程已启动」而没有表单。GitLab 根本没有
 * 交互式流程，provider 就足够判。
 */
function isGitlabTokenEntry(entry: SkillCredentialEntry) {
  return entry.provider === 'gitlab'
}

function isGithubTokenEntry(entry: SkillCredentialEntry) {
  return entry.id === 'github-mcp' && entry.provider === 'github'
}

/** 一颗按钮三种去处 —— 这里是唯一的分流点。
 *
 *  `retry` 排在最前：broker 挂掉时 failSafeResult 把每一行都变成这种卡，按钮语义是
 *  "再读一次状态"，不是"启动认证"。以前它走 startCredential，服务端回一个空操作 200，
 *  于是弹一句绿色「认证流程已启动」——什么都没启动。
 *
 *  判据用 kind 而不是 `status === 'error'`：真 error 态（broker 活着但某个 reader 挂了）
 *  的 GitLab 个人卡仍然该能打开绑定表单，按 status 一刀切会把绑定入口一起堵死（codex 复评）。 */
function onCredentialAction(entry: SkillCredentialEntry) {
  if (entry.action?.kind === 'retry') {
    void loadCredentials({ fresh: true })
    return
  }
  if (isGitlabTokenEntry(entry)) {
    openGitlabDialog(entry)
    return
  }
  if (isGithubTokenEntry(entry)) {
    openGithubDialog(entry)
    return
  }
  void startCredential(entry)
}

function openGithubDialog(entry: SkillCredentialEntry) {
  githubAttempt += 1
  githubSubmitting.value = false
  githubToken.value = ''
  githubError.value = ''
  githubDialog.value = { title: entry.title }
}

function closeGithubDialog() {
  githubAttempt += 1
  githubSubmitting.value = false
  githubToken.value = ''
  githubError.value = ''
  githubDialog.value = null
}

async function confirmGithubToken() {
  if (githubSubmitting.value) return
  const token = githubToken.value.trim()
  if (!token) return
  const attempt = githubAttempt
  const profile = requestedProfile.value
  githubSubmitting.value = true
  githubError.value = ''
  try {
    const result = await submitGithubToken(token, profile)
    if (attempt !== githubAttempt || profile !== requestedProfile.value) return
    if (!result?.ok) {
      githubError.value = result?.error || t('skillCredentials.github.failed')
      return
    }
    closeGithubDialog()
    await loadCredentials({ fresh: true })
  } catch (err: any) {
    if (attempt !== githubAttempt || profile !== requestedProfile.value) return
    githubError.value = err?.data?.error || err?.message || t('skillCredentials.github.failed')
  } finally {
    if (attempt === githubAttempt) githubSubmitting.value = false
  }
}

function openGithubRevokeDialog() {
  githubRevokeDialog.value = true
}

function closeGithubRevokeDialog() {
  githubRevokeDialog.value = false
  githubRevoking.value = false
}

async function confirmGithubRevoke() {
  if (githubRevoking.value) return
  const attempt = githubAttempt
  const profile = requestedProfile.value
  githubRevoking.value = true
  try {
    const result = await revokeGithubToken(profile)
    if (attempt !== githubAttempt || profile !== requestedProfile.value) return
    if (!result?.ok) {
      message.error(result?.error || t('skillCredentials.github.failed'))
      return
    }
    closeGithubRevokeDialog()
    message.success(t('skillCredentials.github.revoked'))
    await loadCredentials({ fresh: true })
  } catch (err: any) {
    if (attempt !== githubAttempt || profile !== requestedProfile.value) return
    message.error(err?.data?.error || err?.message || t('skillCredentials.github.failed'))
  } finally {
    if (attempt === githubAttempt) githubRevoking.value = false
  }
}

/** GitLab has no interactive auth flow — the employee supplies the token, so
 *  this row opens a form instead of starting a device/QR flow. */
async function loadGitlabBaseUrl() {
  if (gitlabBaseUrl.value) return
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const status = await res.json().catch(() => ({})) as { gitlabBaseUrl?: unknown }
    if (typeof status.gitlabBaseUrl === 'string') gitlabBaseUrl.value = status.gitlabBaseUrl.trim()
  } catch { /* 拿不到就不显示链接，不影响填写 */ }
}

function openGitlabDialog(entry: SkillCredentialEntry) {
  void loadGitlabBaseUrl()
  gitlabForm.value = { tier: 'read', token: '' }
  gitlabError.value = ''
  gitlabDialog.value = { title: entry.title }
}

function openRequestedCredential() {
  if (requestedCredentialId.value !== 'gitlab-personal') return
  const entry = credentials.value.find(item => item.id === requestedCredentialId.value && isGitlabTokenEntry(item))
  if (entry) openGitlabDialog(entry)
}

async function confirmGitlabToken() {
  gitlabSubmitting.value = true
  gitlabError.value = ''
  try {
    // The panel profile rides along as a target hint: on a group profile the
    // broker binds the GROUP (owner only) and says so in `note`.
    const res = await submitGitlabToken({
      tier: gitlabForm.value.tier,
      token: gitlabForm.value.token,
    }, requestedProfile.value)
    if (!res?.ok) {
      gitlabError.value = res?.reason || res?.error || '保存失败，请稍后重试'
      return
    }
    // Never keep the token in memory after a successful hand-off.
    gitlabForm.value.token = ''
    gitlabDialog.value = null
    if (res.note) message.success(res.note)
    // fresh: bypass the broker's short-TTL connector cache — without it the
    // card repaints the pre-bind status and the bind reads as a failure
    // (the 2026-08-14 zhaozhiguang report).
    await loadCredentials({ fresh: true })
  } catch (err: any) {
    gitlabError.value = err?.data?.reason || err?.data?.error || err?.message || '保存失败，请稍后重试'
  } finally {
    gitlabSubmitting.value = false
  }
}

async function startCredential(entry: SkillCredentialEntry) {
  startingId.value = entry.id
  // Mint the attempt token BEFORE the await so it marks the LATEST user start. If a
  // newer start supersedes this one while the request is in flight, the stale result
  // is dropped below — otherwise an out-of-order response could close a newer popup
  // and open a stale one.
  const attemptToken = ++attemptSeq
  try {
    const result = entry.action?.env
      ? await startSkillCredentialAuth(entry.id, requestedProfile.value, { env: entry.action.env })
      : await startSkillCredentialAuth(entry.id, requestedProfile.value)
    if (attemptToken !== attemptSeq) return  // a newer attempt superseded this one
    if (result.qrcode_id && result.qrcode_url) {
      qrDialog.value = {
        id: entry.id,
        title: entry.title,
        qrcodeId: result.qrcode_id,
        qrcodeUrl: result.qrcode_url,
        redirectUrl: result.redirect_url,
      }
      return
    }
    if (result.verification_uri) {
      closeAuthWindow()  // close any stale popup from a previous attempt
      authWindow = window.open('about:blank', '_blank')
      authWindowOwnerId = authWindow ? entry.id : ''
      authWindowToken = authWindow ? attemptToken : 0
      authWindowSessionId = authWindow ? result.session_id || '' : ''
      if (authWindow) {
        authWindow.opener = null
        authWindow.location.href = result.verification_uri
      } else {
        window.location.assign(result.verification_uri)
      }
      void pollCredentialAfterOAuth(entry.id, attemptToken, result.session_id || '')
      message.success(result.user_code ? `${entry.title}: ${result.user_code}` : `${entry.title} 认证流程已启动`)
      return
    }
    // 走到这里，响应里没有二维码、没有授权链接、也没有设备码 —— 什么都没启动。
    // 以前这里照样弹绿色「认证流程已启动」，员工点一次绿一次、卡片纹丝不动
    // (ligaofeng 2026-08-06 的 GitLab 绑定)。没启动就别报成功：刷新面板，如实说。
    if (result.user_code) {
      message.success(`${entry.title}: ${result.user_code}`)
    } else {
      message.warning(t('skillCredentials.noInteractiveFlow', { name: entry.title }))
    }
    await loadCredentials()
  } catch (err: any) {
    message.error(err?.message || `${entry.title} 认证启动失败`)
    // 降级卡的「重试」也走这条路：启动失败仍然要把面板重新读一遍，否则 broker 一恢复
    // 员工也只能干看着一排「重试」。刷新失败不再叠一次报错。
    await loadCredentials().catch(() => { /* 手动刷新按钮还在 */ })
  } finally {
    // 只清自己那次的 loading：catch 里多了一次 await，旧请求会活得比以前久，
    // 无条件清空会把期间开始的新一次点击的 loading 提前抹掉（codex 评审）。
    if (attemptToken === attemptSeq) startingId.value = ''
  }
}

async function completeQrCredential() {
  if (!qrDialog.value) return
  const current = qrDialog.value
  completingId.value = current.id
  try {
    const result = await completeSkillCredentialAuth(current.id, current.qrcodeId, requestedProfile.value)
    message.success(result.account_hint ? `${current.title} 已认证：${result.account_hint}` : `${current.title} 已认证`)
    qrDialog.value = null
    await loadCredentials({ fresh: true })
  } catch (err: any) {
    message.error(err?.message || '还没有检测到扫码完成，请确认后再试')
  } finally {
    completingId.value = ''
  }
}

function closeQrDialog() {
  qrDialog.value = null
}

function handleWindowFocus() {
  // The user likely just returned from the auth popup. If a poll is in flight,
  // refresh immediately (fresh) instead of waiting for the next 2.5s tick, and
  // close the popup the moment auth is confirmed.
  if (!authWindowToken) return  // no active popup awaiting auth
  const id = authWindowOwnerId
  const token = authWindowToken
  // A lark-cli device-flow session has its own broker-backed poll. Do not let
  // a focus refresh close the popup from a stale already-authenticated row during
  // re-auth; only the session poll may close it after this attempt succeeds.
  if (id === 'lark-cli' && authWindowSessionId) return
  void refreshCredentials(true).then(() => {
    if (credentialAuthSucceeded(id)) closeAuthWindow(token)  // only close THIS attempt's popup, on success
  }).catch(() => { /* manual refresh stays available */ })
}

onMounted(async () => {
  window.addEventListener('focus', handleWindowFocus)
  // Activate the profile watcher BEFORE the initial load so a profile switch DURING that
  // load triggers a replacement load (the `profile === previous` guard still suppresses
  // the no-op fire when requestedProfile merely resolves to the same value).
  profileWatchReady = true
  await loadCredentials()
  openRequestedCredential()
})

onUnmounted(() => {
  pollAbort = true  // stop the in-flight poll from touching the torn-down component
  window.removeEventListener('focus', handleWindowFocus)
  closeAuthWindow()  // don't leave a stale auth popup open after navigating away
})

watch(requestedProfile, async (profile, previous) => {
  if (!profileWatchReady || profile === previous) return
  // Abandon any in-flight auth attempt tied to the previous profile: bump the seq so
  // its poll stops, and close its popup. The poll refreshes the reactive profile, so
  // without this it would poll the NEW profile and could mis-close (or never close)
  // the old profile's popup.
  attemptSeq += 1
  closeGithubDialog()
  closeGithubRevokeDialog()
  closeAuthWindow()
  oauthPollingId.value = ''
  // 这里必须显式清：startCredential 的 finally 只清"自己那次"，而上面刚把 attemptSeq
  // 顶掉了，被抛弃的那次回来时守卫不认它，loading 会永远转下去（codex 复评）。
  startingId.value = ''
  // Drop the previous profile's data so loadCredentials paints the NEW profile's
  // last-known (via hydrateFromCache) instead of briefly showing the old profile's.
  data.value = null
  await loadCredentials()
})
</script>

<template>
  <div class="credentials-view" :class="{ 'is-embedded': props.embedded }">
    <header class="page-header">
      <h2 class="header-title">{{ t('sidebar.connectors') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="() => loadCredentials({ fresh: true })">刷新</NButton>
    </header>

    <NAlert
      v-if="larkAuthRequired"
      data-testid="lark-auth-required"
      type="warning"
      :show-icon="false"
    >
      {{ t('skillCredentials.larkAuthRequired') }}
    </NAlert>

    <NSpin :show="loading && !data">
      <div v-if="error" class="credentials-error">{{ error }}</div>
      <div v-else class="credentials-sections">
        <section v-for="group in credentialGroups" :key="group.id" class="credential-section" :data-credential-group="group.id">
          <h3 class="credential-section-title">{{ group.title }}</h3>
          <div class="credentials-grid">
            <article
              v-for="entry in group.entries"
              :key="entry.id"
              class="credential-card"
              :class="statusClass(entry.status)"
            >
              <div class="credential-main">
                <div class="credential-icon" aria-hidden="true">{{ entry.title.slice(0, 1) }}</div>
                <div class="credential-copy">
                  <div class="credential-title-row">
                    <h3>{{ entry.title }}</h3>
                    <span class="credential-status">{{ statusLabel(entry.status) }}</span>
                  </div>
                  <div class="credential-meta">
                    <span>{{ entry.provider }}</span>
                    <span v-if="entry.default_identity">{{ entry.default_identity }}</span>
                    <span v-if="entry.account_hint">{{ entry.account_hint }}</span>
                  </div>
                  <p v-if="entry.detail" class="credential-detail">{{ entry.detail }}</p>
                  <code v-if="entry.action?.command" class="credential-command">{{ entry.action.command }}</code>
                </div>
              </div>
              <!-- 没有 action 的条目是纯陈述卡（如「GitLab（全局）」：管理员运维，员工点了
                   也改不了），给按钮等于骗人。判据是 action 本身在不在 —— 不再看 label 是否
                   为空：那个暗号分不清「没有操作」和「有操作但忘了填标签」，后者会静默变成
                   一张点不动的卡。broker 侧对无操作送 null，适配层 coerceAction 如实返回
                   undefined。 -->
              <div class="credential-actions">
                <NButton
                  v-if="isGithubTokenEntry(entry) && entry.status === 'authenticated'"
                  size="small"
                  secondary
                  :loading="githubRevoking"
                  data-credential-revoke="github-mcp"
                  @click="openGithubRevokeDialog"
                >{{ t('skillCredentials.github.revoke') }}</NButton>
                <NButton
                  v-if="entry.action"
                  size="small"
                  :loading="startingId === entry.id"
                  :disabled="entry.status === 'missing'"
                  :data-credential-action="entry.id"
                  @click="onCredentialAction(entry)"
                >
                  <!-- 兜底只管文案，不当渲染开关：渲不渲染由上面的 v-if="entry.action" 决定。
                       有 action 却缺 label 是数据问题，宁可显示「连接」也别渲染一颗空白按钮。 -->
                  {{ entry.action.label || '连接' }}
                </NButton>
              </div>
            </article>
          </div>
        </section>
      </div>
    </NSpin>

    <ConnectorCatalogPanel :profile="requestedProfile" />

    <NModal
      :show="!!gitlabDialog"
      preset="card"
      style="max-width: 520px"
      :title="`${gitlabDialog?.title || 'GitLab'} — 使用我自己的权限`"
      @update:show="(v: boolean) => { if (!v) gitlabDialog = null }"
    >
      <div class="gitlab-form">
        <p class="gitlab-hint">
          填你自己的 GitLab token，hermes 之后就用<strong>你本人的权限</strong>操作仓库。
        </p>
        <ol class="gitlab-steps">
          <li>
            在 GitLab 建 token，<strong>名字必须填 <code>hermes</code></strong>——我们靠这个名字核对你给的权限
            <a
              v-if="gitlabTokenUrl"
              class="gitlab-open-link"
              :href="gitlabTokenUrl"
              target="_blank"
              rel="noopener noreferrer"
            >去 GitLab 建 token →</a>
          </li>
          <li>
            按下面选的档位勾 scope，这一档要勾：
            <code v-for="scope in gitlabScopes" :key="scope" class="gitlab-scope">{{ scope }}</code>
          </li>
          <li><strong>在 GitLab 那边给 token 填一个到期日</strong>——不填我们不收；到期日会直接从 GitLab 读，不用抄回来</li>
        </ol>

        <NFormItem label="授权档位">
          <div class="gitlab-tier-field">
            <NSelect
              v-model:value="gitlabForm.tier"
              :options="[
                { label: '只读 — 看 MR/issue/流水线、拉代码（read_api + read_repository）', value: 'read' },
                { label: '可写 — 上面全部，外加改动和推代码（api + write_repository）', value: 'write' },
              ]"
            />
            <!-- 评审采纳：勾选指引直接跟在下拉下方随档位联动，只写在上面步骤里的话，
                 换档位的人不会回头看第 2 步。 -->
            <p class="gitlab-scope-hint">
              这一档要在 GitLab 勾：
              <code v-for="scope in gitlabScopes" :key="scope" class="gitlab-scope">{{ scope }}</code>
            </p>
          </div>
        </NFormItem>
        <NFormItem label="GitLab token">
          <NInput
            v-model:value="gitlabForm.token"
            type="password"
            show-password-on="click"
            placeholder="粘贴你的 token"
          />
        </NFormItem>
        <NAlert v-if="gitlabError" type="warning" :show-icon="false" class="gitlab-error">
          {{ gitlabError }}
        </NAlert>
        <p class="gitlab-note">
          我们靠 token 的名字核对权限，这能帮你发现填错档位，但没法严格保证你粘贴的就是那个 token。
          请自己确认交出的权限就是你想给的。
        </p>
      </div>
      <template #footer>
        <div class="gitlab-actions">
          <NButton size="small" @click="gitlabDialog = null">取消</NButton>
          <NButton
            size="small"
            type="primary"
            :loading="gitlabSubmitting"
            :disabled="!gitlabForm.token"
            @click="confirmGitlabToken"
          >
            提交
          </NButton>
        </div>
      </template>
    </NModal>

    <NModal
      :show="!!githubDialog"
      preset="card"
      style="max-width: 520px"
      :title="t('skillCredentials.github.title')"
      @update:show="(v: boolean) => { if (!v && !githubSubmitting) closeGithubDialog() }"
    >
      <div class="gitlab-form">
        <p>{{ t('skillCredentials.github.hint') }}</p>
        <NAlert type="info" :show-icon="false">{{ t('skillCredentials.github.readonly') }}</NAlert>
        <ol class="github-pat-guide">
          <li>
            <a
              class="github-pat-create-link"
              data-testid="github-pat-create-link"
              href="https://github.com/settings/personal-access-tokens/new?name=Hermes%20MCP&amp;description=Read-only%20GitHub%20MCP%20connector&amp;expires_in=30&amp;contents=read&amp;issues=read&amp;pull_requests=read&amp;metadata=read"
              target="_blank"
              rel="noopener noreferrer"
            >{{ t('skillCredentials.github.create') }}</a>
          </li>
          <li>{{ t('skillCredentials.github.repositoryAccess') }}</li>
          <li>{{ t('skillCredentials.github.permissions') }}</li>
          <li>{{ t('skillCredentials.github.returnToPaste') }}</li>
        </ol>
        <NFormItem :label="t('skillCredentials.github.token')">
          <NInput
            v-model:value="githubToken"
            type="password"
            show-password-on="click"
            :placeholder="t('skillCredentials.github.placeholder')"
          />
        </NFormItem>
        <NAlert v-if="githubError" type="warning" :show-icon="false">{{ githubError }}</NAlert>
      </div>
      <template #footer>
        <div class="gitlab-actions">
          <NButton size="small" :disabled="githubSubmitting" @click="closeGithubDialog">{{ t('skillCredentials.github.cancel') }}</NButton>
          <NButton
            size="small"
            type="primary"
            :loading="githubSubmitting"
            :disabled="!githubToken.trim()"
            data-testid="github-submit"
            @click="confirmGithubToken"
          >{{ t('skillCredentials.github.connect') }}</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      :show="githubRevokeDialog"
      preset="card"
      style="max-width: 420px"
      :title="t('skillCredentials.github.revoke')"
      @update:show="(v: boolean) => { if (!v && !githubRevoking) closeGithubRevokeDialog() }"
    >
      <p>{{ t('skillCredentials.github.revokeConfirm') }}</p>
      <template #footer>
        <div class="gitlab-actions">
          <NButton size="small" :disabled="githubRevoking" @click="closeGithubRevokeDialog">{{ t('skillCredentials.github.cancel') }}</NButton>
          <NButton
            size="small"
            type="error"
            :loading="githubRevoking"
            data-testid="github-revoke-confirm"
            @click="confirmGithubRevoke"
          >{{ t('skillCredentials.github.revoke') }}</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      :show="!!qrDialog"
      preset="card"
      class="qr-modal"
      :title="qrDialog ? `${qrDialog.title} 扫码登录` : ''"
      @update:show="value => { if (!value) closeQrDialog() }"
    >
      <div v-if="qrDialog" class="qr-auth">
        <img :src="qrDialog.qrcodeUrl" alt="Keep 扫码登录二维码" class="qr-image" />
        <p class="qr-copy">请使用 Keep App 扫描二维码完成登录。</p>
        <a :href="qrDialog.qrcodeUrl" target="_blank" rel="noreferrer" class="qr-link">二维码图片链接</a>
        <a v-if="qrDialog.redirectUrl" :href="qrDialog.redirectUrl" target="_blank" rel="noreferrer" class="qr-link">登录跳转链接</a>
        <div class="qr-actions">
          <NButton @click="closeQrDialog">取消</NButton>
          <NButton type="primary" :loading="completingId === qrDialog.id" @click="completeQrCredential">已完成扫码</NButton>
        </div>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.credentials-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;

  &.is-embedded {
    height: 100%;
    min-height: 0;
    // Embedded in the expert panel the parent is overflow:hidden, so without
    // this the content simply overflows out of view and the bottom rows
    // (GitLab among them) are unreachable — measured 1004px of content in a
    // 628px box. Pre-existing; confirmed by A/B against a build without the
    // GitLab form.
    overflow-y: auto;

  }
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.credentials-sections {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 20px;
}

.credential-section-title {
  margin: 0 0 10px;
  color: $text-primary;
  font-size: 14px;
  font-weight: 650;
}

.credentials-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
  grid-auto-rows: 1fr;
  gap: 12px;
}

.credential-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  height: 220px;
  box-sizing: border-box;
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-secondary;
}

.credential-main {
  flex: 1;
  width: 100%;
  min-width: 0;
  display: flex;
  gap: 12px;
}

.credential-actions {
  align-self: flex-end;
  display: flex;
  gap: 8px;
}

.credential-icon {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
  font-weight: 700;
}

.credential-copy {
  flex: 1;
  min-width: 0;
}

.credential-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;

  h3 {
    margin: 0;
    color: $text-primary;
    font-size: 15px;
    font-weight: 650;
  }
}

.credential-status {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  color: $text-secondary;
  background: $bg-primary;
}

.status-authenticated .credential-status,
.status-configured .credential-status {
  color: #0f7a3a;
  background: rgba(34, 197, 94, 0.12);
}

.status-needs-auth .credential-status,
.status-unknown .credential-status,
.status-error .credential-status {
  color: #9a3412;
  background: rgba(249, 115, 22, 0.12);
}

.credential-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  color: $text-secondary;
  font-size: 12px;
}

.credential-detail {
  margin: 9px 0 0;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.45;
}

.gitlab-open-link {
  margin-left: 6px;
  color: $accent-primary;
  text-decoration: none;
  white-space: nowrap;
}

.gitlab-open-link:hover {
  text-decoration: underline;
}

.github-pat-guide {
  margin: 12px 0 14px;
  padding-left: 22px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.6;
}

.github-pat-create-link {
  color: $accent-primary;
  font-weight: 600;
}

.gitlab-scope {
  margin-right: 4px;
  padding: 0 4px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  font-size: 12px;
}

.gitlab-tier-field {
  width: 100%;
}

.gitlab-scope-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: $text-secondary;
}

.credential-command {
  display: inline-block;
  max-width: 100%;
  margin-top: 8px;
  padding: 5px 7px;
  border-radius: $radius-sm;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-primary;
  background: $code-bg;
}

.credentials-error {
  margin: 20px;
  padding: 12px 14px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: $radius-md;
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.08);
}

:deep(.qr-modal) {
  max-width: 420px;
}

.qr-auth {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.qr-image {
  width: min(260px, 72vw);
  aspect-ratio: 1;
  object-fit: contain;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: #fff;
}

.qr-copy {
  margin: 0;
  color: $text-secondary;
  font-size: 14px;
}

.qr-link {
  color: $accent-primary;
  font-size: 13px;
  text-decoration: none;
}

.qr-actions {
  width: 100%;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
</style>
