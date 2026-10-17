/**
 * Opens the browser you sign into once and keep.
 *
 * This is the only step that needs a human: load `extension/` into a persistent Chromium
 * profile, land on instagram.com, and log in. The cookie jar that results is yours, stored in
 * `.ext-profile/`, and every later tool call rides it through the extension.
 *
 * Nothing here pairs manually — the extension dials `ws://127.0.0.1:48233/` on its own the
 * moment it loads, so the only two things this script needs to tell you are whether the
 * extension attached, and whether you are signed in.
 *
 * Usage:  npm run browser      (driver must be running first: npm run driver)
 *         IG_MCP_CAPTURE=1 npm run browser   — additionally print the header set
 *         instagram.com's own frontend uses, from a throwaway tab.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const EXT_DIR = fileURLToPath(new URL('../extension', import.meta.url))
const PROFILE = process.env.IG_MCP_EXT_PROFILE ?? fileURLToPath(new URL('../.ext-profile', import.meta.url))
const IG = 'https://www.instagram.com/'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const say = (...args) => console.log(...args)

const CDP_PORT = Number(process.env.IG_MCP_CDP_PORT ?? 9333)

say('1. loading the extension from', EXT_DIR)
mkdirSync(PROFILE, { recursive: true })

/**
 * Chrome is started detached from this process and attached over CDP.
 *
 * `launchPersistentContext` cannot detach its browser — only `browserType.launch` has a
 * `detached` option — so a launcher that exits (Ctrl+C, a closed terminal, a shell restart)
 * takes Chrome down with it, and takes the extension's pairing down with that. Everything the
 * agent depends on then dies with a terminal window nobody is looking at.
 *
 * Starting Chrome as its own process group and connecting over CDP inverts the dependency. The
 * extension dials the driver directly, so once the browser is up it no longer needs *this*
 * process at all. Re-running `npm run browser` while a browser is already up just reconnects
 * rather than dying on the profile lock, which makes the command idempotent as a bonus.
 */
const attach = () => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)

/**
 * `connectOverCDP` resolves to a **Browser**, but everything below wants its BrowserContext:
 * service workers, `addCookies`, `pages()`, `newPage()` and `cookies()` are all context methods
 * and none of them exist on a Browser. Reading `context.serviceWorkers` off the Browser is what
 * killed every detached launch one line after the window opened — invisibly, because spawning
 * Chrome happens *before* this point and the extension pairs with the driver on its own, so the
 * only symptom was this script's own traceback while the stack beneath it kept working.
 */
let browser = await attach().catch(() => null)

if (!browser) {
  spawn(
    chromium.executablePath(),
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      `--no-first-run`,
      `--no-default-browser-check`,
      `--disable-session-crashed-bubble`,
      // Playwright's own Chromium, not a system Chrome: branded builds have been removing
      // `--load-extension`, and this window is worthless without the extension in it.
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--window-size=1280,900',
      IG,
    ],
    { detached: true, stdio: 'ignore' },
  ).unref()

  for (let attempt = 0; attempt < 60 && !browser; attempt += 1) {
    await sleep(500)
    browser = await attach().catch(() => null)
  }

  if (!browser) {
    console.error(
      `\nFAIL: could not reach Chrome on 127.0.0.1:${CDP_PORT}.\n` +
        '  It may still be starting, or another browser may hold the debugging port.',
    )
    process.exit(1)
  }
}

// The default context carries the pages and the extension's service worker. connectOverCDP has
// hydrated the target list by the time it resolves, so this reads on the first pass — the poll
// exists only so a late-arriving context reports itself clearly instead of throwing a
// TypeError at the line below it.
let context = browser.contexts()[0] ?? null
for (let attempt = 0; attempt < 20 && !context; attempt += 1) {
  await sleep(250)
  context = browser.contexts()[0] ?? null
}

if (!context) {
  console.error('\nFAIL: connected to Chrome but it exposed no browser context.')
  process.exit(1)
}

