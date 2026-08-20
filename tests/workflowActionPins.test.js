'use strict';

const fs   = require('fs');
const path = require('path');

const workflowsDir = path.join(__dirname, '..', '.github', 'workflows');

// `uses: owner/repo@ref`, capturing the ref and whatever trailing comment
// follows it on the same line.
const USES = /^\s*(?:-\s*)?uses:\s*(\S+?)@(\S+)\s*(?:#\s*(.*))?$/gm;

const workflows = fs.readdirSync(workflowsDir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(file => ({ file, source: fs.readFileSync(path.join(workflowsDir, file), 'utf8') }));

// The publish job carries `packages: write` and pushes the `:latest` tag that
// portainer-stack.yml deploys. It ran on floating tags (@v4, @v6, @v7) while
// the test job — which has nothing worth stealing — was pinned by SHA, so the
// least-hardened workflow held the most privilege. A floating tag is a mutable
// pointer: repoint it upstream and the next run executes new code with the
// registry credential already in the environment.
describe('workflow action pinning', () => {
    test('there is at least one workflow to check', () => {
        expect(workflows.length).toBeGreaterThan(0);
    });

    test.each(workflows)('$file pins every action to a commit SHA', ({ source }) => {
        const floating = [...source.matchAll(USES)]
            .filter(([, action]) => !action.startsWith('./'))
            .filter(([, , ref]) => !/^[0-9a-f]{40}$/.test(ref))
            .map(([, action, ref]) => `${action}@${ref}`);

        expect(floating).toEqual([]);
    });

    test.each(workflows)('$file names the version each SHA stands for', ({ source }) => {
        // A bare SHA is safe but unreadable, and Dependabot writes the version
        // into this comment when it bumps the pin. Without it nobody can tell
        // what is installed without resolving the hash by hand.
        const unlabelled = [...source.matchAll(USES)]
            .filter(([, action]) => !action.startsWith('./'))
            .filter(([, , ref, comment]) => /^[0-9a-f]{40}$/.test(ref) && !/^v?\d+\.\d+/.test(comment ?? ''))
            .map(([, action]) => action);

        expect(unlabelled).toEqual([]);
    });
});
