# Feature Audit Log

A record of the subsystems that have been through a line-by-line audit, and what
was found and fixed in each. **It is not a survey of the whole bot.** Nine
long-stable, low-churn subsystems have been audited, and eight passes over the
economy — the escrow and payout paths of `/duel`, `/heist` and `/syndicate`, the
casino's progressive jackpot, the unwind paths of `/gift` and `/market`, the
casino's hand payouts, the core currency commands (`balance`, `bank`,
`daily`, `work`, `jobs`, `crime`, `invest`), the gathering-loop payouts
(`hunt`, `fish`, `mine`, `explore`), the progression and group/PvP reward
payouts (the season pass, a syndicate's founding, a fishing tournament, the war
resolution), the seasonal-event currency (candy, hearts, snowflakes, and the
event shop), and the gathering commands' non-payout surface (the
repair/upgrade/unlock shop refunds, the quest-claim credits, the fishing
tournament's entry fee, and `/forge`) (#873). The majority of the
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
| 9 | The reconciler's loop could not terminate if a settled guild's marker failed to clear: the same document is re-selected, credited as a duplicate, and re-selected again | The sweep works from the set of outstanding claims it read at the start, so a document that stays selectable is not selected twice. A credit that fails leaves the marker in place and stops the sweep, and the next boot retries it | `casinoJackpotService.js` |
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

## Economy — Gift and the Player Market

**Status: Audited — all findings resolved** ✓

The third pass of the economy audit #873 asks for, over `gift` and `market` —
the two remaining items on that issue's own checklist besides the rest of the
casino. They are taken together because they are one shape: the only two places
a player hands something directly to another player, and so the only two where
an unwind has to put value back somewhere rather than merely not take it.

Every finding below is on an **unwind** path, and that is not a coincidence.
Both commands debit atomically, guard the debit with the balance or the stack it
is taking from, and put the freeze in the filter — the forward direction is
sound, and #869 already fixed the seller's payout on the way out. What nothing
had looked at is the direction things go when a trade fails halfway: five writes
that hand coins or an item *back*, none of which read what the write returned,
three of which told the player it had worked regardless, and one of which did
not exist at all.

