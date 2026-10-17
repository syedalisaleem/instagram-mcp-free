import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { igOk } from './browser.mjs'
import { igFetch, IG_ORIGIN } from './transport.mjs'

/**
 * Instagram's private web API — the endpoints instagram.com's own frontend calls.
 *
 * This is what "without an Instagram API" means here: no Meta Graph API, no business account,
 * no app review, no access token. We use the session the browser already has, which is the
 * same thing INSSIST's extension does.
 *
 * Every function takes a `session` handle rather than a browser object. That handle is either
 * `{kind:'extension'}` or `{kind:'playwright', page}`, and because both resolve requests to
 * the same `{ok, status, json, text}` shape, nothing below knows or cares which is in use —
 * which is exactly why adding the Chrome extension did not require rewriting any of this.
 *
 * These routes are undocumented and Meta renumbers them without notice. All traffic funnels
 * through `call()` so a shape change surfaces as a readable error rather than a crash, and
 * `probe()` exists so a moved endpoint can be re-discovered instead of guessed at.
 */

// MARK: plumbing
// ============================================================================

const call = async (session, path, opts) => {
  const result = await igFetch(session, path, opts)
  const checked = igOk(result)
  if (!checked.ok) throw new Error(checked.error)
  return checked.data
}

/**
 * Feature `doc_id`s captured from instagram.com's own frontend.
 *
 * These numbers identify which GraphQL query to run and are published nowhere — they rotate
 * without notice, which is why they live in one named place with a note on how to re-capture
 * them (`IG_MCP_GQL=1 npm run browser`) rather than being sprinkled through the call sites.
 * When one starts answering "execution error", that is the procedure, not a bug hunt.
 */
export const DOC_ID = {
  /** The posts grid of a profile: `xdt_api__v1__feed__user_timeline_graphql_connection`. */
  userTimeline: '28834890909485062',
  /**
   * The search drawer: `xdt_api__v1__fbsearch__topsearch_connection`. Reached over
   * `/api/graphql` with the page's own form body — see `graphqlCaptured`.
   */
  search: '27706427925724183',
  /**
   * The direct inbox, as `get_slide_mailbox_for_iris_subscription.threads_by_folder`. Sent with
   * `folder: "INBOX"` for the inbox and `folder: "PENDING"` for message requests — one query,
   * two answers, which is why `dm_list` and `dm_requests` share it.
   */
  directInbox: '27437959689223570',
}

/** The Relay feature probes the page always sends. The server does not require these, but it
 *  does refuse a request with no `__relay_internal__pv__…` keys at all. */
const RELAY_DEFAULTS = {
  __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
  __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false,
  __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
  __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
  __relay_internal__pv__PolarisAdDebugToolEnabledrelayprovider: false,
  __relay_internal__pv__PolarisSuggestedUserFeedUnitCardsEnabledrelayprovider: false,
}

/**
 * Runs one GraphQL query by `doc_id`.
 *
 * `variables` is sent *stringified* rather than as an object — that is what the page does, and
 * a real object is refused with a bare 400 that says nothing about why.
 */
export const graphql = async (session, docId, variables) =>
  call(session, '/graphql/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      doc_id: docId,
      variables: JSON.stringify({ ...RELAY_DEFAULTS, ...variables }),
      server_timestamps: 'true',
    }),
  })

const CAPTURED_FILE = fileURLToPath(new URL('../scripts/captured-graphql.json', import.meta.url))

/**
 * Runs a GraphQL query by replaying the page's own captured request, field for field.
 *
 * `graphql()` above sends two fields and one header, which is enough for the Relay reads it was
 * written for. Other queries are not. Search is the one that proved it: it answered with a 200
 * containing Instagram's HTML shell — no error, no status, nothing naming a missing field —
 * until the request carried the ~25 form fields the real front end attaches (`fb_dtsg`,
 * `jazoest`, `lsd`, `__dyn`, `__hs`, …) together with its `x-fb-lsd` and `x-fb-friendly-name`
 * headers. Reconstructing that body would mean guessing at tokens that change per page load.
 *
 * So the captured one is replayed instead, with the only two things the caller controls
 * replaced: `doc_id` and `variables`. Everything else travels back exactly as instagram.com
 * last accepted it.
 *
 * The one fragility that remains is those per-page-load tokens. When a replay starts being
 * answered with an HTML shell or an "invalid token" error, the fix is
 * `IG_MCP_GQL=1 npm run browser`, which re-records them.
 */
