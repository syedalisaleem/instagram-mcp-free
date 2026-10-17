/**
 * Runs on instagram.com and executes same-origin requests in the page, so Chrome attaches the
 * user's own session cookie jar. This is the one place anything touches Instagram, and it does
 * so exactly the way the page itself does: no credential handling, no third-party endpoint,
 * no cookie ever read back out of the browser.
 *
 * The response shape (`{status, json, text}`, or `{transportError}` if the exchange never
 * completed) is deliberately identical to the Playwright transport's, so every tool
 * implementation works unchanged over either path.
 */

/**
 * The header set instagram.com's own frontend sends on `/api/v1/…`, captured from a live
 * logged-in session (`npm run browser` with `IG_MCP_CAPTURE=1`).
 *
 * The values are not arbitrary, and getting them wrong produces an error that names nothing:
 * `96698738` is Instagram's **Android** app id, so sending it from a desktop browser whose
 * User-Agent claims `Chrome` is a self-declared contradiction — which is precisely what
 * `{"message":"useragent mismatch"}` means. `x-ig-app-id` and the User-Agent have to agree,
 * so the id here is the web app's.
 *
 * `x-asbd-id` tracks Instagram's current front-end build and will drift over time; when calls
 * start failing, re-read the real values with `IG_MCP_CAPTURE=1 npm run browser` rather than
 * guessing.
 */
const IG_APP_ID = '936619743392459' // instagram.com web app
const IG_ASB_ID = '359341'
const IG_WWW_CLAIM = '0'
const IG_MAX_TOUCH_POINTS = '0'

/**
 * `x-ig-www-claim` is not a constant the way the app id is — Instagram issues an HMAC per
 * session and returns it on responses as `x-ig-set-x-ig-www-claim`. Sending the literal `0`
 * once it has been issued is what a good-looking header set and a rejected call look like
 * together, so the last observed claim is remembered and reused rather than recomputed.
 *
 * sessionStorage (not localStorage) is deliberate: the claim belongs to a signed-in tab, so a
 * reload inside it keeps it and an expired claim disappears with the session. If storage is
 * unavailable the claim still holds for the lifetime of this document, which is enough for the
 * burst of calls any single tool call makes.
 */
const CLAIM_KEY = 'ig-mcp-free.x-ig-www-claim'
let wwwClaim = (() => {
  try {
    return sessionStorage.getItem(CLAIM_KEY) ?? null
  } catch {
    return null
  }
})()

const rememberClaim = response => {
  const issued = response.headers.get('x-ig-set-x-ig-www-claim')
  if (issued && issued !== wwwClaim) {
    wwwClaim = issued
    try {
      sessionStorage.setItem(CLAIM_KEY, issued)
    } catch {
      /* storage unavailable — the claim still applies to this document */
    }
  }
}

/**
 * Every `x-ig-*` header Instagram sent back on this response.
 *
 * Guessing at which header carries a session claim is how long dead ends happen: the claim is
 * documented nowhere and its response-side name has changed before. Returning what was actually
 * sent turns "the claim is not rotating" into a list you can read the real name off.
 */
const readSessionHeaders = response => {
  const found = {}
  for (const [name, value] of response.headers.entries()) {
    const lower = name.toLowerCase()
    // Anything Instagram names with `x-ig-`, plus any header carrying "claim" under whatever
    // name it is currently issued — the latter is the one that has moved before.
    if (lower.startsWith('x-ig-') || lower.includes('claim')) found[name] = value
  }
  return found
}

/**
 * Ensures a real claim exists before the first API call of this document.
 *
 * The page holds `hmac.…` on its own requests, which means something handed it that value —
 * and it is not any API response, because those have already been checked above. The document
 * response itself is the remaining candidate, so it is fetched once and read. Doing this only
 * when no claim is known yet keeps the cost to a single request per page, and a failure simply
 * leaves the literal `0` in place, which is what gets sent today anyway.
 */
