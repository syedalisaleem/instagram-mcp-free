import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * A local publishing queue — the one part of the contract that was never Instagram's.
 *
 * Upstream's `draft_*` tools (all 8 marked `paced: false`) operate on INSSIST's own storage:
 * a draft is a row in their queue, not anything on Instagram. So reimplementing them means
 * writing a JSON file, and the full 8-tool surface comes back with no paywall and no network.
 *
 * `draft_publish` is the exception: pushing a draft to Instagram is a real resumable upload
 * and is not implemented here yet — it says so instead of reporting success.
 */

const PATH = process.env.IG_MCP_DRAFTS ?? fileURLToPath(new URL('../drafts.json', import.meta.url))

const TYPES = ['post', 'reel', 'story', 'carousel']

const load = () => {
  if (!existsSync(PATH)) return []
  try {
    const rows = JSON.parse(readFileSync(PATH, 'utf-8'))
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

const save = rows => {
  mkdirSync(dirname(PATH), { recursive: true })
  writeFileSync(PATH, JSON.stringify(rows, null, 2), 'utf-8')
}

const find = (rows, id) => {
  const row = rows.find(r => r.draftId === id)
  if (!row) throw new Error(`No draft with id "${id}"`)
  return row
}

const shape = row => ({ ...row })

export const draftQueue = {
  create(params) {
    const rows = load()
    const type = params.type ?? 'post'
    if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`)
    const assets = params.assets ?? []
    if (assets.length && !type) throw new Error('assets require a type')

    const row = {
      draftId: randomUUID(),
      type,
      status: 'draft',
      caption: params.caption ?? '',
      assets: assets.map(String),
      musicTrackId: params.musicTrackId ?? null,
      musicTrackName: params.musicTrackName ?? null,
      location: params.location ?? null,
      mentions: params.mentions ?? [],
      collaborators: params.collaborators ?? [],
      closeFriends: params.closeFriends ?? false,
      linkUrl: params.linkUrl ?? null,
      stickerText: params.stickerText ?? null,
      hideLikes: params.hideLikes ?? false,
      disableComments: params.disableComments ?? false,
      shareToFeed: params.shareToFeed ?? true,
      stretchToFill: params.stretchToFill ?? false,
      at: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    rows.push(row)
    save(rows)
    return shape(row)
  },

  list(params = {}) {
    let rows = load()
    if (params.status) rows = rows.filter(r => r.status === params.status)
    rows.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.createdAt - b.createdAt)
    const limit = params.limit ?? 50
    return { count: rows.length, drafts: rows.slice(0, limit).map(shape) }
  },

  get(params) {
    const rows = load()
    return shape(find(rows, params.draftId))
  },

  update(params) {
    const rows = load()
    const row = find(rows, params.draftId)
    const mutable = [
      'caption', 'type', 'musicTrackId', 'musicTrackName', 'location', 'mentions', 'collaborators',
      'closeFriends', 'linkUrl', 'stickerText', 'hideLikes', 'disableComments', 'shareToFeed', 'stretchToFill',
    ]
    for (const key of mutable) if (params[key] !== undefined) row[key] = params[key]
    if (params.at !== undefined) row.at = params.at
    row.updatedAt = Date.now()
    save(rows)
    return shape(row)
  },

  remove(params) {
    const rows = load()
    const row = find(rows, params.draftId)
    save(rows.filter(r => r.draftId !== params.draftId))
    return { deleted: true, draftId: row.draftId }
  },

  reorder(params) {
    const order = params.draftIds ?? []
    const rows = load()
    const index = new Map(order.map((id, i) => [id, i]))
    rows.sort((a, b) => (index.get(a.draftId) ?? 1e9) - (index.get(b.draftId) ?? 1e9))
    save(rows)
    return { reordered: order.length, drafts: rows.map(shape) }
  },

  schedule(params) {
    const at = params.at
    if (!at) throw new Error('`at` is required (ISO 8601)')
    const epoch = Date.parse(at)
    if (Number.isNaN(epoch)) throw new Error(`"${at}" is not a valid date`)
    if (epoch < Date.now()) throw new Error('Cannot schedule in the past')

    const rows = load()
    const row = find(rows, params.draftId)
    row.at = epoch
    row.status = 'scheduled'
    row.updatedAt = Date.now()
    save(rows)
    return shape(row)
  },

  publish() {
    throw new Error(
      'draft_publish is not implemented: pushing a draft to Instagram is a resumable upload flow ' +
        'that this driver does not yet perform. The draft was left untouched in the queue.',
    )
  },
}
