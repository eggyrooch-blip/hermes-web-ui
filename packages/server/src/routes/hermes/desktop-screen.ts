import Router from '@koa/router'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import * as ctrl from '../../controllers/hermes/desktop-screen'
import { config } from '../../config'
import { logger } from '../../services/logger'
import { shouldRejectUpgradeOrigin, writeForbiddenOrigin } from '../../security'
import { resolveFeishuHandshakeUser } from '../../services/hermes/handshake-identity'
import {
  authorizeDesktopTarget,
  brokerDesktopWsUrl,
  buildDesktopBrokerHeaders,
  normalizeViewerId,
} from '../../services/hermes/desktop-screen'

export const DESKTOP_SCREEN_WS_PATH = '/api/hermes/desktop/ws'

/** Pause reading a side once the peer's unsent backlog passes this. */
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024
const BROKER_HANDSHAKE_TIMEOUT_MS = 10_000

export const desktopScreenRoutes = new Router()

desktopScreenRoutes.post('/api/hermes/desktop/observe', ctrl.observe)
desktopScreenRoutes.post('/api/hermes/desktop/ensure', ctrl.ensure)
desktopScreenRoutes.post('/api/hermes/desktop/lease/acquire', ctrl.acquireLease)
desktopScreenRoutes.post('/api/hermes/desktop/lease/release', ctrl.releaseLease)

function rejectUpgrade(socket: Duplex, status: number, text: string) {
  if (socket.destroyed) return
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

/** Codes a WebSocket may put on the wire (1005/1006/1015 are local-only). */
function isSendableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
}

/**
 * Mirror a close onto the other leg. A clean close keeps its code (1000/1001
 * release the lease broker-side; 4000/4001/4401/4403 drive the page); an
 * abnormal one (1006) is mirrored as a hard drop so the broker keeps the
 * human's lease across a network blip, as the core bridge does.
 */
function closePeer(peer: WebSocket, code: number, reason: Buffer) {
  if (peer.readyState === WebSocket.CLOSING || peer.readyState === WebSocket.CLOSED) return
  if (peer.readyState === WebSocket.CONNECTING || !isSendableCloseCode(code)) {
    peer.terminate()
    return
  }
  peer.close(code, reason)
}

function forward(from: WebSocket, to: WebSocket) {
  return (data: RawData, isBinary: boolean) => {
    if (to.readyState !== WebSocket.OPEN) return
    to.send(data, { binary: isBinary }, () => {
      if (from.isPaused && to.bufferedAmount <= BACKPRESSURE_HIGH_WATER) from.resume()
    })
    if (to.bufferedAmount > BACKPRESSURE_HIGH_WATER) from.pause()
  }
}

function bridge(client: WebSocket, upstream: WebSocket, early: Array<[RawData, boolean]>) {
  upstream.removeAllListeners('message')
  for (const [data, isBinary] of early) client.send(data, { binary: isBinary })
  early.length = 0

  upstream.on('message', forward(upstream, client))
  client.on('message', forward(client, upstream))
  upstream.on('close', (code, reason) => closePeer(client, code, reason))
  client.on('close', (code, reason) => closePeer(upstream, code, reason))
  upstream.on('error', (err) => {
    logger.warn({ err: err.message }, '[desktop-screen] broker stream error')
    client.terminate()
  })
  client.on('error', () => upstream.terminate())
}

async function handleDesktopUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer) {
  // Node drops its own socket error listener before emitting 'upgrade', and
  // ws only adds one inside handleUpgrade. The broker handshake keeps the raw
  // socket waiting for seconds, so a browser reset in that window must not
  // become an uncaught 'error' that takes the process down.
  const onSocketError = () => socket.destroy()
  socket.on('error', onSocketError)

  // Same Origin rule as kanban-events: a foreign Origin is refused, a missing
  // one (the vite dev proxy strips it) is allowed.
  if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
    writeForbiddenOrigin(socket)
    return
  }

  const user = resolveFeishuHandshakeUser(req.headers)
  if (!user || (config.requiredProfile && user.profile !== config.requiredProfile)) {
    rejectUpgrade(socket, 401, 'Unauthorized')
    return
  }

  const url = new URL(req.url || '', 'http://localhost')
  const target = await authorizeDesktopTarget(
    user,
    url.searchParams.get('profile') || '',
    url.searchParams.get('agent_id') || '',
  )
  if (!target) {
    rejectUpgrade(socket, 403, 'Forbidden')
    return
  }

  const viewerId = normalizeViewerId(url.searchParams.get('viewer_id'))
  if (!viewerId) {
    rejectUpgrade(socket, 400, 'Bad Request')
    return
  }
  const upstreamUrl = brokerDesktopWsUrl(viewerId)
  if (!upstreamUrl) {
    rejectUpgrade(socket, 503, 'Service Unavailable')
    return
  }

  const upstream = new WebSocket(upstreamUrl, {
    headers: buildDesktopBrokerHeaders(target),
    handshakeTimeout: BROKER_HANDSHAKE_TIMEOUT_MS,
    perMessageDeflate: false,
  })
  // The broker speaks first (RFB ProtocolVersion) and may do so before the
  // browser leg finishes upgrading; hold those frames for the bridge.
  const early: Array<[RawData, boolean]> = []
  upstream.on('message', (data, isBinary) => early.push([data, isBinary]))

  const abandonUpstream = () => upstream.terminate()
  socket.once('close', abandonUpstream)

  upstream.once('unexpected-response', (_request, response) => {
    socket.off('close', abandonUpstream)
    rejectUpgrade(socket, response.statusCode || 502, response.statusMessage || 'Bad Gateway')
    upstream.terminate()
  })
  // Pre-open only: once the bridge is live the browser leg is a WebSocket and
  // an HTTP status line must never be written into it.
  const onConnectError = (err: Error) => {
    socket.off('close', abandonUpstream)
    logger.warn({ err: err.message }, '[desktop-screen] broker stream connect failed')
    rejectUpgrade(socket, 502, 'Bad Gateway')
  }
  upstream.once('error', onConnectError)
  upstream.once('open', () => {
    upstream.off('error', onConnectError)
    upstream.on('error', abandonUpstream)
    if (socket.destroyed) {
      socket.off('close', abandonUpstream)
      upstream.terminate()
      return
    }
    // handleUpgrade drops a socket that is no longer usable without calling
    // back; the 'close' hook stays until the bridge owns both legs.
    wss.handleUpgrade(req, socket, head, (client) => {
      socket.off('close', abandonUpstream)
      socket.off('error', onSocketError)
      bridge(client, upstream, early)
    })
  })
}

export function setupDesktopScreenWebSocket(httpServers: HttpServer | HttpServer[]) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

  servers.forEach((httpServer) => {
    httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url || '', 'http://localhost')
      if (url.pathname !== DESKTOP_SCREEN_WS_PATH) return
      handleDesktopUpgrade(wss, req, socket, head).catch((err) => {
        logger.error(err, '[desktop-screen] upgrade failed')
        rejectUpgrade(socket, 500, 'Internal Server Error')
      })
    })
  })

  logger.info(`WebSocket ready at ${DESKTOP_SCREEN_WS_PATH} (bot screen RFB bridge)`)
}
