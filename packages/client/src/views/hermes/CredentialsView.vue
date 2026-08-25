<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NAlert, NButton, NFormItem, NInput, NModal, NSelect, NSpin } from 'naive-ui'
import { completeSkillCredentialAuth, fetchSkillCredentials, pollFeishuUatSession, startSkillCredentialAuth } from '@/api/skillCredentials'
import { submitGitlabToken } from '@/api/skillCredentials'
import type { SkillCredentialEntry, SkillCredentialsResponse } from '@/api/skillCredentials'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { readCachedConnectorStatus, writeCachedConnectorStatus } from '@/utils/connector-status-cache'
import KpAppIcon from '@/components/kippies/KpAppIcon.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpCornerBtn from '@/components/kippies/KpCornerBtn.vue'
import MarketTabs from '@/components/hermes/market/MarketTabs.vue'

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
const requestedProfile = computed(() => {
  const activeProfile = profilesStore.activeProfileName || ''
  return props.preferActiveProfile ? activeProfile : routeProfile.value || activeProfile
})
let profileWatchReady = false
const searchQuery = ref('')

const visibleCredentials = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return credentials.value
  return credentials.value.filter(entry =>
    `${entry.title} ${entry.provider} ${entry.detail ?? ''}`.toLowerCase().includes(q))
})

// Split into category sections. A section with no entries is dropped entirely
// rather than rendered empty (e.g. searching "gitlab" hides the "内部系统" head).
const credentialGroups = computed(() => {
  const groups = [
    { key: 'internal', titleKey: 'connectors.internalSystems', entries: visibleCredentials.value.filter(isInternalSystem) },
    { key: 'other', titleKey: 'connectors.otherCredentials', entries: visibleCredentials.value.filter(entry => !isInternalSystem(entry)) },
  ]
  return groups.filter(group => group.entries.length > 0)
})

// Prototype AppIcon language: white tile, COLORED glyph. Real broker rows carry
// no icon/colour, so map known providers to Keep glyphs and hash ids into the
// prototype's hue palette for a stable per-connector tint.
const PROVIDER_GLYPHS: Record<string, string> = {
  lark: 'line_comment',
  'feishu-project': 'line_list',
  gitlab: 'line_compilations',
  keep: 'full_data',
}
const HUE_PALETTE = [
  'var(--hue-blue)',
  'var(--hue-orange)',
  'var(--hue-green)',
  'var(--hue-red)',
  'var(--hue-purple)',
  'var(--hue-cyan)',
  'var(--hue-yellow)',
  'var(--hue-grass)',
]
function entryGlyph(entry: SkillCredentialEntry) {
  return PROVIDER_GLYPHS[entry.provider]
}
function entryHue(entry: SkillCredentialEntry) {
  let hash = 0
  for (const ch of entry.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return HUE_PALETTE[hash % HUE_PALETTE.length]
}

// Category split: internal Keep/Lark-side systems vs. everything else (currently
// just GitLab). Keyed on `provider`, matching the existing GitLab check below —
// an unrecognized future provider falls through to "其他凭证" rather than vanishing.
const INTERNAL_SYSTEM_PROVIDERS = new Set(['lark', 'feishu-project', 'keep'])
function isInternalSystem(entry: SkillCredentialEntry) {
  return INTERNAL_SYSTEM_PROVIDERS.has(entry.provider)
}

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
        setCredentialNotice(id, session.error || 'Lark-cli 授权未完成，请重试', 'error')
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
      setCredentialNotice(id, err?.message || 'Lark-cli 授权状态检查失败，请重试', 'error')
    }
    // The manual refresh button remains available if a background poll fails.
  } finally {
    // Only clear the indicator if THIS poll is still the current attempt — a superseded
    // poll must not hide a newer poll's loading state.
    if (oauthPollingId.value === id && token === attemptSeq) oauthPollingId.value = ''
  }
}

const gitlabDialog = ref<{ id: string; title: string } | null>(null)
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
/** Failure inside the QR dialog, where the code being retried still is. */
const qrError = ref('')

/**
 * Per-credential notice, shown on that credential's own card.
 *
 * Keyed by id because several cards can be mid-flow at once, and a single shared
 * string would pin one card's device code or failure onto another.
 *
 * ⚠️ The device code case is the reason this must be RESIDENT. `user_code` is a
 * string the user has to read and type into another device; putting it in a
 * toast that dismisses itself after a couple of seconds means they have to
 * restart the whole flow to see it again.
 */
const credentialNotice = ref<Record<string, { text: string; tone: 'error' | 'info' | 'code' }>>({})

function setCredentialNotice(id: string, text: string, tone: 'error' | 'info' | 'code') {
  credentialNotice.value = { ...credentialNotice.value, [id]: { text, tone } }
}

