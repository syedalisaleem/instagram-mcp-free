import { ensureBrowser, igFetch as playwrightFetch, IG_ORIGIN } from './browser.mjs'
import { bridge } from './extension.mjs'

// Re-exported so consumers have a single import site for the transport layer.
export { IG_ORIGIN }

/**
 * Decides which browser actually executes an Instagram request.
 *
 * Two transports, one contract: both answer `{ok, status, json, text}`, so every tool in
 * `ig.mjs` works unchanged over either. The extension is preferred when it is attached
 * because it runs inside the user's real Chrome with the session they already have; the
 * Playwright profile is the fallback for when it is not.
 *
 *   auto       (default)  extension if connected, otherwise Playwright
 *   extension             extension only — fails loudly rather than silently falling back
 *   playwright            never touch the extension
 */

const preference = () => (process.env.IG_MCP_TRANSPORT ?? 'auto').trim().toLowerCase()

const notConnected =
  'IG_MCP_TRANSPORT=extension but no Chrome extension is attached. Load extension/ unpacked ' +
  '(chrome://extensions → Developer mode → Load unpacked), keep instagram.com signed in, and ' +
  'make sure the driver is listening on 48233.'

/**
 * Returns a session handle without checking login state on either backend.
 *
 * Deliberately not checked here: both transports reach Instagram the same way, so a signed-out
 * browser produces a 401 that `igOk` renders as one clear message. Probing up front would double
 * every request just to say the same thing.
 */
export const acquireSession = async () => {
  const mode = preference()
  const extensionReady = bridge.connected

  if (mode === 'playwright') return { kind: 'playwright', ...(await ensureBrowser()) }

  if (mode === 'extension') {
    if (!extensionReady) throw new Error(notConnected)
    return { kind: 'extension' }
  }

  if (extensionReady) return { kind: 'extension' }

  // auto, no extension: fall back so the tool surface still works standalone.
  return { kind: 'playwright', ...(await ensureBrowser()) }
}

/** Same as acquireSession, but yields null instead of throwing — for status reporting. */
export const peekSession = async () => {
  try {
    return await acquireSession()
  } catch {
    return null
  }
}

/** True when some backend is reachable, without opening a browser unnecessarily. */
export const backendAvailable = () => bridge.connected || preference() === 'auto' || preference() === 'playwright'

/**
 * Performs one Instagram request on the active backend. Accepts either a path or a full URL,
 * matching the Playwright helper's behaviour so callers do not care which they got.
 */
export const igFetch = async (session, path, { method = 'GET', body = null, headers = {} } = {}) => {
  const url = path.startsWith('http') ? path : `${IG_ORIGIN}${path.replace(/^\//, '')}`

  if (session?.kind === 'extension') return await bridge.fetch(url, { method, body, headers })

  if (!session || session.kind !== 'playwright')
    throw new Error('No browser backend acquired — call acquireSession() first')

  return await playwrightFetch(session.page, url, { method, body, headers })
}

/** Which transport the next call would use, for diagnostics. */
export const describeTransport = () => {
  const mode = preference()
  if (mode === 'playwright') return 'playwright (forced)'
  if (mode === 'extension') return bridge.connected ? 'extension (forced)' : 'extension (forced, NOT connected)'
  return bridge.connected ? 'extension (auto)' : 'playwright (auto)'
}
