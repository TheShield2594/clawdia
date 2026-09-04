'use strict';

/**
 * #940. Both stack files run their backup on an eleven-kilobyte shell script
 * written inline as `entrypoint: > sh -c '…'`, and compose splits that string
 * into arguments before the container ever starts. A single quote inside the
 * script closes the one that opened it — an apostrophe in a comment is enough —
 * and everything after it becomes positional arguments instead of code.
 *
 * That is not hypothetical. "the day's backup", in a comment two thirds of the
 * way down, cut both backup entrypoints off mid-`if`: the container started,
 * `sh` reported a syntax error, and it exited. Nothing said so anywhere, which
 * is the failure mode #872 and #899 are both about — the backup that is only
 * discovered to be missing on the day it is needed.
 *
 * So the shape is asserted here rather than left to a deploy: every embedded
 * entrypoint must split into exactly `sh -c <script>`, and the script must be
 * the whole of what the file holds. shellcheck runs over the same scripts in
 * CI; this half needs no tools and so runs everywhere.
 */

const { STACKS, embeddedShell, splitArguments, splittingProblem } = require('../scripts/lint-stack-shell');

const entries = STACKS.flatMap(embeddedShell);

describe('the shell embedded in the stack files', () => {
    test('is found in both files', () => {
        // A rename that leaves this finding nothing would otherwise pass by
        // checking nothing, which is the same class of silence.
        for (const stack of STACKS) {
            expect([stack, entries.some(entry => entry.file === stack)]).toEqual([stack, true]);
        }
    });

    test('covers the backup entrypoint in particular', () => {
        const backups = entries.filter(entry => entry.service === 'backup');
        expect(backups).toHaveLength(STACKS.length);
        // The one that was truncated. Well over the ~6 KB the broken split
        // produced, so a regression cannot pass this by being merely long.
        for (const backup of backups) expect(backup.script.length).toBeGreaterThan(9000);
    });

    test.each(entries.map(entry => [`${entry.file} → ${entry.service}.${entry.key}`, entry]))(
        '%s reaches the container whole',
        (_name, entry) => {
            expect(splittingProblem(entry)).toBeNull();
            expect(entry.args[0]).toMatch(/^(sh|bash)$/);
            expect(entry.args[1]).toBe('-c');
        }
    );

    test.each(entries.map(entry => [`${entry.file} → ${entry.service}.${entry.key}`, entry]))(
        '%s carries no single quote for compose to split on',
        (_name, entry) => {
            // The rule stated directly, so a failure names the cause rather
            // than the argument count it produces. Compose offers no escape
            // for one inside this form: the fix is always to reword.
            expect(entry.script).not.toContain("'");
        }
    );
});

describe('the splitter the checks are built on', () => {
    // It stands in for compose's own lexing, so it is worth pinning to the
    // cases that decide whether an entrypoint runs.
    test.each([
        ['sh -c \'echo hi\'', ['sh', '-c', 'echo hi']],
        ['sh -c \'a b\' c', ['sh', '-c', 'a b', 'c']],
        ['sh -c "one two"', ['sh', '-c', 'one two']],
        // The shape the bug had: a second quote closes the script, and what
        // follows becomes arguments of its own.
        ['sh -c \'echo one\' \'echo two\'', ['sh', '-c', 'echo one', 'echo two']],
        // Quoted runs butt together into one argument rather than splitting.
        ['sh -c \'a\'b\'c\'', ['sh', '-c', 'abc']],
        ['  spaced   out  ', ['spaced', 'out']],
    ])('%s', (input, expected) => {
        expect(splitArguments(input)).toEqual(expected);
    });

    test('reports an unterminated quote rather than guessing', () => {
        expect(splitArguments("sh -c 'never closed")).toBeNull();
    });

    test('keeps an empty quoted argument, which is not the same as no argument', () => {
        expect(splitArguments('a "" b')).toEqual(['a', '', 'b']);
    });
});
