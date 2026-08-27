# Changelog

Clawdia follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
Every released version gets an entry here and a `v`-prefixed git tag, which is
what CI turns into a versioned container image — see [docs/RELEASING.md](docs/RELEASING.md).

Each entry records the **schema migration high-water mark**: the last migration
in `src/migrations/` that a deployment of this version will have run. That
mapping is the point of the file. Migrations here are destructive and
forward-only, so knowing which migrations a given image has applied is what
makes a rollback decision possible at all — you cannot roll back to a version
whose schema predates a migration that has already run.

`npm test` fails if the newest entry below does not name both the current
`package.json` version and the highest-numbered migration on disk.

## [4.4.0] - 2026-08-27

Migrations through `018_encrypt_guild_ai_keys`.

Welcome cards no longer stall the gateway on a join raid (#592). `canvas.toBuffer()`
is the fully synchronous encode — roughly 10 ms for the 800×300 card, more once a
real avatar is composited — and it ran on every `guildMemberAdd` with no
concurrency cap and no rate limit, which made the heaviest load pattern the bot
has also the one that blocks the event loop. The cards in `utils/cardGenerator.js`
now use node-canvas's callback form, which encodes on libuv's thread pool, and
welcome-card rendering goes through `utils/cardRenderQueue.js`: at most two
renders at a time, at most eight waiting, and at most twenty cards per guild per
minute. Past any of those the join gets the plain welcome embed the handler
already had, so a raid costs an embed per member rather than a canvas encode.

Per-guild AI provider keys can be encrypted at rest (#564). `ai.openaiKey` and
its three siblings are live credentials stored as plain strings in MongoDB, and
the `backup` service writes unencrypted `mongodump` archives into a host bind
mount nightly and keeps a month of them — so reading them needed access to a
directory, not to the database. Set the new **`SECRET_ENCRYPTION_KEY`**
(`openssl rand -base64 32`) and they are stored AES-256-GCM sealed instead;
`018_encrypt_guild_ai_keys` rewrites the keys already stored, and
`npm run secrets:encrypt` runs the same sweep for an operator who sets the
variable after that migration has run. It is opt-in: with the variable unset
nothing changes, the migration is a logged no-op, and reads accept plaintext
either way. **One rollback caveat**: an image from before this release reads a
sealed key as though it were the credential. If you enable encryption and later
roll back, run `npm run migrate:rollback -- 018_encrypt_guild_ai_keys` first
(it needs the same key), or the affected servers fall back to the bot-wide
`*_API_KEY` variables until they re-enter theirs.

The two item-image reads are authenticated now (#565).
`GET /api/v1/item-image/{shop,activity}/:guildId/:itemId` served any guild's
uploaded artwork to anyone who could guess a guild id and an item id. They were
public on the reasoning that a browser rendering an `<img>` cannot present a
session, which is not true of these: every request comes from a dashboard page
on the dashboard's own origin and carries the cookie, and Discord embeds these
images as uploaded attachments rather than by URL. They now take the same
`checkAuth` + `checkGuildAccess` as every other guild-scoped route, and answer
`Cache-Control: private`.

And logging out is a `POST` (#566). `GET /auth/logout` changed session state,
so `<img src="…/auth/logout">` on any page an admin visited ended their session.
The route is `POST` behind the existing origin check, and the dashboard's two
Logout controls submit a form. Nuisance-level only — nothing was ever disclosed
— but a bookmark or script hitting the old `GET` now gets a 404.

## [4.3.1] - 2026-08-26

Migrations through `017_merge_slots_jackpot_pool`.

The casino ran two progressive jackpot pools at once and called them the same
thing. `/casino jackpot` reported `casinoJackpot.pool` — seeded at 10,000, fed
0.5% of every casino bet, dropped on a random per-bet trigger that grows as bets
accumulate. `/casino slots` reported `slots.jackpotPool` under the label
"🏆 Jackpot Pool" — seeded at 5,000, fed a flat 10 per spin, won on Triple Wild.
A single spin paid into both, and each embed showed its own total, so a player
who checked the jackpot and then spun was told two different figures for what
reads as one prize.

Slots now plays for the shared pool like every other game: it reads that pool
for its embeds, and a Triple Wild claims it outright — a second and rarer
trigger (about 1 in 16,600 spins) for the same pot, reseeding it at 10,000
rather than 5,000. Migration `017_merge_slots_jackpot_pool` folds each guild's
retired slots pool into the progressive one. Only the balance above the old
5,000 seed carries over; Mongoose stamped that default onto every Guild document
it ever created, so carrying the whole figure would mint coins into servers that
never spun a reel. The migration is irreversible — the per-guild split is unset,
not recorded — though a rollback to a pre-merge image still runs, since that
build's schema carries its own default.

Two payout bugs went with it. The slots jackpot broadcast announced the pool as
it stood *before* the spin while crediting the amount claimed atomically at the
moment of the win, so two concurrent winners were each told the wrong number;
it now announces what was actually paid. And a coin booster multiplied a jackpot
win, minting the difference — the pool is a fixed pot of other players' coins,
not a multiple of the bet, so it is now exempt. Separately, a jackpot credit that
fails and rolls the pool back clears the winner fields, which the restart
reconciler in `events/ready.js` otherwise pays out a second time.

## [4.3.0] - 2026-08-24

Migrations through `016_fishing_tournament_status_index`.

The dashboard API is mounted at `/api/v1` and answers one response shape per
kind of response. The unversioned `/api` stays mounted beside it as an alias to
the same router, so a browser holding a cached bundle and anything scripted
against an instance keeps working; the response *bodies* of five endpoints did
change, and a script reading them needs updating. See
[API_REFERENCE.md](API_REFERENCE.md#response-shapes).

- **One envelope, and a version** (#582). Bare arrays, `{entries,…}`,
  `{cases,…}`, bare objects and `{success:true,…}` all coexisted, so a caller
  had to learn each endpoint separately. A list is `{ items, page, limit, total,
  pages }` now — `items` for every endpoint, built by
  `src/dashboard/lib/apiPage.js` — a single resource is the object itself, and a
  write is `{success:true,…}`. No endpoint answers with a bare JSON array, which
  is the shape that cannot grow a field later without breaking every caller.
- **The knowledge base and summary job lists page** (#583). The knowledge base
  had a hard `.limit(100)` and no cursor, so a guild's hundred-and-first entry
  was not on a later page — it was unreachable through the API, and unremovable
  through the dashboard that lists it. Summary jobs were unbounded. Both take
  `?page=` and `?limit=` now, and the knowledge base panel has a pager.
- **A mistyped snowflake no longer creates a phantom member** (#584). The
  economy and leveling admin adjust endpoints passed `upsert: true`. A Discord
  snowflake carries no checksum, so a typo is still a well-formed id: the
  adjustment created a member document for someone who may not exist and
  reported success, while the coins went somewhere nobody could see. Both
  return `404` when no member document matches.
- **The Guild schema is the single home for its indexes** (#576). The model
  declared one thing — `unique` on guildId — while migration 001 created two
  more on the same collection, so "what is indexed on guilds" had no single
  answer, and the two halves had drifted: 001's `idx_giveaways_active` covers
  paths (`giveaways.ended`, `giveaways.endsAt`) that no query filters on any
  more, because the giveaway sweep was rewritten. `015_drop_dead_giveaway_index`
  drops it. Five indexes are declared in the schema in its place, covering the
  giveaway, RSS, temp voice, dynamic pricing and bank district sweeps; each is
  partial or sparse, so guilds with the feature off cost nothing to index.
- **MCP connections work with whichever model you picked**, not only Claude.
  Anthropic's connector opens these connections on their side, so the feature
  was Anthropic-only; the bot is an MCP client of its own now
  (`src/services/ai/mcp/`), offering the same servers' tools to OpenAI, Gemini,
  Ollama and OpenRouter as functions, running the calls and feeding the results
  back. A connection is configured once and survives a change of provider. The
  Connections tab gained presets beyond GitHub — Fastmail, DeepWiki, Context7,
  Hugging Face and Stripe, plus Gmail and Spotify prefilled apart from an
  address neither of them publishes — and its **Test** button connects to the
  server itself: no AI provider key, no tokens spent, and it reports the tool
  names, which is what the allow and deny lists want filling in from.
- **A reply that calls MCP tools says so, and gets there faster.** A tool round
  produces no text, so the message sat on an ellipsis for as long as somebody
  else's HTTP request took, and the finished answer never said a tool had run
  at all — which made a slow reply look like a stuck bot and a reply from an
  unreachable server look like a confidently wrong model. The streamed message
  now carries a line naming the tool in flight, and the finished reply keeps a
  summary of what ran, how long each call took, what failed, and which servers
  could not be reached. Two waits were also being spent one after another and
  are now spent at once: the servers are all dialled together at the start of a
  turn instead of one handshake after another before the model sees a token,
  and the calls the model asks for in a single round run concurrently, so a
  round costs its slowest call rather than the sum of them. Names coming back
  from a server are stripped to plain text before they go in a message, so
  nothing a server calls a tool can open markup or ping a role.
- **A tool that writes something can be made to wait for a person.** The block
  list covers tools nobody should ever call; there was nothing for the ones a
  guild wants available but not unattended — filing an issue, sending a mail,
  moving a calendar event. Connections gained an approval setting, and a tool it
  applies to posts **Run it** / **Cancel** in the channel and does not run until
  the person who asked, or anyone who can manage the server, clicks. Nobody
  answering within a minute is the same answer as Cancel, and either way the
  model is told in words it can carry on from rather than left with a tool
  result that never arrived. The two middle modes read the annotations a server
  publishes about its own tools, so they are worth exactly what the server is
  honest about — they differ over a tool that annotates nothing, which
  `destructive` believes and `writes` asks about anyway. The per-connection
  *Always ask before these tools* list asks the server nothing and is the one to
  use when the answer has to be a guarantee. The default is off, so a guild that
  sets nothing behaves as it did.
- **The Connections tab says what the connections have been doing.** The Test
  button answers "does this work right now", which is the half that was never
  the problem: a server that passed its test and has been timing out on every
  turn since looked identical from the dashboard. Tool calls are now kept as a
  daily per-server, per-tool rollup — calls, failures, refusals, average latency
  and the last error a server gave — and shown under the connection list, with
  turns where a server could not be reached counted separately from turns where
  nobody used it. Test also reports what each tool says about itself and how
  many of them the guild's approval setting would stop.
- **Claude can use the bot's MCP client instead of Anthropic's connector.**
  Anthropic is the one provider whose API takes the server list itself and opens
  the connections on their side. That is cheaper — no tool loop runs in the bot
  at all — and it is blind: the bot never sees the calls, so everything the bot
  does with a call is missing. Approval prompts, the tool line in the reply, the
  activity ledger and the result caps all exist because the bot is the one
  making the call, and on the connector none of them can. A guild that turned
  approvals on and then picked Claude in the Chat tab would have lost them
  without being told. Connections gained a route setting, defaulting to
  automatic: Anthropic's connector, unless the guild has asked for something
  only the client route can do, in which case the same tool loop every other
  provider uses runs against the same servers. `connector` and `client` are
  there to override that either way, and the panel says which one automatic
  currently resolves to rather than leaving an admin to work it out.
- **`/ai mcp` answers from the channel what the dashboard answers from a
  browser.** `servers` lists the connections and what the approval setting and
  the Claude route would actually do to them, `tools` and `test` run the same
  handshake the dashboard's Test button runs, and `activity` shows the same
  seven-day rollup. All four need Manage Server and answer privately. It is a
  subcommand group on `/ai` rather than four commands of its own, because
  Discord registers at most a hundred and the count is pinned.
- **A tool that answers with a picture gets to show it.** Every non-text block
  became `[image content omitted]` — the one thing a Discord bot is better
  placed to do than any other MCP client, thrown away. A chart, a screenshot or
  a PDF page now arrives in the channel as a file, and the model is told one
  did, so it can refer to it rather than answering as though the tool returned
  nothing. Only a small known set of media types is accepted, and only within
  a size and count a reply can carry: this is a third party's server handing
  bytes to a bot that can post files, so anything else is reported as omitted
  exactly as before.
- **A preamble no longer runs into the answer after it.** A round that calls
  tools usually says something first, and the answer arrives in the round after
  it — two pieces of prose that were being concatenated into one sentence
  colliding with another. They are separated now, and the non-streaming paths
  keep the preamble rather than dropping it, so turning streaming off no longer
  changes what the reply says.
- **A guild running MCP with actions off was being told nothing about where
  tool results come from.** The rule — text arriving from a connected server is
  reference data, never an instruction — lived inside the in-channel actions
  addendum, so it only reached the model when a guild had actions switched on.
  That is the wrong half: a model with actions off can still be talked into
  calling another tool. It is its own addendum now, attached whenever there is a
  server to reach, and it picks up the ACTION sentence only where there is an
  action to be talked into. Every tool result is also labelled with the server
  and tool it came from, so the rule has something to point at and the model has
  the words to say "the github server returned…" rather than asserting it.
- **A turn's tools cannot cost unbounded time or context.** Every limit in the
  toolkit bounded one call and none of them composed: four rounds of six calls,
  each returning six thousand characters inside a forty-five second timeout, is
  a hundred and forty thousand characters and several minutes of a Discord
  message sitting on an ellipsis. There is a ceiling on the whole turn's tool
  output now — past it a call still runs, since the model may want the side
  effect, but what comes back says the output did not fit — and a wall-clock
  budget after which no further call is dialled and no approval prompt is put in
  front of anyone for a call that will not happen either way.
- **A rate-limited server gets waited out rather than reported as broken.** The
  shared servers rate-limit without a key, and a 429 saying "try again in two
  seconds" was becoming a failed tool call. It is retried once now, and only
  when the server said how long and the wait is short enough for a reply to sit
  through — a server asking for a minute is telling us to come back later.
- **A dropped stream no longer re-runs the tools it already ran.** The retry
  that covers a provider dropping mid-reply re-enters the whole turn, and a turn
  that had already filed an issue would file a second one — and put a second
  approval prompt in front of whoever approved the first. Harmless while MCP was
  read-mostly; not harmless now that a tool can write. A turn that has touched a
  tool is no longer retried, and the user is told what failed instead. A turn
  that has not, or that only met an unreachable server, still gets its retry.
- **Fishing tournaments are indexed on what they are looked up by** (#585). The
  collection was indexed on `guildId` alone while every query in
  `tournamentService` pairs the guild with a status — the read before each
  scoring cast, and the check before a new tournament starts — so a lookup
  narrowed to the guild and then scanned every tournament it had ever run, each
  document carrying its whole entries array. `{ guildId, status }` is declared in
  the schema, and `016_fishing_tournament_status_index` drops the single-field
  index the compound one now covers as its prefix.
- **The dashboard has a tab icon** (#688). It had none, and no view linked one,
  so every fresh page load spent a request on `/favicon.ico` that fell through
  the static handler and all three routers to a 404. An SVG and an ICO of the
  Clawdia paw ship under `public/`, linked from one partial the three views
  share; `npm run favicon` regenerates the ICO from the SVG.
- **A slow search result can no longer overwrite a fresh one** (#691). Both
  member-search dropdowns debounced their keystrokes and then let the answers
  race: the response to `ali`, still in flight, landed after the response to
  `alice` and repainted the list with results for a prefix already typed past.
  Each widget cancels the request it supersedes.
- **Injected avatars are marked decorative** (#678). Six avatars in the search
  dropdowns, the moderation case table and the economy top-earners table were
  written without an `alt`, so a screen reader read the CDN URL out beside the
  username sitting next to it.

Both migrations in this release only drop an index no query uses, and neither
creates anything, so the 4.2.0 image reads the migrated database unchanged —
rolling back to 4.2.0 is the image tag alone. It would rebuild
`idx_giveaways_active` and the single-field `guildId_1` on its next boot, which
is the state it started from.

## [4.2.0] - 2026-08-24

Migrations through `014_scope_item_images_per_guild`.

The first tagged release. The version had sat at `1.0.0` across 299 commits and
fourteen migrations, while the dashboard and landing page separately displayed a
hardcoded `v4.2.0` that nothing produced (#708). `4.2.0` adopts the number the
UI had already been showing, so no deployment sees its version go backwards, and
the templates now read it from `package.json` instead of carrying their own copy.

Also in this release:

- **Exploration drops fieldcraft materials, and has a rare companion** (#753).
  Exploration was the one grind track with no unpurchasable pet, because a
  companion needs a favourite food that resolves in `MATERIAL_RARITY` and
  exploration produced only coins, Explorer XP and relics. It has eleven
  materials of its own now, dropping from treasure finds tier-matched to the
  treasure, and the 🦉 Lantern Owl (+15% Explorer XP) drops from legendary
  treasure and eats Lantern Glass. No migration: `GrindProfile.data` is
  schemaless, so an existing explorer picks the pile up on their next
  expedition.
- **The landing page reports this instance rather than a hardcoded one** (#704).
- **FEATURES.md's dashboard section list is generated** from the sidebar and the
  panels (#705), via `npm run docs:panels`.

No schema migration is part of this release, so its high-water mark is the one
recorded above. Rolling *back* to it is a matter of the image tag alone only
from a later version carrying that same mark — once a newer release has run a
migration past `014_scope_item_images_per_guild`, the database is ahead of this
version's code and the tag alone will not undo that. Check the mark on the
version you are leaving before you pin this one.
