/**
 * Monitoring Aggregations - compute metrics from events
 */

const UsageEvent = require('../database/models/UsageEvent');
const PaymentEvent = require('../database/models/PaymentEvent');
const DailySummary = require('../database/models/DailySummary');
const User = require('../database/models/User');
const replicateBalanceConfig = require('../config/replicateBalance');
const kieBalanceConfig = require('../config/kieBalance');
const { TRIAL_TOKENS, WORST_CASE_TOKEN_USD, EFFECTIVE_TOKEN_USD, NET_REVENUE_FACTOR } = require('../config/constants');

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

async function getKieBalance() {
  const initialUSD = Number(kieBalanceConfig?.initialUSD) || 0;
  const topUps = Array.isArray(kieBalanceConfig?.topUps)
    ? kieBalanceConfig.topUps
    : [];
  const totalTopUpsUSD = topUps.reduce((sum, t) => sum + (Number(t.amountUSD) || 0), 0);
  const fundedUSD = initialUSD + totalTopUpsUSD;

  const startDate = parseFundingStartDate(kieBalanceConfig?.initialDate);
  const spendAgg = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate },
        provider: 'kie'
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

  // COGS aggregation for Replicate only
  const cogsAgg = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        provider: 'replicate'
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

  // Trial burn aggregation for Replicate only
  const trialAgg = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        provider: 'replicate',
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
  const revenueUSD = revenue.totalUSD || 0;
  const netRevenueUSD = revenueUSD * (NET_REVENUE_FACTOR ?? 0.93);
  const trialTokenLiabilityUSD = trial.trialBurn || 0;
  const totalCogsUSD = cogs.totalCogs || 0;
  const grossEstimated = netRevenueUSD - totalCogsUSD;

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
      estimated: totalCogsUSD,
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
      newUsers: freeUsersNew || 0,
      liabilityUSD: trialTokenLiabilityUSD,
      source: 'usage_events'
    },
    gross: {
      estimated: grossEstimated,
      marginPercent: netRevenueUSD > 0
        ? (((grossEstimated) / netRevenueUSD) * 100).toFixed(1)
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
 * Get top models by COGS (Replicate only)
 */
async function getTopModels(from, to, limit = 10) {
  const { startDate, endDate } = parseDateRange(from, to);

  return UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        provider: 'replicate'
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
 * Get top users by tokens spent (Replicate only)
 */
async function getTopUsers(from, to, limit = 10) {
  const { startDate, endDate } = parseDateRange(from, to);

  return UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        provider: 'replicate'
      }
    },
    {
      $group: {
        _id: '$userId',
        generations: { $sum: 1 },
        successCount: { $sum: { $cond: ['$success', 1, 0] } },
        tokensSpent: { $sum: '$tokensSpent' },
        cogs: { $sum: '$estimatedApiCostUSD' },
        revenue: { $sum: '$estimatedRevenueUSD' }
      }
    },
    {
      $addFields: {
        userIdLong: {
          $convert: { input: '$_id', to: 'long', onError: null, onNull: null }
        }
      }
    },
    {
      $lookup: {
        from: 'users',
        localField: 'userIdLong',
        foreignField: '_id',
        as: 'user'
      }
    },
    {
      $unwind: { path: '$user', preserveNullAndEmptyArrays: true }
    },
    {
      $project: {
        userId: '$_id',
        tokensSpent: 1,
        generations: 1,
        cogs: 1,
        revenue: 1,
        successRate: {
          $cond: [
            { $gt: ['$generations', 0] },
            { $multiply: [{ $divide: ['$successCount', '$generations'] }, 100] },
            0
          ]
        },
        user: {
          _id: '$user._id',
          username: '$user.username',
          firstName: '$user.firstName',
          lastName: '$user.lastName',
          languageCode: '$user.languageCode',
          subscription: '$user.subscription',
          tokens: '$user.tokens',
          totalTokensSpent: '$user.totalTokensSpent',
          totalTokensPurchased: '$user.totalTokensPurchased',
          totalTokensEarned: '$user.totalTokensEarned',
          isBanned: '$user.isBanned',
          isAdmin: '$user.isAdmin',
          referralCode: '$user.referralCode',
          referredBy: '$user.referredBy',
          referralEarnings: '$user.referralEarnings',
          createdAt: '$user.createdAt',
          lastActivityAt: '$user.lastActivityAt'
        }
      }
    },
    { $sort: { tokensSpent: -1 } },
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

/**
 * Get summary metrics for KIE.AI provider
 */
async function getKieSummary(from, to) {
  const { startDate, endDate } = parseDateRange(from, to);

  // COGS aggregation for KIE.AI only
  const kieCogsAgg = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        provider: 'kie'
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

  // Trial burn for KIE.AI
  const kieTrialAgg = await UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        provider: 'kie',
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

  const kieCogs = kieCogsAgg[0] || {};
  const kieTrial = kieTrialAgg[0] || {};
  const kieBalance = await getKieBalance();

  const revenueUSD = kieCogs.totalRevenue || 0;
  const totalCogsUSD = kieCogs.totalCogs || 0;
  const grossEstimated = revenueUSD - totalCogsUSD;

  return {
    period: {
      from: startDate.toISOString(),
      to: endDate.toISOString()
    },
    cogs: {
      estimated: totalCogsUSD,
      generations: kieCogs.generationCount || 0,
      successRate: kieCogs.generationCount > 0
        ? ((kieCogs.successCount || 0) / kieCogs.generationCount * 100).toFixed(1)
        : 0,
      activeUsers: kieCogs.activeUsers?.length || 0
    },
    revenue: {
      usd: revenueUSD,
      tokens: kieCogs.totalTokens || 0
    },
    trial: {
      burnUSD: kieTrial.trialBurn || 0,
      generations: kieTrial.trialCount || 0,
      users: kieTrial.trialUsers?.length || 0
    },
    kieBalance,
    gross: {
      estimated: grossEstimated,
      marginPercent: revenueUSD > 0
        ? ((grossEstimated / revenueUSD) * 100).toFixed(1)
        : 0
    }
  };
}

/**
 * Get top models for KIE.AI provider
 */
async function getTopKieModels(from, to, limit = 20) {
  const { startDate, endDate } = parseDateRange(from, to);

  return UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        provider: 'kie'
      }
    },
    {
      $group: {
        _id: '$modelKey',
        count: { $sum: 1 },
        totalCogs: { $sum: '$estimatedApiCostUSD' },
        totalRevenue: { $sum: '$estimatedRevenueUSD' },
        tokensSpent: { $sum: '$tokensSpent' },
        successCount: { $sum: { $cond: ['$success', 1, 0] } },
        failCount: { $sum: { $cond: ['$success', 0, 1] } }
      }
    },
    {
      $project: {
        modelKey: '$_id',
        count: 1,
        cogs: '$totalCogs',
        revenue: '$totalRevenue',
        tokens: '$tokensSpent',
        successCount: 1,
        failCount: 1,
        marginPercent: {
          $cond: [
            { $gt: ['$totalRevenue', 0] },
            {
              $multiply: [
                { $divide: [{ $subtract: ['$totalRevenue', '$totalCogs'] }, '$totalRevenue'] },
                100
              ]
            },
            0
          ]
        }
      }
    },
    { $sort: { cogs: -1 } },
    { $limit: limit }
  ]);
}