function clearCredentialNotice(id: string) {
  const next = { ...credentialNotice.value }
  delete next[id]
  credentialNotice.value = next
}

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
  void startCredential(entry)
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
  gitlabDialog.value = { id: entry.id, title: entry.title }
}

function openRequestedCredential() {
  if (requestedCredentialId.value !== 'gitlab-personal') return
  const entry = credentials.value.find(item => item.id === requestedCredentialId.value && isGitlabTokenEntry(item))
  if (entry) openGitlabDialog(entry)
}

async function confirmGitlabToken() {
  gitlabSubmitting.value = true
  gitlabError.value = ''
  // Captured up front: the dialog is closed before the note is set, and the
  // note has to land on the card it belongs to.
  const noteTargetId = gitlabDialog.value?.id || 'gitlab-personal'
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
    // The server's own note about the bind (e.g. which identity it matched).
    if (res.note) setCredentialNotice(noteTargetId, res.note, 'info')
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
      // A device code has to stay on screen — it is something to read and type
      // somewhere else. "Flow started" needs no notice: the card is already
      // showing its polling state.
      if (result.user_code) setCredentialNotice(entry.id, result.user_code, 'code')
      return
    }
    // 走到这里，响应里没有二维码、没有授权链接、也没有设备码 —— 什么都没启动。
    // 以前这里照样弹绿色「认证流程已启动」，员工点一次绿一次、卡片纹丝不动
    // (ligaofeng 2026-08-06 的 GitLab 绑定)。没启动就别报成功：刷新面板，如实说。
    if (result.user_code) {
      setCredentialNotice(entry.id, result.user_code, 'code')
    } else {
      setCredentialNotice(entry.id, t('skillCredentials.noInteractiveFlow', { name: entry.title }), 'info')
    }
    await loadCredentials()
  } catch (err: any) {
    setCredentialNotice(entry.id, err?.message || `${entry.title} 认证启动失败`, 'error')
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
  qrError.value = ''
  try {
    const result = await completeSkillCredentialAuth(current.id, current.qrcodeId, requestedProfile.value)
    // The QR dialog closes and the card repaints as authenticated, with the
    // matched account in its own foot — so the success needs no line of its own.
    // The matched identity is worth keeping visible though, since it is how the
    // user checks they bound the account they meant to.
    if (result.account_hint) setCredentialNotice(current.id, result.account_hint, 'info')
    qrDialog.value = null
    await loadCredentials({ fresh: true })
  } catch (err: any) {
    // Stays in the QR dialog: the code is still on screen to try again with.
    qrError.value = err?.message || '还没有检测到扫码完成，请确认后再试'
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
    <div class="credentials-scroll">
      <div class="credentials-inner">
        <!-- Prototype market head: title block left, search pill right (no other actions).
             NOT `.page-header` — global.scss owns that name and leaks a 21px/20px padding
             plus a full-width border-bottom into it; the prototype head has neither. -->
        <header class="market-head">
          <div class="header-titles">
            <h1 class="t-h1">{{ t('market.title') }}</h1>
          </div>
          <label class="header-search">
            <KpIcon name="line_search" :size="14" />
            <input
              v-model="searchQuery"
              class="header-search__input"
              type="text"
              :placeholder="t('connectors.searchPlaceholder')"
            />
          </label>
        </header>

        <MarketTabs active="connectors" />
        <!-- The section's own line, below the strip: the h1 names the market,
             this names the section you are looking at. -->
        <p class="t-sub-multi market-sub">{{ t('connectors.subtitle') }}</p>

        <NSpin :show="loading && !data">
          <div v-if="error" class="credentials-error">{{ error }}</div>
          <template v-else>
            <div v-if="data && visibleCredentials.length === 0" class="credentials-empty t-sub">
              {{ t('connectors.noMatch') }}
            </div>
            <template v-else>
              <!-- Prototype CatalogGroup: one section per category, ItemCard grid. -->
              <section
                v-for="group in credentialGroups"
                :key="group.key"
                class="catalog-group"
                :data-credential-group="group.key"
              >
                <div class="catalog-group__head">
                  <span class="catalog-group__title">{{ t(group.titleKey) }}</span>
                </div>
                <div class="credentials-grid">
                  <article
                    v-for="entry in group.entries"
                    :key="entry.id"
                    class="credential-card"
                    :class="statusClass(entry.status)"
                  >
                    <div class="credential-card__head">
                      <KpAppIcon
                        :icon="entryGlyph(entry)"
                        :mark="entry.title.slice(0, 1)"
                        :color="entryHue(entry)"
                        :size="40"
                      />
                      <span class="credential-card__name" :title="entry.title">{{ entry.title }}</span>
                      <!-- 没有 action 的条目是纯陈述卡（如「GitLab（全局）」：管理员运维，员工点了
                           也改不了），给按钮等于骗人。判据是 action 本身在不在 —— 不再看 label 是否
                           为空：那个暗号分不清「没有操作」和「有操作但忘了填标签」，后者会静默变成
                           一张点不动的卡。broker 侧对无操作送 null，适配层 coerceAction 如实返回
                           undefined。 -->
                      <!-- 原型 CornerBtn：30px 发丝圆钮，图标承担动作，文案走 title/aria-label。
                           兜底只管文案，不当渲染开关：有 action 却缺 label 是数据问题，宁可提示
                           「连接」也别渲染一颗无名按钮。 -->
                      <KpCornerBtn
                        v-if="entry.action"
                        type="button"
                        class="credential-card__corner"
                        :class="{ 'is-loading': startingId === entry.id }"
                        :icon="entry.action.kind === 'retry' ? 'line_reload' : 'line_add'"
                        :data-loading="startingId === entry.id ? 'true' : undefined"
                        :disabled="entry.status === 'missing'"
                        :data-credential-action="entry.id"
                        :title="entry.action.label || '连接'"
                        @click="onCredentialAction(entry)"
                      />
                    </div>
                    <p class="credential-card__desc">{{ entry.detail || entry.provider }}</p>
                    <code v-if="entry.action?.command" class="credential-command">{{ entry.action.command }}</code>
                    <!-- Resident, per card. A device code especially must not
                         expire on a timer: it is meant to be read and typed
                         somewhere else. -->
                    <div
                      v-if="credentialNotice[entry.id]"
                      class="credential-notice"
                      :class="`is-${credentialNotice[entry.id].tone}`"
                      data-testid="credential-notice"
                    >
                      <span class="credential-notice__text">{{ credentialNotice[entry.id].text }}</span>
                      <button
                        type="button"
                        class="credential-notice__close"
                        :title="t('common.close')"
                        @click.stop="clearCredentialNotice(entry.id)"
                      >&times;</button>
                    </div>
                    <div class="credential-card__foot">
                      <span class="credential-status">{{ statusLabel(entry.status) }}</span>
                      <template v-if="entry.account_hint || entry.default_identity">
                        <span class="credential-card__sep" />
                        <span class="credential-card__meta">{{ entry.account_hint || entry.default_identity }}</span>
                      </template>
                    </div>
                  </article>
                </div>
              </section>
            </template>
          </template>
        </NSpin>
      </div>
    </div>

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
      :show="!!qrDialog"
      preset="card"
      class="qr-modal"
      :title="qrDialog ? `${qrDialog.title} 扫码登录` : ''"
      @update:show="value => { if (!value) closeQrDialog() }"
    >
      <div v-if="qrDialog" class="qr-auth">
        <p v-if="qrError" class="credential-notice is-error" data-testid="qr-error">{{ qrError }}</p>
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
.credential-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: var(--r-ctl);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.credential-notice.is-error {
  background: var(--danger-bg);
  color: var(--danger);
}

.credential-notice.is-info {
  background: var(--surface-2);
  color: var(--fg-primary);
  box-shadow: inset 0 0 0 0.5px var(--divider);
}

/* A device code is data to be transcribed, so it gets the mono face and enough
   letter-spacing to tell 0 from O. */
.credential-notice.is-code {
  background: var(--surface-2);
  color: var(--fg-title);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  font-family: var(--font-mono);
  font-size: var(--t-14);
  letter-spacing: 0.08em;
  user-select: all;
}

.credential-notice__text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.credential-notice__close {
  flex: 0 0 auto;
  border: 0;
  background: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}


.credentials-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;

  &.is-embedded {
    height: 100%;
    min-height: 0;
  }
}

// KpPage frame: centered 1040 column, 48/40/64. The scroll wrapper reserves a
// stable gutter so the centered column doesn't shift when the scrollbar shows.
// (Also what keeps the bottom rows reachable in the embedded expert panel —
// the parent there is overflow:hidden.)
.credentials-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.credentials-inner {
  max-width: 1040px;
  margin: 0 auto;
  padding: 48px 40px 64px;
}

// Prototype market head: title block + search pill on one row, 28 below.
.market-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.header-titles {
  min-width: 0;
}

// Section line under the tab strip: same measure as KpPage's own sub.
.market-sub {
  margin-bottom: 24px;
  max-width: 560px;
}

// Keep search pill, same as the other market sections' heads.
// surface-2, not gray-f7: same value in light, but the surface token follows dark mode.
.header-search {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 220px;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  background: var(--surface-2);
  color: var(--fg-aux);
  flex: 0 0 auto;
}

.header-search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);

  &::placeholder {
    color: var(--fg-aux);
  }
}

