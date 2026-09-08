'use strict';

/**
 * Pure content analysis for the auto-moderation filters.
 *
 * The filters used to inline their matching in `events/messageCreate`: a
 * substring test for `http://`, a two-alternative regex for invites, an
 * `[a-z]`/`[A-Z]` ratio for caps, and a `\bword\b` list for profanity. Each of
 * them was one obfuscation away from useless, and none of them could be
 * exercised without driving a whole fake message through the event handler —
 * so the evasions were invisible. Everything here is a pure function over a
 * string, which is what lets `tests/contentFilters.test.js` state each evasion
 * and each false positive as its own case.
 *
 * The rule this file follows throughout: normalize the *text* toward a
 * canonical form, and build the *pattern* to tolerate what normalization cannot
 * reach. A filter that only catches the literal spelling is a filter that
 * catches nobody who is trying.
 */

// Invisible characters. Zero-width space and friends are the cheapest evasion
// there is: a zero-width space between two letters renders as nothing, so
// `f<U+200B>uck` reads as "fuck" on screen and matches no pattern. The bidi
// overrides belong here for the same reason.
const INVISIBLE_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

// Letters from other scripts that render as Latin ones. Cyrillic 'о' and Latin
// 'o' are one pixel apart and a different code point, which is the whole point
// of using them. Only lowercase keys: the fold below lowercases first.
const HOMOGLYPHS = {
    // Cyrillic
    'а': 'a', 'в': 'b', 'с': 'c', 'ԁ': 'd', 'е': 'e', 'ё': 'e', 'ԑ': 'e', 'ѕ': 's',
    'һ': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
    'р': 'p', 'г': 'r', 'т': 't', 'у': 'y', 'х': 'x', 'ц': 'u', 'ѵ': 'v', 'ԝ': 'w',
    // Greek
    'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'ι': 'i', 'κ': 'k',
    'ν': 'v', 'ο': 'o', 'ρ': 'p', 'σ': 'o', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');

// Leet-speak substitutions, unchanged from the inline map this replaced.
const LEET_MAP = {
    '4': 'a', '@': 'a', '3': 'e', '€': 'e', '1': 'i', '!': 'i',
    '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '9': 'g',
    '6': 'b', '8': 'b',
};
// Built by escaping only what a character class treats as special. An earlier
// draft escaped every key, which turned `1` into `\1` — an octal escape, not
// the digit — and quietly stopped folding every leet digit in the map.
const LEET_RE = new RegExp(
    `[${Object.keys(LEET_MAP).map(c => c.replace(/[\\\]^-]/g, '\\$&')).join('')}]`,
    'g'
);

// A run of single characters joined by separators — `f u c k`, `f.u.c.k`,
// `f-u-c-k` — collapsed back into one word.
//
// The predecessor of this pattern was `\b(\w)([\s.\-_*]{1,2}(?=\w))+`, which
// needed only *one* separator to fire. That meant any one-letter word glued
// itself to whatever followed: "you are a bitch" normalized to "you are
// abitch", and `\bbitch\b` no longer had a boundary to match against. The most
// ordinary phrasing of an insult in English was the one spelling the profanity
// filter could not see. Requiring at least two joins (so three characters in
// the run) is what separates deliberate spacing-out from a sentence that
// happens to contain "a" or "I".
const SPACED_RUN_RE = /\b(?:\w[\s.\-_*+~]{1,2}){2,}\w\b/g;
const SPACED_RUN_SEPARATORS = /[\s.\-_*+~]/g;

/**
 * Fold a message toward the plainest spelling of itself, so that one pattern
 * per bad word can stand in for the hundreds of ways it gets typed.
 *
 * NFKC does the heavy lifting no hand-written table can: fullwidth `ｆｕｃｋ`,
 * the mathematical alphabets Discord users reach for (`𝓯𝓾𝓬𝓴`), and ligatures
 * all fold to ASCII. The NFD pass then strips combining marks, which handles
 * both accents (`fück`) and zalgo used as cover.
 */
function normalizeToxic(text) {
    if (!text) return '';
    let s = String(text).normalize('NFKC').toLowerCase();
    s = s.replace(INVISIBLE_RE, '');
    s = s.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
    s = s.replace(HOMOGLYPH_RE, ch => HOMOGLYPHS[ch]);
    s = s.replace(LEET_RE, ch => LEET_MAP[ch]);
    // Runs of three or more collapse to two, not to one. Collapsing to one was
    // destructive: "asss" became "as", and the doubled letter in "ass" is not
    // padding, it is the word. Two is enough to cap `fuuuuuck` while leaving
    // every doubled letter that means something intact — and the patterns below
    // accept any run length anyway, so this only bounds the work.
    s = s.replace(/(.)\1{2,}/g, '$1$1');
    s = s.replace(SPACED_RUN_RE, run => run.replace(SPACED_RUN_SEPARATORS, ''));
    return s;
}

function escapeRe(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Endings that make a listed word a different word only grammatically.
// "assholes", "fucks", "bitching" and "crappy" were all invisible to a
// `\bword\b` match, which is a strange place to draw a line.
//
// The set is deliberately closed rather than "any trailing letters": an open
// suffix turns "ass" into a match for "assassin", which is exactly the class of
// false positive the word boundary exists to prevent. Every entry here was
// checked against the base list for that (`assassin`, `assess`, `assign`,
// `pussycat`, `niggardly`, `cocktail`, `shitake` and `hello` all stay clean).
const SUFFIX_GROUP = '(?:s|es|ed|er|ers|ing|ings|in|y|ies|z|zz)';

/**
 * Compile one blocked word into a pattern that tolerates the spellings
 * normalization cannot reach.
 *
 * Each character is allowed to repeat (`f+u+c+k+`), which covers the padded
 * spellings — `shitt`, `biitch`, `fuuuck` — that survived the repeat collapse
 * because collapsing only fires at three. Spaces inside a listed phrase match
 * any run of separator, so "porch monkey" also catches "porch-monkey".
 */
function compileBadWordRegex(word) {
    const chars = [...String(word ?? '').toLowerCase().trim()];
    if (!chars.length) return null;

    const body = chars
        .map(ch => (/\s/.test(ch) ? '[\\s._\\-]+' : `${escapeRe(ch)}+`))
        .join('');

    // `\b` is only meaningful next to a word character. A list entry that
    // starts or ends with punctuation gets no boundary on that side, rather
    // than a boundary that means the opposite of what it reads as.
    const lead = /\w/.test(chars[0]) ? '\\b' : '';
    const endsWithWordChar = /\w/.test(chars[chars.length - 1]);
    const tail = endsWithWordChar ? `${SUFFIX_GROUP}?\\b` : '';

    return new RegExp(`${lead}${body}${tail}`, 'i');
}

/**
 * Compile a word list, dropping anything the guild has explicitly allowed.
 *
 * The base list bundles slurs with mild profanity — `hell`, `damn`, `dick` —
 * and a guild that wants the first without the second previously had no way to
 * say so, since the list could only be added to. Names are the sharpest edge of
 * that: "Dick Grayson" was a deleted message and a filed case.
 */
function buildBadWordRegexes(words, allowlist = []) {
    const allowed = new Set(
        (allowlist || []).map(w => String(w ?? '').toLowerCase().trim()).filter(Boolean)
    );
    return (words || [])
        .filter(word => !allowed.has(String(word ?? '').toLowerCase().trim()))
        .map(compileBadWordRegex)
        .filter(Boolean);
}

/** Does the already-normalized text match any of the compiled patterns? */
function matchesAny(normalizedText, regexes) {
    return regexes.some(re => re.test(normalizedText));
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

// Hosts that hand out Discord invites. The filter used to know two of them, so
// `discordapp.com/invite/x` — the domain Discord itself still redirects — and
// every third-party vanity shortener walked straight through a server that had
// invite filtering switched on.
const INVITE_HOSTS = [
    'discord\\.gg',
    'discord\\.com/invite',
    'discordapp\\.com/invite',
    'discordapp\\.net/invite',
    'discord\\.me',
    'discord\\.io',
    'discord\\.li',
    'discord\\.link',
    'dsc\\.gg',
    'dscrd\\.me',
    'invite\\.gg',
    'disboard\\.org/server/join',
];

const INVITE_RE = new RegExp(`(?:${INVITE_HOSTS.join('|')})/([a-z0-9_-]{2,64})`, 'gi');

// Whitespace is closed up *around dots and slashes* before matching, so
// `discord .gg/ abcd` and a link broken across two lines read the same as the
// plain spelling.
//
// Only around those two characters. Removing whitespace outright glues the code
// to whatever follows it -- `discord.gg/abcd and more` yields the code
// "abcdandmore", which then matches no allowlist entry, so an explicitly
// permitted invite gets deleted for the crime of having a sentence after it.
// This is also what keeps "I use discord. Gg everyone" from being closed up
// into an invite: the pattern still requires the `/code`, and there is no slash.
const INVITE_SPACING_RE = /[\s\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]*([./])[\s\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]*/g;

/** Every invite code in the message, lowercased and deduplicated. */
function extractInviteCodes(content) {
    if (!content) return [];
    const squeezed = String(content)
        .normalize('NFKC')
        .replace(INVISIBLE_RE, '')
        .replace(INVITE_SPACING_RE, '$1');
    const codes = new Set();
    for (const match of squeezed.matchAll(INVITE_RE)) codes.add(match[1].toLowerCase());
    return [...codes];
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

// Bare hostnames are matched only against a known suffix list. A generic
// `something.something` pattern reads "node.js", "readme.md" and "3.5" as
// links, and a filter that deletes a sentence about a file name is worse than
// one that misses a domain. TLDs that double as common file extensions
// (`.md`, `.rs`, `.sh`, `.py`, `.so`) are deliberately absent — those still
// match when written with a scheme.
const BARE_TLDS = new Set([
    'com', 'net', 'org', 'io', 'gg', 'co', 'me', 'tv', 'info', 'biz', 'xyz', 'app',
    'dev', 'site', 'online', 'store', 'shop', 'club', 'top', 'live', 'fun', 'icu',
    'cc', 'ly', 'link', 'click', 'space', 'website', 'host', 'cloud', 'life',
    'world', 'today', 'news', 'blog', 'wiki', 'tech', 'pro', 'vip', 'win', 'bid',
    'stream', 'download', 'ru', 'su', 'ua', 'by', 'kz', 'pl', 'de', 'fr', 'es',
    'it', 'nl', 'be', 'se', 'no', 'fi', 'dk', 'cz', 'gr', 'pt', 'ro', 'hu', 'at',
    'ch', 'uk', 'eu', 'ie', 'us', 'ca', 'mx', 'br', 'ar', 'cl', 'au', 'nz', 'jp',
    'kr', 'cn', 'hk', 'tw', 'sg', 'in', 'id', 'th', 'vn', 'ph', 'my', 'tr', 'il',
    'ae', 'sa', 'za', 'ng', 'ke', 'eg', 'ir', 'pk', 'ai', 'gl', 'to', 'st', 'im',
]);

const SCHEME_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#"'<>|)\]]+)/gi;
const BARE_HOST_RE = /(?:^|[\s(<|"'>])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?=[/:?#]|[\s)>|"'.,!?]|$)/gi;

function cleanHost(host) {
    return String(host).toLowerCase().replace(/^.*@/, '').replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * Every hostname the message links to.
 *
 * The old test was `content.includes('http://') || content.includes('https://')`,
 * which is both too narrow — `www.free-nitro.tld/claim` is the shape a scam
 * actually takes — and unable to say *which* host was linked, so the
 * `linkAllowlist` the dashboard collects had nothing to compare against.
 */
function extractLinkHosts(content) {
    if (!content) return [];
    const text = String(content).normalize('NFKC');
    const hosts = new Set();

    for (const match of text.matchAll(SCHEME_URL_RE)) hosts.add(cleanHost(match[1]));
    for (const match of text.matchAll(BARE_HOST_RE)) {
        const tld = match[2].toLowerCase();
        if (BARE_TLDS.has(tld)) hosts.add(cleanHost(match[1]));
    }

    return [...hosts].filter(Boolean);
}

/** Normalize an allowlist entry an admin may have pasted as a full URL. */
function normalizeHostEntry(entry) {
    return String(entry ?? '')
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/^\*\./, '')
        .replace(/[/?#].*$/, '')
        .replace(/:\d+$/, '')
        .replace(/\.$/, '');
}

/**
 * Is this host covered by the allowlist?
 *
 * Subdomains count: allowing `youtube.com` allows `www.youtube.com` and
 * `m.youtube.com`, which is what an admin typing one domain means. The match is
 * anchored at a label boundary so `youtube.com` never allows `notyoutube.com`.
 */
function isHostAllowed(host, allowlist = []) {
    const target = cleanHost(host);
    return (allowlist || []).some(raw => {
        const entry = normalizeHostEntry(raw);
        if (!entry) return false;
        return target === entry || target.endsWith(`.${entry}`);
    });
}

// ---------------------------------------------------------------------------
// Caps, emoji, mentions
// ---------------------------------------------------------------------------

const CUSTOM_EMOJI_RE = /<a?:\w+:\d+>/g;
const ANY_URL_RE = /\bhttps?:\/\/\S+/gi;

/**
 * Uppercase share of the message, counted over Unicode letters.
 *
 * `[a-z]`/`[A-Z]` scored a message in Cyrillic, Greek or any other cased script
 * as zero percent caps, so shouting in Russian was not shouting. Scripts
 * without case (CJK, Arabic, Hebrew) have no uppercase letters at all, so they
 * score zero the way they should rather than tripping the filter.
 *
 * Custom emoji and URLs are removed first: `<:LOUD_NAME:123>` and a link with a
 * capitalized path are the author's shouting in neither case.
 */
function capsStats(content) {
    const text = String(content ?? '').replace(CUSTOM_EMOJI_RE, ' ').replace(ANY_URL_RE, ' ');
    const letters = (text.match(/\p{L}/gu) || []).length;
    const upper = (text.match(/\p{Lu}/gu) || []).length;
    return { letters, upper, ratio: letters ? (upper / letters) * 100 : 0 };
}

// One emoji, however many code points it takes: a flag is two regional
// indicators, a family is four people joined by zero-width joiners, and a
// skin-toned wave is a base plus a modifier.
//
// The old count was a pair of code-point ranges. It scored `👨‍👩‍👧‍👦👨‍👩‍👧‍👦` —
// two emoji — as eight, and could not see a flag at all, because regional
// indicators sit below the range it started at. Both directions were wrong: one
// deleted messages nobody would call spam, the other let the actual spam past.
const EMOJI_SEQ_RE = new RegExp(
    '\\p{RI}\\p{RI}' +
    '|[0-9#*]\\uFE0F?\\u20E3' +
    '|\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?' +
    '(?:\\u200D(?:\\p{RI}\\p{RI}|\\p{Extended_Pictographic})(?:\\p{Emoji_Modifier}|\\uFE0F)?)*',
    'gu'
);

// Extended_Pictographic includes a handful of characters that are punctuation
// in practice. Counting © and ™ as emoji spam would be its own false positive,
// so they count only when the author asked for the emoji presentation form.
const TEXT_DEFAULT_PICTOGRAPHS = new Set(['\u00A9', '\u00AE', '\u2122', '\u203C', '\u2049']);

/** How many emoji — custom and Unicode — the message contains. */
function countEmojis(content) {
    const text = String(content ?? '');
    const custom = (text.match(CUSTOM_EMOJI_RE) || []).length;

    let unicode = 0;
    for (const [sequence] of text.replace(CUSTOM_EMOJI_RE, '').matchAll(EMOJI_SEQ_RE)) {
        if (TEXT_DEFAULT_PICTOGRAPHS.has(sequence[0]) && !sequence.includes('\uFE0F')) continue;
        unicode += 1;
    }

    return custom + unicode;
}

// Discord collapses `message.mentions.users` by user, so fifty pings of one
// person counted as one mention — a mass-ping of a single victim, which is the
// form harassment usually takes, sat under every threshold.
const MENTION_TOKEN_RE = /<@[!&]?\d+>/g;

/** Mentions in the message, counting repeats of the same target. */
function countMentions(message) {
    const distinct = (message?.mentions?.users?.size ?? 0) + (message?.mentions?.roles?.size ?? 0);
    const raw = (String(message?.content ?? '').match(MENTION_TOKEN_RE) || []).length;
    return Math.max(distinct, raw);
}

module.exports = {
    normalizeToxic,
    compileBadWordRegex,
    buildBadWordRegexes,
    matchesAny,
    extractInviteCodes,
    extractLinkHosts,
    isHostAllowed,
    normalizeHostEntry,
    capsStats,
    countEmojis,
    countMentions,
    // Exported for the tests that pin the lists themselves.
    INVITE_HOSTS,
    BARE_TLDS,
};
