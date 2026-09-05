const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { request, discardBody } = require('../utils/httpFetch');

// All recognised book names and abbreviations, sorted longest-first so the
// regex alternation matches greedily (e.g. "1 Samuel" before "Samuel").
const BOOK_NAMES = [
    'song of solomon', 'song of songs', '1 thessalonians', '2 thessalonians',
    '1 corinthians', '2 corinthians', '1 chronicles', '2 chronicles',
    'deuteronomy', 'lamentations', 'philippians', 'ecclesiastes',
    'revelation', 'habakkuk', 'zephaniah', 'zechariah', 'galatians',
    'ephesians', 'colossians', 'philemon', 'proverbs', 'hebrews',
    'nehemiah', '1 timothy', '2 timothy', 'obadiah', 'malachi',
    'isaiah', 'ezekiel', 'matthew', '1 samuel', '2 samuel',
    'genesis', 'ezra', 'joshua', 'leviticus', 'numbers',
    '1 peter', '2 peter', '1 kings', '2 kings', '1 john', '2 john', '3 john',
    'jeremiah', 'daniel', 'haggai', 'romans', 'exodus', 'psalms', 'psalm',
    'judges', 'nahum', 'titus', 'james', 'hosea', 'jonah', 'micah',
    'joel', 'amos', 'acts', 'mark', 'luke', 'john', 'ruth', 'jude',
    // common abbreviations
    '1thess', '2thess', '1cor', '2cor', '1chr', '2chr', '1sam', '2sam',
    '1tim', '2tim', '1pet', '2pet', '1kgs', '2kgs', '1jn', '2jn', '3jn',
    'deut', 'phil', 'eccl', 'rev', 'hab', 'zeph', 'zech', 'gal', 'eph',
    'col', 'phm', 'prov', 'heb', 'neh', 'obad', 'mal', 'isa', 'ezek',
    'matt', 'gen', 'josh', 'lev', 'num', 'jer', 'dan', 'hag', 'rom',
    'exo', 'psa', 'judg', 'nah', 'tit', 'jas', 'hos', 'jon', 'mic',
    '1th', '2th', '1co', '2co', '1ch', '2ch', '1sa', '2sa', '1ti', '2ti',
    '1pe', '2pe', '1ki', '2ki', 'lam', 'act', 'luk', 'joh', 'ru',
    'ps', 'ex', 'mk', 'lk', 'jn', 'mt', 'ac', 'ro',
];

const PATTERN = BOOK_NAMES
    .map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

const VERSE_REGEX = new RegExp(
    `\\b(${PATTERN})\\.?\\s+(\\d+):(\\d+)(?:-(\\d+))?\\b`,
    'gi'
);

// Per-book embed colors: warm tones for OT, cool tones for NT.
const BOOK_COLORS = {
    // Torah — warm amber
    genesis:0xD4891A, exodus:0xD4891A, leviticus:0xD4891A, numbers:0xD4891A, deuteronomy:0xD4891A,
    // Historical — warm orange
    joshua:0xE07B39, judges:0xE07B39, ruth:0xE07B39,
    '1 samuel':0xE07B39, '2 samuel':0xE07B39, '1 kings':0xE07B39, '2 kings':0xE07B39,
    '1 chronicles':0xE07B39, '2 chronicles':0xE07B39, ezra:0xE07B39, nehemiah:0xE07B39, esther:0xE07B39,
    // Wisdom — warm yellow
    job:0xF0C040, psalms:0xF0C040, psalm:0xF0C040, proverbs:0xF0C040, ecclesiastes:0xF0C040,
    'song of solomon':0xF0C040, 'song of songs':0xF0C040,
    // Major prophets — deep red
    isaiah:0xC0392B, jeremiah:0xC0392B, lamentations:0xC0392B, ezekiel:0xC0392B, daniel:0xC0392B,
    // Minor prophets — rust
    hosea:0xBF6A2E, joel:0xBF6A2E, amos:0xBF6A2E, obadiah:0xBF6A2E, jonah:0xBF6A2E,
    micah:0xBF6A2E, nahum:0xBF6A2E, habakkuk:0xBF6A2E, zephaniah:0xBF6A2E,
    haggai:0xBF6A2E, zechariah:0xBF6A2E, malachi:0xBF6A2E,
    // Gospels — royal blue
    matthew:0x2E86AB, mark:0x2E86AB, luke:0x2E86AB, john:0x2E86AB,
    // Acts — teal
    acts:0x1A9E8A,
    // Paul's epistles — purple
    romans:0x7B2D8B, '1 corinthians':0x7B2D8B, '2 corinthians':0x7B2D8B,
    galatians:0x7B2D8B, ephesians:0x7B2D8B, philippians:0x7B2D8B, colossians:0x7B2D8B,
    '1 thessalonians':0x7B2D8B, '2 thessalonians':0x7B2D8B,
    '1 timothy':0x7B2D8B, '2 timothy':0x7B2D8B, titus:0x7B2D8B, philemon:0x7B2D8B,
    // General epistles — slate blue
    hebrews:0x4A6FA5, james:0x4A6FA5,
    '1 peter':0x4A6FA5, '2 peter':0x4A6FA5, '1 john':0x4A6FA5, '2 john':0x4A6FA5, '3 john':0x4A6FA5,
    jude:0x4A6FA5,
    // Revelation — deep indigo
    revelation:0x5B2C8D,
};

