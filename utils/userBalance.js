const { TRIAL_TOKENS } = require('../config/constants');
const Transaction = require('../database/models/Transaction');
const User = require('../database/models/User');

async function getUser(userId, userInfo = {}) {
  try {
    let user = await User.findById(userId);
    const explicitLanguageCode = userInfo.language_code || userInfo.languageCode;
    const nextLanguageCode = explicitLanguageCode || 'en';

    if (!user) {
      user = new User({
        _id: userId,
        username: userInfo.username,
        firstName: userInfo.first_name,
        lastName: userInfo.last_name,
        languageCode: nextLanguageCode,
        tokens: TRIAL_TOKENS,
        totalTokensEarned: TRIAL_TOKENS
      });

      await user.save();

      await Transaction.create({
        userId,
        type: 'bonus',
        category: 'initial',
        amount: TRIAL_TOKENS,
        balanceBefore: 0,
        balanceAfter: TRIAL_TOKENS,
        description: 'Initial signup bonus'
      });
    } else {
      if (userInfo.username && user.username !== userInfo.username) {
        user.username = userInfo.username;
      }
      if (userInfo.first_name && user.firstName !== userInfo.first_name) {
        user.firstName = userInfo.first_name;
      }
      if (userInfo.last_name && user.lastName !== userInfo.last_name) {
        user.lastName = userInfo.last_name;
      }
      if (explicitLanguageCode && user.languageCode !== explicitLanguageCode) {
        user.languageCode = explicitLanguageCode;
      }
      user.lastActivityAt = new Date();
      await user.save();
    }

    return user;
  } catch (error) {
    console.error('Error in getUser:', error);
    throw error;
  }
}

async function hasTokens(userId, amount) {
  try {
    const user = await User.findById(userId);
    return user && user.tokens >= amount;
  } catch (error) {
    console.error('Error in hasTokens:', error);
    return false;
  }
}

async function getUserStats(userId) {
  try {
    const user = await User.findById(userId).lean();
    if (!user) {
      return null;
    }

    let generationCount = user.stats?.totalGenerations;
    let totalSpent = user.totalTokensSpent;

    // Older user documents may not have the denormalized counters populated.
    if (generationCount == null || totalSpent == null) {
      const [aggregate] = await Transaction.aggregate([
        { $match: { userId } },
        {
          $group: {
            _id: null,
            totalSpent: {
              $sum: {
                $cond: [{ $eq: ['$type', 'deduction'] }, '$amount', 0]
              }
            },
            generationCount: {
              $sum: {
                $cond: [{ $eq: ['$category', 'generation'] }, 1, 0]
              }
            }
          }
        }
      ]);

      generationCount = generationCount ?? aggregate?.generationCount ?? 0;
      totalSpent = totalSpent ?? aggregate?.totalSpent ?? 0;
    }

    return {
      currentBalance: Number(user.tokens || 0),
      generationCount: Number(generationCount || 0),
      totalSpent: Number(totalSpent || 0),
      memberSince: user.createdAt ? new Date(user.createdAt) : new Date()
    };
  } catch (error) {
    console.error('Error in getUserStats:', error);
    return null;
  }
}

async function getConversationHistory(userId, limit = 20) {
  try {
    const user = await User.findById(userId).select('conversationHistory').lean();
    if (!user?.conversationHistory?.length) {
      return [];
    }

    return user.conversationHistory
      .slice(-limit)
      .map(({ role, content }) => ({ role, content }));
  } catch (error) {
    console.error('Error in getConversationHistory:', error);
    return [];
  }
}

async function saveConversationMessage(userId, role, content) {
  try {
    const user = await getUser(userId);
    user.conversationHistory.push({ role, content, timestamp: new Date() });

    if (user.conversationHistory.length > 20) {
      user.conversationHistory = user.conversationHistory.slice(-20);
    }

    await user.save();
    return true;
  } catch (error) {
    console.error('Error in saveConversationMessage:', error);
    return false;
  }
}

async function clearConversationHistory(userId) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      return false;
    }

    user.conversationHistory = [];
    await user.save();
    return true;
  } catch (error) {
    console.error('Error in clearConversationHistory:', error);
    return false;
  }
}

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

    if (details.modelKey) {
      user.stats.totalGenerations += 1;

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

    await Transaction.create({
      userId,
      type: 'deduction',
      category: 'generation',
      amount,
      balanceBefore,
      balanceAfter,
      description: action,
      model: details.modelKey
        ? {
            key: details.modelKey,
            name: details.modelName,
            cost: amount,
            apiCost: details.apiCost
          }
        : undefined,
      metadata: details
    });

    return true;
  } catch (error) {
    console.error('Error in deductTokens:', error);
    return false;
  }
}

async function addTokens(userId, amount, reason = 'purchase', metadata = {}) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      return null;
    }

    const balanceBefore = user.tokens;
    user.tokens += amount;
    const balanceAfter = user.tokens;

    const isPaidPurchase = /purchase|payment|liqpay|wayforpay/i.test(reason);
    if (isPaidPurchase) {
      user.totalTokensPurchased += amount;
    }
    user.totalTokensEarned += amount;

    await user.save();

    let category = 'bonus';
    if (reason.includes('subscription') || reason.includes('purchase') || reason.includes('stripe')) {
      category = 'subscription';
    } else if (reason.includes('admin')) {
      category = 'admin';
    } else if (reason.includes('referral')) {
      category = 'referral';
    }

    const transactionData = {
      userId,
      type: 'addition',
      category,
      amount,
      balanceBefore,
      balanceAfter,
      description: reason,
      metadata
    };

    if (metadata.sessionId) {
      transactionData.sessionId = metadata.sessionId;
    }

    await Transaction.create(transactionData);

    return balanceAfter;
  } catch (error) {
    console.error('Error in addTokens:', error);
    return null;
  }
}

async function removeTokens(userId, amount, reason = 'refund', metadata = {}) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      return null;
    }

    const balanceBefore = user.tokens;
    const tokensToRemove = Math.min(amount, user.tokens);
    user.tokens -= tokensToRemove;

    if (reason.includes('refund')) {
      user.totalTokensPurchased = Math.max(0, user.totalTokensPurchased - tokensToRemove);
    }

    const balanceAfter = user.tokens;

    await user.save();

    await Transaction.create({
      userId,
      type: 'removal',
      category: 'refund',
      amount: tokensToRemove,
      balanceBefore,
      balanceAfter,
      description: reason,
      metadata
    });

    return balanceAfter;
  } catch (error) {
    console.error('Error in removeTokens:', error);
    return null;
  }
}

module.exports = {
  addTokens,
  clearConversationHistory,
  deductTokens,
  getConversationHistory,
  getUser,
  getUserStats,
  hasTokens,
  removeTokens,
  saveConversationMessage
};
