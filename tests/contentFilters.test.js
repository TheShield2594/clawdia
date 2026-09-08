'use strict';

/**
 * The auto-moderation matchers, stated as the evasions they have to survive and
 * the false positives they must not produce.
 *
 * These were inline in `events/messageCreate` and could only be exercised by
 * driving a fake message through the whole event handler, which is why nobody
 * had ever checked what `f*ck`, `discordapp.com/invite/x` or `www.scam.tld`
 * actually did. Every case below was run against the old implementation first:
 * the ones marked as regressions are the ones it got wrong.
 */

const {
    normalizeToxic,
    compileBadWordRegex,
    buildBadWordRegexes,
    matchesAny,
    extractInviteCodes,
    extractLinkHosts,
    isHostAllowed,
    capsStats,
    countEmojis,
    countMentions,
} = require('../src/utils/contentFilters');

const BASE_BAD_WORDS = require('../src/data/profanityList');

const BASE = buildBadWordRegexes(BASE_BAD_WORDS);
const flagged = (text, regexes = BASE) => matchesAny(normalizeToxic(text), regexes);

describe('profanity matching', () => {
    describe('catches the spellings people actually use', () => {
        it.each([
            ['plain', 'you fuck'],
            // The regression this whole pass started from: a one-letter word
            // before the slur glued itself on during normalization, and
            // `\\babitch\\b` matched nothing. "you are a bitch" -- the most
            // ordinary phrasing there is -- was invisible.
            ['after a one-letter word', 'you are a bitch'],
            ['after "I"', 'I am a fuck'],
            ['padded letters', 'what a shitt'],
            ['doubled vowel', 'you biitch'],
            ['stretched', 'fuuuuuck you'],
            ['spaced out', 'f u c k you'],
            ['dot separated', 'f.u.c.k'],
            ['hyphen separated', 'f-u-c-k'],
            ['leet digits', 'you are a b17ch'],
            ['leet symbols', 'nice a55'],
            ['accented', 'fück you'],
            ['fullwidth', 'ｆｕｃｋ you'],
            ['zero-width split', 'f​uck you'],
            ['cyrillic homoglyph', 'fuсk you'],
            ['plural', 'you are assholes'],
            ['verb ending', 'stop fucking around'],
            ['third person', 'he fucks it up'],
        ])('%s', (_label, text) => {
            expect(flagged(text)).toBe(true);
        });
    });

    describe('leaves innocent text alone', () => {
        it.each([
            ['Scunthorpe', 'I live in Scunthorpe'],
            ['assassin', 'the assassin creed game'],
            ['classic', 'a classic bassline'],
            ['shell', 'run the shell script'],
            ['analysis', 'here is the analysis'],
            ['assess', 'assess the asset first'],
            ['assign', 'assign it to me'],
            ['pussycat', 'the pussycat slept'],
            ['cocktail', 'one cocktail please'],
            ['shitake', 'shitake mushrooms'],
            ['niggardly', 'a niggardly sum'],
            ['hello', 'hello there friend'],
            ['spaced innocents', 'I a m o k a y'],
        ])('%s', (_label, text) => {
            expect(flagged(text)).toBe(false);
        });
    });

    it('lets a guild strike a word out of the built-in list', () => {
        // The list bundles slurs with mild profanity and with words that are
        // also names, and could previously only be added to -- so "Dick
        // Grayson is Robin" was a deleted message and a filed case.
        expect(flagged('Dick Grayson is Robin')).toBe(true);

        const softened = buildBadWordRegexes(BASE_BAD_WORDS, ['dick', 'hell', 'damn']);
        expect(flagged('Dick Grayson is Robin', softened)).toBe(false);
        expect(flagged('what the hell', softened)).toBe(false);
        // The rest of the list is untouched by the allowlist.
        expect(flagged('you fuck', softened)).toBe(true);
    });

    it('escapes regex metacharacters in an admin-entered word', () => {
        const re = compileBadWordRegex('a.c');

        expect(re.test('a.c')).toBe(true);
        expect(re.test('abc')).toBe(false);
    });

    it('compiles a padded entry without exponential backtracking', () => {
        // Per character, an entry with two of anything in a row produced two
        // quantified atoms over the same set (`a+a+`, or two `[\s._\-]+` for
        // two spaces), and adjacent quantifiers that can match the same input
        // backtrack exponentially when the match fails. `#` plus ten spaces
        // took 311ms on a 34-character message and quadrupled every four
        // characters after that -- one guild's word list stalling the event
        // loop for every guild. Runs compile to one atom each now.
        const re = compileBadWordRegex(`#${' '.repeat(10)}a`);
        const attack = normalizeToxic(`#${'.-'.repeat(2000)}b`);

        const started = Date.now();
        expect(re.test(attack)).toBe(false);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('keeps a repeated letter significant when collapsing the run', () => {
        // The run collapse must not turn `a+s+s+` into `a+s+`, which would
        // match the word "as".
        const re = compileBadWordRegex('ass');

        expect(re.test('what an ass')).toBe(true);
        expect(re.test('asss')).toBe(true);
        expect(re.test('as a matter of fact')).toBe(false);
    });

    it('matches a listed phrase across any separator', () => {
        const re = compileBadWordRegex('porch monkey');

        expect(re.test('porch monkey')).toBe(true);
        expect(re.test('porch-monkey')).toBe(true);
    });

    it('returns nothing for an empty entry rather than a pattern matching everything', () => {
        expect(compileBadWordRegex('   ')).toBeNull();
        expect(buildBadWordRegexes(['', '  ', 'real'])).toHaveLength(1);
    });
});

describe('normalizeToxic', () => {
    it('collapses a run of three or more to two, not to one', () => {
        // Collapsing to one was destructive: "asss" became "as", and the
        // doubled letter in "ass" is the word rather than padding.
        expect(normalizeToxic('fuuuuck')).toBe('fuuck');
        expect(normalizeToxic('asss')).toBe('ass');
    });

    it('joins a spaced-out run but not a one-letter word and its neighbour', () => {
        expect(normalizeToxic('f u c k')).toBe('fuck');
        expect(normalizeToxic('you are a bitch')).toBe('you are a bitch');
    });
});

describe('invite detection', () => {
    it.each([
        ['discord.gg', 'join discord.gg/abcd', ['abcd']],
        ['uppercase', 'JOIN DISCORD.GG/AbCd', ['abcd']],
        ['discord.com/invite', 'https://discord.com/invite/abcd', ['abcd']],
        // Only discord.gg and discord.com/invite were known before, so the
        // domain Discord itself still redirects walked straight through.
        ['discordapp.com/invite', 'https://discordapp.com/invite/abcd', ['abcd']],
        ['dsc.gg shortener', 'dsc.gg/abcd', ['abcd']],
        ['invite.gg shortener', 'invite.gg/abcd', ['abcd']],
        ['discord.me', 'discord.me/abcd', ['abcd']],
        ['spaced apart', 'join discord .gg/ abcd', ['abcd']],
        ['broken across lines', 'join discord\n.gg/abcd', ['abcd']],
    ])('finds an invite %s', (_label, content, expected) => {
        expect(extractInviteCodes(content)).toEqual(expected);
    });

    it.each([
        ['a sentence mentioning discord', 'I use discord. Gg everyone'],
        ['no invite at all', 'hello there'],
        ['the domain with no code', 'discord.gg'],
    ])('finds nothing in %s', (_label, content) => {
        expect(extractInviteCodes(content)).toEqual([]);
    });

    it('deduplicates repeats of one code', () => {
        expect(extractInviteCodes('discord.gg/abcd and discord.gg/abcd')).toEqual(['abcd']);
    });
});

describe('link detection', () => {
    it.each([
        // The scheme pattern captures the comma, and an uncleaned `youtube.com,`
        // matched no allowlist entry -- so a permitted link was deleted for
        // having a sentence continue after it.
        ['a host followed by prose punctuation', 'see https://youtube.com, it is good', ['youtube.com']],
        ['a host in parentheses', '(https://youtube.com)', ['youtube.com']],
        ['a host ending a sentence', 'go to https://youtube.com.', ['youtube.com']],
        ['a scheme URL', 'see http://evil.tld/x', ['evil.tld']],
        ['a www host with no scheme', 'see www.evil.com/x', ['www.evil.com']],
        ['a bare domain', 'see evil.com/free-nitro', ['evil.com']],
        ['a spoilered link', '||https://evil.com||', ['evil.com']],
        ['mixed case', 'look at Example.COM', ['example.com']],
    ])('finds %s', (_label, content, expected) => {
        expect(extractLinkHosts(content)).toEqual(expected);
    });

    it.each([
        // A generic host pattern reads all of these as links, and a filter that
        // deletes a sentence about a filename is worse than one that misses a
        // domain -- so bare hosts are matched against a known TLD list that
        // leaves the file-extension lookalikes out.
        ['file names', 'edit node.js and readme.md'],
        ['a version number', 'version 3.5 shipped'],
        ['an abbreviation', 'e.g. this one'],
        ['an email address', 'mail me at bob@example.com'],
        ['plain prose', 'no links in this sentence'],
    ])('finds nothing in %s', (_label, content) => {
        expect(extractLinkHosts(content)).toEqual([]);
    });

    describe('allowlist', () => {
        it('covers subdomains of an allowed domain', () => {
            expect(isHostAllowed('m.youtube.com', ['youtube.com'])).toBe(true);
            expect(isHostAllowed('youtube.com', ['youtube.com'])).toBe(true);
        });

        it('anchors at a label boundary', () => {
            expect(isHostAllowed('notyoutube.com', ['youtube.com'])).toBe(false);
        });

        it('accepts an entry pasted as a full URL', () => {
            expect(isHostAllowed('github.com', ['https://github.com/org/repo'])).toBe(true);
        });

        it('accepts a wildcard entry', () => {
            expect(isHostAllowed('cdn.example.com', ['*.example.com'])).toBe(true);
        });

        it('allows nothing when the list is empty', () => {
            expect(isHostAllowed('example.com', [])).toBe(false);
            expect(isHostAllowed('example.com', undefined)).toBe(false);
        });
    });
});

describe('caps ratio', () => {
    it('scores an all-caps message at 100%', () => {
        expect(capsStats('STOP SHOUTING AT EVERYONE').ratio).toBe(100);
    });

    it('scores shouting in a non-Latin script too', () => {
        // Counted with `[a-z]`/`[A-Z]`, a message in Cyrillic scored zero
        // percent caps -- shouting in Russian was not shouting.
        expect(capsStats('ПРЕКРАТИ ЭТО').ratio).toBe(100);
    });

    it('scores a caseless script at zero rather than tripping', () => {
        expect(capsStats('你好世界').ratio).toBe(0);
    });

    it('ignores custom emoji names and URLs', () => {
        expect(capsStats('<:LOUD_EMOJI_NAME:1> hi').upper).toBe(0);
        expect(capsStats('https://EXAMPLE.COM/PATH ok').upper).toBe(0);
    });
});

describe('emoji counting', () => {
    it('counts one emoji per emoji', () => {
        expect(countEmojis('\u{1F600}'.repeat(8))).toBe(8);
    });

    it('counts a flag, which two code-point ranges could not see at all', () => {
        expect(countEmojis('\u{1F1FA}\u{1F1F8}'.repeat(4))).toBe(4);
    });

    it('counts a joined sequence once', () => {
        // A family is four people and three joiners. The old count scored two
        // of them as eight and deleted the message.
        expect(countEmojis('\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'.repeat(2))).toBe(2);
    });

    it('counts a skin-tone modifier with its base', () => {
        expect(countEmojis('\u{1F44B}\u{1F3FD}')).toBe(1);
    });

    it('counts custom emoji', () => {
        expect(countEmojis('<:cat:123><a:dog:456>')).toBe(2);
    });

    it('does not count text-default punctuation as emoji spam', () => {
        expect(countEmojis('© 2024 ® ™')).toBe(0);
    });
});

describe('mention counting', () => {
    const message = (content, users = 0, roles = 0) => ({
        content,
        mentions: { users: { size: users }, roles: { size: roles } },
    });

    it('counts distinct mentioned users and roles', () => {
        expect(countMentions(message('hi', 3, 2))).toBe(5);
    });

    it('counts repeats of one target', () => {
        // Discord collapses `mentions.users` by user, so a mass-ping of a
        // single victim -- the shape harassment usually takes -- counted as one.
        const spam = '<@111111111111111111> '.repeat(20).trim();
        expect(countMentions(message(spam, 1, 0))).toBe(20);
    });

    it('handles a message with no mentions', () => {
        expect(countMentions(message('nothing here'))).toBe(0);
    });
});
