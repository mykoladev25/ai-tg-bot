/**
 * DailySummary - cached daily aggregates for fast dashboard loading
 * Computed by scheduled job, not real-time
 */

const mongoose = require('mongoose');

const dailySummarySchema = new mongoose.Schema({
  // Day identifier (YYYY-MM-DD)
  day: { type: String, required: true, unique: true, index: true },

  // Revenue metrics
  revenueUSD: { type: Number, default: 0 },
  revenueUAH: { type: Number, default: 0 },
  revenueStars: { type: Number, default: 0 },

  // COGS metrics
  cogsUSD_est: { type: Number, default: 0 },
  cogsUSD_actual: { type: Number, default: null },

  // Gross margin
  grossUSD_est: { type: Number, default: 0 },
  grossUSD_actual: { type: Number, default: null },

  // Trial burn
  trialBurnUSD_est: { type: Number, default: 0 },

  // User counts
  paidUsers: { type: Number, default: 0 },
  trialUsers: { type: Number, default: 0 },
  activeUsers: { type: Number, default: 0 },

  // Purchases breakdown
  purchasesByPlan: {
    starter: { type: Number, default: 0 },
    basic: { type: Number, default: 0 },
    pro: { type: Number, default: 0 },
    premium: { type: Number, default: 0 }
  },

  // Purchases by provider
  purchasesByProvider: {
    wayforpay: { type: Number, default: 0 },
    liqpay: { type: Number, default: 0 },
    stars: { type: Number, default: 0 },
    stripe: { type: Number, default: 0 }
  },

  // Model usage breakdown
  usageByModel: [{
    modelKey: String,
    modelName: String,
    count: Number,
    seconds: Number,
    tokens: Number,
    cogs_est: Number,
    revenue_est: Number,
    failRate: Number
  }],

  // Generation stats
  totalGenerations: { type: Number, default: 0 },
  successfulGenerations: { type: Number, default: 0 },
  failedGenerations: { type: Number, default: 0 },
  overallFailRate: { type: Number, default: 0 },

  // Computed timestamp
  computedAt: { type: Date, default: Date.now }
}, {
  timestamps: false,
  collection: 'daily_summaries'
});

