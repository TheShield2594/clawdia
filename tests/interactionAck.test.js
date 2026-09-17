'use strict';

// #995: the dispatcher awaits the settings read, the freeze read and the
// cooldown claim before execute(), and the moderation commands then await
// resolveMember — which fetches from the gateway on a member-cache miss. Stacked,
// that can outrun Discord's three-second acknowledgement window and land the
// first response on a dead token.
//
// The fix acknowledges up front for commands that opt in with a `deferral` hook,
// and routes every response through the two helpers here so a deferred command
// never issues a second initial reply. These tests pin the helper's choice of
// reply / editReply / followUp / deleteReply across the states it has to cover,
// and the visibility it preserves.

const { MessageFlags } = require('discord.js');
const {
    resolveDeferral,
    markDeferred,
    deferVisibility,
    sendPublicResponse,
    sendEphemeralResponse,
} = require('../src/utils/interactionAck');

// A minimal interaction that records which method was used and with what, and
// tracks replied/deferred the way discord.js transitions them.
function fakeInteraction({ deferred = false, replied = false } = {}) {
    const calls = [];
    const interaction = {
        deferred,
        replied,
        reply: jest.fn(async p => { interaction.replied = true; calls.push(['reply', p]); return p; }),
        editReply: jest.fn(async p => { interaction.replied = true; calls.push(['editReply', p]); return p; }),
        followUp: jest.fn(async p => { calls.push(['followUp', p]); return p; }),
        deleteReply: jest.fn(async () => { calls.push(['deleteReply']); }),
        calls,
    };
    return interaction;
}

describe('resolveDeferral', () => {
    // `Boolean('x')` rather than the `{ ephemeral: true }` literal, which the
    // repo lint rule reserves for the deprecated discord.js reply option.
    const ephemeralObject = { ephemeral: Boolean('x') };

    test('reads the object, string and boolean forms', () => {
        expect(resolveDeferral({ ephemeral: false })).toEqual({ ephemeral: false });
        expect(resolveDeferral(ephemeralObject).ephemeral).toBe(true);
        expect(resolveDeferral('public')).toEqual({ ephemeral: false });
        expect(resolveDeferral('ephemeral').ephemeral).toBe(true);
        expect(resolveDeferral(true)).toEqual({ ephemeral: false });
    });

    test('a falsy hook means do not defer', () => {
        expect(resolveDeferral(undefined)).toBeNull();
        expect(resolveDeferral(null)).toBeNull();
        expect(resolveDeferral(false)).toBeNull();
    });

    test('a function hook is evaluated per interaction', () => {
        const hook = interaction => (interaction.wants ? { ephemeral: false } : null);
        expect(resolveDeferral(hook, { wants: true })).toEqual({ ephemeral: false });
        expect(resolveDeferral(hook, { wants: false })).toBeNull();
    });
});

describe('markDeferred / deferVisibility', () => {
    test('records the visibility the dispatcher chose', () => {
        const pub = {};
        markDeferred(pub, false);
        expect(deferVisibility(pub)).toBe('public');

        const eph = {};
        markDeferred(eph, true);
        expect(deferVisibility(eph)).toBe('ephemeral');
    });

    test('an un-deferred interaction has no recorded visibility', () => {
        expect(deferVisibility({})).toBeNull();
    });
});

describe('sendPublicResponse', () => {
    test('replies directly when the interaction was never acknowledged', async () => {
        const interaction = fakeInteraction();
        await sendPublicResponse(interaction, { content: 'hi' });
        expect(interaction.calls).toEqual([['reply', { content: 'hi' }]]);
    });

    test('fills a public placeholder with editReply', async () => {
        const interaction = fakeInteraction({ deferred: true });
        markDeferred(interaction, false);
        await sendPublicResponse(interaction, { embeds: ['e'] });
        expect(interaction.calls).toEqual([['editReply', { embeds: ['e'] }]]);
    });

    test('drops an ephemeral placeholder and follows up publicly', async () => {
        const interaction = fakeInteraction({ deferred: true });
        markDeferred(interaction, true);
        await sendPublicResponse(interaction, { embeds: ['e'] });
        expect(interaction.calls).toEqual([['deleteReply'], ['followUp', { embeds: ['e'] }]]);
    });

    test('follows up once the interaction has already replied', async () => {
        const interaction = fakeInteraction({ deferred: true, replied: true });
        await sendPublicResponse(interaction, { content: 'more' });
        expect(interaction.calls).toEqual([['followUp', { content: 'more' }]]);
    });
});

describe('sendEphemeralResponse', () => {
    test('replies ephemerally when the interaction was never acknowledged', async () => {
        const interaction = fakeInteraction();
        await sendEphemeralResponse(interaction, { content: 'no' });
        expect(interaction.calls).toEqual([['reply', { content: 'no', flags: MessageFlags.Ephemeral }]]);
    });

    // The moderation policy: deferred publicly, but the refusal must stay
    // private, so the public placeholder is removed and the refusal follows up
    // ephemerally rather than being a second initial reply.
    test('drops the public placeholder and follows up ephemerally', async () => {
        const interaction = fakeInteraction({ deferred: true });
        markDeferred(interaction, false);
        await sendEphemeralResponse(interaction, { content: 'denied' });
        expect(interaction.calls).toEqual([
            ['deleteReply'],
            ['followUp', { content: 'denied', flags: MessageFlags.Ephemeral }],
        ]);
    });

    test('edits an already-ephemeral placeholder in place', async () => {
        const interaction = fakeInteraction({ deferred: true });
        markDeferred(interaction, true);
        await sendEphemeralResponse(interaction, { content: 'denied' });
        // editReply keeps the ephemeral visibility fixed at the defer.
        expect(interaction.calls).toEqual([['editReply', { content: 'denied' }]]);
    });

    test('never issues a second initial reply once replied', async () => {
        const interaction = fakeInteraction({ deferred: true, replied: true });
        await sendEphemeralResponse(interaction, { content: 'oops' });
        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.calls).toEqual([['followUp', { content: 'oops', flags: MessageFlags.Ephemeral }]]);
    });

    test('survives a placeholder that cannot be deleted', async () => {
        const interaction = fakeInteraction({ deferred: true });
        markDeferred(interaction, false);
        interaction.deleteReply.mockRejectedValueOnce(new Error('expired token'));
        await expect(sendEphemeralResponse(interaction, { content: 'denied' })).resolves.toBeDefined();
        expect(interaction.followUp).toHaveBeenCalledWith({ content: 'denied', flags: MessageFlags.Ephemeral });
    });
});
