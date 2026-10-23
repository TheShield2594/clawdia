'use strict';

// /pet vacation on|off (#1181) — pause hunger for every pet you own, for up to
// VACATION_MAX_DAYS. The rules live in the Vacation section of
// services/petService.js; this is only the command around them.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const {
    VACATION_MAX_DAYS,
    activeVacation,
    startVacation,
    endVacation,
} = require('../../../services/petService');
const { isVersionError } = require('../../../utils/versionRetry');
const COLORS = require('../../../utils/embedColors');
const { resolveUser, syncHungerAndRunaway } = require('./shared');

const ts = (date, style) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

async function executeVacation(interaction) {
    const turnOn = interaction.options.getString('state') === 'on';
    const days   = interaction.options.getInteger('days') ?? VACATION_MAX_DAYS;

    const user = await resolveUser(interaction);
    if (!user.pets?.length) {
        return interaction.reply({ content: "You don't have any pets to send on vacation.", flags: MessageFlags.Ephemeral });
    }

    // Decay is brought up to date first, so the pause starts (or stops) from
    // the hunger the pet actually has now.
    const synced = await syncHungerAndRunaway(user, interaction);
    if (synced?.saveError) {
        if (isVersionError(synced.saveError)) return interaction.reply({ content: 'Edit conflict — please try again.', flags: MessageFlags.Ephemeral });
        throw synced.saveError;
    }
    if (!user.pets.length) {
        return interaction.reply({ content: "You don't have any pets to send on vacation.", flags: MessageFlags.Ephemeral });
    }

    const current = activeVacation(user);
    if (!turnOn && !current) {
        return interaction.reply({ content: "Your pets aren't on vacation.", flags: MessageFlags.Ephemeral });
    }

    if (turnOn && current) {
        return interaction.reply({
            content: `🏖️ Your pets are already on vacation until ${ts(current.until, 'F')}. End it with \`/pet vacation off\` first to start a new one.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    let until = null;
    if (turnOn) until = startVacation(user, days);
    else endVacation(user);

    try {
        await user.save();
    } catch (err) {
        if (isVersionError(err)) return interaction.reply({ content: 'Edit conflict — please try again.', flags: MessageFlags.Ephemeral });
        throw err;
    }

    const count = user.pets.length;
    const pets  = `${count} pet${count === 1 ? '' : 's'}`;
    const embed = turnOn
        ? new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle('🏖️ Pets on vacation')
            .setDescription(
                `Hunger is paused for your **${pets}** until ${ts(until, 'F')} (${ts(until, 'R')}).\n\n`
                + 'While they are away, passives are off and they can\'t battle, train or earn Pet of the Week credit. '
                + 'They come back with the hunger they left with.',
            )
            .setFooter({ text: `Up to ${VACATION_MAX_DAYS} days · end it early with /pet vacation off` })
        : new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle('🐾 Welcome back!')
            .setDescription(`Your **${pets}** are home. Hunger runs again from where it paused, and passives are back on for any pet fed above the line.`);

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

module.exports = { executeVacation };
