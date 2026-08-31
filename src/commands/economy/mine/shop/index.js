'use strict';

// The /mine shop group — the dispatch, and the one setup every verb shares.
//
// This was one 635-line file, and all but forty of those lines sat inside a
// single `handleShop` function as seven `if (sub === …)` blocks (#917): a shop
// that sells pickaxes, upgrades, charges, consumables, repairs and depths is
// six unrelated flows sharing nothing but the guild lookup at the top. Each is
// a function in its own file now, taking the user and the currency the dispatch
// already resolved.
//
// It is a folder inside a folder, which the loader is fine with: only
// commands/<category>/<name>/index.js registers as a command, so nothing under
// mine/ is ever a command of its own.

const { getGuildSettings } = require('../../../../utils/guildSettingsCache');
const { MessageFlags } = require('discord.js');
const User = require('../../../../models/User');
const { attachGrind } = require('../../../../utils/grindProfile');
const { ensureMineData } = require('../../../../services/mineService');

const { showShopList } = require('./list');
const { handleBuyPickaxe } = require('./pickaxe');
const { handleBuyUpgrade } = require('./upgrade');
const { handleBuy } = require('./buy');
const { handleUse } = require('./use');
const { handleRepair } = require('./repair');
const { handleUnlock } = require('./unlock');

async function handleShop(interaction, sub) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
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
    ensureMineData(user);

    switch (sub) {
        case 'list':    return showShopList(interaction, user, currency);
        case 'pickaxe': return handleBuyPickaxe(interaction, user, currency);
        case 'upgrade': return handleBuyUpgrade(interaction, user, currency);
        case 'buy':     return handleBuy(interaction, user, currency);
        case 'use':     return handleUse(interaction, user);
        case 'repair':  return handleRepair(interaction, user, currency);
        case 'unlock':  return handleUnlock(interaction, user, currency);
    }
}

module.exports = {
    handleShop,
    showShopList,
    handleBuyPickaxe,
    handleBuyUpgrade,
    handleBuy,
    handleUse,
    handleRepair,
    handleUnlock,
};
