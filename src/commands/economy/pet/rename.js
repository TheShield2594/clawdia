'use strict';

const { MessageFlags } = require('discord.js');
const { PET_DEFINITIONS, resolvePetRef, sanitizePetName } = require('../../../services/petService');
const { isVersionError, withVersionRetry } = require('../../../utils/versionRetry');
const { NO_SUCH_PET, resolveUser, readSlotOption } = require('./shared');

async function executeRename(interaction) {
    const newName = sanitizePetName(interaction.options.getString('name'));
    const slotRef = readSlotOption(interaction);
    if (!newName) {
        return interaction.reply({ content: 'That name has nothing left once mentions and formatting characters are taken out — try letters, numbers or emoji.', flags: MessageFlags.Ephemeral });
    }

    // Setting a name is a pure function of the freshly read roster, so a lost
    // version race replays rather than asking the user to retype the command.
    // The first attempt resolves the slot the user asked for; every retry then
    // looks the pet up by its stable _id, since a numeric slot ref would land on
    // a different pet if a concurrent write reordered the roster in between.
    let saved    = null;
    let conflict = false;
    let def      = null;
    let pinnedId = null;
    try {
        saved = await withVersionRetry(
            () => resolveUser(interaction),
            (user) => {
                const target = resolvePetRef(user?.pets, pinnedId ?? slotRef);
                if (!target) return false;
                if (target.pet?._id) pinnedId = String(target.pet._id);
                user.pets[target.index].name = newName;
                user.markModified('pets');
                def = PET_DEFINITIONS[user.pets[target.index].petId];
            },
            { label: 'pet rename' }
        );
    } catch (err) {
        if (!isVersionError(err)) throw err;
        conflict = true;
    }

    if (conflict) return interaction.reply({ content: 'Edit conflict — try again.', flags: MessageFlags.Ephemeral });
    if (!saved)   return interaction.reply({ content: NO_SUCH_PET, flags: MessageFlags.Ephemeral });

    return interaction.reply({ content: `${def?.emoji ?? '🐾'} Pet renamed to **${newName}**!`, flags: MessageFlags.Ephemeral });
}

module.exports = { executeRename };
