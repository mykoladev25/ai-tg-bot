/**
 * Monitoring Loggers - логування генерацій та платежів
 *
 * СЛОВНИК:
 * - COGS (Cost of Goods Sold) = Собівартість = скільки ми платимо API за генерацію
 * - Revenue = Дохід = скільки клієнт заплатив нам
 * - Gross Margin = Валовий прибуток = Revenue - COGS (наш заробіток)
 * - Trial Burn = "Згоріло на безкоштовних" = COGS для trial користувачів (ми платимо, вони - ні)
 */

const crypto = require('crypto');
const UsageEvent = require('../database/models/UsageEvent');
const PaymentEvent = require('../database/models/PaymentEvent');
const models = require('../config/models');

// Ціна 1 токена в USD (найгірший випадок з premium плану)
// Потрібна для розрахунку Revenue
const TOKEN_PRICE_USD = 110 / 4760; // ≈ $0.0231 за токен

/**
 * Generate unique request ID
 */
function generateRequestId() {
  return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Get model config by key
 */
function getModelConfig(modelKey) {
  // Search in all categories
  const categories = ['gpt', 'video', 'design', 'audio'];

  for (const cat of categories) {
    const category = models[cat];
    if (!category) continue;

    // Check models array
    if (category.models) {
      const found = category.models.find(m => m.key === modelKey);
      if (found) return { ...found, category: cat };
    }

    // Check actions array (for GPT)
    if (category.actions) {
      const found = category.actions.find(m => m.key === modelKey);
      if (found) return { ...found, category: cat };
    }
  }

  return null;
}

/**
 * Calculate estimated API cost based on model config
 */
function calculateApiCost(modelConfig, options = {}) {
  const { seconds, duration, generateAudio, mode, orientation } = options;

  if (!modelConfig) return 0;

  // Veo - seconds-based with audio/no-audio pricing
  if (modelConfig.key === 'veo') {
    const secs = seconds || duration || modelConfig.minSeconds || 8;
    const costPerSec = generateAudio !== false
      ? modelConfig.apiCostPerSecondAudio
      : modelConfig.apiCostPerSecondNoAudio;
    return (costPerSec || 0.40) * secs;
  }

  // Kling - seconds-based
  if (modelConfig.key === 'kling' || modelConfig.key === 'kling_v2_6') {
    const secs = seconds || duration || 5;
    const useAudio = generateAudio === true;
    const perSec = useAudio
      ? (modelConfig.apiCostPerSecondAudio ?? modelConfig.apiCostPerSecond ?? 0.07)
      : (modelConfig.apiCostPerSecond ?? modelConfig.apiCostPerSecondNoAudio ?? 0.07);
    return perSec * secs;
  }

  // Runway Turbo - seconds-based
  if (modelConfig.key === 'runway_turbo') {
    const secs = seconds || duration || 5;
    return (modelConfig.apiCostPerSecond || modelConfig.apiCost || 0.25) * secs;
  }

  // Kling Motion - mode-based
  if (modelConfig.key === 'kling_motion') {
    const costKey = `${mode || 'std'}_${orientation || 'image'}`;
    return modelConfig.apiCosts?.[costKey] || 0.50;
  }

  // Standard per-generation cost
  return modelConfig.apiCost || 0;
}

/**
 * Calculate token cost based on model config
 */
function calculateTokenCost(modelConfig, options = {}) {
  const { seconds, duration, generateAudio, mode, orientation } = options;

  if (!modelConfig) return 0;

  // Veo
  if (modelConfig.key === 'veo') {
    const secs = seconds || duration || modelConfig.minSeconds || 8;
    const costPerSec = generateAudio !== false
      ? modelConfig.costPerSecondAudio
      : modelConfig.costPerSecondNoAudio;
    return (costPerSec || 28) * secs;
  }

  // Kling
  if (modelConfig.key === 'kling' || modelConfig.key === 'kling_v2_6') {
    const secs = seconds || duration || 5;
    const useAudio = generateAudio === true;
    const perSec = useAudio
      ? (modelConfig.costPerSecondAudio ?? modelConfig.costPerSecond ?? 6)
      : (modelConfig.costPerSecond ?? modelConfig.costPerSecondNoAudio ?? 6);
    return perSec * secs;
  }

  // Runway Turbo
  if (modelConfig.key === 'runway_turbo') {
    const secs = seconds || duration || 5;
    return (modelConfig.costPerSecond || modelConfig.cost || 22) * secs;
  }

  // Kling Motion
  if (modelConfig.key === 'kling_motion') {
    const costKey = `${mode || 'std'}_${orientation || 'image'}`;
    return modelConfig.costs?.[costKey] || 35;
  }

  return modelConfig.cost || 0;
}

/**
 * Log usage event (generation start/completion)
 *
 * @param {Object} payload
 * @param {string} payload.userId - User ID
 * @param {string} payload.modelKey - Model key (e.g., 'nano_banana_2k')
 * @param {boolean} payload.success - Whether generation succeeded
 * @param {Object} [payload.options] - Generation options (seconds, duration, etc.)
 * @param {string} [payload.planAtTime] - User's plan at time of generation
 * @param {boolean} [payload.isTrial] - Is user on trial
 * @param {boolean} [payload.isFree] - Are these free tokens
 * @param {string} [payload.errorCode] - Error code if failed
 * @param {number} [payload.latencyMs] - Request latency
 * @param {string} [payload.requestId] - Request ID for correlation
 * @param {string} [payload.chatId] - Chat ID
 * @param {Object} [payload.metadata] - Additional metadata
 */
async function logUsageEvent(payload) {
  try {
    const {
      userId,
      modelKey,
      success = true,
      options = {},
      planAtTime,
      isTrial = false,
      isFree = false,
      errorCode,
      latencyMs,
      requestId = generateRequestId(),
      chatId,
      metadata = {}
    } = payload;

    const modelConfig = getModelConfig(modelKey);
    const tokensSpent = calculateTokenCost(modelConfig, options);
    const apiCost = calculateApiCost(modelConfig, options);

    // Revenue = 0 for trial/free users
    const estimatedRevenueUSD = (isTrial || isFree) ? 0 : tokensSpent * TOKEN_PRICE_USD;

    const event = new UsageEvent({
      ts: new Date(),
      userId: String(userId),
      chatId: chatId ? String(chatId) : null,
      requestId,
      modelKey,
      modelName: modelConfig?.name || modelKey,
      provider: 'replicate',
      providerModel: null,
      seconds: options.seconds || options.duration || null,
      tokensSpent,
      estimatedRevenueUSD,
      estimatedApiCostUSD: apiCost,
      actualApiCostUSD: null,
      planAtTime,
      isTrial,
      isFree,
      success,
      errorCode: errorCode || null,
      latencyMs: latencyMs || null,
      metadata
    });

    await event.save();

    // 📊 Логуємо простими словами
    const trialLabel = isTrial ? '🆓 TRIAL (безкоштовно)' : '💰 PAID (платний)';
    const successLabel = success ? '✅' : '❌';
    console.log(`
📊 ═══════════════════════════════════════
   ГЕНЕРАЦІЯ ${successLabel}
   ├─ 🤖 Модель: ${modelConfig?.name || modelKey}
   ├─ 👤 Користувач: ${userId} ${trialLabel}
   ├─ ⚡ Токенів списано: ${tokensSpent}
   ├─ 💵 Собівартість (COGS): $${apiCost.toFixed(4)}
   ├─ 💰 Наш дохід: $${estimatedRevenueUSD.toFixed(4)}
   └─ 📈 Прибуток: $${(estimatedRevenueUSD - apiCost).toFixed(4)}
═══════════════════════════════════════
`);

    return { success: true, requestId, event };
  } catch (error) {
    console.error('❌ [Monitor] Помилка логування генерації:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Log payment event
 *
 * @param {Object} payload
 * @param {string} payload.userId - User ID
 * @param {string} payload.provider - Payment provider (wayforpay/liqpay/stars/stripe)
 * @param {string} payload.providerPaymentId - Provider's payment ID
 * @param {string} payload.planKey - Plan key (starter/basic/pro/premium)
 * @param {number} [payload.amountUAH] - Amount in UAH
 * @param {number} [payload.amountUSD] - Amount in USD
 * @param {number} [payload.amountStars] - Amount in Telegram Stars
 * @param {number} payload.tokensGranted - Tokens granted
 * @param {string} payload.status - Payment status
 * @param {Object} [payload.raw] - Raw webhook payload
 */
async function logPaymentEvent(payload) {
  try {
    const {
      userId,
      provider,
      providerPaymentId,
      planKey,
      amountUAH,
      amountUSD,
      amountStars,
      tokensGranted,
      status = 'success',
      raw = {}
    } = payload;

    // Get plan name
    const plan = models.subscriptions[planKey];
    const planName = plan?.name || planKey;

    const result = await PaymentEvent.logPayment({
      ts: new Date(),
      userId: String(userId),
      provider,
      providerPaymentId: String(providerPaymentId),
      planKey,
      planName,
      amountUAH: amountUAH || null,
      amountUSD: amountUSD || null,
      amountStars: amountStars || null,
      tokensGranted,
      status,
      raw
    });

    if (result.isNew) {
      // 💰 Логуємо платіж простими словами
      const providerName = {
        'wayforpay': '💳 WayForPay (картка)',
        'stars': '⭐ Telegram Stars',
        'liqpay': '💳 LiqPay',
        'stripe': '💳 Stripe'
      }[provider] || provider;

      console.log(`
💰 ═══════════════════════════════════════
   НОВИЙ ПЛАТІЖ ✅
   ├─ 👤 Користувач: ${userId}
   ├─ 📦 Пакет: ${planName}
   ├─ 💵 Сума: $${amountUSD || 0} / ${amountUAH || 0} грн
   ├─ ⚡ Токенів нараховано: ${tokensGranted}
   ├─ 🏦 Спосіб: ${providerName}
   └─ 🔖 ID платежу: ${providerPaymentId}
═══════════════════════════════════════
`);
    } else {
      console.log(`⚠️ [Monitor] Платіж вже існує: ${provider}/${providerPaymentId}`);
    }

    return result;
  } catch (error) {
    console.error('❌ [Monitor] Failed to log payment event:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Helper: Determine user's plan from their tokens/subscription
 */
function determinePlan(user) {
  if (!user) return 'trial';

  // If user has subscription info
  if (user.subscription?.plan) {
    return user.subscription.plan.toLowerCase();
  }

  // If user has ever purchased (tokens > 75 initial trial)
  if (user.totalPurchased && user.totalPurchased > 0) {
    return 'paid'; // Generic paid status
  }

  return 'trial';
}

/**
 * Helper: Check if user is on trial (using free tokens)
 */
function isTrialUser(user) {
  if (!user) return true;

  // If user has ever purchased tokens
  if (user.totalPurchased && user.totalPurchased > 0) {
    return false;
  }

  return true;
}

module.exports = {
  generateRequestId,
  logUsageEvent,
  logPaymentEvent,
  getModelConfig,
  calculateApiCost,
  calculateTokenCost,
  determinePlan,
  isTrialUser,
  TOKEN_PRICE_USD
};
