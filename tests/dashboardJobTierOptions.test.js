/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #911. The job modal's "Career tier" select shipped its four options as static
// markup — "Tier 2 — Skilled Worker (10 shifts)" and so on — while the Careers
// tab in the same panel lets an admin rename every tier and change its shift
// threshold. Opening the modal only set `.value` on the select, so an admin who
// renamed their tiers still read the stock names, and the shift counts shown
// were wrong for their server: the dashboard contradicting configuration the
// same dashboard had just saved.
//
// The options are rebuilt from the live tier list when the modal opens now.

const fs = require('fs');
const path = require('path');
const { VIEWS, bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');
const DEFAULT_TIERS = require('../src/data/defaultTiers');

const options = () => [...document.getElementById('modal-job-tier').options]
    .map(o => ({ value: o.value, text: o.textContent }));

/** Rename a tier and change its threshold the way the Careers tab does. */
function editTier(index, { name, minShifts }) {
    const set = (field, value) => {
        const input = document.querySelector(`[data-tier-idx="${index}"][data-field="${field}"]`);
        input.value = String(value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    if (name !== undefined) set('name', name);
    if (minShifts !== undefined) set('minShifts', minShifts);
}

describe('the job modal\'s career-tier select', () => {
    beforeEach(async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        bootPage();
        clickTab('economy');
        await settle();
    });

    afterEach(() => {
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    test('ships no options in the markup — they are not the page\'s to hardcode', () => {
        const panel = fs.readFileSync(path.join(VIEWS, 'partials', 'panels', 'economy.ejs'), 'utf8');
        const select = /<select id="modal-job-tier"[^>]*>([\s\S]*?)<\/select>/.exec(panel);

        expect(select).not.toBeNull();
        expect(select[1].trim()).toBe('');
        // The stock names in particular — the thing an admin can rename.
        expect(panel).not.toContain('Skilled Worker');
    });

    test('is built from the configured tiers when the modal opens', () => {
        window.openJobModal(-1);

        expect(options()).toEqual(DEFAULT_TIERS.map(t => ({
            value: String(t.tier),
            text: `Tier ${t.tier} — ${t.name} (${t.minShifts} shift${t.minShifts === 1 ? '' : 's'})`,
        })));
    });

    test('shows a renamed tier and its new threshold, not the stock ones', () => {
        editTier(1, { name: 'Deckhand', minShifts: 7 });

        window.openJobModal(-1);

        const second = options()[1];
        expect(second.text).toBe('Tier 2 — Deckhand (7 shifts)');
        expect(options().some(o => o.text.includes('Skilled Worker'))).toBe(false);
    });

    test('picks up a rename made after the modal was last opened', () => {
        window.openJobModal(-1);
        window.closeJobModal();

        editTier(0, { name: 'Rookie' });
        window.openJobModal(-1);

        expect(options()[0].text).toBe('Tier 1 — Rookie (0 shifts)');
    });

    test('says "1 shift", not "1 shifts"', () => {
        editTier(1, { minShifts: 1 });

        window.openJobModal(-1);

        expect(options()[1].text).toBe('Tier 2 — Skilled Worker (1 shift)');
    });

    test('escapes a tier name rather than letting it write markup', () => {
        editTier(2, { name: '<img src=x onerror=alert(1)>' });

        window.openJobModal(-1);

        const select = document.getElementById('modal-job-tier');
        expect(select.querySelector('img')).toBeNull();
        expect(options()[2].text).toContain('<img src=x onerror=alert(1)>');
    });

    test('selects the tier the job being edited is on', () => {
        // A job on tier 3, added through the modal itself so the page's own
        // list is what is read back.
        window.openJobModal(-1);
        document.getElementById('modal-job-name').value = 'Astronaut';
        document.getElementById('modal-job-tier').value = '3';
        document.getElementById('modal-job-min-pay').value = '50';
        document.getElementById('modal-job-max-pay').value = '150';
        window.saveJobModal();

        // The list is grouped by tier, so DOM order is not list order — take the
        // index the edit button itself would pass.
        const idx = window.jobsList.findIndex(job => job.name === 'Astronaut');
        expect(idx).toBeGreaterThan(-1);
        window.openJobModal(idx);

        expect(document.getElementById('modal-job-tier').value).toBe('3');
    });
});
