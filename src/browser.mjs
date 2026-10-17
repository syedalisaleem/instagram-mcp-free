import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A real, logged-in Instagram session — the whole point of this project.
 *
 * Upstream gets its session from the INSSIST extension living inside the user's Chrome. We
 * cannot use the user's running Chrome: since Chrome 136 `--remote-debugging-port` is ignored
 * on the default user-data-dir, and attaching to a profile already owned by a running Chrome
 * is refused outright. So we launch our own Chromium with a persistent profile the user logs
 * into once and keeps.
 *
 * Everything else follows from that: all Instagram calls are made *inside the page*, same
 * origin, with the page's own cookies and CSRF token. No credentials are ever read or stored
 * by us, and no traffic is proxied anywhere. This is the same shape as the extension.
 */

const PROFILE_DIR = process.env.IG_MCP_PROFILE ?? fileURLToPath(new URL('../.chrome-profile', import.meta.url))

export const IG_ORIGIN = 'https://www.instagram.com/'

let state = null

/**
 * Returns a live { context, page } on instagram.com, launching if there is none.
 *
 * The browser can die under us (user closes the window, crash, Playwright teardown), and
 * Playwright's stale handle throws `Target page, context or browser has been closed`. So the
 * reuse path is try/catch rather than an internal-flag check — anything unexpected means
 * "state is dead, relaunch", which is the only safe assumption.
 */
export const ensureBrowser = async () => {
  if (state) {
    try {
      const pages = state.context.pages()
      const ig = pages.find(p => p.url().startsWith(IG_ORIGIN))
      if (ig) return { context: state.context, page: ig }

      const page = await state.context.newPage()
      await page.goto(IG_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      return { context: state.context, page }
    } catch {
      state = null
    }
  }

  mkdirSync(PROFILE_DIR, { recursive: true })
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  })
  context.on('close', () => {
    if (state?.context === context) state = null
  })
  state = { context }

  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(IG_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1500)
  return { context, page }
}

/**
 * True only when a real session cookie exists.
 *
 * Checking for the absence of a login form is not enough: on a cold profile Instagram renders
 * a landing page with no form at all, which reads as "logged in" while every API call 401s.
 * `sessionid` is the authoritative signal, so its absence means logged out, full stop.
 */
export const isLoggedIn = async page => {
  try {
    const cookies = await page.context().cookies(IG_ORIGIN)
    return cookies.some(c => c.name === 'sessionid' || c.name === 'sessionidbit')
  } catch {
    return false
  }
}

/**
 * Calls an Instagram web endpoint from inside the page, so the browser attaches the session
 * cookie jar and CSRF token itself. This is the extension's content-script pattern.
 *
 * `x-ig-app-id` is the public web app id Instagram's own frontend sends on every request;
 * without it most `/api/v1/` routes answer 401.
 */
export const igFetch = async (page, path, { method = 'GET', body = null, headers = {} } = {}) => {
  const url = path.startsWith('http') ? path : `${IG_ORIGIN}${path.replace(/^\//, '')}`

  return await page.evaluate(
    async ({ url, method, body, headers }) => {
      const readCookie = name =>
        document.cookie
          .split('; ')
          .find(row => row.startsWith(`${name}=`))
          ?.slice(name.length + 1) ?? ''

      const csrf = readCookie('csrftoken')
      const send = { 'x-ig-app-id': '96698738', 'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': '198375' }
      if (csrf) send['x-csrftoken'] = csrf
      if (body) send['content-type'] = 'application/x-www-form-urlencoded'

      try {
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers: { ...send, ...headers },
          body: body ?? undefined,
        })
        const text = await res.text()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          /* not json */
        }
        return { ok: res.ok, status: res.status, json, text: json ? null : text.slice(0, 400) }
      } catch (error) {
        return { ok: false, status: 0, json: null, text: String(error) }
      }
    },
    { url, method, body, headers },
  )
}

/**
 * Instagram answers errors as 200 + {status:"ok", message:...} as often as with a status code.
 *
 * It also answers *API* paths with whole HTML web pages — a login wall, a 404, an error screen
 * — whenever it decides we are not a signed-in client, sometimes with HTTP 200. Two distinct
 * failures hide in that: raw markup shipped to the agent as an "error", and `json === null`
 * passing through as a successful empty result. Both are caught here, in the one place every
 * request already funnels through.
 */
export const igOk = result => {
  if (!result) return { ok: false, error: 'no response' }

  if (result.status === 401 || result.status === 403)
    return {
      ok: false,
      error:
        'Not logged in (or the session expired). Sign into instagram.com in whichever browser ' +
        'this bridge is using — the signed-in Chrome with the extension, or the driver profile.',
    }

  if (result.status === 429) return { ok: false, error: 'Rate limited by Instagram. Wait a few minutes.' }

  if (result.status === 0)
    return { ok: false, error: result.text || 'the browser bridge produced no response' }

  const text = typeof result.text === 'string' ? result.text : ''
  const looksLikeHtml = !result.json && /^\s*<(!doctype|html)/i.test(text)

  if (looksLikeHtml) {
    // The page title is the only part worth keeping — it distinguishes "Page Not Found" (the
    // endpoint moved) from a login page (the session died) without dumping markup at the agent.
    const raw = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    const title = raw
      ?.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      ?.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      ?.replace(/&amp;/g, '&')
      ?.replace(/&lt;/g, '<')
      ?.replace(/&gt;/g, '>')
      ?.replace(/&quot;/g, '"')
      ?.replace(/&(?:bull|middot);/g, '·')
      ?.replace(/&\w+;/g, ' ') // any remaining entity is noise, not information
      ?.replace(/\s+/g, ' ')
      .trim()
    return {
      ok: false,
      error:
        `Instagram answered HTTP ${result.status} with a web page instead of API JSON` +
        `${title ? ` ("${title}")` : ''} — usually the login wall, so sign into instagram.com in ` +
        'the browser this bridge uses. If you are already signed in, this endpoint has moved.',
    }
  }

  if (result.status >= 400 || !result.ok)
    return { ok: false, error: text || `Instagram returned HTTP ${result.status}` }

  const j = result.json
  if (j && typeof j === 'object') {
    if (j.status === 'fail' || j.status === 'error')
      return { ok: false, error: j.message || j.feedback_message || 'Instagram rejected the request' }
  }

  return { ok: true, data: j }
}
