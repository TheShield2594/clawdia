# Feature Audit Log

A record of the subsystems that have been through a line-by-line audit, and what
was found and fixed in each. **It is not a survey of the whole bot.** Eleven
subsystems have been audited: nine long-stable, low-churn ones, and two passes
over the economy — the escrow and payout paths of `/duel`, `/heist` and
`/syndicate`, and the casino's progressive jackpot (#873). The majority of the
codebase, and most of the economy, has never been audited; see
[Not yet reviewed](#not-yet-reviewed) for the full list.

A subsystem appearing here means it was audited on the date at the bottom of
this file and the findings were resolved. A subsystem *not* appearing here means
nothing — neither that it is broken nor that it is sound. Do not read the
absence of a section as a clean bill of health, and do not treat this file as a
release gate.

The file records what was audited on the day it was audited, so the paths below
are the paths as they stood then and are deliberately left that way. One has
moved since and is cited often enough to be worth naming: the settings
validators and the `/stats` fixes were audited in `src/dashboard/routes/api.js`,
which mounts the sub-routers and re-exports two of their functions and holds no
handler of its own — that code lives in `src/dashboard/routes/api/`, the
validators in `settings.js` and the guild statistics in `stats.js`.

---

## Welcome Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/utils/cardGenerator.js`
- `src/events/guildMemberAdd.js`
- `src/models/Guild.js`
- `src/dashboard/routes/api.js`
- `Dockerfile`
- `tests/welcome.test.js` (added)

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | Text overflow on canvas for long usernames | Added `truncateText()` helper that measures text width and truncates with ellipsis | `cardGenerator.js` |
| 2 | No max length on welcome/DM message (Discord 4096 char limit) | Added `maxlength: 4000` to `welcome.message` and `welcome.dmMessage` in schema | `Guild.js` |
| 3 | Canvas clip never restored (`save`/`restore` missing) | Wrapped avatar draw block in `ctx.save()` / `ctx.restore()` | `cardGenerator.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 4 | Deprecated `{ dynamic: true }` avatar option | Removed the deprecated option; `displayAvatarURL()` returns animated URLs by default in discord.js v14 | `guildMemberAdd.js` |
| 5 | `user.tag` deprecated in new Discord username system | Replaced with `user.globalName ?? user.username` on card; `user.username` in event log | `cardGenerator.js`, `guildMemberAdd.js` |
| 6 | No timeout on avatar image fetch | Added `loadImageWithTimeout()` wrapper using `Promise.race` with a 5 s deadline | `cardGenerator.js` |
| 7 | Auto-roles applied sequentially | Replaced `for...of` with `Promise.allSettled` | `guildMemberAdd.js` |
| 8 | Non-atomic analytics upsert | Removed spurious no-op `$push` from the increment path; simplified the two-step upsert | `guildMemberAdd.js` |
| 9 | System Arial font not bundled | Registered DejaVu Sans (Regular + Bold) via `canvas.registerFont`; added `ttf-dejavu` to Alpine Dockerfile | `cardGenerator.js`, `Dockerfile` |
| 10 | No bot permission check before sending to welcome channel | Added `PermissionFlagsBits.SendMessages` / `AttachFiles` check before attempting to send | `guildMemberAdd.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 11 | No tests | Added Jest; 13 passing tests covering `applyVariables` and `createWelcomeCard` | `tests/welcome.test.js`, `package.json` |
| 12 | No field-level validation for welcome settings in API | Added `validateWelcomeUpdate()` that validates types, lengths, and snowflake format before hitting Mongoose; Mongoose `ValidationError` now returns 400 instead of 500 | `api.js` |

---

## Farewell Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/events/guildMemberRemove.js`
- `src/models/Guild.js`
- `src/dashboard/routes/api.js`
- `tests/farewell.test.js` (added)

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | Non-atomic analytics upsert (spurious `$push` with `$each: []` in increment path) | Removed no-op `$push` from the `$inc` path; only inserts a new entry when no match exists | `guildMemberRemove.js` |
| 2 | No `maxlength` on `farewell.message` (Discord 4096 char limit) | Added `maxlength: 4000` to `farewell.message` in schema | `Guild.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 3 | Deprecated `{ dynamic: true }` avatar option in farewell embed and log embed | Removed the deprecated option from both `setThumbnail` and `setAuthor` calls | `guildMemberRemove.js` |
| 4 | `user.tag` deprecated in new Discord username system | Replaced `{user}` and `{username}` with `member.user.globalName ?? member.user.username`; `{tag}` with `member.user.username`; log embed author with `member.user.username` | `guildMemberRemove.js` |
| 5 | No bot permission check before sending to farewell channel | Added `PermissionFlagsBits.SendMessages` check before attempting to send | `guildMemberRemove.js` |
| 6 | No field-level validation for farewell settings in API | Added `validateFarewellUpdate()` that validates types, lengths, and snowflake format before hitting Mongoose | `api.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 7 | No tests | Added 7 passing Jest tests covering `applyVariables`, permission guard, disabled-state, and null-settings safety | `tests/farewell.test.js` |

---

## Birthday Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/services/birthdayService.js`
- `src/commands/utility/birthday.js`
- `src/models/Guild.js`
- `src/dashboard/routes/api.js`
- `tests/birthday.test.js` (added)

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | No `maxlength` on `birthdays.message` (Discord 2000 char limit for channel messages) | Added `maxlength: 2000` to `birthdays.message` in schema | `Guild.js` |
| 2 | No field-level validation for birthday settings in API | Added `validateBirthdaysUpdate()` covering type checks, length, and snowflake format for `channelId`, `roleId`, `message`, `enabled`, and `wishingHourUtc` | `api.js` |
| 3 | No bot permission check before sending birthday message | Added `PermissionFlagsBits.SendMessages` check via `channel.permissionsFor(guild.members.me)` before sending | `birthdayService.js` |
| 4 | Feb 29 birthdays silently skipped on non-leap years | On Feb 28 of non-leap years, query now includes both Feb 28 and Feb 29 users so leap-day birthday holders are still celebrated | `birthdayService.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 5 | No tests | Added Jest; 7 passing tests covering age substitution, permission guard, leap day handling, and `lastCelebratedYear` tracking | `tests/birthday.test.js` |

---

## Moderation Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/commands/moderation/appeal.js`
- `src/commands/moderation/ban.js`
- `src/commands/moderation/case.js`
- `src/commands/moderation/cases.js`
- `src/commands/moderation/clear.js`
- `src/commands/moderation/closecase.js`
- `src/commands/moderation/kick.js`
- `src/commands/moderation/lockdown.js`
- `src/commands/moderation/massban.js`
- `src/commands/moderation/mute.js`
- `src/commands/moderation/note.js`
- `src/commands/moderation/slowmode.js`
- `src/commands/moderation/softban.js`
- `src/commands/moderation/unban.js`
- `src/commands/moderation/unmute.js`
- `src/commands/moderation/warn.js`
- `src/services/caseService.js`
- `src/services/escalationService.js`
- `src/services/tempBanService.js`
- `src/services/moderationLogService.js`
- `src/events/messageCreate.js` (AutoMod)
- `src/models/Case.js`
- `src/models/TempBan.js`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `warn add` subcommand had 5+ sequential DB/API operations before `interaction.reply` — routinely exceeded Discord's 3-second response deadline, causing "This interaction failed" errors | Added `interaction.deferReply()` immediately after the bot-check guard; changed reply to `editReply`; fixed the catch path to use `editReply` when already deferred | `warn.js` |
| 2 | `appeal.js` had 2 DB operations before any reply — at-risk of 3-second timeout | Added `interaction.deferReply({ ephemeral: true })` before first DB call; changed all subsequent `reply` calls to `editReply` | `appeal.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 3 | `user.tag` deprecated throughout — in the new Discord username system `.tag` always returns `username#0000` for non-legacy accounts | Replaced all `user.tag` / `interaction.user.tag` / `ban.user.tag` / `msg.author.tag` / `targetUser.tag` / `botUser.tag` with `globalName ?? username` | `appeal.js`, `ban.js`, `cases.js`, `closecase.js`, `escalationService.js`, `kick.js`, `logger.js`, `massban.js`, `mute.js`, `note.js`, `slowmode.js`, `softban.js`, `unban.js`, `unmute.js`, `warn.js` |
| 4 | `displayAvatarURL({ dynamic: true })` deprecated in discord.js v14 | Removed the `{ dynamic: true }` option; the method returns animated URLs by default | `cases.js` |
| 5 | `c.createdAt / 1000` in the case list embed (`cases.js`) — implicit Date→number coercion instead of explicit `.getTime()` | Changed to `c.createdAt.getTime() / 1000` | `cases.js` |
| 6 | `massban.js` fallback user object used `{ id, tag }` — mismatched logger's `globalName ?? username` lookup after fix #3 | Changed to `{ id, globalName: null, username: userId }` | `massban.js` |
| 7 | `warn.js` used flat `if` chains for subcommand dispatch — all three branches evaluated on every call | Changed to `if / else if / else if` | `warn.js` |

> **No ticket system exists.** Earlier revisions of this file listed
> `src/commands/moderation/ticket.js` as reviewed and fixed. That file has never
> existed in any commit, and no ticket command is registered. The claims have
> been struck; a ticket system remains an unimplemented feature, not a reviewed one.

---

## Temp Voice Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/services/tempVoiceService.js`
- `src/events/channelDelete.js`
- `src/index.js`
- `src/commands/utility/vc.js`
- `tests/tempVoice.test.js` (added)

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `checkTempVoice` exported but never scheduled — stale channels from restarts accumulated forever | Added `checkTempVoice(client)` call + 5-minute `setInterval` inside the `ready` event | `index.js` |
| 2 | `channelDelete` event had no temp voice cleanup — manually deleted temp channels left ghost IDs in `activeChannels` forever | Added `$pull` update in `channelDelete` handler when deleted channel is in `activeChannels` | `channelDelete.js` |
| 3 | Non-atomic push/save pattern for `activeChannels` — concurrent lobby joins could lose each other's update | Replaced `push` + `save` with `$addToSet` and `filter` + `save` with `$pull`/`$set` atomic MongoDB operations | `tempVoiceService.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 4 | `{tag}` template variable used deprecated `member.user.tag` | Replaced with `member.user.globalName ?? member.user.username` | `tempVoiceService.js` |
| 5 | No bot `ManageChannels` permission check before channel creation — failures were silent | Added `botMember.permissionsIn(...).has(ManageChannels)` guard with a logged warning | `tempVoiceService.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 6 | No tests | Added Jest; 11 passing tests covering lobby join, channel naming templates, permission guard, leave cleanup, and periodic `checkTempVoice` sweep | `tests/tempVoice.test.js` |

---

## Raid Detection Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/services/raidService.js`
- `src/commands/admin/raidmode.js`
- `tests/raid.test.js` (added)

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | Double-activation race condition: `raidModeActive.add(guildId)` was called *after* `await alertChannel.send()`, allowing two concurrent threshold-crossing joins to both pass the `raidModeActive.has()` guard simultaneously — sending two alerts and running the bulk-action loop twice | Moved `raidModeActive.add(guildId)` and `raidModeActivatedBy.set()` to before the first `await` in the activation block | `raidService.js` |
| 2 | `raid` subcommand had a `Guild.updateOne` DB call before `interaction.reply` — at-risk of Discord's 3-second response timeout | Added `interaction.deferReply()` before DB call; changed `reply` to `editReply` | `raidmode.js` |
| 3 | `toggle` subcommand had a `Guild.findOne` + `setRaidMode` (DB + Discord message) before `interaction.reply` — at-risk of 3-second timeout | Added `interaction.deferReply()` before DB call; changed `reply`/`ephemeral reply` to `editReply` | `raidmode.js` |
| 4 | `status` subcommand had a `Guild.findOne` DB call before `interaction.reply` — at-risk of 3-second timeout | Added `interaction.deferReply()` before DB call; changed `reply` to `editReply` | `raidmode.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 5 | `rd.action.toUpperCase()` in the status embed crashes if `action` is null (e.g. a guild document created before the schema default was added) | Changed to `(rd.action ?? 'alert').toUpperCase()` | `raidmode.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 6 | No tests | Added Jest; 15 passing tests covering threshold detection, auto-activation, double-activation guard, bulk kick/quarantine, active-mode joins, old-account exemption, DB error safety, DB→memory sync on restart, and manual enable/disable | `tests/raid.test.js` |

---

---

## Bible Verses Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/services/bibleService.js`
- `src/services/dailyBibleService.js`
- `src/commands/utility/bible.js`
- `src/dashboard/routes/api.js`
- `tests/bible.test.js` (added)

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | No field-level validation for `bibleVerse.*` settings in the dashboard API — invalid `channelId`, `time`, `timezone`, and `translation` values bypassed every guard and hit Mongoose directly | Added `validateBibleVerseUpdate()` covering type checks, snowflake format for `channelId`, `HH:MM` regex + range check for `time`, IANA timezone validation for `timezone`, and enum check for `translation`; wired it into the settings route alongside the existing welcome/farewell/birthdays validators | `api.js` |
| 2 | No bot permission check before sending the daily verse — `postDailyVerse` called `channel.send()` without verifying the bot has `SendMessages` in that channel; errors were silently swallowed | Added `PermissionFlagsBits.SendMessages` check via `channel.permissionsFor(botMember)` with a logged warning on failure — consistent with birthday/welcome/farewell fix pattern | `dailyBibleService.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 3 | No tests | Added Jest; 22 passing tests covering `detectVerseReferences` (detection, range, dedup, abbreviations), `lookupVerse` (success, API error, network failure, translation param), `getDailyVerse` (success, malformed, failure), `createVerseEmbed` (truncation, footer, fallback translation), `startDailyBibleService` (scheduling, DB failure safety), `postDailyVerse` permission guard (allowed and blocked), and `rescheduleBibleVerse` (enabled and disabled) | `tests/bible.test.js` |

---

---

## Analytics Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/events/guildMemberAdd.js`
- `src/events/guildMemberRemove.js`
- `src/events/interactionCreate.js`
- `src/dashboard/routes/api.js`
- `src/models/Guild.js`
- `tests/analytics.test.js` (added)

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `retained7` in `/stats` endpoint was computed from 30-day join/leave data — copy-paste bug caused both the 7-day and 30-day retention figures to reflect the same 30-day window | Added `joins7`/`leaves7` from `memberEvents.slice(-7)` and fixed `retained7` formula to use 7-day data | `api.js` |
| 2 | `retained30` in `/stats` used `Math.round(leaves30 * 1.2)` — arbitrary 20% inflation of leaves with no justification, causing artificially low retention figures inconsistent with the `/insights` endpoint | Replaced with `Math.max(0, joins30 - leaves30) / joins30`, matching the correct formula in `/insights` | `api.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 3 | `{tag}` template variable in `guildMemberAdd.applyVariables` still used deprecated `member.user.tag` — inconsistent with `guildMemberRemove.js` which was already fixed | Replaced `member.user.tag` with `member.user.username` | `guildMemberAdd.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 4 | No tests for analytics tracking | Added Jest; 18 passing tests covering `trackMemberEvent` joins/leaves (increment existing entry, insert new entry with $slice -120, null-guild safety, DB error swallowing), `logCommandMetric` (success, failure, unknown command, $slice -3000, hour recording), `{tag}` non-deprecated template substitution, and retention math (7-day window isolation, correct 30-day formula, zero-division safety, negative-clamp) | `tests/analytics.test.js` |

---

## Event Log Function

**Status: Audited — all findings resolved** ✓

**Files reviewed/fixed:**
- `src/events/messageDelete.js`
- `src/events/messageUpdate.js`
- `src/events/guildMemberUpdate.js`
- `src/events/channelCreate.js`
- `src/events/channelDelete.js`
- `src/dashboard/routes/api.js`
- `tests/eventLog.test.js` (added)

---

### Issues Found & Fixed

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `user.tag` deprecated in new Discord username system — used in `messageDelete`, `messageUpdate`, and `guildMemberUpdate` event handlers | Replaced with `globalName ?? username` in all three handlers | `messageDelete.js`, `messageUpdate.js`, `guildMemberUpdate.js` |
| 2 | `displayAvatarURL({ dynamic: true })` deprecated in discord.js v14 — used in `messageDelete`, `messageUpdate`, `guildMemberUpdate` | Removed the `{ dynamic: true }` option; the method returns animated URLs by default | `messageDelete.js`, `messageUpdate.js`, `guildMemberUpdate.js` |
| 3 | No bot `SendMessages` permission check before sending to the log channel — failures were silent | Added `PermissionFlagsBits.SendMessages` guard via `logChannel.permissionsFor(guild.members.me)` in all five event handlers | `messageDelete.js`, `messageUpdate.js`, `guildMemberUpdate.js`, `channelCreate.js`, `channelDelete.js` |
| 4 | No field-level validation for `eventLog.*` settings in the dashboard API — invalid `channelId` and non-boolean toggle values bypassed every guard and hit Mongoose directly | Added `validateEventLogUpdate()` covering type checks for all boolean toggles and snowflake format for `channelId`; wired it into the settings route alongside existing validators | `api.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 5 | No tests | Added Jest; 24 passing tests covering `messageDelete` (enabled, disabled, logMessageDelete=false, bot skip, permission guard, globalName fallback, content truncation), `messageUpdate` (content changed, unchanged, bot skip, permission guard), `guildMemberUpdate` (role add, role remove, no changes, permission guard), and `validateEventLogUpdate` (valid booleans, invalid enabled, valid/invalid/null channelId, unrelated keys) | `tests/eventLog.test.js` |

---

## Economy — Duel Escrow and Crew Payouts

**Status: Audited — all findings resolved** ✓

The first pass of the economy audit #873 asks for, taken over the money-moving
paths that hold coins on someone's behalf and then have to put them somewhere:
the `/duel` escrow and settlement, and the crew splits in `/heist` and
`/syndicate`. These were picked first because escrow is the only shape in the
economy where coins exist outside anybody's balance, so a failure there does not
merely misreport a number — it destroys or mints one.

The rest of the economy remains unaudited and is still listed under
[Not yet reviewed](#not-yet-reviewed).

**Files reviewed/fixed:**
- `src/commands/economy/duel.js`
- `src/commands/economy/syndicate.js`
- `src/services/heistService.js`
- `src/utils/duelEscrow.js` (added)
- `src/utils/creditOrOwe.js` (added)
- `src/utils/payoutKey.js`
- `tests/duelEscrowSettlement.test.js` (added)
- `tests/crewShareRecovery.test.js` (added)
- `tests/creditCoinsOrOwe.test.js` (added)
- `tests/heistResolutionFailure.test.js`
- `tests/achievementTracking.test.js`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | A duel that failed *after* paying its winner minted the pot. `finalizeDuel` paid out and then read both balances for the result embed; a rejection from that read — or from anything else past the payout — reached a caller whose only recovery is `refundEscrow`, which handed both stakes back on top of a settled duel. `2 × amount` created per failure | Settlement is now the last thing in `finalizeDuel` that can fail: the result embed and victory card moved into `presentResult`, which swallows its own errors. The accept handler also clears `escrowTaken` when it hands the escrow to the game runner, so its catch cannot refund a duel somebody else has already settled | `duel.js` |
| 2 | `takeEscrow`'s rollback destroyed the challenger's stake. When the opponent's stake could not be taken, the challenger's refund was a bare unchecked `await User.updateOne(...)`: an update matching no document resolved as success, and a rejection escaped to a caller that had already decided no escrow was taken and refunded nothing | The rollback goes through `creditCoinsOrOwe` — verified, never throwing, and recorded as an owed payout when it will not land — and reports what happened back to the caller, which now names the stranded stake in the cancellation message | `duel.js`, `creditOrOwe.js` |
| 3 | A tie refunded both stakes through one `Promise.all` of two `$inc`s. The first failure abandoned the second write and rejected into the caller's catch, so one player could keep their stake, the other lose theirs, and the pair then be refunded again | Both refunds are independent and individually verified; the cooldown stamp they used to share is a separate best-effort write | `duel.js` |
| 4 | `/syndicate` counted an unmatched write as a paid share. `findOneAndUpdate` returning `null` — no user document in that guild — does not throw, so `credited = true` was set on it and the recovery record directly below was never reached. Its three retries of an unguarded `$inc` could also pay twice: a write that commits and loses its response is indistinguishable from one that never ran | Both go through the shared helper: the credit carries a payout key, which is what makes the retry safe, and an unmatched write is a failure rather than a payout | `syndicate.js`, `creditOrOwe.js` |
| 5 | `/syndicate`'s recovery record could not be replayed by anything. `jobName: 'heist_credit'` has no `.owed` suffix, so `npm run payouts:replay` never lists it, and the payload carried no `kind`, so `replayOwedPayout` could not have paid it either. The share was written down where nobody could settle it | Records go through `recordOwedPayout` with a `coins` payload and a `crew:{heistId}:{userId}` key, which is the shape the replay script already understands | `syndicate.js`, `payoutKey.js` |
| 6 | `/heist` lost a failed share entirely. A rejected payout was logged to the console and the resolution moved on; an unmatched one was not noticed at all. Either way the channel was told what everyone earned | Same helper, same owed record. The result embed names any crew member whose share did not arrive and says whether it is recoverable | `heistService.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 7 | Every duel refund path told both players "Both bets have been refunded" regardless of what the two writes did | `refundNote` words the message from the actual outcome — returned, recorded for an admin, or lost — and all seven refund sites use it | `duel.js` |
| 8 | A duel whose payout failed still announced the win, posted the victory card naming the amount, and ticked the "Win a duel" season mission | The result says the pot could not be paid and whether it was recorded; the card and the mission tick are conditional on the payout landing | `duel.js` |
| 9 | The winner's pot shared one write with `duelWins` and the ranked ELO `$set`, so the money's fate was tied to a counter's | The pot moves on its own verified write; the records follow as best-effort `allSettled` writes that cannot fail the duel | `duel.js`, `duelEscrow.js` |
| 10 | Deprecated `displayAvatarURL({ dynamic: true })` in the victory card and the rank view — the same finding as #4 in the Welcome audit, in code written after it | Removed the option; v14 returns animated URLs by default | `duel.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 11 | Three subsystems had three hand-written versions of "credit this player, cope if it fails", and each got a different part of it wrong | One `creditCoinsOrOwe`, keyed and verified, recording what it could not pay | `creditOrOwe.js` |
| 12b | A failed refund was recorded as owed without the bookkeeping it was going to move. A duel refund reverses `lifetimeGambled` in the same write as the coins; the owed record carried only the coins, so `payouts:replay` put the stake back and left the player counted as having gambled it | The owed payload carries `counters` — `{ path: delta }`, plain numbers rather than a `$`-keyed expression a document cannot hold — and `replayOwedPayout` applies them in the same guarded write as the credit | `creditOrOwe.js`, `owedPayout.js`, `balanceDebit.js` |
| 12c | `takeEscrow`'s second debit could reject after the first had committed. The rejection reached the accept handler with `escrowTaken` still false, so nothing refunded the challenger's stake | The second debit is wrapped and reconciles the first, which is known to have committed because it returned a document. The remaining case — a debit whose *own* outcome is unknown — needs a keyed debit and is called out in the module rather than papered over: refunding a debit that never landed would mint coins | `duelEscrow.js`, `duel.js` |
| 12 | A duel's money handling was spread through the command file, which the 900-line cap would not hold | Escrow, refund, winner payout and the refund wording moved to `src/utils/duelEscrow.js`; the command keeps the collectors and the wording around them. The `lifetimeGambled` reversal added by the achievement audit is now a parameter of the refund rather than a property of it, because a tie hands the stakes back without the duel having gone unplayed — the counter stays, as it does on a blackjack push | `duel.js`, `duelEscrow.js` |
| 13 | No tests over any of it | 50 tests across three suites: the escrow, the settlement and the refund wording (`duelEscrowSettlement`); both crew splits driven through the same table (`crewShareRecovery`); and the helper against a store that evaluates the payout-key guard for real (`creditCoinsOrOwe`). `src/commands/economy` now measures 35% against a floor raised from 27% to 33%, and the global floors move from 49/39/50/50 to 50/40/53/51 | `tests/`, `coverage-floors.json`, `jest.config.js` |

**Reviewed and found sound** — no change needed, recorded so the next pass does
not re-derive it: `utils/coinTransfer.js` (the two-party transfer, already
verified-and-recorded end to end), `utils/balanceDebit.js` (the clamp is inside
the update), `utils/balanceDelta.js` and its `save()`-detaching callers,
`utils/payoutKey.js`, `commands/economy/rob.js` (deltas, not absolute writes,
with both sides guarded and reversed on failure), `utils/placeWager.js`, and the
`explore` travel toll. `casinoJackpotService.awardPool` restores the pool and
clears the winner fields when a credit fails, which is sound; it does not write
an owed record, and is left for the casino pass.

*The pool restore was not sound, and the casino pass below says why: it is the
right recovery only if the credit definitely did not land, which is exactly what
the unkeyed retry above it could not establish. Left as it was written, because
what a pass concluded is part of what the next one has to check.*

---

## Economy — The Progressive Jackpot

**Status: Audited — all findings resolved** ✓

The second pass of the economy audit #873 asks for, over `casino payouts,
jackpot`. It takes the jackpot first for the same reason the first pass took
escrow: the pool is the one place in the casino where coins exist outside
anybody's balance, and it is the largest single payout the bot makes — a
five-figure pot claimed out of a shared pool in one write and credited in
another, with a boot-time reconciler in between to cover the gap. A failure
there does not misreport a number; it makes or unmakes one.

The rest of the casino — the eight games' own payout writes, `confirmBet`, the
crash lobby's `pendingCrashRefund` escrow — is **not** audited by this pass and
is still listed under [Not yet reviewed](#not-yet-reviewed).

**Files reviewed/fixed:**
- `src/services/casinoJackpotService.js`
- `src/events/ready.js`
- `src/games/casino/slots.js`
- `src/models/Guild.js`
- `src/utils/payoutKey.js`
- `tests/casinoJackpotPayout.test.js` (rewritten)
- `tests/casinoJackpotSinglePool.test.js`
- `tests/readyEvent.test.js`
- `tests/coverageRatchet.test.js`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | The pot and the amount of it were two writes. The claim reset the pool and named the winner; `lastWonAmount` followed in a separate, unawaited `updateOne`. A process that stopped in between left the new winner's name over the *previous* winner's amount — and that field is what the restart reconciler pays from, so the next boot credited a number this player never won, out of a pool that had already been reseeded | The claim is one update-pipeline write that reseeds the pool, records the amount it took — computed from the pool as it stood at the start of the same write — and mints the payout key, all atomically. The amount is read back off the document that write returned | `casinoJackpotService.js` |
| 2 | The credit was an unkeyed `$inc` retried three times. A write that commits and loses its response is indistinguishable from one that never ran, so the second attempt paid the pot again — the same finding as #4 in the escrow pass, in the payout that pot for pot is the biggest in the bot | The credit goes through `creditCoinsOrOwe` under the claim's own payout key, so a retry of a landed credit moves no coins and reports success | `casinoJackpotService.js`, `payoutKey.js` |
| 3 | A credit that would not land rolled the pool back. That is only the right recovery if the credit definitely did not happen, which #2 says cannot be established; the rollback put a five-figure pot back under a player who may already have been paid it. It also left the coins nowhere an operator could find them: no owed record, no queue entry, one console line | The pool stays reseeded and the debt is written down instead — an owed payout under the claim's key, which `npm run payouts:replay` settles, plus a marker on the guild document for the boot-time reconciler. Restoring *and* recording is what pays twice; recording is the one of the two that cannot | `casinoJackpotService.js` |
| 4 | Slots paid its 25x Triple Wild consolation on top of a rolled-back claim. The three failures compose: one lost response could credit the pot, restore the pool, and pay the fallback — the player keeps the pot, the guild keeps the pot, and the fallback is minted on top | A claim that succeeded is the player's whether the credit has landed or not, so nothing is paid in its place; the spin says the pot has not arrived and whether it was recorded. The fallback now runs only where nothing was claimed at all — a guild with no document, which has no pool to win | `slots.js`, `casinoJackpotService.js` |
| 5 | The restart reconciler asked the transaction log whether a win had been paid. `logTransaction` is fire-and-forget and documents that it never throws, so the absence of a row proves nothing: a credit that landed and whose ledger entry did not was paid a second time. The probe also matched on the amount from finding #1, and on nothing that identified *this* win | Nothing is asked. The credit carries the claim's payout key, so a reconciling attempt against a pot already paid moves no coins by construction, and a `pendingPayoutKey` marker — not the ledger — says whether anything is outstanding | `ready.js`, `casinoJackpotService.js`, `Guild.js` |
| 6 | The reconciler selected on `lastWinnerId` and `lastWonAmount`, which are display state that stays set after a win is paid, and cleared them on success — so every restart went looking for a payout in every guild that had ever dropped a jackpot, and wiped the last-winner line `/casino jackpot` shows | The sweep selects on the outstanding-claim marker and clears only that. The display fields are left alone | `casinoJackpotService.js` |
| 7 | The sweep's own lease could strand a payout for good. It stamped a `claimToken` on the guild before crediting and selected only on `null` or its own token, so a process that stopped after stamping left a claim no later run could ever select — every run mints a different token. The mechanism meant to protect the payout was the one that lost it | There is no lease. N shards crediting the same pot is safe by construction — the credit carries the claim's payout key and only one attempt can move coins — so the sweep reads the outstanding claims and settles them. Reading the set up front is also what bounds the loop | `casinoJackpotService.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 7 | A jackpot whose credit failed was announced to nobody. The announcement is the only thing that ever tells a player the random per-bet trigger fired for them, and it ran only on a successful credit — so an unpaid winner was never told they had won | Announced either way, worded from what happened: the pot, and whether it has been delivered or recorded. The same treatment as finding #8 in the escrow pass | `casinoJackpotService.js` |
| 8 | The winner's display name went into a pipeline update raw, where a value beginning with `$` is a field path rather than text | `$literal` on the strings the claim writes | `casinoJackpotService.js` |
| 9 | The reconciler's loop could not terminate if a settled guild's marker failed to clear: the same document is re-selected, credited as a duplicate, and re-selected again | A guild is visited once per sweep, and the lease is handed back on a failure so the next boot retries | `casinoJackpotService.js` |
| 10 | Startup owned the reconciliation loop — the claim lease, the ledger probe, the field clearing — over a data shape only the service knows | The sweep is `reconcileJackpotClaims()` in the service, next to the claim it recovers. `ready.js` calls it and logs what it settled | `ready.js`, `casinoJackpotService.js` |
| 11 | Slots' public jackpot broadcast said the player "walked away with the entire pool" whatever became of the credit, so a pot that had not arrived was announced as paid to the whole channel while the winner's own result said otherwise | `jackpotBroadcastEmbed` is worded from the claim's outcome, like the service's own announcement | `slots.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 12 | A credit that succeeded on a retry filed no ledger entry, because the helper hands back no document when the key says an earlier attempt landed | The balance is read back and the entry filed. Rare path, and the ledger is where an operator goes looking for the biggest payout the casino makes | `casinoJackpotService.js` |
| 13 | The tests mocked the claim and the credit as bare `findOneAndUpdate` stubs, which cannot evaluate a payout-key guard and so cannot tell a safe retry from a double payment | 34 tests against stores that apply the claim pipeline and evaluate the key for real, including the lost-response case the key exists for. `casinoJackpotService.js` measures 98/84/90/100 and joins the per-file coverage floors | `tests/`, `coverage-floors.json` |

**Reviewed and found sound** — recorded so the next pass does not re-derive it:

- `processJackpotBet`'s contribution is *minted*, not taken. The player's bet has
  already gone to the game; the 0.5% that grows the pool is house money, as is
  the seed the pool resets to. That is the design — a progressive pot funded by
  the house at a rate the guild sets — and not a leak, but it is invisible at the
  call site and reads like one. Recorded rather than changed: changing it would
  change what players are paid.
- The claim races itself harmlessly. Two winners at the same instant settle
  cleanly — the first takes the accumulated pool, the second the fresh seed —
  and a contribution that lands between the two goes into one pot or the other,
  never both.
- `getJackpotDisplay` answers with the default seed for a guild with no document.
  That is a display for a pool that does not exist, but every path that *pays*
  the pool guards for the missing document first, so nothing is credited from it.
- The marker holds one claim at a time, so a guild that drops a second jackpot
  while the first is still unpaid overwrites it, and the boot-time sweep loses
  sight of the first. The owed payout `creditCoinsOrOwe` files is what carries
  that one; what is genuinely lost is a claim whose process died in the window
  between the claim and that record, in a guild that then drops another jackpot
  before the next boot. A per-claim outbox would close it, and is not worth a
  growing array on the guild document for that.
- Upgrade note: a claim left unpaid by a process that died *before* this shipped
  carries no marker and is not reconciled. Nothing can pick those out — the old
  code left the winner fields set on successful wins too, which is the ambiguity
  the ledger probe was failing to resolve. They are recoverable by hand from
  those fields and the CRITICAL line the failed credit logged.

---

## Not yet reviewed

Nothing below has been audited. Several of these are the highest-churn areas of
the codebase — the economy alone is roughly a third of `src/` and takes the bulk
of ongoing rework — so the gap between what this file covers and what ships is
wide, and it is widest exactly where the risk is.

**Economy** — the largest uncovered area:

- `hunt` (`huntService.js`, `hunt/`, `event/trackhunt.js`, `craft.js`, `forge.js`)
- `mine` (`mineService.js`, `mine/`)
- `fish` (`fishService.js`, `fish/`)
- `pet` (`petService.js`, `pet.js`)
- `use` / items / effects (`use.js`, `effectsService.js`, `inventory.js`, `shop.js`)
- exploration (`exploreService.js`, `explore.js`, `map.js`)
- casino (`src/games/casino/*`, `casino.js`) — the eight games' own wager and
  payout writes, `confirmBet`, and the crash lobby's `pendingCrashRefund`
  escrow. Only the progressive jackpot has been audited
- core currency (`balance.js`, `bank.js`, `daily.js`, `work.js`, `jobs.js`, `crime.js`, `rob.js`, `invest.js`, `market.js`, `gift.js`)
- group and PvP systems (`war.js`, `rivalryService.js`, `tournamentService.js`, and everything in `heistService.js`, `syndicateService.js` and `duel.js` other than the escrow and payout paths audited above)
- progression (`prestige.js`, `season.js`, `synergyService.js`, `dailychallenge.js`)
- seasonal events (`seasonalEventService.js`, `eventshop.js`, and the seasonal commands)

**Everything else uncovered:**

- AI chat, personas, and summaries (`aiService.js`, `summaryService.js`, `ai.js`, `dm.js`)
- RSS feeds and the daily newspaper (`rssService.js`, `newspaperService.js`, `newspaper.js`, `feed.js`)
- quests and achievements (`questService.js`, `achievementService.js`, `quests.js`, `questgen.js`, `achievements.js`)
- giveaways (`giveawayService.js`, `giveaway.js`)
- starboard, suggestions, and reaction roles
- command policies and the permission layer
- reminders (`reminderService.js`), polls, profiles, and the remaining utility commands
- anti-nuke (`antiNukeService.js`) and the scheduler (`schedulerService.js`)
- the dashboard beyond the settings validators named above

---

*The nine non-economy subsystems above were last reviewed on 2026-05-28; the
economy escrow and payout paths on 2026-09-01; the progressive jackpot on
2026-09-04. "Not yet reviewed" carries no review date, because nothing in it has
been reviewed.*
