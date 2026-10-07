interface CompletionNotificationPayload {
  title: string
  body?: string
  icon?: string
  tag?: string
}

/**
 * A notification that carries a place to go back to. `clickUrl` is an in-app
 * hash route (`/hermes/...`); clicking the notification focuses the window and
 * navigates there.
 */
export interface SystemNotificationPayload extends CompletionNotificationPayload {
  clickUrl?: string
}

interface HermesDesktopBridge {
  isDesktop?: boolean
  notifyCompletion?: (payload: CompletionNotificationPayload & { clickUrl?: string }) => Promise<boolean>
}

export interface CompletionNotificationPermissionResult {
  granted: boolean
  reason?: 'unsupported' | 'insecure' | 'denied'
}

type WindowWithHermesDesktop = Window & typeof globalThis & {
  hermesDesktop?: HermesDesktopBridge
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), timeoutMs)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      () => {
        window.clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

function desktopBridge(): HermesDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as WindowWithHermesDesktop).hermesDesktop
}

function supportsBrowserNotification(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

function isBrowserNotificationSecureContext(): boolean {
  if (typeof window === 'undefined') return false
  return window.isSecureContext
}

/**
 * Only in-app hash routes are allowed through to the click handler and to the
 * service worker — a notification must never be able to navigate the window to
 * an attacker-chosen origin or escape the app with `..`.
 */
export function safeHermesClickUrl(value?: string): string | undefined {
  if (!value || !value.startsWith('/hermes/') || value.includes('..') || value.includes('\\')) return undefined
  return value
}

function browserNotificationOptions(payload: SystemNotificationPayload): NotificationOptions {
  const clickUrl = safeHermesClickUrl(payload.clickUrl)
  return {
    body: payload.body,
    icon: payload.icon ? new URL(payload.icon, window.location.origin).href : undefined,
    tag: payload.tag,
    data: clickUrl ? { clickUrl } : undefined,
  }
}

/**
 * The page is in front of the user right now. Background-only notifications
 * (pending approvals) stay silent in this case — the card is already on screen.
 */
export function isDocumentVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible'
}

async function showServiceWorkerNotification(
  payload: SystemNotificationPayload,
  requireBackground: boolean,
): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker || typeof navigator.serviceWorker.register !== 'function') return false

  try {
    const registration = await withTimeout(
      navigator.serviceWorker.register('/notification-sw.js'),
      3000,
      null,
    )
    if (!registration) return false
    await withTimeout(navigator.serviceWorker.ready, 3000, registration)
    // Registration plus `ready` can burn up to six seconds on a first visit.
    // The visibility check that gated this call happened before all of that, so
    // re-check here: a user who came back to the tab in the meantime is looking
    // straight at the card and must not be interrupted.
    if (requireBackground && isDocumentVisible()) return false
    await registration.showNotification(payload.title, browserNotificationOptions(payload))
    return true
  } catch (err) {
    console.warn('Failed to show service worker notification:', err)
    return false
  }
}

export function isDesktopNotificationRuntime(): boolean {
  return desktopBridge()?.isDesktop === true
}

export async function requestCompletionNotificationPermission(): Promise<CompletionNotificationPermissionResult> {
  if (isDesktopNotificationRuntime()) return { granted: true }
  if (!supportsBrowserNotification()) return { granted: false, reason: 'unsupported' }
  if (!isBrowserNotificationSecureContext()) return { granted: false, reason: 'insecure' }
  if (Notification.permission === 'granted') return { granted: true }
  if (Notification.permission === 'denied') return { granted: false, reason: 'denied' }

  try {
    const permission = await withTimeout(
      Notification.requestPermission(),
      5000,
      'default' as NotificationPermission,
    )
    return permission === 'granted'
      ? { granted: true }
      : { granted: false, reason: permission === 'denied' ? 'denied' : 'unsupported' }
  } catch {
    return { granted: false, reason: 'unsupported' }
  }
}

/**
 * Show a system notification.
 *
 * `requireBackground` (default `false`) makes the call a no-op while the page
 * is visible. Callers that notify about something the user can already see on
 * screen (pending approvals) pass `true`; completion notifications keep the
 * historical always-show behaviour.
 */
export async function showSystemNotification(
  payload: SystemNotificationPayload,
  options: { requireBackground?: boolean } = {},
): Promise<boolean> {
  const requireBackground = options.requireBackground === true
  if (requireBackground && isDocumentVisible()) return false

  const bridge = desktopBridge()
  if (bridge?.isDesktop && bridge.notifyCompletion) {
    try {
      return await bridge.notifyCompletion({ ...payload, clickUrl: safeHermesClickUrl(payload.clickUrl) })
    } catch (err) {
      console.warn('Failed to show desktop system notification:', err)
      return false
    }
  }

  if (!supportsBrowserNotification() || !isBrowserNotificationSecureContext() || Notification.permission !== 'granted') {
    return false
  }

  try {
    if (await showServiceWorkerNotification(payload, requireBackground)) return true

    // The service-worker attempt above is awaited, so re-check before falling
    // back to the constructor for the same reason.
    if (requireBackground && isDocumentVisible()) return false

    const notification = new Notification(payload.title, browserNotificationOptions(payload))
    notification.onclick = () => {
      window.focus()
      const clickUrl = safeHermesClickUrl(payload.clickUrl)
      if (clickUrl) window.location.hash = `#${clickUrl}`
      notification.close()
    }
    return true
  } catch (err) {
    console.warn('Failed to show browser system notification:', err)
    return false
  }
}

export async function showCompletionNotification(payload: CompletionNotificationPayload): Promise<boolean> {
  return showSystemNotification(payload)
}
