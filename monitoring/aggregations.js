/**
 * Monitoring Aggregations - compute metrics from events
 */

const UsageEvent = require('../database/models/UsageEvent');
const PaymentEvent = require('../database/models/PaymentEvent');
const DailySummary = require('../database/models/DailySummary');
const User = require('../database/models/User');
const replicateBalanceConfig = require('../config/replicateBalance');
const { TRIAL_TOKENS, WORST_CASE_TOKEN_USD } = require('../config/constants');

/**
 * Parse date range from query params
 */
function parseDateRange(from, to) {
  const now = new Date();
  const startDate = from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  const endDate = to ? new Date(to) : now;

  // Ensure valid dates
  if (isNaN(startDate.getTime())) throw new Error('Invalid "from" date');
  if (isNaN(endDate.getTime())) throw new Error('Invalid "to" date');

  return { startDate, endDate };
}

function parseFundingStartDate(value) {
  if (!value) return new Date(0);
  const date = new Date(value);
  return isNaN(date.getTime()) ? new Date(0) : date;
}

async function getReplicateBalance() {
  const initialUSD = Number(replicateBalanceConfig?.initialUSD) || 0;
  const topUps = Array.isArray(replicateBalanceConfig?.topUps)
    ? replicateBalanceConfig.topUps
    : [];
  const totalTopUpsUSD = topUps.reduce((sum, t) => sum + (Number(t.amountUSD) || 0), 0);
  const fundedUSD = initialUSD + totalTopUpsUSD;

  const startDate = parseFundingStartDate(replicateBalanceConfig?.initialDate);
  const spendAgg = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate },
        provider: 'replicate'
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$estimatedApiCostUSD' }
      }
    }
  ]);

  const spentUSD = spendAgg[0]?.total || 0;
  const remainingUSD = fundedUSD - spentUSD;
  const topUpNeededUSD = remainingUSD < 0 ? Math.abs(remainingUSD) : 0;

  return {
    fundedUSD,
    spentUSD,
    remainingUSD,
    topUpNeededUSD,
    startDate: startDate.toISOString().slice(0, 10),
    topUpsCount: topUps.length
  };
}

/**
 * Get summary metrics for dashboard
 */
async function getSummary(from, to) {
  const { startDate, endDate } = parseDateRange(from, to);

  // Revenue aggregation
  const revenueAgg = await PaymentEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        status: 'success'
      }
    },
    {
      $group: {
        _id: null,
        totalUSD: { $sum: '$amountUSD' },
        totalUAH: { $sum: '$amountUAH' },
        totalStars: { $sum: '$amountStars' },
        totalTokens: { $sum: '$tokensGranted' },
        purchaseCount: { $sum: 1 },
        uniqueUsers: { $addToSet: '$userId' }
      }
    }
  ]);

  // COGS aggregation
  const cogsAgg = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalCogs: { $sum: '$estimatedApiCostUSD' },
        totalRevenue: { $sum: '$estimatedRevenueUSD' },
        totalTokens: { $sum: '$tokensSpent' },
        generationCount: { $sum: 1 },
        successCount: { $sum: { $cond: ['$success', 1, 0] } },
        activeUsers: { $addToSet: '$userId' }
      }
    }
  ]);

  // Trial burn aggregation
  const trialAgg = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        isTrial: true
      }
    },
    {
      $group: {
        _id: null,
        trialBurn: { $sum: '$estimatedApiCostUSD' },
        trialCount: { $sum: 1 },
        trialUsers: { $addToSet: '$userId' }
      }
    }
  ]);

  const freeUsersTotal = await User.countDocuments({ totalTokensPurchased: 0 });
  const freeUsersNew = await User.countDocuments({
    totalTokensPurchased: 0,
    createdAt: { $gte: startDate, $lte: endDate }
  });
  const newUsersTotal = await User.countDocuments({
    createdAt: { $gte: startDate, $lte: endDate }
  });
  const totalUsers = await User.countDocuments();
  const paidUsersTotal = await User.countDocuments({ totalTokensPurchased: { $gt: 0 } });
  const replicateBalance = await getReplicateBalance();

  const revenue = revenueAgg[0] || {};
  const cogs = cogsAgg[0] || {};
  const trial = trialAgg[0] || {};
  const trialTokensPerUser = TRIAL_TOKENS;
  const tokenPriceUSD = WORST_CASE_TOKEN_USD ?? (110 / 4760);
  const trialTokenLiabilityUSD = newUsersTotal * trialTokensPerUser * tokenPriceUSD;
  const grossEstimated = (revenue.totalUSD || 0) - (cogs.totalCogs || 0) - trialTokenLiabilityUSD;

  return {
    period: {
      from: startDate.toISOString(),
      to: endDate.toISOString()
    },
    revenue: {
      usd: revenue.totalUSD || 0,
      uah: revenue.totalUAH || 0,
      stars: revenue.totalStars || 0,
      tokens: revenue.totalTokens || 0,
      purchases: revenue.purchaseCount || 0,
      paidUsers: revenue.uniqueUsers?.length || 0
    },
    cogs: {
      estimated: cogs.totalCogs || 0,
      generations: cogs.generationCount || 0,
      successRate: cogs.generationCount > 0
        ? ((cogs.successCount || 0) / cogs.generationCount * 100).toFixed(1)
        : 0,
      activeUsers: cogs.activeUsers?.length || 0
    },
    trial: {
      burnUSD: trial.trialBurn || 0,
      generations: trial.trialCount || 0,
      users: trial.trialUsers?.length || 0
    },
    users: {
      total: totalUsers || 0,
      paidTotal: paidUsersTotal || 0,
      freeTotal: freeUsersTotal || 0,
      freeNew: freeUsersNew || 0,
      newTotal: newUsersTotal || 0
    },
    replicateBalance,
    trialBonus: {
      tokensPerUser: trialTokensPerUser,
      newUsers: newUsersTotal || 0,
      liabilityUSD: trialTokenLiabilityUSD
    },
    gross: {
      estimated: grossEstimated,
      marginPercent: revenue.totalUSD > 0
        ? (((grossEstimated) / revenue.totalUSD) * 100).toFixed(1)
        : 0
    }
  };
}

