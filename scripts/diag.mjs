/**
 * Endpoint diagnostic — asks the *driver* what Instagram actually says, over the same session
 * the tools use.
 *
 * It has to go through the driver: the extension connection belongs to the driver's process, so
 * a probe launched here in isolation would find no bridge, silently fall back to the Playwright
 * profile, and answer about a session you never signed into. That failure mode looks like a
 * plausible answer, which is worse than no diagnostic at all.
 *
 * Two things happen here in order:
 *   1. a control fetch, so a broken bridge is never mistaken for a broken Instagram call;
 *   2. a header sweep on `/api/v1/accounts/current_user/`, subtracting one header at a time.
 *
 * The sweep is necessary because Instagram answers a header set it doesn't believe with
 * `{"message":"useragent mismatch"}`, which names none of the headers. One-at-a-time
 * subtraction turns that dead end into a bisection.
 *
 * Usage: npm run diag        (driver + `npm run browser` both running)
 */

const CONTROL = process.env.IG_MCP_CONTROL ?? 'http://127.0.0.1:48234'
const IG = 'https://www.instagram.com/'
const CURRENT_USER = `${IG}api/v1/accounts/current_user/?edit=true`

const call = async (path, params = {}) => {
  const url = new URL(path, CONTROL)
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined) url.searchParams.set(key, value)
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError' || error?.cause) {
      throw new Error(`driver at ${CONTROL} did not answer in time`)
    }
    console.error(
      `\nCannot reach the driver at ${CONTROL} — is \`npm run driver\` running?\n` +
        `  (${error?.message ?? error})`,
    )
    process.exit(1)
  }
}

const clip = (value, n = 260) => {
  const text = String(value ?? '').replace(/\s+/g, ' ')
  return text.slice(0, n) + (text.length > n ? '…' : '')
}

const classify = body => {
  const text = String(body ?? '')
  const message = /^\s*\{/.test(text) ? (() => {
    try {
      return JSON.parse(text)?.message
    } catch {
      return null
    }
  })() : null
  return { kind: /^\s*[{[]/.test(text) ? 'json' : /<!doctype|<html/i.test(text) ? 'HTML' : 'text', message }
}

const row = (label, out, ms) => {
  const { kind, message } = classify(out.body)
  const mark = out.status >= 200 && out.status < 300 ? 'ok ' : out.status === 0 ? 'ERR' : 'bad'
  console.log(`${mark} ${String(out.status).padStart(3)} ${kind.padEnd(4)} ${String(ms).padStart(5)}ms  ${label}`)
  if (message) console.log(`     message: ${message}`)
  else if (kind !== 'HTML') console.log(`     ${clip(out.body)}`)
  console.log('')
}

// ---------------------------------------------------------------------------

const status = await call('/status')
console.log(`driver     : ${CONTROL}`)
console.log(`transport  : ${status.transport}`)
console.log(`bridge     : ${status.bridge.connected ? `connected on ${status.bridge.port}` : 'NOT connected'}`)
console.log(`tools      : ${status.tools}\n`)

if (!status.bridge.connected) {
  console.error('No extension attached — every probe below would fall back to the Playwright profile,')
  console.error('which is a session you never signed into, so the answers would be misleading.')
  console.error('Run `npm run browser`, sign in, then retry.')
  process.exit(1)
}

// A control that has nothing to do with auth or headers. If this fails, the bridge is the
// problem and everything after it is noise.
{
  const started = Date.now()
  row('CONTROL robots.txt (bridge health, not Instagram)', await call('/probe', { path: `${IG}robots.txt` }), Date.now() - started)
}

// Whether the page thinks you're signed in. This is independent of any API response — the
// login wall shows up as a class on <html> — so it separates "the call was rejected" from
// "there was no session to authenticate the call with" before any header theory is pursued.
{
  const home = await call('/probe', { path: IG })
  const classes = /<html[^>]*class="([^"]*)"/i.exec(home.body ?? '')?.[1] ?? ''
  console.log(`page state : ${classes || '(no <html> class found)'}\n`)
}

console.log('--- header sweep on current_user (one subtraction per row) ---\n')

/**
 * `null` tells the content script to omit that header entirely. Each variant differs from the
 * defaults by one thing, so whichever row first stops saying "useragent mismatch" identifies
 * the offender by construction.
 */
const VARIANTS = [
  ['defaults (app-id + x-requested-with + x-asbd-id)', {}],
  ['minus x-requested-with', { 'x-requested-with': null }],
  ['minus x-asbd-id', { 'x-asbd-id': null }],
  ['minus x-ig-app-id', { 'x-ig-app-id': null }],
  ['bare: no extra headers at all', { 'x-ig-app-id': null, 'x-requested-with': null, 'x-asbd-id': null }],
  ['web app-id 936619743392459', { 'x-ig-app-id': '936619743392459' }],
  ['web app-id, minus x-requested-with', { 'x-ig-app-id': '936619743392459', 'x-requested-with': null }],
]

const firstClean = []

for (const [label, headers] of VARIANTS) {
  const started = Date.now()
  const out = await call('/probe', { path: CURRENT_USER, headers: JSON.stringify(headers) })
  row(label, out, Date.now() - started)
  const { message } = classify(out.body)
  if (out.status === 200 && !/useragent mismatch/i.test(message ?? '')) firstClean.push(label)
}

// Does the fix generalise, or does it only rescue this one endpoint?
console.log('--- does the working header set generalise? ---\n')

for (const label of firstClean.length ? [firstClean[0]] : []) {
  const headers = VARIANTS.find(([name]) => name === label)[1]
  for (const path of [
    ['topsearch', `${IG}api/v1/web/search/topsearch/?context=blended&query=nike`],
    ['profile of a public account', `${IG}api/v1/users/web_profile_info/?username=instagram`],
  ]) {
    const started = Date.now()
    row(`${path[0]}  ← ${label}`, await call('/probe', { path: path[1], headers: JSON.stringify(headers) }), Date.now() - started)
  }
}

// The answer to "am I signed in, and as whom?" — using the default headers, i.e. exactly what
// the tools themselves will send.
const me = await call('/probe', { path: CURRENT_USER })
const username = (() => {
  try {
    return JSON.parse(me.body)?.user?.username
  } catch {
    return null
  }
})()

console.log(`signed in as: ${username ? '@' + username : '(no user object)'}`)
if (firstClean.length) console.log(`headers that work: ${firstClean.join(' | ')}`)
else if (!username) console.log(`default-header response: ${clip(me.body, 200)}`)
