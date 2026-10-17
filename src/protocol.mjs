/**
 * The @inssist/mcp bridge wire protocol, mirrored from the upstream MIT source
 * (vendor/inssist-mcp/src/protocol.ts + constants.ts).
 *
 * We impersonate the Chrome extension: the server only checks that `Origin` starts with
 * `chrome-extension://`, which a Node WebSocket client can set freely. That single check is
 * the entire gate between "any local process" and "the extension" — upstream says so in
 * constants.ts, and pairing is explicitly documented as routing, not trust.
 */

export const PROTOCOL_VERSION = 1
/** Our port, deliberately NOT upstream's 48231. */
export const DEFAULT_PORT = 48232
export const HOST = '127.0.0.1'

/** Upstream refuses any origin that is not an extension. */
export const FAKE_ORIGIN = 'chrome-extension://bcocdbombenodlegijagbhdjbifpiijp'

/** Kept under upstream's `instanceId` expectations: a stable per-profile id. */
export const INSTANCE_ID = 'ig-mcp-free-profile-1'

export const AGENT = { version: 'ig-mcp-free/0.1.0', build: '0.1.0' }

/** Upstream's pairing token floor: `token.length < 16` is rejected as malformed. */
export const makeToken = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')

/** One knob for both halves. Never silently falls back to upstream's 48231. */
export const port = () => Number(process.env.IG_MCP_PORT ?? process.env.INSSIST_MCP_PORT ?? DEFAULT_PORT)

/** One incoming frame, typed loosely; we only branch on `t`. */
export const parse = raw => {
  try {
    const frame = JSON.parse(String(raw))
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') return null
    return frame
  } catch {
    return null
  }
}
