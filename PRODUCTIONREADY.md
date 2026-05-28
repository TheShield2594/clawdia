# Production Readiness Checklist

This file tracks the production readiness status of each feature/function in Clawdia.

---

## Welcome Function

**Status: PRODUCTION READY** ✓

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

**Status: PRODUCTION READY** ✓

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

**Status: PRODUCTION READY** ✓

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

**Status: PRODUCTION READY** ✓

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
- `src/commands/moderation/ticket.js`
- `src/commands/moderation/unban.js`
- `src/commands/moderation/unmute.js`
- `src/commands/moderation/warn.js`
- `src/services/caseService.js`
- `src/services/escalationService.js`
- `src/services/tempBanService.js`
- `src/utils/logger.js`
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
| 3 | `ticket open` subcommand had a DB save + channel creation (2+ slow operations) before reply | Added `interaction.deferReply({ ephemeral: true })` before the slow section; changed final `reply` to `editReply` | `ticket.js` |

#### Warnings (all resolved)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 4 | `user.tag` deprecated throughout — in the new Discord username system `.tag` always returns `username#0000` for non-legacy accounts | Replaced all `user.tag` / `interaction.user.tag` / `ban.user.tag` / `msg.author.tag` / `targetUser.tag` / `botUser.tag` with `globalName ?? username` | `appeal.js`, `ban.js`, `cases.js`, `closecase.js`, `escalationService.js`, `kick.js`, `logger.js`, `massban.js`, `mute.js`, `note.js`, `slowmode.js`, `softban.js`, `ticket.js`, `unban.js`, `unmute.js`, `warn.js` |
| 5 | `displayAvatarURL({ dynamic: true })` deprecated in discord.js v14 | Removed the `{ dynamic: true }` option; the method returns animated URLs by default | `cases.js` |
| 6 | `c.createdAt / 1000` in the case list embed (`cases.js`) — implicit Date→number coercion instead of explicit `.getTime()` | Changed to `c.createdAt.getTime() / 1000` | `cases.js` |
| 7 | `massban.js` fallback user object used `{ id, tag }` — mismatched logger's `globalName ?? username` lookup after fix #4 | Changed to `{ id, globalName: null, username: userId }` | `massban.js` |
| 8 | `warn.js` used flat `if` chains for subcommand dispatch — all three branches evaluated on every call | Changed to `if / else if / else if` | `warn.js` |

---

## Temp Voice Function

**Status: PRODUCTION READY** ✓

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

**Status: PRODUCTION READY** ✓

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

*Last reviewed: 2026-05-28*
