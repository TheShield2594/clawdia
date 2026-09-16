'use strict';

/**
 * Trivia questions for /quiz and the flash-trivia chat event.
 *
 * Both used to repeat themselves, for different reasons. /quiz asked OpenTDB
 * for one random question per play and never identified itself, so the API had
 * no memory of what it had already served: a player working through their forty
 * easy questions a day was drawing with replacement from a pool of roughly a
 * thousand, and saw the same ones again within days. OpenTDB also allows one
 * request per IP every five seconds, so two players hitting /quiz within a few
 * seconds of each other sent the second one to the offline bank — twenty
 * questions per difficulty, also drawn with replacement. Flash trivia never
 * asked OpenTDB at all; it drew, with replacement, from the forty medium and
 * hard questions in that same bank.
 *
 * Now:
 *
 *   - questions arrive in batches under an OpenTDB session token, one per
 *     difficulty. The token is the API's own no-repeat guarantee: it never
 *     returns a question it has already served under that token until the pool
 *     is exhausted, at which point the token is reset and the cycle starts
 *     over. One token per difficulty rather than one shared, because a reset
 *     wipes the token's whole memory: exhausting easy must not let medium and
 *     hard start repeating early;
 *   - each difficulty is dealt from an in-memory deck, refilled in the
 *     background when it runs low, so almost no play waits on the network and
 *     the API sees one request per BATCH_SIZE questions rather than one per
 *     question;
 *   - every OpenTDB call goes through one gate that keeps calls REQUEST_SPACING_MS
 *     apart, so the rate limit is honoured rather than tripped;
 *   - the offline bank is dealt the same way, shuffled once and dealt from until
 *     every card has gone, so a question can repeat only after the whole bank
 *     has been seen.
 *
 * A question is `{ question, category, difficulty, correct_answer,
 * incorrect_answers, offline }`, with every string already decoded.
 * `getQuestion` does not throw: when OpenTDB is unreachable, rate-limited or
 * returns nothing usable, the offline bank answers instead and `offline` says so.
 */

const { request, discardBody } = require('../utils/httpFetch');
const FALLBACK = require('../data/quizFallback');

const OPENTDB_API   = 'https://opentdb.com/api.php';
const OPENTDB_TOKEN = 'https://opentdb.com/api_token.php';

const DIFFICULTIES = ['easy', 'medium', 'hard'];

// OpenTDB caps a single request at 50 questions. Thirty keeps the batch well
// inside the smallest difficulty pool while still cutting API calls thirtyfold.
const BATCH_SIZE = 30;

// Refill in the background once a deck is this low, so the deck is normally
// topped up before it empties and a play never has to wait on the fetch.
const LOW_WATER = 5;

// OpenTDB's published limit is one request per IP every five seconds. Spacing
// is measured from the end of one call to the start of the next.
const REQUEST_SPACING_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;

// After a failed refill, stop asking OpenTDB for this long and deal from the
// offline bank instead. Without it an outage would cost every play the request
// timeout plus the spacing wait before it fell back.
const FAILURE_BACKOFF_MS = 60_000;

// OpenTDB response codes.
const CODE_OK              = 0;
const CODE_NO_RESULTS      = 1;
const CODE_TOKEN_NOT_FOUND = 3;   // the token expired (six hours unused)
const CODE_TOKEN_EMPTY     = 4;   // the token has served every question in the pool

const state = freshState();

