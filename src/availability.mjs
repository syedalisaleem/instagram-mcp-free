/**
 * Precise failures for tools whose Instagram feature a web session cannot reach.
 *
 * These three ship with working code and dead endpoints. Left alone they fail through `igOk`,
 * whose message is tuned for the common case — an HTML answer usually means the login wall —
 * so an agent reading it would correctly conclude it should go sign in, then call again and get
 * the identical answer. That is worse than a failure: it sends the next action somewhere
 * pointless.
 *
 * Each note below states what was actually tried, what each attempt answered, and that
 * retrying is not the fix. Nothing here claims the feature is impossible forever; a capture run
 * that finally reaches the page could still find a query for it, so each says what to do
 * instead of guessing.
 */

/** The exact wording is the product: it has to stop a retry loop and name the real limit. */
const note = (what, attempts) =>
  `${what} cannot be read from a signed-in web session. ` +
  `The browser this driver drives reaches instagram.com the way a person does, and ` +
  `${attempts} ` +
  `Nothing here will start working by retrying or by signing in again — this is a limit of what ` +
  `Instagram exposes on the web, not a lost session. Re-run \`IG_MCP_GQL=1 npm run browser\` ` +
  `and open the page in question if you want to hunt for a query Instagram has since added.`

export const savedUnavailable = () =>
  note(
    'The saved-posts feed',
    'the REST path `/api/v1/feed/saved/` answers HTTP 400 `{"message":"useragent mismatch"}` ' +
      'for every header set tried (web app id, Android app id, plus added `x-instagram-ajax` and ' +
      '`x-web-session-id`), `/api/v1/saved/feed/` and `/api/v1/feed/saved/collections/` return ' +
      "Instagram's 404 page, and a capture run taken across the Saved page recorded no GraphQL " +
      'query backing it.',
  )

export const musicUnavailable = () =>
  note(
    'Music search',
    "`/api/v1/music_search/`, `/api/v1/web/search/music/` and `/api/v1/music_search/?query=` " +
      "all return Instagram's 404 page rather than JSON, and no audio-browser query appeared in " +
      'the capture because the picker was never opened there.',
  )

export const storiesUnavailable = cause =>
  note(
    'Story media',
    "`/api/v1/feed/user/{id}/story/` answers with Instagram's page shell — HTTP 200 containing " +
      'HTML, not API JSON — while the profile lookup it performs first is separately rate ' +
      `limited${cause ? ` (this call ended on: ${cause})` : ''}. The captured reels-tray query ` +
      'reports which accounts have stories but does not carry their media.',
  )

/**
 * Picks between the real cause and the structural one.
 *
 * A rate limit, an expired session or a disconnected bridge are transient — they name an action
 * worth taking and a moment later, so replacing them with "this cannot be read" would send the
 * agent away from the actual fix. Only the structural HTML wall gets the long note. Anything
 * unrecognised is passed through unchanged, because a message that has not been understood yet
 * is more useful than one that has been reinterpreted.
 */
export const structural = (error, explain) => {
  const cause = String(error?.message ?? error)
  return /rate limited|not logged in|not connected|no response|timed? ?out/i.test(cause)
    ? error
    : new Error(explain(cause))
}
