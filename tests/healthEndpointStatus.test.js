'use strict';

// #640: three gaps compounded into "nothing acts on an unhealthy container".
// One of them was in this repo rather than in someone's ops setup — `degraded`
// answered HTTP 200, so every uptime monitor that reads status codes (which is
// most of them) saw a bot whose RSS poller, raid detector and temp-ban sweep
// were all failing every tick as perfectly fine.
//
// The other half of the fix is that this must NOT change what the container
// healthchecks do: they parse `status` out of the JSON body and restart only on
// `unhealthy`, because restarting the process does not fix a feed that is 404ing
// and the restart loop would be worse than the degraded state. Both compose
// files are asserted on for that, since the two halves are only correct
// together.

const fs = require('fs');
const path = require('path');

// getStatus reads mongoose.connection.readyState, which is a non-configurable
// getter on a real connection — so the module is stubbed rather than spied on.
const connection = { readyState: 1 };
jest.mock('mongoose', () => ({ connection }));

const { httpStatusFor, getStatus, recordServiceRun } = require('../src/health');

const root = path.join(__dirname, '..');
const composeFiles = ['docker-compose.yml', 'portainer-stack.yml'];

describe('httpStatusFor', () => {
    test('only a healthy bot answers 200', () => {
        expect(httpStatusFor('healthy')).toBe(200);
    });

    test('degraded is a non-200, so a status-code-only monitor still sees it', () => {
        expect(httpStatusFor('degraded')).toBe(503);
    });

    test('unhealthy stays 503', () => {
        expect(httpStatusFor('unhealthy')).toBe(503);
    });

    // Defensive: getStatus only ever produces the three above, but an unknown
    // value must not be read as "fine" if a fourth is ever added.
    test('an unrecognised status is not treated as healthy', () => {
        expect(httpStatusFor('unknown')).toBe(503);
    });
});

describe('the status /health reports', () => {
    afterEach(() => { connection.readyState = 1; });

    test('a failing scheduled service degrades a bot whose database is up', () => {
        connection.readyState = 1;
        recordServiceRun('degradeProbe', { success: false, error: new Error('feed 404') });

        const status = getStatus({ detailed: false }).status;

        expect(status).toBe('degraded');
        expect(httpStatusFor(status)).toBe(503);
    });

    test('a disconnected database is unhealthy regardless of the services', () => {
        connection.readyState = 0;

        expect(getStatus({ detailed: false }).status).toBe('unhealthy');
    });
});

describe.each(composeFiles)('%s', file => {
    const yaml = fs.readFileSync(path.join(root, file), 'utf8');

    // The probe must key off the body, not the response code — reading the code
    // would now restart the container on `degraded` too.
    test('the bot healthcheck fails only on an unhealthy body', () => {
        expect(yaml).toContain("JSON.parse(b).status");
        expect(yaml).toContain("s === 'unhealthy' ? 1 : 0");
    });

    // The label is what autoheal selects on. It is uncommented in both files
    // even where the service is not, so enabling autoheal is one block and never
    // two.
    test('the bot carries the autoheal label', () => {
        expect(yaml).toMatch(/^\s*autoheal: "true"$/m);
    });

    // Present in both files, live in neither by default: docker-compose.yml puts
    // it behind a compose profile, portainer-stack.yml ships it commented out.
    // Both are opt-in because the service holds the Docker API, which can read
    // every container's environment — and this stack's environment is secrets.
    test('the autoheal wiring is present and restricted to labelled containers', () => {
        expect(yaml).toContain('willfarrell/autoheal');
        expect(yaml).toMatch(/AUTOHEAL_CONTAINER_LABEL[=:] ?autoheal/);
        expect(yaml).toMatch(/docker\.sock:\/var\/run\/docker\.sock/);
    });
});

// The compose profile is what makes it opt-in there. Without it `docker compose
// up -d` would start a container holding the Docker API on every deployment
// that pulled this file, which is not a change a docs-and-monitoring fix gets
// to make on an operator's behalf.
test('docker-compose keeps autoheal behind an opt-in profile', () => {
    const yaml = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const service = yaml.slice(yaml.indexOf('\n  autoheal:'), yaml.indexOf('\n  backup:'));

    expect(service).toMatch(/profiles:\n\s+- autoheal/);
});
