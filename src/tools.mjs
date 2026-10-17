import {
  currentUser,
  fetchProfile,
  fetchPosts,
  fetchPost,
  fetchStories,
  fetchSaved,
  search,
  dmList,
  dmRequests,
  dmRead,
  locationSearch,
  musicSearch,
  listComments,
  addComment,
  replyComment,
  deleteComment,
  likeComment,
  followUser,
  unfollowUser,
  removeFollower,
  blockUser,
  likePost,
  editPost,
  deletePost,
  updateBio,
  listNotifications,
  storyViewers,
  probe,
} from './ig.mjs'
import {
  unfollowersScan,
  unfollowersReport,
  unfollowersExport,
  peersScan,
  peersReport,
  peersExport,
  antibotScan,
  antibotReport,
  antibotExport,
} from './audience.mjs'
import { downloadsStart, downloadsStatus, downloadsCancel } from './downloads.mjs'
import { insightsCollect, insightsReport } from './insights.mjs'
import { eventsCheck } from './events.mjs'
import { structural, savedUnavailable, musicUnavailable, storiesUnavailable } from './availability.mjs'
import {
  growthConfigure,
  growthExport,
  growthPause,
  growthStart,
  growthStatus,
} from './growth.mjs'
import { acquireSession, peekSession, describeTransport } from './transport.mjs'
import { bridge } from './extension.mjs'
import { draftQueue } from './drafts.mjs'
import { INSTANCE_ID } from './protocol.mjs'

/**
 * Tool dispatch: contract name -> handler.
 *
 * A handler returns a plain object; the bridge carries it verbatim to the MCP client. Throwing
 * is fine — the driver turns it into an `error` frame, which upstream surfaces as a tool error
 * the agent can read.
 *
 * Anything not yet implemented answers with a structured `notImplemented` notice naming the
 * gap rather than pretending to succeed. An agent reading that can tell the user exactly what
 * is missing instead of reporting a call that silently did nothing.
 */

/**
 * Resolves a browser backend, then hands the handle to the handler.
 *
 * Login is not checked here: both transports reach Instagram identically, so a signed-out
 * browser yields a 401 that `igOk` renders as one clear message. Pre-checking would mean two
 * round trips per tool call to say the same thing.
 */
const withSession = fn => async params => {
  const session = await acquireSession()
  return fn(session, params ?? {})
}

const notImplemented = name => () => ({
  notImplemented: true,
  tool: name,
  note:
    'This tool is declared in the contract but this driver has no implementation for it yet. ' +
    'Nothing was sent to Instagram.',
})

