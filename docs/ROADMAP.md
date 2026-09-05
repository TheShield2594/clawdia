# Roadmap

What is planned next, in what order, and the one tradeoff that decides the order.

Sequencing used to be reconstructable only by reading [CHANGELOG.md](../CHANGELOG.md)
backwards and following issue references (#914), which meant the debt-versus-feature
call — audit the economy or ship the next game system — was being made implicitly,
one pull request at a time. It is made here instead.

This file carries no dates and no estimates, because it would be wrong about
both. It carries order, and the reason for it. It is a record of a decision, not
a promise: changing the order is an edit to this file in the pull request that
changes it, which is the whole of the mechanism.

## The standing decision: the economy audit comes before new game features

The economy and RPG layer is the largest area of the codebase, the
highest-churn, the lowest-covered, and the one that has already shipped
coin-integrity bugs — dual jackpot pools, minted boosters, negative balances
that needed a migration to clamp. It is also the area with the least audit
coverage, which is [#873](https://github.com/TheShield2594/clawdia/issues/873):
audit coverage is widest exactly where the risk is not.

So net-new game features wait, and every currency-mutation path gets the
treatment the nine long-stable subsystems got. Two passes have landed under that
decision already — `/duel` escrow and the `/heist` and `/syndicate` crew splits
in v4.5.2, the casino's progressive jackpot in v4.6.0 — and between them they
found thirteen critical defects in code that was live. That is the argument for
the order, and it is worth re-reading before anybody proposes suspending it.

What this does *not* mean: bug fixes, security work, operational work and
documentation are not features and are not blocked. Nothing below is sequenced
behind the audit except new game systems.

## Next

Each item links to the issue that holds the detail. Nothing is restated here,
so that there is only ever one copy to correct.

1. **Economy audit, pass 3 — the rest of the casino.**
   ([#873](https://github.com/TheShield2594/clawdia/issues/873)) The progressive
   jackpot is audited. The eight games' own wager and payout writes,
   `confirmBet`, and the crash lobby's `pendingCrashRefund` escrow are not — and
   they are where every ordinary casino payout is made.
2. **Economy audit, pass 4 — `gift` and `market`.**
   ([#873](https://github.com/TheShield2594/clawdia/issues/873)) The last two
   unticked entries on that issue's checklist, and the two remaining paths where
   coins move between users outside a game.
3. **The unapplied CodeRabbit findings.**
   ([#985](https://github.com/TheShield2594/clawdia/issues/985)) Four items:
   undrained response bodies leaking sockets, MCP requests that carry
   credentials over plain HTTP, and two tests that pass whether or not the thing
   they name is true. Independent of the audit and small enough to take whenever
   a pass is waiting on review.
4. **Ratchet the coverage floors each pass earns.** `src/commands/economy/fish`
   and `src/commands/economy/mine` sit at 14% and 16% statements with branch
   floors of 0 — recorded in `coverage-floors.json`'s `unguarded` list, so they
   may shrink and must not grow. Neither pass has reached them yet. The floors
   move when a pass lands on that code, not before and not by hand.

## The audit queue

[docs/AUDIT_LOG.md](AUDIT_LOG.md) is the record of what has been audited and what
each pass found; its
[Not yet reviewed](AUDIT_LOG.md#not-yet-reviewed) section is the queue. That list
is long and mostly unordered, deliberately — it is a survey, not a plan. The
order this roadmap commits to, within the economy, is money-moving first:

1. the rest of the casino — per-game wagers and payouts, `confirmBet`, the crash
   lobby's refunds
2. `gift` and `market`
3. the core currency commands — `balance`, `bank`, `daily`, `work`, `jobs`,
   `crime`, `invest`
4. the gathering loops — `hunt`, `fish`, `mine`, `explore` — and items, effects
   and `use`
5. progression, the group and PvP systems, seasonal events

Everything outside the economy stays in the audit log's list and is not sequenced
ahead of any of the above.

## Decided, not planned

Recorded so they are not silently re-opened by the next reader who notices them.
Each of these is a decision with a reason, and either can be revisited — by
editing this file.

- **TLS on `db-network`
  ([#975](https://github.com/TheShield2594/clawdia/issues/975)).** Built, opt-in,
  and off by default. `db-network` is `internal: true`, and deciding that an
  unroutable network is a sufficient trust boundary for a single-host deployment
  is a legitimate answer rather than a deferred one — the certificate that
  encryption needs is an operational cost with an expiry date attached. The
  procedure, and the case for leaving it off, are in
  [SETUP_GUIDE.md](SETUP_GUIDE.md#encrypting-mongodb-traffic-with-tls).
- **`rss-parser` ([#954](https://github.com/TheShield2594/clawdia/issues/954)).**
  A watch, not a task. No work is planned unless the package goes unmaintained;
  `tests/rssParserWatch.test.js` is what keeps the watch from lapsing quietly,
  and the exit — vendoring the one method the bot actually calls — stays cheap
  for as long as that test holds.
- **A durable outbox for jackpot payouts.** Deferred during pass 2 with the
  reasoning written down in the audit log rather than dropped:
  `casinoJackpot.pendingPayoutKey` holds one unsettled claim per guild, so losing
  a claim needs a failed credit *and* the process dying before the owed payout is
  filed *and* a second jackpot in the same guild before the next boot. The
  alternative considered was a growing array on the guild document, which is the
  shape [#888](https://github.com/TheShield2594/clawdia/issues/888) had just
  finished removing. Worth its own issue if that trade should be reopened.

## Keeping this honest

A roadmap goes stale the way every roadmap goes stale: by describing a plan
nobody is following any more. The guard against that here is that it is short
and that it says one thing — what is next. Update it when a pass lands.
[CHANGELOG.md](../CHANGELOG.md) says what happened,
[docs/AUDIT_LOG.md](AUDIT_LOG.md) says what was audited and what it found, and
this file says what comes after. If it ever disagrees with the issue tracker, the
tracker is right and this file is out of date.
