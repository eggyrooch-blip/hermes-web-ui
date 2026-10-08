#!/usr/bin/env node
/**
 * Mock MT run broker for browser QA of the Bot Screen page.
 *
 * Serves the `/api/run-broker/desktop/*` contract (observe / ensure /
 * lease/acquire / lease/release + the RFB WebSocket) over a fixed, painted
 * framebuffer, applies the same input rule as the real bridge (keyboard and
 * pointer bytes pass only for the human lease holder), and echoes accepted
 * KeyEvents onto the screen so a screenshot shows that input arrived.
 *
 * Test hooks: POST /mock/evict (another viewer takes control → holder's
 * socket closed 4000), POST /mock/stop (desktop stops → 4001),
 * GET /mock/events (accepted KeyEvents + seen broker headers).
 *
 *   node tests/fixtures/desktop-screen/mock-broker.mjs --port 18766 --key broker-key
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const PORT = Number(option('port', '18766'))
const BROKER_KEY = option('key', 'broker-key')
const WIDTH = 960
const HEIGHT = 600

// ── 5x7 bitmap font (rows top→bottom, 5 bits each) ─────────────────────────
const FONT = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31],
  3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12], ' ': [0, 0, 0, 0, 0, 0, 0], ':': [0, 12, 12, 0, 12, 12, 0],
  '-': [0, 0, 0, 31, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], '_': [0, 0, 0, 0, 0, 0, 31],
  '>': [8, 4, 2, 1, 2, 4, 8], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
}

// ── framebuffer (RGB triplets) ─────────────────────────────────────────────
const fb = new Uint8Array(WIDTH * HEIGHT * 3)
function fill(x, y, w, h, [r, g, b]) {
  for (let row = Math.max(0, y); row < Math.min(HEIGHT, y + h); row += 1) {
    for (let col = Math.max(0, x); col < Math.min(WIDTH, x + w); col += 1) {
      const at = (row * WIDTH + col) * 3
      fb[at] = r; fb[at + 1] = g; fb[at + 2] = b
    }
  }
}
function text(x, y, value, color, scale = 3) {
  let cursor = x
  for (const ch of value.toUpperCase()) {
    const glyph = FONT[ch] || FONT[' ']
    glyph.forEach((bits, row) => {
      for (let col = 0; col < 5; col += 1) {
        if (bits & (1 << (4 - col))) fill(cursor + col * scale, y + row * scale, scale, scale, color)
      }
    })
    cursor += 6 * scale
  }
}

const state = {
  running: true,
  lease: { holder: 'agent', viewer_id: null, since: Date.now() / 1000, reason: '', epoch: 1 },
  viewers: new Map(), // viewer_id -> owner open id
  sockets: new Set(), // { ws, viewerId, owner }
  typed: '',
  events: [],
  headersSeen: [],
}

function paint() {
  for (let row = 0; row < HEIGHT; row += 1) {
    const shade = Math.round(40 + (row / HEIGHT) * 60)
    fill(0, row, WIDTH, 1, [20, shade, 90 + Math.round(shade / 2)])
  }
  fill(0, 0, WIDTH, 36, [30, 30, 36])
  text(16, 8, 'HERMES BOT DESKTOP - MOCK', [235, 235, 240], 3)
  fill(80, 90, 800, 420, [245, 245, 248])
  fill(80, 90, 800, 40, [60, 100, 200])
  text(96, 102, 'LOGIN.EXAMPLE.COM', [255, 255, 255], 3)
  text(110, 170, 'USERNAME:', [40, 40, 50], 3)
  fill(110, 200, 740, 50, [255, 255, 255])
  fill(110, 200, 740, 2, [150, 150, 160]); fill(110, 248, 740, 2, [150, 150, 160])
  text(124, 214, state.typed.slice(-36) || '_', [20, 20, 30], 3)
  const holder = state.lease.holder === 'human' ? 'HUMAN HAS CONTROL' : 'AGENT HAS CONTROL'
  text(110, 290, holder, state.lease.holder === 'human' ? [200, 40, 40] : [40, 140, 60], 3)
  text(110, 340, `KEYS RECEIVED: ${state.events.length}`, [40, 40, 50], 3)
  text(110, 390, `LEASE EPOCH: ${state.lease.epoch}`, [90, 90, 100], 3)
}
paint()

const publicLease = () => ({
  ...state.lease,
  viewer_id: null,
  viewer_hash: state.lease.viewer_id ? createHash('sha256').update(state.lease.viewer_id).digest('hex').slice(0, 12) : null,
})

function observeBody(owner) {
  const viewerId = randomBytes(16).toString('base64url')
  state.viewers.set(viewerId, owner)
  return { enabled: true, running: state.running, lease: publicLease(), viewer_id: viewerId }
}

function closeHolderSockets(code, reason) {
  for (const entry of state.sockets) {
    if (entry.viewerId === state.lease.viewer_id) entry.ws.close(code, reason)
  }
}

function repaintAll() {
  paint()
  for (const entry of state.sockets) entry.pushFrame?.()
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${BROKER_KEY}` && Boolean(req.headers['x-hermes-owner-open-id'])
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const path = (req.url || '').split('?')[0]
    if (path === '/mock/events') return json(res, 200, { events: state.events, headers: state.headersSeen, lease: publicLease() })
    if (path === '/mock/evict') {
      closeHolderSockets(4000, 'control-taken')
      state.lease = { holder: 'human', viewer_id: 'someone-else', since: Date.now() / 1000, reason: '', epoch: state.lease.epoch + 1 }
      repaintAll()
      return json(res, 200, { lease: publicLease() })
    }
    if (path === '/mock/stop') {
      state.running = false
      for (const entry of state.sockets) entry.ws.close(4001, 'desktop-closed')
      return json(res, 200, { running: false })
    }
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
    const owner = String(req.headers['x-hermes-owner-open-id'])
    state.headersSeen.push({ path, owner, agent: req.headers['x-hermes-agent-id'] || null })
    const body = raw ? JSON.parse(raw) : {}
    if (path === '/api/run-broker/desktop/observe') return json(res, 200, observeBody(owner))
    if (path === '/api/run-broker/desktop/ensure') {
      state.running = true
      return json(res, 200, observeBody(owner))
    }
    if (path === '/api/run-broker/desktop/lease/acquire' || path === '/api/run-broker/desktop/lease/release') {
      const viewerId = String(body.viewer_id || '')
      if (viewerId && state.viewers.get(viewerId) !== owner) return json(res, 403, { error: 'viewer_not_owned' })
      if (path.endsWith('/acquire')) {
        if (!(state.lease.holder === 'human' && state.lease.viewer_id === viewerId)) {
          if (state.lease.holder === 'human') closeHolderSockets(4000, 'control-taken')
          state.lease = { holder: 'human', viewer_id: viewerId, since: Date.now() / 1000, reason: '', epoch: state.lease.epoch + 1 }
        }
      } else if (state.lease.holder === 'human' && (body.force === true || state.lease.viewer_id === viewerId)) {
        state.lease = { holder: 'agent', viewer_id: null, since: Date.now() / 1000, reason: '', epoch: state.lease.epoch + 1 }
      }
      repaintAll()
      return json(res, 200, { lease: publicLease() })
    }
    json(res, 404, { error: 'not_found' })
  })
})

// ── RFB 3.8 server over WebSocket ──────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', 'http://localhost')
  if (url.pathname !== '/api/run-broker/desktop/ws') return socket.destroy()
  const viewerId = url.searchParams.get('viewer_id') || ''
  const owner = String(req.headers['x-hermes-owner-open-id'] || '')
  if (req.headers.authorization !== `Bearer ${BROKER_KEY}` || !owner) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    if (state.viewers.get(viewerId) !== owner) return ws.close(4401, 'viewer-invalid')
    if (!state.running) return ws.close(4001, 'desktop-closed')
    serveRfb(ws, viewerId, owner)
  })
})

function serveRfb(ws, viewerId, owner) {
  const entry = { ws, viewerId, owner, pushFrame: null }
  state.sockets.add(entry)
  ws.on('close', (code) => {
    state.sockets.delete(entry)
    // Normal close by the viewer releases its lease, as the core bridge does.
    if ((code === 1000 || code === 1001) && state.lease.holder === 'human' && state.lease.viewer_id === viewerId) {
      state.lease = { holder: 'agent', viewer_id: null, since: Date.now() / 1000, reason: '', epoch: state.lease.epoch + 1 }
      paint()
    }
  })

  let stage = 'version'
  let buffer = Buffer.alloc(0)
  let format = { bpp: 32, bigEndian: false, rShift: 16, gShift: 8, bShift: 0 }
  let pendingRequest = false
  let dirty = false

  const sendFrame = () => {
    const bytesPerPixel = format.bpp / 8
    const header = Buffer.alloc(4 + 12)
    header.writeUInt8(0, 0) // FramebufferUpdate
    header.writeUInt16BE(1, 2)
    header.writeUInt16BE(0, 4); header.writeUInt16BE(0, 6)
    header.writeUInt16BE(WIDTH, 8); header.writeUInt16BE(HEIGHT, 10)
    header.writeInt32BE(0, 12) // Raw
    const pixels = Buffer.alloc(WIDTH * HEIGHT * bytesPerPixel)
    for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
      const value = (fb[i * 3] << format.rShift) | (fb[i * 3 + 1] << format.gShift) | (fb[i * 3 + 2] << format.bShift)
      if (format.bigEndian) pixels.writeUInt32BE(value >>> 0, i * 4)
      else pixels.writeUInt32LE(value >>> 0, i * 4)
    }
    ws.send(Buffer.concat([header, pixels]))
    pendingRequest = false
    dirty = false
  }
  // A repaint between requests is held until noVNC asks again, never dropped.
  entry.pushFrame = () => {
    dirty = true
    if (pendingRequest) sendFrame()
  }

  const holds = () => state.lease.holder === 'human' && state.lease.viewer_id === viewerId

  ws.send(Buffer.from('RFB 003.008\n'))
  ws.on('message', (data) => {
    buffer = Buffer.concat([buffer, Buffer.from(data)])
    for (;;) {
      if (stage === 'version') {
        if (buffer.length < 12) return
        buffer = buffer.subarray(12)
        ws.send(Buffer.from([1, 1])) // one security type: None
        stage = 'security'
      } else if (stage === 'security') {
        if (buffer.length < 1) return
        buffer = buffer.subarray(1)
        ws.send(Buffer.from([0, 0, 0, 0])) // SecurityResult OK
        stage = 'clientinit'
      } else if (stage === 'clientinit') {
        if (buffer.length < 1) return
        buffer = buffer.subarray(1)
        const name = Buffer.from('hermes-bot-desktop-mock')
        const init = Buffer.alloc(24)
        init.writeUInt16BE(WIDTH, 0); init.writeUInt16BE(HEIGHT, 2)
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4)
        init.writeUInt32BE(name.length, 20)
        ws.send(Buffer.concat([init, name]))
        stage = 'normal'
      } else {
        if (buffer.length < 1) return
        const type = buffer[0]
        let size
        if (type === 0) size = 20
        else if (type === 2) size = buffer.length >= 4 ? 4 + 4 * buffer.readUInt16BE(2) : Infinity
        else if (type === 3) size = 10
        else if (type === 4) size = 8
        else if (type === 5) size = 6
        else if (type === 6) size = buffer.length >= 8 ? 8 + buffer.readUInt32BE(4) : Infinity
        else return ws.close(1003, 'unsupported message')
        if (buffer.length < size) return
        const message = buffer.subarray(0, size)
        buffer = buffer.subarray(size)
        if (type === 0) {
          format = {
            bpp: message[4],
            bigEndian: message[6] !== 0,
            rShift: message[14],
            gShift: message[15],
            bShift: message[16],
          }
        } else if (type === 3) {
          pendingRequest = true
          if (message[1] === 0 || dirty) sendFrame() // non-incremental, or a held repaint
        } else if ((type === 4 || type === 5 || type === 6) && holds()) {
          if (type === 4 && message[1] === 1) {
            const keysym = message.readUInt32BE(4)
            state.events.push({ type: 'KeyEvent', keysym, viewerId, owner, at: new Date().toISOString() })
            if (keysym >= 0x20 && keysym <= 0x7e) state.typed += String.fromCharCode(keysym)
            if (keysym === 0xff08) state.typed = state.typed.slice(0, -1)
            repaintAll()
          }
        }
      }
    }
  })
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock broker listening on http://127.0.0.1:${PORT}`)
})