/**
 * The extension's service worker, if Playwright can see it right now.
 *
 * Playwright reports service workers it watched start — which is what happens when it owns the
 * browser process. Attached over CDP to a window that is already running, the extension's worker
 * predates the connection and never enters `serviceWorkers()`, even though the worker is plainly
 * alive: the control plane reports it paired. So an empty list is not a failure on its own.
 * Pairing below asks whichever end can answer, and a window that truly failed to load the
 * extension is caught there too, where the actionable advice lives.
 */
let worker = context.serviceWorkers()[0] ?? null

/**
 * Optional: adopt a session you already hold instead of typing a password into the window.
 *
 * `sessionid` is HttpOnly, so it cannot be read back out of a page — the only ways into an
 * existing session are logging in by hand, or being handed the value. This is the latter, and
 * it is deliberately supplied per-launch through the environment rather than persisted: a
 * session cookie is a bearer credential for the whole account, so it should not outlive the
 * process that needed it.
 */
const seedSession = process.env.IG_MCP_SESSIONID
if (seedSession) {
  await context
    .addCookies([
      {
        name: 'sessionid',
        value: seedSession,
        domain: '.instagram.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ])
    .catch(error => say(`   could not seed the session cookie: ${error.message}`))
  say('1a. adopted the session from IG_MCP_SESSIONID')
}

say('2. opening instagram.com')
const page = context.pages()[0] ?? (await context.newPage())
await page.goto(IG, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})

// Whether you're signed in is answerable here without asking Instagram anything. `sessionid`
// is HttpOnly, so the page itself can never read it — but the browser holding the cookie jar
// can list it, which makes this the one login check that can't be fooled by a page that has
// simply not finished loading, or by an API path that rejects you for an unrelated reason.
const cookies = await context.cookies(IG).catch(() => [])
if (cookies.some(cookie => cookie.name === 'sessionid' && cookie.value)) {
  say('   signed in — a sessionid cookie is present')
} else {
  say('   NOT signed in yet — log in in the window that just opened')
}

/**
 * Print the headers instagram.com's own frontend uses on `/api/v1/…` calls.
 *
 * This is the reference our synthesised headers have to match, and the only place the correct
 * set is visible. A valid `sessionid` combined with `useragent mismatch` on *every* path means
 * the difference sits in a header nobody would think to guess — so stop guessing and read it.
 */
const captureApiHeaders = target => {
  target.on('request', request => {
    const url = request.url()
    if (!url.includes('/api/v1/')) return
    request
      .allHeaders()
      .then(headers => {
        const shown = Object.entries(headers)
          .filter(([name]) => !name.startsWith(':') && name !== 'cookie')
          .map(([name, value]) => `${name}: ${value}`)
          .join('\n        ')
        // The full URL, not just the path. Several endpoints — search above all — are refused
        // with a bare 404 when a required query parameter is missing, so the path alone
        // describes an endpoint that appears not to exist.
        say(`   [instagram's own call] ${url}`)
        say(`        ${shown}`)
        const body = request.postData()
        if (body) say(`        body: ${body.slice(0, 400)}`)
      })
      .catch(() => {})
  })
}

captureApiHeaders(page)

say('3. waiting for the extension to attach to the driver')

/**
 * The pairing handshake has two observers and either is sufficient: the extension writes
 * `driver.connected` into its own storage when its socket opens, and the driver flips
 * `bridge.connected` when that socket lands on its side — the same event, opposite ends.
 *
 * Asking the extension needs its worker to be visible over CDP (which, per above, it may not
 * be); asking the driver needs only the control plane it already runs for diagnostics. So read
 * whichever answer is available on each pass, extension first, and keep re-reading `serviceWorkers()`
 * — Playwright can surface a late-starting worker mid-loop, and then the richer answer
 * (including which URL it connected to) becomes available for free.
 */
const deadline = Date.now() + 30_000
let paired = false
let detail = null

while (Date.now() < deadline && !paired) {
  worker ??= context.serviceWorkers()[0] ?? null

  let state = null
  if (worker) {
    state = await worker.evaluate(() => chrome.storage.local.get('driver')).catch(() => null)
    if (state?.driver?.connected) {
      detail = state.driver
      paired = true
      break
    }
  }

  // No worker visible, or its storage did not answer: ask the driver, which hears the same
  // socket land without needing anything from the browser.
  if (!state) {
    const status = await fetch('http://127.0.0.1:48234/status')
      .then(response => response.json())
      .catch(() => null)
    if (status?.bridge?.connected) {
      paired = true
      break
    }
  }

  await sleep(400)
}

if (!paired) {
  say('')
  say('   NOT paired after 30s.')
  if (worker) {
    say(`   The extension is visible but reports: ${JSON.stringify(detail ?? 'not connected')}`)
    say('   Start the driver with `npm run driver` in another terminal, then reopen this window.')
  } else {
    say('   Neither the extension nor the driver answered — the extension worker was never')
    say('   visible over CDP. Open chrome://extensions in this window and look for an "Errors"')
    say('   link. If you edited extension/ files since installing, delete .ext-profile/ and')
    say('   retry — Chrome can keep serving the previous copy from a profile it knows.')
    say('   Also confirm `npm run driver` is running (it reports on 127.0.0.1:48234/status).')
  }
} else if (detail) {
  say(`   paired with ${detail.url ?? 'the local driver'}`)
} else {
  say('   paired — confirmed by the driver (extension worker not visible over CDP)')
}

// Optional capture pass. Instagram's feed is server-rendered and makes no API calls while
// idle, so provoking one requires loading a page that does — done in a throwaway tab so the
// window you signed in with is left exactly as it was.
if (process.env.IG_MCP_CAPTURE) {
  say('')
  say('capturing the real header set from a throwaway tab…')
  const spy = await context.newPage()
  captureApiHeaders(spy)
  await spy.goto(`${IG}instagram/`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  await sleep(12_000)
  await spy.close().catch(() => {})
  say('capture finished')
}

/**
 * GraphQL capture — the replacement for guessing at retired `/api/v1/…` paths.
 *
 * Instagram has moved search, direct messages, saved posts and profile reads behind
 * `/graphql/query`, where the feature is identified by a `doc_id` that is published nowhere,
 * differs per feature, and rotates without notice. It cannot be derived, so the only way to
 * learn one is to drive the real UI and read what the page sends. This does exactly that:
 * opens a throwaway tab, walks the screens, and records every GraphQL request body.
 *
 * Output goes to `scripts/captured-graphql.json` as a list of `{doc_id, variables, where}`,
 * which is the input the `ig.mjs` GraphQL helpers consume.
 *
 * Usage:  IG_MCP_GQL=1 npm run browser
 */
const CAPTURE_PATH = fileURLToPath(new URL('./captured-graphql.json', import.meta.url))

/**
 * Capture when asked to, and whenever there is nothing captured yet.
 *
 * A fresh clone has no capture file, and without one search and the direct-message tools fail:
 * they replay Instagram's own GraphQL requests rather than inventing them, and those requests
 * are recorded by driving the real UI. Doing it here on first launch means installing the
 * project and running two commands is the entire setup. `IG_MCP_GQL=1` stays the way to force a
 * refresh, which matters because the tokens recorded here expire on their own.
 */
if (process.env.IG_MCP_GQL || !existsSync(CAPTURE_PATH)) {
  say('')
  say(
    process.env.IG_MCP_GQL
      ? 'capturing GraphQL doc_ids from the real UI…'
      : 'no GraphQL capture yet — recording one now. IG_MCP_GQL=1 npm run browser reruns it.',
  )

  /** Instagram sends GraphQL either as JSON or as a form body; accept both. */
  const parseGraphql = postData => {
    if (!postData) return {}
    try {
      const json = JSON.parse(postData)
      if (json.doc_id) return { doc_id: json.doc_id, variables: json.variables, encoded: 'json' }
    } catch {
      /* not JSON — fall through to the form parser */
    }
    const params = new URLSearchParams(postData)
    return params.get('doc_id')
      ? { doc_id: params.get('doc_id'), variables: params.get('variables'), encoded: 'form' }
      : {}
  }

  const seen = new Map()
  const spy = await context.newPage()
  // The header/URL logger too, not only GraphQL: search on web still calls a REST endpoint
  // that 404s for us, and the only way to see which query parameters it carries is to watch
  // the page make the call.
  captureApiHeaders(spy)
  spy.on('request', request => {
    // Both GraphQL entry points are matched, not just `/graphql/query`: instagram.com's web
    // app splits its queries across two paths — `/graphql/query` for Relay reads such as a
    // profile grid, and `/api/graphql` for the search drawer. Watching only the first is why
    // an earlier capture run found nothing for search while the page made ten calls.
    if (!request.url().includes('graphql')) return
    const parsed = parseGraphql(request.postData())
    if (!parsed.doc_id) return
    const key = `${parsed.doc_id}|${request.postData()}`
    if (seen.has(key)) return
    // The path travels with the doc_id: the same identifier reached over `/api/graphql`
    // versus `/graphql/query` is a different contract, and remembering only the number would
    // send the next call to the wrong entry point.
    seen.set(key, {
      doc_id: parsed.doc_id,
      variables: parsed.variables ?? null,
      path: new URL(request.url()).pathname,
      // Whether the page sent JSON or a form body. Replaying a form-encoded query as JSON
      // gets a bare 400 that names nothing, so the encoding is part of the captured contract.
      encoded: parsed.encoded ?? 'json',
      // The page's own body and headers, replayed verbatim rather than reconstructed.
      // Sending only `doc_id` and `variables` answers some queries and returns the SPA shell
      // for others; the difference is the extra form fields (`fb_dtsg`, `jazoest`) and headers
      // the real request carried. Capturing them turns "work out what the server expects" into
      // "send back what it just accepted". The four the extension manages itself — cookie,
      // content-length, csrftoken and the rotating claim — are dropped so the live values win.
      headers: Object.fromEntries(
        Object.entries(request.headers()).filter(
          ([name]) =>
            !['cookie', 'content-length', 'host', 'x-csrftoken', 'x-ig-www-claim', 'accept-encoding'].includes(name),
        ),
      ),
      raw: (request.postData() ?? '').slice(0, 8000),
      where: null,
    })
  })

  const visit = async (label, url) => {
    const before = seen.size
    say(`   · ${label}`)
    await spy.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await sleep(5_000)
    for (const entry of seen.values()) if (!entry.where) entry.where = label
    if (seen.size === before) say(`       (no GraphQL on this screen)`)
  }

  // Search is modal rather than a route, so it has to be provoked by opening the drawer and
  // typing — this is also the only screen that reveals the search `doc_id` at all. The nav
  // item has to be clicked first; the input does not exist until the drawer is open, which is
  // why looking for the input on its own finds nothing.
  const search = async label => {
    say(`   · ${label}`)
    await spy.goto(IG, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await sleep(5_000)

    for (const selector of [
      'nav a[href*="/explore/search/"]',
      'a[role="link"] svg[aria-label="Search"]',
      'svg[aria-label="Search"]',
    ]) {
      const item = await spy.$(selector)
      if (!item) continue
      await item.click({ force: true }).catch(() => {})
      await sleep(2_000)
      break
    }

    let typed = false
    // Every input on the page, logged first: one capture run then shows whether the drawer
    // opened at all and what the search field is actually called, instead of silently
    // finding nothing and reporting "no doc_id captured" with no reason attached.
    const inputs = await spy.$$eval('input', nodes =>
      nodes.map(node => ({ placeholder: node.placeholder, aria: node.getAttribute('aria-label'), name: node.name })),
    )
    say(`       inputs present: ${JSON.stringify(inputs)}`)

    for (const selector of ['input[placeholder*="Search"]', 'input[aria-label*="Search"]', 'input[name="searchBox"]']) {
      const box = await spy.$(selector)
      if (!box) continue
      await box.click().catch(() => {})
      await box.type('nike', { delay: 150 }).catch(() => {})
      await sleep(8_000)
      typed = true
      break
    }

    // Belt and braces: whatever the page requested while the drawer was open, read it back
    // from the performance timeline as well. The request listener only sees requests made
    // while it is attached; this sees everything the document fetched, including anything
    // fired before the listener registered.
    const searched = await spy
      .evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map(entry => entry.name)
          .filter(name => /search|graphql/i.test(name)),
      )
      .catch(() => [])
    for (const name of searched) say(`       [performance] ${name}`)

    for (const entry of seen.values()) if (!entry.where) entry.where = label
    if (!typed) say('       could not find the search input — no search doc_id captured')
  }

  await visit('direct inbox', `${IG}direct/inbox/`)
  await visit('profile', `${IG}instagram/`)
  await visit('saved', `${IG}instagram/saved/`)
  await search('search')
  await spy.close().catch(() => {})

  const list = [...seen.values()]
  const outPath = fileURLToPath(new URL('./captured-graphql.json', import.meta.url))

  /**
   * Merge with what is on disk instead of overwriting, and write nothing when this run saw
   * nothing. Both halves are load-bearing:
   *
   * An empty write is the nasty one. Instagram can answer a navigated screen with its HTML
   * shell instead of firing GraphQL, `list` comes back empty — and writing `[]` then makes the
   * file *exist*, so first-launch auto-capture (which keys off the file's absence) never fires
   * again and search stays broken with no signal anywhere. Refusing to write leaves the
   * condition unsatisfied, so the next launch simply retries.
   *
   * A partial write is the quiet one: tokens rotate, so a force-run must be able to refresh
   * every doc_id it observes — but replacing the file wholesale would delete the entries whose
   * screens weren't walked this time, taking those tools down with them. The union keys on the
   * same `(doc_id, body)` pair the run itself dedupes on, newest observation winning, so a run
   * can only ever add or refresh.
   */
  const keyOf = entry => `${entry.doc_id}|${entry.raw ?? JSON.stringify(entry.variables)}`
  let mergedCount = 0

  if (!list.length) {
    say('')
    say('   nothing captured — no GraphQL fired while driving')
    say(
      existsSync(outPath)
        ? '   the existing capture was left untouched'
        : '   no capture on disk — first-launch auto-capture retries on the next run',
    )
  } else {
    const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : []
    const keyed = new Map()
    // Newest run first, and stamped. `graphqlCaptured` reads the first entry for a doc_id that
    // carries real variables, so file order decides whose tokens get replayed after a refresh —
    // appending fresh captures behind the old ones would leave every refreshed doc_id still
    // selecting the stale copy ahead of it. The timestamp makes that preference survive any
    // future reordering, because entries with no stamp are simply treated as the oldest.
    for (const entry of list) keyed.set(keyOf(entry), { ...entry, capturedAt: Date.now() })
    for (const entry of existing) keyed.set(keyOf(entry), entry)
    const merged = [...keyed.values()]
    writeFileSync(outPath, JSON.stringify(merged, null, 2))
    mergedCount = merged.length

    say('')
    say('captured doc_ids:')
    for (const entry of list) say(`   ${entry.doc_id.padEnd(26)} ${entry.where}`)
    say(`written to ${outPath} (${mergedCount} entries after merging with what was there)`)
  }
}

say('')
say('The browser is open and will stay open. Sign into instagram.com in it now.')
say('Your session persists in .ext-profile/, so you only do this once.')
say('')
say('This window can be closed whenever you like — Chrome outlives it and keeps its own')
say('connection to the driver, so a closed terminal no longer takes the session with it.')
say('To end the session, close the browser window itself.')
say('')

// Stay alive, but only as a courtesy: Chrome no longer depends on this process, so an interrupt
// here detaches instead of closing the window. Closing on exit was the right thing while
// Playwright owned the browser as a child — otherwise it would be left holding a profile lock —
// and is exactly wrong now, where the window outliving this terminal is the whole point.
// Ending the session is closing the browser window itself.
context.on('close', () => process.exit(0))

process.on('SIGINT', () => {
  say('\ndetached — the browser stays open. Close its window to end the session.')
  process.exit(0)
})
process.on('SIGTERM', () => process.exit(0))

await new Promise(() => {})