// Prototype empty state: centered quiet line.
.credentials-empty {
  padding: 48px 0;
  text-align: center;
}

// Prototype CatalogGroup: 16/1 semibold title on a 1px rule, grid 16 below.
.catalog-group {
  margin-bottom: 28px;
}

.catalog-group__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 12px;
  margin-bottom: 4px;
  border-bottom: 0.5px solid var(--divider);
}

.catalog-group__title {
  color: var(--fg-title);
  font: var(--w-semibold) var(--t-16) / var(--lh-1) var(--font-cn);
}

.credentials-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
  gap: 20px;
  margin-top: 16px;
}

// Prototype ItemCard: flat column, 20 padding, 1px inset ring, no drop shadow.
.credential-card {
  display: flex;
  flex-direction: column;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  transition: background var(--motion-base) var(--ease-std);

  // Prototype .catrow:hover — surface-1, theme-aware.
  &:hover {
    background: var(--surface-1);
  }
}

.credential-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.credential-card__name {
  flex: 1;
  min-width: 0;
  color: var(--fg-title);
  font: var(--w-medium) var(--t-16) / 1.6 var(--font-cn);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Prototype CornerBtn: 30px hairline circle, 14px glyph, no fill.
// Feedback is the prototype's `button.ab` press language — active dims to .6 —
// with no hover fill (the mock's corner button has none).
.credential-card__corner {
  transition: opacity var(--motion-base) var(--ease-std);

  &:active:not(:disabled) {
    opacity: 0.6;
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  // `:deep` because the glyph now lives inside KpCornerBtn — a plain `i`
  // selector carries this component's scope attribute and would not match it.
  &.is-loading :deep(i) {
    display: none;
  }

  &.is-loading::after {
    content: '';
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1.5px solid var(--divider);
    border-top-color: var(--fg-secondary);
    animation: credential-spin 0.8s linear infinite;
  }
}

@keyframes credential-spin {
  to {
    transform: rotate(360deg);
  }
}

.credential-card__desc {
  flex: 1;
  margin: 0 0 16px;
  color: var(--fg-secondary);
  font: var(--w-regular) var(--t-13) / 1.6 var(--font-cn);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

// Card foot: AgentBadge-style status pill + hairline divider + account meta.
// Prototype ItemCard foot wraps with an 8px row gap — a long account hint
// next to the status pill overflows a 307px card otherwise.
.credential-card__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  row-gap: 8px;
  min-width: 0;
}

// Prototype AgentBadge: 22px pill, 0 8px, 12/22 medium, surface-3 on gray tone.
.credential-status {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
  color: var(--fg-secondary);
  font: var(--w-medium) var(--t-12) / 22px var(--font-cn);
  white-space: nowrap;
}

.status-authenticated .credential-status,
.status-configured .credential-status {
  color: var(--action-press);
  background: var(--keep-green-bg);
}

.status-needs-auth .credential-status,
.status-unknown .credential-status,
.status-error .credential-status {
  color: var(--warning);
  background: var(--warning-bg);
}

.credential-card__sep {
  width: 1px;
  height: 14px;
  background: var(--divider);
  flex: 0 0 auto;
}

.credential-card__meta {
  min-width: 0;
  color: var(--fg-aux);
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gitlab-open-link {
  margin-left: 6px;
  color: var(--keep-green);
  text-decoration: none;
  white-space: nowrap;
}

.gitlab-open-link:hover {
  text-decoration: underline;
}

.gitlab-scope {
  margin-right: 4px;
  padding: 0 5px;
  border-radius: var(--r-card-l);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  font: var(--w-regular) var(--t-12) / 1.6 var(--font-mono);
}

.gitlab-tier-field {
  width: 100%;
}

.gitlab-scope-hint {
  margin: 6px 0 0;
  font: var(--w-regular) var(--t-12) / 1.5 var(--font-cn);
  color: var(--fg-secondary);
}

.credential-command {
  display: inline-block;
  max-width: 100%;
  margin-top: 8px;
  padding: 5px 8px;
  border-radius: var(--r-card-l);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-title);
  background: var(--surface-1);
  font: var(--w-regular) var(--t-12) / 1.5 var(--font-mono);
}

.credentials-error {
  margin: 20px;
  padding: 12px 14px;
  border-radius: var(--r-ctl);
  box-shadow: inset 0 0 0 0.5px var(--danger);
  color: var(--danger);
  background: var(--danger-bg);
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
  border-radius: var(--r-ctl);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  background: var(--white);
}

.qr-copy {
  margin: 0;
  color: var(--fg-secondary);
  font: var(--w-regular) var(--t-14) / 1.5 var(--font-cn);
}

.qr-link {
  color: var(--keep-green);
  font-size: var(--t-13);
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
