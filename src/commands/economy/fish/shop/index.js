'use strict';

// The /fish shop group — the dispatch, and the one setup every verb shares.
//
// This was one 822-line file and the largest command file in the repo (#917).
// The folder split of #721 stopped at the verb group; the groups themselves
// kept growing, and a shop that sells rods, upgrades, bait, consumables,
// repairs and locations is six unrelated flows sharing nothing but the guild
// lookup at the top. Each is its own file now, and this one routes to it.
//
// It is a folder inside a folder, which the loader is fine with: only
// commands/<category>/<name>/index.js registers as a command, so nothing under
// fish/ is ever a command of its own.

const Guild = require('../../../../models/Guild');
const { MessageFlags } = require('discord.js');
const User = require('../../../../models/User');
const { attachGrind } = require('../../../../utils/grindProfile');
const { ensureFishingData } = require('../../../../services/fishService');

const { showShopList } = require('./list');
const { handleBuyRod } = require('./rod');
const { handleBuyUpgrade } = require('./upgrade');
const { handleBuy } = require('./buy');
const { handleUse } = require('./use');
const { handleRepair } = require('./repair');
const { handleUnlock } = require('./unlock');

async function handleShop(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureFishingData(user);

    switch (sub) {
        case 'list':    return showShopList(interaction, user, currency);
        case 'rod':     return handleBuyRod(interaction, user, currency);
        case 'upgrade': return handleBuyUpgrade(interaction, user, currency);
        case 'buy':     return handleBuy(interaction, user, currency);
        case 'use':     return handleUse(interaction, user);
        case 'repair':  return handleRepair(interaction, user, currency);
        case 'unlock':  return handleUnlock(interaction, user, currency);
    }
}

// The surface a `./shop` require had before the split, unchanged.
module.exports = {
    handleBuy,
    handleBuyRod,
    handleBuyUpgrade,
    handleRepair,
    handleShop,
    handleUnlock,
    handleUse,
    showShopList,
};
