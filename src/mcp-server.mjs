#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Launches the upstream MIT server unmodified, on a port of our own.
 *
 * Their server has no PRO logic at all — the subscription check lives in the extension, which
 * is us. So we keep their compiled `dist` verbatim (vendored, licence included) and only point
 * it somewhere the running INSSIST instance on 48231 will not collide with.
 *
 * This file must relay stdio straight through: it is the process the MCP client spawns.
 */

const UPSTREAM = fileURLToPath(new URL('../vendor/inssist-mcp/dist/index.js', import.meta.url))

// Our port, not upstream's 48231. On 48231 the user's real INSSIST MCP already runs as a hub
// and this driver would pair into *their* session instead of serving ours. `IG_MCP_PORT` is
// the one knob shared by both halves: set it in both places, or in neither.
process.env.INSSIST_MCP_PORT ??= process.env.IG_MCP_PORT ?? '48232'

const child = spawn(process.execPath, [UPSTREAM], { stdio: 'inherit', env: process.env })

const forward = (signal, code) => () => {
  if (!child.killed) child.kill(signal)
  process.exit(code)
}
process.on('SIGINT', forward('SIGINT', 130))
process.on('SIGTERM', forward('SIGTERM', 143))
child.on('exit', code => process.exit(code ?? 0))
