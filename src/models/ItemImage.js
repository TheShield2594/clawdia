const mongoose = require('mongoose');

const itemImageSchema = new mongoose.Schema({
    itemId:    { type: String, required: true, unique: true },
    imageData: { type: Buffer, required: true },
    imageType: { type: String, default: 'image/png' },
    updatedAt: { type: Date,   default: Date.now }
});

module.exports = mongoose.model('ItemImage', itemImageSchema);
