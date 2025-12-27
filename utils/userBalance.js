// Проста in-memory база (для продакшену використовуй MongoDB/PostgreSQL)
const users = new Map();

/**
 * Отримати або створити користувача
 */
function getUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      tokens: 100, // FREE токени при реєстрації
      subscription: null,
      subscriptionExpiry: null,
      conversationHistory: [],
      currentModel: null,
      history: [],
      createdAt: new Date(),
      lastActivity: new Date()
    });
  }
  
  // Оновлюємо останню активність
  const user = users.get(userId);
  user.lastActivity = new Date();
  
  return user;
}

/**
 * Перевірити чи достатньо токенів
 */
function hasTokens(userId, amount) {
  const user = getUser(userId);
  return user.tokens >= amount;
}

/**
 * Відняти токени
 */
function deductTokens(userId, amount, action, details = {}) {
  const user = getUser(userId);
  
  if (user.tokens < amount) {
    return false;
  }
  
  user.tokens -= amount;
  user.history.push({
    type: 'deduction',
    action,
    amount,
    details,
    balance: user.tokens,
    timestamp: new Date()
  });
  
  return true;
}

/**
 * Додати токени
 */
function addTokens(userId, amount, reason = 'purchase') {
  const user = getUser(userId);
  user.tokens += amount;
  
  user.history.push({
    type: 'addition',
    reason,
    amount,
    balance: user.tokens,
    timestamp: new Date()
  });
  
  return user.tokens;
}

/**
 * Встановити підписку
 */
function setSubscription(userId, subscriptionType, durationDays = 30) {
  const user = getUser(userId);
  user.subscription = subscriptionType;
  
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + durationDays);
  user.subscriptionExpiry = expiry;
  
  return user;
}

/**
 * Перевірити чи активна підписка
 */
function hasActiveSubscription(userId) {
  const user = getUser(userId);
  
  if (!user.subscription || !user.subscriptionExpiry) {
    return false;
  }
  
  return new Date() < user.subscriptionExpiry;
}

/**
 * Зберегти контекст розмови
 */
function saveConversationMessage(userId, role, content) {
  const user = getUser(userId);
  
  user.conversationHistory.push({
    role,
    content,
    timestamp: new Date()
  });
  
  // Обмежуємо історію до останніх 20 повідомлень
  if (user.conversationHistory.length > 20) {
    user.conversationHistory = user.conversationHistory.slice(-20);
  }
  
  return user.conversationHistory;
}

/**
 * Отримати історію розмови
 */
function getConversationHistory(userId) {
  const user = getUser(userId);
  return user.conversationHistory;
}

/**
 * Очистити історію розмови
 */
function clearConversationHistory(userId) {
  const user = getUser(userId);
  user.conversationHistory = [];
  return true;
}

/**
 * Встановити поточну модель
 */
function setCurrentModel(userId, modelKey) {
  const user = getUser(userId);
  user.currentModel = modelKey;
  return true;
}

/**
 * Отримати поточну модель
 */
function getCurrentModel(userId) {
  const user = getUser(userId);
  return user.currentModel;
}

/**
 * Отримати історію транзакцій
 */
function getTransactionHistory(userId, limit = 10) {
  const user = getUser(userId);
  return user.history.slice(-limit).reverse();
}

/**
 * Отримати статистику користувача
 */
function getUserStats(userId) {
  const user = getUser(userId);

  let totalSpent = 0;
  let generationCount = 0;

  for (const h of user.history) {
    if (h.type === 'deduction') {
      totalSpent += h.amount;
      generationCount++;
    }

    if (
        h.type === 'addition' &&
        typeof h.reason === 'string' &&
        h.reason.includes('refund')
    ) {
      totalSpent -= h.amount;
      generationCount = Math.max(0, generationCount - 1);
    }
  }

  return {
    currentBalance: user.tokens,
    totalSpent: Math.max(0, totalSpent),
    generationCount,
    totalAdded: user.history
        .filter(h => h.type === 'addition')
        .reduce((s, h) => s + h.amount, 0),
    memberSince: user.createdAt,
    lastActivity: user.lastActivity,
    hasSubscription: hasActiveSubscription(userId),
    subscriptionType: user.subscription,
    subscriptionExpiry: user.subscriptionExpiry
  };
}


/**
 * Отримати всіх користувачів (для адміністрування)
 */
function getAllUsers() {
  return Array.from(users.values());
}

/**
 * Отримати кількість активних користувачів
 */
function getActiveUsersCount(hoursAgo = 24) {
  const cutoffTime = new Date();
  cutoffTime.setHours(cutoffTime.getHours() - hoursAgo);
  
  return Array.from(users.values())
    .filter(user => user.lastActivity > cutoffTime)
    .length;
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
  setCurrentModel,
  getCurrentModel,
  getTransactionHistory,
  getUserStats,
  getAllUsers,
  getActiveUsersCount
};
