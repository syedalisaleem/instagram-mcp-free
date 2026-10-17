/**
 * Message router only. The service worker deliberately owns no connection.
 *
 * MV3 workers are suspended after ~30s idle and any socket they hold dies with them — and a
 * dead worker with no pending event never wakes itself, so the extension would go permanently
 * silent without ever appearing broken. The WebSocket therefore lives in an offscreen
 * document, which persists until the extension is disabled or reloaded, and this worker only
 * shuttles frames between it and the content script on instagram.com.
 */

const OFFSCREEN_PATH = 'offscreen.html'

// FIRST executable statement — issued against storage (which is shared across every world, so
// unlike a global it is readable from any context and cannot be masked by an isolated world).
// A parse failure, a stale cached copy, or a wrong-context global each look different from
// "this ran and storage kept the value".
chrome.storage.local
  .set({ swBoot: Date.now() })
  .then(
    () => {
      globalThis.__igSwBooted = Date.now()
    },
    error => {
      globalThis.__igSwError = `storage set failed: ${error?.message ?? error}`
    },
  )

/** Offscreen's `reasons` enum has shifted between Chrome releases; try the ones that fit. */
const REASON_CANDIDATES = [['WORKERS'], ['IFRAME_SCRIPTING'], ['DOM_PARSER']]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ensureOffscreen = async () => {
  if (await chrome.offscreen.hasDocument()) return

  let lastError = null

  for (const reasons of REASON_CANDIDATES) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons,
        justification: 'Hold a persistent WebSocket to the local instagram-mcp-free driver.',
      })
      await chrome.storage.local.set({ diag: { offscreen: 'ok', reasons, at: Date.now() } })
      return
    } catch (error) {
      const message = String(error?.message ?? error)
      lastError = message
      // Another caller creating it first is a success in disguise.
      if (/single offscreen|already exists/i.test(message)) {
        await chrome.storage.local.set({ diag: { offscreen: 'already-exists', at: Date.now() } })
        return
      }
      if (!/reason|invalid/i.test(message)) break
    }
  }

  // Never fail silently: without this a rejected `reasons` enum looks exactly like "not
  // paired", and the user is left guessing.
  const detail = lastError ?? 'every reason candidate was rejected'
  await chrome.storage.local.set({ diag: { offscreen: 'failed', detail, at: Date.now() } })
  throw new Error(`chrome.offscreen.createDocument failed: ${detail}`)
}

// Belt and braces: install, browser start, and any stray wake-up all converge on the same
// idempotent ensure.
const start = () =>
  ensureOffscreen().catch(async error => {
    await chrome.storage.local
      .set({ diag: { offscreen: 'failed', detail: String(error?.message ?? error), at: Date.now() } })
      .catch(() => {})
  })

chrome.runtime.onInstalled.addListener(start)
chrome.runtime.onStartup.addListener(start)
void start()

const IG_MATCH = 'https://www.instagram.com/*'

/** Highest `driver-state` sequence applied; a restart legitimately starts from 0 again. */
let lastDriverSeq = 0

const tabIsReady = async tabId => {
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'ping' })
    return true
  } catch {
    return false
  }
}

/**
 * Finds a tab with a live content script, opening one if needed.
 *
 * Opening the tab ourselves is what makes the first tool call work out of the box: the user
 * should not have to have instagram.com already sitting open before their agent can run.
 */
const acquireTab = async () => {
  const open = await chrome.tabs.query({ url: IG_MATCH })

  for (const tab of open) {
    if (tab.id != null && (await tabIsReady(tab.id))) return tab
  }

  const created = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false })
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    await sleep(300)
    if (await tabIsReady(created.id)) return created
  }

  throw new Error('instagram.com tab did not become ready within 20s')
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'bg') return

  void (async () => {
    // `relay-req` is the boundary where a bridge request becomes a tab message, so the worker
    // stamps the `kind` here rather than trusting every caller to. (It also has to: the frame
    // arriving from the driver carries no `kind`, and without one the content script ignores
    // the message entirely and the caller sees a message port that simply vanished.)
    if (message.cmd === 'relay-req') {
      const tab = await acquireTab()
      const result = await chrome.tabs.sendMessage(tab.id, { kind: 'fetch', ...(message.req ?? {}) })

      // Never forward an undefined payload: `sendResponse(undefined)` reports to the caller as
      // "no response", which reads as a dead worker rather than a dead tab.
      if (result == null) {
        sendResponse({
          transportError: 'the instagram.com content script accepted the request but returned nothing',
        })
        return
      }
      sendResponse(result)
      return
    }

    if (message.cmd === 'ping') {
      sendResponse({ ok: true })
      return
    }

    // `chrome.storage` is unavailable inside an offscreen document (it reads back as
    // undefined there), while it works normally in a worker. The offscreen document holds the
    // socket, so every piece of persisted driver state is brokered through this worker.
    if (message.cmd === 'driver-config') {
      const data = await chrome.storage.local.get('driver')
      sendResponse({ url: data.driver?.url ?? null })
      return
    }

    // The sender sends the *whole* record plus a monotonic sequence, and this worker only
    // persists it. The obvious alternative — read, merge, write — loses patches: two updates
    // in flight take the same snapshot and the later write discards the earlier one, which is
    // how `connected` can vanish from storage while the socket is in fact up.
    if (message.cmd === 'driver-state') {
      if (typeof message.seq === 'number' && message.seq < lastDriverSeq) {
        sendResponse({ ok: true, stale: true })
        return
      }
      lastDriverSeq = typeof message.seq === 'number' ? message.seq : lastDriverSeq
      await chrome.storage.local.set({ driver: message.state ?? {} })
      sendResponse({ ok: true })
      return
    }

    sendResponse({ transportError: `unknown cmd "${message.cmd}"` })
  })().catch(error => sendResponse({ transportError: String(error?.message ?? error) }))

  return true // the reply is asynchronous; keep the channel open
})
