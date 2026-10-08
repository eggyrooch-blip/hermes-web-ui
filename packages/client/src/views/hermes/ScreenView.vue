<script setup lang="ts">
/**
 * Bot Screen (云电脑) — live view of the bot's desktop with 接管 / 交还给 bot.
 *
 * The broker owns the lease; this page paints a cache of it. `you_hold` is
 * computed server-side from the minted viewer id, and `viewOnly` here is UX
 * only — the broker's RFB filter drops input from anyone but the holder.
 *
 * Close codes from the bridge: 4000 another viewer took control → back to
 * watching on a fresh observe; 4001 desktop stopped; 4401 viewer id expired →
 * observe again; 4403 not allowed. Repeated rapid evictions end in the error
 * state instead of a reconnect loop.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { NButton } from 'naive-ui'
import {
  acquireDesktopLease,
  buildDesktopScreenWebSocketUrl,
  ensureDesktop,
  observeDesktop,
  releaseDesktopLease,
} from '@/api/hermes/desktop'

type RfbClient = {
  viewOnly: boolean
  scaleViewport: boolean
  resizeSession: boolean
  focusOnClick: boolean
  background: string
  qualityLevel: number
  addEventListener: (type: string, handler: (event: { detail?: { clean?: boolean; reason?: string } }) => void) => void
  disconnect: () => void
  focus: () => void
}
type RfbConstructor = new (target: HTMLElement, socket: WebSocket, options?: Record<string, unknown>) => RfbClient
type Phase = 'loading' | 'disabled' | 'stopped' | 'connecting' | 'live' | 'error'

const CLOSE_CONTROL_TAKEN = 4000
const CLOSE_DESKTOP_STOPPED = 4001
const CLOSE_VIEWER_INVALID = 4401
const CLOSE_FORBIDDEN = 4403
const RAPID_RECONNECT_WINDOW_MS = 10_000
const MAX_RAPID_RECONNECTS = 3

const phase = ref<Phase>('loading')
const youHold = ref(false)
const busy = ref(false)
const notice = ref('')
const errorText = ref('')
const stoppedTitle = ref('桌面未启动')
const canvasHost = ref<HTMLDivElement | null>(null)

const rfb = shallowRef<RfbClient | null>(null)
let socket: WebSocket | null = null
let viewerId: string | null = null
let generation = 0
let dialedAt = 0
let rapidReconnects = 0
let unmounted = false

async function loadRfb(): Promise<RfbConstructor> {
  const mod = await import('@novnc/novnc') as unknown as { default: RfbConstructor }
  return mod.default
}

/** Error codes from the WebUI server and the broker contract, in the page's language. */
const ERROR_TEXT: Record<string, string> = {
  too_many_viewers: '同时观看这个桌面的窗口太多（最多 4 个），请关掉其他窗口后重新连接',
  desktop_forbidden: '没有权限查看这个桌面',
  forbidden: '没有权限查看这个桌面',
  viewer_forbidden: '这个观看会话不属于你，请重新连接',
  viewer_expired: '观看会话已过期，请重新连接',
  viewer_id_required: '观看会话已失效，请重新连接',
  desktop_disabled: '这个 bot 没有开启云电脑',
  desktop_not_running: '桌面已关闭',
  desktop_unavailable: '云电脑服务暂不可用，请稍后再试',
  desktop_broker_unreachable: '连不上云电脑服务，请稍后再试',
  desktop_broker_error: '云电脑服务出错，请稍后再试',
  desktop_broker_bad_response: '云电脑服务返回异常，请稍后再试',
  invalid_force: '请求参数有误，请刷新页面后重试',
}
const HAN = /[\u4e00-\u9fff]/

function errorStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

/**
 * Known codes map to fixed text; otherwise a Chinese message from the broker
 * (ensure failures carry one) is shown as is, and anything else gets a
 * generic line instead of a raw English code or network error.
 */
function errorMessage(err: unknown): string {
  if (errorStatus(err) === 429) return ERROR_TEXT.too_many_viewers
  const known = ERROR_TEXT[errorCode(err) ?? '']
  const text = (err instanceof Error ? err.message : String(err)).replace(/^API Error \d+:\s*/, '')
  if (HAN.test(text)) return text
  return known || '云电脑服务出错，请稍后再试'
}

function detach(handBack: boolean) {
  generation += 1
  const ws = socket
  const client = rfb.value
  socket = null
  rfb.value = null
  // noVNC closes its socket without a status; a deliberate exit sends 1000
  // first so the broker releases a held lease. A reconnect keeps it.
  if (handBack && ws && ws.readyState <= WebSocket.OPEN) ws.close(1000)
  client?.disconnect()
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
}

