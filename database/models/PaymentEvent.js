/**
 * PaymentEvent - tracking all payment transactions for revenue calculation
 * Append-only collection with idempotency on (provider, providerPaymentId)
 */

const mongoose = require('mongoose');

const paymentEventSchema = new mongoose.Schema({
  // Timestamp
  ts: { type: Date, default: Date.now, index: true },

  // User info
  userId: { type: String, required: true, index: true },

  // Payment provider
  provider: {
    type: String,
    required: true,
    enum: ['liqpay', 'wayforpay', 'stars', 'stripe']
  },

  // Provider-specific payment ID (for idempotency)
  providerPaymentId: { type: String, required: true },

  // Plan info
  planKey: { type: String, required: true }, // starter/basic/pro/premium
  planName: { type: String },

  // Amounts
  amountUAH: { type: Number, default: null },
  amountUSD: { type: Number, default: null },
  amountStars: { type: Number, default: null },

  // Tokens granted
  tokensGranted: { type: Number, required: true },

  // Status
  status: {
    type: String,
    required: true,
    enum: ['success', 'failed', 'refunded', 'pending']
  },

  // Raw webhook payload (for debugging)
  raw: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: false,
  collection: 'payment_events'
});

// UNIQUE constraint on provider + providerPaymentId (idempotency)
paymentEventSchema.index(
  { provider: 1, providerPaymentId: 1 },
  { unique: true, background: true }
);

// Compound indexes
paymentEventSchema.index({ userId: 1, ts: -1 });
paymentEventSchema.index({ planKey: 1, ts: -1 });
paymentEventSchema.index({ status: 1, ts: -1 });

// Static method: Get revenue by period
paymentEventSchema.statics.getRevenue = async function(startDate, endDate, groupBy = 'day') {
  const dateFormat = groupBy === 'week' ? '%Y-W%V' : groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

  return this.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        status: 'success'
      }
    },
    {
      $group: {
        _id: {
          period: { $dateToString: { format: dateFormat, date: '$ts' } },
          provider: '$provider',
          planKey: '$planKey'
        },
        count: { $sum: 1 },
        totalUSD: { $sum: '$amountUSD' },
        totalUAH: { $sum: '$amountUAH' },
        totalStars: { $sum: '$amountStars' },
        totalTokens: { $sum: '$tokensGranted' },
        uniqueUsers: { $addToSet: '$userId' }
      }
    },
    {
      $group: {
        _id: '$_id.period',
        byProvider: {
          $push: {
            provider: '$_id.provider',
            planKey: '$_id.planKey',
            count: '$count',
            usd: '$totalUSD',
            uah: '$totalUAH',
            stars: '$totalStars',
            tokens: '$totalTokens',
            users: { $size: '$uniqueUsers' }
          }
        },
        totalUSD: { $sum: '$totalUSD' },
        totalUAH: { $sum: '$totalUAH' },
        totalCount: { $sum: '$count' },
        allUsers: { $push: '$uniqueUsers' }
      }
    },
    {
      $project: {
        _id: 1,
        byProvider: 1,
        totalUSD: 1,
        totalUAH: 1,
        totalCount: 1,
        uniquePayers: {
          $size: {
            $reduce: {
              input: '$allUsers',
              initialValue: [],
              in: { $setUnion: ['$$value', '$$this'] }
            }
          }
        }
      }
    },
    { $sort: { _id: -1 } }
  ]);
};

// Static method: Get purchases by plan
paymentEventSchema.statics.getPurchasesByPlan = async function(startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        ts: { $gte: startDate, $lte: endDate },
        status: 'success'
      }
    },
    {
      $group: {
        _id: '$planKey',
        count: { $sum: 1 },
        totalUSD: { $sum: '$amountUSD' },
        totalTokens: { $sum: '$tokensGranted' },
        uniqueUsers: { $addToSet: '$userId' }
      }
    },
    {
      $project: {
        _id: 1,
        count: 1,
        totalUSD: 1,
        totalTokens: 1,
        uniqueUsers: { $size: '$uniqueUsers' }
      }
    },
    { $sort: { totalUSD: -1 } }
  ]);
};

// Static method: Safe upsert (idempotent)
paymentEventSchema.statics.logPayment = async function(payload) {
  const { provider, providerPaymentId } = payload;

  try {
    // Try to insert, if duplicate key error - it's already logged
    const event = await this.findOneAndUpdate(
      { provider, providerPaymentId },
      { $setOnInsert: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return { success: true, isNew: event.isNew !== false, event };
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key - payment already exists
      console.log(`⚠️ Payment already logged: ${provider}/${providerPaymentId}`);
      return { success: true, isNew: false, existing: true };
    }
    throw error;
  }
};

module.exports = mongoose.model('PaymentEvent', paymentEventSchema);

