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

*Last reviewed: 2026-05-28*
