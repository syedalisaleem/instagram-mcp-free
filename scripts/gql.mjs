/**
 * Calls `/graphql/query` through the driver's live session, so a captured `doc_id` can be
 * tried immediately instead of being wired into `ig.mjs` first and debugged there.
 *
 * A `doc_id` is the whole contract now: Instagram moved search, direct messages, saved posts
 * and profile reads behind GraphQL, where each feature is identified by one of these numbers.
 * They are published nowhere and rotate without notice, so the working procedure is always the
 * same — capture one with `IG_MCP_GQL=1 npm run browser`, confirm it answers here, then
 * wire it into `ig.mjs`.
 *
 * Usage:
 *   npm run gql -- 28834890909485062 '{"username":"instagram","data":{"count":12}}'
 *   npm run gql -- --from-captured 'profile'   # reuse the variables captured for that screen
 *
 * The `__relay_internal__pv__…` flags in captured variables are React Relay feature probes. The
 * server does not require a specific value for them, but an empty object is refused — so the
 * defaults below are sent when the caller gives none.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CONTROL = process.env.IG_MCP_CONTROL ?? 'http://127.0.0.1:48234'
const GRAPHQL = 'https://www.instagram.com/graphql/query'

const RELAY_DEFAULTS = {
  __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
  __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false,
  __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
  __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
  __relay_internal__pv__PolarisAdDebugToolEnabledrelayprovider: false,
  __relay_internal__pv__PolarisSuggestedUserFeedUnitCardsEnabledrelayprovider: false,
}

const argv = process.argv.slice(2)
const after = flag => argv[argv.indexOf(flag) + 1]

const capturedPath = fileURLToPath(new URL('./captured-graphql.json', import.meta.url))
const captured = () => JSON.parse(readFileSync(capturedPath, 'utf8'))

let docId = null
let variables = {}
// Both default to the Relay read contract; a capture from the search drawer overrides them
// with `/api/graphql` and a form body, which are a different pair entirely.
let endpoint = GRAPHQL
let encoded = 'json'
// When the capture stored the page's own body and headers, those are replayed as-is and this
// wins over anything reconstructed below.
let rawBody = null
let capturedHeaders = null

if (argv.includes('--id')) {
  // The path back out of a capture run: the log prints doc_ids with their tag, and a single
  // tag such as "search" covers a dozen entries (null-state panels, filter toggles, the actual
  // query), so the first match for a tag is usually the wrong query. Selecting by id and
  // preferring the entry that carried real variables picks the one that was answering the user.
  const wanted = after('--id')
  const hits = captured().filter(entry => String(entry.doc_id) === String(wanted))
  if (!hits.length) {
    console.error(`No captured request with doc_id ${wanted}. Re-run \`IG_MCP_GQL=1 npm run browser\`.`)
    process.exit(1)
  }
  const hit = hits.find(entry => entry.variables && entry.variables !== '{}') ?? hits[0]
  docId = hit.doc_id
  variables = JSON.parse(hit.variables ?? '{}')
  if (hit.path) endpoint = hit.path
  if (hit.encoded) encoded = hit.encoded
  if (hit.raw) rawBody = hit.raw
  if (hit.headers) capturedHeaders = hit.headers
} else if (argv.includes('--from-captured')) {
  const where = after('--from-captured')
  const hit = captured().find(entry => entry.where === where)
  if (!hit) {
    console.error(`No captured request tagged "${where}". Re-run \`IG_MCP_GQL=1 npm run browser\`.`)
    process.exit(1)
  }
  docId = hit.doc_id
  variables = JSON.parse(hit.variables ?? '{}')
  if (hit.path) endpoint = hit.path
  if (hit.encoded) encoded = hit.encoded
  if (hit.raw) rawBody = hit.raw
  if (hit.headers) capturedHeaders = hit.headers
} else {
  docId = argv[0]
  variables = argv[1] ? JSON.parse(argv[1]) : {}
}

// Merged over whatever the capture carried, so a captured search query can be re-run with a
// different search term without hand-editing the variables document.
if (argv.includes('--vars')) variables = { ...variables, ...JSON.parse(after('--vars')) }

// The two entry points are not interchangeable for every query, and the capture says which
// one the page used. Forcing the other is a cheap, one-line experiment rather than a
// re-capture, which is how it was decided that search needs `/api/graphql`.
if (argv.includes('--endpoint')) endpoint = after('--endpoint')

if (!docId) {
  console.error('Give a doc_id, --id <doc_id>, or --from-captured <where>. See the header of this file.')
  process.exit(1)
}

const variablesText = JSON.stringify({ ...RELAY_DEFAULTS, ...variables })

/**
 * Builds the request body: the page's own, when the capture stored it, otherwise a minimal one.
 *
 * Replaying the captured body means `fb_dtsg`, `jazoest` and the other fields Instagram put in
 * the original request travel back unchanged — only `doc_id` and `variables` are swapped, which
 * is exactly the pair the caller is asking to differ on. A reconstructed body works for the
 * Relay reads and silently returns HTML for the search query, and that difference has no error
 * message attached to explain it.
 */
