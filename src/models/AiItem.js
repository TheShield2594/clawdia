'use strict';

const { Schema, model } = require('mongoose');

const aiItemSchema = new Schema({
    itemId:      { type: String, required: true, unique: true },
    name:        { type: String, required: true },
    emoji:       { type: String, default: '✨' },
    rarity:      { type: String, default: 'Legendary' },
    description: { type: String, default: '' },
    lore:        { type: String, default: '' },
    createdBy:   { type: String, required: true },
    guildId:     { type: String, required: true },
    createdAt:   { type: Date,   default: Date.now },
});

module.exports = model('AiItem', aiItemSchema);
