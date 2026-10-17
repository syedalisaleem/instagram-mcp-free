# instagram-mcp-free

A drop-in, free implementation of the `@inssist/mcp` Instagram MCP server.

Same 60 tools, same names, same parameters, same descriptions — **no PRO paywall, no INSSIST
Chrome extension, no Meta Graph API.** It runs against a normal logged-in instagram.com session
in a browser window it controls.

---

## Install & use

Six steps, in order. Steps 3 and 4 run concurrently and must both stay alive.

```bash
npm install
npx playwright install chromium

npm run driver     # terminal A — must be running first
npm run browser    # terminal B — opens the window you sign into
npm run test       # terminal C — proves the whole chain
```

`npm run browser` opens Chrome on instagram.com. **Sign in there once**; the session persists
in `.ext-profile/`. If you already hold a `sessionid` cookie, hand it over instead of typing a
password:

```bash
IG_MCP_SESSIONID='<the cookie value>' npm run browser
```

It is read only from that variable, for that launch, and never written to disk.

**First launch takes about a minute longer.** With no GraphQL capture present, the launcher
records one itself by driving a few screens — that is what teaches the project the `doc_id`s
for search and direct messages, which Instagram publishes nowhere. Later launches skip it.

Then point an MCP client at the server:

```json
{ "mcpServers": { "instagram": { "command": "node", "args": ["src/mcp-server.mjs"] } } }
```

There is no toggle and no pairing step — the extension dials the driver the moment it loads.
If `npm run test` reports 60 tools and a live `account_info`, the agent can use every tool in
the list; anything genuinely unavailable says so in its answer rather than failing silently.

Chrome **outlives** the terminal that started it. To end the session, close the browser
window. `test:ext` launches its own browser from the same profile, so close the running one
before running it.

---

## How it works

`@inssist/mcp` (MIT, public) turned out to be **only a relay**:

```
agent  <--stdio MCP-->  @inssist/mcp  <--ws://127.0.0.1-->  INSSIST Chrome extension  --> instagram.com
```

The server contains **zero Instagram logic**. Every one of the 60 tools is executed by the
closed-source extension. The one gate between "any local process" and "the extension" is that
the WebSocket `Origin` header must start with `chrome-extension://` — which a Node client can
set freely.

So this project replaces the one piece that was never open-sourced — and does it in two ways,
picked automatically per call:

```
agent  <--stdio MCP-->  upstream @inssist/mcp (vendored, unmodified)
                          <--ws://127.0.0.1:48232-->  THIS driver
                                                        |
                                 <--ws://127.0.0.1:48233-->  extension/ in YOUR Chrome
                                                            --> instagram.com
                                                        |
                                                        `-> Playwright fallback (.chrome-profile/)
