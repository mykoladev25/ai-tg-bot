const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Telegram user info
  _id: { type: Number, required: true },  // Використовуємо Telegram ID як _id
  username: { type: String, index: true },
  firstName: String,
  lastName: String,
  languageCode: { type: String, default: 'uk' },
  
  // Баланс токенів
  tokens: { type: Number, default: 10, required: true },  // Початковий баланс 10⚡
  totalTokensPurchased: { type: Number, default: 0 },
  totalTokensSpent: { type: Number, default: 0 },
  totalTokensEarned: { type: Number, default: 10 },  // Включає початковий бонус
  
  // Підписка
  subscription: {
    type: { type: String, enum: ['TRIAL', 'STARTER', 'BASIC', 'PRO', 'PREMIUM', null] },
    startedAt: Date,
    expiresAt: Date,
    isActive: Boolean
  },
  
  // Статистика використання
  stats: {
    totalGenerations: { type: Number, default: 0 },
    textRequests: { type: Number, default: 0 },
    imageRequests: { type: Number, default: 0 },
    videoRequests: { type: Number, default: 0 },
    audioRequests: { type: Number, default: 0 },
    visionRequests: { type: Number, default: 0 }
  },
  
  // Поточна сесія
  currentModel: String,  // Яка модель зараз обрана
  
  // Історія розмов Claude (останні 20)
  conversationHistory: [{
    role: { type: String, enum: ['user', 'assistant'] },
    content: String,
    timestamp: { type: Date, default: Date.now }
  }],
  
  // Статус
  isBanned: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  banReason: String,
  bannedAt: Date,
  
  referralCode: { type: String },
  referredBy: { type: Number, ref: 'User' },
  referralEarnings: { type: Number, default: 0 },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  lastActivityAt: { type: Date, default: Date.now }
}, {
  _id: false,  // Вимикаємо автоматичний _id, бо використовуємо свій
  timestamps: false  // Вимикаємо автоматичні timestamps
});

// Індекси для швидкого пошуку
userSchema.index({ lastActivityAt: -1 });
userSchema.index({ 'subscription.expiresAt': 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ referralCode: 1 }, { unique: true, sparse: true });

// Virtual для перевірки активної підписки
userSchema.virtual('hasActiveSubscription').get(function() {
  return this.subscription?.expiresAt && this.subscription.expiresAt > new Date();
});

// Метод для оновлення останньої активності
userSchema.methods.updateActivity = function() {
  this.lastActivityAt = new Date();
  return this.save();
};

// Метод для додавання повідомлення в історію розмови
userSchema.methods.addToConversation = function(role, content) {
  this.conversationHistory.push({ role, content, timestamp: new Date() });
  
  // Обмежуємо історію до 20 останніх повідомлень
  if (this.conversationHistory.length > 20) {
    this.conversationHistory = this.conversationHistory.slice(-20);
  }
  
  return this.save();
};

// Метод для очищення історії розмови
userSchema.methods.clearConversation = function() {
  this.conversationHistory = [];
  return this.save();
};

// Static метод для отримання статистики
userSchema.statics.getGlobalStats = async function() {
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

const User = mongoose.model('User', userSchema);

module.exports = User;