async function connect() {
  if (!viewerId || !canvasHost.value) return
  detach(false)
  const attempt = generation
  phase.value = 'connecting'
  errorText.value = ''

  let Rfb: RfbConstructor
  try {
    // Load before dialing: noVNC installs its own onopen and would miss an
    // open that fired while the import was in flight.
    Rfb = await loadRfb()
  } catch {
    phase.value = 'error'
    errorText.value = '桌面查看器加载失败，请刷新页面后重试'
    return
  }
  if (attempt !== generation || unmounted || !canvasHost.value) return

  dialedAt = Date.now()
  const ws = new WebSocket(buildDesktopScreenWebSocketUrl(viewerId))
  ws.binaryType = 'arraybuffer'
  socket = ws
  // noVNC's disconnect detail carries only {clean}; the bridge's verdict is the
  // raw close code, captured before RFB installs its own handler.
  let closeCode = 0
  ws.addEventListener('close', (event) => {
    closeCode = event.code
  })

  const client = new Rfb(canvasHost.value, ws, { shared: true })
  client.scaleViewport = true
  client.resizeSession = false
  client.focusOnClick = true
  client.background = '#000'
  client.qualityLevel = 7
  client.viewOnly = !youHold.value
  client.addEventListener('connect', () => {
    if (attempt !== generation) return
    phase.value = 'live'
    if (youHold.value) client.focus()
  })
  client.addEventListener('disconnect', (event) => {
    if (rfb.value === client) rfb.value = null
    if (attempt !== generation) return
    void handleStreamClosed(closeCode, event.detail?.clean === true)
  })
  rfb.value = client
}

async function observeAndConnect() {
  const result = await observeDesktop()
  youHold.value = result.you_hold
  viewerId = result.viewer_id
  if (!result.enabled) {
    phase.value = 'disabled'
    return
  }
  if (!result.running || !viewerId) {
    stoppedTitle.value = '桌面未启动'
    phase.value = 'stopped'
    return
  }
  await connect()
}

function withinReconnectBudget(): boolean {
  rapidReconnects = Date.now() - dialedAt < RAPID_RECONNECT_WINDOW_MS ? rapidReconnects + 1 : 1
  return rapidReconnects <= MAX_RAPID_RECONNECTS
}

async function handleStreamClosed(code: number, clean: boolean) {
  if (unmounted) return
  if (code === CLOSE_DESKTOP_STOPPED) {
    youHold.value = false
    stoppedTitle.value = '桌面已关闭'
    phase.value = 'stopped'
    return
  }
  if (code === CLOSE_FORBIDDEN) {
    phase.value = 'error'
    errorText.value = '没有权限查看这个桌面'
    return
  }
  if (code === CLOSE_CONTROL_TAKEN || code === CLOSE_VIEWER_INVALID) {
    youHold.value = false
    if (!withinReconnectBudget()) {
      phase.value = 'error'
      errorText.value = '连接反复被中断，请稍后重新连接'
      return
    }
    if (code === CLOSE_CONTROL_TAKEN) notice.value = '控制权已在别处被接管，已回到观看'
    try {
      await observeAndConnect()
    } catch (err) {
      phase.value = 'error'
      errorText.value = errorMessage(err)
    }
    return
  }
  phase.value = 'error'
  errorText.value = clean ? '连接已关闭' : '与桌面的连接已断开'
}

/**
 * A viewer id that still exists keeps a human lease across a dropped stream,
 * so a manual reconnect re-dials with it first; an expired one answers 4401
 * and falls through to a fresh observe.
 */
async function reconnect() {
  rapidReconnects = 0
  notice.value = ''
  phase.value = 'loading'
  try {
    if (viewerId) await connect()
    else await observeAndConnect()
  } catch (err) {
    phase.value = 'error'
    errorText.value = errorMessage(err)
  }
}

