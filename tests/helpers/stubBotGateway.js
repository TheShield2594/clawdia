'use strict';

/**
 * A test double for the bot gateway facade (src/bot/gateway.js).
 *
 * Dashboard suites build their app with an injected `bot` and stub only the one
 * or two methods the route under test calls. That worked while the facade was a
 * loose object; #876 gave it a protocol, two implementations and a batch method
 * (`hasGuilds`) that three call sites reach for — so a hand-rolled stub missing
 * one method now fails as a 500 several layers away from the omission.
 *
 * This fills in the rest of the protocol with "no": every method answers null,
 * every presence check answers false, and whatever the suite passes wins. A
 * stub that overrides only `hasGuild` also gets a `hasGuilds` derived from it,
 * because those two must agree and a suite should not have to say so twice.
 *
 *     const bot = stubBotGateway({ hasGuild: id => ids.includes(id) });
 */

const { GATEWAY_METHODS } = require('../../src/bot/gatewayProtocol');

module.exports = function stubBotGateway(overrides = {}) {
    const stub = {};
    for (const method of GATEWAY_METHODS) stub[method] = async () => null;

    stub.hasGuild = async () => false;
    stub.hasChannel = async () => false;
    stub.hasGuilds = async ids => Object.fromEntries((ids ?? []).map(id => [id, false]));

    Object.assign(stub, overrides);

    if (overrides.hasGuild && !overrides.hasGuilds) {
        stub.hasGuilds = async ids => {
            const present = {};
            for (const id of ids ?? []) present[id] = (await overrides.hasGuild(id)) === true;
            return present;
        };
    }

    return stub;
};
