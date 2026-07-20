# VortexChat — Claude Code Project Rules

## Active Sprint: Hardening
- We are closing Tier 1 and Tier 2 gaps from `docs/mvp-core-features.md`
- That file is the **SINGLE SOURCE OF TRUTH** — update it when completing any feature
- When a task is complete, mark it done in `docs/mvp-core-features.md` before moving on

---

## Project Stack & Structure
- **Package manager: `npm`** — never use pnpm (overrides global CLAUDE.md preference)
- Stack: Next.js App Router, TypeScript, Supabase, Socket.IO, WebRTC, npm monorepo
- Monorepo layout:
  - `apps/web` — Next.js frontend + API routes
  - `packages/shared` — types, permissions, utilities
  - `signal-server` — Socket.IO for voice/WebRTC signaling

---

## Critical File & Naming Rules
- `proxy.ts` is the correct file for request interception (Next.js 16 renamed `middleware.ts` → `proxy.ts`, exported function `middleware` → `proxy`)
- **Do NOT create or reference `middleware.ts`** — it does not exist in this project
- Import permissions from `@vortex/shared` — never hardcode permission bits anywhere

---

## Before You Write Any Code
1. **Look before you build** — search the codebase for existing patterns, utilities, and components that solve the same problem before creating new ones
2. Check `packages/shared` for types and utilities that may already exist
3. Understand the existing auth and permission flow before adding a new endpoint
4. If a pattern exists somewhere in the codebase, follow it exactly — do not invent a new approach

---

## API Routes — Required Checklist
Every new API route must have ALL of the following before it is considered complete:

- [ ] Permission check using the existing proxy/auth pattern — **before any DB read or write**
- [ ] Session-derived user ID — never trust a client-supplied user ID
- [ ] Input validation on all request body fields
- [ ] Null check on every Supabase query result before accessing properties
- [ ] Structured error response — never expose raw error messages or stack traces to the client
- [ ] try/catch wrapping all async operations
- [ ] Correct HTTP status codes (401 for unauthed, 403 for forbidden, 404 for not found, 400 for bad input)

---

## Auth & Permissions
- Permission checks go **before** any data operation — reads and writes alike
- Always derive user identity from the session/token server-side — never from request body or query params
- Never assume `req.user` exists even after auth middleware — validate it explicitly
- Socket.IO and WebRTC signaling events are **not automatically authenticated** — validate the session token on every sensitive socket event
- Use the permission helpers from `@vortex/shared` — do not reimplement permission logic inline

---

## Error Handling
- Every `async` function must have `try/catch` — no silent promise rejections
- API routes must always return a structured JSON error response `{ error: string }` — never let Next.js return an unhandled 500
- Socket.IO event handlers must catch and log all errors — an unhandled throw will kill the socket connection
- Log errors with enough context to debug (route, userId, action) but **never log passwords, tokens, or PII**
- In error paths, still complete required side effects (audit logs, cleanup) where safe to do so

---

## Null & Type Safety
- Never assume a Supabase query returns a row — always check for `null` before accessing properties
- Never assume an array is non-empty — guard with `.length` checks before accessing `[0]`
- Prefer optional chaining (`?.`) over assuming a nested value exists
- Avoid `as` type casts unless you have verified the shape — prefer proper type guards
- All function parameters that could be `undefined` must be handled explicitly

---

## Moderation & Audit Logging
- Every moderation action (ban, kick, mute, message delete, role change) requires an audit log entry
- Audit log entries must include: `actorId`, `targetId`, `action`, `reason`, `timestamp`
- Write the audit log in the **same transaction** as the action where Supabase supports it
- Log **attempted** actions in error paths too — a failed ban is still worth recording
- Never skip audit logging even when a request returns an error

---

## Socket.IO / WebRTC
- Validate session/auth token on connection AND on every sensitive event — do not assume a connected socket is still authorized
- Clean up socket room membership and event listeners on disconnect
- WebRTC signaling messages must be validated for required fields before forwarding
- Do not broadcast internal server state or user data beyond what the client needs

---

## TypeScript
- No use of `any` — use `unknown` and narrow it, or define a proper type
- New shared types belong in `packages/shared/types` — not inline in `apps/web`
- Avoid `// @ts-ignore` — fix the underlying type issue instead
- All new functions should have explicit return types

---

## Self-Review — Required Before Marking a Task Done
Before completing any implementation, review your own changes against this checklist:

1. Does every async operation have error handling?
2. Does every API route have a permission check before touching data?
3. Does every Supabase result have a null check?
4. Is there any hardcoded permission bit that should come from `@vortex/shared`?
5. Is any sensitive data (token, password, PII) being logged or returned to the client?
6. Does every moderation action have an audit log entry?
7. Would TypeScript be satisfied — no implicit `any`, no unsafe casts?
8. Is `proxy.ts` being used correctly — no references to `middleware.ts`?

If any answer is "no" or "not sure", fix it before finishing.