/**
 * Get top users for KIE.AI provider
 */
async function getTopKieUsers(from, to, limit = 20) {
  const { startDate, endDate } = parseDateRange(from, to);

  return UsageEvent.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        provider: 'kie'
      }
    },
    {
      $group: {
        _id: '$userId',
        count: { $sum: 1 },
        tokensSpent: { $sum: '$tokensSpent' },
        totalCogs: { $sum: '$estimatedApiCostUSD' },
        totalRevenue: { $sum: '$estimatedRevenueUSD' },
        successCount: { $sum: { $cond: ['$success', 1, 0] } }
      }
    },
    {
      $project: {
        userId: '$_id',
        count: 1,
        tokensSpent: 1,
        cogs: '$totalCogs',
        revenue: '$totalRevenue',
        successRate: {
          $cond: [
            { $gt: ['$count', 0] },
            { $multiply: [{ $divide: ['$successCount', '$count'] }, 100] },
            0
          ]
        }
      }
    },
    { $sort: { tokensSpent: -1 } },
    { $limit: limit }
  ]);
}

module.exports = {
  parseDateRange,
  getSummary,
  getKieSummary,
  getRevenue,
  getCogs,
  getTrialBurn,
  getFailRate,
  getPurchasesByPlan,
  getTopModels,
  getTopKieModels,
  getTopUsers,
  getTopKieUsers,
  getReplicateBalance,
  getKieBalance,
  computeDailySummary,
  getDailySummaries
};
