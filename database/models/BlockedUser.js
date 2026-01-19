const mongoose = require('mongoose');

const blockedUserSchema = new mongoose.Schema({
  _id: { type: Number, required: true },  // Telegram user ID
  username: { type: String },
  firstName: { type: String },
  reason: { type: String, default: 'Manual block' },  // Причина блокування
  blockedAt: { type: Date, default: Date.now },
  blockedBy: { type: Number },  // ID адміна що заблокував
  notes: { type: String }  // Додаткові нотатки адміна
});

module.exports = mongoose.model('BlockedUser', blockedUserSchema);

