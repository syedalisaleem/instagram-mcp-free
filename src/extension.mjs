import { WebSocketServer } from 'ws'

/**
 * The server half of the bridge: the Chrome extension dials *us* here, on loopback only.
 *
 * Note the direction is inverted from upstream's design. INSSIST's server listens and the
 * extension calls tools; here the extension only ever answers `fetch` requests, and every
 * tool is still executed by our own Node code. That split is the whole point — all 60 tool
 * implementations stay in one testable place instead of being duplicated into a bundle, and
 * swapping between the extension and the Playwright fallback is a one-line dispatch.
 *
 * The gate mirrors upstream's exactly: `Origin` must be an extension. A website opening this
 * socket sends `Origin: https://…`, a stray local process usually sends none, and only a
 * Chrome extension context produces `chrome-extension://…`.
 */

const HOST = '127.0.0.1'
const DEFAULT_EXT_PORT = 48233
const FETCH_TIMEOUT_MS = 30_000

export const extPort = () => Number(process.env.IG_MCP_EXT_PORT ?? DEFAULT_EXT_PORT)

const log = (...args) => console.error('[bridge]', ...args)

/** Set once the listener is up; `null` until then. */
let server = null

/** The one attached extension. A second connection replaces it. */
let active = null
let activeMeta = null

let seq = 0
const pending = new Map()

const rejectPending = reason => {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve({ ok: false, status: 0, json: null, text: reason })
  }
  pending.clear()
}

const isExtensionOrigin = origin =>
  origin.startsWith('chrome-extension://') || origin.startsWith('chrome://')

const accept = (socket, origin) => {
  if (active && active !== socket) {
    try {
      active.close(1000, 'superseded')
    } catch {
      /* already gone */
    }
  }

  active = socket
  activeMeta = { agent: null, connectedOn: Date.now() }
  log(`extension attached (origin ${origin})`)

  socket.on('message', raw => {
    let frame
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!frame || typeof frame.t !== 'string') return

    switch (frame.t) {
      case 'hello': {
        activeMeta = { agent: frame.agent ?? null, connectedOn: Date.now() }
        log(`paired with ${activeMeta.agent?.name ?? 'unknown agent'} v${activeMeta.agent?.version ?? '?'}`)
        socket.send(JSON.stringify({ t: 'welcome', v: 1, server: 'ig-mcp-free' }))
        break
      }

      case 'res': {
        const entry = pending.get(frame.id)
        if (!entry) return
        clearTimeout(entry.timer)
        pending.delete(frame.id)

        if (frame.error) {
          entry.resolve({ ok: false, status: 0, json: null, text: frame.error })
          return
        }

        const status = Number(frame.status) || 0
        entry.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: frame.json ?? null,
          text: frame.text ?? null,
          // Forwarded, not rebuilt. The content script volunteers `sentHeaders` and `pageState`
          // only when asked for, and quietly dropping them here would leave "the request was
          // rejected" and "there was no valid session to authenticate it" indistinguishable —
          // the exact ambiguity these diagnostics exist to end.
          ...(frame.sentHeaders ? { sentHeaders: frame.sentHeaders } : {}),
          ...(frame.pageState ? { pageState: frame.pageState } : {}),
          // The `x-ig-www-claim` the extension was actually carrying when this response came
          // back, so a diagnosis can see whether the claim had rotated yet.
          ...(frame.claim ? { claim: frame.claim } : {}),
          ...(frame.respHeaders ? { respHeaders: frame.respHeaders } : {}),
        })
        break
      }

      case 'ping':
        socket.send(JSON.stringify({ t: 'pong' }))
        break

      default:
        break
    }
  })

  socket.on('close', () => {
    if (active !== socket) return
    active = null
    activeMeta = null
    log('extension detached')
    rejectPending('Chrome extension disconnected')
  })

  socket.on('error', error => log(`socket error: ${error.message}`))
}

export const bridge = {
  get connected() {
    return active != null && active.readyState === 1
  },

  info() {
    return { connected: this.connected, port: extPort(), agent: activeMeta?.agent ?? null }
  },

  /**
   * Performs one same-origin request through the extension, answering in exactly the shape
   * the Playwright transport does. Never throws: a dead bridge degrades to a `status: 0`
   * result, which `igOk` turns into a readable error instead of an unhandled rejection.
   */
  fetch(url, { method = 'GET', body = null, headers = {}, full = false } = {}) {
    return new Promise(resolve => {
      if (!this.connected) {
        resolve({ ok: false, status: 0, json: null, text: 'Chrome extension is not connected' })
        return
      }

      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({
          ok: false,
          status: 0,
          json: null,
          text: `Chrome extension did not answer within ${FETCH_TIMEOUT_MS / 1000}s`,
        })
      }, FETCH_TIMEOUT_MS)

      pending.set(id, { resolve, timer })
      active.send(JSON.stringify({ t: 'req', id, req: { url, method, body, headers, full } }))
    })
  },
}

/** Binds the loopback listener. Safe to call once; the port choice comes from IG_MCP_EXT_PORT. */
export const startBridge = ({ port = extPort() } = {}) => {
  if (server) return bridge

  server = new WebSocketServer({ host: HOST, port })

  server.on('listening', () => log(`extension listener up on ws://${HOST}:${port}/`))
  server.on('error', error => log(`listener error: ${error.message}`))

  server.on('connection', (socket, request) => {
    const origin = request.headers.origin ?? ''

    // Config escape hatch, purely so a rejected handshake is diagnosable rather than silent.
    if (!isExtensionOrigin(origin) && process.env.IG_MCP_ALLOW_ANY_ORIGIN !== '1') {
      log(`REJECTED origin "${origin || '(none)'}" — only a chrome-extension:// origin may attach`)
      socket.close(1008, 'extension origin required')
      return
    }

    accept(socket, origin || '(none)')
  })

  return bridge
}

export const stopBridge = () => {
  rejectPending('bridge shutting down')
  try {
    active?.close(1000, 'shutting down')
  } catch {
    /* already gone */
  }
  active = null
  activeMeta = null
  server?.close()
  server = null
}