let payload
if (rawBody && encoded === 'form') {
  const params = new URLSearchParams(rawBody)
  params.set('doc_id', docId)
  params.set('variables', variablesText)
  if (!params.has('server_timestamps')) params.set('server_timestamps', 'true')
  payload = params.toString()
} else if (encoded === 'form') {
  payload = new URLSearchParams({
    doc_id: docId,
    variables: variablesText,
    server_timestamps: 'true',
  }).toString()
} else {
  payload = JSON.stringify({
    doc_id: docId,
    variables: variablesText,
    server_timestamps: 'true',
  })
}
const contentType = encoded === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'
// Captured headers first, so `content-type` from the capture cannot disagree with the body that
// is actually being sent.
const requestHeaders = { ...(capturedHeaders ?? {}), 'content-type': contentType }

const status = await fetch(`${CONTROL}/status`, { signal: AbortSignal.timeout(15_000) })
  .then(r => r.json())
  .catch(() => null)

if (!status?.bridge?.connected) {
  console.error('No extension attached to the driver — start `npm run driver`, then `npm run browser`.')
  process.exit(1)
}

const url = new URL(`${CONTROL}/probe`)
url.searchParams.set('path', endpoint)
url.searchParams.set('method', 'POST')
url.searchParams.set('headers', JSON.stringify(requestHeaders))
url.searchParams.set('body', payload)
// The default probe cap truncates GraphQL bodies mid-JSON; ask for the whole thing.
url.searchParams.set('full', '1')

const response = await fetch(url, { signal: AbortSignal.timeout(90_000) }).then(r => r.json())

console.log(`doc_id ${docId}  →  HTTP ${response.status} (${response.transport})`)

/**
 * Print the response's shape rather than its bytes. GraphQL answers are dominated by CDN URLs
 * and DASH manifests that bury the two things worth reading — which query answered, and what
 * fields it returned — so a raw dump is unusable for this.
 */
const outline = (value, depth = 0, maxDepth = 3) => {
  if (depth >= maxDepth) return
  const pad = '  '.repeat(depth + 1)

  if (Array.isArray(value)) {
    console.log(`${pad}[] (${value.length} items)`)
    if (value.length) outline(value[0], depth + 1, maxDepth)
    return
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') {
        console.log(`${pad}${key}:`)
        outline(child, depth + 1, maxDepth)
      } else {
        const shown = typeof child === 'string' ? (child.length > 40 ? `${child.slice(0, 40)}…` : child) : child
        console.log(`${pad}${key} = ${JSON.stringify(shown)}`)
      }
    }
    return
  }
}

let parsed = null
try {
  parsed = JSON.parse(response.body)
} catch {
  /* not JSON — printed as text below */
}

if (parsed && !argv.includes('--full')) {
  outline(parsed)
  console.log('\n(use --full for the complete response)')
} else {
  console.log(response.body)
}
