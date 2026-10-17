/**
 * Follower analysis: unfollowers, peer lists, and follower-quality scoring.
 *
 * All three are computed locally from `/api/v1/friendships/{id}/followers|following`, which
 * still answer with real JSON. None of them ask Instagram to do anything — they read lists
 * and diff them — which is why they can be reimplemented exactly rather than approximated.
 *
 * Unfollowers in particular needs a previous snapshot to diff against, so this is the one
 * feature here that persists state: without a stored follower list there is no answer to
 * "who unfollowed me", only a shrug. It is kept in the user's own home folder, deliberately
 * outside the real INSSIST's `.inssist/` directory so the two never touch.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { igFetch } from './transport.mjs'
import { currentUser, resolveUser } from './ig.mjs'
import { startJob, listJobs, jobStatus } from './jobs.mjs'
import { writeCsv, exportDir } from './csv.mjs'

const DATA_DIR = `${homedir()}\\.inssist-mcp-free`

const read = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const write = (path, value) => {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

const shapePeer = user => ({
  id: user.pk ?? user.id ?? null,
  username: user.username ?? null,
  fullName: user.full_name ?? null,
  private: user.is_private ?? false,
  verified: user.is_verified ?? false,
  followedByYou: user.friendship_status?.following ?? null,
  followsYou: user.friendship_status?.followed_by ?? null,
  profilePic: user.profile_pic_url ?? null,
})

/** Fetches one path as JSON, returning null instead of throwing so a failed page ends a crawl. */
const json = async (session, path) => {
  const result = await igFetch(session, path)
  return result.ok ? result.json : null
}

/**
 * Pages through a whole followers or following list.
 *
 * Instagram caps a page well below a large account's total, so this walks `max_id` until the
 * response stops handing one back. The page ceiling guards against a cursor that stops
 * advancing — without it a malformed response spins forever.
 */
const crawl = async (session, userId, kind, onProgress) => {
  const users = []
  let cursor = ''
  let pages = 0

  for (;;) {
    const response = await json(
      session,
      `/api/v1/friendships/${userId}/${kind}/?count=200&max_id=${encodeURIComponent(cursor)}`,
    )

    const batch = response?.users ?? []
    users.push(...batch.map(shapePeer))
    pages += 1
    onProgress?.(users.length, pages)

    const next = response?.next_max_id
    if (!next || !batch.length || pages > 500) return users
    cursor = String(next)
  }
}

/** The signed-in account's numeric id — required by every friendships route. */
const ownUserId = async session => String((await currentUser(session))?.id ?? '')

/**
 * Follower counts broken down by the two attributes the payload actually carries.
 *
 * Exported for `insights_collect` so audience stats use the identical crawl as the analysis
 * tools rather than a second, differently-paged implementation that would disagree with them.
 */
export const crawlFollowersForInsights = async (session, userId, onProgress) => {
  const users = await crawl(session, userId, 'followers', onProgress)
  const total = users.length
  const percent = count => (total ? Math.round((count / total) * 10000) / 100 : 0)

  return {
    total,
    privatePct: percent(users.filter(user => user.private).length),
    verifiedPct: percent(users.filter(user => user.verified).length),
  }
}

// MARK: unfollowers
// ============================================================================

const UNFOLLOWERS_FILE = `${DATA_DIR}\\unfollowers.json`

export const unfollowersScan = session =>
  startJob('unfollowers', 'unfollowers scan', async job => {
    const me = await currentUser(session)
    const userId = String(me.id)

    job.step = 'crawling followers'
    const current = await crawl(session, userId, 'followers', done => {
      job.done = done
      job.step = `crawling followers (${done} so far)`
    })

    const previous = read(UNFOLLOWERS_FILE)
    const known = new Set(current.map(user => String(user.id)))
    const now = Date.now()

    // An account counts as an unfollower if it was in the previous snapshot and is not in the
    // list now. The first scan has nothing to diff against, so it reports nobody rather than
    // presenting every current follower as a recent loss.
    const gone = (previous?.followers ?? [])
      .filter(user => !known.has(String(user.id)))
      .map(user => ({ ...user, unfollowedOn: new Date(now).toISOString() }))

    write(UNFOLLOWERS_FILE, { userId, username: me.username, scannedOn: now, followers: current, unfollowers: gone })

    job.result = {
      scannedOn: now,
      followersNow: current.length,
      // Without a prior snapshot the diff is undefined, and saying so beats a silent zero.
      hadSnapshot: Boolean(previous),
      unfollowers: gone,
    }
  })

export const unfollowersReport = () => {
  const job = listJobs('unfollowers')[0] ?? null
  const stored = read(UNFOLLOWERS_FILE)

  return {
    ...(job ? jobStatus(job) : { scanning: false, state: stored ? 'done' : 'never-run' }),
    lastScanOn: stored?.scannedOn ?? null,
    followersNow: stored?.followers?.length ?? null,
    hadSnapshot: Boolean(stored),
    unfollowers: stored?.unfollowers ?? [],
    note: stored
      ? null
      : 'No scan has run yet. Call unfollowers_scan — the first run establishes the baseline and reports nobody.',
  }
}

export const unfollowersExport = () => {
  const rows = read(UNFOLLOWERS_FILE)?.unfollowers ?? []
  const file = `${exportDir()}\\unfollowers-${new Date().toISOString().slice(0, 10)}.csv`
  writeCsv(file, rows, [
    ['id', user => user.id],
    ['username', user => user.username],
    ['fullName', user => user.fullName],
    ['private', user => user.private],
    ['verified', user => user.verified],
    ['unfollowedOn', user => user.unfollowedOn],
  ])
  return { file, rows: rows.length }
}

