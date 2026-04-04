const mongoose = require('mongoose');
const { TRIAL_TOKENS } = require('../../config/constants');

const userSchema = new mongoose.Schema({
  _id: { type: Number, required: true },
  username: { type: String, index: true },
  firstName: String,
  lastName: String,
  languageCode: { type: String, default: 'en' },

  tokens: { type: Number, default: TRIAL_TOKENS, required: true },
  totalTokensPurchased: { type: Number, default: 0 },
  totalTokensSpent: { type: Number, default: 0 },
  totalTokensEarned: { type: Number, default: TRIAL_TOKENS },

  trialUsage: {
    nano_banana_4k: { type: Number, default: 0 },
    kling: { type: Number, default: 0 },
    kling_v2_6: { type: Number, default: 0 },
    runway_turbo: { type: Number, default: 0 },
    veo: { type: Number, default: 0 },
    kling_motion: { type: Number, default: 0 }
  },

  freeUsage: {
    nano_banana_free: { type: Number, default: 0 }
  },

  subscription: {
    type: { type: String, enum: ['TRIAL', 'STARTER', 'BASIC', 'PRO', 'PREMIUM', null] },
    startedAt: Date,
    expiresAt: Date,
    isActive: Boolean
  },

  stats: {
    totalGenerations: { type: Number, default: 0 },
    textRequests: { type: Number, default: 0 },
    imageRequests: { type: Number, default: 0 },
    videoRequests: { type: Number, default: 0 },
    audioRequests: { type: Number, default: 0 },
    visionRequests: { type: Number, default: 0 }
  },

  currentModel: String,

  conversationHistory: [{
    role: { type: String, enum: ['user', 'assistant'] },
    content: String,
    timestamp: { type: Date, default: Date.now }
  }],

  isBanned: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  banReason: String,
  bannedAt: Date,

  referralCode: { type: String },
  referredBy: { type: Number, ref: 'User' },
  referralEarnings: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  lastActivityAt: { type: Date, default: Date.now }
}, {
  _id: false,
  timestamps: false
});

userSchema.index({ lastActivityAt: -1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ referralCode: 1 }, { unique: true, sparse: true });

userSchema.methods.updateActivity = function updateActivity() {
  this.lastActivityAt = new Date();
  return this.save();
};

userSchema.methods.addToConversation = function addToConversation(role, content) {
  this.conversationHistory.push({ role, content, timestamp: new Date() });

  if (this.conversationHistory.length > 20) {
    this.conversationHistory = this.conversationHistory.slice(-20);
  }

  return this.save();
};

userSchema.methods.clearConversation = function clearConversation() {
  this.conversationHistory = [];
  return this.save();
};

userSchema.statics.getGlobalStats = async function getGlobalStats() {
  const totalUsers = await this.countDocuments();
  const activeUsers24h = await this.countDocuments({
    lastActivityAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  });
  const activeUsers7d = await this.countDocuments({
    lastActivityAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
  });

  const aggregateStats = await this.aggregate([
    {
      $group: {
        _id: null,
        totalTokens: { $sum: '$tokens' },
        totalSpent: { $sum: '$totalTokensSpent' },
        totalPurchased: { $sum: '$totalTokensPurchased' },
        totalGenerations: { $sum: '$stats.totalGenerations' }
      }
    }
  ]);

  return {
    totalUsers,
    activeUsers24h,
    activeUsers7d,
    ...aggregateStats[0]
  };
};

module.exports = mongoose.model('User', userSchema);
