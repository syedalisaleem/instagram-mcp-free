/**
 * A small loopback control endpoint on the driver.
 *
 * Diagnosing Instagram from *outside* the driver is otherwise impossible: the extension
 * connection belongs to the driver's process, so any other tool silently falls back to the
 * Playwright browser and reports on a session you never signed into. That failure mode is
 * worse than no diagnostic at all, because the answer looks plausible.
 *
 * So the driver exposes the two things a human actually needs when a read starts failing:
 * whether its transport is live, and a raw probe against the *same* session tools use.
 *
 * Bound to 127.0.0.1, GET only, and restricted to instagram.com paths — this is a debugging
 * hatch on the machine that already holds the browser session, not a network service.
 */

import { createServer } from 'node:http'
import { bridge } from './extension.mjs'
import { probe } from './ig.mjs'
import { acquireSession, describeTransport, IG_ORIGIN } from './transport.mjs'
import { contract } from './manifest.mjs'

const DEFAULT_CONTROL_PORT = 48234

const log = (...args) => console.error('[control]', ...args)

/** Only ever reaches instagram.com, whether given as a path or a full URL. */
const normalisePath = raw => {
  if (!raw) return null
  const value = String(raw)
  if (value.startsWith(IG_ORIGIN)) return value
  if (value.startsWith('/')) return `${IG_ORIGIN.replace(/\/$/, '')}${value}`
  return null
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

const handle = async (url, res) => {
  if (url.pathname === '/status') {
    json(res, 200, {
      transport: describeTransport(),
      bridge: bridge.info(),
      tools: contract.length,
      driverPort: 48233,
    })
    return
  }

  if (url.pathname === '/probe') {
    const path = normalisePath(url.searchParams.get('path'))
    if (!path) {
      json(res, 400, { error: 'give ?path=/api/… (a path, or a full https://www.instagram.com/ URL)' })
      return
    }

    const method = (url.searchParams.get('method') ?? 'GET').toUpperCase()
    if (!['GET', 'POST', 'DELETE'].includes(method)) {
      json(res, 400, { error: `method must be GET, POST or DELETE (got ${method})` })
      return
    }

    // Optional header overrides, so competing `x-ig-app-id` values can be compared directly
    // instead of being edited into the source and restarted.
    let headers = {}
    const rawHeaders = url.searchParams.get('headers')
    if (rawHeaders) {
      try {
        headers = JSON.parse(rawHeaders)
      } catch {
        json(res, 400, { error: 'headers must be a JSON object' })
        return
      }
    }

    // A request body, for endpoints that take JSON. GraphQL is the driving case: it rejects a
    // form-encoded body with a bare 400, and POST is otherwise untestable through here.
    let body = null
    const rawBody = url.searchParams.get('body')
    if (rawBody) {
      try {
        body = JSON.stringify(JSON.parse(rawBody))
      } catch {
        body = rawBody
      }
    }

    // `full=1` lifts the response cap. Needed for GraphQL, where a truncated body is not just
    // incomplete but unparseable.
    const full = url.searchParams.get('full') === '1'

    const session = await acquireSession()
    const result = await probe(session, path, method, headers, body, full)
    // Echoed so the flag's journey is observable end to end. When a full body still arrives
    // truncated, this tells you whether the break is before the extension or inside it.
    json(res, 200, { transport: session.kind, path, method, requestedFull: full, ...result })
    return
  }

  json(res, 404, { error: 'try /status or /probe?path=…' })
}

export const startControl = ({ port = Number(process.env.IG_MCP_CONTROL_PORT ?? DEFAULT_CONTROL_PORT) } = {}) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    handle(url, res).catch(error => {
      try {
        json(res, 500, { error: String(error?.message ?? error) })
      } catch {
        /* headers already sent */
      }
    })
  })

  server.on('listening', () => log(`diagnostics on http://127.0.0.1:${port}/status`))
  server.on('error', error => log(`control endpoint error: ${error.message}`))

  server.listen(port, '127.0.0.1')
  return server
}
