'use strict';

const { Schema, model } = require('mongoose');

const aiQuestSchema = new Schema({
    questId:     { type: String, required: true, unique: true },
    userId:      { type: String, required: true },
    guildId:     { type: String, required: true },
    name:        { type: String, required: true },
    lore:        { type: String, default: '' },
    description: { type: String, required: true },
    mechanic:    { type: String, required: true, enum: ['hunt', 'fishing', 'mining', 'social', 'economy', 'explore'] },
    target:      { type: Number, required: true },
    emoji:       { type: String, default: '⭐' },
    difficulty:  { type: String, default: 'legendary' },
    xpReward:    { type: Number, default: 500 },
    coinReward:  { type: Number, default: 250 },
    createdAt:   { type: Date,   default: Date.now },
});

aiQuestSchema.index({ userId: 1, guildId: 1, createdAt: -1 });

module.exports = model('AiQuest', aiQuestSchema);