async function startDesktop() {
  busy.value = true
  errorText.value = ''
  try {
    const result = await ensureDesktop(viewerId)
    youHold.value = result.you_hold
    viewerId = result.viewer_id
    if (!result.enabled) {
      phase.value = 'disabled'
    } else if (result.running && viewerId) {
      await connect()
    } else {
      errorText.value = '桌面没有启动成功，请稍后再试'
    }
  } catch (err) {
    errorText.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

function applyControl(hold: boolean) {
  youHold.value = hold
  const client = rfb.value
  if (!client) return
  client.viewOnly = !hold
  if (hold) client.focus()
}

/**
 * 503 on a lease call = the desktop is gone (same as WS 4001). 403 = this
 * viewer id expired or is not ours: start over on a fresh one.
 */
async function recoverFromLeaseError(err: unknown) {
  if (errorStatus(err) === 503) {
    detach(false)
    youHold.value = false
    notice.value = ''
    stoppedTitle.value = '桌面已关闭'
    phase.value = 'stopped'
    return
  }
  notice.value = errorMessage(err)
  if (errorStatus(err) !== 403) return
  viewerId = null
  youHold.value = false
  await reconnect()
  if (phase.value === 'connecting' || phase.value === 'live') notice.value = '观看会话已过期，已重新连接'
}

async function takeOver() {
  if (!viewerId) return
  busy.value = true
  notice.value = ''
  try {
    const result = await acquireDesktopLease(viewerId)
    applyControl(result.you_hold)
  } catch (err) {
    await recoverFromLeaseError(err)
  } finally {
    busy.value = false
  }
}

async function handBack() {
  if (!viewerId) return
  busy.value = true
  try {
    const result = await releaseDesktopLease(viewerId)
    applyControl(result.you_hold)
  } catch (err) {
    await recoverFromLeaseError(err)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void reconnect()
})

onBeforeUnmount(() => {
  unmounted = true
  const holding = youHold.value && viewerId
  detach(true)
  if (holding && viewerId) void releaseDesktopLease(viewerId).catch(() => undefined)
})
</script>

<template>
  <div class="screen-view">
    <header class="screen-header">
      <div class="header-left">
        <span class="screen-title">Bot 的电脑</span>
        <span
          v-if="phase === 'live' || phase === 'connecting'"
          class="control-badge"
          :class="{ holding: youHold }"
          data-testid="screen-status"
        >{{ youHold ? '你正在操作' : '观看中' }}</span>
      </div>
      <div class="header-actions">
        <template v-if="phase === 'live' || phase === 'connecting'">
          <NButton
            v-if="youHold"
            size="small"
            secondary
            :loading="busy"
            data-testid="screen-hand-back"
            @click="handBack"
          >交还给 bot</NButton>
          <NButton
            v-else
            size="small"
            type="primary"
            :loading="busy"
            :disabled="phase !== 'live'"
            data-testid="screen-take-over"
            @click="takeOver"
          >接管</NButton>
        </template>
        <NButton
          v-if="phase === 'error' || phase === 'live'"
          size="small"
          quaternary
          data-testid="screen-reconnect"
          @click="reconnect"
        >重新连接</NButton>
      </div>
    </header>

    <div v-if="notice" class="screen-notice" data-testid="screen-notice">{{ notice }}</div>

    <div class="screen-stage" :class="{ holding: youHold && phase === 'live' }">
      <div ref="canvasHost" class="screen-canvas" data-testid="screen-canvas" />

      <div v-if="phase === 'loading' || phase === 'connecting'" class="screen-overlay">正在连接桌面…</div>
      <div v-else-if="phase === 'disabled'" class="screen-overlay">这个 bot 没有开通云电脑</div>
      <div v-else-if="phase === 'stopped'" class="screen-overlay" data-testid="screen-stopped">
        <div class="overlay-title">{{ stoppedTitle }}</div>
        <NButton type="primary" :loading="busy" data-testid="screen-start" @click="startDesktop">启动桌面</NButton>
        <div v-if="errorText" class="overlay-error">{{ errorText }}</div>
      </div>
      <div v-else-if="phase === 'error'" class="screen-error" data-testid="screen-error">{{ errorText }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.screen-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.screen-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.screen-title {
  font-weight: 600;
  color: $text-primary;
}

.control-badge {
  padding: 2px 8px;
  border-radius: $radius-sm;
  font-size: 12px;
  background: $bg-secondary;
  color: $text-secondary;

  &.holding {
    background: rgba(220, 38, 38, 0.12);
    color: $error;
    font-weight: 600;
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.screen-notice {
  padding: 6px 20px;
  font-size: 12px;
  background: rgba(245, 158, 11, 0.12);
  color: $warning;
}

.screen-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #000;

  &.holding {
    box-shadow: inset 0 0 0 2px rgba(220, 38, 38, 0.7);
  }
}

.screen-canvas {
  position: absolute;
  inset: 0;
}

.screen-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: rgba(255, 255, 255, 0.75);
  background: #000;
  font-size: 14px;
}

.overlay-title {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
}

.overlay-error {
  font-size: 12px;
  color: #fca5a5;
}

.screen-error {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 6px 20px;
  font-size: 12px;
  color: #fecaca;
  background: rgba(127, 29, 29, 0.85);
}

@media (max-width: $breakpoint-mobile) {
  .screen-header {
    padding: 12px 12px 12px 52px;
  }
}
</style>