```

| Concern | Where it lives | Status |
|---|---|---|
| MCP plumbing, hub/peer, pacing, pairing | upstream `dist/` (MIT) | **vendored verbatim** |
| Tool contract (names/params/descriptions) | `tools-manifest.json` | **byte-identical** |
| `pro` flags / subscription gate | sent by the extension → **us** | **set `false` on all 60** |
| Actual Instagram work | closed-source extension | **reimplemented here** |

There is no server-side PRO check left to remove, because upstream never had one — the check
was always in the extension. Because *we* send the `manifest` frame, flipping `pro` removes both
the upsell text and the gate in one place.

### Two transports, one implementation

`IG_MCP_TRANSPORT` picks how a request is executed. Every tool is written once, against a
`session` handle, and both transports answer `{ok, status, json, text}` — so nothing in
`src/ig.mjs` knows which one is in use.

| Value | Behaviour |
|---|---|
| `auto` *(default)* | use the extension if it is attached, otherwise fall back to Playwright |
| `extension` | extension only — fails loudly rather than silently falling back |
| `playwright` | never touch the extension |

**The extension is preferred** because it runs inside your real Chrome with the session you
already have. `extension/` is a thin fetch proxy: it does exactly one thing — perform a
same-origin HTTP request on instagram.com — and the service worker is only a message router.
All 60 tool implementations stay in Node, so both transports share one code path.

Why an offscreen document owns the socket rather than the service worker: MV3 workers suspend
after ~30s idle and never reconnect on their own, so a socket held there dies silently.

---

## Status: 54 / 60 tools implemented

**Working — live against a signed-in session**

- Profile & feed: `account_info`, `account_switch`, `ig_fetch_profile`, `ig_fetch_posts`,
  `ig_fetch_post`, `ig_search`, `location_search`, `notifications_list`
- Engagement: `comments_list`, `comment_add`, `comment_reply`, `comment_delete`, `comment_like`,
  `ig_action`, `ig_block`, `follower_remove`, `ig_post_edit`, `ig_post_delete`, `profile_update`
- Publishing: `draft_create`, `draft_list`, `draft_get`, `draft_update`, `draft_delete`,
  `draft_reorder`, `draft_schedule`, `draft_publish`
- Direct messages (read): `dm_list`, `dm_read`, `dm_requests`
- Downloads & analysis: `downloads_start` / `downloads_status` / `downloads_cancel`,
  `insights_collect` / `insights_report`, `events_check`, `unfollowers_*`, `peers_*`

**Honest refusal rather than a fake answer**

- `growth_start` / `growth_status` / `growth_pause` / `growth_configure` / `growth_export` —
  INSSIST's growth automation runs against their own service. There is nothing to clone, so
  these say so instead of pretending a pacing loop is the same thing.
- `antibot_scan` / `antibot_report` / `antibot_export` — work, but from a documented local
  heuristic (follow-back rate, posting rhythm), not INSSIST's trained model. The output says so.

**Implemented, but Instagram no longer serves these on the web**

`ig_fetch_saved`, `music_search`, `ig_fetch_stories` ship with working code against endpoints
that now return Instagram's 404 page or its HTML shell instead of JSON. Each attempt is still
made — a query appearing in a future capture starts working with no edit here — but the failure
is re-explained to name the limit, because blaming a lost session sends the agent off to sign in
again for an answer that never changes. See `src/availability.mjs` for what was tried.

**Not implemented — 6 tools**

Answered with `{notImplemented: true, note: ...}` and **nothing sent to Instagram**, rather than
reporting a call that silently did nothing:

- `dm_send`, `dm_accept`, `dm_mark_seen`, `dm_remove` — the send/accept/seen/delete side of
  direct messages. The read side works (above); these are GraphQL *mutations*, and a mutation's
  `doc_id` only appears in a capture when the request actually fires — which means sending a real
  message. That was not done to this account to learn a number.
- `follow_requests_list` — Instagram's REST path `/api/v1/friendships/pending_requests/` is not
  routed for a web session, and no query for it appeared in a capture run across the inbox,
  profile, saved and search pages.
- `note_set` — same story: a write, needing a captured `doc_id` from a note actually posted.

---

## Running detail

The commands are in *Install & use* above. What is worth knowing beyond them:

- The driver holds the extension listener on **48233** and dials upstream on **48232**. Port
  **48231** is left alone deliberately — it belongs to a real `@inssist/mcp` if one is
  installed, and the driver refuses to silently join it. Diagnostics are on **48234**
  (`/status`, `/probe?path=…`).
- Chrome is started **detached** from the launcher and attached over CDP, which is why closing
  the terminal leaves the session running. Re-running `npm run browser` while one is already
  up reconnects rather than failing on the profile lock.
- Prefer your own Chrome? Load `extension/` unpacked — `chrome://extensions` → Developer mode →
  **Load unpacked**. Its profile carries its own session, so it behaves identically.

Then prove the surface:

```bash
npm run test:unit   # response classification — no browser needed
npm run test        # 60 tools, 0 PRO upsells, a real tool call round-trip
npm run test:ext    # the full chain through the extension, browser included
```

`test:ext` launches its own browser from `.ext-profile/`, so close the running one first —
Chrome holds the profile exclusively, and the test fails on the lock rather than on anything
about the extension.

Expected from `npm run test`:

```
tools/list -> 60 tools (paired after 3 probes)
tools carrying a PRO upsell: 0
account_info -> isError=false
```

