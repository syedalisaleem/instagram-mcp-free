/**
 * Loads extension/ unpacked into a throwaway Chromium profile and proves it auto-pairs with
 * the running driver.
 *
 * Two independent signals are checked, because either alone can lie:
 *   1. the offscreen document wrote `connected:true` to chrome.storage (the socket is up), and
 *   2. the instagram.com content script answers `ping` (the execution path to the page is up).
 *
 * Requires `node src/driver.mjs` to be running first.
 *
 * Usage: node scripts/ext-test.mjs
 */

import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const EXT_DIR = fileURLToPath(new URL('../extension', import.meta.url))
const SMOKE = fileURLToPath(new URL('./smoke.mjs', import.meta.url))
const PROFILE = process.env.EXT_PROFILE ?? fileURLToPath(new URL('../.ext-profile', import.meta.url))
const IG = 'https://www.instagram.com/'

const PAIR_TIMEOUT_MS = 40_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const fail = message => {
  console.error(`\nFAIL: ${message}`)
  process.exit(1)
}

console.log('1. loading unpacked extension from', EXT_DIR)
mkdirSync(PROFILE, { recursive: true })

let context
try {
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  })
} catch (error) {
  fail(`could not launch Chromium with the extension: ${error.message}`)
}

context.on('close', () => {
  console.error('\n(the browser was closed before the test finished)')
})

// The extension's service worker — our window into its storage and messaging.
console.log('2. waiting for the extension service worker')
let worker = context.serviceWorkers()[0]
if (!worker) {
  worker = await context
    .waitForEvent('serviceworker', { timeout: 15_000 })
    .catch(() => null)
}
if (!worker) {
  await context.close()
  fail(
    'no service worker appeared — the manifest was probably rejected. ' +
      'Check chrome://extensions for an "Errors" link.',
  )
}
console.log(`   worker: ${worker.url()}`)
const allWorkers = context.serviceWorkers().map(w => w.url())
if (allWorkers.length > 1) console.log(`   ALL workers: ${allWorkers.join(', ')}`)

// Open instagram.com so the content script has somewhere to live.
console.log('3. opening instagram.com')
const page = context.pages()[0] ?? (await context.newPage())
await page.goto(IG, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})

// --- signal 1: the offscreen socket reports itself connected --------------------
console.log('4. polling chrome.storage for an established socket')
const deadline = Date.now() + PAIR_TIMEOUT_MS
let state = null
while (Date.now() < deadline) {
  state = await worker.evaluate(() => chrome.storage.local.get('driver')).catch(() => null)
  if (state?.driver?.connected) break
  await sleep(500)
}

if (!state?.driver?.connected) {
  // Diagnose rather than guess: probe storage with explicit keys (and capture the error if
  // even that fails), so a failed probe can't masquerade as an empty extension.
  const probe = await worker.evaluate(async () => {
    const out = {}

    try {
      const manifest = chrome.runtime.getManifest()
      out.extension = `${manifest.name} v${manifest.version} (${chrome.runtime.id})`
    } catch (error) {
      out.manifestError = String(error?.message ?? error)
    }

    out.swBooted = globalThis.__igSwBooted ?? null
    out.swError = globalThis.__igSwError ?? null

    try {
      await chrome.storage.local.set({ probeWrite: Date.now() })
      out.storage = await chrome.storage.local.get([
        'probeWrite',
        'swBoot',
        'offscreenBoot',
        'driver',
        'diag',
      ])
    } catch (error) {
      out.storageError = String(error?.message ?? error)
    }

    try {
      out.offscreenLive = await chrome.offscreen.hasDocument()
      out.offscreenContexts = (await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      })).map(c => ({ url: c.url, state: c.state }))
    } catch (error) {
      out.offscreenError = String(error?.message ?? error)
    }

    try {
      out.offscreenStatus = await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'status' })
    } catch (error) {
      out.offscreenStatus = `ERR: ${error?.message ?? error}`
    }

    return out
  }).catch(error => ({ probeError: String(error?.message ?? error) }))

  await context.close()
  fail(
    `extension never reported connected within ${PAIR_TIMEOUT_MS / 1000}s.\n` +
      `  driver state   : ${JSON.stringify(state?.driver ?? null)}\n` +
      `  probe          : ${JSON.stringify(probe ?? null)}\n` +
      "  Is `node src/driver.mjs` running, and is ws://127.0.0.1:48233/ reachable?",
  )
}
console.log(`   connected since ${new Date(state.driver.since).toISOString()}`)
console.log(`   driver url: ${state.driver.url}`)

