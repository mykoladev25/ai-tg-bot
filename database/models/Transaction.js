const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: Number, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: ['deduction', 'addition', 'purchase', 'refund', 'bonus'],
    required: true
  },
  category: {
    type: String,
    enum: ['generation', 'subscription', 'bonus', 'admin', 'referral', 'initial'],
    required: true
  },
  amount: { type: Number, required: true },
  balanceBefore: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  description: String,
  model: {
    key: String,
    name: String,
    cost: Number,
    apiCost: Number
  },
  sessionId: { type: String, unique: true, sparse: true, index: true },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: false
});

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ category: 1 });

transactionSchema.statics.getUserHistory = async function getUserHistory(userId, limit = 10) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

transactionSchema.statics.getDailyStats = async function getDailyStats(startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        createdAt: {
          $gte: startDate,
          $lte: endDate
        }
      }
    },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
        },
        totalTransactions: { $sum: 1 },
        deductions: {
          $sum: { $cond: [{ $eq: ['$type', 'deduction'] }, '$amount', 0] }
        },
        additions: {
          $sum: { $cond: [{ $eq: ['$type', 'addition'] }, '$amount', 0] }
        },
        purchases: {
          $sum: { $cond: [{ $eq: ['$type', 'purchase'] }, 1, 0] }
        },
        totalApiCost: { $sum: '$model.apiCost' }
      }
    },
    { $sort: { _id: -1 } }
  ]);
};

transactionSchema.statics.getTopModels = async function getTopModels(limit = 10) {
  return this.aggregate([
    {
      $match: {
        'model.key': { $exists: true },
        type: 'deduction'
      }
    },
    {
      $group: {
        _id: '$model.key',
        modelName: { $first: '$model.name' },
        usageCount: { $sum: 1 },
        totalTokensSpent: { $sum: '$amount' },
        totalApiCost: { $sum: '$model.apiCost' },
        uniqueUsers: { $addToSet: '$userId' }
      }
    },
    {
      $project: {
        _id: 1,
        modelName: 1,
        usageCount: 1,
        totalTokensSpent: 1,
        totalApiCost: 1,
        uniqueUsers: { $size: '$uniqueUsers' }
      }
    },
    { $sort: { usageCount: -1 } },
    { $limit: limit }
  ]);
};

module.exports = mongoose.model('Transaction', transactionSchema);
