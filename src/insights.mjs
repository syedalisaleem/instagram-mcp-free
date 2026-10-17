/**
 * `insights_collect` / `insights_report` — engagement analytics computed from real posts.
 *
 * Instagram only exposes its own Insights dashboards to business and creator accounts through
 * the Graph API, which this whole project exists to avoid. What is still completely readable is
 * the public record: every post carries its own like and comment counts, its timestamp, and the
 * account's follower total. Engagement rate and reach are not derivable from that — impressions
 * and reach are private — so nothing below claims them. The metrics here are the ones the
 * public data genuinely supports, and each is labelled with what it is measured against.
 *
 * State lives on disk rather than only in memory because a scan of 1500 posts is expensive to
 * repeat, and a report that forgets everything on every driver restart would be worthless.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fetchPosts, fetchProfile } from './ig.mjs'
import { crawlFollowersForInsights } from './audience.mjs'
import { startJob, listJobs, jobStatus } from './jobs.mjs'

const DATA_DIR = `${homedir()}\\.inssist-mcp-free`
const insightsFile = username => `${DATA_DIR}\\insights-${String(username).replace(/[^\w.-]+/g, '_')}.json`

const read = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const write = (path, value) => {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

/** Mean, rounded to a sensible number of digits — engagement rates read badly at 15 places. */
const mean = values => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : 0)

/** The hour a timestamp falls in, in UTC — the only zone that does not depend on where this runs. */
const hourOf = takenAt => new Date(takenAt * 1000).getUTCHours()
const weekdayOf = takenAt => new Date(takenAt * 1000).getUTCDay()

export const insightsCollect = (session, { username, postsLimit = null, followers = false } = {}) => {
  if (!username) throw new Error('`username` is required')

  const limit = Math.min(Math.max(1, Number(postsLimit) || 150), 1500)

  return startJob('insights', `insights ${username}`, async job => {
    job.step = 'reading profile'
    const profile = await fetchProfile(session, username)

    job.step = 'collecting posts'
    const posts = []
    let cursor = null

    for (;;) {
      const page = await fetchPosts(session, username, Math.min(50, limit - posts.length), cursor)
      posts.push(...page.posts)
      job.done = posts.length
      job.total = limit
      job.step = `collecting posts (${posts.length}${limit >= 1500 ? '' : `/${limit}`})`

      cursor = page.nextCursor
      if (!cursor || posts.length >= limit || job.cancelled) break
    }

    job.step = 'computing metrics'
    const capped = posts.slice(0, limit)

    const likes = capped.map(post => Number(post.likes) || 0)
    const comments = capped.map(post => Number(post.comments) || 0)
    const totalLikes = likes.reduce((a, b) => a + b, 0)
    const totalComments = comments.reduce((a, b) => a + b, 0)

    const hours = Array(24).fill(0)
    const weekdays = Array(7).fill(0)
    for (const post of capped) {
      if (!post.takenAt) continue
      hours[hourOf(post.takenAt)] += 1
      weekdays[weekdayOf(post.takenAt)] += 1
    }

    // Posting gaps, in days, sorted so the median describes typical cadence rather than being
    // dragged around by one month of silence.
    const gaps = capped
      .filter(post => post.takenAt)
      .sort((a, b) => a.takenAt - b.takenAt)
      .slice(1)
      .map((post, index, sorted) => (post.takenAt - sorted[index - 1]?.takenAt) / 86400)
      .filter(days => Number.isFinite(days) && days >= 0)

    const followerCount = profile?.followers ?? null
    // Per-post engagement against the follower count, not an account-wide rate: one viral post
    // would otherwise hide the typical post's performance for the whole window.
    const engagementRate =
      followerCount > 0
        ? Math.round((mean(likes) + mean(comments)) / followerCount * 10000) / 100
        : null

    let audience = null
    if (followers) {
      job.step = 'collecting followers'
      audience = await crawlFollowersForInsights(session, String(profile.id), done => {
        job.step = `collecting followers (${done})`
      })
    }

    const metrics = {
      username: profile.username ?? username,
      postsAnalyzed: capped.length,
      followers: followerCount,
      following: profile.following ?? null,
      avgLikes: mean(likes),
      avgComments: mean(comments),
      totalLikes,
      totalComments,
      // Labelled as per-post because that is what it is. Reach and impressions are private and
      // cannot be computed from public counts, so they are not offered at all.
      engagementRateVsFollowersPct: engagementRate,
      bestHourUtc: hours.indexOf(Math.max(...hours)),
      postsByHourUtc: hours,
      postsByWeekdayUtc: weekdays,
      medianDaysBetweenPosts: gaps.length ? Math.round(mean(gaps) * 100) / 100 : null,
      topPosts: [...capped]
        .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))
        .slice(0, 5)
        .map(post => ({ shortcode: post.shortcode, url: post.url, likes: post.likes, comments: post.comments })),
      audience: audience
        ? {
            total: audience.total,
            privatePct: audience.privatePct,
            verifiedPct: audience.verifiedPct,
          }
        : null,
      audienceScanned: Boolean(audience),
      collectedOn: new Date().toISOString(),
    }

    write(insightsFile(profile.username ?? username), metrics)
    job.result = metrics
  })
}

export const insightsReport = ({ username = null } = {}) => {
  if (!username) throw new Error('`username` is required')

  const job = listJobs('insights').find(entry => entry.label === `insights ${username}`) ?? null
  const stored = read(insightsFile(username))

  if (job) return { ...jobStatus(job), note: 'Still collecting — poll again.' }

  if (!stored) {
    return {
      scanning: false,
      state: 'never-run',
      username,
      note: 'No collected data for this account yet. Call insights_collect first.',
    }
  }

  return { scanning: false, state: 'done', username, ...stored }
}
