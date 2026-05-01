const axios = require('axios');
const { EmbedBuilder } = require('discord.js');

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

async function lookupVerse(reference, translation = 'kjv') {
    try {
        const encoded = encodeURIComponent(reference);
        const url = `https://bible-api.com/${encoded}?translation=${translation}`;
        const { data } = await axios.get(url, { timeout: 8000 });
        if (data.error) return null;
        return data;
    } catch {
        return null;
    }
}

async function getDailyVerse() {
    try {
        const { data } = await axios.get(
            'https://beta.ourmanna.com/api/v1/get/?format=json&order=daily',
            { timeout: 8000 }
        );
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
    const text = (verseData.text || '').trim().replace(/\s+/g, ' ');
    const reference = verseData.reference || '';
    const translation = verseData.translation_name || verseData.translation_id?.toUpperCase() || 'KJV';

    return new EmbedBuilder()
        .setColor(0xF5C518)
        .setTitle(title)
        .setDescription(`*"${text}"*`)
        .setFooter({ text: `${reference}  ·  ${translation}` })
        .setTimestamp();
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

module.exports = { lookupVerse, getDailyVerse, createVerseEmbed, detectVerseReferences };
