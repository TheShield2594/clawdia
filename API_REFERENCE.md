# Clawdia HTTP API Reference

Every HTTP endpoint the bot serves, who may call it, and what it does.

This is the dashboard's own API. It is not a public API and there are no API
keys: every call is authenticated by the Discord OAuth session cookie the
dashboard sets, and authorized against the guilds that session administers. The
dashboard's own JavaScript is the only client it was built for, and anything
else calling it has to carry a browser session.

To *write* an endpoint rather than call one, see
[docs/EXTENDING.md](docs/EXTENDING.md#adding-api-endpoints).

## Where it lives

| | |
| --- | --- |
| Base URL | `DASHBOARD_URL`, or `http://localhost:$DASHBOARD_PORT` (3000 by default) |
| Mount point | `/api` — every path below already includes it |
| Source | `src/dashboard/routes/api/`, one file per feature, mounted by `routes/api.js` |
| Request bodies | JSON, except the image uploads, which are `multipart/form-data` |
| Responses | JSON, except the image reads, which return the image bytes |

## Authentication

Log in at `/auth/discord`; the OAuth callback sets a session cookie backed by
MongoDB. Every route below except the two image reads is behind `checkAuth`,
which answers `401 {"error": "Unauthorized"}` to a request without a session.

## Authorization

Routes with a `:guildId` are behind `checkGuildAccess`, which applies two gates
in cost order:

1. **The session's own guild list.** Free to read, and rejects anyone who was
   not an administrator of this guild when they logged in.
2. **Discord, live.** The session's guild list is a snapshot taken once at OAuth
   time, so on its own it would hand a demoted or kicked admin full write access
   until their cookie expired. The second gate asks Discord whether they still
   administer the guild.

Either gate answering *no* is `403 {"error": "Forbidden"}`. A gate that cannot
answer — a Discord outage — falls through to the snapshot rather than to a 403,
deliberately: the alternative is that an unrelated Discord incident locks every
operator out of their own dashboard. Only a definite *no* denies.

## Cross-origin writes

Every `POST`, `PUT`, `PATCH` and `DELETE` passes `checkCsrfOrigin` before its
route runs. There is no CSRF token; the check is on the headers a browser sends
and a cross-site page cannot forge:

- an `Origin` header matching the dashboard's own origin passes;
- an `Origin` from anywhere else is rejected;
- no `Origin` at all passes only with `Sec-Fetch-Site: same-origin` or `none`.

Anything else — a stray proxy, a scripted client, a browser sending neither
header — gets `403 {"error": "Forbidden: cross-origin request rejected"}`. The
Fetch standard requires browsers to send `Origin` on every non-`GET` request, so
a real dashboard write always carries one.

## Rate limits

| Scope | Limit | Counted per |
| --- | --- | --- |
| Reads (`GET`, `HEAD`) | 120 / minute | session, or IP when unauthenticated |
| Writes | 60 / minute | session |

Both answer `429 {"error": "Too many requests. Please slow down."}`. The read
limit is applied router-wide and the write limit per route, which is why
`write limit` appears in the table below and a read limit does not: it is on
everything.

The two budgets are counted separately and a route can be in both. `GET` rows
carrying `write limit` are not a mistake in the table: the member search and
resolve lookups are reads that each cost a Discord call, so they are charged to
the write budget as well as the read one. The ceilings are well above what the dashboard itself asks for — a
page load fires a handful of requests, not a hundred — and exist because several
reads are expensive: `/stats` and `/insights` each run collection-wide
aggregations.

## Errors

Failures are a JSON object with an `error` string. Handlers catch their own
exceptions; anything that still escapes is caught by the terminal error
middleware, because the dashboard shares a process with the gateway and an
escaped error would take the bot down with it.

| Status | Means |
| --- | --- |
| `400` | The request body or a query parameter failed validation; `error` names the field |
| `401` | No session |
| `403` | Not an administrator of this guild, or a rejected cross-origin write |
| `404` | No such guild, entry, member or case |
| `409` | The same operation is already in flight for this guild |
| `429` | Rate limited |
| `500` | Unhandled server error; the detail is in the bot's logs, not the response |
| `503` | Discord refused a request the route depends on, usually a missing bot permission |

## Endpoints

The **Requires** column lists what a caller must satisfy beyond the read limit:

- **session** — logged in (`checkAuth`)
- **guild admin** — administers this `:guildId`, verified live (`checkGuildAccess`)
- **write limit** — counts against the 60/minute write budget
  (`checkWriteRateLimit`), on top of the read limit when the route is a `GET`
- **multipart** — body is `multipart/form-data` with an `image` file part
- **public** — no session needed; the image reads are served to `<img>` tags

<!-- BEGIN GENERATED ENDPOINTS — npm run docs:api -->

_Generated by `npm run docs:api` from `src/dashboard/routes/api/` — 46 endpoints. Edit the routes and their comments, not this table._

### `settings.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `POST` | `/api/guild/:guildId/settings` | session, guild admin, write limit | Applies a patch of guild settings, rejecting any key outside the allow-list |

### `stats.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/stats` | session, guild admin | The dashboard's headline numbers for a guild: members, messages, coins in circulation, top levels and average XP |
| `GET` | `/api/guild/:guildId/insights` | session, guild admin | Derived analytics: 7 and 30 day retention, activity by hour, and command usage |

### `autorole.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `POST` | `/api/guild/:guildId/autorole` | session, guild admin, write limit | Adds a role to the set every new member is given on join |
| `DELETE` | `/api/guild/:guildId/autorole/:roleId` | session, guild admin, write limit | Stops giving a role to new members on join |

### `reactionRoles.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `POST` | `/api/guild/:guildId/reactionrole/panel` | session, guild admin, write limit | Posts a reaction role panel to a channel and stores its emoji-to-role mappings |
| `DELETE` | `/api/guild/:guildId/reactionrole/panel/:messageId` | session, guild admin, write limit | Deletes a reaction role panel, both the stored mappings and the Discord message |

### `rss.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `POST` | `/api/guild/:guildId/validate-feed` | session, guild admin, write limit | Checks that a URL is a fetchable RSS or Atom feed before it is subscribed to |
| `POST` | `/api/guild/:guildId/rss/add` | session, guild admin, write limit | Subscribes a channel to an RSS or Atom feed |
| `POST` | `/api/guild/:guildId/dailynews/trigger` | session, guild admin, write limit | Sends the configured daily news digest now, refusing while one is already in flight |
| `DELETE` | `/api/guild/:guildId/rss/:index` | session, guild admin, write limit | Unsubscribes from the feed at a position in the guild's feed list |

### `knowledgeBase.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/knowledge-base` | session, guild admin | The guild's 100 most recent knowledge base entries, newest first |
| `POST` | `/api/guild/:guildId/knowledge-base` | session, guild admin, write limit | Adds a knowledge base entry the AI can draw on, with up to 10 tags |
| `DELETE` | `/api/guild/:guildId/knowledge-base/:entryId` | session, guild admin, write limit | Deletes one knowledge base entry |
| `PUT` | `/api/guild/:guildId/knowledge-base/:entryId` | session, guild admin, write limit | Replaces one knowledge base entry's title, content and tags |

### `summaryJobs.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/summary-jobs` | session, guild admin | The guild's scheduled channel summary jobs, oldest first |
| `POST` | `/api/guild/:guildId/summary-jobs` | session, guild admin, write limit | Schedules a daily channel summary, up to 10 per guild |
| `DELETE` | `/api/guild/:guildId/summary-jobs/:jobId` | session, guild admin, write limit | Deletes one scheduled summary job |

### `dailyDigest.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/daily-digest` | session, guild admin | The guild's AI daily digest settings |
| `PUT` | `/api/guild/:guildId/daily-digest` | session, guild admin, write limit | Updates the daily digest: on/off, target and source channels, and the local time it is posted |

### `ai.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `POST` | `/api/guild/:guildId/persona` | session, guild admin, write limit | Creates or replaces the AI persona — name and system prompt — for one channel |
| `DELETE` | `/api/guild/:guildId/persona/:channelId` | session, guild admin, write limit | Removes a channel's persona, returning it to the guild's default system prompt |
| `GET` | `/api/guild/:guildId/ai/usage` | session, guild admin | Token and request usage for the last `?days=` (1-90, default 14), plus the configured rate limits |

### `mcpServers.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/mcp-servers` | session, guild admin | The guild's MCP servers, the operator's global ones, the presets, and whether editing is allowed at all |
| `PUT` | `/api/guild/:guildId/mcp-servers/:name` | session, guild admin, write limit | Creates or replaces one guild MCP server: URL, token, and its tool allow and block lists |
| `DELETE` | `/api/guild/:guildId/mcp-servers/:name` | session, guild admin, write limit | Removes one guild MCP server |
| `POST` | `/api/guild/:guildId/mcp-servers/:name/test` | session, guild admin, write limit | Makes a real request through one MCP server and reports whether it connected |

### `members.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/members/search` | session, guild admin, write limit | Up to 10 members matching `?q=` (2 characters or more), for the dashboard's member pickers |
| `GET` | `/api/guild/:guildId/members/resolve` | session, guild admin, write limit | Resolves up to 50 comma-separated user ids in `?ids=` to names and avatars |

### `achievements.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `POST` | `/api/guild/:guildId/achievements/grant` | session, guild admin, write limit | Grants one of the guild's custom achievements to a member, with its XP and coin rewards |

### `itemImages.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/item-image/shop/:guildId/:itemId` | public | Serves a guild shop item's image |
| `POST` | `/api/item-image/shop/:guildId/:itemId` | session, guild admin, write limit, multipart | Stores the image shown for a guild shop item, replacing any existing one |
| `DELETE` | `/api/item-image/shop/:guildId/:itemId` | session, guild admin, write limit | Removes a guild shop item's image |
| `GET` | `/api/item-image/activity/:guildId/:itemId` | public | Serves a guild's activity item image, falling back to the shared pre-#561 one |
| `POST` | `/api/item-image/activity/:guildId/:itemId` | session, guild admin, write limit, multipart | Stores one guild's activity item image, replacing any existing one |
| `DELETE` | `/api/item-image/activity/:guildId/:itemId` | session, guild admin, write limit | Removes one guild's activity item image |

### `moderation.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/cases` | session, guild admin | One page of moderation cases, filterable by `?type=` and `?status=` |
| `PATCH` | `/api/guild/:guildId/cases/:caseId` | session, guild admin, write limit | Adds a moderator note to a case, or closes it with a resolution |
| `GET` | `/api/guild/:guildId/sanctions/active` | session, guild admin | Up to 200 active bans and 200 active timeouts, read live from Discord |
| `POST` | `/api/guild/:guildId/sanctions/unban/:userId` | session, guild admin, write limit | Lifts a ban, attributing it to the dashboard user, and writes an audit entry |
| `POST` | `/api/guild/:guildId/sanctions/untimeout/:userId` | session, guild admin, write limit | Clears a member's timeout, attributing it to the dashboard user, and writes an audit entry |

### `economy.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/economy/stats` | session, guild admin | Economy overview: richest members by net worth, coins in circulation, the count of members who worked, claimed a daily or fished in the last 7 days, and the top commands |
| `POST` | `/api/guild/:guildId/economy/adjust` | session, guild admin, write limit | Gives, takes, resets, freezes or unfreezes one member's balance, and writes an audit entry |

### `leveling.js`

| Method | Path | Requires | Summary |
| --- | --- | --- | --- |
| `GET` | `/api/guild/:guildId/leveling/leaderboard` | session, guild admin | One page of 25 members ranked by level then XP |
| `POST` | `/api/guild/:guildId/leveling/adjust` | session, guild admin, write limit | Gives, takes, resets or sets one member's XP or level |
| `POST` | `/api/guild/:guildId/leveling/xp-event` | session, guild admin, write limit | Starts a timed XP multiplier event, replacing any event already running |

<!-- END GENERATED ENDPOINTS -->

## Keeping this file honest

The tables above are generated by `npm run docs:api` from the routers
themselves. Method, path and the **Requires** column are read off each route's
middleware chain; the summary is the one-sentence `//` comment above it, so it
lives with the handler and is read by whoever edits it next.

A route with no comment above it fails the generator rather than being rendered
blank, and `tests/apiDocs.test.js` compares this file against a fresh render, so
adding, moving or renaming a route turns `npm test` red until `npm run docs:api`
has been run. This file
was previously a set of Express snippets whose only endpoint example was a
`/api/custom/:guildId` that has never existed ([#711]); a hand-maintained list of
46 routes drifts the week it is written, so it is no longer hand-maintained.

[#711]: https://github.com/TheShield2594/clawdia/issues/711