/**
 * Get revenue breakdown by period
 */
async function getRevenue(from, to, groupBy = 'day') {
  const { startDate, endDate } = parseDateRange(from, to);
  return PaymentEvent.getRevenue(startDate, endDate, groupBy);
}

/**
 * Get COGS breakdown by period and optionally by model/provider
 */
async function getCogs(from, to, groupBy = 'day', by = null) {
  const { startDate, endDate } = parseDateRange(from, to);

  if (by === 'model') {
    return UsageEvent.getDailyCogs(startDate, endDate, groupBy);
  }

  // Simple daily COGS
  const dateFormat = groupBy === 'week' ? '%Y-W%V' : groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

  return UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: { $dateToString: { format: dateFormat, date: '$ts' } },
        totalCogs: { $sum: '$estimatedApiCostUSD' },
        totalRevenue: { $sum: '$estimatedRevenueUSD' },
        count: { $sum: 1 },
        successCount: { $sum: { $cond: ['$success', 1, 0] } }
      }
    },
    {
      $project: {
        _id: 1,
        cogs: '$totalCogs',
        revenue: '$totalRevenue',
        gross: { $subtract: ['$totalRevenue', '$totalCogs'] },
        count: 1,
        failRate: {
          $multiply: [
            { $divide: [{ $subtract: ['$count', '$successCount'] }, { $max: ['$count', 1] }] },
            100
          ]
        }
      }
    },
    { $sort: { _id: -1 } }
  ]);
}

/**
 * Get trial burn by period
 */
async function getTrialBurn(from, to, groupBy = 'day') {
  const { startDate, endDate } = parseDateRange(from, to);
  return UsageEvent.getTrialBurn(startDate, endDate, groupBy);
}

/**
 * Get fail rate by model
 */
async function getFailRate(from, to, groupBy = 'day', by = 'model') {
  const { startDate, endDate } = parseDateRange(from, to);
  return UsageEvent.getFailRate(startDate, endDate, groupBy);
}

/**
 * Get purchases by plan
 */
async function getPurchasesByPlan(from, to) {
  const { startDate, endDate } = parseDateRange(from, to);
  return PaymentEvent.getPurchasesByPlan(startDate, endDate);
}

/**
 * Get top models by COGS
 */
async function getTopModels(from, to, limit = 10) {
  const { startDate, endDate } = parseDateRange(from, to);

  return UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: { modelKey: '$modelKey', modelName: '$modelName' },
        count: { $sum: 1 },
        totalSeconds: { $sum: '$seconds' },
        totalTokens: { $sum: '$tokensSpent' },
        cogs: { $sum: '$estimatedApiCostUSD' },
        revenue: { $sum: '$estimatedRevenueUSD' },
        successCount: { $sum: { $cond: ['$success', 1, 0] } }
      }
    },
    {
      $project: {
        modelKey: '$_id.modelKey',
        modelName: '$_id.modelName',
        count: 1,
        seconds: '$totalSeconds',
        tokens: '$totalTokens',
        cogs: 1,
        revenue: 1,
        gross: { $subtract: ['$revenue', '$cogs'] },
        margin: {
          $cond: [
            { $gt: ['$revenue', 0] },
            { $multiply: [{ $divide: [{ $subtract: ['$revenue', '$cogs'] }, '$revenue'] }, 100] },
            0
          ]
        },
        failRate: {
          $multiply: [
            { $divide: [{ $subtract: ['$count', '$successCount'] }, { $max: ['$count', 1] }] },
            100
          ]
        }
      }
    },
    { $sort: { cogs: -1 } },
    { $limit: limit }
  ]);
}

/**
 * Compute and cache daily summary
 */
async function computeDailySummary(dayString) {
  return DailySummary.computeForDay(dayString);
}

/**
 * Get cached summaries for range
 */
async function getDailySummaries(startDay, endDay) {
  return DailySummary.getRange(startDay, endDay);
}

module.exports = {
  parseDateRange,
  getSummary,
  getRevenue,
  getCogs,
  getTrialBurn,
  getFailRate,
  getPurchasesByPlan,
  getTopModels,
  getReplicateBalance,
  computeDailySummary,
  getDailySummaries
};