let claimBootstrapTried = false
const bootstrapClaim = async () => {
  if (wwwClaim || claimBootstrapTried) return
  claimBootstrapTried = true
  try {
    const response = await fetch(`${location.origin}/`, {
      credentials: 'include',
      headers: { accept: 'text/html' },
    })
    rememberClaim(response)
    // The body is irrelevant and would otherwise be buffered for nothing.
    await response.body?.cancel?.().catch(() => {})
  } catch {
    /* no claim obtainable — the literal `0` is still the correct fallback */
  }
}

/** csrftoken is readable from JS; sessionid is HttpOnly and never appears here. */
const readCookie = name =>
  document.cookie
    .split('; ')
    .find(row => row.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? ''

/**
 * Headers instagram.com's own frontend attaches to `/api/v1/…` calls.
 *
 * A caller may override any of them, or pass `null` to drop one entirely. That escape hatch
 * exists for a specific reason: Instagram answers a header set it doesn't believe with
 * `{"message":"useragent mismatch"}`, which names none of the headers involved. Working out
 * which one it disbelieves by editing this file and reloading the extension per guess is not
 * a usable loop, so the caller gets to subtract one header at a time instead.
 */
const IG_HEADERS = {
  'x-ig-app-id': IG_APP_ID,
  'x-requested-with': 'XMLHttpRequest',
  'x-asbd-id': IG_ASB_ID,
  'x-ig-www-claim': IG_WWW_CLAIM,
  'x-ig-max-touch-points': IG_MAX_TOUCH_POINTS,
}

const buildHeaders = supplied => {
  const headers = { ...IG_HEADERS }
  // Applied before the caller's overrides, so an explicit value from the caller still wins —
  // that is the escape hatch the header sweep needs in order to test `0` against the live one.
  if (wwwClaim) headers['x-ig-www-claim'] = wwwClaim
  for (const [name, value] of Object.entries(supplied ?? {})) {
    if (value === null || value === false) delete headers[name]
    else headers[name] = value
  }
  return headers
}

const runFetch = async request => {
  const csrf = readCookie('csrftoken')
  await bootstrapClaim()

  const headers = buildHeaders(request.headers)
  if (csrf) headers['x-csrftoken'] = csrf
  // Default only. The caller may set `content-type` itself in `request.headers`, which it must
  // for GraphQL and several newer write endpoints that require JSON — forcing the form
  // encoding on those produces an opaque 400 with no hint as to why.
  if (request.body && !headers['content-type']) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
  }

  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      credentials: 'include',
      headers,
      body: request.body ?? undefined,
    })

    const text = await response.text()
    // Read the rotated claim before returning — the very next call needs it.
    rememberClaim(response)
    const respHeaders = readSessionHeaders(response)
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* Instagram answers non-JSON often enough that this is normal, not exceptional */
    }

    // A completed HTTP exchange — even 401 or 429 — is a success at this layer. Note there is
    // no `ok` key here: the caller derives HTTP-ok from `status`, which keeps "Instagram said
    // no" from ever colliding with "the request never happened". Only an exchange that never
    // completes reports `transportError`.
    return {
      status: response.status,
      json,
      // Non-JSON bodies are truncated by default: a login page is ~40 KB of markup whose only
      // useful part is a token or two, and shipping all of it over the WebSocket on every 404
      // would slow the diagnostics down for no gain. `full` lifts the cap for the cases where
      // the whole document is the point — reading `fb_dtsg` out of the page, or telling an
      // error shell apart from the real app, both invisible in the first 400 characters.
      text: json ? null : request.full ? text.slice(0, 400_000) : text.slice(0, 400),
      // The claim currently in force, so diagnostics can show whether it has been issued yet.
      claim: wwwClaim,
      respHeaders,
    }
  } catch (error) {
    return { transportError: String(error?.message ?? error) }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind === 'ping') {
    sendResponse({ ok: true })
    return
  }

  if (message?.kind !== 'fetch') return

  void runFetch(message).then(sendResponse)
  return true // keep the channel open for the async reply
})
