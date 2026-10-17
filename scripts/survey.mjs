/**
 * Endpoint survey — probes a list of instagram.com paths through the driver's *live* session
 * and prints one row per path: status, latency, and the shape of what came back.
 *
 * This exists because Instagram retires `/api/v1/…` paths regularly and replaces them with
 * GraphQL, and the failure mode is uniformly a 404/429 rendered as an HTML app shell. Status
 * code alone cannot separate "wrong path" from "rate limited" from "not signed in", so the
 * survey reports all three signals at once and lets you scan the table.
 *
 * It goes through the driver (127.0.0.1:48234) rather than fetching directly, because a probe
 * launched in its own process finds no extension bridge, silently falls back to the Playwright
 * profile that has never been signed into, and returns a plausible-looking wrong answer.
 *
 * Usage:
 *   npm run survey                              # the default candidate list
 *   npm run survey -- /api/v1/foo/ /api/v1/bar/ # your own paths
 *   npm run survey -- --method POST /api/v1/x/  # non-GET
 */

const CONTROL = process.env.IG_MCP_CONTROL ?? 'http://127.0.0.1:48234'
const IG = 'https://www.instagram.com/'

const call = async (path, params = {}) => {
  const url = new URL(path, CONTROL)
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined) url.searchParams.set(key, value)
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  return await response.json()
}

/**
 * Paths worth checking. Instagram has been migrating these to `/graphql/query` with a
 * per-feature `doc_id`, so a 404 here is information — it means capture the real request
 * instead of trying another guess at the path.
 */
const DEFAULT_PATHS = [
  // identity & profile
  '/api/v1/accounts/edit/web_form_data/',
  '/api/v1/users/web_profile_info/?username=instagram',
  '/api/v1/users/usernameinfo/?username=instagram',
  '/api/v1/friendships/22890518115/',
  // comments
  '/api/v1/media/4008624687011885064_22890518115/comments/',
  '/api/v1/media/4008624687011885064_22890518115/comments/?can_support_threading=true',
  // feed & saved
  '/api/v1/feed/timeline/',
  '/api/v1/feed/saved/',
  '/api/v1/saved/feed/',
  '/api/v1/feed/saved_posts/?max_id=',
  // follows
  '/api/v1/friendships/22890518115/followers/?max_id=',
  '/api/v1/friendships/22890518115/following/?max_id=',
  '/api/v1/friendships/22890518115/requests/',
  '/api/v1/friendships/show_many/22890518115,4008624687011885064/',
  // direct messages
  '/api/v1/direct_v2/inbox/',
  '/api/v1/direct_v2/web/inbox/',
  '/api/v1/direct_v2/threads/',
  // activity
  '/api/v1/news/inbox/',
  '/api/v1/notifications/app_badge/',
  // stories
  '/api/v1/feed/user/22890518115/story/',
  '/api/v1/media/4008624687011885064_22890518115/story_viewers/',
  // search (retired → graphql)
  '/api/v1/web/search/topsearch/?context=blended&query=nike',
  // graphql baseline — proves whether the transport handles POST at all
  '/graphql/query',
]

const argv = process.argv.slice(2)
const method = argv.includes('--method') ? argv[argv.indexOf('--method') + 1] ?? 'GET' : 'GET'
const paths = argv.filter((arg, i) => arg !== '--method' && argv[i - 1] !== '--method')
const list = paths.length ? paths : DEFAULT_PATHS

const status = await call('/status').catch(() => null)
if (!status?.bridge?.connected) {
  console.error('No extension attached to the driver — results would describe a session you')
  console.error('never signed into. Run `npm run driver` and `npm run browser`, then retry.')
  process.exit(1)
}
console.log(`transport: ${status.transport}   (${list.length} path(s), method ${method})\n`)

const rows = []
for (const path of list) {
  const started = Date.now()
  let out
  try {
    out = await call('/probe', { path: path.startsWith('http') ? path : IG + path.replace(/^\//, ''), method })
  } catch (error) {
    rows.push({ path, status: 'ERR', ms: Date.now() - started, shape: '-', preview: String(error?.message ?? error).slice(0, 60) })
    continue
  }

  const body = String(out.body ?? '')
  const shape = /^\s*[{[]/.test(body) ? 'JSON' : /^\s*</.test(body) ? 'HTML' : body ? 'text' : 'empty'
  const message = (() => {
    try {
      return JSON.parse(body)?.message
    } catch {
      return null
    }
  })()

  rows.push({
    path,
    status: out.status,
    ms: Date.now() - started,
    shape,
    preview: message ?? (shape === 'JSON' ? body.slice(0, 70) : body.replace(/\s+/g, ' ').slice(0, 70)),
  })
}

const width = Math.max(...rows.map(r => r.path.length))
for (const row of rows) {
  const mark = row.status === 200 && row.shape === 'JSON' ? '**' : '  '
  console.log(
    `${mark}${String(row.status).padStart(4)} ${row.shape.padEnd(4)} ${String(row.ms).padStart(6)}ms  ${row.path.padEnd(width)}  ${row.preview}`,
  )
}

const good = rows.filter(r => r.status === 200 && r.shape === 'JSON')
console.log(`\n${good.length}/${rows.length} answered with real JSON`)
if (good.length) console.log('usable:\n' + good.map(r => '  ' + r.path).join('\n'))