// Static method: Compute summary for a day
dailySummarySchema.statics.computeForDay = async function(dayString) {
  const UsageEvent = require('./UsageEvent');
  const PaymentEvent = require('./PaymentEvent');

  const startOfDay = new Date(dayString + 'T00:00:00.000Z');
  const endOfDay = new Date(dayString + 'T23:59:59.999Z');

  // Aggregate usage events
  const usageStats = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startOfDay, $lte: endOfDay }
      }
    },
    {
      $group: {
        _id: null,
        totalCogs: { $sum: '$estimatedApiCostUSD' },
        totalRevenue: { $sum: '$estimatedRevenueUSD' },
        trialBurn: {
          $sum: { $cond: ['$isTrial', '$estimatedApiCostUSD', 0] }
        },
        totalCount: { $sum: 1 },
        successCount: { $sum: { $cond: ['$success', 1, 0] } },
        failCount: { $sum: { $cond: ['$success', 0, 1] } },
        trialUsers: { $addToSet: { $cond: ['$isTrial', '$userId', null] } },
        activeUsers: { $addToSet: '$userId' }
      }
    }
  ]);

  // Aggregate by model
  const modelStats = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startOfDay, $lte: endOfDay }
      }
    },
    {
      $group: {
        _id: { modelKey: '$modelKey', modelName: '$modelName' },
        count: { $sum: 1 },
        seconds: { $sum: '$seconds' },
        tokens: { $sum: '$tokensSpent' },
        cogs_est: { $sum: '$estimatedApiCostUSD' },
        revenue_est: { $sum: '$estimatedRevenueUSD' },
        successCount: { $sum: { $cond: ['$success', 1, 0] } },
        failCount: { $sum: { $cond: ['$success', 0, 1] } }
      }
    },
    {
      $project: {
        modelKey: '$_id.modelKey',
        modelName: '$_id.modelName',
        count: 1,
        seconds: 1,
        tokens: 1,
        cogs_est: 1,
        revenue_est: 1,
        failRate: {
          $multiply: [
            { $divide: ['$failCount', { $max: [{ $add: ['$successCount', '$failCount'] }, 1] }] },
            100
          ]
        }
      }
    },
    { $sort: { cogs_est: -1 } }
  ]);

  // Aggregate payment events
  const paymentStats = await PaymentEvent.aggregate([
    {
      $match: {
        ts: { $gte: startOfDay, $lte: endOfDay },
        status: 'success'
      }
    },
    {
      $group: {
        _id: null,
        totalUSD: { $sum: '$amountUSD' },
        totalUAH: { $sum: '$amountUAH' },
        totalStars: { $sum: '$amountStars' },
        paidUsers: { $addToSet: '$userId' },
        starterCount: { $sum: { $cond: [{ $eq: ['$planKey', 'starter'] }, 1, 0] } },
        basicCount: { $sum: { $cond: [{ $eq: ['$planKey', 'basic'] }, 1, 0] } },
        proCount: { $sum: { $cond: [{ $eq: ['$planKey', 'pro'] }, 1, 0] } },
        premiumCount: { $sum: { $cond: [{ $eq: ['$planKey', 'premium'] }, 1, 0] } },
        wayforpayCount: { $sum: { $cond: [{ $eq: ['$provider', 'wayforpay'] }, 1, 0] } },
        liqpayCount: { $sum: { $cond: [{ $eq: ['$provider', 'liqpay'] }, 1, 0] } },
        starsCount: { $sum: { $cond: [{ $eq: ['$provider', 'stars'] }, 1, 0] } },
        stripeCount: { $sum: { $cond: [{ $eq: ['$provider', 'stripe'] }, 1, 0] } }
      }
    }
  ]);

  const usage = usageStats[0] || {};
  const payments = paymentStats[0] || {};

  const summary = {
    day: dayString,
    revenueUSD: payments.totalUSD || 0,
    revenueUAH: payments.totalUAH || 0,
    revenueStars: payments.totalStars || 0,
    cogsUSD_est: usage.totalCogs || 0,
    grossUSD_est: (payments.totalUSD || 0) - (usage.totalCogs || 0),
    trialBurnUSD_est: usage.trialBurn || 0,
    paidUsers: payments.paidUsers ? payments.paidUsers.length : 0,
    trialUsers: usage.trialUsers ? usage.trialUsers.filter(u => u !== null).length : 0,
    activeUsers: usage.activeUsers ? usage.activeUsers.length : 0,
    purchasesByPlan: {
      starter: payments.starterCount || 0,
      basic: payments.basicCount || 0,
      pro: payments.proCount || 0,
      premium: payments.premiumCount || 0
    },
    purchasesByProvider: {
      wayforpay: payments.wayforpayCount || 0,
      liqpay: payments.liqpayCount || 0,
      stars: payments.starsCount || 0,
      stripe: payments.stripeCount || 0
    },
    usageByModel: modelStats.map(m => ({
      modelKey: m.modelKey,
      modelName: m.modelName,
      count: m.count,
      seconds: m.seconds || 0,
      tokens: m.tokens,
      cogs_est: m.cogs_est,
      revenue_est: m.revenue_est,
      failRate: m.failRate
    })),
    totalGenerations: usage.totalCount || 0,
    successfulGenerations: usage.successCount || 0,
    failedGenerations: usage.failCount || 0,
    overallFailRate: usage.totalCount > 0
      ? ((usage.failCount || 0) / usage.totalCount) * 100
      : 0,
    computedAt: new Date()
  };

  // Upsert
  await this.findOneAndUpdate(
    { day: dayString },
    summary,
    { upsert: true, new: true }
  );

  return summary;
};

// Static method: Get range of summaries
dailySummarySchema.statics.getRange = async function(startDay, endDay) {
  return this.find({
    day: { $gte: startDay, $lte: endDay }
  }).sort({ day: -1 }).lean();
};

module.exports = mongoose.model('DailySummary', dailySummarySchema);