export const graphqlCaptured = async (session, docId, variables = {}) => {
  let entries
  try {
    entries = JSON.parse(readFileSync(CAPTURED_FILE, 'utf8'))
  } catch {
    throw new Error(`No captured queries at ${CAPTURED_FILE}. Run \`IG_MCP_GQL=1 npm run browser\`.`)
  }

  const hits = entries.filter(entry => String(entry.doc_id) === String(docId))
  if (!hits.length) {
    throw new Error(`doc_id ${docId} was never captured. Run \`IG_MCP_GQL=1 npm run browser\`.`)
  }

  // Prefer a capture that carried real variables, and among those the most recent one. A single
  // doc_id is captured many times over a session — a live query once, and feature probes with
  // empty variables behind it — and the body of a probe is not the body the query itself needs.
  //
  // Recency matters because captures merge: a refreshed entry carries the run's live `fb_dtsg`
  // and `lsd`, while an older copy of the same query carries tokens that have since rotated
  // out — replaying the stale one is indistinguishable from a broken query (Instagram answers
  // with its HTML page and no error). Entries written before `capturedAt` existed have no
  // timestamp, sort as the oldest, and so keep the original first-with-real-variables pick.
  const withVariables = hits.filter(entry => entry.variables && entry.variables !== '{}')
  const newest = [...withVariables].sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))[0]
  const hit = newest ?? hits[0]

  const encoded = hit.encoded ?? 'form'
  const captured = hit.variables ? JSON.parse(hit.variables) : {}
  const variablesText = JSON.stringify({ ...RELAY_DEFAULTS, ...captured, ...variables })

  let body
  if (encoded === 'form' && hit.raw) {
    const params = new URLSearchParams(hit.raw)
    params.set('doc_id', String(docId))
    params.set('variables', variablesText)
    if (!params.has('server_timestamps')) params.set('server_timestamps', 'true')
    body = params.toString()
  } else if (encoded === 'form') {
    body = new URLSearchParams({
      doc_id: String(docId),
      variables: variablesText,
      server_timestamps: 'true',
    }).toString()
  } else {
    body = JSON.stringify({
      doc_id: String(docId),
      variables: variablesText,
      server_timestamps: 'true',
    })
  }

  const headers = { ...(hit.headers ?? {}) }
  // Transport-level headers describe the request the page made, not this one; sending a stale
  // length is a malformed body and a stale cookie or claim is a rejected session.
  delete headers['content-length']
  delete headers.cookie
  delete headers.host
  delete headers['x-ig-www-claim']
  delete headers['x-csrftoken']
  // Describes the body being sent now, so it wins over whatever the capture carried.
  headers['content-type'] = encoded === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'

  return call(session, hit.path ?? '/graphql/query', { method: 'POST', headers, body })
}

/** Normalises an Instagram node into the flat post shape the MCP contract returns. */
const shapePost = node => {
  const media = node?.node ?? node
  if (!media) return null
  const user = media.user ?? {}
  const code = media.code ?? media.shortcode ?? null

  return {
    id: media.id ?? null,
    shortcode: code,
    url: code ? `${IG_ORIGIN}p/${code}/` : null,
    type:
      media.media_type === 1
        ? 'image'
        : media.media_type === 2
          ? 'video'
          : media.media_type === 8
            ? 'carousel'
            : 'unknown',
    caption: media.caption?.text ?? media.caption ?? null,
    likes: media.like_count ?? null,
    comments: media.comment_count ?? null,
    takenAt: media.taken_at ?? null,
    accessibilityCaption: media.accessibility_caption ?? null,
    owner: { id: user.pk ?? media.user_id ?? null, username: user.username ?? null },
    images:
      media.image_versions2?.candidates
        ?.slice(0, 1)
        .map(c => ({ url: c.url, width: c.width, height: c.height })) ?? [],
    videos:
      media.video_versions
        ?.slice(0, 1)
        .map(v => ({ url: v.url, width: v.width, height: v.height })) ?? [],
    // Every frame of a carousel, in order. Carousels are the one shape where keeping only the
    // cover — as the listings above do — silently loses content: a download tool built on the
    // trimmed shape would save a single image for what is a twelve-image post.
    children:
      (media.carousel_media ?? []).map(child => ({
        id: child.id ?? null,
        type:
          child.media_type === 1 ? 'image' : child.media_type === 2 ? 'video' : 'unknown',
        caption: child.caption?.text ?? null,
        images:
          child.image_versions2?.candidates
            ?.slice(0, 1)
            .map(c => ({ url: c.url, width: c.width, height: c.height })) ?? [],
        videos:
          child.video_versions
            ?.slice(0, 1)
            .map(v => ({ url: v.url, width: v.width, height: v.height })) ?? [],
      })) ?? [],
  }
}