`npm run test:ext` additionally asserts the browser half, and fails if any of these regress:

```
PASS: 60 tools advertised
PASS: no PRO upsells
PASS: account_info used the extension transport
PASS: driver saw the extension as connected
PASS: relay answered a real request (no dead-worker response)
PASS: errors are a sentence, not raw Instagram HTML
PASS: account_info explains a false loggedIn instead of just asserting it
PASS: smoke suite exited cleanly
```

It needs `npm run driver` already running, and it uses its own throwaway profile so it never
disturbs the login in `.ext-profile/`.

### Use it from an agent harness

Register the **server**; keep the **driver** running alongside it.

```json
{
  "mcpServers": {
    "ig-free": {
      "command": "node",
      "args": ["<this repo>/src/mcp-server.mjs"],
      "env": { "IG_MCP_PORT": "48232" }
    }
  }
}
```

The port is one shared knob (`IG_MCP_PORT`). Both halves read it. **Leave it at 48232** —
48231 belongs to a real `@inssist/mcp` instance if one is installed, and the driver refuses to
silently join it. The extension listener has its own knob, `IG_MCP_EXT_PORT` (48233).

### The Playwright fallback

If no extension is attached, `auto` falls back to a Chromium window on `.chrome-profile/` and
the first tool call opens it. Log in there if you want reads without the extension. It is a
separate profile from `.ext-profile/`, so the two never share a session.

Use a separate `IG_MCP_PROFILE` directory per account — there is no `account_switch`, because
one driver is one browser profile.

---

## Notes & caveats

- **Instagram's private web API is undocumented.** Every helper goes through one `call()` so a
  shape change surfaces as a readable error instead of a crash, and `_probe` exists to
  re-discover a moved endpoint. Instagram also answers API paths with **whole HTML pages**
  (login wall, 404) whenever it thinks you're signed out — sometimes with HTTP 200. `igOk`
  recognises that and returns one sentence instead of shipping markup to your agent.
- **Two kinds of endpoint, and they fail differently.** The `/api/v1/…` paths answer with JSON
  and die loudly. The GraphQL ones (`/api/graphql`, `/graphql/query`) take a `doc_id` that
  Instagram publishes nowhere, rotates without notice, and refuses by returning **HTTP 200
  containing the site's own HTML page** — no error, nothing naming a missing field. Search and
  the direct inbox were both blocked on this until the requests were replayed verbatim instead
  of reconstructed: the page sends ~25 form fields (`fb_dtsg`, `jazoest`, `lsd`, `__dyn`, `__hs`)
  plus `x-fb-lsd`, and guessing at those tokens is unwinnable. So a capture run records them
  into `scripts/captured-graphql.json`, and `src/ig.mjs` sends the captured body back with only
  `doc_id` and `variables` replaced. **If a tool starts answering with an HTML page, re-run
  `IG_MCP_GQL=1 npm run browser`, open the page in question, and the tokens are refreshed.**
- **`chrome.storage` is unavailable inside an offscreen document** — it reads back as
  `undefined` there even with the permission granted, while working normally in the service
  worker. Persistence is therefore brokered through the worker (`driver-config` /
  `driver-state`), and the offscreen message listener is registered *before* anything else runs
  so a document that dies partway can still report why via `{cmd:'status'}`. Both are load-bearing;
  either one removed and a broken extension is indistinguishable from an unpaired one.
- **Chrome can keep serving a previous copy of extension code** from a profile it already
  knows. If you edit `extension/` and the old behaviour persists, delete the profile directory
  (`.ext-profile/`) and reload — it holds only cookies, which you'd have to sign into again.
- **It automates your own account in your own browser** — the same thing INSSIST does. That can
  still conflict with Meta's automation terms, and heavy write-automation can earn an action
  block. Read tools are low-risk; batch writes are not.
- **Rate limits are real.** 429s are surfaced as such, not retried.

## Licensing

The vendored `vendor/inssist-mcp/` is upstream `@inssist/mcp` v2.0.0 under the MIT License —
`vendor/inssist-mcp/LICENSE` is retained as required, with `UPSTREAM-README.md` alongside it.
This project's own code is MIT too.
