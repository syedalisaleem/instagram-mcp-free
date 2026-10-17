/**
 * End-to-end check: spawn our MCP server, handshake, list tools, call account_info.
 * Verifies three things that must all hold:
 *   1. 60 tools are advertised
 *   2. no "(Requires INSSIST PRO.)" upsell text survives
 *   3. the driver answers a real tool call
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] })

let buffer = ''
const pending = new Map()
let nextId = 1

child.stdout.on('data', chunk => {
  buffer += String(chunk)
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})

const rpc = (method, params = {}) => {
  const id = nextId++
  return new Promise(resolve => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve({ error: { message: `timeout on ${method}` } })
      }
    }, 180000)
  })
}

const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

/**
 * The server serves the *bundled* snapshot until a browser pairs, so listing immediately
 * would show upstream's 48 PRO upsells and prove nothing. Wait for the driver's live manifest
 * (pro:false on all 60) to replace it — upstream signals that with tools/list_changed.
 */
const waitForPairing = async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const probe = await rpc('tools/list')
    const list = probe.result?.tools ?? []
    const upsells = list.filter(t => /Requires INSSIST PRO/.test(t.description ?? '')).length
    if (upsells === 0 && list.length) return { list, attempts: attempt + 1 }
    await sleep(500)
  }
  const final = await rpc('tools/list')
  return { list: final.result?.tools ?? [], attempts: 'gave up' }
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ig-mcp-free-smoke', version: '0.1.0' },
  })
  console.log('server:', JSON.stringify(init.result?.serverInfo))
  notify('notifications/initialized')

  await sleep(400)

  const { list, attempts } = await waitForPairing()
  const tools = list
  console.log(`tools/list -> ${tools.length} tools (paired after ${attempts} probes)`)

  const upsells = tools.filter(t => /Requires INSSIST PRO/.test(t.description ?? ''))
  console.log(`tools carrying a PRO upsell: ${upsells.length}`)

  const gateAnnotations = tools.filter(t => t.annotations?.destructiveHint === true)
  console.log(`marked destructive (so a harness will confirm them): ${gateAnnotations.length}`)

  const call = await rpc('tools/call', { name: 'account_info', arguments: {} })
  const text = (call.result?.content ?? []).map(c => c.text).join('\n')
  console.log(`\naccount_info -> isError=${call.result?.isError ?? false}`)
  console.log(text.slice(0, 900))

  const draft = await rpc('tools/call', { name: 'draft_create', arguments: { caption: 'smoke test', type: 'post' } })
  console.log(`\ndraft_create -> isError=${draft.result?.isError ?? false}`)
  console.log(((draft.result?.content ?? []).map(c => c.text).join('\n') || '').slice(0, 300))

  const notImpl = await rpc('tools/call', { name: 'dm_send', arguments: {} })
  console.log(`\ndm_send (unimplemented) -> isError=${notImpl.result?.isError ?? false}`)
  console.log(((notImpl.result?.content ?? []).map(c => c.text).join('\n') || '').slice(0, 300))

  // A real Instagram read, against the signed-in session. This used to assert a login-wall
  // failure back when the smoke test ran against a never-logged-in Playwright profile; the
  // driver now pairs with the real browser, so the meaningful check is the opposite one — that
  // search returns users rather than Instagram's HTML error shell.
  const search = await rpc('tools/call', { name: 'ig_search', arguments: { query: 'nike' } })
  console.log(`\nig_search -> isError=${search.result?.isError ?? false}`)
  console.log(((search.result?.content ?? []).map(c => c.text).join('\n') || '').slice(0, 300))

  /**
   * Exercise the read tools against the signed-in session. These are deliberately reads only:
   * a tool that fires a write with empty arguments would be answering a smoke test by
   * changing something real on the account.
   *
   * The list is intentionally broad now. Several of these were implemented late, and the tools
   * that answer without touching Instagram at all (`downloads_status`, `growth_status`,
   * `insights_report`) are included precisely because they must keep answering when the
   * session is idle — a tool that only works while something else is running is not finished.
   */
  const exercises = [
    ['ig_fetch_posts', { username: 'instagram', limit: 3 }],
    ['ig_search', { query: 'nike', type: 'all' }],
    ['comments_list', { post: '4008624687011885064_22890518115' }],
    ['notifications_list', { limit: 3 }],
    ['ig_fetch_stories', { username: 'instagram' }],
    ['ig_fetch_saved', {}],
    ['music_search', { query: 'ambient' }],
    ['location_search', { query: 'london' }],
    ['draft_list', {}],
    ['dm_list', {}],
    ['dm_requests', {}],
    ['downloads_status', {}],
    ['insights_report', { username: 'instagram' }],
    ['unfollowers_report', {}],
    ['growth_status', {}],
    ['events_check', {}],
    ['account_info', {}],
  ]

  console.log('\n--- read tools against the live session ---')
  for (const [name, args] of exercises) {
    const started = Date.now()
    const response = await rpc('tools/call', { name, arguments: args })
    const text = (response.result?.content ?? []).map(c => c.text).join('\n') || ''
    const errored = response.result?.isError ?? false
    const headline = errored
      ? `ERROR ${text.replace(/\s+/g, ' ').slice(0, 110)}`
      : text.replace(/\s+/g, ' ').slice(0, 110)
    console.log(`${errored ? 'FAIL' : 'ok  '} ${name.padEnd(18)} ${String(Date.now() - started).padStart(6)}ms  ${headline}`)
  }
} catch (error) {
  console.error('SMOKE FAILED:', error?.message ?? error)
  child.kill()
  process.exit(1)
}

child.kill()
process.exit(0)