const shapeUser = u => ({
  id: u?.id ?? u?.pk ?? null,
  username: u?.username ?? null,
  fullName: u?.full_name ?? null,
  bio: u?.biography ?? u?.bio ?? null,
  externalUrl: u?.external_url ?? null,
  verified: u?.is_verified ?? false,
  private: u?.is_private ?? false,
  followers: u?.follower_count ?? u?.edge_followed_by?.count ?? null,
  following: u?.following_count ?? u?.edge_follow?.count ?? null,
  posts: u?.media_count ?? u?.edge_owner_to_timeline_media?.count ?? null,
  profilePic: u?.profile_pic_url_hd ?? u?.profile_pic_url ?? null,
})

// MARK: account
// ============================================================================

export const currentUser = async session => {
  // `accounts/current_user/` has been repointed at the SPA and answers with HTML for a
  // signed-in desktop session, so it can no longer identify the account. The edit-profile
  // endpoint still returns real JSON — it is what instagram.com reads the signed-in identity
  // from — and unlike `current_user` it does not move underneath you every few weeks.
  const data = await call(session, '/api/v1/accounts/edit/web_form_data/')
  const form = data?.form_data

  if (!form?.username) {
    // A signed-out browser answers 200 + `login_required` rather than 401, so the status code
    // alone cannot tell "nobody is signed in" from "the shape moved". Say which one it is —
    // a generic failure here reads as a broken bridge when it is really just a login wall.
    if (data == null)
      throw new Error('Instagram returned an empty body for the current-user endpoint')

    const message = String(data.message ?? '')
    throw new Error(
      /login|required|auth/i.test(message)
        ? 'Not signed in to instagram.com in this browser'
        : `Could not read the logged-in account (Instagram answered: ${message || 'no message field'})`,
    )
  }

  // Deliberately not forwarding the email address and phone number this same endpoint also
  // returns. `account_info` gets asked for constantly, and nothing here needs either — a tool
  // that quietly echoes account credentials is not one anyone asked for.
  return shapeUser({
    username: form.username,
    full_name: [form.first_name, form.last_name].filter(Boolean).join(' '),
  })
}

// MARK: profile & posts
// ============================================================================