The rest of the economy is **not** audited by this pass and is still listed
under [Not yet reviewed](#not-yet-reviewed).

**Files reviewed/fixed:**
- `src/commands/economy/market.js`
- `src/commands/economy/gift.js`
- `src/services/marketService.js`
- `src/utils/creditOrOwe.js`
- `src/utils/payoutKey.js`
- `src/utils/coinTransfer.js`
- `src/utils/giftCaps.js`
- `src/utils/inventoryGrant.js`
- `tests/grantItemsOrOwe.test.js` (added)
- `tests/economyMarketCommand.test.js`
- `tests/giftItemTransfer.test.js`
- `coverage-floors.json`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `/market buy` refunded a buyer whose listing was taken first with a bare `User.updateOne` `$inc`, read nothing back from it, and said "This listing was just sold. Your coins have been refunded." A filter that matches nothing resolves exactly as happily as one that moved coins, so a buyer whose document had gone was told their money was back over a balance that was still short — the #804 failure, in the one write that had never been looked at. It also had no `catch`, so a rejection escaped `executePurchase` with the buyer already charged | Both refunds go through `creditCoinsOrOwe` under a key naming this interaction, and the reply is worded from what the helper reports: returned, recorded as owed, or neither | `market.js`, `payoutKey.js` |
| 2 | The other refund — the one for a purchase whose item could not be credited — had the same unread result and swallowed its rejection into `console.error`, then said "Your coins have been refunded" either way. Nothing was written down, so unlike every other credit in the file there was nothing for `npm run payouts:replay` to settle | As above; the two are one helper now, so a third failure path cannot be added with a fourth handling of it | `market.js` |
| 3 | That same failure **destroyed the item**. The listing row is the only place a listed item exists — it left the seller's bag when they listed it — and `/market buy` deletes the listing to claim it *before* crediting the buyer. A credit that then failed refunded the buyer's coins and stopped: the item was in nobody's inventory at all, the seller was never told, and no record of it existed anywhere but a log line | The seller's stock goes back through the new `grantItemsOrOwe`, keyed to the listing, and is recorded as owed when it cannot — and only once the buyer's own keyed credit has been read back as genuinely absent, so a lost response cannot give the item to both. Returned to the bag rather than by recreating the listing: the seller's five slots may have filled while the purchase was in flight | `market.js`, `creditOrOwe.js`, `payoutKey.js` |
| 4 | `/market cancel` returned the stock with a bare `grantInventoryItem` in a `try`. That call answers `null` rather than throwing when no document matched, and the return value was never read — so a cancel that returned nothing still replied "Returned 3x lucky_charm". The `catch` that did fire wrote a console line calling the items "owed" while recording nothing owed, three hundred lines below the `returnStock` in `handleList` that records exactly this, for exactly this reason. The delete is the claim, so nothing would ever find the return again | `grantItemsOrOwe`, keyed to the listing's cancel, with the reply worded from its result | `market.js` |
| 5 | `/market buy`'s claim — the `findOneAndDelete` that takes the listing — had no `catch`, so a rejection after the buyer's debit escaped the purchase entirely: the coins gone, nothing written down, and in the non-confirm path an unhandled rejection out of the command | Caught, and the buyer refunded through the same keyed helper. The stock is deliberately *not* returned on this path: a rejection leaves it unknowable whether this delete landed or another buyer's did, and returning stock for a listing somebody else bought mints an item — `marketService`'s own rule, that losing a return is recoverable from a record and silently doubling one is not. The first attempt at this wrote that record as a console line, which is not one; it is a `FailedJob` now (finding 10) | `market.js`, `marketService.js` |
| 6 | `/gift`'s item rollback — the write that hands a sender their item back when the recipient's credit missed — ignored its return value entirely, so the one case it exists to handle was the case it reported as handled: "Your item was returned" over an item debited from the sender, refused by the recipient, and rolled back into nothing. When it *did* throw, the sender was told to contact an admin and nothing was written down for the admin to act on | `grantItemsOrOwe` under a key naming the gift, with the day's item-gift allowance still refunded in the same write. The three failure wordings say which of the three happened | `gift.js`, `payoutKey.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 7 | All five unwinds were unkeyed and unretried. A transient failure lost the value outright; and the owed record two of them filed was against a write that may have committed and merely lost its response, so a replay could pay it twice — the same reasoning that put a key on the escrow refund and the jackpot credit in the two passes before this | Every one of them is keyed and retried, under the six constructors added to `payoutKey.js`. A retry of a landed write is a no-op by construction rather than by hope | `payoutKey.js`, `creditOrOwe.js` |
| 8 | Four hand-written versions of "grant this item, and cope if it fails", one of which was right. `handleList`'s `returnStock` checked the null return and filed an owed payload; the other three each got a different part of it wrong. That is the shape #873's first pass found in the three group payouts, one subsystem over | `grantItemsOrOwe` in `utils/creditOrOwe.js`, beside the `creditCoinsOrOwe` the coin side already shares. `/market buy`'s own half moves to `creditPurchasedItem` and `unwindPurchase` in `services/marketService.js`, beside the sweep that unwinds the other way — which is also what keeps the command under the 900-line cap the lint rule holds it to | `creditOrOwe.js`, `market.js`, `gift.js` |
| 9 | `/gift`'s rollback refunded the day's item-gift allowance in the same write as the item, but the *owed record* carried only the item — so a rollback settled by `payouts:replay` returned the item and left the sender charged a day's cap for a gift that never arrived. The coin side had carried `counters` on the payload for exactly this reason since the first pass; the items branch of `replayOwedPayout` was the gap | A `budgetRefund` descriptor on the payload, stamped with the window the debit wrote, and `windowedRefundExpr` gating the refund on that window still being current — inside the same write, so there is no second read and no gap for the window to turn over in | `giftCaps.js`, `creditOrOwe.js`, `owedPayout.js`, `gift.js` |
| 10 | The ambiguous claim above was written down as a `console.error` and nothing else, so the seller's item was findable only by someone already reading logs at the right minute. "Recoverable from a record" and "there is a log line" are not the same claim | `recordAmbiguousClaim` files a `FailedJob`, carrying the listing, both parties, and the question an operator has to answer — whether a completed purchase exists for that listing. Deliberately **not** `recordOwedPayout`: that suffixes the job name `.owed`, which is what puts a payload in front of `payouts:replay`, and replaying this one would grant the stock unconditionally — the duplicate the whole finding is about | `marketService.js`, `market.js` |
| 11 | `payListingSeller` answered `balance: 0` when the seller's balance could not be read, and `handleBuy` filed that into the `market_sell` ledger row — a number nobody observed, recorded as though somebody had, in the one place an operator goes looking when the coins are in question | Three outcomes rather than two: the write's own projection, then a read, and only a read that *threw* is `null`. A read that succeeds and finds no seller document is an answer — they hold nothing — so that row is still filed, which is what #869 added it for. An unknown balance omits the row and logs why | `marketService.js`, `market.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 12 | The market tests broke a return with `mockRejectedValueOnce`, which asserts nothing about a path that is supposed to survive one transient failure, and asserted the *call shape* of the return rather than whether the item came back | Persistent failures where the test is about the failure, a retry test where it is about the retry, and assertions on the bag. The inventory mock now evaluates the payout-key guard for real, without which it would answer `unknown` where the store answers `duplicate` — the exact distinction `creditPurchasedItem` turns on, so a mock that waved it through would report the unwind as safe. `market.js` and `gift.js` join the per-file coverage floors at 86/65/81/86 and 88/69/86/91; `marketService.js` at 94/85/97/94 | `tests/`, `coverage-floors.json` |

**Reviewed and found sound** — recorded so the next pass does not re-derive it:

- `commitCoinTransfer` (`utils/coinTransfer.js`), which is the whole of
  `/gift type:coins` and of `/bank transfer`. Debit and send cap in one filter,
  credit and receive cap in another, an E11000-only retry on the upsert, a
  refund whose `matchedCount` is read, and an owed payout keyed by the
  interaction when the refund will not land. Nothing to add.
- The item debits in both commands. Positional `$` rather than an `arrayFilter`,
  so a duplicate slot is decremented once; `$elemMatch` on the stack, so the
  check and the debit are one write; and the id is taken from the stack that
  will actually be debited, so the soulbound test and the `$elemMatch` agree.
- `MarketListing`'s slot cap. `createListingInFreeSlot` lets the unique index on
  `{ guildId, sellerId, slot }` be the check, retries once per slot, and counts
  pre-slot legacy rows against the seller's five.
- `returnExpiredMarketListings` (`services/marketService.js`). Claim by delete,
  keyed grant, owed record, oldest-first within the TTL grace. #867, #804 and
  #807 left it in the state this pass would have asked for.
- The freeze is not checked in `/market`, and does not need to be: the command
  gate in `events/interactionCreate.js` is default-deny over the whole `economy`
  category, so a frozen member cannot reach any of these handlers. What the gate
  deliberately does not stop is a frozen *seller* being paid or having stock
  returned, which is the same call `economyFreeze.js` documents — a credit
  refused in its filter is indistinguishable from one that failed, and the
  economy's answer to a failed credit is to file it as owed and pay it later.
- Item value crossing the coin caps is priced, not ignored: `/gift`'s item path
  charges the guild's shop value of the stack against a separate daily
  item-value budget, so "buy the item, gift the item, sell it on the market" is
  not the coin cap with one extra step. `/market` has no cap of its own, by
  design — a sale is priced by the seller and paid for by the buyer.

**The bound this pass first left open, and where it now stands.** A recipient
credit that *commits and loses its response* is indistinguishable from one that
never ran, so an unwind acting on that reading returns an item that may already
have been delivered — a duplicate rather than a loss. The keys make each unwind
exactly-once *as an unwind*; they cannot make it conditional on a forward credit
that carries no key of its own.

- **`/market buy`: closed.** The buyer's credit is keyed by the listing
  (`listingPurchasePayoutKey`) and `creditPurchasedItem` reads that key back
  before anything unwinds, so a rejection is a question rather than an
  assumption. `duplicate` is a success and the seller's stock stays where it is.
  The cost is one capped `paidPayouts` entry per purchase, which is what the
  duel, crew and jackpot payouts already pay.

  There are **three** answers, not two, and the first attempt at this got that
  wrong: a classification that itself fails was read as "not delivered", which
  unwinds — and unwinding refunds the buyer *and* returns the seller's stock, so
  a credit that had in fact landed left the buyer with a free item and the seller
  with a second copy. Two items minted, out of the branch written to prevent one.
  `indeterminate` is now its own state, nothing is undone under it, and the
  delivery is filed as an owed payout under the purchase's own key —
  `grantItemOnce` under that key is a no-op if the write landed and a grant if it
  did not, so the replay reaches the right end without anyone having to know
  which it was. The sale stands: the buyer paid, the seller was paid, and the
  receipt says the delivery is unconfirmed rather than claiming it.
- **`/gift`: open, deliberately.** The same fix would put a payout key on every
  ordinary gift. Unlike a purchase there is no listing id to key it by — it
  would be the interaction — and the gift path has no equivalent of the deleted
  listing that makes the market's key safe to reuse across a replay. Left as it
  is, and named here so it is a decision rather than an oversight.

**The item side gets `counters` too.** `/gift`'s rollback refunds the day's
item-gift allowance in the same write as the item, so a rollback that lands
restores both — but one recorded as *owed* used to restore only the item, leaving
the sender charged a day's cap for a gift that never arrived. The coin side had
already solved this: `creditCoinsOrOwe` carries `counters` on the owed payload
precisely so "the replay reproduces that write rather than half of it", and the
items branch of `replayOwedPayout` was the gap.

The one thing that made it more than a copy is that this counter resets every 24
hours, so replaying the refund days later would take it out of a window the gift
was never charged against. The payload therefore carries a `budgetRefund`
descriptor stamped with the window the debit wrote, and `windowedRefundExpr`
gates the refund on that window still being current — inside the same write, so
there is no second read and no gap for the window to turn over in. A window that
comes back in the wrong shape compares unequal and the refund is skipped, which
is the conservative direction: an allowance that stays spent costs a day's cap,
one refunded twice is a cap that does not hold.

---

## Economy — Casino Hand Payouts

**Status: Audited — all findings resolved** ✓

The fourth pass of the economy audit #873 asks for, over the item its checklist
calls *casino payouts*: the coins the eight games under `src/games/casino` credit
when a hand settles. The progressive jackpot they play for was audited
separately (above); this is everything else the casino pays.

The forward direction was sound and had been for a while. Every stake goes
through `utils/placeWager`'s compare-and-set, which is one debit with the balance
check and the freeze in its filter, and #785's settlement extraction had already
moved the arithmetic — rounding order, multiplier stacking — into
`games/casino/settlement.js` where it is tested to 100%. What no pass had looked
at is the write that follows: the `$inc` that puts the winnings in.

`src/utils/economyLock.js` argues that those writes are safe, and for the
property it is arguing about they are. A `$inc` is atomic, so a hand settling
alongside a grind command cannot lose a payout to a stale read. But atomic is not
durable. Every one of the twenty-odd payout sites was an unkeyed `$inc` with no
retry, no record and — at several sites — no `catch`; the stake had left the
wallet minutes earlier when the hand opened. A write that never landed left
nothing behind but an embed announcing winnings over a balance that had not
moved. The jackpot credited from the same spin already went through
`creditCoinsOrOwe`, so the pot built from other players' stakes was recoverable
and the hand's own payout beside it was not. That asymmetry is finding 1, and
findings 2 through 5 are the places it did specific damage.

The rest of the casino — `confirmBet`, the bet guards, the games' own odds and
their leaderboard writes — is **not** audited by this pass, and neither is the
rest of the economy. Both are still listed under
[Not yet reviewed](#not-yet-reviewed).

**Files reviewed/fixed:**
- `src/games/casino/payout.js` (added)
- `src/games/casino/crash.js`
- `src/games/casino/blackjack.js`
- `src/games/casino/poker.js`
- `src/games/casino/cupgame.js`
- `src/games/casino/higherlower.js`
- `src/games/casino/keno.js`
- `src/games/casino/roulette.js`
- `src/games/casino/slots.js`
- `src/utils/payoutKey.js`
- `tests/casinoPayoutRecovery.test.js` (added)
- `tests/casinoJackpotSinglePool.test.js`
- `tests/helpers/fakeInteraction.js` — collectors can be held open across a
  running game, a press one collector's filter turns away stays queued for
  another collector on the same message, and a queued press can be made to fail
  its own render
- `tests/coverageRatchet.test.js`
- `coverage-floors.json`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | Every payout in the casino was an unkeyed `$inc` with nothing reading it back. A write that matched nothing — a removed document, a stepdown, a lost response — resolved exactly as happily as one that moved coins, and the embed printed the winnings and `updated?.balance ?? 0` regardless. The stake was already gone, taken by `placeWager` when the hand opened, so the player was out the bet and the winnings with no trace anywhere. Several sites had no `catch` either; `blackjack`'s final settle sat in a collector's `end` handler, where a rejection became an unhandled rejection that took the result embed *and* the lock release with it, freezing the hand mid-reveal | All of them go through the new `games/casino/payout.js`, which wraps `creditCoinsOrOwe`: keyed, retried, and filed for `npm run payouts:replay` when it will not land. `creditCoinsOrOwe` documents that it never rejects, which is what lets these sit unguarded in a collector callback. Each site reports which of the three happened, and `payoutNote` puts it in the embed that announces the win | all eight games, `payout.js`, `payoutKey.js` |
| 2 | `/casino crash` cleared `pendingCrashRefund` for every player not marked cashed-out when the round busted. `cashOutPlayer` deliberately leaves a player unmarked when their credit write fails — its own comment says so, "so the emergency-refund path still sees an unresolved player on DB failure" — so the sweep could not tell a player still riding the multiplier from one whose cash-out had just been lost. `pendingCrashRefund` is the marker `src/events/ready.js` reconciles on restart; zeroing it destroyed the one record that could have made those players whole, on top of the payout they had already lost | The failure is recorded on the player's state as `cashFailed` and excluded from the sweep, so the marker survives to be reconciled. The sweep decrements by the stake rather than zeroing, because a player sitting in a second channel's lobby has that stake counted in the same field and zeroing discarded it | `crash.js` |
| 3 | A crash cash-out whose write failed replied **"You've already cashed out."** — the one sentence that costs the player money. They read it as being safely out at 5×, stopped watching, and lost the hand at the bust. `cashOutPlayer` returned a boolean, so "already cashed out" and "the write did not land" were the same answer | `cashOutPlayer` returns `'paid' \| 'owed' \| 'lost' \| 'already'` and each gets its own wording. The payout is credited and the marker cleared in **one keyed write**, so a credit cannot land with the marker left set — which would have the reconciler return the stake on top of winnings already paid | `crash.js` |
| 4 | `/casino poker`'s error rollback refunded a flat `bet`. Every raise the player makes goes through `placeWager` and adds to `playerStake`, which the three street timeouts refund correctly — but `playerStake` was declared inside the `try`, so the `catch` could not see it and refunded the opening bet alone. A hand that errored after two raises quietly kept the rest | `playerStake` is hoisted to the function scope and the rollback refunds it, through the keyed helper like every other return | `poker.js` |
| 5 | `/casino cupgame`'s decision handler did nothing at all when a throw followed the button press. `decided` was set before `deferUpdate`, so the timeout arm was skipped; `settled` had been set before the decision, so the outer rollback was skipped too. A player who pressed "take the money" got neither the money, nor a message, nor their lock back | The catch now settles a decided take as well as an undecided timeout. Paying there is safe *because* the payout is keyed: it is the same key as the press, so a credit that did land makes this one a no-op — the property that turns a "pay again to be sure" into something a money path can do | `cupgame.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 6 | Every game's "Play Again" re-enters its play function with the **original interaction**, so keying the payout on `interaction.id` — the obvious choice — would classify a replay's winnings as a duplicate of the hand it replaced and drop them silently. That is a worse failure than the unkeyed write being replaced, and it would have shipped invisibly: the first hand of a session always pays | `newHandId` mints a UUID per hand and it is threaded through the recursion inside one — Monte's double-or-nothing rounds, higher-or-lower's streak — while a replay calls the play function again and gets a new one. Covered by a test that plays two hands through one interaction and asserts the keys differ | `payout.js`, all eight games |
| 7 | `/casino slots` never refunded the stake when a spin errored between the wager and the payout: the catch logged, said "An error occurred… Please try again", and kept the coins | A keyed rollback, guarded on the settle not having already happened | `slots.js` |
| 8 | `/casino roulette` read `updated.balance` off a write that can answer `null`. When it did, the `TypeError` landed in the outer catch — which, with `settled` already true, skipped the refund and told the player their wager had been refunded anyway | The balance comes from `settledBalance`, which reads the document back when the credit returned none rather than falling back to a pre-hand figure that is higher than the truth | `roulette.js` |
| 9 | `/casino crash` read `.username` off `client.users.fetch`'s result at three sites. The `.catch` there covers a rejected fetch; discord.js can also *resolve* `null` for a user it cannot see, and reading through that threw out of a tick, aborting the round mid-multiplier | `?? { username: uid }` on the resolved value as well as the rejection | `crash.js` |
| 10 | The rewrite itself introduced four defects, all found reviewing this pass. `cashOutPlayer` returned `true` from its success path while the button handler compared against `'paid'`, so **every successful manual cash-out reported a failure** — the auto-cash-out path the tests drove does not read the return value, which is why the suite missed it. A lucky save in higher-or-lower credited the bet and then rendered it, and a render that threw dropped into the outer catch, which refunded the bet a *second* time under its own key. Slots' new rollback read a `debited` scoped inside the `try`, so an error raised before the wager refunded a stake that had never been taken. And a `cashFailed` crash player — left with `cashedOutAt` null so the tick-error refund could still see them — was rendered as "still in" and then as "didn't cash out", contradicting the reply they had just been given | The return value is `'paid'`; the save records that it settled and the catch reads it; `debited` is hoisted and gates the rollback; the failed cash-out records its multiplier and outcome, and both renderers read them. Each is covered by a test that reproduces the defect | `crash.js`, `higherlower.js`, `slots.js` |
| 11 | Five rollback messages claimed "your wager was refunded" and then appended a note saying it had not been — one sentence contradicting the next — and said the same thing when no rollback had been attempted at all | Each reports which of the four things happened: no wager was taken, the hand had already been settled, the wager was refunded, or it could not be | `keno.js`, `poker.js`, `roulette.js`, `slots.js`, `cupgame.js` |

#### Informational

| # | Note |
|---|------|
| 12 | The zero-amount payout is now a no-op that issues no write. Slots credited `$inc: { balance: 0 }` on a jackpot spin — deliberately, so the pot was not paid twice — and a losing hand did the same. It was one more round trip and one more way for a settled hand to fail; `creditCoinsOrOwe` short-circuits a non-positive amount before it reaches the database. `tests/casinoJackpotSinglePool.test.js` asserted that write's shape and now asserts that no `casino:` credit is issued at all, which is the same property stated better |
| 13 | The crash join refund is left as a bare `$inc`. It fires immediately, in the same request, when a seat is lost to a lobby that filled — and if it fails, `pendingCrashRefund` is still set, so `ready.js` recovers the stake on the next boot. It is the one unkeyed coin write left under `src/games/casino`, and it already has the record the others lacked |
| 14 | A leaked `releaseLock` locks a player out of the casino for the primitive's ten-minute lease rather than permanently, so the paths above that failed to release it were a nuisance and not an outage. Left as it is; the lease is the backstop and shortening it belongs with `activeGameLock`, not here |

---

## Economy — The Core Currency Commands

**Status: Audited — all findings resolved** ✓

The fifth pass of the economy audit #873 asks for, over the core currency
commands its checklist and [ROADMAP.md](ROADMAP.md) sequence next: `balance`,
`bank`, `daily`, `work`, `jobs`, `crime` and `invest`. These are the commands a
player runs most, and between them the everyday ways coins enter and leave a
wallet outside of a trade with another player — which the earlier passes covered.

The shape of the pass is the same as the four before it. The forward direction
was mostly sound: `/daily` and `/work` credit their base reward through a guarded,
cooldown-carrying write, `/bank` moves coins between a player's own wallet and
bank in one atomic write, and `/crime`'s fines all go through the audited
`debitUpTo`. What no pass had looked at is the credit that follows a slow,
interactive flow — a challenge answered thirty seconds after the shift was paid,
a district that filled while a contribution was in flight — and the refund when
one of those fails. Every finding below is a **credit that read nothing back**:
a bare `$inc` announced as paid whether or not the write matched a document, with
nothing written down when it did not. That is the #804/#868/#870 shape the whole
audit is about, in the four commands that had never had it applied.

The rest of the economy remains unaudited and is still listed under
[Not yet reviewed](#not-yet-reviewed).

**Files reviewed/fixed:**
- `src/commands/economy/invest.js`
- `src/commands/economy/work.js`
- `src/commands/economy/daily.js`
- `src/commands/economy/crime.js`
- `src/commands/economy/balance.js` (reviewed, sound)
- `src/commands/economy/bank.js` (reviewed, sound)
- `src/commands/economy/jobs.js` (reviewed, sound)
- `src/utils/payoutKey.js`
- `tests/economyInvestCommand.test.js`
- `tests/economyWorkCommand.test.js`
- `tests/economyDailyCommand.test.js`
- `tests/economyCrimeCommand.test.js`
- `coverage-floors.json`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `/invest contribute` had no `try` past the debit. The wallet is debited atomically, and then the pool `$inc`, the refund and `freshGuild.save()` all ran unguarded — a rejection from any of them left `execute` as an unhandled rejection with the coins gone from the wallet and nowhere else, and nothing written down | The whole post-debit flow is guarded. A throw before the pool takes the coins refunds them; a throw *after* they are in the pool does not, because the pool `$inc` is the durable record and refunding would pay the player back for coins the pool is holding — it acknowledges the contribution instead | `invest.js` |
| 2 | `/invest`'s concurrent-activation refund was a bare `$inc` that read nothing back and replied "Coins refunded" whether or not the write matched a document, filing an `invest_refund` ledger row against a balance it never observed — the #804/#870 pattern, in the one write here that had never been audited | The refund goes through `creditCoinsOrOwe` under `investRefundPayoutKey(interaction.id)`: keyed so a replay cannot pay twice, verified, and recorded as owed when it will not land. The reply is worded from what the helper reports — refunded, recorded, or neither | `invest.js`, `payoutKey.js` |
| 3 | `/work`'s challenge bonus was a bare `$inc` credited from a collector callback minutes after the guarded shift. An unmatched write still rendered "You earned an extra +N coins" and added it to the shift total; a *rejection* fell into the timeout `catch` labelled "base payout already secured", silently dropping a bonus it had already displayed | The bonus credits through `creditCoinsOrOwe` under `challengeBonusPayoutKey('work', interaction.id)`. It is announced only when the credit lands, worded as recorded-and-will-be-restored when it is owed, and the displayed total no longer includes coins that never arrived | `work.js`, `payoutKey.js` |
| 4 | `/daily`'s challenge bonus had the same bare `$inc`, and worse: a rejection there aborted to the command's generic outer `catch`, telling the player their **claim** failed after the daily had already been paid, with the bonus neither credited nor recorded | Same helper, same key constructor, phase `daily`. The claim's own result stands regardless of the bonus, and the bonus is announced from what the credit actually did | `daily.js`, `payoutKey.js` |
| 5 | `/crime`'s clean-getaway payout was a bare `$inc` whose result the embed dereferenced as `updated.balance`. Unlike `/work` and `/daily` — whose payout and cooldown are one guarded write, retryable when it misses — `/crime` claims its cooldown up front, so a payout that failed cost the player both the coins and the cooldown, and a `null` result (a pruned document) crashed the embed into a catch that told them to try a job they were now on cooldown for | The payout goes through `creditCoinsOrOwe` under `crimePayoutKey(interaction.id)`, with the `crimeRecord.totalCrimes`/`successfulCrimes` counters riding the same keyed write so the count and the coins land together. It is recorded as owed rather than lost when it cannot land, and the embed reads the settled balance and says whether the payout arrived | `crime.js`, `payoutKey.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 6 | The `/work` and `/daily` bonuses, `/crime`'s payout and `/invest`'s refund were all unkeyed, so the owed record any of them might file was against a write that may have committed and lost its response — a replay could pay it twice | Three key constructors added — `investRefundPayoutKey`, `crimePayoutKey`, `challengeBonusPayoutKey` — beside the existing family, so every credit this pass touched is exactly-once as the earlier passes' are | `payoutKey.js` |
| 7 | No tests over any of the failure paths. `/invest`'s only refund test asserted the happy path; the challenge bonuses and the crime payout were driven only far enough to pay | Failure-path tests across all four suites: `/invest`'s throw-refund and the no-refund-once-in-the-pool guard, both challenge bonuses paid and recorded-when-owed, and `/crime`'s payout filed as owed with the balance not inflated and no big-win logged. `daily.js`, `work.js` and `crime.js` join the per-file coverage floors | `tests/`, `coverage-floors.json` |

**Reviewed and found sound** — no change needed, recorded so the next pass does
not re-derive it:

- `/balance` (`balance.js`). The starter-kit credit goes through
  `claimStarterKit`, which is one atomic pipeline update guarded by
  `onboarding.starterKitClaimed`, so it cannot mint twice; the local
  `user.balance` bump after it is display-only and the command never calls
  `save()`, so there is no stale absolute write to erase a concurrent change.
- `/jobs` (`jobs.js`). A read-only listing — it reads the user and the guild
  settings and renders a table, and moves no coins.
- `/bank` (`bank.js`). `deposit` and `withdraw` are each a single atomic
  `findOneAndUpdate` moving coins between the caller's own wallet and bank under a
  `$gte` guard, so there is nothing to lose and no second write to lose it to;
  `transfer` is `commitCoinTransfer`, audited end-to-end in pass 3; `statement` is
  read-only. It defers before the transfer and statement flows for the
  three-second window, which the deposit and withdraw paths (two writes, no
  interactive wait) do not need.
- The `/crime` fine, critical-failure and lifesaver paths. All three debits go
  through `debitUpTo`, which clamps inside the update against the balance being
  written and carries the freeze in its filter — the audited-sound helper from
  pass 1. Only the success payout was the gap.
- `/invest`'s pool credit itself. The `$inc: { 'districts.$.pool': amount }` is
  atomic and, once it lands, durable; the `topContributors` bookkeeping the
  `save()` after it writes is cosmetic and already commented as such, and a
  failure there now leaves the contribution in the pool rather than escaping the
  command.

---

## Economy — The Gathering Loops

**Status: Audited — all findings resolved** ✓

The sixth pass of the economy audit #873, over the gathering loops its checklist
and [ROADMAP.md](ROADMAP.md) sequence next: `hunt`, `fish`, `mine`, `explore`,
and the detached item grants in the same surface (`use` loot boxes). These are
the highest-volume coin credits in the game — 95 of the commits since July touch
this code — and they were the last currency-mutation paths still on a bare,
unkeyed write.

The shape of the pass is the same as the five before it, with a twist the earlier
passes' commands did not have. The forward direction was sound: every gathering
run reads the user, mutates `balance` across an interactive window (an approach
prompt, a reel-in, a 20-second encounter), and credits the *net change* through
`commitBalanceDelta`/`saveWithBalanceDelta` after the save lands, so a bet placed
in another channel mid-run is never flattened (`balanceDelta.js`, audited into
these four commands already). What no pass had looked at is that **every one of
those credits passed no `payoutKey`** — the one thing that makes the credit
exactly-once. Unkeyed, `commitBalanceDelta` is three failures at once: its own
retry re-credits a write whose response was lost (a double payment); a run
against a pruned document is reported as paid though no coins moved (the #804
failure the keyed path exists to tell apart); and a payout that ultimately fails
is filed as a **keyless `FailedJob` that carries no `kind`**, so
`npm run payouts:replay` cannot settle it and the coins are lost rather than
owed. The item side had the bare-grant pattern pass 3 named: two detached grants
read nothing back and announced the prize regardless.

Scope, stated so the next pass does not assume more was covered: this pass
audited the **currency-mutation paths** of the gathering loops — the run payouts,
the apex/boss bonus payouts, the two detached item grants, and the shop-purchase
refunds. The rest of these commands (repair/upgrade/unlock pricing, quest and
mission crediting through the already-audited `onEconomyEarn`, prestige, pet
drops that ride the run's own `save()`, the tournament and map flows) was not
re-derived here and stays under [Not yet reviewed](#not-yet-reviewed).

**Files reviewed/fixed:**
- `src/services/huntService.js`, `src/services/fishService.js`, `src/services/mineService.js`, `src/services/exploreService.js`
- `src/commands/economy/hunt/start.js`, `src/commands/economy/fish/cast.js`, `src/commands/economy/mine/dig.js`, `src/commands/economy/explore.js`
- `src/commands/economy/use.js`
- `src/commands/economy/{hunt,fish,mine}/shop/*` (the purchase refunds)
- `src/utils/payoutKey.js`
- `tests/gatheringPayoutRecovery.test.js`, `tests/payoutKey.test.js`, `tests/inventoryGrantCallSites.test.js`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | The `/hunt`, `/fish`, `/mine` and `/explore` run payouts — the highest-volume credits in the game — all went through `commitBalanceDelta` with no `payoutKey`. Unkeyed, the retry inside the helper re-credits a write that committed and lost its response (a double payment), and a run against a pruned document is reported as paid while no coins move (#804) | Each `commit*` now takes a `payoutKey` built from the interaction (`gatherPayoutKey(service, interaction.id, 'run')`) and forwards it to `commitBalanceDelta`, which guards the credit on `paidPayouts.key` — the retry is a no-op and a missing document is classified rather than reported as paid | `huntService.js`, `fishService.js`, `mineService.js`, `explore.js`, `hunt/start.js`, `fish/cast.js`, `mine/dig.js`, `payoutKey.js` |
| 2 | A gathering payout that ultimately failed was filed as a **keyless `FailedJob`**, which carries no `kind` — so `npm run payouts:replay` cannot settle it. The coins were shown as owed but were, in practice, lost | With a key the same failure files a replayable owed `coins` payload under the key (`balanceDelta.js`'s keyed branch), which `payouts:replay -- --pay` settles exactly once | (as above) |
| 3 | The second credit each run can make — the `/hunt` apex bonus and the `/fish` boss bonus, paid from a collector callback minutes after the base haul — went through `saveWithBalanceDelta` unkeyed too, with the same two failures | Both credit under `gatherPayoutKey(service, interaction.id, 'apex'\|'boss')`; the phase in the key keeps the bonus from colliding with the base haul of the same interaction | `hunt/start.js`, `fish/cast.js`, `payoutKey.js` |
| 4 | `/explore` credits twice around its 20-second encounter prompt (the find, then the encounter), both unkeyed | Keyed `find` and `encounter` off the interaction, so each replays on its own and neither stands in for the other | `explore.js`, `payoutKey.js` |
| 5 | `/explore`'s recovered relic — the one grant that does not ride the run's `save()`, re-applied as an atomic upsert — was a bare `grantInventoryItem` that read nothing back and swallowed a throw into a log line that *said* "owed" while recording nothing. A relic that never landed was announced as in the player's case | Moved into `exploreService.commitExpeditionRelic`, which grants through `grantItemsOrOwe` under `exploreRelicPayoutKey(interaction.id)` — keyed, never throwing, recorded as owed when it will not land — and the result embed says "recorded as owed" instead of "in your inventory" | `exploreService.js`, `explore.js`, `payoutKey.js` |
| 6 | `/use` on a seasonal loot box consumed the box atomically and then granted the won item with a bare `grantInventoryItem`, announcing "You found a … item" whether or not the grant landed. The box is spent by then, so a failed grant lost the prize outright | The grant goes through `grantItemsOrOwe` under `lootBoxItemPayoutKey(interaction.id)`, and the embed adds a "Not Yet in Your Inventory" note when the prize is only owed | `use.js`, `payoutKey.js` |
| 7 | The `{hunt,fish,mine}/shop` purchases refund the debit when the item's stack-cap guard loses a race, and every refund was a bare `$inc` with `.catch(() => {})` that read nothing back and replied "your coins were refunded" regardless — the pass-3 `/market` unwind shape, seven handlers over | Each refund goes through `creditCoinsOrOwe` under `shopRefundPayoutKey(interaction.id)`, and the reply is worded from what the helper reports — refunded, or recorded as owed | `hunt/shop/{buy,weapon}.js`, `fish/shop/{buy,rod,upgrade}.js`, `mine/shop/{buy,pickaxe}.js`, `payoutKey.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 8 | Four key constructors were needed and did not exist | `gatherPayoutKey`, `exploreRelicPayoutKey`, `lootBoxItemPayoutKey` and `shopRefundPayoutKey` added beside the existing family, each keyed by the identifier that survives its flow | `payoutKey.js` |
| 9 | No tests over any of the failure paths, and the `grantInventoryItem` call-site sweep counted the two grants this pass moved behind `grantItemsOrOwe` | `tests/gatheringPayoutRecovery.test.js` drives the service commits against a store that evaluates the payout-key guard for real (exactly-once, replayable-owed, missing-document) plus the relic grant, and holds the eleven call sites to the keyed path; the sweep's count and its comment were updated for the two grants that left it | `tests/` |

**Reviewed and found sound** — no change needed, recorded so the next pass does
not re-derive it:

- The `detach → save → commit` transaction itself in all four commands. Keeping
  `balance` out of the `save()` and re-applying the net change as an `$inc` is
  the audited-sound shape from `balanceDelta.js`; this pass added the key, not
  the transaction.
- The shop **debits**. Every purchase charges through a `findOneAndUpdate`
  guarded by `balance: { $gte: cost }` and reads the result back, so the forward
  charge cannot overdraw or run on a stale balance — only the refund on the way
  out was bare.
- `/explore travel`'s unlock toll. Its debit is a guarded conditional update and
  its failed-save refund already reads `matchedCount` back and only promises the
  refund that landed — the pattern this pass applied elsewhere, already in place
  here.
- The material, trophy, ore and catch grants inside the run. These mutate the
  user document in memory and ride the run's single `save()`, which is one atomic
  write — there is no detached second write to lose, so they need no key.

---

## Economy — Progression and Group/PvP Payouts

**Status: Audited — all findings resolved** ✓

The seventh pass of the economy audit #873, over the reward payouts in
**progression** (the season pass) and the **group and PvP competitions** (a
syndicate's founding, a fishing tournament, and the guild-war resolution). These
are the milestone-and-competition rewards the money-moving passes had not yet
reached: every one credited coins or granted an item without a payout key, so
the three failures the shared helpers exist for lived on each — a retry or a
replay could pay twice, a write against a pruned document read as success, and a
payout that failed was lost rather than filed where `npm run payouts:replay`
could settle it, while the embed announced the reward regardless. The season
claims compounded it by recording the tier or mission as claimed in the `save()`
*before* the credit, so a failure locked the reward out behind a permanent flag
with nothing to replay.

Scope, stated so the next pass does not assume more was covered: this pass
audited the **coin and inventory-item currency-mutation paths** of these two
areas. **Seasonal events are deliberately not in it** and stay under
[Not yet reviewed](#not-yet-reviewed): they hinge on the **event currency**
(candy, hearts, snowflakes) — a separate currency the keyed helpers do not yet
cover and which is not detached from `save()` the way `balance` is — so keying
the coins beside it while leaving that untouched would half-fix each handler.
The event currency wants its own helper and its own pass (pass 8), the same way
the coverage-floor ratchet became #998 rather than riding an audit pass.

**Files reviewed/fixed:**
- `src/commands/economy/season.js`
- `src/commands/economy/syndicate.js`
- `src/commands/economy/war.js`
- `src/services/tournamentService.js`
- `src/utils/payoutKey.js`
- `tests/pass7PayoutRecovery.test.js` (added)
- `tests/tournamentPrizePayout.test.js`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `/season claim`'s tier coin reward rode `saveWithBalanceDelta` with **no `payoutKey`**, the degraded branch: the `$inc` is retried and re-credits a write whose response was lost, a missing document is reported as credited, and a hard failure files a keyless `FailedJob` `payouts:replay` cannot pay. The tier was already marked claimed in the same save, so a failed credit locked it out with the coins unrecoverable | The credit carries `seasonTierCoinPayoutKey(seasonId, userId, tier, track)`, which makes the retry a no-op, classifies a missing document, and files a replayable owed `coins` payload keyed the same | `season.js`, `payoutKey.js` |
| 2 | The tier reward **item** was a bare `grantInventoryItem` in a `try`, and that call answers `null` — not a throw — for a pruned document, so a null read as success: a tier already marked claimed could announce an item it never granted | Through `grantItemsOrOwe` under `seasonTierItemPayoutKey(seasonId, userId, tier, track)` — reads the result back, records a replayable owed payload, never throws — and `itemOwed` is set from what it reports | `season.js`, `payoutKey.js` |
| 3 | `/season claim-all` credited the whole batch of tier coins as one unkeyed `$inc`, and two concurrent claim-alls (a double-click) each computed the same batch and both credited it — a double payment on top of the unkeyed retry | One keyed credit under `seasonClaimAllCoinsPayoutKey(seasonId, userId, track, signature)`, the signature being the exact set of tiers claimed: a second claim-all of the same batch produces the same key and moves no coins, and the owed record is replayable | `season.js`, `payoutKey.js` |
| 4 | `/season claim-all`'s items were one bare `inventoryAddStages` pipeline that read nothing back and filed nothing on failure — a whole batch of items lost to a keyless console line | Each item grants through `grantItemsOrOwe` under the **same per-tier** `seasonTierItemPayoutKey` a single claim of that tier would use, so a tier claimed alone and one claimed in a batch cannot both land, and any that miss are recorded as owed | `season.js`, `payoutKey.js` |
| 5 | `/season claim-mission`'s coin reward had the same unkeyed `saveWithBalanceDelta` as the tier claim, and the mission was marked `claimed` in the same save before it — a failed credit locked the mission with the coins in a non-replayable record | Keyed by `seasonMissionCoinPayoutKey(seasonId, userId, missionDay, missionIndex)` — the mission's slot in the set dealt that UTC day, so today's slot and tomorrow's are distinct credits | `season.js`, `payoutKey.js` |
| 6 | `/syndicate` founding debits the 50k creation cost and enrolls the founder atomically, then creates the syndicate; a `create` that threw refunded the cost with a bare `$inc` that read nothing back and recorded nothing, so a refund against a pruned document left the founder out 50k with no owed record — the pass-3 `/market` unwind shape | The refund goes through `creditCoinsOrOwe` under `syndicateFoundRefundPayoutKey(interaction.id)` — recorded for replay when it will not land, exactly-once on a retry — and the enrollment is cleared by a separate self-guarded best-effort write, since a stuck founder can escape that state but not coins they cannot get back | `syndicate.js`, `payoutKey.js` |
| 7 | A fishing tournament's prize payout was a bare `$inc` per winner: a transient failure or a winner who had left the guild left `paidOut: false` on the tournament with **no owed record and no replay**, while the winners embed announced the prize regardless. Unkeyed, any retry would double-pay | The credit goes through `creditCoinsOrOwe` under `tournamentPrizePayoutKey(tournamentId, place)` — a prize it cannot land is recorded as a replayable owed payout, the key stops a replay paying twice, and the embed says "owed (being settled)" for a prize marked owed rather than promising coins | `tournamentService.js`, `payoutKey.js` |
| 8 | `war.js`'s hot path (`grantWarPoints`) resolved an expired war **inline**, and it was a buggy duplicate of the scheduler's audited resolver (#931): the `activeWar.status: active → ended` flip carried no `'active'` guard, so two point-earning commands that both saw the war expired each ran the reward `updateMany` and pushed a **second** 24h 2× coin booster onto every member of the guild — a silent, guild-wide earnings leak. It also granted only from the calling guild's perspective, rewarding the losing side whenever their own action happened to trigger the check | The inline resolver is removed; the expired war is left for `warService.resolveExpiredWars`, which runs every five minutes and claims the resolution atomically, pays the winner **by score**, and announces to both servers. The hot path simply stops scoring an expired war (its point `$inc`s already guard on `status: 'active'`) | `war.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 9 | `/season tier-skip` consumed the token and granted the tier XP in one atomic `$inc` (sound), then pruned the emptied inventory slot by filtering the array in memory and calling `save()` — which rewrites `inventory` as an absolute `$set` and would flatten a concurrent grant that landed in the gap after the consume (the `save()`-clobber `balanceDelta.js`/`inventoryGrant.js` warn about), an item loss or duplication | The prune is a targeted `$pull` of the empty slots, which touches nothing else; the in-memory copy is still filtered for the embed's "tokens remaining" line, but no document `save()` follows | `season.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 10 | Six key constructors were needed and did not exist | `syndicateFoundRefundPayoutKey`, `tournamentPrizePayoutKey`, `seasonTierCoinPayoutKey`, `seasonTierItemPayoutKey`, `seasonClaimAllCoinsPayoutKey` and `seasonMissionCoinPayoutKey`, each keyed by the identifier that names its payout across a retry and a replay | `payoutKey.js` |
| 11 | No tests over the keyed paths | `tests/pass7PayoutRecovery.test.js` drives the season claim/claim-all handlers and the syndicate founding refund against a store that evaluates the payout-key guard for real (keys written, duplicate is a no-op), pins the war hot path making no write against an expired war, and holds the mission/tournament/tier-skip call sites to the keyed path; `tests/tournamentPrizePayout.test.js` gains the owed-and-duplicate cases | `tests/` |

**Reviewed and found sound** — no change needed, recorded so the next pass does
not re-derive it:

- **Prestige** (`prestige.js`, `utils/prestige.js`). Prestige does **not** wipe
  the coin balance or the inventory: the reset is one guarded atomic
  `findOneAndUpdate` that sets `level`/`xp` to 0 and increments the rank and
  lifetime XP, touching neither `balance` nor `inventory`. There is no
  reset-then-grant window to lose value in, and no coin or item payout for
  prestiging — the reward is permanent bonus multipliers applied elsewhere.
- **`dailychallenge.js`**. The board reward is a single guarded
  `findOneAndUpdate` that credits coins and XP and stamps the cooldown in one
  write — the sound atomic payout+cooldown shape. A null match is a cooldown
  miss (no coins moved) and a failed write leaves the cooldown unset for a
  retry, so there is no separate owed path to key.
- **`synergyService.js` and `synergies.js`**. The service is pure reads (every
  function returns a bonus number); the command's only write is a
  `$setOnInsert` profile upsert. No currency moves here — the synergy bonuses
  are applied at the gather/work/crime call sites, which earlier passes covered.
- **`/season unlock`** (the premium-track purchase) is a guarded atomic debit
  and the economy's primary deliberate sink; **`/season end`**'s `seasonCoins`
  reset is a leaderboard counter, explicitly separate from the wallet, and the
  `SeasonRecord` snapshot is written before the reset.
- **`rivalryService.js`** (only writes notification timestamps),
  **`syndicateService.js`** (in-memory lobby state and outcome math), and
  **`heist.js`** (only stamps `lastHeist`) move no coins or items.
- The war **point increments** in `grantWarPoints` guard on
  `'activeWar.status': 'active'` in their own filters, so a stale-active read
  costs a no-op write rather than a wrong one — and the canonical
  `warService.resolveExpiredWars` this pass defers to was audited under #931.

**The bound this pass leaves open.** Seasonal events are not audited here, and
that is the deliberate line above rather than an omission: the event shop and
the seasonal activities move an **event currency** with no keyed helper and no
`save()`-detach, so their credits, refunds and grants need infrastructure this
pass did not build. That is pass 8. Within this pass's own scope, the season
coin credits inherit `saveWithBalanceDelta`'s one residual at-least-once corner
only when a *keyed* write commits and loses its response between the credit and
its acknowledgement — the same millisecond window every keyed credit in the
economy carries, closed by the guard on the replay, not by the live write.

---

## Economy — Seasonal Events

**Status: Audited — all findings resolved** ✓

The eighth pass of the economy audit #873, over the **seasonal-event currency**:
candy, hearts, snowflakes, shells and frost tokens. This is the currency pass 7
named and stopped short of — it lives in the `eventCurrency` array on the user
document, not in `balance`, so `creditCoinsOnce` could not credit it and there
was no keyed helper for it at all. As on every path before, the forward
direction was sound (the `/eventshop` debit is an atomic, guarded, result-read
compare-and-set); the failure was the familiar shape, on the credits and the
refund. Each moved the currency with a bare, unkeyed write — a positional `$inc`,
a `$push`, or a snapshot `$set` ridden along on a `save()` — announced as
delivered whether or not it matched a document, and recorded nowhere when it did
not. Unkeyed, that is three failures at once: the retry inside the owe helper
re-credits a write whose response was lost, a credit against a pruned document
reads as paid, and a credit that ultimately fails is lost with nothing for
`payouts:replay` to settle.

The piece pass 7 said this pass would have to build first is the keyed
event-currency helper. `creditEventCurrencyOnce` credits the array in one
aggregation-pipeline update — bumping the matching entry or appending a fresh one
— with the payout-key guard in the write's own filter, the exactly-once shape
`creditCoinsOnce` has for `balance`; `creditEventCurrencyOrOwe` wraps it with the
retry and a replayable owed `eventCurrency` payload, and `replayOwedPayout` gains
the matching `kind`.

Scope, stated so the next pass does not assume more was covered: this pass
audited the **event-currency and coin credits, the bonus item grants and the
refund** of the seasonal-event commands. It did not re-audit the event
*definition* surface (`/event start`/`end`/`status` in `event/manage.js`, and the
auto-start/auto-end scheduler in `seasonalEventService.js`), which moves no player
currency, nor the shop's *browse*/*balance* reads. One event-currency credit is
deliberately left for a follow-up — see the closing bound.

**Files reviewed/fixed:**
- `src/commands/economy/eventshop.js`
- `src/commands/economy/event/snowball.js`
- `src/commands/economy/event/trickortreat.js`
- `src/commands/economy/event/sandcastle.js`
- `src/commands/economy/event/lovenote.js`
- `src/commands/economy/event/trackhunt.js`
- `src/utils/payoutKey.js` (added `creditEventCurrencyOnce`, `eventCurrencyCreditExpr`, `eventActivityPayoutKey`, `eventShopRefundPayoutKey`)
- `src/utils/creditOrOwe.js` (added `creditEventCurrencyOrOwe`)
- `src/utils/owedPayout.js` (added the `eventCurrency` replay kind)
- `src/utils/eventActivityReward.js` (added)
- `tests/eventCurrencyPayoutRecovery.test.js` (added)

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `/trickortreat`, `/sandcastle`, `/lovenote` and `/trackhunt` each credited their **coins** through `saveWithBalanceDelta` with **no `payoutKey`** — the pass-6 degraded branch: the `$inc` is retried and re-credits a lost-response write, a missing document is reported as paid, and a hard failure files a keyless `FailedJob` `payouts:replay` cannot pay. The cooldown is claimed up front, so a failed payout costs the player the cooldown too | The coin credit carries `eventActivityPayoutKey(activity, interaction.id, 'coins')` | `event/{trickortreat,sandcastle,lovenote,trackhunt}.js` |
| 2 | Those same four rode their **event currency** on the run's `save()` via `addEventCurrency` — a snapshot `$set` of the whole `eventCurrency` array that a concurrent `/eventshop` spend landing in the window would flatten, restoring the spent currency for free — and it was not keyed or recoverable | The currency is detached from the save and credited through `creditEventCurrencyOrOwe` under `eventActivityPayoutKey(activity, interaction.id, 'currency')` (shared as `creditActivityReward`); a credit that will not land is recorded as owed and shown as owed | `event/*.js`, `eventActivityReward.js`, `creditOrOwe.js`, `payoutKey.js` |
| 3 | Those four granted their themed **bonus item** with a bare `grantInventoryItem` that read nothing back, so a grant against a pruned document (which answers `null`, not a throw) was announced as delivered over an empty bag | Through `grantItemsOrOwe` under `eventActivityPayoutKey(activity, interaction.id, 'item')` — result read, recorded as owed when it will not land, embed says so | `event/*.js`, `eventActivityReward.js` |
| 4 | `/event snowball`'s attacker **coin credit** was a bare unkeyed `$inc` and its **snowflake credit** an increment-then-push dance, both over a snowball and 5-minute cooldown already spent — a write that matched nothing announced coins and currency that never moved, with nothing to replay | Both go through the owe helpers keyed to the interaction (`'coins'`/`'currency'` phases); the append-when-absent case is folded into `creditEventCurrencyOnce`, so the three-write push dance is gone | `event/snowball.js`, `payoutKey.js`, `creditOrOwe.js` |
| 5 | `/eventshop buy` debits the currency atomically, then grants the item or effect; a grant that failed refunded the currency with a bare `$inc` and `.catch(() => {})` that read nothing back and told the player only that the purchase failed — so a refund that itself failed lost the currency outright, with no owed record (the pass-3 `/market` unwind shape, on the currency the keyed helpers did not cover) | The refund goes through `creditEventCurrencyOrOwe` under `eventShopRefundPayoutKey(interaction.id)`, and the message is worded from what the refund actually did — refunded, recorded as owed, or (neither) contact an admin | `eventshop.js`, `payoutKey.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 6 | Event currency had no keyed credit primitive — `creditCoinsOnce` credits `balance`, not the `eventCurrency` array | `eventCurrencyCreditExpr` (bump-or-append in one pipeline expression) and `creditEventCurrencyOnce` (the guarded write) join the coin and item primitives; `replayOwedPayout` gains the `eventCurrency` kind, keyed like the others | `payoutKey.js`, `owedPayout.js` |
| 7 | Two key constructors were needed and did not exist | `eventActivityPayoutKey(activity, interactionId, phase)` and `eventShopRefundPayoutKey(interactionId)` | `payoutKey.js` |
| 8 | No tests over the keyed event-currency paths | `tests/eventCurrencyPayoutRecovery.test.js` drives `creditEventCurrencyOrOwe`, the `eventCurrency` replay and `creditActivityReward` against a store that evaluates the payout-key guard and the credit pipeline for real, and holds the six call sites to the keyed path | `tests/` |

**Reviewed and found sound** — no change needed, recorded so the next pass does
not re-derive it:

- **The `/eventshop` debit** (step 2 of a purchase) is an atomic
  `findOneAndUpdate` guarded on `'eventCurrency.amount': { $gte: totalCost }`
  with its result read back — the sound compare-and-set. So is the stock
  decrement that precedes it (`$elemMatch` on `itemId` + `stock: { $gte: qty }`).
- **The stock revert** on a failed grant stays a best-effort `$inc` with
  `.catch`: it moves guild inventory, not player value, and mis-counting one
  shelf by `qty` is not a coin-integrity failure — deliberately not keyed.
- **`spendEventCurrency` / `getEventCurrencyBalance` / `addEventCurrency`** in
  `seasonalEventService.js` are in-memory helpers with unit tests; the activities
  no longer route their credit through `addEventCurrency` (it wrote through
  `save()`), but it stays for the tests and any read-side use.
- **`event/manage.js`** (`/event start`/`end`/`status`) and
  **`seasonalEventService.checkSeasonalEvents`** move no player currency — they
  write the guild's `activeEvent` definition and its shop stock, guarded where it
  matters (the uncached, projected read before `/event start`'s write).

**The bound this pass leaves open.** One event-currency credit is *not* keyed
here: `/explore`'s while-an-event-runs drop (`explore.js:addEventCurrency`), which
still rides the expedition's `save()`. It is left deliberately, for two reasons —
`explore.js` is a gathering command (pass 6's file, and its non-payout surface is
already queued under [Not yet reviewed](#not-yet-reviewed)), and it is frozen at
its `command-file-size` ceiling, so detaching and keying the drop cannot be done
without first splitting the file. The helper now exists, so it is a mechanical
follow-up once explore is split, not new infrastructure. Within this pass's own
scope, the same residual millisecond corner every keyed credit carries applies: a
keyed write that commits and loses its response between the credit and its
acknowledgement is closed by the guard on the replay, not by the live write.

---

## Economy — The Gathering Commands' Non-Payout Surface

**Status: Audited — all findings resolved** ✓

The ninth pass of the economy audit #873, over the value-moving writes the
gathering-loop payout pass (pass 6) named as out of its scope and
[ROADMAP.md](ROADMAP.md) sequenced next: the `/hunt`, `/fish` and `/mine` shops'
repair/upgrade/unlock refunds, the gathering quest-claim credits, `craft.js` and
`forge.js`, and the tournament/map/raid flows. Pass 6 keyed the run and bonus
payouts and the buy/tool shop refunds; this pass takes the rest of the same
command trees.

The shape is the one every pass finds. The forward direction was sound — the
shop debits are guarded atomic charges that read their result back (pass 6), the
craft/forge grants ride an atomic write, the raid transfer is a guarded
two-phase move with a rollback — and the failure was on the unwind and the
detached credit: a refund or credit written without a key, and on the shop
unwinds without reading the write back either, announced as done regardless. The
tournament fee is the exception and the most serious finding: not a durability
gap but a mint, a real-coin pool grown out of nothing on every entry.

Scope, stated so the next pass does not assume more was covered: this pass
audited the **currency-mutation paths** of the gathering commands' non-payout
surface. The `/pet` command's PvP-battle payouts and adopt refund are unkeyed
writes of this same class but are **deliberately left** — see the closing bound.

**Files reviewed/fixed:**
- `src/services/tournamentService.js`
- `src/utils/grindShop.js`, `src/utils/payoutKey.js`
- `src/commands/economy/{hunt,fish,mine}/shop/{repair,upgrade,unlock}.js` (the seven bare refunds; `fish/shop/upgrade.js` was already keyed in pass 6)
- `src/commands/economy/{hunt,fish,mine}/shared.js`
- `src/commands/economy/{hunt,fish,mine}/quests.js`
- `src/commands/economy/forge.js`
- `tests/gatheringNonPayoutSurface.test.js` (added), `tests/tournamentPrizePayout.test.js`, `tests/aiJsonCommands.test.js`

---

### Issues Found & Fixed

#### Critical (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | A fishing tournament's **entry fee was minted, not taken**. `submitCatch` grew the prize pool by `entryFee` on a new entrant's first catch but never debited the player — the fee the tournament announcement calls "auto-deducted on first catch" was conjured into a real-coin pool, `entryFee` coins per entrant, and then paid to the winners for real by the audited `endTournament`. An admin-set entry fee was a per-entrant coin faucet | The fee is charged atomically first (`chargeExact`, the guarded compare-and-set the shop debits use), and only a paid fee enters the player and grows the pool; a player who cannot cover it does not join, and their catch still counted as an ordinary cast. A fee debited for an entry that then fails to save is refunded through `creditCoinsOrOwe` under `tournamentEntryRefundPayoutKey` | `tournamentService.js`, `payoutKey.js` |
| 2 | The **repair/upgrade/unlock shop refunds** — seven handlers across the three shops — put coins back through the bare `refundBalance` (`refundCharge`): an unkeyed `$inc` that swallowed its own error with `.catch` and read nothing back, under a reply that said "your coins were refunded" whether or not the write matched a document. The pass-3/pass-6 `/market` unwind shape, in the shop handlers pass 6 did not reach | Each refunds through the new `refundBalanceOrOwe` (`creditCoinsOrOwe` under `shopRefundPayoutKey`), and the reply is worded from the result by `shopRefundMessage` — refunded, recorded as owed, or (neither) contact an admin. `refundBalance` stays for its #884 tests but no handler calls it now | `grindShop.js`, `{hunt,fish,mine}/shop/{repair,upgrade,unlock}.js`, `{hunt,fish,mine}/shared.js` |
| 3 | The **gathering quest-claim credits** (`/hunt`, `/fish`, `/mine quests claim`) rode `saveWithBalanceDelta` with no `payoutKey` — the pass-6 degraded branch: the `$inc` is retried and re-credits a lost-response write, a missing document is reported as paid, and a hard failure files a keyless `FailedJob` `payouts:replay` cannot settle. The quest is marked `progress: -1` (claimed) in the same `save()`, so a failed credit locked the reward out behind a permanent flag with nothing to replay, while the embed announced the coins as paid | The credit carries `questClaimPayoutKey(service, userId, questId, expiresAt)` — exactly-once, and a failure recorded as a replayable owed `coins` payload — and the embed adds a "Payout Owed" note when the credit does not land | `{hunt,fish,mine}/quests.js`, `payoutKey.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 4 | `/forge`'s refund read its own result (so, unlike the shop unwinds, it never announced a refund that had not happened — #829) but it was a bare `$inc` with no key: a transient failure lost the coins with nothing to replay, and a refund whose response was lost sent the player to an admin over coins that had in fact come back | Through `creditCoinsOrOwe` under `forgeRefundPayoutKey` — exactly-once, recorded as owed when it will not land — with the reply worded three ways by `refundClause` | `forge.js`, `payoutKey.js` |

#### Informational (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 5 | Three key constructors were needed and did not exist | `questClaimPayoutKey`, `tournamentEntryRefundPayoutKey` and `forgeRefundPayoutKey`, each keyed by the identifier that names its payout across a retry and a replay | `payoutKey.js` |
| 6 | No tests over the keyed paths | `tests/gatheringNonPayoutSurface.test.js` drives `refundBalanceOrOwe` against a store that evaluates the payout-key guard for real (exactly-once, replayable-owed) and holds the ten command call sites and `/forge` to the keyed path; `tests/tournamentPrizePayout.test.js` gains the fee-debited, cannot-afford, free-entry and refund-on-save-failure cases; `tests/aiJsonCommands.test.js`'s `/forge` refund tests move to the three-way keyed outcomes | `tests/` |

**Reviewed and found sound** — no change needed, recorded so the next pass does
not re-derive it:

- **`craft.js` and `fish/craft.js`.** Each debits the ingredients and grants the
  crafted output by mutating the in-memory user document and persisting with one
  `user.save()` — one atomic write, so there is no detached second write to lose
  and no window a crash could dupe the output or eat the ingredients in.
- **The pet drops the gathering runs grant.** `tryGrantRarePet` pushes the pet
  onto `user.pets` in memory and the run's single `save()` persists it — the same
  ride-the-atomic-save shape pass 6 found sound for the material, trophy, ore and
  catch grants. The `balance` is what pass 6 detached and keyed; the pets, like
  the rest of the run's document mutations, are one write.
- **The `/mine raid` material transfer.** A guarded two-phase move — the
  defender's materials debited under per-material `$gte` and a shield
  compare-and-set, the raider's credited under a cooldown CAS, both read back —
  with a rollback that restores the defender and tells the player "nothing was
  taken, and nothing was lost" rather than reporting a false success. It moves
  inventory materials, not coins, and mints nothing.
- **The shops' `use` handlers and the travel/switch commands** (`hunt/zone.js`,
  `fish/location.js`, `mine/map.js`). Activating a consumable decrements a stack
  and applies a buff in one save; switching zone/location/depth sets a field and
  is free — no toll, so no refund to get wrong.
- **`refundCharge`/`refundBalance`** themselves are left as the #884 best-effort
  primitive their own tests pin; finding 2 stops the handlers *calling* the bare
  one, it does not delete the primitive.

**The bound this pass leaves open.** The `/pet` command has unkeyed writes of
exactly this class — the PvP-battle winner payout is a bare `$inc` that announces
the win regardless of whether it landed, and the adopt refund tells the player
their coins came back over a write it never read — but they are **deliberately
not fixed here**, for the same two reasons pass 8 deferred the `/explore`
event-currency drop: `pet` is its own audit-queue subsystem (`pet.js`,
`petService.js`), and `pet.js` is frozen at its `command-file-size` ceiling, so
keying its payouts (which needs the owe helpers and the three-way messaging)
cannot be done without first splitting the file. The helpers all exist now, so it
is a scoped follow-up rather than new infrastructure — a dedicated `/pet` pass,
which is worth its own issue.

---

## Not yet reviewed

Nothing below has been audited. Several of these are the highest-churn areas of
the codebase — the economy alone is roughly a third of `src/` and takes the bulk
of ongoing rework — so the gap between what this file covers and what ships is
wide, and it is widest exactly where the risk is.

**Economy** — the largest uncovered area:

- `hunt`, `mine`, `fish`, `explore` — the run and bonus **payouts** and the shop-purchase **refunds** are audited above (pass 6); the **repair/upgrade/unlock shop refunds**, the **quest-claim credits**, `craft.js`, `forge.js`, and the **tournament flow** (the entry fee) are audited above (pass 9); the `/mine raid` transfer, the craft/forge grants and the pet drops that ride the run's `save()` were reviewed there and found sound. Still not reviewed: quest/mission crediting through the already-audited `onEconomyEarn`, prestige (reviewed sound in pass 7), and the map view. `/explore`'s while-an-event-runs **event-currency drop** is the one event-currency credit pass 8 did not key (it rides the expedition `save()` and `explore.js` is at its file-size ceiling) — the keyed helper now exists, so it is a follow-up once explore is split
- `pet` (`petService.js`, `pet.js`) — pass 9 reviewed the pet **drops** the gathering runs grant (sound, they ride the run's `save()`) and found the `/pet` command's **PvP-battle payouts and adopt refund** to be unkeyed writes of the audit's usual class, but left them: `pet.js` is at its `command-file-size` ceiling, so keying them needs the file split first (the same bound pass 8 left on `/explore`). Worth a dedicated `/pet` pass. `pet` feeding, the pet-care quest credits and the Pet-of-the-Week reward were reviewed and found sound
- `use` / items / effects — the seasonal loot-box item grant is audited above (pass 6); `effectsService.js`, `inventory.js`, `shop.js` and the rest of `use.js` are not
- casino (`src/games/casino/*`, `casino.js`) — `confirmBet`, the bet guards, the
  eight games' odds and their leaderboard writes. The progressive jackpot and the
  hand payout paths (including the crash lobby's `pendingCrashRefund` escrow) have
  been audited above; the stakes those hands are played for go through
  `placeWager`, which #785 covered
- core currency: `rob.js` is reviewed (pass 1); `balance`, `bank`, `daily`, `work`, `jobs`, `crime` and `invest` are audited above (pass 5); `market.js` and `gift.js` have had their unwind paths audited (pass 3), the rest of both commands has not
- group and PvP systems: the reward payouts are audited above (pass 7) — a syndicate's founding refund, the fishing-tournament prize, and the war resolution (`war.js`, `tournamentService.js`, the founding refund in `syndicate.js`), alongside the escrow and crew payouts from pass 1. `rivalryService.js` and `syndicateService.js` were found to move no currency; the non-payout remainder of `heistService.js`, `syndicateService.js` and `duel.js` (lobby state, skill checks, ELO) is not reviewed
- progression: the season-pass **coin and item reward payouts** — `/season claim`, `claim-all`, `claim-mission` and `tier-skip` — are audited above (pass 7); `prestige.js`/`utils/prestige.js`, `synergyService.js`, `synergies.js` and `dailychallenge.js` were reviewed and found to have no unkeyed currency-mutation path. `season.js`'s non-reward surface (the view/leaderboard/history/admin flows) is not reviewed
- seasonal events — the event-currency and coin credits, the bonus item grants and the `/eventshop` refund are audited above (pass 8): `eventshop.js` and the five activity commands (`event/{snowball,trickortreat,sandcastle,lovenote,trackhunt}.js`) now key every credit through the new event-currency helper. Not reviewed: the event *definition* surface (`/event start`/`end`/`status` in `event/manage.js`, the auto-start/auto-end scheduler in `seasonalEventService.js`) and the shop's browse/balance reads, none of which move player currency; and `/explore`'s event-currency drop, noted under the gathering bullet above

**Everything else uncovered:**

- AI chat, personas, and summaries (`aiService.js`, `summaryService.js`, `ai.js`, `dm.js`)
- RSS feeds and the daily newspaper (`rssService.js`, `newspaperService.js`, `newspaper.js`, `feed.js`)
- quests and achievements (`questService.js`, `achievementService.js`, `quests.js`, `questgen.js`, `achievements.js`)
- giveaways (`giveawayService.js`, `giveaway.js`)
- starboard, suggestions, and reaction roles
- command policies and the permission layer
- reminders (`reminderService.js`), polls, profiles, and the remaining utility commands
- anti-nuke (`antiNukeService.js`) and the scheduler (`services/scheduler/` and
  the domain services its job table points at)
- the dashboard beyond the settings validators named above

---

*The nine non-economy subsystems above were last reviewed on 2026-05-28; the
economy escrow and payout paths on 2026-09-01; the progressive jackpot on
2026-09-04; the gift and market unwind paths on 2026-09-05; the casino hand
payouts on 2026-09-08; the core currency commands on 2026-09-17; the
gathering-loop payouts on 2026-09-18; the progression and group/PvP payouts on
2026-09-19; the seasonal-event currency on 2026-09-20; and the gathering
commands' non-payout surface on 2026-09-22. "Not yet reviewed" carries no review
date, because nothing in it has been reviewed.*
