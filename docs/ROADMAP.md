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

So net-new game features waited, and every currency-mutation path got the
treatment the nine long-stable subsystems got. **That condition is now met**:
every area in the audit log's economy list has had a pass, and the changes that
landed after the last one were re-checked with no findings. The freeze is
lifted. What stays is the rule the passes kept proving: a change to the economy
is a reason to re-check it, recorded in the audit log like any other pass.
Twenty-four passes landed under
that decision already — `/duel` escrow and the `/heist` and `/syndicate` crew
splits in v4.5.2, the casino's progressive jackpot in v4.6.0, `/gift` and
`/market` in v4.6.1, the casino's hand payouts in v4.7.0, the core currency
commands (`balance`, `bank`, `daily`, `work`, `jobs`, `crime`, `invest`) in
v4.11.1, the gathering-loop payouts (`hunt`, `fish`, `mine`, `explore`) in
v4.11.2, the progression and group/PvP reward payouts (the season pass, a
syndicate's founding, a fishing tournament, the war resolution) in v4.12.1, the
seasonal-event currency (the event activities and the event shop) in v4.12.3,
the gathering commands' non-payout surface (the shop refunds, the quest-claim
credits, `/forge`, and a tournament entry fee that was minted rather than taken)
in v4.13.1, the `/pet` command's PvP-battle payouts and adopt refund in
v4.13.2, the quest-reward credit keyed at every caller in v4.13.3, and the rest
of the casino (`confirmBet`, the bet guards, the crash restart refund and the
leaderboard writes) in v4.13.4, `/explore`'s event-currency drop in
v4.13.5, and the items, effects and server shop (`/use`, `/shop buy`, the event
shop's effect purchases) in v4.13.6, the effect consumers in v4.13.7, and the
map views in v4.13.8, the `/explore` views in v4.13.9, the season pass's views in v4.13.10, season XP,
tier claims and mission progress in v4.13.11, and the gathering commands'
profiles, inventories and prestige in v4.13.12, and the rest of `/market` and
`/gift` with `/trade` in v4.13.13, the heist, syndicate and duel lobbies in
v4.13.14, the seasonal-event definition surface in v4.13.16, and the casino's
odds in v4.13.17 — and between them they found the same defect on
path after path: a
credit or grant written without reading the write back and without a key to
replay it. That is
the argument for the order, and it is worth re-reading before anybody proposes
suspending it.

What this does *not* mean: bug fixes, security work, operational work and
documentation are not features and are not blocked. Nothing below is sequenced
behind the audit except new game systems.

## Next

Each item links to the issue or the audit-log entry that holds the detail.
Nothing is restated here, so that there is only ever one copy to correct.

The two items that stood here before — acknowledging moderation interactions
before the slow work ([#995](https://github.com/TheShield2594/clawdia/issues/995))
and ratcheting the gathering loops' coverage floors
([#998](https://github.com/TheShield2594/clawdia/issues/998)) — are done.

1. **The AI-layer audit's remaining open findings**, in the order
   [that section](AUDIT_LOG.md#ai-layer-unattended-runs-tools-mcp-and-spend)
   lists them: page reads as an exfiltration path in unattended runs (B), and a
   monthly ceiling that is checked but not reserved (C). The rest are low and
   wait for a reason to touch the code they are in. Who may use a guild's MCP
   connections, which stood first here, is decided: OAuth and `managers_only`
   connections are for members with Manage Server, and approval defaults to
   them too.

## The audit queue

[docs/AUDIT_LOG.md](AUDIT_LOG.md) is the record of what has been audited and what
each pass found; its
[Not yet reviewed](AUDIT_LOG.md#not-yet-reviewed) section is the queue. That list
is long and mostly unordered, deliberately — it is a survey, not a plan. The
order this roadmap commits to, within the economy, is money-moving first.
Twenty-four passes have landed against it — `/duel` escrow and the crew splits, the
progressive jackpot, `/gift` and `/market`, the casino's hand payouts and crash
refunds, the core currency commands, the gathering-loop payouts (`hunt`,
`fish`, `mine`, `explore`, plus the `/explore` relic and `/use` loot-box item
grants), the progression and group/PvP reward payouts (the season pass, a
syndicate's founding, a fishing tournament, the war resolution), the
seasonal-event currency (the event activities and the event shop), the
gathering commands' non-payout surface (the shop refunds, the quest-claim
credits, `/forge`, and the tournament entry fee), the `/pet` command's
PvP-battle payouts and adopt refund, and the **quest-reward credit keyed at
every caller** (`awardQuest` through `onMessage`/`onReaction`/`onCommandUse`/
`onEconomyEarn`/`onPetCare`), and **the rest of the casino** (`confirmBet`, the
bet guards re-asked on every replay, the crash restart refund that had never
run, and the leaderboard and stat writes), `/explore`'s **event-currency
drop**, the one credit pass 8 deferred, and **the items, effects and server
shop** — `/shop buy`'s refunds (the last bare coin credits, missed because the
earlier passes covered the grind shops but not the server shop), and the `/use`
and event-shop paths that spent an item or currency before a `save()` that
could fail — and **the effect consumers**, which turned out to be every
`save()` of a user: `activeEffects` is now kept out of `save()` by the model and
charges are committed as guarded writes — and **the gathering commands'
remaining surface**, where `/hunt` and `/fish` prestige saved a whole grind
profile from a button collector running outside the economy lock — and **the
player market, gifts and trades**, where `/trade` counted a confirmation pressed
on an offer that had since changed — and **the heist, syndicate and duel
lobbies**, where a ranked duel played past the season's end cost the leader
their prize — and **the seasonal-event definition surface**, where the hourly
sweep and `/event start`/`end` each wrote `activeEvent` over whatever another
had just written, and `/event end` on a seasonal event lasted an hour — and
**the casino's odds**, which the roadmap had listed as moving nothing and which
turned out to be where the economy minted the most: five games (crash's auto
cash-out, Three Card Monte, higher-or-lower, slots and poker) paid back more
than they took, and blackjack's insurance prompt leaked the hole card — which
leaves:

1. nothing unaudited in the economy. Every area in the audit log's economy list
   has had a pass. Twice now (pass 14's server-shop refunds, pass 24's odds) a
   pass has found money moving in an area this roadmap had called non-payout,
   so "nothing money-moving is left" is a finding to re-check whenever the
   economy changes rather than a settled result
2. nothing on the coverage floors either: they were re-measured after pass 24
   and ratcheted (#998) — 41 directory floors raised, the global threshold from
   51/41/53/52 to 63/54/62/65 — and the last two economy directories with a
   branch floor of 0, `fish/shop` and `pet`, earned floors of 92 and 82 from
   suites of their own. No economy directory is left on the `unguarded` list

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
- **Recurring agent runs
  ([#1045](https://github.com/TheShield2594/clawdia/issues/1045)).** This entry
  used to say "not planned"; recurring runs shipped anyway — cron-scheduled AI
  tasks, scheduled tasks that run as deep tasks with sub-agents, and delivery by
  DM — without this file being edited, which is the drift this file exists to
  prevent. What the entry warned about held: with nobody watching, the approval
  flow is the safety boundary, and until the AI-layer audit it was not one — a
  guild on the default confirm mode had its MCP write tools run on a timer with
  no list read. That is fixed (unattended turns confirm under at least `writes`,
  and only the per-connection "run without asking in scheduled tasks" list can
  pass a write). The "per-task tool firewall" for DM tasks this entry once
  named was never built: a DM task has the same tools as a channel task, and is
  instead held to its creator still having Manage Server on every run.
  Condition-triggered runs (watch a feed, fire on a change) remain not planned,
  for the reason above.

## Keeping this honest

A roadmap goes stale the way every roadmap goes stale: by describing a plan
nobody is following any more. The guard against that here is that it is short
and that it says one thing — what is next. Update it when a pass lands.
[CHANGELOG.md](../CHANGELOG.md) says what happened,
[docs/AUDIT_LOG.md](AUDIT_LOG.md) says what was audited and what it found, and
this file says what comes after. If it ever disagrees with the issue tracker, the
tracker is right and this file is out of date.
