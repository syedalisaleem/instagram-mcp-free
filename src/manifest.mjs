import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The upstream tool contract, with the paywall removed at the source.
 *
 * Upstream's `describe()` appends "(Requires INSSIST PRO.)" only when `entry.pro` is true,
 * and refuses to run a PRO tool without a subscription. Because *we* supply the `manifest`
 * frame, flipping `pro` to false here removes both the upsell text and the subscription gate
 * — there is no server-side PRO check left to bypass, because the server never had one.
 *
 * Everything else (name, params, risk, pacing, source) is passed through byte-for-byte, so
 * the MCP surface a harness sees is identical to upstream's.
 */

const MANIFEST_PATH = fileURLToPath(new URL('../tools-manifest.json', import.meta.url))

export const loadContract = () => {
  const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  if (!Array.isArray(parsed?.tools)) throw new Error('tool contract is malformed')
  return parsed.tools
}

/** The frame we advertise: same contract, every `pro` flag false. */
export const unlockedManifest = () =>
  loadContract().map(tool => ({
    name: tool.name,
    description: tool.description,
    params: tool.params ?? [],
    pro: false,
    risk: tool.risk,
    source: tool.source,
    ...(tool.paced === false ? { paced: false } : {}),
  }))

export const contract = loadContract()

export const byName = new Map(contract.map(tool => [tool.name, tool]))
