/**
 * UsageEvent - tracking all model generation events for COGS calculation
 * Append-only collection for analytics
 */

const mongoose = require('mongoose');

const usageEventSchema = new mongoose.Schema({
  // Timestamp
  ts: { type: Date, default: Date.now, index: true },

  // User info
  userId: { type: String, required: true, index: true },
  chatId: { type: String, default: null },

  // Request tracking
  requestId: { type: String, required: true, index: true },

  // Model identification
  modelKey: { type: String, required: true, index: true },
  modelName: { type: String },

  // Provider info
  provider: { type: String, default: 'replicate' }, // replicate|internal|other
  providerModel: { type: String, default: null },

  // For seconds-based billing (Kling, Veo)
  seconds: { type: Number, default: null },

  // Token cost (internal)
  tokensSpent: { type: Number, default: 0 },

  // Financial metrics
  estimatedRevenueUSD: { type: Number, default: 0 },
  estimatedApiCostUSD: { type: Number, default: 0 },
  actualApiCostUSD: { type: Number, default: null },

  // User status at time of event
  planAtTime: { type: String, default: null }, // trial/starter/basic/pro/premium
  isTrial: { type: Boolean, default: false, index: true },
  isFree: { type: Boolean, default: false }, // using free/trial tokens

  // Result
  success: { type: Boolean, default: false },
  errorCode: { type: String, default: null },
  latencyMs: { type: Number, default: null },

  // Extra metadata
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: false,
  collection: 'usage_events'
});

// Compound indexes for common queries
usageEventSchema.index({ userId: 1, ts: -1 });
usageEventSchema.index({ modelKey: 1, ts: -1 });
usageEventSchema.index({ isTrial: 1, ts: -1 });
usageEventSchema.index({ success: 1, ts: -1 });
usageEventSchema.index({ ts: 1, modelKey: 1 }); // For daily aggregations

// Static method: Get daily COGS summary
usageEventSchema.statics.getDailyCogs = async function(startDate, endDate, groupBy = 'day') {
  const dateFormat = groupBy === 'week' ? '%Y-W%V' : groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

  return this.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: {
          period: { $dateToString: { format: dateFormat, date: '$ts' } },
          modelKey: '$modelKey'
        },
        count: { $sum: 1 },
        totalSeconds: { $sum: '$seconds' },
        totalTokens: { $sum: '$tokensSpent' },
        estimatedCogs: { $sum: '$estimatedApiCostUSD' },
        estimatedRevenue: { $sum: '$estimatedRevenueUSD' },
        successCount: { $sum: { $cond: ['$success', 1, 0] } },
        failCount: { $sum: { $cond: ['$success', 0, 1] } }
      }
    },
    {
      $group: {
        _id: '$_id.period',
        models: {
          $push: {
            modelKey: '$_id.modelKey',
            count: '$count',
            seconds: '$totalSeconds',
            tokens: '$totalTokens',
            cogs: '$estimatedCogs',
            revenue: '$estimatedRevenue',
            successRate: { $divide: ['$successCount', { $add: ['$successCount', '$failCount'] }] }
          }
        },
        totalCogs: { $sum: '$estimatedCogs' },
        totalRevenue: { $sum: '$estimatedRevenue' },
        totalCount: { $sum: '$count' }
      }
    },
    { $sort: { _id: -1 } }
  ]);
};

// Static method: Get trial burn
usageEventSchema.statics.getTrialBurn = async function(startDate, endDate, groupBy = 'day') {
  const dateFormat = groupBy === 'week' ? '%Y-W%V' : groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

  return this.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        isTrial: true
      }
    },
    {
      $group: {
        _id: { $dateToString: { format: dateFormat, date: '$ts' } },
        trialBurnUSD: { $sum: '$estimatedApiCostUSD' },
        trialCount: { $sum: 1 },
        trialUsers: { $addToSet: '$userId' }
      }
    },
    {
      $project: {
        _id: 1,
        trialBurnUSD: 1,
        trialCount: 1,
        uniqueTrialUsers: { $size: '$trialUsers' }
      }
    },
    { $sort: { _id: -1 } }
  ]);
};

// Static method: Get fail rate by model
usageEventSchema.statics.getFailRate = async function(startDate, endDate, groupBy = 'day') {
  const dateFormat = groupBy === 'week' ? '%Y-W%V' : groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

  return this.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: {
          period: { $dateToString: { format: dateFormat, date: '$ts' } },
          modelKey: '$modelKey'
        },
        total: { $sum: 1 },
        failures: { $sum: { $cond: ['$success', 0, 1] } }
      }
    },
    {
      $project: {
        _id: 1,
        total: 1,
        failures: 1,
        failRate: {
          $multiply: [
            { $divide: ['$failures', { $max: ['$total', 1] }] },
            100
          ]
        }
      }
    },
    { $sort: { '_id.period': -1, failRate: -1 } }
  ]);
};

module.exports = mongoose.model('UsageEvent', usageEventSchema);

