const User = require('../database/models/User');
const Transaction = require('../database/models/Transaction');

/**
 * Отримати або створити користувача
 */
async function getUser(userId, userInfo = {}) {
  try {
    let user = await User.findById(userId);
    
    if (!user) {
      // Створюємо нового користувача
      user = new User({
        _id: userId,
        username: userInfo.username,
        firstName: userInfo.first_name,
        lastName: userInfo.last_name,
        languageCode: userInfo.language_code || 'uk',
        tokens: 10,  // Початковий баланс
        totalTokensEarned: 10
      });

      await user.save();
      
      // Додаємо початкову транзакцію
      await Transaction.create({
        userId,
        type: 'bonus',
        category: 'initial',
        amount: 10,
        balanceBefore: 0,
        balanceAfter: 10,
        description: 'Початковий бонус при реєстрації'
      });
    } else {
      // Оновлюємо останню активність
      user.lastActivityAt = new Date();
      await user.save();
    }
    
    return user;
  } catch (error) {
    console.error('Error in getUser:', error);
    throw error;
  }
}

/**
 * Перевірити чи достатньо токенів
 */
async function hasTokens(userId, amount) {
  try {
    const user = await User.findById(userId);
    return user && user.tokens >= amount;
  } catch (error) {
    console.error('Error in hasTokens:', error);
    return false;
  }
}

/**
 * Відняти токени
 */
async function deductTokens(userId, amount, action, details = {}) {
  try {
    const user = await User.findById(userId);
    
    if (!user || user.tokens < amount) {
      return false;
    }
    
    const balanceBefore = user.tokens;
    user.tokens -= amount;
    user.totalTokensSpent += amount;
    const balanceAfter = user.tokens;
    
    // Оновлюємо статистику
    if (details.modelKey) {
      user.stats.totalGenerations += 1;
      
      // Визначаємо тип генерації
      if (details.modelKey.includes('text') || details.modelKey.includes('claude')) {
        user.stats.textRequests += 1;
      } else if (details.modelKey.includes('vision') || details.modelKey.includes('image')) {
        if (details.isAnalysis) {
          user.stats.visionRequests += 1;
        } else {
          user.stats.imageRequests += 1;
        }
      } else if (details.modelKey.includes('video') || details.modelKey.includes('runway') || details.modelKey.includes('kling')) {
        user.stats.videoRequests += 1;
      } else if (details.modelKey.includes('audio') || details.modelKey.includes('suno')) {
        user.stats.audioRequests += 1;
      }
    }
    
    await user.save();
    
    // Створюємо транзакцію
    await Transaction.create({
      userId,
      type: 'deduction',
      category: 'generation',
      amount,
      balanceBefore,
      balanceAfter,
      description: action,
      model: details.modelKey ? {
        key: details.modelKey,
        name: details.modelName,
        cost: amount,
        apiCost: details.apiCost
      } : undefined,
      metadata: details
    });
    
    return true;
  } catch (error) {
    console.error('Error in deductTokens:', error);
    return false;
  }
}

/**
 * Додати токени
 */
async function addTokens(userId, amount, reason = 'purchase', metadata = {}) {
  try {
    const user = await User.findById(userId);
    if (!user) return null;
    
    const balanceBefore = user.tokens;
    user.tokens += amount;
    const balanceAfter = user.tokens;
    
    if (reason === 'purchase' || reason === 'subscription_purchase') {
      user.totalTokensPurchased += amount;
    }
    user.totalTokensEarned += amount;
    
    await user.save();
    
    // Визначаємо категорію
    let category = 'bonus';
    if (reason.includes('subscription') || reason.includes('purchase')) {
      category = 'subscription';
    } else if (reason.includes('admin')) {
      category = 'admin';
    } else if (reason.includes('referral')) {
      category = 'referral';
    }
    
    // Створюємо транзакцію
    await Transaction.create({
      userId,
      type: 'addition',
      category,
      amount,
      balanceBefore,
      balanceAfter,
      description: reason,
      metadata
    });
    
    return balanceAfter;
  } catch (error) {
    console.error('Error in addTokens:', error);
    return null;
  }
}

/**
 * Встановити підписку
 */
