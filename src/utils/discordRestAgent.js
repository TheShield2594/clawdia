// An undici Agent for discord.js's REST client, built from the undici that
// @discordjs/rest itself loads (pinned to 6.x through `overrides`).
//
// Without one, @discordjs/rest sends through undici's *global* dispatcher, and
// that is shared between every undici copy in the process under
// `Symbol.for('undici.globalDispatcher.1')`: whichever copy loads first
// installs its Agent there. When the top-level undici 8 (ours, and openai's)
// loads before discord.js, every REST call is dispatched by undici 8's Agent.
// JSON bodies survive that, but an upload does not: @discordjs/rest builds its
// multipart body with the platform `FormData`, and undici 8 refuses any
// FormData it did not create — "body must be a FormData created by this undici
// package instance". So every reply carrying `files` (the /pet card first
// among them) failed, depending only on module load order.
//
// Handing REST its own Agent from the matching undici takes the global
// dispatcher out of the path entirely.
function discordRestAgent() {
    const restEntry = require.resolve('@discordjs/rest');
    const undici = require(require.resolve('undici', { paths: [restEntry] }));
    return new undici.Agent();
}

module.exports = { discordRestAgent };
