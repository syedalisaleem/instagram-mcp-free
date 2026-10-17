/**
 * `events_check` — a cheap "has anything happened" poll.
 *
 * The contract offers six kinds. Four of them (comments, likes, follows, mentions) come from
 * `/api/v1/news/inbox/`, which answers with real JSON for this session. The other two, `dm`
 * and `dm_requests`, sit behind `/api/v1/direct_v2/…`, which instagram.com's web front end
 * does not route at all — it answers with the signed-out 404 page rather than an API error.
 *
 * That difference is the reason this file exists separately from `notifications_list`: the
 * honest answer for the default kinds is "these cannot be checked from a web session", and
 * silently returning zero events would read exactly like "your inbox is quiet".
 */
import { listNotifications } from './ig.mjs'

const KINDS = new Set(['dm', 'dm_requests', 'comments', 'likes', 'follows', 'mentions'])

/** Kinds backed by a working endpoint, mapped onto the notification text they share. */
const NOTIFICATION_KIND = {
  comments: n => /comment|replied|reply/i.test(n.text ?? ''),
  likes: n => /like/i.test(n.text ?? ''),
  follows: n => /follow/i.test(n.text ?? ''),
  mentions: n => /mention|tagged/i.test(n.text ?? ''),
}

export const eventsCheck = async (session, { kinds = null, cursor = null } = {}) => {
  const wanted = kinds?.length ? new Set(kinds) : new Set(['dm', 'dm_requests'])

  for (const kind of wanted) {
    if (!KINDS.has(kind)) throw new Error(`\`kinds\` must be one of: ${[...KINDS].join(', ')} (got "${kind}")`)
  }

  const unavailable = [...wanted].filter(kind => kind === 'dm' || kind === 'dm_requests')
  const pollable = [...wanted].filter(kind => NOTIFICATION_KIND[kind])

  // The default request is entirely made of kinds this endpoint cannot answer, so returning
  // an empty event list would be indistinguishable from a silent inbox. Ask anyway — the
  // notification list is one call and gives the caller a real cursor either way — but say
  // plainly what could not be checked.
  const feed = pollable.length ? await listNotifications(session, { limit: 200 }) : null

  const events = (feed?.notifications ?? [])
    .filter(notice => pollable.some(kind => NOTIFICATION_KIND[kind](notice)))
    .map(notice => ({
      ...notice,
      kind: pollable.find(kind => NOTIFICATION_KIND[kind](notice)) ?? null,
      // A cursor is only meaningful if the caller can compare against it, and timestamps come
      // back in seconds here while a few paths report milliseconds — normalise so a cursor
      // produced by one call compares correctly on the next.
      at: typeof notice.timestamp === 'number' && notice.timestamp > 1e12
        ? Math.floor(notice.timestamp / 1000)
        : notice.timestamp,
    }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))

  // Everything newer than the caller's cursor. An unset cursor means "first call", which
  // returns the whole window rather than nothing, so the caller has something to resume from.
  const since = cursor ? Number(cursor) : null
  const fresh = since ? events.filter(event => (event.at ?? 0) > since) : events
  const nextCursor = events.length ? String(events[0].at ?? '') : null

  return {
    checked: pollable,
    unavailable,
    note: unavailable.length
      ? 'dm and dm_requests need /api/v1/direct_v2/…, which instagram.com does not route for a web session — they would report "quiet" even with unread messages waiting.'
      : null,
    newEvents: fresh.length,
    events: fresh,
    cursor: nextCursor,
    counts: feed?.counts ?? null,
  }
}