async function setSubscription(userId, subscriptionType, durationDays = 30) {
  try {
    const user = await User.findById(userId);
    if (!user) return null;
    
    const startedAt = new Date();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + durationDays);
    
    user.subscription = {
      type: subscriptionType,
      startedAt,
      expiresAt,
      isActive: true
    };
    
    await user.save();
    return user;
  } catch (error) {
    console.error('Error in setSubscription:', error);
    return null;
  }
}

/**
 * Перевірити чи активна підписка
 */
async function hasActiveSubscription(userId) {
  try {
    const user = await User.findById(userId);
    return user?.hasActiveSubscription || false;
  } catch (error) {
    console.error('Error in hasActiveSubscription:', error);
    return false;
  }
}

/**
 * Зберегти контекст розмови
 */
async function saveConversationMessage(userId, role, content) {
  try {
    const user = await User.findById(userId);
    if (!user) return [];
    
    await user.addToConversation(role, content);
    return user.conversationHistory;
  } catch (error) {
    console.error('Error in saveConversationMessage:', error);
    return [];
  }
}

/**
 * Отримати історію розмови
 */
async function getConversationHistory(userId) {
  try {
    const user = await User.findById(userId);
    return user?.conversationHistory || [];
  } catch (error) {
    console.error('Error in getConversationHistory:', error);
    return [];
  }
}

/**
 * Очистити історію розмови
 */
async function clearConversationHistory(userId) {
  try {
    const user = await User.findById(userId);
    if (!user) return false;
    
    await user.clearConversation();
    return true;
  } catch (error) {
    console.error('Error in clearConversationHistory:', error);
    return false;
  }
}

/**
 * Отримати історію транзакцій
 */
async function getTransactionHistory(userId, limit = 10) {
  try {
    return await Transaction.getUserHistory(userId, limit);
  } catch (error) {
    console.error('Error in getTransactionHistory:', error);
    return [];
  }
}

/**
 * Отримати статистику користувача
 */
async function getUserStats(userId) {
  try {
    const user = await User.findById(userId);
    if (!user) return null;
    
    const transactions = await Transaction.find({ userId, type: 'deduction' });
    
    return {
      currentBalance: user.tokens,
      totalSpent: user.totalTokensSpent,
      totalPurchased: user.totalTokensPurchased,
      totalEarned: user.totalTokensEarned,
      generationCount: user.stats.totalGenerations,
      textRequests: user.stats.textRequests,
      imageRequests: user.stats.imageRequests,
      videoRequests: user.stats.videoRequests,
      audioRequests: user.stats.audioRequests,
      visionRequests: user.stats.visionRequests,
      memberSince: user.createdAt,
      lastActivity: user.lastActivityAt,
      hasSubscription: user.hasActiveSubscription,
      subscriptionType: user.subscription?.type,
      subscriptionExpiry: user.subscription?.expiresAt
    };
  } catch (error) {
    console.error('Error in getUserStats:', error);
    return null;
  }
}

/**
 * Отримати всіх користувачів (для адміністрування)
 */
async function getAllUsers(filters = {}) {
  try {
    const query = {};
    
    if (filters.isBanned !== undefined) {
      query.isBanned = filters.isBanned;
    }
    
    if (filters.hasSubscription) {
      query['subscription.expiresAt'] = { $gt: new Date() };
    }
    
    return await User.find(query)
      .sort({ lastActivityAt: -1 })
      .limit(filters.limit || 100)
      .lean();
  } catch (error) {
    console.error('Error in getAllUsers:', error);
    return [];
  }
}

/**
 * Отримати кількість активних користувачів
 */
async function getActiveUsersCount(hoursAgo = 24) {
  try {
    const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    return await User.countDocuments({
      lastActivityAt: { $gte: cutoffTime }
    });
  } catch (error) {
    console.error('Error in getActiveUsersCount:', error);
    return 0;
  }
}

module.exports = {
  getUser,
  hasTokens,
  deductTokens,
  addTokens,
  setSubscription,
  hasActiveSubscription,
  saveConversationMessage,
  getConversationHistory,
  clearConversationHistory,
  getTransactionHistory,
  getUserStats,
  getAllUsers,
  getActiveUsersCount
};