# Production Readiness Checklist

This file tracks the production readiness status of each feature/function in Clawdia.

---

## Welcome Function

**Status: NOT PRODUCTION READY**

**Files reviewed:**
- `src/utils/cardGenerator.js` — `createWelcomeCard()`
- `src/events/guildMemberAdd.js` — `guildMemberAdd` event handler
- `src/models/Guild.js` — `welcome` schema
- `src/dashboard/routes/api.js` — settings save endpoint

---

### Issues

#### Critical

1. **Text overflow on welcome card** (`cardGenerator.js:19,22`)
   - `member.user.tag` and `Member #N` are drawn at hardcoded x=250 with no truncation or wrapping. Long usernames will overflow the 800px canvas width and be cut off or render off-canvas.

2. **No message length validation** (`Guild.js:51`, `guildMemberAdd.js:68,79`)
   - The `welcome.message` and `welcome.dmMessage` fields have no `maxlength` constraint in the schema. Discord embed descriptions are capped at 4096 characters. A template that expands past this limit (e.g., a server with a very long name inserted via `{server}`) will cause a Discord API error and drop the welcome message silently.

3. **Canvas clip is never restored** (`cardGenerator.js:28-30`)
   - `ctx.clip()` is called without a preceding `ctx.save()` or a following `ctx.restore()`. The clipping region is never released. Any future changes to this function that add drawing after the avatar block will be silently clipped to the avatar circle.

#### Warnings

4. **Deprecated Discord.js `dynamic` option** (`guildMemberAdd.js:81,108`)
   - `displayAvatarURL({ dynamic: true })` uses a deprecated option. The correct replacement in discord.js v14+ is `forceStatic: false` or just omitting the option. This still works today but will break on a future library update.

5. **`user.tag` is deprecated in new Discord username system** (`cardGenerator.js:19`, `guildMemberAdd.js:108`)
   - `user.tag` returns `username#0000` but in Discord's new username system most accounts have no discriminator, so `.tag` just mirrors `.username`. Using `user.username` directly or `user.globalName ?? user.username` is the correct approach.

6. **No timeout on avatar image load** (`cardGenerator.js:25`)
   - `loadImage(avatarURL)` has no timeout. A slow or unresponsive CDN response will stall the entire `guildMemberAdd` handler indefinitely until the Node.js socket times out at the OS level.

7. **Auto-roles applied sequentially** (`guildMemberAdd.js:94-99`)
   - Auto-roles are awaited one-by-one in a `for...of` loop. On servers with many auto-roles, this introduces unnecessary latency. Should use `Promise.allSettled`.

8. **Analytics upsert is non-atomic** (`guildMemberAdd.js:7-27`)
   - The two-step upsert in `trackMemberEvent` (try update, then insert if no match) is not atomic. Under a burst of simultaneous joins it can create duplicate date entries. Low risk in practice but not correct under concurrency.

9. **System font dependency** (`cardGenerator.js:13,17,21`)
   - The canvas renders using Arial, a system font. If Arial is not installed in the deployment environment (e.g., a minimal Docker image), Node canvas will silently fall back to a default monospace font and the card layout will break. A font should be bundled and registered explicitly.

10. **No bot permission check before sending** (`guildMemberAdd.js:61-85`)
    - Before sending to the welcome channel, no check is made that the bot has `SendMessages` and `AttachFiles` permissions in that channel. Failures are swallowed by the outer `try/catch` and logged, but there is no admin notification or structured error.

#### Informational

11. **No tests** — There are no unit or integration tests for `createWelcomeCard`, `applyVariables`, or the `guildMemberAdd` handler.

12. **API settings save has no field-level validation for welcome** (`api.js:228-229`) — Only the top-level key name (`welcome`) is whitelisted. Individual field values within the welcome object are validated only by Mongoose schema constraints, which currently have no length limits on message fields.

---

### Summary Table

| # | Severity | Issue | File |
|---|----------|-------|------|
| 1 | Critical | Text overflow on canvas for long usernames | `cardGenerator.js:19,22` |
| 2 | Critical | No max length on welcome/DM message (Discord 4096 char limit) | `Guild.js:51,54` |
| 3 | Critical | Canvas clip never restored (`save`/`restore` missing) | `cardGenerator.js:27-35` |
| 4 | Warning | Deprecated `dynamic` avatar option | `guildMemberAdd.js:81,108` |
| 5 | Warning | `user.tag` deprecated in new username system | `cardGenerator.js:19` |
| 6 | Warning | No timeout on avatar image fetch | `cardGenerator.js:25` |
| 7 | Warning | Auto-roles applied sequentially, not in parallel | `guildMemberAdd.js:94-99` |
| 8 | Warning | Non-atomic analytics upsert (race condition under burst joins) | `guildMemberAdd.js:7-27` |
| 9 | Warning | System Arial font dependency — not bundled | `cardGenerator.js:13,17,21` |
| 10 | Warning | No bot permission check before sending to welcome channel | `guildMemberAdd.js:61-85` |
| 11 | Info | No tests | — |
| 12 | Info | No field-level validation for welcome settings in API | `api.js:228-229` |

---

*Last reviewed: 2026-05-28*