// --- signal 2: the content script actually answers ------------------------------
console.log('5. pinging the instagram.com content script')

const pingContentScript = async () => {
  // Reach it the same way the service worker does, from the worker context.
  return await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.instagram.com/*' })
    if (!tab?.id) return { ok: false, error: 'no instagram tab' }
    try {
      return await chrome.tabs.sendMessage(tab.id, { kind: 'ping' })
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })
}

let content = null
const pingDeadline = Date.now() + 20_000
while (Date.now() < pingDeadline) {
  content = await pingContentScript().catch(() => null)
  if (content?.ok) break
  await sleep(500)
}

if (!content?.ok) {
  await context.close()
  fail(`content script never became ready: ${JSON.stringify(content)}`)
}
console.log('   content script ready')

// --- proof the whole chain moves data -------------------------------------------
console.log('6. round-tripping a real request through the extension')
const roundTrip = await worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://www.instagram.com/*' })
  if (!tab?.id) return { transportError: 'no instagram tab' }
  try {
    return await chrome.tabs.sendMessage(tab.id, {
      kind: 'fetch',
      url: 'https://www.instagram.com/api/v1/accounts/current_user/?edit=true',
      method: 'GET',
    })
  } catch (error) {
    return { transportError: String(error?.message ?? error) }
  }
})

if (roundTrip?.transportError) {
  await context.close()
  fail(`round trip failed: ${roundTrip.transportError}`)
}

const loggedIn = Boolean(roundTrip?.json?.user?.username)
console.log(`   HTTP ${roundTrip.status} — ${loggedIn ? `signed in as @${roundTrip.json.user.username}` : 'no session cookie (log in once in this window)'}`)

// --- 7: prove the *tool* path uses this browser, not the Playwright fallback -------------
// Round-tripping through the extension by hand proves the socket; it does not prove the driver
// picks this transport when a tool is called. `account_info` reports `transport` precisely so
// that distinction is checkable rather than assumed.
console.log('7. running the MCP suite with the browser still open')

const smokeOut = await new Promise(resolve => {
  const child = spawn(process.execPath, [SMOKE], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', chunk => {
    out += String(chunk)
  })
  child.on('close', code => resolve({ out, code }))
})

console.log(smokeOut.out.trimEnd().replace(/^/gm, '   | '))

const checks = [
  ['60 tools advertised', /tools\/list -> 60 tools/.test(smokeOut.out)],
  ['no PRO upsells', /tools carrying a PRO upsell: 0/.test(smokeOut.out)],
  ['account_info used the extension transport', /"transport"\s*:\s*"extension/.test(smokeOut.out)],
  ['driver saw the extension as connected', /"connected"\s*:\s*true/.test(smokeOut.out)],
  [
    'relay answered a real request (no dead-worker response)',
    !/no response from the service worker|returned nothing|Could not establish connection/.test(smokeOut.out),
  ],
  [
    // Without igOk's HTML detection, a logged-out 404 gets shipped to the agent verbatim as
    // the "error" — dozens of lines of Instagram's page markup instead of a sentence.
    'errors are a sentence, not raw Instagram HTML',
    !/<!DOCTYPE html>|<html/i.test(smokeOut.out),
  ],
  [
    // A bare `loggedIn:false` with no note means a failure was silently read as "not logged
    // in" — the exact misdiagnosis this field exists to prevent.
    'account_info explains a false loggedIn instead of just asserting it',
    !/"loggedIn":\s*false/.test(smokeOut.out) || /"note":\s*"/.test(smokeOut.out),
  ],
  ['smoke suite exited cleanly', smokeOut.code === 0],
]
const broken = checks.filter(([, ok]) => !ok)

console.log('\nPASS')
console.log('  socket paired    : yes')
console.log('  content script   : ready')
console.log('  request relay    : yes')
console.log('  instagram login  :', loggedIn ? `yes (@${roundTrip.json.user.username})` : 'no (expected until you sign in)')
for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`)
console.log('\nLeave this browser signed in — the session persists in .ext-profile/.')

await context.close()
process.exit(broken.length ? 1 : 0)