function freshState() {
    return {
        tokens:        { easy: null, medium: null, hard: null },
        decks:         { easy: [], medium: [], hard: [] },
        refills:       { easy: null, medium: null, hard: null },   // in-flight fetch per difficulty
        offline:       { easy: [], medium: [], hard: [] },
        lastOffline:   { easy: null, medium: null, hard: null },
        gate:          Promise.resolve(),                           // serialises OpenTDB calls
        lastRequestAt: 0,
        pausedUntil:   0,
    };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// OpenTDB is asked for RFC 3986 percent-encoding (`encode=url3986`) rather
// than its default HTML entities. The default needs an entity table — `&pi;`,
// `&eacute;`, `&hellip;` and so on — that a hand-written list is always missing
// a row of, and a missed row reaches the player as literal `&pi;`. Percent-
// encoding is one call to decodeURIComponent. A string it refuses (a stray
// `%` that is not an escape) is returned as it came rather than lost.
function decodeText(str) {
    const s = String(str);
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function shuffle(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// ── OpenTDB ───────────────────────────────────────────────────────────────────

/**
 * One OpenTDB call, queued behind every other so that no two are ever closer
 * together than REQUEST_SPACING_MS. The gate is a promise chain: each call waits
 * for the previous one to settle, then for the spacing to elapse, then runs.
 */
function callOpenTdb(url) {
    const turn = state.gate.then(async () => {
        const wait = state.lastRequestAt + REQUEST_SPACING_MS - Date.now();
        if (wait > 0) await sleep(wait);
        try {
            const response = await request(url, { timeout: REQUEST_TIMEOUT_MS });
            if (!response.ok) {
                await discardBody(response);
                throw new Error(`OpenTDB returned HTTP ${response.status}`);
            }
            return await response.json();
        } finally {
            state.lastRequestAt = Date.now();
        }
    });
    state.gate = turn.catch(() => {});
    return turn;
}

async function ensureToken(difficulty) {
    if (state.tokens[difficulty]) return state.tokens[difficulty];
    const data = await callOpenTdb(`${OPENTDB_TOKEN}?command=request`);
    if (data.response_code !== CODE_OK || !data.token) {
        throw new Error(`OpenTDB token request failed: response_code ${data.response_code}`);
    }
    state.tokens[difficulty] = data.token;
    return data.token;
}

async function resetToken(difficulty) {
    const token = state.tokens[difficulty];
    state.tokens[difficulty] = null;
    const data = await callOpenTdb(`${OPENTDB_TOKEN}?command=reset&token=${encodeURIComponent(token)}`);
    if (data.response_code !== CODE_OK) {
        throw new Error(`OpenTDB token reset failed: response_code ${data.response_code}`);
    }
    state.tokens[difficulty] = data.token ?? token;
}

/**
 * A batch of questions at one difficulty. The token is best-effort: if it cannot
 * be obtained the batch is still fetched, just without the no-repeat guarantee.
 */
async function fetchBatch(difficulty, retry = true) {
    let token = null;
    try {
        token = await ensureToken(difficulty);
    } catch (err) {
        console.warn(`[trivia] no OpenTDB session token for ${difficulty} — questions may repeat:`, err.message);
    }

    const params = new URLSearchParams({
        amount: String(BATCH_SIZE),
        type:   'multiple',
        encode: 'url3986',
        difficulty,
    });
    if (token) params.set('token', token);
    const data = await callOpenTdb(`${OPENTDB_API}?${params}`);

    if (data.response_code === CODE_OK && data.results?.length) return data.results;

    if (token && retry) {
        // Every question at this difficulty has been served under its token:
        // reset that token and start the cycle over. "No results" is treated
        // the same way, since with a token it means fewer than a batch remain.
        // The other difficulties' tokens keep their memory.
        if (data.response_code === CODE_TOKEN_EMPTY || data.response_code === CODE_NO_RESULTS) {
            await resetToken(difficulty);
            return fetchBatch(difficulty, false);
        }
        // The token expired while the bot was quiet; get a new one.
        if (data.response_code === CODE_TOKEN_NOT_FOUND) {
            state.tokens[difficulty] = null;
            return fetchBatch(difficulty, false);
        }
    }

    throw new Error(`OpenTDB response_code: ${data.response_code}`);
}

function normalise(raw) {
    return {
        question:          decodeText(raw.question),
        category:          decodeText(raw.category),
        difficulty:        DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : 'medium',
        correct_answer:    decodeText(raw.correct_answer),
        incorrect_answers: (raw.incorrect_answers ?? []).map(decodeText),
    };
}

/**
 * Tops up one difficulty's deck. Concurrent callers share the in-flight fetch,
 * so a burst of plays costs one request, not one each.
 */
function refill(difficulty) {
    if (!state.refills[difficulty]) {
        state.refills[difficulty] = fetchBatch(difficulty)
            .then(results => {
                state.decks[difficulty].push(...results.map(normalise));
            })
            .catch(err => {
                state.pausedUntil = Date.now() + FAILURE_BACKOFF_MS;
                throw err;
            })
            .finally(() => {
                state.refills[difficulty] = null;
            });
    }
    return state.refills[difficulty];
}

// ── Offline bank ──────────────────────────────────────────────────────────────

function dealOffline(difficulty) {
    const deck = state.offline[difficulty];
    if (deck.length === 0) {
        deck.push(...shuffle(FALLBACK[difficulty] ?? FALLBACK.medium));
        // A fresh shuffle may put the card just dealt back on top; move it down.
        if (deck.length > 1 && deck[0] === state.lastOffline[difficulty]) {
            const j = 1 + Math.floor(Math.random() * (deck.length - 1));
            [deck[0], deck[j]] = [deck[j], deck[0]];
        }
    }
    const q = deck.shift();
    state.lastOffline[difficulty] = q;
    return {
        question:          q.question,
        category:          'General Knowledge',
        difficulty,
        correct_answer:    q.correct_answer,
        incorrect_answers: [...q.incorrect_answers],
    };
}

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * The next question at `difficulty` ('easy' | 'medium' | 'hard' | 'any').
 * Never rejects: if OpenTDB cannot supply one, the offline bank does.
 */
async function getQuestion(difficulty = 'any') {
    const key = DIFFICULTIES.includes(difficulty)
        ? difficulty
        : DIFFICULTIES[Math.floor(Math.random() * DIFFICULTIES.length)];

    const deck = state.decks[key];
    if (Date.now() >= state.pausedUntil) {
        if (deck.length === 0) {
            try {
                await refill(key);
            } catch (err) {
                console.error(`[trivia] OpenTDB ${key} fetch failed — using offline bank:`, err.message);
            }
        } else if (deck.length <= LOW_WATER) {
            refill(key).catch(err => console.error('[trivia] background refill failed:', err.message));
        }
    }

    const next = deck.shift();
    if (next) return { ...next, offline: false };
    return { ...dealOffline(key), offline: true };
}

function resetForTests() {
    Object.assign(state, freshState());
}

module.exports = {
    getQuestion,
    decodeText,
    __test__: { state, resetForTests, BATCH_SIZE, LOW_WATER, REQUEST_SPACING_MS, FAILURE_BACKOFF_MS },
};
