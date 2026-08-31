'use strict';

// The /hunt shop group — the dispatch, and the one setup every verb shares.
//
// This was one 828-line file, the largest in the /hunt folder and the second
// largest command file in the repo (#917). The folder split of #721 stopped at
// the verb group; the groups themselves kept growing, and a shop that sells
// weapons, upgrades, ammo, consumables, repairs and zones is six unrelated
// flows sharing nothing but the guild lookup at the top. Each is its own file
// now, and this one routes to it.
//
// It is a folder inside a folder, which the loader is fine with: only
// commands/<category>/<name>/index.js registers as a command, so nothing under
// hunt/ is ever a command of its own.

const { getGuildSettings } = require('../../../../utils/guildSettingsCache');
const { MessageFlags } = require('discord.js');
const User = require('../../../../models/User');
const { attachGrind } = require('../../../../utils/grindProfile');
const { ensureHuntData } = require('../../../../services/huntService');

const { showShopList } = require('./list');
const { handleBuyWeapon, completePurchase } = require('./weapon');
const { handleBuyUpgrade } = require('./upgrade');
const { handleBuy } = require('./buy');
const { handleUse } = require('./use');
const { handleRepair } = require('./repair');
const { handleUnlock } = require('./unlock');
const {
    CROSS_ECONOMY_DAYS,
    fullRepairCost,
    huntingDaysFor,
    huntingDaysLabel,
    isCrossEconomyWeapon,
} = require('./pricing');

async function executeShop(interaction, sub) {
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
    ensureHuntData(user);

    switch (sub) {
        case 'list':    return showShopList(interaction, user, currency);
        case 'weapon':  return handleBuyWeapon(interaction, user, currency);
        case 'upgrade': return handleBuyUpgrade(interaction, user, currency);
        case 'buy':     return handleBuy(interaction, user, currency);
        case 'use':     return handleUse(interaction, user);
        case 'repair':  return handleRepair(interaction, user, currency);
        case 'unlock':  return handleUnlock(interaction, user, currency);
    }
}

// The surface a `./shop` require had before the split, unchanged: hunt's own
// index.js builds the command definition from the pricing helpers, and the
// tests reach for the handlers directly.
module.exports = {
    CROSS_ECONOMY_DAYS,
    completePurchase,
    executeShop,
    fullRepairCost,
    handleBuy,
    handleBuyUpgrade,
    handleBuyWeapon,
    handleRepair,
    handleUnlock,
    handleUse,
    huntingDaysFor,
    huntingDaysLabel,
    isCrossEconomyWeapon,
    showShopList,
};
