'use strict';

/**
 * The shared trivia deck behind /quiz and flash trivia.
 *
 * The complaint that motivated it was repeats: /quiz drew one random question
 * per play with no session token, and flash trivia drew from a forty-question
 * bank with replacement. These tests pin the behaviours that stop that — one
 * token, batches dealt without repetition, the offline bank dealt as a shuffled
 * deck — and the rate-limit spacing that keeps OpenTDB from refusing the bot.
 */

jest.mock('../src/utils/httpFetch', () => ({
    request:     jest.fn(),
    discardBody: jest.fn().mockResolvedValue(undefined),
}));

const { request } = require('../src/utils/httpFetch');
const FALLBACK    = require('../src/data/quizFallback');
const { getQuestion, decodeHtml, __test__ } = require('../src/services/triviaQuestionService');
const { resetForTests, BATCH_SIZE, LOW_WATER, REQUEST_SPACING_MS, FAILURE_BACKOFF_MS } = __test__;

const ok  = body => ({ ok: true, status: 200, json: async () => body });
const err = status => ({ ok: false, status, json: async () => ({}), body: { cancel: async () => {} } });

function batch(difficulty, tag = difficulty, n = BATCH_SIZE) {
    return Array.from({ length: n }, (_, i) => ({
        category:          'Science &amp; Nature',
        type:              'multiple',
        difficulty,
        question:          `${tag} question ${i}?`,
        correct_answer:    `right ${i}`,
        incorrect_answers: [`a${i}`, `b${i}`, `c${i}`],
    }));
}

// Routes each mocked request by endpoint and query so a test reads as a script.
function respond(handler) {
    request.mockImplementation(async url => handler(new URL(url)));
}

const isTokenCall = url => url.pathname.endsWith('api_token.php');

// Every OpenTDB call waits out the spacing on a real timer, so a draw that has
// to fetch is driven by advancing the fake clock until it settles.
async function drive(promise, ms = REQUEST_SPACING_MS * 4) {
    await jest.advanceTimersByTimeAsync(ms);
    return promise;
}