export const handlers = {
  // MARK: account
  /**
   * Upstream answers this one itself, fanning out over paired browsers and spreading our
   * return value into each instance entry — so this returns a flat object deliberately.
   * Nesting an `instances` array here would produce a redundant one two levels deep.
   */
  account_info: async () => {
    const session = await peekSession()
    const transport = describeTransport()

    if (!session) {
      return {
        instanceId: INSTANCE_ID,
        transport,
        loggedIn: false,
        pro: false,
        proTrialDaysLeft: 0,
        note: 'No browser backend available. Load extension/ unpacked, or let Playwright open its own profile.',
      }
    }

    // The failure reason matters as much as the failure itself: a dead relay and an empty
    // login both arrive here as `me === null`, and reporting the second when the first is
    // true would send the user off to log in while their bridge is actually broken.
    let me = null
    let failure = null
    try {
      me = await currentUser(session)
    } catch (error) {
      failure = String(error?.message ?? error)
    }

    return {
      instanceId: INSTANCE_ID,
      transport,
      bridge: bridge.info(),
      loggedIn: me != null,
      username: me?.username ?? null,
      fullName: me?.fullName ?? null,
      accountId: me?.id ?? null,
      followers: me?.followers ?? null,
      following: me?.following ?? null,
      posts: me?.posts ?? null,
      private: me?.private ?? null,
      pro: false,
      proTrialDaysLeft: 0,
      note: me
        ? null
        // When the failure already carries the fix (igOk's login-wall text does), repeat it
        // verbatim rather than appending a second, competing instruction.
        : /signed in|logged in|login wall/i.test(failure ?? '')
          ? failure
          : `The account request did not succeed: ${failure ?? 'unknown error'}`,
    }
  },

  account_switch: async () => ({
    switched: false,
    note:
      'One bridge is one signed-in browser profile, so there is no second account to switch ' +
      'to. Load a second unpacked extension under a different Chrome profile, or set ' +
      'IG_MCP_PROFILE to a second Playwright directory, to run accounts side by side.',
  }),

  // MARK: read data
  ig_fetch_profile: withSession((session, p) => fetchProfile(session, p.username)),
  ig_fetch_posts: withSession((session, p) => fetchPosts(session, p.username, p.limit ?? 12, p.cursor ?? null)),
  ig_fetch_post: withSession((session, p) => fetchPost(session, p)),
  // These three ship with working code against endpoints Instagram no longer serves on the web.
  // The attempt is still made — a query appearing in a future capture should start working with
  // no edit here — but the structural failure is re-explained, because `igOk`'s generic "usually
  // the login wall" would send an agent off to sign in again for an answer that never changes.
  ig_fetch_stories: withSession(async (session, p) => {
    try {
      return await fetchStories(session, p.username)
    } catch (error) {
      throw structural(error, storiesUnavailable)
    }
  }),
  ig_fetch_saved: withSession(async (session, p) => {
    try {
      return await fetchSaved(session, p.cursor ?? null)
    } catch (error) {
      throw structural(error, () => savedUnavailable())
    }
  }),
  ig_search: withSession((session, p) => search(session, p.query, p.type ?? 'user')),

  // MARK: direct messages (read)
  dm_list: withSession(session => dmList(session)),
  dm_requests: withSession(session => dmRequests(session)),
  dm_read: withSession((session, p) => dmRead(session, p.thread_id, p.limit ?? 25)),

  // MARK: publish helpers
  location_search: withSession((session, p) => locationSearch(session, p.query)),
  music_search: withSession(async (session, p) => {
    try {
      return await musicSearch(session, p.query, p.limit ?? 10)
    } catch (error) {
      throw structural(error, () => musicUnavailable())
    }
  }),

  // MARK: comments
  comments_list: withSession((session, p) => listComments(session, p)),
  comment_add: withSession((session, p) => addComment(session, p)),
  comment_reply: withSession((session, p) => replyComment(session, p)),
  comment_delete: withSession((session, p) => deleteComment(session, p)),
  comment_like: withSession((session, p) => likeComment(session, p)),

  // MARK: follow, block, actions
  /**
   * `ig_action` accepts exactly four verbs and rejects anything else, matching the contract.
   * A tool that silently turned a typo into some other action would be worse than one that
   * refuses it.
   */
  ig_action: withSession(async (session, p) => {
    const type = String(p.type ?? '').toLowerCase()
    if (!['like', 'unlike', 'follow', 'unfollow'].includes(type)) {
      throw new Error(`\`type\` must be one of like, unlike, follow, unfollow (got "${p.type}")`)
    }

    if (type === 'unlike') {
      if (!p.postId && !p.shortcode) throw new Error('`unlike` needs a `postId` or a `shortcode`')
      return likePost(session, p.postId ?? p.shortcode, true)
    }

    if (!p.username) throw new Error(`\`${type}\` needs a \`username\``)
    if (type === 'like') {
      // "Like" means "pick a recent post of theirs and like it" — the caller supplies the
      // account, not the post, so the most recent post has to be chosen here.
      const posts = await fetchPosts(session, p.username, 1)
      const target = posts.posts[0]
      if (!target) throw new Error(`@${p.username} has no posts to like`)
      return likePost(session, target.id, false)
    }

    return type === 'follow' ? followUser(session, p.username) : unfollowUser(session, p.username)
  }),

  ig_block: withSession((session, p) => blockUser(session, p.user, p.unblock ?? false)),
  follower_remove: withSession((session, p) => removeFollower(session, p.user)),

  // MARK: published posts
  ig_post_edit: withSession((session, p) => editPost(session, p)),
  ig_post_delete: withSession((session, p) => deletePost(session, p)),

  // MARK: account & activity
  profile_update: withSession((session, p) => updateBio(session, p.bio ?? '')),
  notifications_list: withSession((session, p) => listNotifications(session, p)),
  story_viewers: withSession((session, p) => storyViewers(session, p)),

  // MARK: local analysis — read lists, diff them, score them. Nothing here writes to
  // Instagram, so these run the same as INSSIST's do but are computed on this machine.
  unfollowers_scan: withSession(session => unfollowersScan(session)),
  unfollowers_report: withSession(() => unfollowersReport()),
  unfollowers_export: withSession(() => unfollowersExport()),

  peers_scan: withSession((session, p) => peersScan(session, p)),
  peers_report: withSession((_session, p) => peersReport(p)),
  peers_export: withSession(() => peersExport()),

  antibot_scan: withSession(session => antibotScan(session)),
  antibot_report: withSession(() => antibotReport()),
  antibot_export: withSession(() => antibotExport()),

  // MARK: downloads — listing runs through the session, the bytes come straight off the CDN
  downloads_start: withSession((session, p) => downloadsStart(session, p)),
  downloads_status: withSession((_session, p) => downloadsStatus(p)),
  downloads_cancel: withSession((_session, p) => downloadsCancel(p)),

  // MARK: analytics & activity
  insights_collect: withSession((session, p) => insightsCollect(session, p)),
  insights_report: withSession((_session, p) => insightsReport(p)),
  events_check: withSession((session, p) => eventsCheck(session, p)),

  // MARK: growth — deliberately not session-backed. These answer with a refusal rather than a
  // browser error, because the honest answer does not depend on whether Chrome is open.
  growth_configure: growthConfigure,
  growth_export: growthExport,
  growth_pause: growthPause,
  growth_start: growthStart,
  growth_status: growthStatus,

  // MARK: drafts — INSSIST's queue lives in its own storage, so this is reimplementable
  // locally in full, with no Instagram involvement and no PRO gate.
  draft_create: p => draftQueue.create(p),
  draft_list: p => draftQueue.list(p),
  draft_get: p => draftQueue.get(p),
  draft_update: p => draftQueue.update(p),
  draft_delete: p => draftQueue.remove(p),
  draft_reorder: p => draftQueue.reorder(p),
  draft_schedule: p => draftQueue.schedule(p),
  draft_publish: p => draftQueue.publish(p),

  // MARK: diagnostics (not in the contract; reachable directly, not via MCP)
  _probe: withSession((session, p) => probe(session, p.path, p.method ?? 'GET', p.headers ?? {}, p.body ?? null)),
}

/** Names in the contract with no handler yet. */
export const pendingTools = names => names.filter(n => n !== '_probe' && !handlers[n])

/** Wraps a handler so "not implemented" is an explicit, honest answer. */
export const resolve = name => handlers[name] ?? notImplemented(name)
