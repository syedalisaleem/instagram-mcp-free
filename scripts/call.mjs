/**
 * Calls one tool through the real MCP server and prints the result, then exits.
 *
 * Written for the moments the full smoke suite is the wrong shape: one call, its whole payload,
 * no other output in the way. `node scripts/call.mjs downloads_start '{"username":"x","limit":1}'`
 *
 * Anything reachable through an MCP client is reachable this way, which is the point — if this
 * script cannot drive a tool, the agent could not either.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [, , name, rawArgs = '{}'] = process.argv
if (!name) {
  console.error('usage: node scripts/call.mjs <tool> [json-arguments]')
  process.exit(2)
}

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
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
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
    }, 300_000)
  })
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ig-mcp-free-call', version: '0.1.0' },
  })
  if (init.error) throw new Error(init.error.message)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // The server serves a bundled snapshot until the driver's live manifest replaces it, so a
  // call issued immediately would be answered against upstream's tool list, not ours.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await rpc('tools/list')
    const upsells = (probe.result?.tools ?? []).filter(t => /Requires INSSIST PRO/.test(t.description ?? ''))
    if (upsells.length === 0) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  const result = await rpc('tools/call', { name, arguments: JSON.parse(rawArgs) })
  const text = (result.result?.content ?? []).map(part => part.text).join('\n')
  console.log(`isError: ${result.result?.isError ?? false}`)
  console.log(text || JSON.stringify(result.result ?? result.error, null, 2))
} catch (error) {
  console.error('FAILED:', error?.message ?? error)
  child.kill()
  process.exit(1)
}

child.kill()
process.exit(0)
