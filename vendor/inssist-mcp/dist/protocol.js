/**
 * The bridge wire protocol: newline-free JSON objects over one WebSocket, every frame
 * tagged with `t`. Deliberately transport agnostic (no WS specifics leak into the shapes)
 * so native messaging can replace the socket without touching either side's logic.
 *
 * Handshake, extension dials the server:
 *
 *   ext -> hello         instanceId, agent build
 *   srv -> server-hello  serverId, version, pid, whether it already holds a token
 *   ext -> auth | pair
 *   srv -> ready | unauthorized
 *   ext -> manifest      live tool list, replaces the bundled snapshot
 *
 * Steady state:
 *
 *   srv -> call          id, tool, params
 *   ext -> result|error  id, payload
 *   srv -> ping          ext -> pong
 *
 * Peers (a second server process on the same machine) speak a small second dialect on the
 * `/peer` path: `peer-hello` in, `peer-state` out on every change, `peer-call` in and
 * `peer-result` / `peer-error` out per call. The hub answers a peer call exactly as it would
 * its own, so every harness on the machine shares one set of browsers.
 *
 * Pairing is automatic: the extension's AI Agents toggle is the user's consent, and on a
 * server's first hello the extension mints a token that both sides persist. The token
 * routes reconnects to the right browser profile; it is not a trust gate. The server
 * records whatever well-formed token it is sent, so any local process able to bind the
 * port can pair itself — accepted under the threat model's local-malware stance (a rogue
 * process on the same machine already owns the session). See mcp-bridge-threat-model.md.
 */
/** Parses a frame without ever throwing: a malformed message must not kill the socket. */
export const parseFrame = (data) => {
    try {
        const frame = JSON.parse(data);
        if (!frame || typeof frame !== 'object')
            return null;
        if (typeof frame.t !== 'string')
            return null;
        return frame;
    }
    catch {
        return null;
    }
};
