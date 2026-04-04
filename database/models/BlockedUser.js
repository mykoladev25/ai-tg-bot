const mongoose = require('mongoose');

const blockedUserSchema = new mongoose.Schema({
  _id: { type: Number, required: true },
  username: { type: String },
  firstName: { type: String },
  reason: { type: String, default: 'Manual block' },
  blockedAt: { type: Date, default: Date.now },
  blockedBy: { type: Number },
  notes: { type: String }
});

module.exports = mongoose.model('BlockedUser', blockedUserSchema);