// MARK: peers
// ============================================================================

const peersFile = userId => `${DATA_DIR}\\peers-${userId}.json`

export const peersScan = (session, { user = null, kind = 'followers' } = {}) =>
  startJob('peers', `peers scan (${kind})`, async job => {
    const userId = user ? String((await resolveUser(session, user)).id) : await ownUserId(session)

    job.step = `crawling ${kind}`
    const users = await crawl(session, userId, kind, done => {
      job.done = done
      job.step = `crawling ${kind} (${done} so far)`
    })

    write(peersFile(userId), { userId, kind, scannedOn: Date.now(), users })
    job.result = { userId, kind, count: users.length }
  })

export const peersReport = ({ from = 0, limit = 50 } = {}) => {
  const job = listJobs('peers')[0] ?? null

  // The most recent scan names the account it collected, which is what selects the file —
  // there is no directory scan to search for one.
  const stored = job?.result?.userId ? read(peersFile(job.result.userId)) : null
  const users = stored?.users ?? []

  const start = Math.max(0, Number(from) || 0)
  const size = Math.min(Math.max(1, Number(limit) || 50), 200)

  return {
    ...(job ? jobStatus(job) : { scanning: false, state: stored ? 'done' : 'never-run' }),
    kind: stored?.kind ?? null,
    scannedOn: stored?.scannedOn ?? null,
    total: users.length,
    from: start,
    users: users.slice(start, start + size),
    nextFrom: start + size < users.length ? start + size : null,
  }
}

export const peersExport = () => {
  const job = listJobs('peers')[0]
  const stored = job?.result?.userId ? read(peersFile(job.result.userId)) : null
  const users = stored?.users ?? []

  const file = `${exportDir()}\\peers-${new Date().toISOString().slice(0, 10)}.csv`
  writeCsv(file, users, [
    ['id', user => user.id],
    ['username', user => user.username],
    ['fullName', user => user.fullName],
    ['private', user => user.private],
    ['verified', user => user.verified],
    ['followsYou', user => user.followsYou],
    ['followedByYou', user => user.followedByYou],
  ])
  return { file, rows: users.length }
}

// MARK: antibot
// ============================================================================

/**
 * Scores followers on the signals the followers payload actually carries.
 *
 * This is a transparent heuristic, not a claim about INSSIST's detector — their model is
 * theirs and cannot be recovered from outside. What *can* be scored honestly from this data:
 * a missing profile picture, zero posts, and a following count wildly out of proportion to
 * the follower count are the three signals a spam farm leaves in plain sight. Every scored
 * account carries its reasons, so the user can disagree with any verdict.
 */
const scoreFollower = user => {
  const reasons = []

  if (!user.profilePic) reasons.push('no profile picture')
  if (user.posts === 0) reasons.push('no posts')

  const following = user.following ?? 0
  const followers = user.followers ?? 0
  if (following > 750 && following > followers * 50) reasons.push(`follows ${following}, followed by ${followers}`)

  const digits = (user.username ?? '').match(/\d/g)?.length ?? 0
  if (digits >= 5) reasons.push(`${digits} digits in the username`)

  const risk = reasons.length >= 2 ? 'high' : reasons.length === 1 ? 'medium' : 'clean'
  return { ...user, risk, reasons }
}

const ANTIBOT_FILE = `${DATA_DIR}\\antibot.json`

export const antibotScan = session =>
  startJob('antibot', 'antibot scan', async job => {
    const userId = await ownUserId(session)

    job.step = 'crawling followers'
    const followers = await crawl(session, userId, 'followers', done => {
      job.done = done
      job.step = `crawling followers (${done} so far)`
    })

    job.step = 'scoring'
    const scored = followers.map(scoreFollower)
    const scannedOn = Date.now()
    write(ANTIBOT_FILE, { userId, scannedOn, scored })

    job.result = { scannedOn, total: scored.length, scored }
  })

export const antibotReport = () => {
  const job = listJobs('antibot')[0] ?? null
  const stored = read(ANTIBOT_FILE)

  const scored = stored?.scored ?? []
  const byRisk = { high: 0, medium: 0, clean: 0 }
  for (const entry of scored) byRisk[entry.risk] = (byRisk[entry.risk] ?? 0) + 1

  return {
    ...(job ? jobStatus(job) : { scanning: false, state: stored ? 'done' : 'never-run' }),
    scannedOn: stored?.scannedOn ?? null,
    total: scored.length,
    byRisk,
    flagged: scored.filter(entry => entry.risk !== 'clean'),
    note: scored.length
      ? "Heuristic scoring from public profile signals, not INSSIST's detector. Detection only — nothing was removed."
      : 'No scan has run yet. Call antibot_scan.',
  }
}

export const antibotExport = () => {
  const scored = read(ANTIBOT_FILE)?.scored ?? []
  const file = `${exportDir()}\\antibot-${new Date().toISOString().slice(0, 10)}.csv`
  writeCsv(file, scored, [
    ['id', user => user.id],
    ['username', user => user.username],
    ['fullName', user => user.fullName],
    ['risk', user => user.risk],
    ['reasons', user => user.reasons.join('; ')],
  ])
  return { file, rows: scored.length }
}
