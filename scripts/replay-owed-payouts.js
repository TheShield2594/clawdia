#!/usr/bin/env node
'use strict';

// Lists and replays payouts a scheduled job claimed but never delivered (#804).
//
//   npm run payouts:replay             # list what is owed, pay nothing
//   npm run payouts:replay -- --pay    # attempt every pending owed payout
//
// `announceWeeklyChampions` and `returnExpiredMarketListings` both claim a record
// before paying out — the winner is flipped to `rewarded`, the listing is
// deleted — so a credit that fails afterwards cannot be retried by re-running
// the job: the next tick finds nothing. Instead each one is written down as a
// FailedJob whose payload names who is owed what (src/utils/owedPayout.js), and
// this is what pays them.
//
// It is deliberately an operator command rather than an automatic retry. These
// records exist because a write did not land, and the failure that stopped it —
// a database that was down, a user document that no longer exists — is usually
// still true a minute later; a loop that kept trying would spend its attempts
// before anyone could look. Shell access to the host is the same bar as
// `npm run migrate:rollback`, and the same reasoning: a hand on the wheel for
// the operations that move data no other path can put back.
//
// Every attempt goes through retryJob, so the DLQ record carries its own audit
// trail: attempts, last error, and `resolved`/`exhausted` at the end of it. A
// record that exhausts its attempts is left for a human — nothing here deletes
// one.

require('dotenv').config();
require('../src/config/fileSecrets').loadFileSecrets();

const mongoose = require('mongoose');
const FailedJob = require('../src/models/FailedJob');
const { retryJob, claimableFilter } = require('../src/utils/jobRunner');
const { replayOwedPayout, describeOwedPayout, OWED_SUFFIX } = require('../src/utils/owedPayout');

async function main() {
    const pay = process.argv.slice(2).includes('--pay');

    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set (put it in .env or the environment).');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    try {
        // claimableFilter is retryJob's own claim condition: pending or
        // retrying, and not under a live lease. Selecting on anything looser
        // would list records the replay below is about to refuse — 'exhausted'
        // has spent its attempts and wants a human, 'resolved' has been paid,
        // and a record another run is replaying right now is that run's.
        const owed = await FailedJob.find({
            jobName: { $regex: `\\${OWED_SUFFIX}$` },
            ...claimableFilter(),
        }).sort({ createdAt: 1 });

        if (owed.length === 0) {
            console.log('Nothing owed.');
            return;
        }

        console.log(`${owed.length} owed payout(s):\n`);
        for (const record of owed) {
            console.log(
                `  ${record._id}  ${record.jobName}  ${describeOwedPayout(record.payload)}  ` +
                `(attempt ${record.attempts}/${record.maxAttempts}, last error: ${record.errorMessage})`
            );
        }

        if (!pay) {
            console.log('\nNothing was paid. Re-run with --pay to attempt these.');
            return;
        }

        console.log('');
        let paid = 0;
        let stillOwed = 0;
        for (const record of owed) {
            const what = describeOwedPayout(record.payload);
            try {
                const after = await retryJob(record._id, replayOwedPayout, 'replay-owed-payouts');
                if (after.status === 'resolved') {
                    paid++;
                    console.log(`  paid    ${what}`);
                } else {
                    stillOwed++;
                    console.error(`  FAILED  ${what} — ${after.errorMessage} [${after.status}]`);
                }
            } catch (err) {
                // retryJob refuses a record another run resolved or exhausted
                // between the listing above and here.
                stillOwed++;
                console.error(`  SKIPPED ${what} — ${err.message}`);
            }
        }

        console.log(`\nPaid ${paid}, still owed ${stillOwed}.`);
        if (stillOwed > 0) process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
});