beforeEach(() => {
    jest.useFakeTimers();
    request.mockReset();
    resetForTests();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('OpenTDB session token', () => {
    test('fetches one batch under a token and deals it without repeats', async () => {
        respond(url => {
            if (isTokenCall(url)) return ok({ response_code: 0, token: 'tok1' });
            expect(url.searchParams.get('token')).toBe('tok1');
            expect(url.searchParams.get('amount')).toBe(String(BATCH_SIZE));
            expect(url.searchParams.get('difficulty')).toBe('easy');
            return ok({ response_code: 0, results: batch('easy') });
        });

        const first = await drive(getQuestion('easy'));
        expect(first.offline).toBe(false);
        expect(first.category).toBe('Science & Nature');
        expect(first.difficulty).toBe('easy');

        const seen = new Set([first.question]);
        for (let i = 1; i < BATCH_SIZE - LOW_WATER; i++) {
            const q = await getQuestion('easy');   // dealt from the deck, no network
            expect(q.offline).toBe(false);
            seen.add(q.question);
        }
        expect(seen.size).toBe(BATCH_SIZE - LOW_WATER);
        expect(request).toHaveBeenCalledTimes(2);   // token + one batch
    });

    test('refills in the background at the low-water mark without making a play wait', async () => {
        let batches = 0;
        respond(url => {
            if (isTokenCall(url)) return ok({ response_code: 0, token: 'tok1' });
            return ok({ response_code: 0, results: batch('easy', `b${batches++}`) });
        });

        await drive(getQuestion('easy'));
        for (let i = 1; i < BATCH_SIZE - LOW_WATER; i++) await getQuestion('easy');
        expect(__test__.state.decks.easy).toHaveLength(LOW_WATER);

        // This draw crosses the mark. It resolves off the deck before any timer
        // fires — under fake timers, a draw that waited on the fetch would hang.
        const q = await getQuestion('easy');
        expect(q.question).toMatch(/^b0 /);
        expect(__test__.state.refills.easy).not.toBeNull();

        await jest.advanceTimersByTimeAsync(REQUEST_SPACING_MS * 2);
        expect(__test__.state.refills.easy).toBeNull();
        expect(__test__.state.decks.easy).toHaveLength(LOW_WATER - 1 + BATCH_SIZE);
        expect(request).toHaveBeenCalledTimes(3);
    });

    test('a burst of plays on an empty deck shares one fetch', async () => {
        respond(url => {
            if (isTokenCall(url)) return ok({ response_code: 0, token: 'tok1' });
            return ok({ response_code: 0, results: batch('medium') });
        });

        const draws = Promise.all(Array.from({ length: 5 }, () => getQuestion('medium')));
        const got   = await drive(draws);

        expect(new Set(got.map(q => q.question)).size).toBe(5);
        expect(got.every(q => !q.offline)).toBe(true);
        expect(request).toHaveBeenCalledTimes(2);
    });

    test('resets the token once it has served every question, then carries on', async () => {
        const calls = [];
        respond(url => {
            calls.push(`${url.pathname}?${url.searchParams}`);
            if (isTokenCall(url)) {
                return url.searchParams.get('command') === 'reset'
                    ? ok({ response_code: 0, token: url.searchParams.get('token') })
                    : ok({ response_code: 0, token: 'tok1' });
            }
            // First batch call: exhausted. Second: fresh cycle.
            const apiCalls = calls.filter(c => c.includes('api.php')).length;
            return apiCalls === 1
                ? ok({ response_code: 4, results: [] })
                : ok({ response_code: 0, results: batch('hard') });
        });

        const q = await drive(getQuestion('hard'));
        expect(q.offline).toBe(false);
        expect(calls).toContain('/api_token.php?command=reset&token=tok1');
        expect(request).toHaveBeenCalledTimes(4);   // token, empty batch, reset, batch
    });

    test('replaces a token OpenTDB no longer recognises', async () => {
        let tokens = 0;
        respond(url => {
            if (isTokenCall(url)) return ok({ response_code: 0, token: `tok${++tokens}` });
            return url.searchParams.get('token') === 'tok1'
                ? ok({ response_code: 3 })
                : ok({ response_code: 0, results: batch('easy') });
        });

        const q = await drive(getQuestion('easy'));
        expect(q.offline).toBe(false);
        expect(__test__.state.token).toBe('tok2');
    });

    test('keeps consecutive OpenTDB calls at least the spacing apart', async () => {
        const at = [];
        respond(url => {
            at.push(Date.now());
            if (isTokenCall(url)) return ok({ response_code: 0, token: 'tok1' });
            return ok({ response_code: 0, results: batch('easy') });
        });

        await drive(getQuestion('easy'));
        expect(at).toHaveLength(2);
        expect(at[1] - at[0]).toBeGreaterThanOrEqual(REQUEST_SPACING_MS);
    });
});

describe('offline bank', () => {
    test('deals every question once before any repeats, and backs off from OpenTDB', async () => {
        respond(() => err(429));
        const bank = FALLBACK.hard.length;

        // Only the first draw has a fetch to wait out; the rest are answered
        // from the bank inside the backoff window, with no timer to drive.
        const seen = [];
        for (let i = 0; i < bank; i++) {
            const q = i === 0 ? await drive(getQuestion('hard')) : await getQuestion('hard');
            expect(q.offline).toBe(true);
            expect(q.difficulty).toBe('hard');
            seen.push(q.question);
        }
        expect(new Set(seen).size).toBe(bank);

        // The first draw tried the token and the batch; after that failure the
        // bank answered directly for the rest of the backoff window.
        expect(request).toHaveBeenCalledTimes(2);

        // The reshuffled deck never opens with the card just dealt.
        const next = await getQuestion('hard');
        expect(next.question).not.toBe(seen[seen.length - 1]);

        // Past the backoff, OpenTDB is tried again.
        await jest.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS);
        await drive(getQuestion('hard'));
        expect(request.mock.calls.length).toBeGreaterThan(2);
    });

    test('a batch with no usable questions falls back too', async () => {
        respond(url => isTokenCall(url)
            ? ok({ response_code: 0, token: 'tok1' })
            : ok({ response_code: 2 }));   // invalid parameter: no retry path

        const q = await drive(getQuestion('medium'));
        expect(q.offline).toBe(true);
        expect(FALLBACK.medium.some(f => f.question === q.question)).toBe(true);
    });

    test('"any" picks one of the three difficulties', async () => {
        respond(() => err(503));
        const q = await drive(getQuestion('any'));
        expect(['easy', 'medium', 'hard']).toContain(q.difficulty);
        expect(q.offline).toBe(true);
    });
});

describe('decodeHtml', () => {
    test('decodes the entities OpenTDB uses', () => {
        expect(decodeHtml('&quot;Rock &amp; Roll&quot; &ndash; who&#039;s first?'))
            .toBe('"Rock & Roll" – who\'s first?');
    });
});
