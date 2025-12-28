const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: Number, ref: 'User', required: true, index: true },
  
  // Тип транзакції
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
  
  // Сума
  amount: { type: Number, required: true },
  balanceBefore: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  
  // Деталі
  description: String,
  
  // Інформація про модель (якщо це генерація)
  model: {
    key: String,          // claude_text, midjourney, runway
    name: String,         // "Claude Sonnet", "Runway Gen-4"
    cost: Number,         // Вартість для користувача
    apiCost: Number       // Реальна вартість API
  },
  
  // Додаткові дані
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Timestamp
  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: false
});

// Складені індекси для швидких запитів
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ category: 1 });

// Static метод для отримання історії користувача
transactionSchema.statics.getUserHistory = async function(userId, limit = 10) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// Static метод для агрегації по днях
transactionSchema.statics.getDailyStats = async function(startDate, endDate) {
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

// Static метод для топ моделей
transactionSchema.statics.getTopModels = async function(limit = 10) {
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

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;