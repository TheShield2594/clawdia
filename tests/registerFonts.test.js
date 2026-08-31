'use strict';

/**
 * The font table, and the resolution scripts/image-smoke.js asks it for.
 *
 * The candidate lists exist because the same package installs to a different
 * directory on each distro, and getting one wrong is invisible: canvas renders
 * either way, just in its own fallback face. That is exactly what happened to
 * the Alpine entry — `ttf-dejavu` installs into /usr/share/fonts/dejavu/, not
 * the /usr/share/fonts/ttf-dejavu/ the package name implies, and the path that
 * was actually serving the shipped image had been labelled Fedora/RHEL. The bot
 * was fine; the comment was wrong for years, and nothing could have said so
 * without looking inside a built container.
 *
 * So the check that matters runs in the image (scripts/image-smoke.js, via the
 * `image` job in CI). What is worth holding here is the contract that check
 * depends on: resolution reports rather than throws, registers nothing, and
 * distinguishes a required family from an optional one.
 */

const fs = require('fs');
const path = require('path');

const { resolveFonts, FONTS } = require('../src/utils/registerFonts');

describe('font table', () => {
    test('every family lists candidates and names its weight', () => {
        expect(FONTS.length).toBeGreaterThan(0);
        for (const font of FONTS) {
            expect(typeof font.family).toBe('string');
            expect(['normal', 'bold']).toContain(font.weight);
            expect(font.candidates.length).toBeGreaterThan(0);
            for (const candidate of font.candidates) {
                expect([candidate, path.isAbsolute(candidate)]).toEqual([candidate, true]);
            }
        }
    });

    test('the DejaVu faces the image installs are reachable by an Alpine path', () => {
        // The Dockerfile's `apk add ttf-dejavu`. Losing this candidate would
        // downgrade every generated card in the shipped image and nothing in a
        // checkout-only test run would notice.
        const dejavu = FONTS.filter(f => f.family === 'DejaVu Sans');
        expect(dejavu).toHaveLength(2);
        for (const font of dejavu) {
            expect(font.candidates).toContain(
                `/usr/share/fonts/dejavu/DejaVuSans${font.weight === 'bold' ? '-Bold' : ''}.ttf`);
        }
    });

    test('emoji are optional and the text faces are not', () => {
        // registerFonts.js warns either way; the difference is what
        // scripts/image-smoke.js fails the build over.
        const optional = FONTS.filter(f => f.optional).map(f => f.family);
        expect(optional).toEqual(['Noto Color Emoji']);
    });
});

describe('resolveFonts', () => {
    test('reports one entry per family, carrying the fields the smoke test reads', () => {
        const resolved = resolveFonts();
        expect(resolved).toHaveLength(FONTS.length);

        for (const [i, entry] of resolved.entries()) {
            expect(entry.family).toBe(FONTS[i].family);
            expect(entry.weight).toBe(FONTS[i].weight);
            expect(typeof entry.optional).toBe('boolean');
            expect(entry.path === null || typeof entry.path === 'string').toBe(true);
        }
    });

    test('resolves to the first candidate that exists', () => {
        const [first] = FONTS;
        const spy = jest.spyOn(fs, 'existsSync').mockImplementation(p => p === first.candidates[1]);

        expect(resolveFonts()[0].path).toBe(first.candidates[1]);

        spy.mockRestore();
    });

    test('reports a missing family as null rather than throwing', () => {
        // The bot must start on a host with no fonts at all — a generated card
        // in the wrong face is worse than nothing, but not worse than a crash.
        const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);

        expect(resolveFonts().map(f => f.path)).toEqual(FONTS.map(() => null));

        spy.mockRestore();
    });

    test('survives an existsSync that throws', () => {
        // A path under a directory the process cannot stat. Swallowed per
        // candidate, so one unreadable mount cannot take the rest down.
        const spy = jest.spyOn(fs, 'existsSync').mockImplementation(() => { throw new Error('EACCES'); });

        expect(() => resolveFonts()).not.toThrow();
        expect(resolveFonts()[0].path).toBeNull();

        spy.mockRestore();
    });

    test('registers nothing — the smoke test calls it before deciding to', () => {
        // resolveFonts() must stay side-effect free: ensureFontsRegistered()
        // guards itself with a once-flag, and a resolution that tripped it
        // would leave the real registration a no-op.
        const canvas = require('canvas');
        const spy = jest.spyOn(canvas, 'registerFont');

        resolveFonts();

        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('ensureFontsRegistered', () => {
    // The module memoizes its one pass, so each case needs a fresh copy of it
    // with canvas mocked before the top-level destructure of registerFont.
    const load = registerFont => {
        let mod;
        jest.isolateModules(() => {
            jest.doMock('canvas', () => ({ registerFont }));
            mod = require('../src/utils/registerFonts');
        });
        return mod;
    };

    afterEach(() => {
        jest.dontMock('canvas');
        jest.restoreAllMocks();
    });

    test('registers every resolved family and says so', () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        const registerFont = jest.fn();

        const report = load(registerFont).ensureFontsRegistered();

        expect(registerFont).toHaveBeenCalledTimes(FONTS.length);
        expect(report.map(f => f.registered)).toEqual(FONTS.map(() => true));
        expect(report.every(f => f.error === null)).toBe(true);
    });

    test('reports a font that resolved and then failed to register', () => {
        // The gap this report exists for: the file is at the expected path, so
        // resolution is happy, and registerFont rejects it anyway — a truncated
        // copy, or a format this build of canvas cannot read. Without the
        // report that is a warning on stderr and nothing else, and every
        // generated card silently drops to the fallback face.
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const registerFont = jest.fn(() => { throw new Error('Could not parse font file'); });

        const report = load(registerFont).ensureFontsRegistered();

        expect(report.every(f => f.registered)).toBe(false);
        for (const font of report) {
            expect(font.registered).toBe(false);
            expect(font.error).toBe('Could not parse font file');
        }
    });

    test('does not throw when a font cannot be registered', () => {
        // A bot that refuses to start over a font is worse than one whose cards
        // render in the wrong face, so the failure stays non-fatal here. Only
        // the image smoke test turns it into an error, and only for the
        // families the table marks required.
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const mod = load(() => { throw new Error('boom'); });

        expect(() => mod.ensureFontsRegistered()).not.toThrow();
    });

    test('marks a family that resolved nowhere as not registered', () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const registerFont = jest.fn();

        const report = load(registerFont).ensureFontsRegistered();

        expect(registerFont).not.toHaveBeenCalled();
        expect(report.map(f => f.error)).toEqual(FONTS.map(() => 'not found'));
    });

    test('registers once and returns the same report on every later call', () => {
        // registerFont must run before any canvas context is created, and the
        // report has to survive the early return — a second caller that got
        // undefined back would read it as "nothing failed".
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        const registerFont = jest.fn();
        const mod = load(registerFont);

        const first = mod.ensureFontsRegistered();
        const second = mod.ensureFontsRegistered();

        expect(registerFont).toHaveBeenCalledTimes(FONTS.length);
        expect(second).toBe(first);
    });
});