const BG_VERSIONS = { kjv:'KJV', asv:'ASV', web:'WEB', ylt:'YLT', darby:'DARBY', bbe:'BBE', webbe:'WEBBE', niv:'NIV' };
const BOOK_THUMBNAIL = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4d6.png';

function getBookColor(reference) {
    const book = (reference || '').replace(/\s+\d+:\d+.*$/, '').trim().toLowerCase();
    return BOOK_COLORS[book] ?? 0xF5C518;
}

function getBibleGatewayUrl(reference, translationId) {
    const version = BG_VERSIONS[(translationId || '').toLowerCase()] || 'KJV';
    return `https://www.biblegateway.com/passage/?search=${encodeURIComponent(reference)}&version=${version}`;
}

// Resolves a verseData object to a BG_VERSIONS key, preferring translation_id
// then falling back to translation_name (e.g. ourmanna returns only 'KJV' there).
function resolveTranslationKey(verseData) {
    const id = (verseData.translation_id || '').toLowerCase();
    if (BG_VERSIONS[id]) return id;
    const nameAsId = (verseData.translation_name || '').toLowerCase();
    return BG_VERSIONS[nameAsId] ? nameAsId : 'kjv';
}

async function lookupVerse(reference, translation = 'kjv') {
    try {
        const encoded = encodeURIComponent(reference);
        const url = `https://bible-api.com/${encoded}?translation=${translation}`;
        // Both lookups here answer a null on any failure, so a non-2xx is
        // thrown into the same catch that a transport failure lands in —
        // `fetch`, unlike axios, would otherwise hand back the error page.
        const response = await request(url, { timeout: 8000 });
        if (!response.ok) {
            await discardBody(response);
            return null;
        }
        const data = await response.json();
        if (data.error) return null;
        return data;
    } catch {
        return null;
    }
}

async function getDailyVerse() {
    try {
        const response = await request(
            'https://beta.ourmanna.com/api/v1/get/?format=json&order=daily',
            { timeout: 8000 }
        );
        if (!response.ok) {
            await discardBody(response);
            return null;
        }
        const data = await response.json();
        const details = data?.verse?.details;
        if (details?.text && details?.reference) {
            return {
                reference: details.reference,
                text: details.text.trim(),
                translation_name: details.version || 'KJV'
            };
        }
    } catch {}
    return null;
}

function createVerseEmbed(verseData, title = '📖 Bible Verse') {
    const reference = verseData.reference || '';
    const translationId = verseData.translation_id || '';
    const translation = verseData.translation_name || translationId.toUpperCase() || 'KJV';
    const bgUrl = getBibleGatewayUrl(reference, resolveTranslationKey(verseData));
    const isMultiVerse = Array.isArray(verseData.verses) && verseData.verses.length > 1;
    const linkSuffix = `\n\n[Continue reading →](${bgUrl})`;

    let body;
    if (isMultiVerse) {
        body = verseData.verses
            .map(v => `**[${v.verse}]** *${v.text.trim().replace(/\s+/g, ' ')}*`)
            .join('\n');
    } else {
        const text = (verseData.text || '')
            .trim()
            .split('\n')
            .map(line => line.trim().replace(/\s+/g, ' '))
            .filter(Boolean)
            .join('\n');
        body = `*"${text}"*`;
    }

    // Cap description at Discord's 4096-char limit, reserving space for the link suffix.
    const hardLimit = 4096 - linkSuffix.length;
    let truncated = false;
    if (body.length > hardLimit) {
        if (isMultiVerse) {
            body = body.slice(0, hardLimit - 1) + '…';
        } else {
            // Close the quote cleanly before truncation marker: *"text…"*
            body = body.slice(0, hardLimit - 4) + '…"*';
        }
        truncated = true;
    }

    if (isMultiVerse || truncated) {
        body += linkSuffix;
    }

    return new EmbedBuilder()
        .setColor(getBookColor(reference))
        .setTitle(title)
        .setURL(bgUrl)
        .setThumbnail(BOOK_THUMBNAIL)
        .setDescription(body)
        .setFooter({ text: `${reference}  ·  ${translation}` })
        .setTimestamp();
}

function createVerseComponents(verseData) {
    const bgUrl = getBibleGatewayUrl(verseData.reference || '', resolveTranslationKey(verseData));
    const button = new ButtonBuilder()
        .setLabel('Read on BibleGateway')
        .setURL(bgUrl)
        .setStyle(ButtonStyle.Link)
        .setEmoji('📖');
    return [new ActionRowBuilder().addComponents(button)];
}

function detectVerseReferences(content) {
    const refs = [];
    const seen = new Set();

    VERSE_REGEX.lastIndex = 0;
    let match;
    while ((match = VERSE_REGEX.exec(content)) !== null) {
        const book = match[1];
        const chapter = match[2];
        const verseStart = match[3];
        const verseEnd = match[4];
        const ref = verseEnd
            ? `${book} ${chapter}:${verseStart}-${verseEnd}`
            : `${book} ${chapter}:${verseStart}`;
        const key = ref.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            refs.push(ref);
        }
    }
    return refs;
}

module.exports = { lookupVerse, getDailyVerse, createVerseEmbed, createVerseComponents, detectVerseReferences };