export const fetchProfile = async (session, username) => {
  const handle = String(username ?? '').replace(/^@/, '').trim()
  if (!handle) throw new Error('`username` is required')

  const data = await call(session, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`)
  const user = data?.data?.user ?? data?.user
  if (!user) throw new Error(`No Instagram user named "${handle}"`)
  return shapeUser(user)
}

export const fetchPosts = async (session, username, limit = 12, cursor = null) => {
  const handle = String(username ?? '').replace(/^@/, '').trim()
  if (!handle) throw new Error('`username` is required')

  // Keyed by handle rather than by user id, so listing someone's posts no longer depends on
  // `fetchProfile` resolving first — which started to matter once profile reads began being
  // rate limited on their own, taking every other read down with them.
  const data = await graphql(session, DOC_ID.userTimeline, {
    username: handle,
    data: {
      count: Math.min(Number(limit) || 12, 50),
      include_reel_media_seen_timestamp: true,
      include_relationship_info: true,
      latest_besties_reel_media: true,
      latest_reel_media: true,
    },
    after: cursor ?? null,
  })

  const timeline = data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection
  if (!timeline) throw new Error('Instagram changed the post list response shape')

  const posts = (timeline.edges ?? []).map(shapePost).filter(Boolean)

  return {
    // Every post carries its owner, so the profile need not be fetched a second time just to
    // fill in the handle the caller already supplied.
    user: { username: handle, id: posts[0]?.owner?.id ?? null },
    posts,
    nextCursor: timeline.page_info?.has_next_page ? timeline.page_info.end_cursor : null,
  }
}

export const fetchPost = async (session, { url, shortcode } = {}) => {
  const code =
    shortcode ??
    (() => {
      const match = String(url ?? '').match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/)
      return match?.[1] ?? null
    })()

  if (!code) throw new Error('Give a post URL or a shortcode')

  const data = await call(session, `/api/v1/media/shortcode/${encodeURIComponent(code)}/info/`)
  const items = data?.items
  if (!items?.length) throw new Error('Post not found')

  return shapePost(items[0])
}

export const fetchStories = async (session, username) => {
  const user = await fetchProfile(session, username)
  const data = await call(session, `/api/v1/feed/user/${user.id}/story/`)

  const reels = Object.values(data?.reels ?? {})
  const items = reels.flatMap(reel => reel.items ?? [])

  return {
    user,
    count: items.length,
    stories: items.map(story => ({
      id: story.id ?? null,
      type: story.media_type === 1 ? 'image' : 'video',
      takenAt: story.taken_at ?? null,
      expiringAt: story.expiring_at ?? null,
      url:
        story.image_versions2?.candidates?.[0]?.url ??
        story.video_versions?.[0]?.url ??
        null,
      owner: story.user?.username ?? username,
    })),
  }
}

export const fetchSaved = async (session, cursor = null) => {
  const data = await call(session, `/api/v1/saved/feed/?max_id=${encodeURIComponent(cursor ?? '')}`)
  const items = data?.items ?? []

  return {
    count: items.length,
    posts: items.map(shapePost).filter(Boolean),
    nextCursor: data?.max_id ?? null,
  }
}

export const search = async (session, query, type = 'user') => {
  if (!query) throw new Error('`query` is required')

  // The search drawer's own query, replayed as the page sends it. Instagram's REST search path
  // (`/api/v1/web/search/topsearch/`) is still called by the front end but is not routed for a
  // signed-in web session — it answers with the 404 * page, not an API error — so search goes
  // through GraphQL, where it returns `xdt_api__v1__fbsearch__topsearch_connection`.
  const data = await graphqlCaptured(session, DOC_ID.search, {
    data: {
      context: 'blended',
      include_reel: 'true',
      query,
      rank_token: '',
      search_session_id: randomUUID(),
      search_surface: 'web_top_search',
    },
    hasQuery: true,
  })

  // `igOk` hands back the whole GraphQL payload, so the connection sits one `data` further in
  // — the same double hop `fetchPosts` already makes, and reading it from the outer level is
  // how a query that answered with five users produced an empty list.
  const connection = data?.data?.xdt_api__v1__fbsearch__topsearch_connection ?? {}

  // Each collection wraps its node one level down (`{user: …}`, `{hashtag: …}`, `{place: …}`),
  // so the wrapper is unwrapped with the node kept as a fallback rather than assumed present.
  const users = (connection.users ?? [])
    .map(entry => shapeUser(entry?.user ?? entry))
    .filter(Boolean)

  const hashtags = (connection.hashtags ?? [])
    .map(entry => {
      const tag = entry?.hashtag ?? entry
      return { name: tag?.name ?? null, posts: tag?.media_count ?? null }
    })
    .filter(tag => tag.name)

  const places = (connection.places ?? [])
    .map(entry => {
      const place = entry?.place ?? entry
      const location = place?.location ?? place
      return { name: place?.name ?? location?.name ?? null, id: location?.pk ?? null }
    })
    .filter(place => place.name)

  if (type === 'hashtag') return { hashtags }
  if (type === 'place') return { places }
  if (type === 'all') return { users, hashtags, places }
  return { users }
}

// MARK: messaging
// ============================================================================

/**
 * A thread node from the direct inbox query, mapped defensively.
 *
 * The query itself is verified — it executes and returns `threads_by_folder.edges` — but this
 * account has no DM threads, so no node was ever observed to map against. The field names used
 * below are the ones Instagram's own direct schema uses everywhere else (`thread_id`,
 * `thread_title`, `users`, `items`), each read through its Relay-shaped alternative as well, so
 * a rename upstream shows up as a null field rather than an exception.
 */
const shapeGraphQLThread = edge => {
  const thread = edge?.node ?? edge ?? {}
  const users = thread.users?.edges?.map(entry => entry?.node ?? entry) ?? thread.users ?? []

  return {
    threadId: thread.thread_id ?? thread.id ?? null,
    title: thread.thread_title ?? thread.title ?? null,
    users: users.map(user => ({
      id: user.pk ?? user.id ?? null,
      username: user.username ?? null,
      fullName: user.full_name ?? null,
    })),
    unreadCount: thread.read_state === 'UNREAD' ? 1 : (thread.unread_count ?? 0),
    lastMessage: thread.items?.[0]?.text ?? thread.items?.[0]?.latest_message?.text ?? null,
    lastActivityAt: thread.last_activity_at ?? null,
    // Kept in full as well as flattened: `dm_read` needs every field of every item, and
    // reducing that list here would bake assumptions about a shape this account cannot show.
    rawItems: (thread.items ?? []).map(item => ({
      itemId: item.item_id ?? item.id ?? null,
      from: item.user_id ?? item.sender_id ?? null,
      type: item.item_type ?? item.type ?? null,
      text: item.text ?? item.latest_message?.text ?? null,
      timestamp: item.timestamp ?? null,
    })),
  }
}

/** Runs the inbox query for one folder. One doc_id answers both INBOX and PENDING. */
const directMailbox = async (session, folder) => {
  const data = await graphqlCaptured(session, DOC_ID.directInbox, { folder })
  // Same double hop as above: `igOk` returns `{data: …, extensions: …}`, not the inner object.
  const mailbox = data?.data?.get_slide_mailbox_for_iris_subscription?.threads_by_folder ?? {}
  return {
    threads: (mailbox.edges ?? []).map(shapeGraphQLThread),
    cursor: mailbox.page_info?.end_cursor ?? null,
    hasNext: mailbox.page_info?.has_next_page ?? false,
  }
}

export const dmList = async session => {
  const { threads, cursor, hasNext } = await directMailbox(session, 'INBOX')

  return {
    count: threads.length,
    unread: threads.reduce((sum, thread) => sum + (thread.unreadCount ?? 0), 0),
    threads,
    cursor,
    hasNext,
  }
}

export const dmRequests = async session => {
  const { threads, cursor, hasNext } = await directMailbox(session, 'PENDING')
  return { count: threads.length, threads, cursor, hasNext }
}

export const dmRead = async (session, threadId, limit = 25) => {
  if (!threadId) throw new Error('`thread_id` is required')

  // Messages ride along with the inbox query rather than being fetched per-thread: the
  // per-thread query needs a conversation opened in the browser to be captured, and this
  // account has no DM threads to open. Reading them back off the mailbox keeps `dm_read` working
  // for whatever the inbox already holds instead of depending on a capture that cannot be made.
  const { threads } = await directMailbox(session, 'INBOX')
  const thread = threads.find(entry => String(entry.threadId) === String(threadId))
  if (!thread) {
    throw new Error(
      `Thread ${threadId} is not in the inbox page the query returns. It may have scrolled off it — ` +
        'Instagram answers the direct mailbox as a single page, so older threads are not reachable from here.',
    )
  }

  return {
    threadId: thread.threadId,
    title: thread.title,
    users: thread.users,
    messages: (thread.rawItems ?? []).slice(0, limit),
  }
}

// MARK: search helpers used by publish tools
// ============================================================================

export const locationSearch = async (session, query) => {
  if (!query) throw new Error('`query` is required')

  const data = await call(
    session,
    `/api/v1/location_search/?search_query=${encodeURIComponent(query)}&rank_token=0.5`,
  )

  const places = data?.items ?? data?.venues ?? []
  return {
    places: places.map(place => ({
      id: place.location?.pk ?? place.pk ?? null,
      name: place.title ?? place.name ?? place.location?.name ?? null,
      address: place.subtitle ?? null,
    })),
  }
}

export const musicSearch = async (session, query, limit = 10) => {
  if (!query) throw new Error('`query` is required')

  const data = await call(session, `/api/v1/music/music_search/?query=${encodeURIComponent(query)}&limit=${limit}`)
  const tracks = data?.tracks ?? data?.items ?? []

  return {
    tracks: tracks.slice(0, limit).map(track => ({
      id: track.id ?? track.audio_asset?.id ?? null,
      title: track.title ?? track.audio_asset?.title ?? null,
      artist: track.artist?.name ?? track.audio_asset?.artist?.name ?? null,
      durationSec: track.duration_ms ? Math.round(track.duration_ms / 1000) : null,
    })),
  }
}

// MARK: identity resolution
// ============================================================================

/** Form-encodes a parameter bag, which is what every `/api/v1/…` write endpoint takes. */
const form = params =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')

/** POSTs a form body. Instagram answers these with the updated object, or an error envelope. */
const post = async (session, path, params) => call(session, path, { method: 'POST', body: form(params) })

/**
 * Turns "media id, shortcode, or URL" into a media id.
 *
 * Every media-scoped tool takes that triple, because callers have all three in hand — a
 * permalink copied out of a browser, a shortcode from an API response, or a raw id from a
 * listing tool. Resolving here keeps that duplication out of every handler.
 */
export const resolveMedia = async (session, value) => {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('`post` is required')

  // A bare media id is "<media>_<owner>" and needs no round trip.
  if (/^\d+_\d+$/.test(raw)) return raw

  const code = raw.includes('/')
    ? (raw.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? null)
    : /^[A-Za-z0-9_-]+$/.test(raw)
      ? raw
      : null

  if (!code) throw new Error(`"${raw}" is not a media id, shortcode, or post URL`)

  const data = await call(session, `/api/v1/media/shortcode/${encodeURIComponent(code)}/info/`)
  const id = data?.items?.[0]?.id
  if (!id) throw new Error(`No Instagram post found for "${raw}"`)
  return id
}

/** Turns "username, profile URL, or numeric id" into `{id, username}`. */
export const resolveUser = async (session, user) => {
  const raw = String(user ?? '').trim()
  if (!raw) throw new Error('`user` is required')

  if (/^\d+$/.test(raw)) return { id: raw, username: null }

  const handle = raw.includes('/')
    ? (raw.match(/instagram\.com\/([A-Za-z0-9_.]+)/)?.[1] ?? null)
    : raw.replace(/^@/, '')

  if (!handle) throw new Error(`"${raw}" is not a username, profile URL, or numeric id`)

  const profile = await fetchProfile(session, handle)
  return { id: String(profile.id), username: profile.username }
}

// MARK: comments
// ============================================================================

const shapeComment = comment => ({
  id: comment.pk ?? comment.id ?? null,
  text: comment.text ?? null,
  author: { id: comment.user?.pk ?? comment.user_id ?? null, username: comment.user?.username ?? null },
  likes: comment.comment_like_count ?? comment.like_count ?? 0,
  likedByYou: comment.has_liked_comment ?? false,
  replies: (comment.child_comments?.comments ?? comment.replies ?? []).map(shapeComment),
  createdAt: comment.created_at ?? null,
  parentId: comment.parent_comment_id ?? null,
})

export const listComments = async (session, { post, cursor = null } = {}) => {
  const mediaId = await resolveMedia(session, post)

  const data = await call(
    session,
    `/api/v1/media/${mediaId}/comments/?can_support_threading=true&child_comment_count=20&fetch_media_id=1` +
      `&max_id=${encodeURIComponent(cursor ?? '')}`,
  )

  const comments = data?.comments ?? []
  return {
    mediaId,
    count: comments.length,
    total: data?.comment_count ?? null,
    comments: comments.map(shapeComment),
    nextCursor: data?.has_more_comments ? (data?.next_max_id ?? null) : null,
  }
}

export const addComment = async (session, { post, text } = {}) => {
  const mediaId = await resolveMedia(session, post)
  if (!text) throw new Error('`text` is required')

  const data = await post(session, `/api/v1/media/${mediaId}/comments/`, {
    comment_text: text,
    is_in_video_mode: '0',
    can_support_threading: 'true',
  })

  const comment = data?.comment
  return {
    done: data?.status === 'ok' || comment != null,
    mediaId,
    comment: comment ? shapeComment(comment) : null,
  }
}

export const replyComment = async (session, { post, commentId, text } = {}) => {
  const mediaId = await resolveMedia(session, post)
  if (!commentId) throw new Error('`commentId` is required')
  if (!text) throw new Error('`text` is required')

  const data = await post(session, `/api/v1/media/${mediaId}/comments/`, {
    comment_text: text,
    // Threading is what makes this a reply rather than a fresh top-level comment.
    comment_thread_id: commentId,
    is_in_video_mode: '0',
    can_support_threading: 'true',
  })

  const comment = data?.comment
  return {
    done: data?.status === 'ok' || comment != null,
    mediaId,
    comment: comment ? shapeComment(comment) : null,
  }
}

export const deleteComment = async (session, { post, commentId } = {}) => {
  const mediaId = await resolveMedia(session, post)
  if (!commentId) throw new Error('`commentId` is required')

  const data = await post(session, `/api/v1/media/${mediaId}/comments/${encodeURIComponent(commentId)}/delete/`, {
    comment_ids: commentId,
  })

  return { done: data?.status === 'ok', mediaId, commentId }
}

export const likeComment = async (session, { commentId, unlike = false, mediaId = null } = {}) => {
  if (!commentId) throw new Error('`commentId` is required')

  // The like route is scoped by media, but `comment_like` only carries the comment id. When no
  // media id is in hand, use the media-less route rather than forcing an extra lookup round
  // trip on the caller for a field the tool never asked them for.
  const path = mediaId
    ? `/api/v1/media/${mediaId}/${encodeURIComponent(commentId)}/${unlike ? 'unlike' : 'like'}/`
    : `/api/v1/comments/${encodeURIComponent(commentId)}/${unlike ? 'unlike' : 'like'}/`

  const data = await post(session, path, {})
  return { done: data?.status === 'ok', commentId, unliked: unlike }
}

// MARK: follow, block, moderation
// ============================================================================

export const followUser = async (session, user) => {
  const target = await resolveUser(session, user)
  const data = await post(session, `/api/v1/friendships/create/${target.id}/`, { user_id: target.id })
  return { done: data?.status === 'ok', user: target, following: data?.friendship_status?.following ?? null }
}

export const unfollowUser = async (session, user) => {
  const target = await resolveUser(session, user)
  const data = await post(session, `/api/v1/friendships/destroy/${target.id}/`, { user_id: target.id })
  return { done: data?.status === 'ok', user: target, following: data?.friendship_status?.following ?? null }
}

export const removeFollower = async (session, user) => {
  const target = await resolveUser(session, user)
  const data = await post(session, `/api/v1/friendships/remove_follower/${target.id}/`, { user_id: target.id })
  return { done: data?.status === 'ok', user: target }
}

export const blockUser = async (session, user, unblock = false) => {
  const target = await resolveUser(session, user)
  const data = await post(session, `/api/v1/blocks/${unblock ? 'destroy' : 'block'}/${target.id}/`, {
    user_id: target.id,
  })
  return { done: data?.status === 'ok', user: target, blocked: !unblock }
}

export const likePost = async (session, value, unlike = false) => {
  const mediaId = await resolveMedia(session, value)
  const data = await post(session, `/api/v1/media/${mediaId}/${unlike ? 'unlike' : 'like'}/`, {
    media_id: mediaId,
    d: '0',
  })
  return { done: data?.status === 'ok', mediaId, liked: !unlike }
}

// MARK: published posts & profile
// ============================================================================

export const editPost = async (session, { post, caption = '' } = {}) => {
  const mediaId = await resolveMedia(session, post)

  const data = await post(session, `/api/v1/media/${mediaId}/edit_media/`, {
    caption_text: caption ?? '',
  })

  return { done: data?.status === 'ok', mediaId, caption: data?.caption ?? caption }
}

export const deletePost = async (session, { post } = {}) => {
  const mediaId = await resolveMedia(session, post)
  const data = await post(session, `/api/v1/media/${mediaId}/delete/`, {})
  return { done: data?.status === 'ok', mediaId }
}

export const updateBio = async (session, bio = '') => {
  // Read the current profile first so the edit sends every field Instagram expects, rather than
  // just the bio — a partial payload here silently clears whichever fields it omits.
  const current = await call(session, '/api/v1/accounts/edit/web_form_data/')
  const existing = current?.form_data ?? {}

  const data = await post(session, '/api/v1/accounts/edit_profile/', {
    first_name: existing.first_name ?? '',
    phone_number: existing.phone_number ?? '',
    external_url: existing.external_url ?? '',
    biography: bio ?? '',
    gender: existing.gender ?? '',
    email: existing.email ?? '',
  })

  return { done: data?.status === 'ok', bio: data?.biography ?? bio }
}

// MARK: activity
// ============================================================================

const shapeNotification = entry => ({
  type: entry.type ?? null,
  text: entry.args?.text ?? entry.story?.user?.username ?? null,
  timestamp: entry.timestamp ?? null,
  actor: entry.args?.profile_id
    ? { id: entry.args.profile_id, username: entry.args.username ?? null }
    : null,
  media: entry.media_id ? { id: entry.media_id, code: entry.code ?? null } : null,
})

export const listNotifications = async (session, { type = 'all', limit = 50 } = {}) => {
  const data = await call(session, '/api/v1/news/inbox/?already_seen=0')

  // Instagram buckets these by verb in one payload rather than serving a filterable feed, so
  // the filter is applied here. "mentions" is text-matched because there is no separate kind.
  const wants = {
    all: () => true,
    comments: n => /comment|replied|reply/i.test(n.text ?? ''),
    likes: n => /like/i.test(n.text ?? ''),
    follows: n => /follow/i.test(n.text ?? ''),
    mentions: n => /mention|tagged/i.test(n.text ?? ''),
  }

  const predicate = wants[type] ?? wants.all
  const notifications = (data?.stories ?? []).map(shapeNotification).filter(predicate)

  return {
    counts: data?.counts ?? null,
    total: notifications.length,
    notifications: notifications.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))),
  }
}

export const storyViewers = async (session, { storyId, cursor = null } = {}) => {
  if (!storyId) throw new Error('`storyId` is required')

  const data = await call(
    session,
    `/api/v1/media/${encodeURIComponent(storyId)}/story_viewers/?max_id=${encodeURIComponent(cursor ?? '')}`,
  )

  const viewers = data?.users ?? []
  return {
    storyId,
    total: data?.viewer_count ?? viewers.length,
    viewers: viewers.map(u => ({ id: u.pk, username: u.username, fullName: u.full_name })),
    nextCursor: data?.max_id ?? null,
  }
}

/**
 * Diagnostic: hit one raw path and report exactly what came back. Used to re-discover an
 * endpoint after Meta moves it, instead of guessing at the shape. `headers` exists so
 * competing values (notably `x-ig-app-id`) can be compared without editing the source.
 */
export const probe = async (session, path, method = 'GET', headers = {}, body = null, full = false) => {
  // GraphQL takes its payload as JSON, and its responses are large enough that a tight slice
  // would hide the field being looked for — so the diagnostic keeps more of the body than a
  // tool result would ever need to. `full` lifts the cap entirely, because a truncated
  // response is not merely incomplete but unparseable: the caller gets text it cannot JSON
  // parse and cannot tell apart from a non-JSON answer.
  // `full` is forwarded, not merely honoured locally: the content script truncates non-JSON
  // bodies on its side too, so asking only for a complete response here would still arrive
  // with the first 400 characters already chopped off.
  const result = await igFetch(session, path, { method, headers, body, full })
  const rendered = result.json ? JSON.stringify(result.json) : result.text
  return {
    status: result.status,
    ok: result.ok,
    // Which `x-ig-www-claim` the extension was actually carrying. Seeing this is how you tell
    // "the claim has been rotated by now" from "still sending the literal 0".
    claim: result.claim ?? null,
    respHeaders: result.respHeaders ?? null,
    body: full ? rendered : rendered?.slice(0, 8000),
  }
}
