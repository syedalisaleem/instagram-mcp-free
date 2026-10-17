/**
 * Owns the WebSocket to the local driver.
 *
 * This lives in an offscreen document rather than the service worker for one reason: MV3
 * workers are suspended after ~30s idle, and a socket held in one dies silently and never
 * reconnects on its own. An offscreen document persists until the extension is disabled or
 * reloaded, which is the lifetime a driver waiting for a browser expects.
 *
 * Pairing is automatic: we dial on load, and every path back to load — install, browser
 * start, socket drop, config change — re-dials. There is no toggle to remember.
 *
 * Two rules learned the hard way, both encoded below:
 *
 *  1. The message listener is registered *before* anything else runs. If a statement further
 *     down throws, the document still answers `status` and says why — otherwise a dead
 *     document is indistinguishable from a healthy one that simply hasn't paired, which is
 *     exactly the ambiguity that cost an hour of diagnosis here.
 *
 *  2. This document has no `chrome.storage`. It reads back as `undefined` in an offscreen
 *     context even with the `storage` permission granted and even though it works fine in the
 *     worker. So persistence is brokered through the worker (`driver-config` / `driver-state`)
 *     and this file keeps only an in-memory mirror. Touched naively, this failure kills the
 *     script before it can say a word.
 */

globalThis.__igOffBooted = Date.now()

const DEFAULT_URL = 'ws://127.0.0.1:48233/'
const PING_MS = 20_000
const CONFIG_TIMEOUT_MS = 3_000

/** Set if a statement throws; reported back through `status`. */
globalThis.__igOffError = null

const catchTop = what => error => {
  globalThis.__igOffError = `${what}: ${error?.message ?? error}`
}

/** Attempts 1..5 back off 1s,2s,4s,8s,16s, then level at 30s. */
const backoffMs = attempt => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))

let socket = null
let attempt = 0
let pingTimer = null

/** In-memory mirror of the worker-held `driver` record — this file is the sole author of it. */
let driverState = {}

/** Monotonic writer sequence; lets the worker drop any packet that arrives out of order. */
let driverSeq = 0

const emit = frame => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

const toWorker = message => chrome.runtime.sendMessage(message)

/**
 * Pushes the whole record to the worker, which persists it verbatim.
 *
 * Merging in the worker instead would need a read-modify-write there, and two patches in
 * flight would take the same snapshot — the later write silently discarding the earlier
 * `connected` flag. Owning the object here and sending it whole removes that race entirely.
 */
const remember = async patch => {
  driverState = { ...driverState, ...patch }
  try {
    await toWorker({ target: 'bg', cmd: 'driver-state', seq: ++driverSeq, state: { ...driverState } })
  } catch (error) {
    globalThis.__igOffError = `driver-state: ${error?.message ?? error}`
  }
}

/**
 * Asks the worker for the configured driver URL.
 *
 * Bounded by CONFIG_TIMEOUT_MS: if the worker is slow to wake, dialing the default promptly
 * beats waiting on config the user probably never changed.
 */
const driverConfig = async () => {
  const reply = await Promise.race([
    toWorker({ target: 'bg', cmd: 'driver-config' }).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), CONFIG_TIMEOUT_MS)),
  ])
  return reply?.url || DEFAULT_URL
}

/**
 * The driver asks, we relay to the worker, which drives the content script.
 *
 * Two-shaped on purpose: `error` means the request never reached a page, whereas a completed
 * HTTP 401/429 arrives as `{status, json, text}` with no `error` key. Collapsing those would
 * make "not logged in" and "extension broken" indistinguishable to the agent.
 */
const handleRequest = async frame => {
  let response
  try {
    response = await toWorker({ target: 'bg', cmd: 'relay-req', req: frame.req })
  } catch (error) {
    response = { transportError: String(error?.message ?? error) }
  }

  if (!response || response.transportError) {
    emit({
      t: 'res',
      id: frame.id,
      error: response?.transportError ?? 'no response from the service worker',
    })
    return
  }

  emit({
    t: 'res',
    id: frame.id,
    status: response.status ?? 0,
    json: response.json ?? null,
    text: response.text ?? null,
    // Forwarded rather than rebuilt as `{status, json, text}`: the content script volunteers
    // `sentHeaders` and `pageState` only when asked for, and dropping them here would make
    // "the request was rejected" and "there was no valid session to authenticate it"
    // indistinguishable — which is exactly the confusion these exist to end.
    ...(response.sentHeaders ? { sentHeaders: response.sentHeaders } : {}),
    ...(response.pageState ? { pageState: response.pageState } : {}),
  })
}

const connect = async () => {
  const url = await driverConfig()
  void remember({ connecting: true, url })

  const ws = new WebSocket(url)
  socket = ws

  ws.onopen = () => {
    if (socket !== ws) return
    attempt = 0
    emit({ t: 'hello', v: 1, agent: { name: 'ig-mcp-free-ext', version: '0.1.0' } })
    clearInterval(pingTimer)
    pingTimer = setInterval(() => emit({ t: 'ping' }), PING_MS)
    void remember({ connected: true, connecting: false, since: Date.now() })
  }

  ws.onmessage = event => {
    if (socket !== ws) return

    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    if (!frame || typeof frame.t !== 'string') return

    switch (frame.t) {
      case 'welcome':
        void remember({ paired: true, server: frame.server ?? null })
        break
      case 'req':
        void handleRequest(frame)
        break
      case 'ping':
        emit({ t: 'pong' })
        break
      default:
        break
    }
  }

  ws.onerror = () => {
    /* `onclose` always follows and carries the actionable message */
  }

  ws.onclose = () => {
    if (socket !== ws) return // a deliberate reconnect closed this one
    clearInterval(pingTimer)
    void remember({ connected: false, connecting: true })
    attempt += 1
    setTimeout(() => void connect().catch(catchTop('connect retry')), backoffMs(attempt))
  }
}

/** Full teardown and immediate re-dial — used when the driver URL changes. */
const reconnect = async () => {
  const current = socket
  socket = null
  clearInterval(pingTimer)
  attempt = 0
  try {
    current?.close()
  } catch {
    /* already gone */
  }
  await connect()
}

// --- registered before anything else runs, on purpose (see header comment) -------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return

  if (message.cmd === 'status') {
    sendResponse({
      booted: globalThis.__igOffBooted ?? null,
      error: globalThis.__igOffError ?? null,
      storageAvailable: typeof chrome.storage !== 'undefined',
      driver: { ...driverState },
    })
    return false // fully synchronous reply; no channel to keep open
  }

  if (message.cmd === 'reconnect') {
    void reconnect()
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message ?? error) }))
    return true
  }

  sendResponse({ transportError: `unknown cmd "${message.cmd}"` })
  return false
})

// --- everything below can fail without going deaf --------------------------------------
void connect().catch(catchTop('connect'))
