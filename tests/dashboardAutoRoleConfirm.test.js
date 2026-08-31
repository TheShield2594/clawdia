/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #677. Every other destructive action on the dashboard goes through
// showConfirm; removing an auto-role fired its DELETE straight off the click.
// The target is a one-character × sitting against a role name in a row of
// them, so the miss is easy — and the undo is not: re-adding the role restores
// the setting for people who join later, but nobody who joined in between ever
// gets it.
const { bootPage, renderPanel, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');
const { populatedGuildSettingsLocals } = require('./helpers/guildSettingsLocals');

// The populated locals are the ones that seed an auto-role, on the role they
// call ROLE. The default locals have none, and a panel with no chip in it
// would pass every assertion below by having nothing to remove.
const ROLE_ID = '40';
const ROLE_NAME = 'Member';
const POPULATED = populatedGuildSettingsLocals();

async function openWelcome() {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '';
    bootPage({
        panelFetch: name => ({
            ok: true,
            status: 200,
            text: async () => renderPanel(name, { settings: POPULATED.settings }),
        }),
    });
    clickTab('welcome');
    await settle();
    expect(removeButton()).not.toBeNull();
}

const removeButton = () =>
    document.querySelector(`#autorole-list [data-role-id="${ROLE_ID}"] button[data-action="autorole-remove"]`);

const deleteCalls = () =>
    window.fetch.mock.calls.filter(([, opts]) => opts && opts.method === 'DELETE');

/** Press the confirm dialog's Confirm or Cancel, once it is up. */
async function answerConfirm(ok) {
    const modal = document.getElementById('confirm-modal');
    expect(modal.style.display).toBe('flex');
    const body = document.getElementById('confirm-modal-body').textContent;
    window._confirmResolve(ok);
    await settle();
    return body;
}

afterEach(async () => {
    await settle();
    forgetDocumentListeners();
    jest.restoreAllMocks();
});

describe('removing an auto-role', () => {
    beforeEach(openWelcome);

    it('asks before it deletes anything', async () => {
        removeButton().click();
        await settle();

        expect(document.getElementById('confirm-modal').style.display).toBe('flex');
        expect(deleteCalls()).toHaveLength(0);
    });

    it('names the role, because the chips sit in a row', async () => {
        removeButton().click();
        await settle();

        expect(document.getElementById('confirm-modal-title').textContent).toMatch(/auto-role/i);
        const body = await answerConfirm(false);
        expect(body).toContain(ROLE_NAME);
    });

    it('deletes once confirmed, and takes the chip with it', async () => {
        removeButton().click();
        await settle();
        await answerConfirm(true);

        expect(deleteCalls()).toHaveLength(1);
        expect(deleteCalls()[0][0]).toContain(`/autorole/${ROLE_ID}`);
        expect(document.querySelector(`#autorole-list [data-role-id="${ROLE_ID}"]`)).toBeNull();
    });

    it('leaves the role alone when cancelled', async () => {
        removeButton().click();
        await settle();
        await answerConfirm(false);

        expect(deleteCalls()).toHaveLength(0);
        expect(document.querySelector(`#autorole-list [data-role-id="${ROLE_ID}"]`)).not.toBeNull();
    });

    // The dialog says people who already have the role keep it, because that
    // is the part an admin is most likely to be wrong about.
    it('says what removing it does and does not undo', async () => {
        removeButton().click();
        await settle();
        const body = await answerConfirm(false);
        expect(body).toMatch(/already have it keep it/i);
    });
});
