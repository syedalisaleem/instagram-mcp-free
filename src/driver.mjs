import WebSocket from 'ws'
import { unlockedManifest, contract } from './manifest.mjs'
import { resolve, pendingTools } from './tools.mjs'
import { startBridge, extPort } from './extension.mjs'
import { startControl } from './control.mjs'
import { FAKE_ORIGIN, INSTANCE_ID, AGENT, PROTOCOL_VERSION, HOST, port, makeToken, parse } from './protocol.mjs'

/**
 * The driver wears two faces:
 *
 *   outward, it *is* the INSSIST extension — it dials upstream's MIT server, pairs, advertises
 *   the unlocked manifest, and executes every `call` frame itself.
 *
 *   inward, it is a server for our own Chrome extension, which connects to `extPort()` and does
 *   nothing but answer `fetch` requests from inside the user's signed-in instagram.com tab.
 *
 * Handshake order (both halves) is taken from upstream's `bridge-hub.ts`, not guessed:
 *   ext -> hello        {v, instanceId, agent}
 *   srv -> server-hello {v, serverId, paired}
 *   ext -> pair         {token}          (upstream accepts any well-formed token; it routes
 *                                          reconnects and is explicitly *not* a trust gate)
 *   srv -> ready
 *   ext -> manifest     {tools}          (this is where `pro:false` on all 60 lands)
 *   srv -> call / ping  <->  ext -> result / error / pong
 */

const MANIFEST = unlockedManifest()

const log = (...args) => console.error('[driver]', ...args)

/** Module scope, not inside `connect()` — both must survive across reconnect attempts. */
let downAnnounced = false
let warnedWrongPort = false

const notImplementedCount = pendingTools(contract.map(t => t.name)).length

const runTool = async (name, params) => {
  const handler = resolve(name)
  return await handler(params ?? {})
}

const connect = () => {
  const target = `ws://${HOST}:${port()}/`
  const startedAt = Date.now()

  if (port() === 48231 && !warnedWrongPort) {
    warnedWrongPort = true
    log("WARNING: 48231 is upstream INSSIST's port — you are about to pair into their hub, not ours")
  }

  // Retries are silent; only a fresh dial (first attempt, or one after the bridge came back)
  // is worth a line. Without this the log is a wall of identical connect attempts.
  if (!downAnnounced) log(`dialing ${target} as extension origin ${FAKE_ORIGIN}`)

  const socket = new WebSocket(target, { headers: { Origin: FAKE_ORIGIN } })

  const send = frame => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }

  socket.on('open', () => {
    if (downAnnounced) log('bridge is back up')
    downAnnounced = false
    send({ t: 'hello', v: PROTOCOL_VERSION, instanceId: INSTANCE_ID, agent: AGENT })
  })

  socket.on('message', raw => {
    const frame = parse(raw)
    if (!frame) return

    switch (frame.t) {
      case 'server-hello':
        // `paired` means the hub already has a token for this instance id. We always re-pair:
        // it overwrites with our current token, which upstream treats as normal recovery.
        send({ t: 'pair', token: makeToken() })
        break

      case 'ready':
        log(`ready (${MANIFEST.length} tools advertised, ${notImplementedCount} without an implementation)`)
        send({ t: 'manifest', tools: MANIFEST })
        break

      case 'unauthorized':
        log(`REJECTED: ${frame.reason}`)
        break

      case 'ping':
        send({ t: 'pong' })
        break

      case 'call':
        void (async () => {
          const started = Date.now()
          try {
            const result = await runTool(frame.tool, frame.params)
            send({ t: 'result', id: frame.id, result })
            log(`ok   ${frame.tool} ${Date.now() - started}ms`)
          } catch (error) {
            const message = error?.message ?? String(error)
            send({ t: 'error', id: frame.id, error: { message, code: 'TOOL_ERROR' } })
            log(`FAIL ${frame.tool}: ${message}`)
          }
        })()
        break

      default:
        log(`ignoring unknown frame "${frame.t}"`)
    }
  })

  socket.on('error', error => {
    // ECONNREFUSED is the same information as the close that always follows it; only log
    // errors that are *not* the bridge simply not being up yet.
    if (error.code !== 'ECONNREFUSED') log(`socket error: ${error.message}`)
  })

  socket.on('close', () => {
    // The harness owns the MCP server and spawns it lazily, so the bridge is often simply not
    // up yet. Back off quietly instead of hammering — a fresh log line every 3s is noise, not
    // information. Log the transition once, then stay silent until it comes back up.
    const waited = Date.now() - startedAt
    const delay = waited < 15_000 ? 1_000 : waited < 60_000 ? 3_000 : 10_000
    if (!downAnnounced) {
      log(`bridge not up on ${target}; waiting (retries every ${delay}ms)`)
      downAnnounced = true
    }
    setTimeout(connect, delay)
  })
}

log(`contract: ${contract.length} tools, every pro flag removed`)
log(`implementations present: ${contract.length - notImplementedCount}`)

// Our own extension listener comes up first, so the browser has somewhere to land by the
// time the first tool call arrives.
startBridge()
log(`extension side listening on 127.0.0.1:${extPort()} (auto-pairing, no toggle)`)

// Diagnostics live here rather than in any other process: the extension connection belongs to
// this one, so a probe launched elsewhere would quietly fall back to the Playwright profile
// and answer about a session you never signed into.
startControl()

connect()
