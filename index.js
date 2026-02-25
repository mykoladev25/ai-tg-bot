require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const express = require('express');
const groqWhisper = require('./services/groq-whisper');
const adminNotifier = require('./utils/adminNotifier');

// Імпортуємо сервіси
const claude = require('./services/claude');
const midjourney = require('./services/midjourney');
const replicate = require('./services/replicate');
const kieAI = require('./services/kie-ai');
const geminiImage = require('./services/gemini-image');
const kiePricingSync = require('./services/kie-pricing-sync');
const payment = require('./services/payment');
const exchangeRate = require('./services/exchangeRate');

// Імпортуємо webhooks
const stripeWebhook = require('./webhooks/stripe');

// Імпортуємо моніторинг
const monitoringLoggers = require('./monitoring/loggers');
const monitoringAlerts = require('./monitoring/alerts');
const adminRoutes = require('./admin/routes');
const replicatePricing = require('./services/replicatePricing');

// Імпортуємо утиліти
const keyboard = require('./utils/keyboard');
const userBalance = require('./utils/userBalance');
const blockedUsersUtil = require('./utils/blockedUsers');
const gracefulShutdown = require('./utils/gracefulShutdown');
const providerFallback = require('./utils/providerFallback');
const db = require('./database/connection');
const User = require('./database/models/User');
const GenerationResult = require('./database/models/GenerationResult');

// Імпортуємо конфігурацію
const models = require('./config/models');
const { TRIAL_TOKENS, WORST_CASE_TOKEN_USD } = require('./config/constants');
const accessControl = require('./config/access');

/**
 * Список моделей дизайну з ефективною ціною для кнопок меню (KIE/Replicate за вибором юзера).
 * Фільтрує Midjourney якщо KIE.AI не налаштований (Midjourney доступний тільки через KIE.AI).
 */
function getDesignModelsWithEffectiveCost(userId) {
  if (!models?.design?.models || !Array.isArray(models.design.models)) {
    console.error('❌ models.design.models is not available');
    return [];
  }

  return models.design.models
    .filter(m => {
      // Midjourney та Z-Image доступні тільки якщо KIE.AI налаштований
      if (m.key === 'midjourney' || m.key === 'z_image') {
        return kieAI.isKieAIEnabled;
      }
      // Nano Banana FREE доступна тільки якщо Google Gemini API налаштований
      if (m.key === 'nano_banana_free') {
        return geminiImage.isConfigured;
      }
      return true;
    })
    .map(m => ({
      ...m,
      cost: getEffectiveImageCost(userId, m, m.key)
    }));
}

/** Моделі відео, що доступні тільки через KIE (Kling 3.0, Sora 2). */
const KIE_ONLY_VIDEO_MODELS = ['kling_3', 'sora_2'];


/**
 * Чи може користувач бачити моделі "тільки KIE" (Kling 3.0, Sora 2).
 */
function canSeeKieOnlyVideoModels(userId) {
  if (!accessControl.canUseKieAI(userId) || !kieAI.isKieAIEnabled) return false;
  const choice = userProviderChoice.get(userId);
  return choice !== 'replicate'; // показуємо при kie-ai або auto
}

/** Чи показувати ціну KIE в меню: при виборі KIE або при "auto" + є доступ до KIE. При виборі Replicate — завжди Replicate. */
function useKiePriceForDisplay(userId) {
  const choice = userProviderChoice.get(userId);
  if (choice === 'replicate') return false;
  if (choice === 'kie-ai') return true;
  return accessControl.canUseKieAI(userId) && kieAI.isKieAIEnabled;
}

/**
 * Список відео-моделей для меню з ефективними цінами (KIE/Replicate за провайдером).
 */
function getVideoModelsForUser(userId) {
  const list = canSeeKieOnlyVideoModels(userId)
    ? models.video.models
    : models.video.models.filter(m => !KIE_ONLY_VIDEO_MODELS.includes(m.key));
  return list.map(m => {
    if (m.key === 'veo') {
      return {
        ...m,
        costFast: getEffectiveVeoFlatCost(userId, 'veo3_fast'),
        costQuality: getEffectiveVeoFlatCost(userId, 'veo3'),
        costPerSecondNoAudio: getEffectiveVeoCostPerSecond(userId, false),
        costPerSecondAudio: getEffectiveVeoCostPerSecond(userId, true)
      };
    }
    if (m.key === 'kling') {
      return { ...m, costPerSecond: getEffectiveKlingCostPerSecond(userId) };
    }
    if (m.key === 'kling_v2_6') {
      const model = m;
      return {
        ...m,
        costPerSecond: getEffectiveKlingV2_6CostPerSecond(userId, model, false),
        costPerSecondAudio: getEffectiveKlingV2_6CostPerSecond(userId, model, true)
      };
    }
    if (m.key === 'kling_motion') {
      const costs = getEffectiveKlingMotionCosts(userId);
      const vals = Object.values(costs);
      return {
        ...m,
        costs,
        cost: Math.min(...vals),
        maxCost: Math.max(...vals)
      };
    }
    if (m.key === 'kling_3') {
      return {
        ...m,
        costPerSecondNoAudio: getEffectiveKling3CostPerSecond(userId, 'pro', false),
        costPerSecondAudio: getEffectiveKling3CostPerSecond(userId, 'pro', true)
      };
    }
    if (m.key === 'runway_turbo') {
      const costPerSecond = getEffectiveRunwayTurboCostPerSecond(userId);
      const durations = m.durations || [5];
      const minD = Math.min(...durations);
      return {
        ...m,
        costPerSecond,
        cost: minD * costPerSecond
      };
    }
    if (m.key === 'sora_2') {
      const durations = m.durations || [4, 8, 12];
      const minCost = Math.min(...durations.map(d => getEffectiveSora2Cost(userId, m, d)));
      return { ...m, cost: minCost };
    }
    if (m.key === 'kling_o1_edit') {
      // Для редагування відео: ціна залежить від mode та наявності відео-input
      // Показуємо мінімальну ціну (std без відео-input)
      const durations = m.durations || [3, 5, 7, 10];
      const minDuration = Math.min(...durations);
      return {
        ...m,
        cost: minDuration * m.costPerSecond,  // std без відео-input
        maxCost: Math.max(...durations) * m.costPerSecondProWithVideo  // pro з відео-input
      };
    }
    if (m.key === 'a2e_motion') {
      // A2E: показуємо мінімальну та максимальну ціну залежно від тривалості
      const durations = m.durations || [5, 10, 15, 20];
      const minDuration = Math.min(...durations);
      const maxDuration = Math.max(...durations);
      return {
        ...m,
        cost: minDuration * m.costPerSecond,
        maxCost: maxDuration * m.costPerSecond
      };
    }
    return m;
  });
}

/**
 * Ціна за обраним провайдером: KIE → ціна KIE, Replicate → Replicate.
 * Якщо обрано KIE, але в KIE немає реалізації для моделі — ціна Replicate і запуск Replicate.
 */
function getEffectiveImageCost(userId, model, modelKey) {
  if (!useKiePriceForDisplay(userId)) return model.cost;
  if (!kieAI.isKieAIImplemented(modelKey)) return model.cost;

  try {
    const kieCost = kiePricingSync.getKieTokenCostSync(modelKey);
    return typeof kieCost === 'number' ? kieCost : model.cost;
  } catch (error) {
    console.warn(`⚠️ Could not get KIE price for ${modelKey}, using fallback:`, error.message);
    return model.cost;
  }
}

/**
 * Ціна за обраним провайдером; якщо KIE без реалізації — Replicate.
 */
function getEffectiveKlingV2_6CostPerSecond(userId, model, withAudio) {
  if (!useKiePriceForDisplay(userId)) {
    return withAudio ? (model?.costPerSecondAudio ?? model?.costPerSecond ?? 6) : (model?.costPerSecond ?? model?.costPerSecondNoAudio ?? 6);
  }
  if (!kieAI.isKieAIImplemented('kling_v2_6')) {
    return withAudio ? (model?.costPerSecondAudio ?? 6) : (model?.costPerSecondNoAudio ?? model?.costPerSecond ?? 6);
  }
  const k = kiePricingSync.getKieTokenCostSync('kling_v2_6');
  if (!k || typeof k !== 'object') {
    return withAudio ? (model?.costPerSecondAudio ?? 6) : (model?.costPerSecondNoAudio ?? model?.costPerSecond ?? 6);
  }
  const v = withAudio ? (k.costPerSecondAudio ?? model?.costPerSecondAudio) : (k.costPerSecondNoAudio ?? model?.costPerSecondNoAudio ?? model?.costPerSecond);
  return v ?? (withAudio ? 6 : 6);
}

/**
 * Ціна Veo — flat per-video (токени за одне відео).
 * @param {number} userId
 * @param {string} veoModel - 'veo3_fast' або 'veo3'
 * @returns {number} вартість у токенах
 */
function getEffectiveVeoFlatCost(userId, veoModel = 'veo3_fast') {
  const model = models.video.models.find(m => m.key === 'veo');
  const isQuality = veoModel === 'veo3';
  const fallback = isQuality ? (model?.costQuality ?? 208) : (model?.costFast ?? 50);
  if (!useKiePriceForDisplay(userId)) return fallback;
  if (!kieAI.isKieAIImplemented('veo')) return fallback;
  const k = kiePricingSync.getKieTokenCostSync('veo');
  if (!k || typeof k !== 'object') return fallback;
  return isQuality ? (k.costQuality ?? fallback) : (k.costFast ?? fallback);
}

/**
 * API cost Veo (USD) — flat per-video.
 */
function getVeoApiCostUSD(veoModel = 'veo3_fast') {
  const model = models.video.models.find(m => m.key === 'veo');
  return veoModel === 'veo3' ? (model?.apiCostQuality ?? 1.25) : (model?.apiCostFast ?? 0.30);
}

/**
 * Legacy: Ціна Veo per-second (для /api/plans backward compat).
 */
function getEffectiveVeoCostPerSecond(userId, withAudio) {
  const model = models.video.models.find(m => m.key === 'veo');
  const fallbackNo = model?.costPerSecondNoAudio ?? 33;
  const fallbackAud = model?.costPerSecondAudio ?? 66;
  if (!useKiePriceForDisplay(userId)) return withAudio ? fallbackAud : fallbackNo;
  if (!kieAI.isKieAIImplemented('veo')) return withAudio ? fallbackAud : fallbackNo;
  const k = kiePricingSync.getKieTokenCostSync('veo');
  if (!k || typeof k !== 'object') return withAudio ? fallbackAud : fallbackNo;
  return withAudio ? (k.costPerSecondAudio ?? fallbackAud) : (k.costPerSecondNoAudio ?? fallbackNo);
}

/**
 * Ціна Kling 2.5 за обраним провайдером (токенів за секунду).
 */
function getEffectiveKlingCostPerSecond(userId) {
  const model = models.video.models.find(m => m.key === 'kling');
  const fallback = model?.costPerSecond ?? 12;
  if (!useKiePriceForDisplay(userId)) return fallback;
  if (!kieAI.isKieAIImplemented('kling')) return fallback;
  const k = kiePricingSync.getKieTokenCostSync('kling');
  if (!k || typeof k !== 'object' || typeof k.costPerSecond !== 'number') return fallback;
  return k.costPerSecond;
}

/**
 * Ціна Runway Turbo за обраним провайдером: токени за секунду або за run.
 */
function getEffectiveRunwayTurboCostPerSecond(userId) {
  const model = models.video.models.find(m => m.key === 'runway_turbo');
  const fallback = model?.costPerSecond ?? 9;
  if (!useKiePriceForDisplay(userId)) return fallback;
  if (!kieAI.isKieAIImplemented('runway_turbo')) return fallback;
  const k = kiePricingSync.getKieTokenCostSync('runway_turbo', { duration: 5 });
  if (!k || typeof k !== 'object' || typeof k.costPerSecond !== 'number') return fallback;
  return k.costPerSecond;
}

/**
 * Ціна Kling Motion за обраним провайдером: { std_image, std_video, pro_image, pro_video }.
 */
function getEffectiveKlingMotionCosts(userId) {
  const model = models.video.models.find(m => m.key === 'kling_motion');
  const fallback = model?.costs ?? { std_image: 83, std_video: 165, pro_image: 165, pro_video: 330 };
  if (!useKiePriceForDisplay(userId)) return fallback;
  if (!kieAI.isKieAIImplemented('kling_motion')) return fallback;
  const k = kiePricingSync.getKieTokenCostSync('kling_motion');
  if (!k || typeof k !== 'object' || !k.costs) return fallback;
  return k.costs;
}

/**
 * Ціна Kling 3.0 за обраним провайдером (токенів за секунду; mode: 'std'|'pro').
 */
function getEffectiveKling3CostPerSecond(userId, mode, withAudio) {
  const model = models.video.models.find(m => m.key === 'kling_3');
  const fallbackNo = model?.costPerSecondNoAudio ?? 23;
  const fallbackAud = model?.costPerSecondAudio ?? 45;
  if (!useKiePriceForDisplay(userId)) return withAudio ? fallbackAud : fallbackNo;
  if (!kieAI.isKieAIImplemented('kling_3')) return withAudio ? fallbackAud : fallbackNo;
  const r = kiePricingSync.getKling3TokenCostPerSecondSync({ mode: mode || 'pro' });
  if (!r) return withAudio ? fallbackAud : fallbackNo;
  return withAudio ? (r.costPerSecondAudio ?? fallbackAud) : (r.costPerSecondNoAudio ?? fallbackNo);
}

/**
 * Ціна за обраним провайдером; якщо KIE без реалізації (напр. Sora) — Replicate ціна і запуск Replicate.
 */
function getEffectiveSora2Cost(userId, model, duration = 15, options = {}) {
  if (!useKiePriceForDisplay(userId)) {
    return Math.ceil(duration * (model?.costPerSecond || 0));
  }
  if (!kieAI.isKieAIImplemented('sora_2')) {
    return Math.ceil(duration * (model?.costPerSecond || 0));
  }
  const soraType = options.soraType || (duration >= 15 ? 'text_to_video_15s' : duration >= 10 ? 'image_to_video_10s' : null);
  if (soraType) {
    const k = kiePricingSync.getKieTokenCostSync('sora_2', { soraType });
    if (k && typeof k === 'object' && typeof k.cost === 'number') return k.cost;
  }
  return Math.ceil(duration * (model?.costPerSecond || 0));
}

// Ініціалізація бота
const bot = new Telegraf(process.env.BOT_TOKEN);

const isDevelopment = false;
const isShowBroadCast = process.env.SEND_STARTUP_BROADCAST === 'true' && false;

// ==================== DATA STORAGE ====================
// Для збирання feedback від користувачів
const feedbackData = new Map(); // userId -> { type, message, timestamp }

// Чернетки розсилок (адмін)
const broadcastDrafts = new Map(); // adminId -> { type, text?, caption?, fileId?, parseMode? }
const broadcastStates = new Map(); // adminId -> { step: 'awaiting_content', parseMode }

// Стан генерації зображень (новий флоу)
// userId -> { model: string, prompt?: string, photos?: Array, step: 'waiting_photos'|'prompt' }
const imageGenState = new Map();

// Вибір провайдера для користувачів (тільки для адміна поки що)
// userId -> 'replicate' | 'kie-ai'
const userProviderChoice = new Map();
const PROVIDER_CHOICE_FILE = path.join(__dirname, 'config', 'provider-choice.json');

function loadProviderChoice() {
  try {
    if (fs.existsSync(PROVIDER_CHOICE_FILE)) {
      const raw = fs.readFileSync(PROVIDER_CHOICE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        for (const [uid, choice] of Object.entries(data)) {
          if (choice === 'kie-ai' || choice === 'replicate') userProviderChoice.set(Number(uid), choice);
        }
      }
    }
  } catch (e) {
    console.warn('Provider choice load failed:', e.message);
  }
}

function saveProviderChoice() {
  try {
    const data = {};
    for (const [uid, choice] of userProviderChoice) data[String(uid)] = choice;
    fs.writeFileSync(PROVIDER_CHOICE_FILE, JSON.stringify(data, null, 0), 'utf8');
  } catch (e) {
    console.warn('Provider choice save failed:', e.message);
  }
}

loadProviderChoice();

// Rate limiting для заблокованих користувачів (щоб не спамили)
const blockedUserLastNotified = new Map(); // userId -> timestamp
const BLOCKED_USER_COOLDOWN = 5 * 60 * 1000; // 5 хвилин між повідомленнями

const WELCOME_MODAL_TEXT = [
  'Всі топові нейромережі в одному місці!',
  'Стань АІ-креатором разом з нами.',
  'Курс по АІ: https://neurolab.fun/'
].join('\n');

const WELCOME_START_BUTTON_TEXT = '✨ Start ✨';

let cachedBotAvatarFileId = null;
let cachedBotId = null;

/**
 * Перевіряє чи можна надіслати повідомлення заблокованому користувачу
 * Повертає true якщо можна, false якщо ще рано (cooldown)
 */
function canNotifyBlockedUser(userId) {
  const lastNotified = blockedUserLastNotified.get(userId);
  const now = Date.now();

  if (!lastNotified || (now - lastNotified) > BLOCKED_USER_COOLDOWN) {
    blockedUserLastNotified.set(userId, now);
    return true;
  }
  return false;
}

async function getBotAvatarFileId() {
  if (cachedBotAvatarFileId) return cachedBotAvatarFileId;

  try {
    if (!cachedBotId) {
      const botInfo = await bot.telegram.getMe();
      cachedBotId = botInfo?.id || null;
    }

    if (!cachedBotId) return null;

    const photos = await bot.telegram.getUserProfilePhotos(cachedBotId, 0, 1);
    const avatar = photos?.photos?.[0]?.[0];
    if (!avatar?.file_id) return null;

    cachedBotAvatarFileId = avatar.file_id;
    return cachedBotAvatarFileId;
  } catch (error) {
    console.warn('⚠️ Could not fetch bot avatar:', error.message);
    return null;
  }
}

function buildWelcomeStartKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(WELCOME_START_BUTTON_TEXT, 'welcome_start')]
  ]);
}

async function sendWelcomeModal(ctx) {
  const keyboardMarkup = buildWelcomeStartKeyboard();
  const caption = WELCOME_MODAL_TEXT;

  try {
    const avatarFileId = await getBotAvatarFileId();
    if (avatarFileId) {
      await ctx.replyWithPhoto(avatarFileId, {
        caption,
        ...keyboardMarkup
      });
      return;
    }
  } catch (error) {
    console.warn('⚠️ Failed to send welcome photo:', error.message);
  }

  await ctx.reply(caption, {
    ...keyboardMarkup,
    disable_web_page_preview: true
  });
}

function buildMainMenuMessage(ctx, user) {
  const firstName = ctx.from?.first_name || 'друг';
  const balance = Number.isFinite(user?.tokens) ? user.tokens.toFixed(2) : '0.00';

  return `🏠 Головне меню

Привіт, ${firstName}!

Я neuro\u200B.lab\u200B.ai - ваш помічник з AI генерації.

💰 Ваш баланс: ${balance}⚡ FREE

Виберіть бажаний розділ 👇`;
}

async function sendMainMenu(ctx, user) {
  await ctx.reply(buildMainMenuMessage(ctx, user), keyboard.createMainMenu());
}

function runBackgroundTask(task, label = 'task') {
  Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error(`❌ Background task failed (${label}):`, error);
    });
}

// ==================== TRIAL RESTRICTIONS ====================
const { TRIAL_RESTRICTIONS } = models;

function getVideoMinCostTokens(model) {
  if (!model) return null;

  // Seconds-based (Kling)
  if (model.costPerSecond) {
    const durations = model.durations?.length ? model.durations : [5];
    const minDuration = Math.min(...durations);
    const perSec = model.costPerSecond ?? 0;
    return minDuration * perSec;
  }

  // Veo (audio/no-audio)
  if (model.costPerSecondAudio || model.costPerSecondNoAudio) {
    const durations = model.durations?.length ? model.durations : [4];
    const minDuration = model.minSeconds || Math.min(...durations);
    const perSec = Math.min(
      model.costPerSecondNoAudio ?? Number.POSITIVE_INFINITY,
      model.costPerSecondAudio ?? Number.POSITIVE_INFINITY
    );
    if (!Number.isFinite(perSec)) return null;
    return minDuration * perSec;
  }

  // Multi-mode models (Kling Motion)
  if (model.costs) {
    const values = Object.values(model.costs);
    return values.length ? Math.min(...values) : null;
  }

  // Fixed cost
  if (model.cost) return model.cost;

  return null;
}

function buildDynamicTrialBlockedModels(trialTokens) {
  const blocked = new Set(TRIAL_RESTRICTIONS.blockedModels);

  // Design models: block if not affordable
  models.design.models
    .filter(m => m.available)
    .forEach((m) => {
      if (m.cost && m.cost > trialTokens) blocked.add(m.key);
    });

  // Video models: block if min cost not affordable
  models.video.models
    .filter(m => m.available || TRIAL_RESTRICTIONS.blockedModels.includes(m.key))
    .forEach((m) => {
      const minCost = getVideoMinCostTokens(m);
      if (minCost && minCost > trialTokens) blocked.add(m.key);
    });

  return blocked;
}

/**
 * Перевіряє чи користувач на Trial (не робив покупок)
 */
async function isTrialUser(userId) {
  try {
    const user = await userBalance.getUser(userId);
    // Trial = користувач НЕ має жодної покупки (totalTokensPurchased = 0)
    return user.totalTokensPurchased === 0;
  } catch (e) {
    return true; // За замовчуванням вважаємо Trial
  }
}

/**
 * Записує Trial usage в базу даних
 */
async function recordTrialUsage(userId, modelKey) {
  try {
    const User = require('./database/models/User');
    await User.findByIdAndUpdate(userId, {
      $inc: { [`trialUsage.${modelKey}`]: 1 }
    });
    console.log(`📊 Trial usage recorded: user ${userId}, model ${modelKey}`);
  } catch (e) {
    console.error('Error recording trial usage:', e.message);
  }
}

/**
 * Перевіряє Trial обмеження для моделі
 * @returns {object} { allowed: boolean, message?: string }
 */
async function checkTrialRestrictions(userId, modelKey, options = {}) {
  // Trial = без покупок. Але якщо баланс >= початкового (15⚡), дозволяємо доступ.
  const trialTokens = TRIAL_TOKENS;
  let user;
  try {
    user = await userBalance.getUser(userId);
  } catch (e) {
    return { allowed: true };
  }

  const isTrial = (user?.totalTokensPurchased || 0) === 0;
  const hasMinTrialBalance = (user?.tokens || 0) >= trialTokens;

  if (!isTrial || hasMinTrialBalance) {
    return { allowed: true }; // Платний або має >= початкового балансу
  }

  // 1. Перевірка повністю заблокованих моделей
  if (TRIAL_RESTRICTIONS.blockedModels.includes(modelKey)) {
    return {
      allowed: false,
      message: TRIAL_RESTRICTIONS.messages.blocked
    };
  }

  // 2. Перевірка заблокованих режимів (наприклад, тривалість)
  const blockedModes = TRIAL_RESTRICTIONS.blockedModes[modelKey];
  if (blockedModes) {
    // Перевірка тривалості для Kling
    if (blockedModes.durations && options.duration) {
      if (blockedModes.durations.includes(options.duration)) {
        return {
          allowed: false,
          message: TRIAL_RESTRICTIONS.messages.durationBlocked
        };
      }
    }
  }

  return { allowed: true };
}

// ✅ ГРАФІЧНІ МОДЕЛІ ДЛЯ НОВОГО ФЛОУ (референси → промпт → генерація)
const IMAGE_MODELS = [
  'stable_diffusion',
  'nano_banana',
  'nano_banana_free',
  'nano_banana_2k',
  'nano_banana_4k',
  'seedream_4k',
  'ideogram',
  'z_image',
  'clarity',
  'recraft_upscale'
];

// ✅ МОДЕЛІ КОТРІ ПІДТРИМУЮТЬ ВИБІР ASPECT RATIO
const MODELS_WITH_ASPECT_RATIO = [
  'nano_banana',
  'nano_banana_free',
  'nano_banana_2k',
  'nano_banana_4k',
  'seedream_4k',
  'stable_diffusion',
  'ideogram',
  'z_image'
];

// ✅ МАСИВ МОДЕЛЕЙ З БАГАТОКРОКОВИМ ПРОЦЕСОМ
const MODELS_WITH_STATE = [
  'kling',                  // duration + aspect + start_image + end_image
  'kling_v2_6',             // duration + aspect + start_image (no end_image)
  'kling_motion',           // mode + orientation + sound + фото + відео
  'veo',                    // aspect ratio + prompt + last_frame + start_image
  'sora_2',                 // duration + aspect ratio + optional reference + prompt
  'nano_banana_pro',        // вибір розміру (майбутнє)
  ...MODELS_WITH_ASPECT_RATIO // добавляємо моделі з вибором aspect ratio
];

const ASPECT_RATIO_OPTIONS = {
  seedream_4k: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', 'match_input_image'],
  nano_banana: ['match_input_image', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  nano_banana_free: ['match_input_image', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  nano_banana_2k: ['match_input_image', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  nano_banana_4k: ['match_input_image', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  stable_diffusion: ['1:1', '16:9', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21'],
  ideogram: ['1:3', '3:1', '1:2', '2:1', '9:16', '16:9', '10:16', '16:10', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '1:1'],
  z_image: ['1:1', '4:3', '3:4', '16:9', '9:16']
};

const ASPECT_RATIO_LABELS = {
  '1:1': '📐 1:1 (Square)',
  '1:2': '📱 1:2 (Portrait)',
  '2:1': '🖼️ 2:1 (Wide)',
  '1:3': '📱 1:3 (Tall)',
  '3:1': '🖼️ 3:1 (Panorama)',
  '4:5': '📱 4:5 (Portrait)',
  '5:4': '🖼️ 5:4 (Classic Landscape)',
  '4:3': '🎬 4:3 (Landscape)',
  '3:4': '📱 3:4 (Portrait)',
  '16:9': '🎥 16:9 (Widescreen)',
  '9:16': '📱 9:16 (Vertical)',
  '10:16': '📱 10:16 (Vertical)',
  '16:10': '🖼️ 16:10 (Wide)',
  '3:2': '🖼️ 3:2 (Classic)',
  '2:3': '🖼️ 2:3 (Classic Portrait)',
  '21:9': '🎬 21:9 (Ultrawide)',
  '9:21': '📱 9:21 (Vertical)',
  'match_input_image': 'Авто'
};

const RATIO_NOTES = {
  '9:16': 'Вертикальний формат для Instagram Stories/Reels та TikTok.',
  '21:9': 'Ультраширокі кадри, добре для кінематографічних сцен.',
  '16:9': 'Горизонтальний widescreen (YouTube, презентації).'
};

const TEXT_ASPECT_RATIO_MODELS = new Set([
  'nano_banana',
  'nano_banana_free',
  'nano_banana_2k',
  'nano_banana_4k',
  'seedream_4k',
  'ideogram',
  'stable_diffusion',
  'z_image'
]);

function getAspectRatiosForModel(modelKey, hasImageInput = true) {
  const ratios = ASPECT_RATIO_OPTIONS[modelKey] || ['1:1', 'match_input_image'];
  return ratios.filter(ratio => ratio !== 'match_input_image');
}

function buildAspectRatioKeyboard(modelKey, hasImageInput = true) {
  const ratios = getAspectRatiosForModel(modelKey, hasImageInput);
  const buttons = ratios.map(ratio => [
    Markup.button.callback(ASPECT_RATIO_LABELS[ratio] || ratio, `aspect_ratio_${modelKey}_${ratio}`)
  ]);
  buttons.push([Markup.button.callback('🔙 Назад', 'design_menu')]);
  return { keyboard: Markup.inlineKeyboard(buttons), ratios };
}

async function promptAspectRatioSelection(ctx, { modelKey, promptText, hasReferences = false, referencesCount = 0 }) {
  const { keyboard: aspectRatioMenu, ratios: validRatios } = buildAspectRatioKeyboard(modelKey, hasReferences);
  const ratioNotes = validRatios
    .map(ratio => RATIO_NOTES[ratio])
    .filter(Boolean);
  const notesBlock = ratioNotes.length
    ? `\n\nПримітки:\n${ratioNotes.map((note, index) => `${index + 1}. ${note}`).join('\n')}`
    : '';
  const referenceLine = hasReferences
    ? `\n📸 Референси: ${referencesCount} фото\n`
    : '';
  const promptPreview = promptText.length > 100 ? promptText.substring(0, 100) + '...' : promptText;

  await ctx.reply(
    `✅ <b>Промпт збережено!</b>\n\n` +
    `📝 "${promptPreview}"\n\n` +
    `📐 <b>Оберіть пропорції зображення (Aspect Ratio)</b>\n\n` +
    `📝 Крок 1: ваша ідея/промпт\n` +
    `📐 Крок 2: вибір пропорцій\n` +
    `✍️ Крок 3: генерація запускається одразу після вибору\n\n` +
    `${referenceLine}` +
    `Доступні формати: ${validRatios.join(', ')}${notesBlock}`,
    { parse_mode: 'HTML', ...aspectRatioMenu }
  );
}

// ✅ MIDDLEWARE: обнуляти стан при callback (крім моделей зі станами)
bot.on('callback_query', async (ctx, next) => {
  const callbackData = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);
  
  // ✅ ДОЗВОЛЯЄМО ASPECT RATIO CALLBACKS
  if (callbackData.startsWith('aspect_ratio_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО IMG GENERATION CALLBACKS (референси/промпт)
  if (callbackData.startsWith('img_gen_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО VEO CALLBACKS
  if (callbackData.startsWith('veo_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО SORA CALLBACKS
  if (callbackData.startsWith('sora_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО KLING CALLBACKS
  if (callbackData.startsWith('kling_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО KLING MOTION CALLBACKS
  if (callbackData.startsWith('motion_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО RUNWAY TURBO CALLBACKS
  if (callbackData.startsWith('runway_turbo_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО A2E MOTION CALLBACKS
  if (callbackData.startsWith('a2e_')) {
    return next();
  }

  if (MODELS_WITH_STATE.includes(callbackData)) {
    return next();
  }
  
  if (MODELS_WITH_STATE.includes(currentModel) && state) {
    const allowedNavigation = ['video_menu', 'design_menu', 'audio_menu', 'main_menu'];
    if (allowedNavigation.includes(callbackData)) {
      return next();
    }
  }
  
  // ✅ Дозволяємо veo state
  if (state?.action === 'veo_generation') {
    return next();
  }

  // ✅ Дозволяємо kling state
  if (state?.action === 'kling_generation') {
    return next();
  }

  // ✅ Дозволяємо kling_motion state
  if (state?.action === 'kling_motion_generation') {
    return next();
  }

  // ✅ Дозволяємо runway turbo state
  if (state?.action === 'runway_turbo_generation') {
    return next();
  }

  // ✅ Дозволяємо kling_3 state
  if (state?.action === 'kling_3_generation') {
    return next();
  }

  // ✅ Дозволяємо a2e_motion state
  if (state?.action === 'a2e_motion_generation') {
    return next();
  }

  // ✅ Дозволяємо kling_o1_edit state
  if (state?.action === 'kling_o1_edit_generation') {
    return next();
  }

  // ✅ Дозволяємо midjourney state
  if (state?.action === 'midjourney_generation') {
    return next();
  }

  userCurrentModel.delete(userId);
  userState.delete(userId);
  
  return next();
});

// ==================== FEEDBACK HANDLER ====================

// Обробник для текстового feedback
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Якщо користувач заповнює feedback
  if (feedbackData.has(userId) && !text.startsWith('/')) {
    const feedback = feedbackData.get(userId);

    if (text.length > 1000) {
      await ctx.reply('⚠️ Занадто довгий текст! Максимум 1000 символів.');
      return;
    }

    await sendFeedbackToAdmin(feedback, text, ctx);
    feedbackData.delete(userId);
    return;
  }

  // Перевіряємо чи користувач заблокований
  const isBlocked = await blockedUsersUtil.isUserBlocked(userId);
  if (isBlocked) {
    // Rate limit - відповідаємо тільки раз на 5 хвилин
    if (canNotifyBlockedUser(userId)) {
      await ctx.reply('🚫 Ви були заблоковані та не можете користуватися цим ботом.');
    }
    return;
  }

  return next();
});

// Обробник для зображень/фото у feedback
bot.on(['photo', 'document'], async (ctx, next) => {
  const userId = ctx.from.id;

  // Якщо користувач заповнює feedback та надсилає фото/документ
  if (feedbackData.has(userId)) {
    const feedback = feedbackData.get(userId);

    // Отримуємо caption як текст feedback
    const text = ctx.message.caption || '[Скрін з помилкою/проблемою]';

    if (text.length > 1000) {
      await ctx.reply('⚠️ Занадто довгий текст! Максимум 1000 символів.');
      return;
    }

    // Отримуємо ID зображення для пересилання
    let fileId = null;
    if (ctx.message.photo) {
      // Беремо найбільше фото
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
    }

    await sendFeedbackToAdmin(feedback, text, ctx, fileId);
    feedbackData.delete(userId);
    return;
  }

  return next();
});

// Допоміжна функція для відправки feedback адміну
async function sendFeedbackToAdmin(feedback, text, ctx, fileId = null) {
  feedback.message = text;
  feedback.timestamp = new Date();

  // Відправляємо feedback усім адмінам
  const adminIds = accessControl.getAdminIds();
  if (adminIds.length > 0) {
    // Формуємо рядок з username - показуємо тільки якщо він є
    const usernameDisplay = feedback.username && feedback.username !== 'unknown'
      ? `@${feedback.username}`
      : '(без username)';

    const adminMessage = `📨 <b>Новий ${feedback.typeName.toLowerCase()}</b>

👤 Від: ${usernameDisplay} | ${feedback.firstName}
🆔 ID: ${feedback.userId}
⏰ ${feedback.timestamp.toLocaleString('uk-UA')}

📝 <b>Текст:</b>
${feedback.message}`;

    const adminKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Прийняти', `feedback_confirm_${feedback.userId}`)],
      [Markup.button.callback('❌ Відхилити', `feedback_decline_${feedback.userId}`)],
      [Markup.button.callback('🚫 Заблокувати', `feedback_block_${feedback.userId}`)]
    ]);

    try {
      for (const adminId of adminIds) {
        if (fileId) {
          if (ctx.message.photo) {
            await bot.telegram.sendPhoto(adminId, fileId, {
              caption: adminMessage,
              parse_mode: 'HTML',
              reply_markup: adminKeyboard.reply_markup
            });
          } else if (ctx.message.document) {
            await bot.telegram.sendDocument(adminId, fileId, {
              caption: adminMessage,
              parse_mode: 'HTML',
              reply_markup: adminKeyboard.reply_markup
            });
          }
        } else {
          await bot.telegram.sendMessage(adminId, adminMessage, {
            parse_mode: 'HTML',
            ...adminKeyboard
          });
        }
      }
    } catch (error) {
      console.error('❌ Error sending feedback to admin:', error.message);
    }
  }

  // Відповідаємо користувачу
  await ctx.reply(
    `✅ <b>Дякуємо за ваш ${feedback.typeName.toLowerCase()}!</b>

Ми отримали ваше звернення и розглянемо його найближчим часом.`,
    { parse_mode: 'HTML', ...keyboard.createMainMenu() }
  );
}

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  // Перевіряємо чи користувач заблокований
  const isBlocked = await blockedUsersUtil.isUserBlocked(userId);
  if (isBlocked) {
    // Rate limit - відповідаємо тільки раз на 5 хвилин
    if (canNotifyBlockedUser(userId)) {
      await ctx.reply('🚫 Ви були заблоковані та не можете користуватися цим ботом.');
    }
    return;
  }

  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);
  
  // Кнопки головного меню (обнуляють стан) - тільки короткі версії
  const menuButtons = [
    '🧠 Помічники',
    '🎨 Креативи',
    '🎬 Відео',
    '🖼️ Зображення',
    '👤 Профіль',
    '💰 Поповнити баланс',
    '📝 Feedback',
    '❓ Допомога'
  ];
  
  // Якщо натиснута кнопка меню - обнуляємо
  if (menuButtons.includes(text)) {
    userCurrentModel.delete(userId);
    userState.delete(userId);
  }
  
  // Якщо звичайний текст (промпт) - НЕ обнуляємо, передаємо далі
  return next();
});

if (isDevelopment) {
  console.log('🛠️ Development mode - maintenance message enabled');
  
  bot.use(async (ctx, next) => {
    if (accessControl.isAdmin(ctx.from.id)) {
      console.log(`✅ Admin ${ctx.from.id} bypassed maintenance`);
      return next();
    }
    
    await ctx.reply(
      '🛠️ Бот тимчасово недоступний\n\n' +
      '⚙️ Триває технічне обслуговування\n' +
      '⏰ Очікуваний час: ~30 хвилин\n\n' +
      'Спробуйте пізніше! Дякуємо за розуміння 🙏'
    );
    
    console.log(`🚫 Blocked user ${ctx.from.id} (@${ctx.from.username}) during maintenance`);
  });
}

const userCurrentModel = new Map();
const userState = new Map();
const mediaGroups = new Map();

const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '@nnn_ddddddd';

const INSTRUCTION_HTML = `
📄 <b>ІНСТРУКЦІЯ</b>

📝 <b>Як користуватися ботом:</b>

<b>1️⃣ Базові помічники (Claude AI)</b>
- <b>✍️ Текст:</b> напишіть запит → отримайте відповідь
- <b>🎙️ Голос:</b> надішліть голосове → AI розпізнає і відповість
- <b>🖼️ Аналіз фото:</b> надішліть зображення → AI опише/проаналізує

<b>2️⃣ Генерація зображень</b>
- Оберіть модель (<i>Nano Banana, Seedream, Ideogram тощо</i>)
- Опишіть що хочете побачити (промпт)
- Можна додати до 14 референс-фото!
- Очікуйте результат <i>(~20–60 сек)</i>

<b>3️⃣ Генерація відео</b>
- Оберіть модель (<i>Kling, Kling 3.0, Veo, Runway тощо</i>).
- <b>Kling 3.0</b>: після вибору моделі з’явиться покрокова підказка — режим якості, тривалість, формат відео, звук, опційно фото як перший кадр, потім текстовий опис відео. Просто йдіть кроками і вводьте те, що просить бот.
- Інші моделі: налаштуйте параметри та надішліть опис або фото.
- Відео буде готове <i>за 1–5 хвилин</i>.

💰 <b>Токени ⚡</b>
- <b>Кожна генерація списує токени</b>
- 🎁 <b>Безкоштовно:</b> 15⚡ при реєстрації
- 💎 Далі — можна поповнити баланс
- 📉 <b>Чим більший пакет — тим вигідніше!</b>

<i>⚡ Вартість вказана біля кожної моделі</i>

📜 <b>Політика білінгу</b>

- Бот використовує сторонні AI-сервіси
  <i>(Replicate, Google, Runway тощо)</i>

- <b>Ви купуєте внутрішні токени ⚡</b>, а не прямий API-доступ

- <b>Токени списуються за кожну AI-дію</b>

⚠️ <b>Важливо:</b>
- <b>Генерація може не відповідати очікуванням</b> — це особливість AI
- <b>Повернення токенів за виконані дії не передбачено</b>

🔥 <b>⚠️ ЗАВЖДИ ЗАВАНТАЖУЙТЕ ОДРАЗУ! ⚠️</b>
<b>Великі файли (>10MB) активні ТІЛЬКИ 1 ГОДИНУ!</b>
Звичайні фото/відео Telegram зберігає автоматично.

📥 <b>Як зберегти результат:</b>
1️⃣ Натисніть на згенерований файл
2️⃣ Натисніть меню ⋮ або утримуйте палець
3️⃣ Оберіть "Зберегти" / "Завантажити"

📋 <b>Юридична інформація:</b>
Перед оплатою ознайомтесь з нашими документами:
- Угода користувача
- Політика приватності

Введіть команду <i>/info</i> для перегляду юридичної інформації.

ℹ️ Використовуючи бота, ви погоджуєтеся з умовами обслуговування.
`;

// ==================== КОМАНДИ ====================

bot.start(async (ctx) => {
  const userId = ctx.from.id;

  // Перевіряємо чи користувач заблокований
  const isBlocked = await blockedUsersUtil.isUserBlocked(userId);
  if (isBlocked) {
    // Rate limit - відповідаємо тільки раз на 5 хвилин
    if (canNotifyBlockedUser(userId)) {
      await ctx.reply('🚫 Ви були заблоковані та не можете користуватися цим ботом.');
    }
    return;
  }

  let isNewUser = false;
  try {
    const existingUser = await User.findById(userId);
    isNewUser = !existingUser;
  } catch (error) {
    console.warn('⚠️ Could not check user existence:', error.message);
  }

  const user = await userBalance.getUser(userId, ctx.from);

  if (isNewUser) {
    await sendWelcomeModal(ctx);
    return;
  }

  await sendMainMenu(ctx, user);
});

bot.command('help', async (ctx) => {
  const helpText = `❓ Допомога

🤖 Доступні команди:
/start - Головне меню
/profile - Ваш профіль
/balance - Перевірити баланс
/history - Історія використання
/clear - Очистити історію розмови
/feedback - Форма зворотнього зв'язку
/instruction - Інструкція
/info - Юридична інформація та угода користувача
/help - Ця довідка

💡 Як користуватися:
1. Виберіть розділ у головному меню
2. Оберіть модель для генерації
3. Надішліть текстовий запит
4. Чекайте на результат

💰 Токени витрачаються за кожну генерацію
📦 Купіть підписку для отримання більше токенів

👤 Підтримка:
💬 Telegram: https://t.me/nnn_ddddddd

📋 Важлива інформація:
🔗 Угода користувача: /info
🔗 Політика приватності: /info
🔗 Інформація про компанію: /info

© 2026 neuro.lab.ai Всі права захищені.`;

  await ctx.reply(helpText, keyboard.createBackButton());
});

bot.command('profile', async (ctx) => {
  await showProfile(ctx);
});

bot.command('balance', async (ctx) => {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);
  await ctx.reply(
    `💰 Ваш баланс: ${user.tokens.toFixed(2)}⚡`,
    keyboard.createBackButton()
  );
});

bot.command('clear', async (ctx) => {
  const userId = ctx.from.id;

  // Очищаємо стан генерації зображень (новий флоу)
  const hadImageState = imageGenState.has(userId);
  imageGenState.delete(userId);

  // Очищаємо стан генерації (але НЕ обрану модель!)
  const hadState = userState.has(userId);
  userState.delete(userId);
  // НЕ видаляємо userCurrentModel - користувач може продовжити з тією ж моделлю

  if (hadImageState || hadState) {
    const currentModel = userCurrentModel.get(userId);
    await ctx.reply(
      '🧹 <b>Очищено!</b>\n\n' +
      (hadPrompt ? '✅ Накопичений промпт видалено\n' : '') +
      (hadState ? '✅ Стан генерації скинуто\n' : '') +
      (currentModel ? `\n📌 Обрана модель: <b>${currentModel}</b>\nМожете продовжити генерацію.` : '\nМожете почати заново.'),
      { parse_mode: 'HTML' }
    );
  } else {
    await ctx.reply(
      '✅ Нічого очищати - все чисто!',
      keyboard.createMainMenu()
    );
  }
});

bot.command('history', async (ctx) => {
  const history = await userBalance.getTransactionHistory(ctx.from.id, 10);
  
  if (history.length === 0) {
    await ctx.reply('📊 Історія порожня', keyboard.createBackButton());
    return;
  }
  
  let text = '📊 Історія останніх операцій:\n\n';
  
  history.forEach((item, index) => {
    const date = new Date(item.createdAt).toLocaleString('uk-UA');
    const sign = item.type === 'deduction' ? '-' : '+';
    text += `${index + 1}. ${date}\n`;
    text += `   ${item.description || 'Транзакція'}\n`;
    text += `   ${sign}${item.amount.toFixed(2)}⚡ (баланс: ${item.balanceAfter.toFixed(2)}⚡)\n\n`;
  });
  
  await ctx.reply(text, keyboard.createBackButton());
});

bot.command('clear', async (ctx) => {
  await userBalance.clearConversationHistory(ctx.from.id);
  await ctx.reply('✅ Історію розмови очищено!', keyboard.createMainMenu());
});

bot.command('info', async (ctx) => {
  const message = `📋 <b>Юридична інформація та Угода користувача</b>

Перед використанням сервісу ознайомтесь з нашими юридичними документами:

<b>📋 Угода користувача</b>
Регулює умови надання послуг та взаємовідносини між користувачем та компанією. Включає описання всіх товарів/послуг та їхні вартості.

<b>🔒 Політика приватності</b>
Описує як ми збираємо, обробляємо та захищаємо вашу персональну інформацію.

Натисніть на кнопку нижче щоб ознайомитися з повним текстом документів:`;

  await ctx.reply(message, { parse_mode: 'HTML', ...keyboard.createLegalMenu() });
});

bot.command('feedback', async (ctx) => {
  const feedbackMenu = `📝 <b>Форма зворотнього зв'язку</b>

Яка причина вашого звернення?

Оберіть категорію 👇`;

  const feedbackKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💡 Побажання', 'feedback_suggestion')],
    [Markup.button.callback('🐛 Проблема', 'feedback_problem')],
    [Markup.button.callback('⭐ Відгук', 'feedback_review')],
    [Markup.button.callback('🔙 Назад', 'main_menu')]
  ]);

  await ctx.reply(feedbackMenu, { parse_mode: 'HTML', ...feedbackKeyboard });
});

// ==================== ADMIN COMMANDS ====================

bot.command('blocklist', async (ctx) => {
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  const blockedUsers = await blockedUsersUtil.getAllBlockedUsers();

  if (blockedUsers.length === 0) {
    await ctx.reply('✅ Заблокованих користувачів немає');
    return;
  }

  let message = `🚫 <b>Список забло��ованих користувачів</b> (${blockedUsers.length})\n\n`;

  for (let index = 0; index < blockedUsers.length; index++) {
    const user = blockedUsers[index];
    message += `${index + 1}. ID: <code>${user._id}</code>\n`;
    message += `   👤 @${user.username || 'unknown'} (${user.firstName || 'No name'})\n`;
    message += `   🚫 Причина: ${user.reason}\n`;
    message += `   📅 ${new Date(user.blockedAt).toLocaleString('uk-UA')}\n`;
    message += `   /unblock_${user._id}\n\n`;
  }

  await ctx.reply(message, { parse_mode: 'HTML' });
});

// Перевірка цін KIE.AI (тільки для адміна)
bot.command('kiepricing', async (ctx) => {
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  try {
    const statusMsg = await ctx.reply('⏳ Перевіряю ціни KIE.AI...');

    const cache = await kiePricingSync.getCurrentPricing();
    const parsed = cache.parsed;

    const age = Date.now() - cache.timestamp;
    const hours = Math.floor(age / (60 * 60 * 1000));

    let message = `💰 <b>KIE.AI Ціни</b>\n\n`;
    message += `🕐 Оновлено: ${hours}h тому\n`;
    message += `📅 ${cache.lastUpdate}\n\n`;

    // IMAGE
    message += `🎨 <b>ЗОБРАЖЕННЯ:</b>\n`;
    if (parsed.nano_banana) {
      message += `  🍌 Nano Base: $${parsed.nano_banana.usdPrice} (${parsed.nano_banana.creditPrice} cr)\n`;
    }
    if (parsed.nano_banana_2k) {
      message += `  🍌 Nano 2K: $${parsed.nano_banana_2k.usdPrice} (${parsed.nano_banana_2k.creditPrice} cr)\n`;
    }
    if (parsed.nano_banana_4k) {
      message += `  🍌🍌 Nano 4K: $${parsed.nano_banana_4k.usdPrice} (${parsed.nano_banana_4k.creditPrice} cr)\n`;
    }
    message += `\n`;

    // VIDEO
    message += `🎬 <b>ВІДЕО:</b>\n`;
    if (parsed.kling_2_6?.length) {
      message += `  Kling 2.6: ${parsed.kling_2_6.length} варіантів\n`;
      parsed.kling_2_6.slice(0, 2).forEach(m => {
        const desc = m.modelDescription.replace('kling 2.6, ', '').substring(0, 30);
        message += `    • ${desc}: $${m.usdPrice}\n`;
      });
    }
    if (parsed.kling_3_0?.length) {
      message += `  Kling 3.0: ${parsed.kling_3_0.length} варіантів\n`;
    }
    if (parsed.sora_2?.length) {
      message += `  Sora 2: ${parsed.sora_2.length} варіантів\n`;
      const sora = parsed.sora_2[0];
      if (sora) {
        message += `    • ${sora.modelDescription.substring(0, 30)}: $${sora.usdPrice}\n`;
      }
    }
    message += `\n`;

    message += `💡 Команди:\n`;
    message += `/kiepricingupdate - оновити ціни\n`;
    message += `/kiepricingreport - детальний звіт`;

    await ctx.telegram.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      null,
      message,
      { parse_mode: 'HTML' }
    );

  } catch (error) {
    console.error('Error in /kiepricing:', error);
    await ctx.reply(`❌ Помилка: ${error.message}`);
  }
});

// Форсувати оновлення цін (тільки для адміна)
bot.command('kiepricingupdate', async (ctx) => {
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  try {
    const statusMsg = await ctx.reply('⏳ Оновлюю ціни з KIE.AI API...');

    await kiePricingSync.forceUpdate();

    await ctx.telegram.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      null,
      '✅ Ціни KIE.AI успішно оновлені!\n\n/kiepricing - переглянути ціни'
    );

  } catch (error) {
    console.error('Error in /kiepricingupdate:', error);
    await ctx.reply(`❌ Помилка оновлення: ${error.message}`);
  }
});

// Детальний звіт про ціни (тільки для адміна)
bot.command('kiepricingreport', async (ctx) => {
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  try {
    const statusMsg = await ctx.reply('⏳ Генерую звіт...');

    const cache = await kiePricingSync.getCurrentPricing();
    const parsed = cache.parsed;

    let messages = [];
    let currentMsg = `💰 <b>KIE.AI Pricing Report</b>\n`;
    currentMsg += `📅 ${cache.lastUpdate}\n\n`;

    // Kling 2.6
    if (parsed.kling_2_6?.length) {
      currentMsg += `🎬 <b>Kling 2.6 (${parsed.kling_2_6.length} варіантів):</b>\n`;
      parsed.kling_2_6.forEach(m => {
        const desc = m.modelDescription.replace('kling 2.6, ', '');
        const line = `  • ${desc}\n    $${m.usdPrice} (${m.creditPrice} cr)\n`;
        if ((currentMsg + line).length > 4000) {
          messages.push(currentMsg);
          currentMsg = '';
        }
        currentMsg += line;
      });
      currentMsg += `\n`;
    }

    // Kling 3.0
    if (parsed.kling_3_0?.length) {
      currentMsg += `🚀 <b>Kling 3.0 (${parsed.kling_3_0.length} варіантів):</b>\n`;
      parsed.kling_3_0.forEach(m => {
        const desc = m.modelDescription.replace('Kling 3.0, ', '');
        const line = `  • ${desc}\n    $${m.usdPrice}/sec (${m.creditPrice} cr/sec)\n`;
        if ((currentMsg + line).length > 4000) {
          messages.push(currentMsg);
          currentMsg = '';
        }
        currentMsg += line;
      });
      currentMsg += `\n`;
    }

    // Sora 2
    if (parsed.sora_2?.length) {
      currentMsg += `🔥 <b>OpenAI Sora 2 (${parsed.sora_2.length} варіантів):</b>\n`;
      parsed.sora_2.forEach(m => {
        const desc = m.modelDescription.replace('Open AI sora 2, ', '');
        const discount = m.discountRate ? ` (${m.discountRate}% OFF!)` : '';
        const line = `  • ${desc}\n    $${m.usdPrice} vs Fal $${m.falPrice}${discount}\n`;
        if ((currentMsg + line).length > 4000) {
          messages.push(currentMsg);
          currentMsg = '';
        }
        currentMsg += line;
      });
    }

    messages.push(currentMsg);

    await ctx.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id);

    for (const msg of messages) {
      await ctx.reply(msg, { parse_mode: 'HTML' });
    }

  } catch (error) {
    console.error('Error in /kiepricingreport:', error);
    await ctx.reply(`❌ Помилка: ${error.message}`);
  }
});

// Порівняння цін для конкретної моделі (тільки для адміна)
bot.command('kiecompare', async (ctx) => {
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  try {
    const cache = await kiePricingSync.getCurrentPricing();
    const parsed = cache.parsed;
    const kieModels = require('./config/kie-ai-models');

    let message = `💰 <b>Порівняння цін: KIE.AI vs Replicate</b>\n\n`;

    // Nano Banana
    message += `🎨 <b>ЗОБРАЖЕННЯ:</b>\n\n`;

    if (parsed.nano_banana_2k) {
      const kiePrice = parseFloat(parsed.nano_banana_2k.usdPrice);
      const repPrice = kieModels.nano_banana_pro.replicate_pricing['2K'];
      const savings = ((repPrice - kiePrice) / repPrice * 100).toFixed(1);
      message += `🍌 <b>Nano Banana 2K:</b>\n`;
      message += `  KIE.AI: $${kiePrice}\n`;
      message += `  Replicate: $${repPrice}\n`;
      message += `  ${savings >= 0 ? '💰 Економія' : '⚠️ Дорожче'}: ${Math.abs(savings)}%\n\n`;
    }

    if (parsed.nano_banana_4k) {
      const kiePrice = parseFloat(parsed.nano_banana_4k.usdPrice);
      const repPrice = kieModels.nano_banana_pro.replicate_pricing['4K'];
      const savings = ((repPrice - kiePrice) / repPrice * 100).toFixed(1);
      message += `🍌🍌 <b>Nano Banana 4K:</b>\n`;
      message += `  KIE.AI: $${kiePrice}\n`;
      message += `  Replicate: $${repPrice}\n`;
      message += `  ${savings >= 0 ? '💰 Економія' : '⚠️ Дорожче'}: ${Math.abs(savings)}%\n\n`;
    }

    // Kling 2.6
    message += `🎬 <b>ВІДЕО:</b>\n\n`;

    const kling26_5s_no_audio = parsed.kling_2_6?.find(m =>
      m.modelDescription.includes('5.0s') && m.modelDescription.includes('without audio')
    );
    if (kling26_5s_no_audio) {
      const kiePrice = parseFloat(kling26_5s_no_audio.usdPrice);
      const repPrice = 0.07 * 5; // Replicate: $0.07/sec * 5s
      const savings = ((repPrice - kiePrice) / repPrice * 100).toFixed(1);
      message += `🎭 <b>Kling 2.6 (5s без аудіо):</b>\n`;
      message += `  KIE.AI: $${kiePrice}\n`;
      message += `  Replicate: $${repPrice.toFixed(3)}\n`;
      message += `  ${savings >= 0 ? '💰 Економія' : '⚠️ Дорожче'}: ${Math.abs(savings)}%\n\n`;
    }

    // Kling 3.0
    const kling30_1080p_no_audio = parsed.kling_3_0?.find(m =>
      m.modelDescription.includes('1080P') && m.modelDescription.includes('without audio')
    );
    if (kling30_1080p_no_audio) {
      const kiePricePerSec = parseFloat(kling30_1080p_no_audio.usdPrice.replace(/[^0-9.]/g, ''));
      const falPricePerSec = parseFloat(kling30_1080p_no_audio.falPrice);
      const savings = ((falPricePerSec - kiePricePerSec) / falPricePerSec * 100).toFixed(1);
      message += `🚀 <b>Kling 3.0 (1080p без аудіо):</b>\n`;
      message += `  KIE.AI: $${kiePricePerSec}/sec\n`;
      message += `  Fal.ai: $${falPricePerSec}/sec\n`;
      message += `  💰 Економія: ${savings}%\n\n`;
    }

    // Sora 2
    if (parsed.sora_2?.length) {
      const sora = parsed.sora_2[0];
      const kiePrice = parseFloat(sora.usdPrice);
      const falPrice = parseFloat(sora.falPrice);
      const savings = ((falPrice - kiePrice) / falPrice * 100).toFixed(1);
      message += `🔥 <b>Sora 2 (${sora.modelDescription.replace('Open AI sora 2, ', '')}):</b>\n`;
      message += `  KIE.AI: $${kiePrice}\n`;
      message += `  Fal.ai: $${falPrice}\n`;
      message += `  🎉 Економія: ${savings}%!\n\n`;
    }

    message += `\n📊 Всі ціни актуальні станом на:\n${cache.lastUpdate}`;

    await ctx.reply(message, { parse_mode: 'HTML' });

  } catch (error) {
    console.error('Error in /kiecompare:', error);
    await ctx.reply(`❌ Помилка: ${error.message}`);
  }
});

bot.command(/^unblock_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);

  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  // Перевіряємо чи користувач заблокований
  const isBlocked = await blockedUsersUtil.isUserBlocked(userId);
  if (!isBlocked) {
    await ctx.reply(`ℹ️ Користувач ${userId} не заблокований`);
    return;
  }

  // Розблокуємо користувача
  const success = await blockedUsersUtil.unblockUser(userId);

  if (success) {
    await ctx.reply(`✅ Користувач ${userId} розблокований`);

    // Спробуємо повідомити користувача
    try {
      await bot.telegram.sendMessage(
        userId,
        `✅ <b>Ви були розблоковані!</b>

Ви знову можете користуватися ботом. Приносимо вибачення за незручності.

Введіть /start щоб почати`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.warn(`⚠️ Could not notify user ${userId}:`, error.message);
    }

    console.log(`✅ User ${userId} unblocked by admin`);
  } else {
    await ctx.reply(`❌ Помилка при розблокуванні користувача`);
  }
});

// ==================== BROADCAST (ADMIN) ====================

bot.command('broadcast', async (ctx) => {
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }
  const currentAdminId = ctx.from.id;

  const parts = ctx.message.text.trim().split(' ');
  const args = parts.slice(1);

  let parseMode = 'HTML';
  if (args.length) {
    const modeCandidate = args[0].toLowerCase();
    if (['html', 'plain', 'text', 'none', 'off'].includes(modeCandidate)) {
      parseMode = resolveBroadcastParseMode(modeCandidate);
      args.shift();
    }
  }

  const inlineText = args.join(' ').trim();
  const priorityIds = getBroadcastPriorityIds();
  const priorityLabel = priorityIds.length
    ? `Priority IDs: [${priorityIds.join(', ')}]`
    : 'Priority IDs: Всім';

  broadcastDrafts.delete(currentAdminId);
  broadcastStates.delete(currentAdminId);

  if (inlineText) {
    await ctx.reply(priorityLabel);
    const draft = { type: 'text', text: inlineText, parseMode };
    broadcastDrafts.set(currentAdminId, draft);
    await sendBroadcastPreview(ctx, draft);
    return;
  }

  broadcastStates.set(currentAdminId, { step: 'awaiting_content', parseMode });

  const modeLabel = parseMode ? 'HTML' : 'без форматування';
  await ctx.reply(
    `📣 <b>Режим розсилки</b>\n\n` +
    `Надішліть повідомлення для розсилки.\n` +
    `Підтримка: текст, фото, відео, кружечки.\n` +
    `Підпис (caption) доступний для фото/відео.\n\n` +
    `Форматування: <b>${modeLabel}</b>\n` +
    `Priority IDs: <code>${priorityIds.length ? priorityIds.join(', ') : 'Всім'}</code>\n` +
    `Скасувати: /broadcast_cancel`,
    { parse_mode: 'HTML' }
  );
});

bot.command('broadcast_cancel', async (ctx) => {
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }
  const currentAdminId = ctx.from.id;
  broadcastStates.delete(currentAdminId);
  broadcastDrafts.delete(currentAdminId);
  await ctx.reply('✅ Розсилку скасовано.');
});

bot.action('broadcast_send', async (ctx) => {
  await ctx.answerCbQuery();

  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }
  const currentAdminId = ctx.from.id;

  const draft = broadcastDrafts.get(currentAdminId);
  if (!draft) {
    await ctx.reply('⚠️ Чернетку не знайдено. Запустіть /broadcast ще раз.');
    return;
  }

  broadcastStates.delete(currentAdminId);

  const priorityIds = getBroadcastPriorityIds();
  const priorityLabel = priorityIds.length ? `Priority IDs: [${priorityIds.join(', ')}]` : 'Priority IDs: Всім';
  await ctx.reply(`📢 Розсилка запущена. Зачекайте...\n${priorityLabel}`);

  try {
    const stats = await broadcastPayload(draft);
    broadcastDrafts.delete(currentAdminId);

    await ctx.reply(
      `✅ Розсилка завершена:\n` +
      `✅ Надіслано: ${stats.success}\n` +
      `❌ Помилок: ${stats.failed}`
    );
  } catch (error) {
    console.error('Broadcast send error:', error);
    await ctx.reply('❌ Помилка розсилки. Перевірте логи.');
  }
});

bot.action('broadcast_cancel', async (ctx) => {
  await ctx.answerCbQuery();

  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }
  const currentAdminId = ctx.from.id;
  broadcastStates.delete(currentAdminId);
  broadcastDrafts.delete(currentAdminId);
  await ctx.reply('✅ Розсилку скасовано.');
});

// Перехоплюємо контент для превʼю (тільки адмін)
bot.on('message', async (ctx, next) => {
  if (!accessControl.isAdmin(ctx.from.id)) return next();
  const currentAdminId = ctx.from.id;

  const state = broadcastStates.get(currentAdminId);
  if (!state || state.step !== 'awaiting_content') return next();

  const text = ctx.message.text;
  if (text && text.startsWith('/')) {
    const cmd = text.split(' ')[0].toLowerCase();
    if (cmd === '/broadcast_cancel') {
      return next();
    }
  }

  const parseMode = state.parseMode ?? null;
  let draft = null;

  if (ctx.message.text) {
    draft = { type: 'text', text: ctx.message.text, parseMode };
  } else if (ctx.message.photo) {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    draft = { type: 'photo', fileId, caption: ctx.message.caption || '', parseMode };
  } else if (ctx.message.video) {
    const fileId = ctx.message.video.file_id;
    draft = { type: 'video', fileId, caption: ctx.message.caption || '', parseMode };
  } else if (ctx.message.video_note) {
    const fileId = ctx.message.video_note.file_id;
    draft = { type: 'video_note', fileId };
  } else if (ctx.message.document) {
    const fileId = ctx.message.document.file_id;
    draft = { type: 'document', fileId, caption: ctx.message.caption || '', parseMode };
  }

  if (!draft) {
    await ctx.reply('⚠️ Підтримка: текст, фото, відео, кружечки.');
    return;
  }

  broadcastDrafts.set(currentAdminId, draft);
  broadcastStates.delete(currentAdminId);

  await sendBroadcastPreview(ctx, draft);
});

// Обробники feedback категорій
bot.action(/^feedback_(suggestion|problem|review)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const feedbackType = ctx.match[1];
  const typeNames = {
    suggestion: '💡 Побажання',
    problem: '🐛 Проблема',
    review: '⭐ Відгук'
  };

  // Зберігаємо тип в sessionStorage
  feedbackData.set(ctx.from.id, {
    type: feedbackType,
    typeName: typeNames[feedbackType],
    userId: ctx.from.id,
    username: ctx.from.username || 'unknown',
    firstName: ctx.from.first_name
  });

  const message = `<b>${typeNames[feedbackType]}</b>

Розскажіть детальніше 👇
(максимум 1000 символів)`;

  await ctx.reply(message, { parse_mode: 'HTML' });
});

// ==================== ADMIN FEEDBACK HANDLERS ====================

// Адмін підтверджує feedback
bot.action(/^feedback_confirm_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = parseInt(ctx.match[1]);
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Доступ заборонений', true);
    return;
  }

  // Оновлюємо повідомлення (якщо це текстове)
  const messageText = ctx.callbackQuery?.message?.text;
  if (messageText) {
    await ctx.editMessageText(
      messageText + '\n\n✅ <b>Статус: Прийнято</b>',
      { parse_mode: 'HTML' }
    );
  } else {
    // Якщо це фото/документ, просто рідим reply
    await ctx.reply('✅ <b>Feedback прийнято</b>', { parse_mode: 'HTML' });
  }

  // Повідомляємо користувачу
  try {
    await bot.telegram.sendMessage(
      userId,
      `✅ <b>Ваше звернення прийнято в роботу</b>

Дякуємо за звернення! Ми розглянули ваше повідомлення та почнемо над ним працювати.

Якщо у вас ще є питання, можете написати нам ще раз командою /feedback`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('❌ Error notifying user:', error.message);
  }

  console.log(`✅ Feedback confirmed from user ${userId}`);
});

// Адмін відхиляє feedback
bot.action(/^feedback_decline_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = parseInt(ctx.match[1]);
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Доступ заборонений', true);
    return;
  }

  // Оновлюємо повідомлення (якщо це текстове)
  const messageText = ctx.callbackQuery?.message?.text;
  if (messageText) {
    await ctx.editMessageText(
      messageText + '\n\n❌ <b>Статус: Відхилено</b>\n<i>Не на часі або порушує політику</i>',
      { parse_mode: 'HTML' }
    );
  } else {
    // Якщо це фото/документ, просто рідим reply
    await ctx.reply('❌ <b>Feedback відхилено</b>', { parse_mode: 'HTML' });
  }

  // Повідомляємо користувачу
  try {
    await bot.telegram.sendMessage(
      userId,
      `❌ <b>Ваше звернення було розглянуто</b>

На жаль, ваше звернення не відповідає нашій політиці або зараз не актуальне.

Якщо у вас ще є питання, ми завжди готові вислухати 💬`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('❌ Error notifying user:', error.message);
  }

  console.log(`❌ Feedback declined from user ${userId}`);
});

// Адмін блокує користувача
bot.action(/^feedback_block_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = parseInt(ctx.match[1]);
  if (!accessControl.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Доступ заборонений', true);
    return;
  }

  if (accessControl.isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Не можна заблокувати адміна.', true);
    return;
  }

  // Парсимо username та firstName з тексту повідомлення
  // Новий формат: 👤 Від: @username | FirstName
  // Або: 👤 Від: (без username) | FirstName
  const messageText = ctx.callbackQuery?.message?.text || ctx.callbackQuery?.message?.caption || '';
  let username = null;
  let firstName = 'Unknown';

  // Спробуємо знайти з username
  const userMatchWithUsername = messageText.match(/👤 Від: @(\S+) \| (.+)/);
  if (userMatchWithUsername) {
    username = userMatchWithUsername[1];
    firstName = userMatchWithUsername[2].trim();
  } else {
    // Спробуємо знайти без username
    const userMatchNoUsername = messageText.match(/👤 Від: \(без username\) \| (.+)/);
    if (userMatchNoUsername) {
      username = null;
      firstName = userMatchNoUsername[1].trim();
    }
  }

  // Блокуємо користувача в БД
  const success = await blockedUsersUtil.blockUser(
    userId,
    username,
    firstName,
    ctx.from.id,
    'Spam or inappropriate behavior',
    'Blocked via feedback system'
  );

  if (success) {
    // Оновлюємо повідомлення (якщо це текстове)
    const messageText = ctx.callbackQuery?.message?.text;
    if (messageText) {
      await ctx.editMessageText(
        messageText + '\n\n🚫 <b>Статус: Користувач заблокований</b>\n<i>Спам або неадекватна поведінка</i>',
        { parse_mode: 'HTML' }
      );
    } else {
      // Якщо це фото/документ, просто рідим reply
      await ctx.reply('🚫 <b>Користувач заблокований</b>', { parse_mode: 'HTML' });
    }

    // Повідомляємо користувачу про блокування
    try {
      await bot.telegram.sendMessage(
        userId,
        `🚫 <b>Ви були заблоковані</b>

Ваш акаунт був заблокований через порушення правил нашого сервісу (спам, неадекватна поведінка або інші порушення).

Якщо вважаєте це помилкою, зв'яжіться з технічною підтримкою.`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('❌ Error notifying user about block:', error.message);
    }

    console.log(`🚫 User ${userId} blocked`);
  } else {
    await ctx.answerCbQuery('❌ Помилка при блокуванні користувача', true);
  }
});

// Обробники feedback категорій
bot.action(/^feedback_(suggestion|problem|review)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const feedbackType = ctx.match[1];
  const typeNames = {
    suggestion: '💡 Побажання',
    problem: '🐛 Проблема',
    review: '⭐ Відгук'
  };

  // Зберігаємо тип в sessionStorage
  feedbackData.set(ctx.from.id, {
    type: feedbackType,
    typeName: typeNames[feedbackType],
    userId: ctx.from.id,
    username: ctx.from.username || 'unknown',
    firstName: ctx.from.first_name
  });

  const message = `<b>${typeNames[feedbackType]}</b>

Розскажіть детальніше 👇
(максимум 1000 символів)`;

  await ctx.reply(message, { parse_mode: 'HTML' });
});

// ==================== ГОЛОВНЕ МЕНЮ ====================

bot.hears('🧠 Помічники', async (ctx) => {
  await ctx.reply(
    `🧠 Claude\n\n💎 Claude - преміум якість\n\nОберіть режим роботи 👇`,
    keyboard.createGPTActionsMenu(models.gpt.actions)
  );
});

bot.hears('🎬 Відео', async (ctx) => {
  await ctx.reply(
    '🎬 Створення відео\n\nВиберіть розділ для роботи з відео 👇',
    keyboard.createInlineMenu(getVideoModelsForUser(ctx.from.id), 1)
  );
});

bot.hears('🖼️ Зображення', async (ctx) => {
  try {
    await ctx.reply(
      '🎨 Дизайн з AI\n\nВиберіть розділ для роботи з зображенням 👇',
      keyboard.createInlineMenu(getDesignModelsWithEffectiveCost(ctx.from.id), 1)
    );
  } catch (error) {
    console.error('❌ Error loading design menu:', error);
    await ctx.reply(
      '⚠️ Помилка завантаження меню.\n\n' +
      'Спробуйте ще раз або зверніться до адміністратора.',
      keyboard.createBackButton()
    );
  }
});

bot.hears('🎙️ Аудіо з AI', async (ctx) => {
  await ctx.reply(
    '🎙️ Аудіо з AI\n\nВиберіть розділ для роботи з аудіо 👇',
    keyboard.createInlineMenu(models.audio.models, 1)
  );
});

bot.hears('👤 Профіль', async (ctx) => {
  await showProfile(ctx);
});

/**
 * Меню вибору провайдера (доступно всім користувачам)
 */
bot.command('provider', async (ctx) => {
  const userId = ctx.from.id;


  if (!kieAI.isKieAIEnabled) {
    return ctx.reply('❌ KIE.AI не увімкнена. Додайте KIE_AI_API_KEY в .env файл.');
  }

  const currentChoice = userProviderChoice.get(userId) || 'auto';

  const providerMenu = `⚙️ <b>Вибір провайдера для генерацій</b>

Який провайдер використовувати для генерацій?

<b>Поточний вибір:</b> ${currentChoice === 'auto' ? '🤖 Автоматичний' : currentChoice === 'kie-ai' ? '🔵 KIE.AI' : '🟣 Replicate'}

<b>Описання:</b>
🔵 <b>KIE.AI</b> - дешевший, швидший (пріоритетний) ✅
🟣 <b>Replicate</b> - альтернативний провайдер
🤖 <b>Автоматичний</b> - розумний вибір з fallback

<b>🆕 Нова система fallback:</b>
✅ Якщо KIE.AI не працює - автоматично перемикається на Replicate
✅ Якщо обрали конкретний провайдер - використовується тільки він

💡 Рекомендуємо: <b>Автоматичний</b> (найкраща надійність)`;

  const providerKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔵 KIE.AI', 'provider_kie-ai')],
    [Markup.button.callback('🟣 Replicate', 'provider_replicate')],
    [Markup.button.callback('🤖 Автоматичний', 'provider_auto')],
    [Markup.button.callback('🏠 Назад', 'main_menu')]
  ]);

  await ctx.reply(providerMenu, {
    parse_mode: 'HTML',
    ...providerKeyboard
  });
});

/**
 * Callback handlers для вибору провайдера
 */
bot.action('provider_kie-ai', async (ctx) => {
  const userId = ctx.from.id;

  userProviderChoice.set(userId, 'kie-ai');
  saveProviderChoice();

  await ctx.editMessageText(
    '✅ <b>KIE.AI вибрана</b>\n\n' +
    '🔵 Тепер все генерації будуть використовувати KIE.AI\n\n' +
    '💡 Командa: /provider для зміни вибору',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Назад', 'main_menu')]])
    }
  );

  await ctx.answerCbQuery('✅ KIE.AI обрана!');
});

bot.action('provider_replicate', async (ctx) => {
  const userId = ctx.from.id;

  userProviderChoice.set(userId, 'replicate');
  saveProviderChoice();

  await ctx.editMessageText(
    '✅ <b>Replicate вибрана</b>\n\n' +
    '🟣 Тепер всі генерації будуть використовувати Replicate\n\n' +
    '⚠️ <b>Увага:</b> Вартість генерацій на Replicate зазвичай <b>дорожча</b> ніж на KIE.AI!\n' +
    'Наприклад: Nano Banana — 7⚡ (Replicate) vs 4⚡ (KIE.AI)\n\n' +
    '💡 Рекомендуємо <b>KIE.AI</b> або <b>Автоматичний</b> режим для економії\n\n' +
    '💡 Командa: /provider для зміни вибору',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔵 Повернути KIE.AI', 'provider_kie-ai')],
        [Markup.button.callback('🏠 Назад', 'main_menu')]
      ])
    }
  );

  await ctx.answerCbQuery('⚠️ Replicate обрана (дорожчі ціни)');
});

bot.action('provider_auto', async (ctx) => {
  const userId = ctx.from.id;

  userProviderChoice.delete(userId);  // видаляємо вибір, щоб використовувати автоматичний
  saveProviderChoice();

  await ctx.editMessageText(
    '✅ <b>Автоматичний режим увімкнено</b>\n\n' +
    '🤖 Розумний вибір провайдера:\n' +
    '1️⃣ Спочатку пробує <b>KIE.AI</b> (дешевше)\n' +
    '2️⃣ Якщо не працює → автоматично <b>Replicate</b>\n\n' +
    '✅ Fallback УВІМКНЕНИЙ - максимальна надійність!\n\n' +
    '💡 Команда: /provider для зміни вибору',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Назад', 'main_menu')]])
    }
  );

  await ctx.answerCbQuery('✅ Автоматичний режим включений!');
});

/**
 * Callback для кнопки "Вибір провайдера" з меню профіля
 */
bot.action('provider_menu', async (ctx) => {
  const userId = ctx.from.id;


  if (!kieAI.isKieAIEnabled) {
    return ctx.answerCbQuery('❌ KIE.AI не увімкнена', 1);
  }

  const currentChoice = userProviderChoice.get(userId) || 'auto';

  const providerMenu = `⚙️ <b>Вибір провайдера для генерацій</b>

Який провайдер використовувати для генерацій?

<b>Поточний:</b> ${currentChoice === 'auto' ? '🤖 Автоматичний (KIE.AI)' : currentChoice === 'kie-ai' ? '🔵 KIE.AI' : '🟣 Replicate'}

🔵 <b>KIE.AI</b> — дешевший, рекомендований ✅
🟣 <b>Replicate</b> — дорожчий, альтернативний
🤖 <b>Автоматичний</b> — спершу KIE.AI, якщо недоступна → Replicate

⚠️ При виборі Replicate ціни генерацій будуть вищими!`;

  const providerKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔵 KIE.AI (рекомендовано)', 'provider_kie-ai')],
    [Markup.button.callback('🟣 Replicate (дорожчий)', 'provider_replicate')],
    [Markup.button.callback('🤖 Автоматичний', 'provider_auto')],
    [Markup.button.callback('🏠 Профіль', 'profile_menu')]
  ]);

  await ctx.editMessageText(providerMenu, {
    parse_mode: 'HTML',
    ...providerKeyboard
  });

  await ctx.answerCbQuery('⚙️ Меню провайдера');
});

// ==================== НАЛАШТУВАННЯ ====================

bot.hears('⚙️ Налаштування', async (ctx) => {
  const userId = ctx.from.id;
  const currentChoice = userProviderChoice.get(userId) || 'auto';

  const choiceEmoji = {
    'kie-ai': '🔵',
    'replicate': '🟣',
    'auto': '🤖'
  };

  const choiceText = {
    'kie-ai': 'KIE.AI',
    'replicate': 'Replicate',
    'auto': 'Автоматичний'
  };

  const settingsMenu = `⚙️ <b>Налаштування</b>

<b>Поточні налаштування:</b>
${choiceEmoji[currentChoice]} Провайдер: <b>${choiceText[currentChoice]}</b>

<b>Що таке провайдер?</b>
• 🔵 <b>KIE.AI</b> - дешевший, пріоритетний ✅
• 🟣 <b>Replicate</b> - альтернативний (дорожчий)
• 🤖 <b>Автоматичний</b> - спершу KIE.AI, потім Replicate

✅ Якщо один провайдер не працює - автоматично перемикається на інший!

Оберіть опцію нижче 👇`;

  const settingsKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔧 Вибрати провайдер', 'provider_menu')],
    [Markup.button.callback('🏠 Назад', 'main_menu')]
  ]);

  await ctx.reply(settingsMenu, {
    parse_mode: 'HTML',
    ...settingsKeyboard
  });
});

bot.hears('❓ Допомога', async (ctx) => {
  await ctx.reply(
    '❓ Використовуйте /help для перегляду команд\n' +
    '📄 Інструкція: /instruction',
    keyboard.createBackButton()
  );
});

bot.command('instruction', async (ctx) => {
  await ctx.reply(INSTRUCTION_HTML, {
    parse_mode: 'HTML',
    ...keyboard.createBackButton()
  });
});

bot.hears('🎨 Креативи', async (ctx) => {
  const creativesMenu = `🎨 <b>Готові креативи</b>

Вибери готовий креатив - будуть згенеровані фотосесії з вшитими промптами 👇`;

  const creativesKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💌 До Дня Закоханих', 'creative_love_is')],
    [Markup.button.callback('❤️ Льодяник', 'creative_hearts')],
    [Markup.button.callback('✨ Порцелянова фігурка', 'creative_porcelain_figure')],
    [Markup.button.callback('🐱 Котики', 'creative_kittens')],
    [Markup.button.callback('🌊 Підводний макро-портрет', 'creative_underwater_macro')],
    [Markup.button.callback('👑 Bridgerton', 'creative_bridgerton')],
    [Markup.button.callback('🏠 Головне меню', 'main_menu')]
  ]);

  await ctx.reply(creativesMenu, { parse_mode: 'HTML', ...creativesKeyboard });
});

bot.hears('📝 Feedback', async (ctx) => {
  const feedbackMenu = `📝 <b>Форма зворотнього зв'язку</b>

Яка причина вашого звернення?

Оберіть категорію 👇`;

  const feedbackKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💡 Побажання', 'feedback_suggestion')],
    [Markup.button.callback('🐛 Проблема', 'feedback_problem')],
    [Markup.button.callback('⭐ Відгук', 'feedback_review')],
    [Markup.button.callback('🔙 Назад', 'main_menu')]
  ]);

  await ctx.reply(feedbackMenu, { parse_mode: 'HTML', ...feedbackKeyboard });
});

bot.hears('💰 Поповнити баланс', async (ctx) => {
  await ctx.reply(`⚡ Купити токени\n\n Виберіть пакет 👇`, keyboard.createSubscriptionsMenu(ctx.from.id));
});

// Отримуємо ціни моделей
const nanoBanana2kModel = models.design.models.find(m => m.key === 'nano_banana_2k');
const seedream4kModel = models.design.models.find(m => m.key === 'seedream_4k');
const CREATIVE_COST = seedream4kModel?.cost || 5;  // Seedream 4K: 5 токенів (KIE.AI $0.032)
const CREATIVE_COST_2K = 25;
const CREATIVE_COST_SEEDREAM_4K = CREATIVE_COST;

// ==================== UKRAINIAN ROMANTIC QUOTES FOR LOVE IS... ====================
// Точно 25 цитат, як запропоновано
const UKRAINIAN_LOVE_QUOTES = [
  "засинати, тримаючись за руки",
  "ділити останній шматочок і не шкодувати",
  "сміятися з дурниць, які розумієте лише ви двоє",
  "пити чай на кухні й говорити 'як ти?' по-справжньому",
  "обіймати міцніше, коли день був важкий",
  "пам'ятати про 'я з тобою' без зайвих слів",
  "робити з дому місце, куди хочеться повертатися",
  "підтримувати мрії одне одного, навіть маленькі",
  "разом прибирати без драми і з музикою",
  "приносити каву саме так, як ти любиш",
  "писати 'я скучив/скучила' першими",
  "вміти миритися швидше, ніж ображатися",
  "радіти простим вечорам більше, ніж гучним планам",
  "зберігати теплість навіть у дрібних клопотах",
  "робити компліменти не 'за щось', а 'просто так'",
  "ділити парасолю і сміятися під дощем",
  "помічати одне одного в натовпі з першого погляду",
  "планувати майбутнє й не поспішати — разом",
  "підставляти плече, а не читати нотації",
  "бути командою у всьому — навіть у дрібницях",
  "цілувати в щоку, коли ти не очікуєш",
  "берегти ваші 'маленькі традиції'",
  "вміти слухати, а не лише відповідати",
  "казати 'дякую' за буденні речі",
  "робити фото смішними, а спогади — теплими"
];

const ROMANTIC_SCENARIOS = [
  // Класичні романтичні
  "holding hands",
  "hugging warmly",
  "sharing umbrella",
  "dancing together",
  "giving flowers",
  "sitting together",
  "walking together",
  "looking at stars",
  "sharing ice cream",

  // Ніжні жести
  "gentle forehead kiss",
  "playing with hair",
  "nose to nose",
  "piggyback ride",
  "carried in arms",
  "head on shoulder",
  "intertwined fingers",
  "whispering secrets",

  // Веселі активності
  "pillow fight",
  "making funny faces",
  "building blanket fort",
  "taking silly selfie",
  "sharing headphones",
  "cooking together",
  "playing video games",
  "eating pizza together",

  // Побутові милоти
  "morning coffee together",
  "breakfast in bed",
  "doing dishes together",
  "grocery shopping",
  "reading books together",
  "watching sunset",
  "building snowman",
  "catching raindrops",

  // Сюрреалістичні
  "floating with balloons",
  "sitting on clouds",
  "riding bicycle in sky",
  "surrounded by hearts",
  "standing on rainbow",
  "flying with birds",
  "dancing on stars",

  // Пригоди
  "running in rain",
  "jumping in puddles",
  "autumn leaf pile",
  "beach walking",
  "mountain hiking",
  "picnic in park",
  "riding tandem bike",

  // Творчі моменти
  "drawing each other",
  "taking photos",
  "making heart shapes",
  "blowing bubbles",
  "playing guitar together",
  "singing karaoke",

  // Затишні
  "wrapped in blanket",
  "cuddling on couch",
  "sleeping together",
  "sharing hot cocoa",
  "warming by fireplace",
  "under starry blanket",

  // Playful
  "feeding each other",
  "sharing cotton candy",
  "ice cream cone fight",
  "stealing hoodie",
  "tickle fight",
  "rock paper scissors"
];

const BACKGROUND_COLORS = [
  // Пастельні рожеві
  "soft pink",
  "blush pink",
  "rose pink",
  "peachy pink",
  "baby pink",

  // Фіолетові відтінки
  "lavender",
  "lilac",
  "light purple",
  "periwinkle",
  "mauve",

  // Зелені та м'ятні
  "mint green",
  "sage green",
  "seafoam",
  "pistachio",
  "pale turquoise",

  // Персикові та коралові
  "peach",
  "apricot",
  "light coral",
  "salmon pink",
  "melon",

  // Блакитні
  "sky blue",
  "powder blue",
  "baby blue",
  "ice blue",
  "aqua",

  // Жовті та кремові
  "cream yellow",
  "butter yellow",
  "lemon chiffon",
  "vanilla",
  "champagne",

  // Особливі
  "cotton candy",
  "pearl white",
  "rose gold",
  "champagne pink",
  "ivory cream"
];

const HEART_COLORS = [
  // Рожево-червоні
  "pink, red, purple",
  "pink, coral, magenta",
  "red, crimson, scarlet",
  "hot pink, purple, violet",

  // Яскраві мікси
  "fuchsia, pink, rose",
  "coral, peach, pink",
  "ruby, cherry, rose",
  "magenta, pink, lavender",

  // Пастельні комбінації
  "baby pink, blush, rose",
  "lavender, lilac, pink",
  "peach, coral, cream",
  "mint, pink, lavender",

  // Теплі тони
  "orange, coral, pink",
  "gold, rose, pink",
  "salmon, peach, coral",
  "tangerine, pink, red",

  // Холодні відтінки
  "purple, violet, magenta",
  "blue, purple, pink",
  "teal, pink, purple",
  "indigo, purple, pink",

  // Яскраві контрасти
  "neon pink, hot pink, magenta",
  "electric pink, fuchsia, purple",
  "bright red, pink, orange",

  // Ніжні градієнти
  "soft pink, rose, blush",
  "cream, peach, pink",
  "white, pink, rose",
  "vanilla, coral, pink"
];

// Бонус: додаткові деталі для унікальності
const CUTE_DETAILS = [
  "with floating hearts around",
  "with sparkles and stars",
  "with small flowers in background",
  "with musical notes floating",
  "with cute clouds nearby",
  "with ribbon or bow decoration",
  "with small butterflies",
  "with gentle glow effect",
  "with confetti around",
  "with small hearts and stars",
  "with whimsical swirls",
  "with little gift boxes",
  "with feathers floating",
  "with soap bubbles",
  "with golden shimmer"
];

// До Дня Закоханих - Love is... комік
bot.action('creative_love_is', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const effectiveCost2K = getEffectiveImageCost(userId, nanoBanana2kModel, 'nano_banana_2k');

  if (!(await userBalance.hasTokens(userId, effectiveCost2K))) {
    await showInsufficientTokens(ctx, effectiveCost2K);
    return;
  }

  // Генеруємо випадкові елементи
  const randomQuote = UKRAINIAN_LOVE_QUOTES[Math.floor(Math.random() * UKRAINIAN_LOVE_QUOTES.length)];
  const randomScenario = ROMANTIC_SCENARIOS[Math.floor(Math.random() * ROMANTIC_SCENARIOS.length)];
  const randomBgColor = BACKGROUND_COLORS[Math.floor(Math.random() * BACKGROUND_COLORS.length)];
  const randomHeartColors = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
  const randomDetail = CUTE_DETAILS[Math.floor(Math.random() * CUTE_DETAILS.length)];

  userState.set(userId, {
    creative: 'love_is',
    step: 'waiting_photo',
    model: 'nano_banana_2k',
    loveIsData: {
      quote: randomQuote,
      scenario: randomScenario,
      bgColor: randomBgColor,
      heartColors: randomHeartColors,
      detail: randomDetail
    }
  });

  // ✅ ВАЖНО: Встановити currentModel щоб система знала яку модель використовувати
  userCurrentModel.set(userId, 'love_is');

  await ctx.reply(
      `💌 <b>Готовий креатив: День Закоханих "Love is..."</b>\n\n` +
      `📸 <b>Крок 1/1:</b> Надішліть фото пари\n\n` +
      `💰 <b>Вартість:</b> ${effectiveCost2K}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть фото пари тепер`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// ❤️ Льодяник - Valentine's portrait з серцем-льодяником
bot.action('creative_hearts', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const effectiveCost4K = getEffectiveImageCost(userId, seedream4kModel, 'seedream_4k');

  if (!(await userBalance.hasTokens(userId, effectiveCost4K))) {
    await showInsufficientTokens(ctx, effectiveCost4K);
    return;
  }

  userState.set(userId, {
    creative: 'hearts',
    step: 'waiting_photo',
    model: 'seedream_4k'
  });

  userCurrentModel.set(userId, 'hearts');

  await ctx.reply(
      `❤️ <b>Готовий креатив: Льодяник</b>\n\n` +
      `📸 <b>Крок 1/1:</b> Надішліть своє селфі\n\n` +
      `💰 <b>Вартість:</b> ${effectiveCost4K}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть своє селфі зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// ✨ Порцелянова фігурка - 3D collectible-figure портрет
bot.action('creative_porcelain_figure', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const effectiveCost4K = getEffectiveImageCost(userId, seedream4kModel, 'seedream_4k');

  if (!(await userBalance.hasTokens(userId, effectiveCost4K))) {
    await showInsufficientTokens(ctx, effectiveCost4K);
    return;
  }

  userState.set(userId, {
    creative: 'porcelain_figure',
    step: 'waiting_photo',
    model: 'seedream_4k'
  });

  userCurrentModel.set(userId, 'porcelain_figure');

  await ctx.reply(
      `✨ <b>Готовий креатив: Порцелянова фігурка</b>\n\n` +
      `3D collectible-style портрет з максимальним збереженням рис обличчя, емоцій та гендеру.\n\n` +
      `💰 <b>Вартість:</b> ${effectiveCost4K}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `📸 <b>Крок 1/1:</b> Надішліть своє селфі\n` +
      `👉 Надішліть своє селфі зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// 🐱 Котики - cozy editorial портрет з кошенятами
bot.action('creative_kittens', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const effectiveCost4K = getEffectiveImageCost(userId, seedream4kModel, 'seedream_4k');

  if (!(await userBalance.hasTokens(userId, effectiveCost4K))) {
    await showInsufficientTokens(ctx, effectiveCost4K);
    return;
  }

  userState.set(userId, {
    creative: 'kittens',
    step: 'waiting_photo',
    model: 'seedream_4k'
  });

  userCurrentModel.set(userId, 'kittens');

  await ctx.reply(
      `🐱 <b>Готовий креатив: Котики</b>\n\n` +
      `📸 <b>Крок 1/1:</b> Надішліть своє селфі\n\n` +
      `💰 <b>Вартість:</b> ${effectiveCost4K}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть своє селфі зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// 🌊 Підводний макро-портрет - ultra-detailed underwater close-up
bot.action('creative_underwater_macro', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const effectiveCost4K = getEffectiveImageCost(userId, seedream4kModel, 'seedream_4k');

  if (!(await userBalance.hasTokens(userId, effectiveCost4K))) {
    await showInsufficientTokens(ctx, effectiveCost4K);
    return;
  }

  userState.set(userId, {
    creative: 'underwater_macro',
    step: 'waiting_photo',
    model: 'seedream_4k'
  });

  userCurrentModel.set(userId, 'underwater_macro');

  await ctx.reply(
      `🌊 <b>Готовий креатив: Підводний макро-портрет</b>\n\n` +
      `📸 <b>Крок 1/1:</b> Надішліть своє селфі\n\n` +
      `💰 <b>Вартість:</b> ${effectiveCost4K}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть своє селфі зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// 👑 Bridgerton - Regency portrait у стилі серіалу
bot.action('creative_bridgerton', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const effectiveCost4K = getEffectiveImageCost(userId, seedream4kModel, 'seedream_4k');

  if (!(await userBalance.hasTokens(userId, effectiveCost4K))) {
    await showInsufficientTokens(ctx, effectiveCost4K);
    return;
  }

  userState.set(userId, {
    creative: 'bridgerton',
    step: 'waiting_photo',
    model: 'seedream_4k'
  });

  // Скидаємо інші флоу, щоб фото точно пішло в креатив
  imageGenState.delete(userId);
  userCurrentModel.delete(userId);

  await ctx.reply(
      `👑 <b>Готовий креатив: Bridgerton</b>\n\n` +
      `📸 <b>Крок 1/1:</b> Надішліть своє селфі\n\n` +
      `💰 <b>Вартість:</b> ${effectiveCost4K}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть своє селфі зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// ==================== ОБРОБКА ФОТО ДЛЯ КРЕАТИВІВ ====================
// Вставити ПЕРЕД bot.on('photo') handler

async function handleCreativePhoto(ctx, imageUrl) {
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || !state.creative) return false;

  const creativeType = state.creative;

  // Промпти (АНГЛІЙСЬКА + збереження рис обличчя)
  let prompt = null;
  if (creativeType === 'love_is') {
    const data = state?.loveIsData || {
      scenario: 'holding hands',
      detail: 'with floating hearts around',
      quote: 'бути разом у будь-яку погоду'
    };
    prompt = `GOAL: Transform the uploaded photo of a real couple into a cute vintage bubblegum-wrapper "Love Is"-style sticker panel (romantic mini-comic). Keep the couple recognizable (hair, face proportions, key features), but simplify into classic chibi cartoon characters.

STYLE (match the classic "Love Is" sticker vibe):
- 1990s romantic sticker/comic illustration
- big heads, small bodies, tiny hands/feet, simple rounded shapes
- clean black outline with slightly varied line weight
- soft pastel watercolor fills + minimal shading (gentle gradients)
- subtle paper grain / print texture, tiny ink imperfections like vintage print
- warm, innocent, playful mood; cute facial expressions; light blush on cheeks
- no modern 3D, no anime, no hyperrealism, no painterly oil look

COMPOSITION / LAYOUT (single panel):
- Pure white background
- A thin black rectangular frame around the whole panel (like a sticker card), even margins
- Top-left header text: "Love is…" (exactly this, with three dots) in simple black print/handwritten-like feel, small size
- Top-right: a small heart icon (solid red/pink) inside the frame
- Illustration area: couple centered in the upper 65-70% of the panel, full bodies visible, no cropping
- Caption area: lower 30-35% reserved for Ukrainian caption text

COUPLE TRANSFORMATION RULES:
- Preserve identity cues: hair color/style, skin tone, face shape, eyebrows, glasses (if any), beard/mustache (if any)
- Keep the pose/interaction similar to the photo if it reads well; otherwise convert to a classic sweet pose: ${data.scenario}
- Simplify clothing into solid pastel blocks; keep recognizable colors/pattern hints
- Add small cute details typical for sticker comics: tiny hearts floating above, minimal props ${data.detail}

TEXT RULES (CRITICAL):
- Only two text elements:
  1) Top-left: "Love is…" (exactly this format, not "Love is...")
  2) Bottom: ONE Ukrainian sentence that MUST start with three dots "..."
- The bottom sentence is: "...${data.quote}"
- Do NOT add numbers, copyrights, signatures, watermarks, extra captions, or English translation
- Typography: simple, clean, NOT fancy cursive

NEGATIVE / AVOID:
- no anime, no manga, no 3D render, no photorealism
- no complex backgrounds, no gradients behind the panel, no colored backdrop
- no extra text, no English line, no page numbers, no watermark, no copyright marks
- no blurry lines, no messy typography, no distorted faces, no extra fingers/limbs

OUTPUT: Single sticker-style panel with "Love is…" at top-left and Ukrainian caption at bottom.`;
  } else if (creativeType === 'hearts') {
    prompt = `Dramatic overhead professional lighting with depth and sculpted shadows. Keep the EXACT selfie expression, mood, and gaze — do not change emotion or add any “sultry” look. Preserve the original head turn/tilt and camera angle from the uploaded selfie (if the head is slightly turned, keep it slightly turned; keep the same gaze direction). Preserve facial identity and all facial proportions strictly as in the selfie — do not alter facial features; keep her highly recognizable. Realistic skin texture with visible pores and natural highlights (no beauty blur, no plastic smoothing). IMPORTANT: keep all natural moles/beauty marks/freckles exactly as in the selfie — do not remove, do not smooth them out, do not retouch them away.

Hair styled into two relaxed top buns on the crown (not side buns), with light volume and a few loose strands framing the face. Makeup: natural clean makeup only, soft neutral eyeshadow, subtle mascara, no graphic eyeliner, no exaggerated eye shapes, no face paint, no decals, no fantasy elements, keep eyebrows clean and natural. Matte rich red lipstick with a slightly darker contoured edge.

Outfit: elegant red satin off-shoulder dress (smooth glossy satin fabric, soft folds, subtle specular highlights), neckline below the shoulders, fashion studio look.

Heart lollipop: a large semi-transparent heart-shaped hard candy on a stick that covers ONE eye like an eye-patch; make it big (about one-third of the face), clear translucent red with realistic reflections; the stick visible and held in hand; position it precisely over the eye (not near the mouth). Glossy red almond-shaped manicure.

Gold dangling earrings with a red heart-shaped gemstone. Gold choker necklace with a centered heart charm matching the earrings.

Remove lipstick kiss marks. Add a small amount of glossy heart stickers: clustered on ONE side of the face only, plus a few on the neck/upper chest/shoulder area (not too many). Neutral studio background, clean.

Framing: chest-up portrait (from upper chest to top of head), centered, no full-body. 9:16 8K

NEGATIVE: any eyebrow decals, any “ear” shapes, any leaf/animal shapes, any fantasy makeup, any face markings, any graphic eyeliner, any mole removal, any skin-smoothing that erases pores or beauty marks.`
  } else if (creativeType === 'porcelain_figure') {
    prompt = `Create a hyper-stylized 3D version of the person from the reference image, strictly preserving their unique facial structure, proportions, and recognizable features. The face shape, eyes, nose, lips, jawline, eyebrows, and overall expression should closely match the reference while being translated into a cute, softly exaggerated 3D aesthetic. Maintain the original hairstyle, hair length, parting, and general volume, adapted into smooth, stylized strands without altering identity.

CRITICAL FACE PRESERVATION:
- Strictly preserve the EXACT gender from the reference image. Do NOT feminize male faces or masculinize female faces.
- Keep the EXACT facial proportions: eye shape, eye spacing, nose shape and size, lip shape and fullness, jawline structure, cheekbones, face width and length ratio.
- Preserve the EXACT expression and emotions from the reference photo: if smiling - keep the smile; if serious - keep serious; if playful - keep playful. Do not change or neutralize emotions.
- Keep all distinctive facial features: beauty marks, freckles, facial structure, eyebrow shape and thickness, eye color.
- Maintain natural skin tones matching the reference person.
- Do NOT swap or alter gender identity, facial identity, or emotional expression.

The character should be floating against a clean, solid white background. Body proportions must remain logical, cohesive, and clearly readable, with gentle stylization (slightly rounded forms, softened edges) but no distortion of anatomy or facial likeness.

Style & Materials: Render in a polished, collectible-figure style with a glossy porcelain-vinyl surface, subtle iridescent glow, and soft specular highlights. The surface should be smooth, clean, and lightly reflective, resembling a premium designer figurine.

Color & Finish: Use a bright, saturated, cartoon-like color palette while keeping natural skin tones and balanced harmony. Avoid extreme stylization that would obscure facial identity or gender.

Lighting & Camera: Soft studio lighting with gentle highlights and minimal shadows. Use a 3/4 camera angle, slightly from above, to emphasize volume, depth, and facial features.

Composition: The character appears lightly floating in mid-air. No props, no environment, no background elements — only the figure on a pure white backdrop. Ensure a clean silhouette, strong readability, and a refined, finished look.

NEGATIVE PROMPT: gender swap, face morphing, altered facial proportions, feminized male features, masculinized female features, different identity, changed expression, neutral emotion when reference shows emotion, removed beauty marks or freckles, changed eye color or shape.`
  } else if (creativeType === 'kittens') {
    prompt = `A cozy dreamy high-fashion editorial portrait of the person from the reference photo. The person is fully surrounded by dozens of ultra-fluffy kittens, filling the entire frame like a soft living cloud. Extremely long, dense, airy fur with plush texture, maximum volume and soft halos. Baby-like kittens with big round eyes and faces in white, cream, beige, gray and soft ginger tones, hyper-realistic fur details.

The person lies calmly in the center, relaxed as if resting near a fireplace, eyes gently closed or with a soft peaceful smile, deep cozy holiday mood. Wearing a warm red New Year-inspired cozy sweater: oversized chunky knit, soft wool or cashmere texture, thick yarn, rich deep red color, relaxed fit, no logos.

Warm amber fireplace lighting, gentle shadows, cinematic warmth, soft fur highlights. Delicate Christmas garlands with warm fairy lights, creamy bokeh, magical winter atmosphere. Top-down symmetrical composition, cinematic editorial photography, shallow depth of field, high resolution.

Face preservation: strictly preserve the original face from the reference photo. Do not change gender, facial structure, proportions, expression or identity. Keep natural skin texture and realistic features exactly as in the reference.
Negative: gender swap, face morphing, altered facial proportions, feminized or masculinized features, different identity.`
  } else if (creativeType === 'underwater_macro') {
    prompt = `Hyper-realistic, ultra-detailed close-up portrait submerged in water, one eye in sharp focus, positioned on the far left of the frame, light rays creating caustic patterns on the skin, suspended water droplets and bubbles adding depth, cinematic lighting with soft shadows and sharp highlights, photorealistic textures including skin pores, wet lips, eyelashes, and subtle subsurface scattering, surreal and dreamlike atmosphere, shallow depth of field, underwater macro.

Exactly the same face from the reference image. Do not change gender, facial structure, proportions, expression, or identity. Preserve natural skin texture and realistic features exactly as in the reference.`
  } else if (creativeType === 'bridgerton') {
    prompt = `PROMPT (NanoBanana Pro / copy-paste) — “Bridgerton vibe, STRICT pose & camera lock”

INPUT IMAGES:
- Image 1 (SELFIE) = the ONLY identity + pose + camera reference. Use it to match the exact camera angle, head tilt, facial expression, and perspective.
- (Optional) Image 2 (STYLE REF) = ONLY for background/mood/color palette (flowers/arch/garden). Do NOT borrow face, hairline, or any identity features from it.

MAIN RULE (NON-NEGOTIABLE):
Recreate the selfie’s geometry 1:1:
- Keep the EXACT camera angle and perspective from the selfie (same viewpoint, same rotation, same distance feel).
- Keep the EXACT head tilt/turn, eye gaze direction, and facial expression from the selfie.
- Keep the subject’s face and identity perfectly recognizable: same facial proportions, eyes, eyebrows, nose, lips, skin tone, and all distinctive marks (moles/freckles). Do NOT beautify into a different person.

FRAMING:
Upper-body portrait cropped slightly below the bust (just below chest), like an editorial portrait, but KEEP the selfie’s pose and camera perspective.

WARDROBE (REGENCY / BRIDGERTON VIBE):
Transform the outfit into an elegant Regency-era off-shoulder gown:
- Off-shoulder neckline, structured bodice, luxurious satin/silk texture, subtle embroidery, refined seamwork.
- Color palette “tone 8” cold icy blue for the dress (cool blue).

HAIR:
Regency-inspired updo with soft loose curls and a few delicate tendrils; gentle breeze moves only a few strands (subtle, not messy). Keep hair color consistent with the selfie.

ENVIRONMENT:
Outdoor grand palace garden in full bloom:
- A large floral arch directly behind/around the subject, EXTREMELY abundant flowers (dense, pompous, premium).
- Flowers in cool palette: icy blues + whites + hints of lavender, lush greenery, elegant estate garden atmosphere.
- Background softly blurred (bokeh), subject sharp.

LIGHTING / CAMERA LOOK:
High-end cinematic daylight, soft and flattering; realistic skin texture (no plastic skin), sharp focus on eyes, shallow depth of field, premium editorial color grading leaning cool/blue while remaining natural.

DO NOT:
- Do NOT change pose, head angle, face angle, eye direction, or expression.
- Do NOT change the selfie’s camera viewpoint/perspective (no “new” angle, no reposing).
- No extra people, no text, no logos, no watermark, no cartoon/anime look.
- No face swapping with the style reference.

OUTPUT:
Photorealistic, expensive Regency romance drama vibe, Instagram-ready.`
  }
  
  if (!prompt) {
    console.error(`Unknown creative type: ${creativeType}`);
    await ctx.reply('❌ Помилка: невідомий тип креативу.', keyboard.createBackButton('main_menu'));
    userState.delete(userId);
    return true;
  }

  // Вибираємо правильну модель для кожного креативу
  let modelKey;
  if (creativeType === 'love_is') {
    modelKey = 'nano_banana_2k';
  } else if (creativeType === 'hearts') {
    modelKey = 'seedream_4k';
  } else if (creativeType === 'porcelain_figure') {
    modelKey = 'seedream_4k';
  } else if (creativeType === 'kittens') {
    modelKey = 'seedream_4k';
  } else if (creativeType === 'underwater_macro') {
    modelKey = 'seedream_4k';
  } else if (creativeType === 'bridgerton') {
    modelKey = 'seedream_4k';
  } else {
    modelKey = 'nano_banana_4k';
  }
  const model = models.design.models.find(m => m.key === modelKey);

  const creativeNames = {
    love_is: '💌 День Закоханих',
    hearts: '❤️ Льодяник',
  porcelain_figure: '✨ Порцелянова фігурка',
  kittens: '🐱 Котики',
  underwater_macro: '🌊 Підводний макро-портрет',
    bridgerton: '👑 Bridgerton'
  };

  if (!model) {
    await ctx.reply('❌ Помилка: модель не знайдена.', keyboard.createBackButton('main_menu'));
    userState.delete(userId);
    userCurrentModel.delete(userId);
    return true;
  }

  const creativeCost = getEffectiveImageCost(userId, model, modelKey);

  const statusMsg = await ctx.reply(
      `🎨 <b>Генерую ${creativeNames[creativeType]}...</b>\n\n` +
      `📷 Ваше фото отримано\n` +
      `✨ Зберігаю ваші риси обличчя\n` +
      `⏱️ Це займе ~30-40 секунд\n\n` +
      `💰 Списується: ${creativeCost}⚡`,
      { parse_mode: 'HTML' }
  );

  const chatId = ctx.chat.id;
  const username = ctx.from.username || 'unknown';
  const creativeLabel = creativeNames[creativeType] || creativeType;

  // Звільняємо стан одразу, щоб не блокувати користувача
  userState.delete(userId);
  userCurrentModel.delete(userId);

  runBackgroundTask(async () => {
    try {
      let result;

      // Перевіряємо чи можемо використовувати KIE.AI для адміна
      // Перевіряємо чи можемо використовувати KIE.AI
      // Враховуємо вибір користувача з userProviderChoice та централізовану систему доступу
      const userChosenProvider = userProviderChoice.get(userId);
      const canUseKieAI = accessControl.canUseKieAI(userId) && kieAI.isKieAIEnabled;

      // Логіка: провайдер за вибором; love_is → nano_banana_2k, інші → seedream_4k
      const creativeModelKey = modelKey; // 'nano_banana_2k' | 'seedream_4k'
      let useKieAI = false;
      if (userChosenProvider === 'kie-ai') {
        useKieAI = kieAI.isKieAIImplemented(creativeModelKey);
      } else if (userChosenProvider === 'replicate') {
        useKieAI = false;
      } else {
        useKieAI = canUseKieAI && kieAI.isKieAIImplemented(creativeModelKey);
      }

      const providerName = useKieAI ? 'KIE.AI' : 'Replicate';
      console.log(`🎯 Creative generation using ${providerName}: ${creativeType}`);

      // Вибираємо правильну функцію генерації в залежності від креативу
      // По дефолту використовуємо 9:16 для всіх креативів
      if (creativeType === 'hearts') {
        // Hearts використовує Seedream 4K з aspect ratio 9:16
        result = useKieAI
          ? await kieAI.generateWithSeedreamKieAI(prompt, imageUrl, '4K', '9:16', 0.5)
          : await replicate.generateWithSeedream(prompt, imageUrl, '4K', '9:16');
      } else if (creativeType === 'porcelain_figure') {
        // Porcelain figure використовує Seedream 4K з aspect ratio 1:1
        result = useKieAI
          ? await kieAI.generateWithSeedreamKieAI(prompt, imageUrl, '4K', '1:1', 0.5)
          : await replicate.generateWithSeedream(prompt, imageUrl, '4K', '1:1');
      } else if (creativeType === 'kittens') {
        // Kittens використовує Seedream 4K з aspect ratio 1:1
        result = useKieAI
          ? await kieAI.generateWithSeedreamKieAI(prompt, imageUrl, '4K', '1:1', 0.5)
          : await replicate.generateWithSeedream(prompt, imageUrl, '4K', '1:1');
      } else if (creativeType === 'underwater_macro') {
        // Underwater macro використовує Seedream 4K з aspect ratio 16:9
        result = useKieAI
          ? await kieAI.generateWithSeedreamKieAI(prompt, imageUrl, '4K', '16:9', 0.5)
          : await replicate.generateWithSeedream(prompt, imageUrl, '4K', '16:9');
      } else if (creativeType === 'bridgerton') {
        // Bridgerton використовує Seedream 4K з aspect ratio 9:16
        result = useKieAI
          ? await kieAI.generateWithSeedreamKieAI(prompt, imageUrl, '4K', '9:16', 0.5)
          : await replicate.generateWithSeedream(prompt, imageUrl, '4K', '9:16');
      } else if (creativeType === 'love_is') {
        // Love is... використовує NanoBanana 2K з aspect ratio 9:16
        result = useKieAI
          ? await kieAI.generateWithNanoBananaKieAI(prompt, imageUrl, '2K', '9:16', 0.5)
          : await replicate.generateWithNanoBanana(prompt, imageUrl, '2K', '9:16');
      } else {
        // Fallback для інших креативів - теж 9:16
        const resolution = modelKey === 'nano_banana_2k' ? '2K' : '4K';
        result = useKieAI
          ? (resolution === '2K'
              ? await kieAI.generateWithNanoBananaKieAI(prompt, imageUrl, '2K', '9:16', 0.5)
              : await kieAI.generateWithSeedreamKieAI(prompt, imageUrl, '4K', '9:16', 0.5))
          : await replicate.generateWithNanoBanana(prompt, imageUrl, resolution, '9:16');
      }

      if (!result.success) {
        const creativeName = creativeNames[creativeType] || creativeType;
        await adminNotifier.notifyAdmin(
          bot,
          new Error(result.error),
          { userId, username, action: `creative_${creativeType}`, model: creativeName, provider: providerName }
        );
        await bot.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          null,
          `❌ Помилка генерації (${providerName}).\n\nСпробуйте ще раз або оберіть іншу модель.`
        );

        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey,
          success: false,
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100),
          provider: useKieAI ? 'kie' : 'replicate'
        });
        return;
      }

      await userBalance.deductTokens(
        userId,
        creativeCost,
        `${creativeLabel} generation`,
        { modelKey: modelKey, modelName: model.name, apiCost: model.apiCost }
      );

      const isTrialCreative = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey,
        success: true,
        isTrial: isTrialCreative,
        isFree: isTrialCreative,
        provider: useKieAI ? 'kie' : 'replicate'
      });

      // Перевірити розмір файлу
      const fileSize = await getFileSize(result.imageUrl);
      const maxPhotoSize = 10 * 1024 * 1024; // 10MB

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      if (fileSize > maxPhotoSize) {
        // Файл завеликий - віддати посиланням
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        await bot.telegram.sendMessage(
          chatId,
          `✅ <b>${creativeLabel}</b>\n\n` +
          `📊 <b>Розмір:</b> ${fileSizeMB} MB\n` +
          `⚠️ Файл завеликий для Telegram\n\n` +
          `🔗 <a href="${result.imageUrl}">📥 Натисніть для завантаження PNG</a>\n\n` +
          `⚠️ <b>ВАЖЛИВО - ЗАВАНТАЖТЕ ОДРАЗУ!</b>\n` +
          `Посилання активне тільки <b>1 ГОДИНУ</b>!\n` +
          `Після цього файл буде видалений.\n\n` +
          `💾 <b>Як завантажити:</b>\n` +
          `1️⃣ Натисніть на посилання вище\n` +
          `2️⃣ Файл завантажиться\n` +
          `3️⃣ Збережіть на телефон/комп'ютер\n\n` +
          `💰 Витрачено: ${creativeCost}⚡`,
          {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...keyboard.createBackButton('main_menu')
          }
        );
      } else {
        // Файл нормальний - відправити як фото
        await safeSendPhoto(chatId, result.imageUrl, {
          caption: `✅ ${creativeLabel}\n\n💰 Витрачено: ${creativeCost}⚡`,
          ...keyboard.createBackButton('main_menu')
        });
      }
    } catch (error) {
      console.error(`Creative ${creativeType} generation failed:`, error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: `creative_${creativeType}` });
      try {
        await bot.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          null,
          '❌ Помилка генерації. Спробуйте ще раз.'
        );
      } catch (editError) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації. Спробуйте ще раз.');
      }
    }
  }, `creative_${creativeType}`);

  return true;
}
// ==================== CALLBACK HANDLERS ====================

bot.action('gpt_text', async (ctx) => {
  await ctx.answerCbQuery();
  userCurrentModel.set(ctx.from.id, 'claude_text');
  await ctx.reply(
    '✍️ Режим Claude активовано! 💎\n\n' +
    'Надішліть мені ваше запитання, і я відповім текстом.\n\n' +
    '💡 Claude Sonnet 4.5 - найкраща якість\n' +
    '💰 Вартість: 1⚡ за запит\n' +
    '💡 Підказка: Я запам\'ятовую контекст розмови.',
    keyboard.createBackButton()
  );
});

bot.action('gpt_voice', async (ctx) => {
  await ctx.answerCbQuery();
  userCurrentModel.set(ctx.from.id, 'claude_voice');
  await ctx.reply(
    '🎙️ Режим голосової розмови активовано! 🆓\n\n' +
    'Надішліть голосове повідомлення, і я перетворю його в текст та відповім.\n\n' +
    '💡 Groq Whisper - безкоштовна транскрипція\n' +
    '💰 Відповідь через Claude: 1⚡',
    keyboard.createBackButton()
  );
});

bot.action('gpt_image', async (ctx) => {
  await ctx.answerCbQuery();
  userCurrentModel.set(ctx.from.id, 'claude_vision');
  await ctx.reply(
    '🖼️ Режим Claude Vision активовано! 💎\n\n' +
    'Надішліть мені зображення з підписом (або без), і я його проаналізую.\n\n' +
    '💰 Вартість: 3⚡ за аналіз',
    keyboard.createBackButton()
  );
});

bot.action('gpt_sora_watermark_remover', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  console.log('🧹 Sora Watermark Remover action clicked by user:', userId);

  // Отримуємо динамічну ціну з KIE.AI
  const kieAI = require('./services/kie-ai');
  const modelInfo = await kieAI.getModelInfo('sora-watermark-remover');
  const cost = modelInfo?.cost || 10; // Fallback до 10 токенів якщо не вдалося отримати ціну

  console.log('🧹 Sora Watermark: Model info loaded:', {
    cost,
    apiCost: modelInfo?.apiCost,
    modelDescription: modelInfo?.modelDescription
  });

  userCurrentModel.set(userId, 'sora_watermark_remover');
  userState.set(userId, {
    action: 'sora_watermark_remover',
    step: 'waiting_url'
  });

  console.log('🧹 Sora Watermark: State set for user', userId, {
    currentModel: userCurrentModel.get(userId),
    state: userState.get(userId)
  });

  await ctx.reply(
    '🧹 <b>Видалення Sora Watermark</b>\n\n' +
    '📝 <b>Як використовувати:</b>\n' +
    '1. Згенеруйте відео в Sora (sora.chatgpt.com)\n' +
    '2. Скопіюйте URL відео\n' +
    '3. Надішліть URL сюди\n\n' +
    '✅ <b>Підтримувані формати URL:</b>\n' +
    '<code>https://sora.chatgpt.com/p/s_...</code>\n' +
    '<code>https://sora.chatgpt.com/g/gen_...</code>\n\n' +
    '⚠️ <b>Увага:</b> Якщо відео приватне, API може не мати доступу.\n\n' +
    `💰 <b>Вартість:</b> ${cost}⚡\n` +
    '⏱️ <b>Час обробки:</b> ~30-60 секунд\n\n' +
    '📤 Надішліть URL вашого Sora відео:',
    {
      parse_mode: 'HTML',
      ...keyboard.createBackButton('main_menu')
    }
  );
});

bot.action('new_conversation', async (ctx) => {
  await ctx.answerCbQuery('Історію очищено!');
  await userBalance.clearConversationHistory(ctx.from.id);
  await ctx.reply(
    '✅ Нову розмову розпочато! 👋\n\nНадішліть своє повідомлення.',
    keyboard.createGPTActionsMenu(models.gpt.actions)
  );
});

// ==================== ASPECT RATIO SELECTION ====================
bot.action(/^aspect_ratio_(.+?)_(1:1|1:2|2:1|1:3|3:1|4:5|5:4|9:16|10:16|16:10|4:3|3:4|16:9|3:2|2:3|21:9|match_input_image)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const callbackData = ctx.callbackQuery.data;
  const match = callbackData.match(/^aspect_ratio_(.+?)_(1:1|1:2|2:1|1:3|3:1|4:5|5:4|9:16|10:16|16:10|4:3|3:4|16:9|3:2|2:3|21:9|match_input_image)$/);
  const userId = ctx.from.id;

  console.log(`📐 Aspect ratio callback: ${callbackData}`);
  console.log(`📐 User ID: ${userId}`);
  console.log(`📐 Regex match result:`, match);
  console.log(`📐 Current userState Map size:`, userState.size);
  console.log(`📐 All userState keys:`, Array.from(userState.keys()));

  if (!match) {
    console.error('❌ Regex не спрацював');
    await ctx.reply('❌ Помилка обробки запиту.');
    return;
  }

  const modelKey = match[1];
  const aspectRatio = match[2];
  const state = userState.get(userId);

  console.log(`📐 Model: ${modelKey}, Ratio: ${aspectRatio}`);
  console.log(`📐 Retrieved state for userId ${userId}:`, state);

  if (!state || !state.prompt) {
    console.error(`❌ Стан відсутній або неповний. State:`, state);
    await ctx.reply('❌ Помилка. Спробуйте ще раз.');
    userState.delete(userId);
    return;
  }

  console.log(`📐 Aspect ratio selected: ${aspectRatio} for model: ${modelKey}`);

  // Генеруємо з вибраним aspect ratio (у фоні, щоб не блокувати інші апдейти)
  const imageInput = state.imageUrl || null;
  runBackgroundTask(
    () => handleImageGeneration(ctx, state.prompt, modelKey, imageInput, aspectRatio),
    'image_generation_aspect_ratio'
  );

  userState.delete(userId);
});

// ==================== MIDJOURNEY SPECIFIC HANDLERS ====================

// Midjourney - вибір швидкості
bot.action('midjourney', async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const model = models.design.models.find(m => m.key === 'midjourney');

  if (!model || !model.available) {
    await ctx.reply('❌ Модель недоступна');
    return;
  }

  await ctx.reply(
    `🖼️ <b>${model.name}</b>\n\n` +
    `⚡ <b>Крок 1: Оберіть швидкість генерації</b>\n\n` +
    `• 🐢 Relaxed - найдешевше (${model.speeds.relaxed.cost}⚡)\n` +
    `  Час: ~2-3 хвилини\n\n` +
    `• ⚡ Fast - стандарт (${model.speeds.fast.cost}⚡)\n` +
    `  Час: ~1-1.5 хвилини\n\n` +
    `• 🚀 Turbo - найшвидше (${model.speeds.turbo.cost}⚡)\n` +
    `  Час: ~30-60 секунд\n\n` +
    `💡 Всі швидкості генерують 4 варіанти одночасно!\n` +
    `🔍 Upscale і 🎨 Vary - безкоштовно!`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🐢 Relaxed (3⚡)', 'mj_speed_relaxed')],
        [Markup.button.callback('⚡ Fast (7⚡)', 'mj_speed_fast')],
        [Markup.button.callback('🚀 Turbo (14⚡)', 'mj_speed_turbo')],
        [Markup.button.callback('← Назад', 'design_menu')]
      ])
    }
  );
});

// Вибір швидкості Midjourney
bot.action(/^mj_speed_(relaxed|fast|turbo)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const speed = ctx.match[1];
  const model = models.design.models.find(m => m.key === 'midjourney');
  const cost = model.speeds[speed].cost;

  if (!(await userBalance.hasTokens(userId, cost))) {
    await showInsufficientTokens(ctx, cost);
    return;
  }

  // Зберігаємо стан
  userState.set(userId, {
    action: 'midjourney_generation',
    step: 'select_aspect_ratio',
    speed,
    taskType: 'mj_txt2img',
    fileUrls: []
  });

  await ctx.reply(
    `🖼️ Midjourney (${speed})\n\n` +
    `💰 Вартість: ${cost}⚡\n\n` +
    `📐 <b>Крок 2: Оберіть пропорції</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('1:1', `mj_ar_${speed}_1:1`),
          Markup.button.callback('16:9', `mj_ar_${speed}_16:9`),
          Markup.button.callback('9:16', `mj_ar_${speed}_9:16`)
        ],
        [
          Markup.button.callback('4:3', `mj_ar_${speed}_4:3`),
          Markup.button.callback('3:4', `mj_ar_${speed}_3:4`),
          Markup.button.callback('2:1', `mj_ar_${speed}_2:1`)
        ],
        [Markup.button.callback('← Назад', 'midjourney')]
      ])
    }
  );
});

// Вибір aspect ratio Midjourney (новий формат з швидкістю в callback)
bot.action(/^mj_ar_([^_]+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const speed = ctx.match[1];
  const aspectRatio = ctx.match[2];

  const model = models.design.models.find(m => m.key === 'midjourney');
  if (!model || !model.speeds[speed]) {
    await ctx.reply('❌ Помилка: невідома швидкість. Спробуйте ще раз.');
    return;
  }

  const cost = model.speeds[speed].cost;

  // Зберігаємо стан для вибору налаштувань
  userState.set(userId, {
    action: 'midjourney_generation',
    step: 'select_settings',
    speed,
    aspectRatio,
    taskType: 'mj_txt2img',
    fileUrls: [],
    // Дефолтні значення
    stylization: 100,
    weirdness: 0,
    variety: 50
  });

  await ctx.reply(
    `🖼️ Midjourney (${speed})\n\n` +
    `📐 Пропорції: ${aspectRatio}\n` +
    `💰 Вартість: ${cost}⚡\n\n` +
    `⚙️ <b>Крок 3: Розширені налаштування</b>\n\n` +
    `🎨 <b>Stylization:</b> 100 (0-1000)\n` +
    `   Вищі значення = більше художності\n\n` +
    `🌀 <b>Weirdness:</b> 0 (0-3000)\n` +
    `   Вищі значення = більше експериментів\n\n` +
    `🎲 <b>Variety:</b> 50 (0-100)\n` +
    `   Вищі значення = більше різноманітності\n\n` +
    `💡 Дефолтні значення оптимальні для більшості задач`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🎨 Stylization', `mj_set_stylization_${speed}_${aspectRatio}`),
          Markup.button.callback('🌀 Weirdness', `mj_set_weirdness_${speed}_${aspectRatio}`)
        ],
        [
          Markup.button.callback('🎲 Variety', `mj_set_variety_${speed}_${aspectRatio}`)
        ],
        [
          Markup.button.callback('✅ Продовжити з цими налаштуваннями', `mj_settings_done_${speed}_${aspectRatio}`)
        ],
        [Markup.button.callback('← Назад', 'midjourney')]
      ])
    }
  );
});

// Старий обробник для зворотної сумісності зі старими кнопками
bot.action(/^mj_aspect_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const aspectRatio = ctx.match[1];
  const state = userState.get(userId);

  if (!state || state.action !== 'midjourney_generation') {
    await ctx.reply(
      '❌ Сесія застаріла (можливо бот перезапущувався)\n\n' +
      '💡 Почніть заново: Зображення → MidJourney',
      keyboard.createBackButton('design_menu')
    );
    return;
  }

  state.aspectRatio = aspectRatio;
  state.step = 'waiting_prompt';
  userState.set(userId, state);

  const model = models.design.models.find(m => m.key === 'midjourney');
  const cost = model.speeds[state.speed].cost;

  await ctx.reply(
    `🖼️ Midjourney (${state.speed})\n\n` +
    `📐 Пропорції: ${aspectRatio}\n` +
    `💰 Вартість: ${cost}⚡\n\n` +
    `✍️ <b>Крок 3: Опишіть що хочете згенерувати</b>\n\n` +
    `💡 Будьте детальні: опишіть об'єкт, стиль, освітлення, композицію\n\n` +
    `📝 Приклад: "A majestic lion standing on a cliff at sunset, cinematic lighting, photorealistic, 8k"`,
    {
      parse_mode: 'HTML',
      ...keyboard.createBackButton('midjourney')
    }
  );
});

// Налаштування Stylization
bot.action(/^mj_set_stylization_([^_]+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const speed = ctx.match[1];
  const aspectRatio = ctx.match[2];

  console.log(`🔍 [STYLIZATION BUTTON] Callback triggered - userId=${userId}, speed=${speed}, aspectRatio=${aspectRatio}`);

  // Відновлюємо або створюємо стан з параметрів callback
  let state = userState.get(userId);

  // Детальне логування стану
  if (state) {
    console.log(`🔍 [STYLIZATION BUTTON] State found:`, JSON.stringify({
      action: state.action,
      step: state.step,
      speed: state.speed,
      aspectRatio: state.aspectRatio,
      stylization: state.stylization,
      weirdness: state.weirdness,
      variety: state.variety,
      _timestamp: state._timestamp,
      age: state._timestamp ? `${Date.now() - state._timestamp}ms` : 'unknown'
    }, null, 2));
  }

  console.log(`🔍 mj_set_stylization ENTRY - userId: ${userId}, hasState: ${!!state}, action: ${state?.action}, stylization: ${state?.stylization}, step: ${state?.step}, stateTimestamp: ${state?._timestamp}`);

  if (!state || state.action !== 'midjourney_generation') {
    // Створюємо новий стан тільки якщо його немає
    console.log(`⚠️ Creating NEW state for stylization (state=${!!state}, action=${state?.action})`);
    state = {
      action: 'midjourney_generation',
      speed,
      aspectRatio,
      taskType: 'mj_txt2img',
      fileUrls: [],
      stylization: 100,
      weirdness: 0,
      variety: 50,
      _timestamp: Date.now()
    };
    userState.set(userId, state); // Зберігаємо одразу
    console.log(`🔍 [STYLIZATION BUTTON] Created and saved new state`);
  } else {
    // Якщо стан існує, оновлюємо тільки speed і aspectRatio (якщо змінилися)
    const stateAge = Date.now() - (state._timestamp || 0);
    console.log(`✅ Using EXISTING state, age=${stateAge}ms, preserving stylization=${state.stylization}, weirdness=${state.weirdness}, variety=${state.variety}`);
    state.speed = speed;
    state.aspectRatio = aspectRatio;
    state._timestamp = Date.now();
    // Зберігаємо існуючі значення stylization, weirdness, variety
  }

  // Ensure default values if undefined (тільки для нового стану)
  if (state.stylization === undefined) state.stylization = 100;
  if (state.weirdness === undefined) state.weirdness = 0;
  if (state.variety === undefined) state.variety = 50;

  console.log('🔍 mj_set_stylization - userId:', userId, 'current stylization:', state.stylization);

  state.step = 'awaiting_stylization';
  userState.set(userId, state);

  await ctx.reply(
    `🎨 <b>Stylization (0-1000)</b>\n\n` +
    `Поточне значення: ${state.stylization}\n\n` +
    `💡 <b>Що це:</b>\n` +
    `• 0 = мінімум художності, максимум точності\n` +
    `• 100 = збалансовано (рекомендовано)\n` +
    `• 500 = більше творчості\n` +
    `• 1000 = максимум художності\n\n` +
    `📝 Надішліть число від 0 до 1000:`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('midjourney') }
  );
});

// Налаштування Weirdness
bot.action(/^mj_set_weirdness_([^_]+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const speed = ctx.match[1];
  const aspectRatio = ctx.match[2];

  console.log(`🔍 [WEIRDNESS BUTTON] Callback triggered - userId=${userId}, speed=${speed}, aspectRatio=${aspectRatio}`);

  // Відновлюємо або створюємо стан
  let state = userState.get(userId);

  // Детальне логування стану
  if (state) {
    console.log(`🔍 [WEIRDNESS BUTTON] State found:`, JSON.stringify({
      action: state.action,
      step: state.step,
      speed: state.speed,
      aspectRatio: state.aspectRatio,
      stylization: state.stylization,
      weirdness: state.weirdness,
      variety: state.variety,
      _timestamp: state._timestamp,
      age: state._timestamp ? `${Date.now() - state._timestamp}ms` : 'unknown'
    }, null, 2));
  }

  console.log(`🔍 mj_set_weirdness ENTRY - userId: ${userId}, hasState: ${!!state}, action: ${state?.action}, weirdness: ${state?.weirdness}, step: ${state?.step}, stateTimestamp: ${state?._timestamp}`);

  if (!state || state.action !== 'midjourney_generation') {
    // Створюємо новий стан тільки якщо його немає
    console.log(`⚠️ Creating NEW state for weirdness (state=${!!state}, action=${state?.action})`);
    state = {
      action: 'midjourney_generation',
      speed,
      aspectRatio,
      taskType: 'mj_txt2img',
      fileUrls: [],
      stylization: 100,
      weirdness: 0,
      variety: 50,
      _timestamp: Date.now()
    };
    userState.set(userId, state); // Зберігаємо одразу
    console.log(`🔍 [WEIRDNESS BUTTON] Created and saved new state`);
  } else {
    // Якщо стан існує, оновлюємо тільки speed і aspectRatio
    const stateAge = Date.now() - (state._timestamp || 0);
    console.log(`✅ Using EXISTING state, age=${stateAge}ms, preserving stylization=${state.stylization}, weirdness=${state.weirdness}, variety=${state.variety}`);
    state.speed = speed;
    state.aspectRatio = aspectRatio;
    state._timestamp = Date.now();
    // Зберігаємо існуючі значення stylization, weirdness, variety
  }

  // Ensure default values if undefined (тільки для нового стану)
  if (state.stylization === undefined) state.stylization = 100;
  if (state.weirdness === undefined) state.weirdness = 0;
  if (state.variety === undefined) state.variety = 50;

  console.log('🔍 mj_set_weirdness - userId:', userId, 'current weirdness:', state.weirdness);

  state.step = 'awaiting_weirdness';
  userState.set(userId, state);

  await ctx.reply(
    `🌀 <b>Weirdness (0-3000)</b>\n\n` +
    `Поточне значення: ${state.weirdness}\n\n` +
    `💡 <b>Що це:</b>\n` +
    `• 0 = стандартні результати (рекомендовано)\n` +
    `• 500 = помірні експерименти\n` +
    `• 1500 = незвичайні результати\n` +
    `• 3000 = максимум дивності\n\n` +
    `📝 Надішліть число від 0 до 3000:`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('midjourney') }
  );
});

// Налаштування Variety
bot.action(/^mj_set_variety_([^_]+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const speed = ctx.match[1];
  const aspectRatio = ctx.match[2];

  console.log(`🔍 [VARIETY BUTTON] Callback triggered - userId=${userId}, speed=${speed}, aspectRatio=${aspectRatio}`);

  // Відновлюємо або створюємо стан
  let state = userState.get(userId);

  // Детальне логування стану
  if (state) {
    console.log(`🔍 [VARIETY BUTTON] State found:`, JSON.stringify({
      action: state.action,
      step: state.step,
      speed: state.speed,
      aspectRatio: state.aspectRatio,
      stylization: state.stylization,
      weirdness: state.weirdness,
      variety: state.variety,
      _timestamp: state._timestamp,
      age: state._timestamp ? `${Date.now() - state._timestamp}ms` : 'unknown'
    }, null, 2));
  }

  console.log(`🔍 mj_set_variety ENTRY - userId: ${userId}, hasState: ${!!state}, action: ${state?.action}, variety: ${state?.variety}, step: ${state?.step}`);

  if (!state || state.action !== 'midjourney_generation') {
    // Створюємо новий стан тільки якщо його немає
    console.log(`⚠️ Creating NEW state for variety (state=${!!state}, action=${state?.action})`);
    state = {
      action: 'midjourney_generation',
      speed,
      aspectRatio,
      taskType: 'mj_txt2img',
      fileUrls: [],
      stylization: 100,
      weirdness: 0,
      variety: 50,
      _timestamp: Date.now()
    };
    userState.set(userId, state);
    console.log(`🔍 [VARIETY BUTTON] Created and saved new state`);
  } else {
    // Якщо стан існує, оновлюємо тільки speed і aspectRatio
    const stateAge = Date.now() - (state._timestamp || 0);
    console.log(`✅ Using EXISTING state, age=${stateAge}ms, preserving stylization=${state.stylization}, weirdness=${state.weirdness}, variety=${state.variety}`);
    state.speed = speed;
    state.aspectRatio = aspectRatio;
    state._timestamp = Date.now();
    // Зберігаємо існуючі значення stylization, weirdness, variety
  }

  // Ensure default values if undefined (тільки для нового стану)
  if (state.stylization === undefined) state.stylization = 100;
  if (state.weirdness === undefined) state.weirdness = 0;
  if (state.variety === undefined) state.variety = 50;

  console.log('🔍 mj_set_variety - userId:', userId, 'current variety:', state.variety);

  state.step = 'awaiting_variety';
  userState.set(userId, state);

  await ctx.reply(
    `🎲 <b>Variety (0-100)</b>\n\n` +
    `Поточне значення: ${state.variety}\n\n` +
    `💡 <b>Що це:</b>\n` +
    `• 0 = мінімум варіацій між 4 картинками\n` +
    `• 50 = збалансовано (рекомендовано)\n` +
    `• 100 = максимум різноманітності\n\n` +
    `📝 Надішліть число від 0 до 100:`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('midjourney') }
  );
});

// Продовжити з налаштуваннями
bot.action(/^mj_settings_done_([^_]+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const speed = ctx.match[1];
  const aspectRatio = ctx.match[2];

  // Відновлюємо або створюємо стан
  let state = userState.get(userId);
  if (!state || state.action !== 'midjourney_generation') {
    state = {
      action: 'midjourney_generation',
      speed,
      aspectRatio,
      taskType: 'mj_txt2img',
      fileUrls: [],
      stylization: 100,
      weirdness: 0,
      variety: 50
    };
  }

  state.step = 'waiting_prompt';
  userState.set(userId, state);

  const model = models.design.models.find(m => m.key === 'midjourney');
  const cost = model.speeds[speed].cost;

  await ctx.reply(
    `🖼️ Midjourney (${speed})\n\n` +
    `📐 Пропорції: ${aspectRatio}\n` +
    `🎨 Stylization: ${state.stylization || 100}\n` +
    `🌀 Weirdness: ${state.weirdness || 0}\n` +
    `🎲 Variety: ${state.variety || 50}\n` +
    `💰 Вартість: ${cost}⚡\n\n` +
    `✍️ <b>Крок 4: Опишіть що хочете згенерувати</b>\n\n` +
    `💡 Будьте детальні: опишіть об'єкт, стиль, освітлення, композицію\n\n` +
    `📝 Приклад: "A majestic lion standing on a cliff at sunset, cinematic lighting, photorealistic, 8k"`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('midjourney') }
  );
});

// Midjourney Upscale
bot.action(/^mj_upscale_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('🔍 Починаю upscale...');

  const userId = ctx.from.id;
  const taskId = ctx.match[1];
  const imageIndex = parseInt(ctx.match[2]);

  const statusMsg = await ctx.reply(
    `🔍 Виконую Upscale #${imageIndex}...\n\n` +
    `💰 Вартість: безкоштовно!\n` +
    `⏱️ Це займе ~30-60 секунд`
  );

  try {
    const result = await midjourney.upscaleImage(taskId, imageIndex);

    if (!result.success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ Помилка upscale: ${result.error}`
      );
      return;
    }

    // Чекаємо результату
    const finalResult = await midjourney.waitForCompletion(result.taskId);

    if (finalResult.success && finalResult.resultUrls && finalResult.resultUrls.length > 0) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

      await safeSendPhoto(ctx.chat.id, finalResult.resultUrls[0], {
        caption: `✅ Upscale завершено!\n\n💰 Вартість: безкоштовно!`
      });
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ Помилка: ${finalResult.error || 'Не вдалося отримати результат'}`
      );
    }

  } catch (error) {
    console.error('❌ Midjourney upscale error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      '❌ Виникла помилка при upscale'
    );
  }
});

// Midjourney Vary
bot.action(/^mj_vary_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('🎨 Створюю варіації...');

  const userId = ctx.from.id;
  const taskId = ctx.match[1];
  const imageIndex = parseInt(ctx.match[2]);

  const statusMsg = await ctx.reply(
    `🎨 Створюю варіації #${imageIndex}...\n\n` +
    `💰 Вартість: безкоштовно!\n` +
    `⏱️ Це займе ~60-90 секунд`
  );

  try {
    const result = await midjourney.variateImage(taskId, imageIndex);

    if (!result.success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ Помилка vary: ${result.error}`
      );
      return;
    }

    // Чекаємо результату
    const finalResult = await midjourney.waitForCompletion(result.taskId);

    if (finalResult.success && finalResult.resultUrls && finalResult.resultUrls.length > 0) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

      // Відправляємо всі варіації
      for (let i = 0; i < finalResult.resultUrls.length; i++) {
        const imageUrl = finalResult.resultUrls[i];
        const caption = i === 0
          ? `✅ Варіації готові!\n\n💰 Вартість: безкоштовно!`
          : undefined;

        await safeSendPhoto(ctx.chat.id, imageUrl, {
          caption,
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(`🔍 Upscale #${i + 1}`, `mj_upscale_${result.taskId}_${i + 1}`),
              Markup.button.callback(`🎨 Vary #${i + 1}`, `mj_vary_${result.taskId}_${i + 1}`)
            ]
          ])
        });
      }
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ Помилка: ${finalResult.error || 'Не вдалося отримати результат'}`
      );
    }

  } catch (error) {
    console.error('❌ Midjourney vary error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      '❌ Виникла помилка при створенні варіацій'
    );
  }
});

// Design Models
bot.action(/^(flux|nano_banana_free|nano_banana|nano_banana_2k|nano_banana_4k|stable_diffusion|seedream_4k|clarity|recraft_upscale|ideogram|z_image)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const model = models.design.models.find(m => m.key === modelKey);

  if (!model) {
    await ctx.answerCbQuery('Модель не знайдена');
    return;
  }

  if (model.available === false) {
    await ctx.answerCbQuery('❌ Модель тимчасово недоступна', { show_alert: true });
    return;
  }

  // ✅ TRIAL CHECK: Перевірка обмежень для nano_banana_4k
  const trialCheck = await checkTrialRestrictions(ctx.from.id, modelKey);
  if (!trialCheck.allowed) {
    await ctx.answerCbQuery();
    await ctx.reply(
      trialCheck.message,
      { parse_mode: 'HTML', ...keyboard.createSubscriptionsMenu(ctx.from.id) }
    );
    return;
  }
  // Показуємо warning якщо це остання безкоштовна генерація
  if (trialCheck.warning) {
    await ctx.reply(trialCheck.warning, { parse_mode: 'HTML' });
  }

  await ctx.answerCbQuery();

  // 🎁 FREE MODEL CHECK: Nano Banana FREE — перевірка ліміту безкоштовних генерацій
  if (modelKey === 'nano_banana_free') {
    if (!geminiImage.isConfigured) {
      await ctx.reply('❌ Модель тимчасово недоступна (Google API not configured).');
      return;
    }
    const user = await User.findById(ctx.from.id);
    const freeUsed = user?.freeUsage?.nano_banana_free || 0;
    const freeLimit = geminiImage.FREE_GENERATIONS_LIMIT;
    if (freeUsed >= freeLimit) {
      await ctx.reply(
        `🎁 <b>Nano Banana FREE</b>\n\n` +
        `❌ Ви вже використали всі ${freeLimit} безкоштовних генерацій!\n\n` +
        `💡 Спробуйте платні моделі з більшими можливостями:\n` +
        `• 🍌 Nano Banana — 4⚡ за генерацію\n` +
        `• 🍌 Nano Banana PRO 2K — 15⚡\n` +
        `• 🍌 Nano Banana PRO 4K — 20⚡\n\n` +
        `Або поповніть баланс для доступу до всіх моделей! 🚀`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
      );
      return;
    }
  }

  const effectiveCost = getEffectiveImageCost(ctx.from.id, model, modelKey);
  if (model.cost > 0 && !(await userBalance.hasTokens(ctx.from.id, effectiveCost))) {
    await showInsufficientTokens(ctx, effectiveCost);
    return;
  }

  userCurrentModel.set(ctx.from.id, modelKey);

  if (modelKey === 'recraft_upscale') {
    imageGenState.delete(ctx.from.id);
    await ctx.reply(
      `✨ <b>${model.name}</b>\n\n` +
      `🔎 Розумне підвищення якості (upscale)\n\n` +
      `📷 <b>Крок 1:</b> Надішліть зображення\n\n` +
      `💰 Вартість: ${effectiveCost}⚡\n` +
      `⏱️ Час: ~20-40 секунд`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
    );
    return;
  }

  const maxPhotos = model.maxImages || 1;

  // ✅ НОВИЙ ФЛОУ: Зберігаємо стан - чекаємо на референси
  imageGenState.set(ctx.from.id, {
    model: modelKey,
    step: 'waiting_photos',
    photos: []
  });

  const refsStep = `📝 <b>Крок 1:</b> Надішліть референс-зображення (опціонально)\n` +
    `💡 Можна до ${maxPhotos} фото\n\n` +
    `✍️ <b>Крок 2:</b> Введіть промпт\n\n` +
    `Натисніть <b>"Далі до промпту"</b> якщо без референсів.\n\n`;

  // Інструкції для різних моделей (effectiveCost — для KIE-користувачів реальна вартість)
  const messages = {
    clarity: `✨ <b>${model.name}</b>\n\n` +
      `🔮 Покращення якості зображень\n\n` +
      refsStep +
      `💬 Можете додати опис для кращого результату\n\n` +
      `💰 Вартість: ${effectiveCost}⚡\n` +
      `⏱️ Час: ~30-60 секунд`,
    recraft_upscale: `✨ <b>${model.name}</b>\n\n` +
      `🔎 Розроблений для підвищення чіткості та чистоти зображень, Crisp Upscale покращує загальну якість, роблячи візуальні елементи придатними для використання в Інтернеті або друку.\n\n` +
      `📝 <b>Крок 1:</b> Надішліть зображення\n` +
      `✍️ <b>Крок 2:</b> (опціонально) короткий опис\n\n` +
      `Натисніть <b>"Далі до промпту"</b> після фото.\n\n` +
      `💰 Вартість: ${effectiveCost}⚡\n` +
      `⏱️ Час: ~20-40 секунд`,

    stable_diffusion: `🌀 <b>${model.name}</b>\n\n` +
      refsStep +
      `Опишіть детально що хочете згенерувати.\n\n` +
      `💡 Приклад: "A beautiful sunset over mountains, photorealistic, 8k"\n\n` +
      `💰 Вартість: ${effectiveCost}⚡\n` +
      `⏱️ Час: ~30-40 секунд`,

    ideogram: `✏️ <b>${model.name}</b>\n\n` +
      refsStep +
      `Опишіть детально що хочете згенерувати.\n` +
      `💡 Ideogram чудово працює з текстом на зображеннях!\n\n` +
      `💰 Вартість: ${effectiveCost}⚡\n` +
      `⏱️ Час: ~30-40 секунд`,

    nano_banana: `🍌 <b>${model.name}</b>\n\n` +
      refsStep +
      `Опишіть детально що хочете згенерувати.\n` +
      `💰 Вартість: ${effectiveCost}⚡\n` +
      `⏱️ Час: ~20-30 секунд`,

    nano_banana_free: `🍌🎁 <b>Nano Banana FREE</b>\n\n` +
      `🆓 Безкоштовна генерація зображень!\n` +
      `📊 Ліміт: ${geminiImage.FREE_GENERATIONS_LIMIT} генерацій на користувача\n` +
      `🤖 Модель: Gemini 3 Pro Image (Nano Banana Pro)\n\n` +
      refsStep +
      `Опишіть детально що хочете згенерувати.\n` +
      `💡 До ${geminiImage.MAX_REFERENCE_IMAGES} референс-зображень!\n\n` +
      `💰 Вартість: БЕЗКОШТОВНО 🎁\n` +
      `⏱️ Час: ~15-40 секунд`,

    seedream: `🌊 <b>${model.name}</b>\n\n` +
      refsStep +
      `Опишіть детально що хочете згенерувати.\n` +
      `💰 Вартість: ${effectiveCost}⚡\n` +
      `⏱️ Час: ~20-40 секунд`,

    z_image: `⚡ <b>${model.name}</b>\n\n` +
      `🖼️ Найшвидша та найдешевша модель зображень!\n\n` +
      `✍️ Введіть промпт (до 1000 символів)\n\n` +
      `💰 Вартість: ${effectiveCost}⚡\n` +
      `⏱️ Час: ~10-20 секунд`
  };

  // Для nano_banana та seedream моделей використовуємо спільний шаблон
  let messageKey = modelKey;
  if (modelKey === 'nano_banana_free') messageKey = 'nano_banana_free';
  else if (modelKey.startsWith('nano_banana')) messageKey = 'nano_banana';
  if (modelKey.startsWith('seedream')) messageKey = 'seedream';

  const defaultMessage = `🎨 <b>${model.name}</b>\n\n` +
    refsStep +
    `Опишіть що хочете згенерувати.\n\n` +
    `💰 Вартість: ${effectiveCost}⚡`;

  await ctx.reply(
    messages[messageKey] || defaultMessage,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏭️ Далі до промпту', `img_gen_start_${modelKey}`)],
        [Markup.button.callback('← Назад', 'design_menu')]
      ])
    }
  );
});

// ✅ НОВИЙ ФЛОУ: Кнопка "Почати генерацію" (без референсів)
bot.action(/^img_gen_start_(.+)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const userId = ctx.from.id;
  const imgState = imageGenState.get(userId);

  await ctx.answerCbQuery();

  if (!imgState) {
    await ctx.reply('❌ Помилка: стан не знайдено. Почніть заново.', keyboard.createBackButton('design_menu'));
    imageGenState.delete(userId);
    return;
  }

  if ((modelKey === 'clarity' || modelKey === 'recraft_upscale') && (!imgState.photos || imgState.photos.length === 0)) {
    imageGenState.set(userId, { ...imgState, step: 'waiting_photos' });
    await ctx.reply(
      '🔮 <b>Upscaler</b> потребує зображення.\n\n' +
      '📷 Надішліть фото для покращення якості.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
    );
    return;
  }

  if (modelKey === 'recraft_upscale' && imgState.photos && imgState.photos.length > 0 && !imgState.prompt) {
    const prompt = imgState.prompt || 'upscale image';
    const references = normalizeReferenceOrder(imgState.photos || []);
    imageGenState.delete(userId);
    await ctx.reply('🚀 Починаємо upscale...', { parse_mode: 'HTML' });
    runBackgroundTask(
      () => handleImageGeneration(ctx, prompt, modelKey, references.length ? references : null),
      'image_generation_upscale_start'
    );
    return;
  }

  // Якщо промпт ще не введено — переходимо до кроку промпту
  if (!imgState.prompt) {
    imageGenState.set(userId, { ...imgState, step: 'prompt' });

    await ctx.reply(
      `✍️ <b>Крок 2: Введіть промпт</b>\n\n` +
      `Опишіть що хочете згенерувати.\n\n` +
      `💡 Можете детально описати стиль, сцену, об'єкти.`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
    );
    return;
  }

  const prompt = imgState.prompt;
  const references = normalizeReferenceOrder(imgState.photos || []);
  imageGenState.delete(userId);

  await ctx.reply('🚀 Починаємо генерацію...', { parse_mode: 'HTML' });
  runBackgroundTask(
    () => handleImageGeneration(ctx, prompt, modelKey, references.length ? references : null),
    'image_generation_start'
  );
});

// ✅ НОВИЙ ФЛОУ: Кнопка "Додати референси"
bot.action(/^img_gen_refs_(.+)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const userId = ctx.from.id;
  const imgState = imageGenState.get(userId);

  await ctx.answerCbQuery();

  if (!imgState) {
    await ctx.reply('❌ Помилка: стан не знайдено. Почніть заново.', keyboard.createBackButton('design_menu'));
    imageGenState.delete(userId);
    return;
  }

  // Оновлюємо стан - чекаємо на фото (референси)
  imgState.step = 'waiting_photos';
  imgState.photos = imgState.photos || [];
  imageGenState.set(userId, imgState);

  const model = models.design.models.find(m => m.key === modelKey);
  const maxPhotos = model?.maxImages || 1;

  await ctx.reply(
    `📷 <b>Завантажте референс-зображення</b>\n\n` +
    `💡 Можна до ${maxPhotos} фото\n` +
    `✅ Натисніть "Далі до промпту" коли завершите`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏭️ Далі до промпту', `img_gen_start_${modelKey}`)],
        [Markup.button.callback('← Назад', 'design_menu')]
      ])
    }
  );
});


// Video Models
bot.action(/^(kling|kling_v2_6|kling_3|kling_motion|kling_o1_edit|runway_gen4|runway_turbo|veo|sora_2|luma|a2e_motion)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const model = models.video.models.find(m => m.key === modelKey);

  if (!model) {
    await ctx.answerCbQuery('Модель не знайдена');
    return;
  }

  await ctx.answerCbQuery();

  // Kling 3.0 та Sora 2 — тільки при доступі KIE (не показуємо в меню при Replicate, але перевіряємо і при прямому кліку)
  if (KIE_ONLY_VIDEO_MODELS.includes(modelKey) && !canSeeKieOnlyVideoModels(ctx.from.id)) {
    await ctx.reply(
      '🔒 <b>Kling 3.0 / Sora 2</b> доступні тільки при виборі провайдера <b>KIE.AI</b>.\n\n' +
      '👤 Профіль → Вибір провайдера → 🔵 KIE.AI',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ TRIAL CHECK: Перевірка обмежень для безкоштовних користувачів
  const trialCheck = await checkTrialRestrictions(ctx.from.id, modelKey);
  if (!trialCheck.allowed) {
    await ctx.reply(
      trialCheck.message,
      { parse_mode: 'HTML', ...keyboard.createSubscriptionsMenu(ctx.from.id) }
    );
    return;
  }
  // Показуємо warning якщо це остання безкоштовна генерація
  if (trialCheck.warning) {
    await ctx.reply(trialCheck.warning, { parse_mode: 'HTML' });
  }

  let requiredCost = model.cost;
  if (modelKey === 'runway_turbo') {
    const durations = model.durations || [5];
    const minDuration = Math.min(...durations);
    requiredCost = minDuration * getEffectiveRunwayTurboCostPerSecond(ctx.from.id);
  }
  if (modelKey === 'kling_motion') {
    const costs = getEffectiveKlingMotionCosts(ctx.from.id);
    requiredCost = Math.min(...Object.values(costs));
  }
  if (modelKey === 'kling') {
    const durations = model.durations || [5, 10];
    const minDuration = Math.min(...durations);
    requiredCost = minDuration * getEffectiveKlingCostPerSecond(ctx.from.id);
  }
  if (modelKey === 'kling_v2_6') {
    const durations = model.durations || [5, 10];
    const minDuration = Math.min(...durations);
    requiredCost = minDuration * getEffectiveKlingV2_6CostPerSecond(ctx.from.id, model, false);
  }
  if (modelKey === 'kling_3') {
    const durations = model.durations || [3, 5, 8, 10, 15];
    const minDuration = Math.min(...durations);
    requiredCost = minDuration * getEffectiveKling3CostPerSecond(ctx.from.id, 'pro', false);
  }
  if (modelKey === 'sora_2') {
    const durations = model.durations || [4, 8, 12];
    const minDuration = Math.min(...durations);
    requiredCost = getEffectiveSora2Cost(ctx.from.id, model, minDuration);
  }
  if (modelKey === 'veo') {
    requiredCost = getEffectiveVeoFlatCost(ctx.from.id, 'veo3_fast'); // мінімальна ціна = Fast
  }
  if (modelKey === 'kling_o1_edit') {
    const durations = model.durations || [3, 5, 7, 10];
    const minDuration = Math.min(...durations);
    // Мінімальна ціна: std без відео-input
    requiredCost = minDuration * model.costPerSecond;
  }

  if (!(await userBalance.hasTokens(ctx.from.id, requiredCost))) {
    await showInsufficientTokens(ctx, requiredCost);
    return;
  }

  // Для A2E Motion не встановлюємо currentModel, бо це image-to-video модель
  if (modelKey !== 'a2e_motion') {
    userCurrentModel.set(ctx.from.id, modelKey);
  }

  if (modelKey === 'kling_motion') {
    const motionCosts = getEffectiveKlingMotionCosts(ctx.from.id);
    const minCost = Math.min(...Object.values(motionCosts));
    const maxCost = Math.max(...Object.values(motionCosts));

    await ctx.reply(
      `🔥 <b>Kling Motion Control</b>\n\n` +
      `🎬 <b>Крок 1: Оберіть режим якості</b>\n\n` +
      `<b>⚡ STD</b> — Стандартний (швидше, дешевше)\n` +
      `<b>💎 PRO</b> — Професійний (вища якість)\n\n` +
      `💰 Вартість: ${minCost}—${maxCost}⚡`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⚡ STD', 'motion_mode_std'),
            Markup.button.callback('💎 PRO', 'motion_mode_pro')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  if (modelKey === 'kling_o1_edit') {
    const durations = model.durations || [3, 5, 7, 10];
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    const minCostStd = minDuration * model.costPerSecond;
    const maxCostPro = maxDuration * model.costPerSecondProWithVideo;

    userState.set(ctx.from.id, {
      action: 'kling_o1_edit_generation',
      step: 'select_mode',
      modelKey: 'kling_o1_edit'
    });

    await ctx.reply(
      `✂️ <b>Kling O1 Edit</b>\n\n` +
      `Редагування відео через природну мову: зміна персонажів, середовища, стилю зі збереженням руху та таймінгу.\n\n` +
      `📐 <b>Крок 1: Оберіть режим якості</b>\n\n` +
      `⚡ <b>STD</b> — стандартний (швидше, дешевше)\n` +
      `💎 <b>PRO</b> — професійний (вища якість)\n\n` +
      `💰 Орієнтовно: ${minCostStd}—${maxCostPro}⚡\n` +
      `(залежить від тривалості відео та наявності відео-input)`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⚡ STD', 'kling_o1_mode_std'),
            Markup.button.callback('💎 PRO', 'kling_o1_mode_pro')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // A2E Motion без омеженнь 🔥
  if (modelKey === 'a2e_motion') {
    try {
      const a2eService = require('./services/a2e');
      console.log('🔥 A2E Motion: Service loaded, isA2EEnabled:', a2eService.isA2EEnabled);
      
      if (!a2eService.isA2EEnabled) {
        await ctx.reply(
          '❌ A2E API тимчасово вимкнена. Додайте A2E_API_TOKEN в .env.',
          keyboard.createBackButton('video_menu')
        );
        return;
      }

      const durations = model.durations || [5, 10, 15, 20];
      const minDuration = Math.min(...durations);
      const maxDuration = Math.max(...durations);
      const minCost = minDuration * model.costPerSecond;
      const maxCost = maxDuration * model.costPerSecond;

      console.log('🔥 A2E Motion: Setting state for user', ctx.from.id);
      userState.set(ctx.from.id, {
        action: 'a2e_motion_generation',
        step: 'waiting_image',
        modelKey: 'a2e_motion'
      });

      await ctx.reply(
        `🔥 <b>Motion без омеженнь</b>\n\n` +
        `Анімація зображення з природним рухом та плавними переходами.\n\n` +
        `⏱️ Тривалість: ${durations.join(', ')} секунд\n` +
        `💰 Вартість: ${minCost}—${maxCost}⚡\n\n` +
        `🚫 <b>Заборонено надсилати:</b>\n` +
        `• зображення неповнолітніх у будь-якому сексуальному контексті\n` +
        `• насильницький або незаконний контент\n` +
        `• матеріали, що порушують права третіх осіб\n\n` +
        `Користуючись сервісом, ви погоджуєтесь з правилами провайдера:\n` +
        `🔗 https://a2e.ai/a2e-terms-of-use/\n\n` +
        `⚠️ Порушення призведе до блокування без повернення коштів.\n\n` +
        `🖼️ <b>Крок 1: Надішліть зображення</b>\n` +
        `📤 <b>Надішліть одне зображення:</b>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('← Назад', 'video_menu')]
          ])
        }
      );
      return;
    } catch (error) {
      console.error('A2E Motion error:', error);
      await ctx.reply(
        '❌ Помилка ініціалізації A2E Motion. Перевірте налаштування.',
        keyboard.createBackButton('video_menu')
      );
      return;
    }
  }

  // Для Kling 3.0 (KIE.AI) — тільки якщо є доступ до KIE та KIE увімкнена
  if (modelKey === 'kling_3') {
    if (!kieAI.isKieAIEnabled) {
      await ctx.reply('❌ KIE.AI тимчасово вимкнена. Додайте KIE_AI_API_KEY в .env.', keyboard.createBackButton('video_menu'));
      return;
    }
    if (!accessControl.canUseKieAI(ctx.from.id)) {
      await ctx.reply(
        '🔒 Генерації через KIE.AI (Kling 3.0 тощо) поки доступні тільки адміністратору.\n\n' +
        'Доступ керується змінною KIE_AI_ACCESS у .env (admin_only / all_users).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    const durations = model.durations || [3, 5, 8, 10, 15];
    const noAudioSec = getEffectiveKling3CostPerSecond(ctx.from.id, 'pro', false);
    const audioSec = getEffectiveKling3CostPerSecond(ctx.from.id, 'pro', true);
    const minCost = Math.min(...durations) * noAudioSec;
    const maxCost = Math.max(...durations) * audioSec;

    userState.set(ctx.from.id, {
      action: 'kling_3_generation',
      step: 'select_mode',
      modelKey: 'kling_3'
    });

    await ctx.reply(
      `🎭 <b>Kling 3.0 Pro 💎</b>\n\n` +
      `Відео за описом: один опис або кілька сцен, опційно перший кадр і елементи @ім’я.\n\n` +
      `📐 <b>Крок 1: Оберіть режим якості</b> (натисніть одну з кнопок):\n\n` +
      `⚡ <b>STD</b> — швидше, дешевше\n` +
      `💎 <b>PRO</b> — вища якість\n\n` +
      `💰 Орієнтовно: ${minCost}—${maxCost}⚡`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⚡ STD', 'kling_3_mode_std'),
            Markup.button.callback('💎 PRO', 'kling_3_mode_pro')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Для Kling показуємо спеціальне меню з вибором тривалості
  if (modelKey === 'kling' || modelKey === 'kling_v2_6') {
    const durations = model.durations || [5];
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    const costPerSecNo = modelKey === 'kling_v2_6' ? getEffectiveKlingV2_6CostPerSecond(ctx.from.id, model, false) : getEffectiveKlingCostPerSecond(ctx.from.id);
    const costPerSecAud = modelKey === 'kling_v2_6' ? getEffectiveKlingV2_6CostPerSecond(ctx.from.id, model, true) : getEffectiveKlingCostPerSecond(ctx.from.id);
    const minCost = minDuration * costPerSecNo;
    const maxCost = maxDuration * costPerSecAud;
    const durationButtons = durations.map(d =>
      Markup.button.callback(
        modelKey === 'kling_v2_6' ? `${d} сек (${d * costPerSecNo}—${d * costPerSecAud}⚡)` : `${d} сек (${d * costPerSecNo}⚡)`,
        `kling_duration_${d}`
      )
    );

    userState.set(ctx.from.id, {
      action: 'kling_generation',
      step: 'select_duration',
      modelKey
    });

    await ctx.reply(
      `<b>${model.name}</b>\n\n` +
      `📐 <b>Крок 1: Оберіть тривалість відео</b>\n\n` +
      `⏱️ <b>${minDuration} секунд</b> — ${minCost}⚡\n` +
      `⏱️ <b>${maxDuration} секунд</b> — ${maxCost}⚡\n\n` +
      `📊 Якість: 1080p\n` +
      `💰 Вартість: ${minCost}—${maxCost}⚡`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          durationButtons,
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Для Runway Turbo показуємо флоу: image -> параметри -> промпт
  if (modelKey === 'runway_turbo') {
    const durations = model.durations || [5];
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    const costPerSec = getEffectiveRunwayTurboCostPerSecond(ctx.from.id);
    const minCost = minDuration * costPerSec;
    const maxCost = maxDuration * costPerSec;
    const aspectRatios = model.aspectRatios || ['16:9'];
    const defaultAspect = aspectRatios[0];
    userState.set(ctx.from.id, {
      action: 'runway_turbo_generation',
      step: 'waiting_image',
      duration: minDuration,
      aspectRatio: defaultAspect
    });

    await ctx.reply(
      `🎬 <b>Runway Gen-4 Turbo</b>\n\n` +
      `🖼️ <b>Крок 1: Додайте початкове зображення</b>\n\n` +
      `Це перший кадр відео.\n\n` +
      `⏱️ Тривалість: ${minDuration}-${maxDuration} сек\n` +
      `💰 Вартість: ${minCost.toFixed(1)}—${maxCost.toFixed(1)}⚡\n\n` +
      `📐 Поточні налаштування:\n` +
      `• Тривалість: ${minDuration} сек\n` +
      `• Пропорції: ${defaultAspect}\n\n` +
      `📤 Надішліть одне зображення:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Для Veo показуємо спеціальне меню з вибором якості моделі (Крок 1)
  if (modelKey === 'veo') {
    const costFast = getEffectiveVeoFlatCost(ctx.from.id, 'veo3_fast');
    const costQuality = getEffectiveVeoFlatCost(ctx.from.id, 'veo3');

    await ctx.reply(
      `🌟 <b>Google Veo 3.1 💎</b>\n\n` +
      `🎯 <b>Крок 1: Оберіть якість моделі</b>\n\n` +
      `<b>⚡ Fast</b> — швидка генерація, хороша якість\n` +
      `💰 ${costFast}⚡ за відео\n\n` +
      `<b>💎 Quality</b> — найвища якість, довше генерує\n` +
      `💰 ${costQuality}⚡ за відео\n\n` +
      `🔊 Аудіо включено за замовчуванням\n` +
      `⏱️ Тривалість: 4, 6 або 8 секунд`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`⚡ Fast (${costFast}⚡)`, 'veo_model_fast')],
          [Markup.button.callback(`💎 Quality (${costQuality}⚡)`, 'veo_model_quality')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Для Sora 2 показуємо вибір тривалості
  if (modelKey === 'sora_2') {
    if (!model.costPerSecond || model.costPerSecond <= 0) {
      await ctx.reply(
        '⚠️ Sora 2 тимчасово недоступна — не задано ціну.\n' +
        'Оновіть costPerSecond/apiCostPerSecond у config/models.js.',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    const durations = model.durations || [4, 8, 12];
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    const minCost = durations.reduce((acc, d) => Math.min(acc, getEffectiveSora2Cost(ctx.from.id, model, d)), Infinity);
    const maxCost = durations.reduce((acc, d) => Math.max(acc, getEffectiveSora2Cost(ctx.from.id, model, d)), 0);
    const durationButtons = durations.map(d => ([
      Markup.button.callback(`${d} сек (${getEffectiveSora2Cost(ctx.from.id, model, d)}⚡)`, `sora_duration_${d}`)
    ]));

    userState.set(ctx.from.id, {
      action: 'sora_generation',
      step: 'select_duration',
      modelKey
    });

    await ctx.reply(
      `<b>${model.name}</b>\n\n` +
      `📐 <b>Крок 1: Оберіть тривалість відео</b>\n\n` +
      `⏱️ ${minDuration}-${maxDuration} секунд\n` +
      `💰 Вартість: ${minCost}—${maxCost}⚡\n` +
      `🖼️ Опціонально: стартове зображення\n` +
      `📐 Пропорції: portrait / landscape`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          ...durationButtons,
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Розрахунок ефективної вартості для відображення у повідомленнях
  let displayCost = model.cost;
  if (modelKey === 'runway_turbo') {
    displayCost = 5 * getEffectiveRunwayTurboCostPerSecond(ctx.from.id);
  } else if (modelKey === 'runway_gen4') {
    displayCost = 10 * getEffectiveRunwayTurboCostPerSecond(ctx.from.id);
  } else if (modelKey === 'luma') {
    displayCost = 5 * (model.costPerSecond || (model.cost / 5));
  }

  const messages = {

    runway_turbo: `${model.name}\n\n🎬 Image-to-Video ONLY ⚠️\n\n⚠️ ОБОВ'ЯЗКОВО: Надішліть зображення + текстовий опис\n\n📝 Опис має містити деталі руху/анімації\n🖼️ Зображення стане першим кадром відео\n\n💡 Приклад:\n"Camera slowly zooms in, person turns head to the left"\n\n⏱️ Генерація: 1-3 хвилини\n💰 Вартість: ${displayCost}⚡\n📊 Якість: 720p, 5 секунд\n⚡ Найшвидша модель!`,

    runway_gen4: `${model.name}\n\n🎬 Image-to-Video ONLY ⚠️\n\n⚠️ ОБОВ'ЯЗКОВО: Надішліть зображення + текстовий опис\n\n📝 Опис має містити деталі руху/анімації\n🖼️ Зображення стане першим кадром відео\n\n💡 Приклад:\n"Slow motion, waves crashing, cinematic"\n\n⏱️ Генерація: 3-5 хвилин\n💰 Вартість: ${displayCost}⚡\n📊 Якість: 1080p, 10 секунд\n💎 Найвища якість!`,

    luma: `${model.name}\n\n🌊 Text-to-Video і Image-to-Video\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для створення відео\n\n⏱️ Генерація: 2-4 хвилини\n💰 Вартість: ${displayCost}⚡\n📊 Якість: 1080p, 5 секунд`
  };

  await ctx.reply(
    messages[modelKey] || `${model.name}\n\nНадішліть текстовий опис відео або зображення з підписом.\n\n⏱️ Генерація: 2-5 хвилин\n💰 Вартість: ${displayCost}⚡`,
    keyboard.createBackButton('video_menu')
  );
});

// ==================== KLING 3.0 (KIE.AI) CALLBACKS ====================

// Крок 1: Режим (std / pro)
bot.action(/^kling_3_mode_(std|pro)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const mode = ctx.match[1];
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_3_generation' || state.step !== 'select_mode') {
    await ctx.reply('❌ Помилка. Почніть заново: Відео → Kling 3.0 Pro 💎');
    return;
  }

  const model = models.video.models.find(m => m.key === 'kling_3');
  const durations = model.durations || [3, 5, 8, 10, 15];
  const costNoAud = getEffectiveKling3CostPerSecond(userId, mode, false);
  const costAud = getEffectiveKling3CostPerSecond(userId, mode, true);
  const durationButtons = durations.map(d => {
    const costNoAudio = d * costNoAud;
    const costAudio = d * costAud;
    return Markup.button.callback(`${d}с (${costNoAudio}—${costAudio}⚡)`, `kling_3_duration_${d}`);
  });

  userState.set(userId, { ...state, mode, step: 'select_shot_type' });

  await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎</b>\n\n` +
    `Режим: <b>${mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n\n` +
    `📽️ <b>Оберіть тип відео</b> (натисніть кнопку):\n\n` +
    `• <b>Один опис</b> — одне відео за одним текстом.\n` +
    `• <b>Кілька сцен</b> — відео з кількома частинами (у кожної свій опис і тривалість).`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('1️⃣ Один опис', 'kling_3_shot_single')],
        [Markup.button.callback('🎬 Кілька сцен', 'kling_3_shot_multi')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Single-shot → вибір тривалості
bot.action('kling_3_shot_single', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  if (!state || state.action !== 'kling_3_generation' || state.step !== 'select_shot_type') return;

  const model = models.video.models.find(m => m.key === 'kling_3');
  const costNo = getEffectiveKling3CostPerSecond(userId, state.mode, false);
  const costAud = getEffectiveKling3CostPerSecond(userId, state.mode, true);
  const durations = model.durations || [3, 5, 8, 10, 15];
  const durationButtons = durations.map(d => {
    const costNoAudio = d * costNo;
    const costAudio = d * costAud;
    return Markup.button.callback(`${d}с (${costNoAudio}—${costAudio}⚡)`, `kling_3_duration_${d}`);
  });

  userState.set(userId, { ...state, multiShots: false, step: 'select_duration' });

  await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎</b> — один опис\n\n` +
    `⏱️ <b>Крок 2: Скільки секунд матиме відео?</b>\n\n` +
    `Оберіть тривалість від 3 до 15 секунд.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        durationButtons,
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Multi-shot → кількість сцен
bot.action('kling_3_shot_multi', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  if (!state || state.action !== 'kling_3_generation' || state.step !== 'select_shot_type') return;

  userState.set(userId, { ...state, multiShots: true, multiPrompt: [], sceneIndex: 0, step: 'select_scene_count' });

  await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎</b> — кілька сцен\n\n` +
    `Скільки сцен буде у відео? Кожна сцена матиме свій опис і тривалість (1–12 сек).`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('2', 'kling_3_scenes_2'),
          Markup.button.callback('3', 'kling_3_scenes_3'),
          Markup.button.callback('4', 'kling_3_scenes_4'),
          Markup.button.callback('5', 'kling_3_scenes_5')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Multi: обрано кількість сцен
bot.action(/^kling_3_scenes_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const sceneCount = parseInt(ctx.match[1], 10);
  if (!state || state.action !== 'kling_3_generation' || state.step !== 'select_scene_count') return;

  userState.set(userId, { ...state, sceneCount, step: 'waiting_scene_prompt' });

  await ctx.reply(
    `🎬 Сцен: <b>${sceneCount}</b>\n\n` +
    `Опишіть <b>сцену 1</b> текстом (що має відбуватися в цій частині відео).`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Multi-shot: тривалість сцени (1–12)
bot.action(/^kling_3_scene_dur_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const duration = parseInt(ctx.match[1], 10);
  if (!state || state.action !== 'kling_3_generation' || state.step !== 'select_scene_duration') return;

  const multiPrompt = [...(state.multiPrompt || []), { prompt: state.pendingScenePrompt || '', duration }];
  const sceneIndex = (state.sceneIndex || 0) + 1;
  const sceneCount = state.sceneCount || 2;

  if (sceneIndex >= sceneCount) {
    const totalDuration = multiPrompt.reduce((sum, s) => sum + (s.duration || 0), 0);
    userState.set(userId, {
      ...state,
      multiPrompt,
      sceneIndex,
      duration: Math.min(15, Math.max(3, totalDuration)),
      step: 'select_aspect'
    });
    await ctx.reply(
      `🎬 Усі ${sceneCount} сцен задано.\n\n` +
      `📐 <b>Пропорції відео</b>: 16:9, 9:16 або 1:1.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🎬 16:9', 'kling_3_aspect_16:9'),
            Markup.button.callback('📱 9:16', 'kling_3_aspect_9:16')
          ],
          [Markup.button.callback('⬜ 1:1', 'kling_3_aspect_1:1')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  userState.set(userId, {
    ...state,
    multiPrompt,
    sceneIndex,
    pendingScenePrompt: null,
    step: 'waiting_scene_prompt'
  });
  await ctx.reply(
    `Опишіть <b>сцену ${sceneIndex + 1}</b> текстом.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Крок 2: Тривалість (single-shot)
bot.action(/^kling_3_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const duration = parseInt(ctx.match[1], 10);
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_3_generation' || state.step !== 'select_duration') {
    await ctx.reply('❌ Помилка. Почніть заново: Відео → Kling 3.0 Pro 💎');
    return;
  }

  userState.set(userId, { ...state, duration, step: 'select_aspect' });

  await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎</b>\n\n` +
    `⏱️ Тривалість: <b>${duration} сек</b>\n\n` +
    `📐 <b>Крок 3: Формат відео</b> (оберіть кнопку):\n\n` +
    `16:9 — горизонтальне | 9:16 — вертикальне | 1:1 — квадрат`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🎬 16:9', 'kling_3_aspect_16:9'),
          Markup.button.callback('📱 9:16', 'kling_3_aspect_9:16')
        ],
        [Markup.button.callback('⬜ 1:1', 'kling_3_aspect_1:1')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 3: Пропорції
bot.action(/^kling_3_aspect_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const aspectRatio = ctx.match[1];
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_3_generation' || state.step !== 'select_aspect') {
    await ctx.reply('❌ Помилка. Почніть заново: Відео → Kling 3.0 Pro 💎');
    return;
  }

  const model = models.video.models.find(m => m.key === 'kling_3');
  const costPerSecAud = getEffectiveKling3CostPerSecond(userId, state.mode, true);
  const costPerSecNo = getEffectiveKling3CostPerSecond(userId, state.mode, false);
  const costWithAudio = state.duration * costPerSecAud;
  const costNoAudio = state.duration * costPerSecNo;

  // Multi-shot: API вимагає sound 'on', не питаємо — одразу далі з generateAudio: true
  if (state.multiShots) {
    userState.set(userId, {
      ...state,
      aspectRatio,
      generateAudio: true,
      kling3Cost: costWithAudio,
      step: 'ask_start_image'
    });
    await ctx.reply(
      `🎭 <b>Kling 3.0 Pro 💎</b>\n\n` +
      `📐 Пропорції: <b>${aspectRatio}</b>\n\n` +
      `🔊 Для кількох сцен звук завжди увімкнено.\n` +
      `💰 Вартість: <b>${costWithAudio}⚡</b>\n\n` +
      `🖼️ <b>Крок 5: Перший кадр</b> (оберіть кнопку):\n\n` +
      `• <b>Завантажу зображення</b> — фото стане першим кадром, AI його анімує.\n` +
      `• <b>Без зображення</b> — відео тільки за текстовим описом.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🖼️ Завантажу зображення', 'kling_3_add_start_image')],
          [Markup.button.callback('⏭️ Без зображення', 'kling_3_skip_start_image')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  userState.set(userId, { ...state, aspectRatio, step: 'select_audio' });

  await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎</b>\n\n` +
    `📐 Пропорції: <b>${aspectRatio}</b>\n\n` +
    `🔊 <b>Крок 4: Звук</b> (оберіть кнопку):\n\n` +
    `З аудіо — звукові ефекти | Без аудіо — тільки картинка`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`🔊 З аудіо (${costWithAudio}⚡)`, 'kling_3_audio_on')],
        [Markup.button.callback(`🔇 Без аудіо (${costNoAudio}⚡)`, 'kling_3_audio_off')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 4: Аудіо
bot.action(/^kling_3_audio_(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const sound = ctx.match[1] === 'on';

  if (!state || state.action !== 'kling_3_generation' || state.step !== 'select_audio') {
    await ctx.reply('❌ Помилка. Почніть заново: Відео → Kling 3.0 Pro 💎');
    return;
  }

  const model = models.video.models.find(m => m.key === 'kling_3');
  const costPerSec = getEffectiveKling3CostPerSecond(userId, state.mode, sound);
  const kling3Cost = state.duration * costPerSec;

  userState.set(userId, {
    ...state,
    generateAudio: sound,
    kling3Cost,
    step: 'ask_start_image'
  });

  await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎</b>\n\n` +
    `🔊 Звук: <b>${sound ? 'Так' : 'Ні'}</b>\n` +
    `💰 Вартість: <b>${kling3Cost}⚡</b>\n\n` +
    `🖼️ <b>Крок 5: Перший кадр</b> (оберіть кнопку):\n\n` +
    `• <b>Завантажу зображення</b> — фото стане першим кадром, AI його анімує.\n` +
    `• <b>Без зображення</b> — відео тільки за текстовим описом.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🖼️ Завантажу зображення', 'kling_3_add_start_image')],
        [Markup.button.callback('⏭️ Без зображення', 'kling_3_skip_start_image')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 5: Стартове зображення — пропустити → переходимо до елементів (або промпту)
bot.action('kling_3_skip_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_3_generation' || state.step !== 'ask_start_image') {
    return;
  }

  userState.set(userId, { ...state, elements: state.elements || [], step: 'ask_elements' });

  await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎</b>\n\n` +
      `🔗 <b>Елементи</b> (оберіть кнопку):\n\n` +
      `• <b>Додати елемент</b> — додати фото/відео з ім’ям (наприклад @dog), щоб посилатись у описі.\n` +
      `• <b>Пропустити</b> — перейти одразу до текстового опису відео.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Додати елемент', 'kling_3_add_element')],
        [Markup.button.callback('⏭️ Пропустити → до опису', 'kling_3_skip_elements')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 5: Стартове зображення — чекаємо фото
bot.action('kling_3_add_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_3_generation' || state.step !== 'ask_start_image') {
    return;
  }

  userState.set(userId, { ...state, step: 'waiting_start_image' });

  await ctx.reply(
    `🖼️ <b>Надішліть одне фото</b>\n\n` +
    `Воно стане першим кадром. Після цього можна додати елементи та опис відео.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Елементи: пропустити → перехід до промпту (single) або ready_multi (multi-shot)
bot.action('kling_3_skip_elements', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_3_generation') return;
  if (state.step !== 'ask_elements' && state.step !== 'waiting_element_media') return;

  if (state.multiShots && state.multiPrompt?.length) {
    const totalDuration = state.multiPrompt.reduce((s, x) => s + (x.duration || 0), 0);
    const costPerSec = getEffectiveKling3CostPerSecond(userId, state.mode, state.generateAudio);
    const kling3Cost = state.kling3Cost || (totalDuration * costPerSec);
    userState.set(userId, { ...state, step: 'ready_multi', currentElement: null, kling3Cost });
    await ctx.reply(
      `🎬 <b>Кілька сцен</b> налаштовано.\n\n` +
      `Сцен: ${state.multiPrompt.length}. Сумарна тривалість: ${totalDuration} сек. Вартість: ${kling3Cost}⚡.\n\n` +
      `Натисніть «Старт», щоб почати генерацію.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('▶️ Старт генерації', 'kling_3_generate_multi')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  userState.set(userId, { ...state, step: 'waiting_prompt', currentElement: null });

  const elementsHint = (state.elements || []).length > 0
    ? `\n\nВи додали елементи: ${(state.elements || []).map(e => `@${e.name}`).join(', ')}. Використовуйте їх у описі, наприклад: «собака біжить @${state.elements[0].name}». `
    : '';

  await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎</b>\n\n` +
    `✍️ <b>Опишіть відео текстом</b>\n\n` +
    `Напишіть, що має відбуватися на екрані: рух, сцена, дії.${elementsHint}\nЧим детальніше — тим краще результат.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Елементи: додати елемент → просимо ім’я
bot.action('kling_3_add_element', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_3_generation') return;
  if (state.step !== 'ask_elements') return;

  userState.set(userId, { ...state, step: 'waiting_element_name' });

  await ctx.reply(
    `🔗 <b>Ім’я елемента</b>\n\n` +
    `Напишіть одне слово або коротке ім’я латиницею (наприклад: dog, cat, hero). У описі відео ви посилатиметесь на нього так: <b>@dog</b>.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Multi-shot: старт генерації
bot.action('kling_3_generate_multi', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  if (!state || state.action !== 'kling_3_generation' || state.step !== 'ready_multi') return;
  runBackgroundTask(() => generateKling3Video(ctx, state), 'kling_3_generate_multi');
});

// ==================== VEO 3.1 CALLBACKS ====================

// Крок 1: Вибір якості моделі (Fast / Quality)
bot.action(/^veo_model_(fast|quality)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const veoModel = ctx.match[1] === 'quality' ? 'veo3' : 'veo3_fast';
  const veoModelLabel = veoModel === 'veo3' ? '💎 Quality' : '⚡ Fast';
  const veoCost = getEffectiveVeoFlatCost(userId, veoModel);

  userState.set(userId, {
    action: 'veo_generation',
    step: 'select_aspect',
    veoModel: veoModel,
    duration: 8,
    generateAudio: true,
    lastFrame: null
  });

  await ctx.reply(
    `🌟 <b>Google Veo 3.1 💎</b>\n` +
    `🎯 Модель: <b>${veoModelLabel}</b> | 💰 ${veoCost}⚡\n\n` +
    `📐 <b>Крок 2: Оберіть пропорції відео</b>\n\n` +
    `<b>🎬 16:9</b> — YouTube, кіно, горизонтальне\n` +
    `<b>📱 9:16</b> — TikTok, Reels, Stories`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎬 16:9 (Горизонтальне)', 'veo_aspect_16:9')],
        [Markup.button.callback('📱 9:16 (Вертикальне)', 'veo_aspect_9:16')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 2: Вибір aspect ratio
bot.action(/^veo_aspect_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const aspectRatio = ctx.match[1]; // "16:9" або "9:16"
  const state = userState.get(userId);

  // Якщо немає стейту від Крок 1 — створюємо з default (fast)
  const veoModel = state?.veoModel || 'veo3_fast';
  const veoModelLabel = veoModel === 'veo3' ? '💎 Quality' : '⚡ Fast';
  const veoCost = getEffectiveVeoFlatCost(userId, veoModel);

  userState.set(userId, {
    ...(state || {}),
    action: 'veo_generation',
    step: 'select_duration',
    aspectRatio: aspectRatio,
    veoModel: veoModel,
    duration: 8,
    generateAudio: true,
    lastFrame: null
  });

  await ctx.reply(
    `🌟 <b>Google Veo 3.1 💎</b>\n` +
    `🎯 Модель: <b>${veoModelLabel}</b> | 📐 ${aspectRatio === '16:9' ? '🎬 Горизонтальне' : '📱 Вертикальне'}\n` +
    `💰 Вартість: <b>${veoCost}⚡</b>\n\n` +
    `⏱️ <b>Крок 3: Оберіть тривалість відео</b>\n\n` +
    `💡 Ціна однакова незалежно від тривалості`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`4сек`, 'veo_duration_4'),
          Markup.button.callback(`6сек`, 'veo_duration_6'),
          Markup.button.callback(`8сек`, 'veo_duration_8')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 3: Вибір тривалості
bot.action(/^veo_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const duration = parseInt(ctx.match[1]);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Veo 3.1');
    return;
  }

  const veoModel = state.veoModel || 'veo3_fast';
  const veoModelLabel = veoModel === 'veo3' ? '💎 Quality' : '⚡ Fast';
  const veoCost = getEffectiveVeoFlatCost(userId, veoModel);

  userState.set(userId, {
    ...state,
    duration: duration,
    step: 'select_audio'
  });

  await ctx.reply(
    `🌟 <b>Google Veo 3.1 💎</b>\n` +
    `🎯 ${veoModelLabel} | ${state.aspectRatio === '16:9' ? '🎬' : '📱'} ${state.aspectRatio} | ⏱️ ${duration}сек\n` +
    `💰 Вартість: <b>${veoCost}⚡</b>\n\n` +
    `🔊 <b>Крок 4: Аудіо</b>\n\n` +
    `Veo 3.1 генерує звук за замовчуванням.\n` +
    `Можете вимкнути якщо не потрібно.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`🔊 З аудіо (${veoCost}⚡)`, 'veo_audio_on')],
        [Markup.button.callback(`🔇 Без аудіо (${veoCost}⚡)`, 'veo_audio_off')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 4: Вибір аудіо
bot.action(/^veo_audio_(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const generateAudio = ctx.match[1] === 'on';

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Veo 3.1');
    return;
  }

  const veoModel = state.veoModel || 'veo3_fast';
  const veoModelLabel = veoModel === 'veo3' ? '💎 Quality' : '⚡ Fast';
  const veoCost = getEffectiveVeoFlatCost(userId, veoModel);

  userState.set(userId, {
    ...state,
    generateAudio: generateAudio,
    veoCost: veoCost,
    step: 'ask_start_image'
  });

  await ctx.reply(
    `🌟 <b>Google Veo 3.1 💎</b>\n` +
    `🎯 ${veoModelLabel} | ${state.aspectRatio === '16:9' ? '🎬' : '📱'} ${state.aspectRatio} | ⏱️ ${state.duration}сек | ${generateAudio ? '🔊' : '🔇'}\n` +
    `💰 Вартість: <b>${veoCost}⚡</b>\n\n` +
    `🖼️ <b>Крок 5: Стартове зображення (опціонально)</b>\n\n` +
    `Це перший кадр відео. AI анімує його.\n` +
    `Якщо не маєте — пропустіть.\n\n` +
    `📤 Оберіть дію:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🖼️ Завантажу зображення', 'veo_add_start_image')],
        [Markup.button.callback('⏭️ Без зображення', 'veo_skip_start_image')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// ==================== RUNWAY TURBO CALLBACKS ====================

bot.action(/^runway_turbo_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const duration = parseInt(ctx.match[1], 10);
  const state = userState.get(userId);
  const model = models.video.models.find(m => m.key === 'runway_turbo');

  if (!state || state.action !== 'runway_turbo_generation' || state.step !== 'select_duration') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Runway Turbo');
    return;
  }

  const costPerSec = getEffectiveRunwayTurboCostPerSecond(userId);
  const cost = duration * costPerSec;

  userState.set(userId, {
    ...state,
    duration: duration,
    step: 'select_aspect'
  });

  const aspectRatios = model?.aspectRatios || ['16:9'];
  const aspectButtons = aspectRatios.map(r => Markup.button.callback(`${r}`, `runway_turbo_aspect_${r}`));

  await ctx.reply(
    `🎬 <b>Runway Gen-4 Turbo</b>\n\n` +
    `⏱️ Тривалість: <b>${duration} сек</b>\n` +
    `💰 Вартість: <b>${cost.toFixed(1)}⚡</b>\n\n` +
    `📐 <b>Крок 3: Оберіть aspect ratio</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        aspectButtons,
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

bot.action(/^runway_turbo_aspect_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const aspectRatio = ctx.match[1];
  const state = userState.get(userId);

  if (!state || state.action !== 'runway_turbo_generation' || state.step !== 'select_aspect') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Runway Turbo');
    return;
  }

  const model = models.video.models.find(m => m.key === 'runway_turbo');
  const duration = state.duration || 5;
  const costPerSec = getEffectiveRunwayTurboCostPerSecond(userId);
  const cost = duration * costPerSec;

  userState.set(userId, {
    ...state,
    aspectRatio: aspectRatio,
    step: 'waiting_prompt'
  });

  await ctx.reply(
    `🎬 <b>Runway Gen-4 Turbo</b>\n\n` +
    `⏱️ Тривалість: <b>${duration} сек</b>\n` +
    `📐 Пропорції: <b>${aspectRatio}</b>\n` +
    `💰 Вартість: <b>${cost.toFixed(1)}⚡</b>\n\n` +
    `✍️ <b>Крок 4: Введіть промпт</b>\n\n` +
    `Опишіть рух/анімацію для відео.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// ==================== VEO START IMAGE CALLBACKS ====================

// Користувач хоче додати стартове зображення
bot.action('veo_add_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Veo 3.1');
    return;
  }

  const idealSize = state.aspectRatio === '16:9' ? '1280×720' : '720×1280';

  userState.set(userId, {
    ...state,
    step: 'waiting_start_image'
  });

  await ctx.reply(
    `🖼️ <b>Завантажте стартове зображення</b>\n\n` +
    `Це зображення стане <b>першим кадром</b> вашого відео.\n` +
    `AI анімує його згідно з промптом.\n\n` +
    `💡 Ідеальний розмір: ${idealSize}\n` +
    `📁 Формат: JPG або PNG\n\n` +
    `📤 <b>Надішліть одне фото:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Користувач пропускає стартове зображення - переходимо до останнього кадру
bot.action('veo_skip_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'ask_last_frame',
    startImage: null
  });

  await ctx.reply(
    `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
    `<b>Що це:</b> Зображення для кінця відео.\n` +
    `AI створить плавний перехід від початку до цього кадру.\n\n` +
    `<b>🎯 Приклад:</b>\n` +
    `• Початок: людина стоїть\n` +
    `• Кінець: людина сидить\n` +
    `• AI згенерує рух присідання`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📷 Завантажу останній кадр', 'veo_add_last_frame')],
        [Markup.button.callback('⏭️ Генерувати без останнього кадру', 'veo_skip_last_frame')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Додати останній кадр
bot.action('veo_add_last_frame', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_last_frame'
  });

  await ctx.reply(
    `📷 <b>Завантажте останній кадр</b>\n\n` +
    `Надішліть <b>одне зображення</b>, яке буде кінцем відео.\n\n` +
    `💡 <b>Порада:</b> Використовуйте зображення того ж розміру що й пропорції (${state.aspectRatio === '16:9' ? '1280×720' : '720×1280'})`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Пропустити останній кадр - переходимо до промпту
bot.action('veo_skip_last_frame', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_prompt',
    lastFrame: null
  });

  await ctx.reply(
    `✍️ <b>Крок 6: Введіть промпт</b>\n\n` +
    `Опишіть детально що хочете бачити у відео.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Перейти до промпту (без додаткових опцій)
bot.action('veo_generate_now', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_prompt'
  });

  await ctx.reply(
    `✍️ <b>Крок 6: Введіть промпт</b>\n\n` +
    `Опишіть детально що хочете бачити у відео.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// ==================== SORA 2 CALLBACKS ====================

// Крок 1: Вибір тривалості
bot.action(/^sora_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const duration = parseInt(ctx.match[1]);
  const state = userState.get(userId);
  const model = models.video.models.find(m => m.key === 'sora_2');

  if (!state || state.action !== 'sora_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    duration,
    step: 'select_aspect'
  });

  await ctx.reply(
    `🌌 <b>${model?.name || 'OpenAI Sora 2'}</b>\n\n` +
    `⏱️ Тривалість: <b>${duration} сек</b>\n\n` +
    `📐 <b>Крок 2: Оберіть пропорції відео</b>\n\n` +
    `📱 Portrait — 720×1280\n` +
    `🎬 Landscape — 1280×720`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📱 Portrait', 'sora_aspect_portrait'),
          Markup.button.callback('🎬 Landscape', 'sora_aspect_landscape')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 2: Вибір aspect ratio
bot.action(/^sora_aspect_(portrait|landscape)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const aspectRatio = ctx.match[1];
  const state = userState.get(userId);

  if (!state || state.action !== 'sora_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    aspectRatio,
    step: 'ask_reference'
  });

  await ctx.reply(
    `🖼️ <b>Крок 3: Додати стартове зображення?</b>\n\n` +
    `Опціонально можна задати перший кадр.\n` +
    `Зображення має мати пропорції <b>${aspectRatio}</b>.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📷 Додати зображення', 'sora_add_reference'),
          Markup.button.callback('⏭️ Без зображення', 'sora_skip_reference')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Додати reference image
bot.action('sora_add_reference', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'sora_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_reference'
  });

  await ctx.reply(
    `📷 <b>Надішліть стартове зображення</b>\n\n` +
    `Пропорції мають бути: <b>${state.aspectRatio}</b>.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Пропустити reference image
bot.action('sora_skip_reference', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'sora_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    inputReference: null,
    step: 'waiting_prompt'
  });

  await ctx.reply(
    `✍️ <b>Крок 4: Введіть промпт</b>\n\n` +
    `Опишіть детально що хочете бачити у відео.`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// ==================== KLING v2.5 CALLBACKS ====================

// Крок 1: Вибір тривалості
bot.action(/^kling_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const duration = parseInt(ctx.match[1]);
  const state = userState.get(userId);
  const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
  const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');
  const costPerSecKling = modelKey === 'kling_v2_6' ? getEffectiveKlingV2_6CostPerSecond(userId, model, false) : getEffectiveKlingCostPerSecond(userId);
  const klingCost = duration * costPerSecKling;

  // ✅ TRIAL CHECK: 10 секунд заблоковано для Trial
  const trialCheck = await checkTrialRestrictions(userId, modelKey, { duration });
  if (!trialCheck.allowed) {
    await ctx.reply(
      trialCheck.message,
      { parse_mode: 'HTML', ...keyboard.createSubscriptionsMenu(ctx.from.id) }
    );
    return;
  }

  if (modelKey === 'kling_v2_6') {
    const costPerSecNo = getEffectiveKlingV2_6CostPerSecond(userId, model, false);
    const costPerSecAud = getEffectiveKlingV2_6CostPerSecond(userId, model, true);
    const noAudioCost = duration * costPerSecNo;
    const audioCost = duration * costPerSecAud;

    userState.set(userId, {
      action: 'kling_generation',
      step: 'select_audio',
      duration: duration,
      modelKey
    });

    await ctx.reply(
      `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
      `⏱️ Тривалість: <b>${duration} секунд</b>\n\n` +
      `🔊 <b>Крок 2: Оберіть аудіо</b>\n\n` +
      `🔇 Без аудіо — <b>${noAudioCost}⚡</b>\n` +
      `🔊 З аудіо — <b>${audioCost}⚡</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`🔇 Без аудіо (${noAudioCost}⚡)`, 'kling_audio_off'),
            Markup.button.callback(`🔊 З аудіо (${audioCost}⚡)`, 'kling_audio_on')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  userState.set(userId, {
    action: 'kling_generation',
    step: 'select_aspect',
    duration: duration,
    klingCost: klingCost,
    modelKey
  });

  await ctx.reply(
    `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
    `⏱️ Тривалість: <b>${duration} секунд</b>\n` +
    `💰 Вартість: <b>${klingCost}⚡</b>\n\n` +
    `📐 <b>Крок 2: Оберіть пропорції</b>\n\n` +
    `<i>Ігнорується якщо завантажите стартове зображення</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🎬 16:9', 'kling_aspect_16:9'),
          Markup.button.callback('📱 9:16', 'kling_aspect_9:16')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 2 (Kling v2.6): Вибір аудіо
bot.action(/^kling_audio_(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const audioOn = ctx.match[1] === 'on';
  const state = userState.get(userId);
  const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
  const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');

  if (!state || state.action !== 'kling_generation' || state.step !== 'select_audio') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  const duration = state.duration || 5;
  const costPerSec = getEffectiveKlingV2_6CostPerSecond(userId, model, audioOn);
  const klingCost = duration * costPerSec;

  userState.set(userId, {
    ...state,
    generateAudio: audioOn,
    klingCost,
    step: 'select_aspect'
  });

  await ctx.reply(
    `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
    `⏱️ Тривалість: <b>${duration} секунд</b>\n` +
    `🔊 Аудіо: <b>${audioOn ? 'Так' : 'Ні'}</b>\n` +
    `💰 Вартість: <b>${klingCost}⚡</b>\n\n` +
    `📐 <b>Крок 3: Оберіть пропорції</b>\n\n` +
    `<i>Ігнорується якщо завантажите стартове зображення</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🎬 16:9', 'kling_aspect_16:9'),
          Markup.button.callback('📱 9:16', 'kling_aspect_9:16')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 2: Вибір aspect ratio
bot.action(/^kling_aspect_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const aspectRatio = ctx.match[1];
  const state = userState.get(userId);
  const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
  const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    aspectRatio: aspectRatio,
    step: 'ask_start_image'
  });

  const useAudio = state.generateAudio === true;
  const effectiveCost = state.klingCost || (state.duration * (useAudio ? (model?.costPerSecondAudio || model?.costPerSecond || 6) : (model?.costPerSecond || 6)));
  const startImageStep = state?.generateAudio !== undefined ? 4 : 3;

  const audioLine = state?.generateAudio !== undefined
    ? `🔊 Аудіо: <b>${state.generateAudio ? 'Так' : 'Ні'}</b>\n`
    : '';

  // ⚠️ Kling v2.5 (key: 'kling') — тільки image-to-video! Не показуємо "Без зображення"
  const isKlingV25 = modelKey === 'kling';
  const requiresImage = isKlingV25;

  const buttons = [];
  buttons.push([Markup.button.callback('🖼️ Завантажу зображення', 'kling_add_start_image')]);

  // Якщо модель НЕ вимагає image, показуємо опцію "Без зображення"
  if (!requiresImage) {
    buttons.push([Markup.button.callback('⏭️ Без зображення (text-to-video)', 'kling_skip_start_image')]);
  }

  buttons.push([Markup.button.callback('← Назад', 'video_menu')]);

  await ctx.reply(
    `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
    `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
    `📐 Пропорції: <b>${aspectRatio}</b>\n` +
    `${audioLine}` +
    `💰 Вартість: <b>${effectiveCost}⚡</b>\n\n` +
    `🖼️ <b>Крок ${startImageStep}: ${requiresImage ? 'Завантажте стартове зображення' : 'Стартове зображення (опціонально)'}</b>\n\n` +
    `${requiresImage 
      ? '⚠️ Kling v2.5 працює тільки з image-to-video.\n\nЗображення стане першим кадром відео.\nAI анімує його згідно з промптом.' 
      : 'Зображення стане першим кадром відео.\nAI анімує його згідно з промптом.'}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Крок 3a: Додати стартове зображення
bot.action('kling_add_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_start_image'
  });

  await ctx.reply(
    `🖼️ <b>Завантажте стартове зображення</b>\n\n` +
    `Це зображення стане <b>першим кадром</b> відео.\n\n` +
    `📤 <b>Надішліть одне фото:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Крок 3b: Пропустити стартове зображення
bot.action('kling_skip_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
  const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');
  const supportsEndImage = model?.supportsEndImage !== false;

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  // ⚠️ Kling v2.5 вимагає зображення!
  if (modelKey === 'kling') {
    await ctx.answerCbQuery('⚠️ Kling v2.5 працює тільки з зображеннями!', { show_alert: true });
    return;
  }

  if (!supportsEndImage) {
    const audioLine = state?.generateAudio !== undefined
      ? `🔊 Аудіо: <b>${state.generateAudio ? 'Так' : 'Ні'}</b>\n`
      : '';

    userState.set(userId, {
      ...state,
      startImage: null,
      endImage: null,
      step: 'waiting_prompt'
    });

    await ctx.reply(
      `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
      `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
      `📐 Пропорції: <b>${state.aspectRatio}</b>\n` +
    `🖼️ Початкове зображення: <b>Ні</b>\n` +
      `${audioLine}` +
      `💰 Вартість: <b>${state.klingCost}⚡</b>\n\n` +
      `📝 <b>Напишіть промпт</b>\n\n` +
      `Опишіть рух/анімацію для відео.\n\n` +
      `✍️ <b>Надішліть текстовий промпт:</b>`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  userState.set(userId, {
    ...state,
    startImage: null,
    step: 'ask_end_image'
  });

  await ctx.reply(
    `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
    `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
    `<b>Що це:</b> Зображення для кінця відео.\n` +
    `AI створить плавний перехід від першого до останнього кадру.\n\n` +
    `<b>🎯 Приклад:</b>\n` +
    `• Початок: людина стоїть\n` +
    `• Кінець: людина сидить\n` +
    `• Результат: анімація присідання`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📷 Завантажу end_image', 'kling_add_end_image')],
        [Markup.button.callback('⏭️ Перейти до промпту', 'kling_skip_end_image')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 4 (після start_image): Питаємо про end_image
bot.action('kling_ask_end_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
  const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  await ctx.reply(
    `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
    `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
    `<b>Що це:</b> Зображення для кінця відео.\n` +
    `AI створить плавний перехід від першого до останнього кадру.\n\n` +
    `<b>🎯 Приклад:</b>\n` +
    `• Початок: людина стоїть\n` +
    `• Кінець: людина сидить\n` +
    `• Результат: анімація присідання`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📷 Завантажу end_image', 'kling_add_end_image')],
        [Markup.button.callback('⏭️ Перейти до промпту', 'kling_skip_end_image')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Додати end_image
bot.action('kling_add_end_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_end_image'
  });

  await ctx.reply(
    `📷 <b>Завантажте останній кадр</b>\n\n` +
    `Це зображення стане кінцевим кадром відео.\n\n` +
    `📤 <b>Надішліть одне фото:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Пропустити end_image - перейти до промпту
bot.action('kling_skip_end_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
  const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  const audioLine = state?.generateAudio !== undefined
    ? `🔊 Аудіо: <b>${state.generateAudio ? 'Так' : 'Ні'}</b>\n`
    : '';

  userState.set(userId, {
    ...state,
    endImage: null,
    step: 'waiting_prompt'
  });

  await ctx.reply(
    `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
    `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
    `📐 Пропорції: <b>${state.aspectRatio}</b>\n` +
    `🖼️ Початкове зображення: <b>${state.startImage ? 'Так' : 'Ні'}</b>\n` +
    `${audioLine}` +
    `💰 Вартість: <b>${state.klingCost}⚡</b>\n\n` +
    `📝 <b>Напишіть промпт</b>\n\n` +
    `Опишіть детально що хочете бачити у відео.\n\n` +
    `✍️ <b>Надішліть текстовий промпт:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// ==================== KLING MOTION CONTROL CALLBACKS ====================

// Крок 1: Вибір mode (STD/PRO)
bot.action(/^motion_mode_(std|pro)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const mode = ctx.match[1];
  const model = models.video.models.find(m => m.key === 'kling_motion');

  userState.set(userId, {
    action: 'kling_motion_generation',
    step: 'select_orientation',
    mode: mode
  });

  // Показуємо ціни для обраного mode (ефективні ціни за провайдером)
  const effectiveCosts = getEffectiveKlingMotionCosts(userId);
  const imageCost = effectiveCosts[`${mode}_image`];
  const videoCost = effectiveCosts[`${mode}_video`];

  await ctx.reply(
    `🔥 <b>Kling Motion Control</b>\n\n` +
    `⚙️ Режим: <b>${mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n\n` +
    `🎭 <b>Крок 2: Оберіть орієнтацію персонажа</b>\n\n` +
    `<b>📷 Image</b> — орієнтація з фото (до 10 сек) — ${imageCost}⚡\n` +
    `<b>🎥 Video</b> — орієнтація з відео (до 30 сек) — ${videoCost}⚡`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`📷 Image (${imageCost}⚡)`, 'motion_orient_image'),
          Markup.button.callback(`🎥 Video (${videoCost}⚡)`, 'motion_orient_video')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 2: Вибір orientation (image/video)
bot.action(/^motion_orient_(image|video)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const orientation = ctx.match[1];
  const state = userState.get(userId);
  const model = models.video.models.find(m => m.key === 'kling_motion');

  if (!state || state.action !== 'kling_motion_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  const costKey = `${state.mode}_${orientation}`;
  const motionCosts = getEffectiveKlingMotionCosts(userId);
  const motionCost = motionCosts[costKey] ?? model.costs?.[costKey];
  const maxDuration = orientation === 'image' ? 10 : 30;

  userState.set(userId, {
    ...state,
    orientation: orientation,
    motionCost: motionCost,
    step: 'ask_sound'
  });

  await ctx.reply(
    `🔥 <b>Kling Motion Control</b>\n\n` +
    `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
    `🎭 Орієнтація: <b>${orientation === 'image' ? '📷 Image' : '🎥 Video'}</b>\n` +
    `⏱️ Макс тривалість: <b>${maxDuration} сек</b>\n` +
    `💰 Вартість: <b>${motionCost}⚡</b>\n\n` +
    `🔊 <b>Крок 3: Звук з відео</b>\n\n` +
    `Зберегти оригінальний звук з референсного відео?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔊 Зберегти звук', 'motion_sound_on'),
          Markup.button.callback('🔇 Без звуку', 'motion_sound_off')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 3: Вибір keep_original_sound
bot.action(/^motion_sound_(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const keepSound = ctx.match[1] === 'on';
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_motion_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    keepOriginalSound: keepSound,
    step: 'waiting_image'
  });

  const maxDuration = state.orientation === 'image' ? 10 : 30;

  await ctx.reply(
    `🔥 <b>Kling Motion Control</b>\n\n` +
    `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
    `🎭 Орієнтація: <b>${state.orientation === 'image' ? '📷 Image' : '🎥 Video'}</b>\n` +
    `⏱️ Макс: <b>${maxDuration} сек</b>\n` +
    `🔊 Звук: <b>${keepSound ? 'Зберегти' : 'Без звуку'}</b>\n` +
    `💰 Вартість: <b>${state.motionCost}⚡</b>\n\n` +
    `📷 <b>Крок 4: Надішліть ФОТО персонажа</b>\n\n` +
    `Це зображення персонажа який буде анімований.\n\n` +
    `📤 <b>Надішліть одне фото:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Генерувати Kling Motion
bot.action('motion_generate_now', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_motion_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  await ctx.reply('🚀 Починаємо генерацію Kling Motion...');
  runBackgroundTask(() => generateKlingMotionVideo(ctx, state), 'kling_motion_generate_now');
});

// ==================== KLING O1 EDIT FLOW ====================

// Крок 1: Вибір mode (std/pro)
bot.action(/^kling_o1_mode_(std|pro)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const mode = ctx.match[1];
  const state = userState.get(userId);
  const model = models.video.models.find(m => m.key === 'kling_o1_edit');

  if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'select_mode') {
    await ctx.reply('❌ Помилка. Почніть заново: Відео → Kling O1 Edit');
    return;
  }

  userState.set(userId, {
    ...state,
    mode: mode,
    step: 'waiting_video'
  });

  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `⚙️ Режим: <b>${mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n\n` +
    `🎥 <b>Крок 2: Надішліть ВІДЕО для редагування</b>\n\n` +
    `Потрібен відео-файл (MP4, MOV, WEBM, M4V, GIF)\n` +
    `Максимальний розмір: 200MB\n` +
    `Тривалість: 3-10 секунд\n\n` +
    `📤 <b>Надішліть відео:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Обробка відео для kling_o1_edit
// ❌ ВИДАЛЕНО: Дублікат обробника відео (тепер є один універсальний обробник нижче)
// bot.on('video', async (ctx) => {
//   const userId = ctx.from.id;
//   const state = userState.get(userId);
//
//   if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'waiting_video') {
//     return;
//   }

// ПЕРЕМІЩЕНО В УНІВЕРСАЛЬНИЙ ОБРОБНИК НИЖЧЕ (рядок ~8820)
// ПЕРЕМІЩЕНО В УНІВЕРСАЛЬНИЙ ОБРОБНИК НИЖЧЕ (рядок ~8820)

//   const videoFile = ctx.message.video;
//   if (!videoFile) {
//     await ctx.reply('❌ Помилка: не вдалося отримати відео. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
//     return;
//   }
//
//   // Перевірка розміру (200MB max)
//   const fileSizeMB = (videoFile.file_size || 0) / (1024 * 1024);
//   if (fileSizeMB > 200) {
//     await ctx.reply(
//       `❌ Відео занадто велике!\n\n` +
//       `Максимальний розмір: 200MB\n` +
//       `Ваш файл: ${fileSizeMB.toFixed(2)}MB\n\n` +
//       `Спробуйте стиснути відео або використати коротший кліп.`,
//       keyboard.createBackButton('video_menu')
//     );
//     return;
//   }
//
//   // Перевірка роздільності (мінімум 720px по обох вимірах)
//   const videoWidth = videoFile.width || 0;
//   const videoHeight = videoFile.height || 0;
//   if (videoWidth < 720 || videoHeight < 720) {
//     await ctx.reply(
//       `❌ Роздільність відео занадто низька!\n\n` +
//       `Мінімальна роздільність: 720x720 пікселів\n` +
//       `Ваше відео: ${videoWidth}x${videoHeight}\n\n` +
//       `⚠️ Обидва виміри (ширина та висота) повинні бути не менше 720px.\n\n` +
//       `Спробуйте використати відео з вищою роздільністю.`,
//       keyboard.createBackButton('video_menu')
//     );
//     return;
//   }
//
//   const videoUrl = await getVideoUrl(ctx);
//   if (!videoUrl) {
//     await ctx.reply('❌ Помилка: не вдалося завантажити відео. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
//     return;
//   }
//
//   userState.set(userId, {
//     ...state,
//     referenceVideo: videoUrl,
//     step: 'select_video_type'
//   });
//
//   await ctx.reply(
//     `✂️ <b>Kling O1 Edit</b>\n\n` +
//     `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
//     `🎥 Відео: <b>Завантажено</b>\n\n` +
//     `🎬 <b>Крок 3: Як використовувати відео?</b>\n\n` +
//     `• <b>Feature</b> — як референс стилю/камери (можна змінювати тривалість)\n` +
//     `• <b>Base</b> — редагування відео (тривалість як у оригіналі)`,
//     {
//       parse_mode: 'HTML',
//       ...Markup.inlineKeyboard([
//         [
//           Markup.button.callback('🎨 Feature', 'kling_o1_video_type_feature'),
//           Markup.button.callback('✂️ Base', 'kling_o1_video_type_base')
//         ],
//         [Markup.button.callback('← Назад', 'video_menu')]
//       ])
//     }
//   );
// });

// ❌ КІНЕЦЬ ЗАКОМЕНТОВАНОГО ОБРОБНИКА

// Крок 3: Вибір video_reference_type
bot.action(/^kling_o1_video_type_(feature|base)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const videoType = ctx.match[1];
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'select_video_type') {
    await ctx.reply('❌ Помилка. Почніть заново: Відео → Kling O1 Edit');
    return;
  }

  userState.set(userId, {
    ...state,
    videoReferenceType: videoType,
    step: videoType === 'feature' ? 'select_duration' : 'ask_sound'
  });

  if (videoType === 'feature') {
    // Feature type: можна вибрати duration
    await ctx.reply(
      `✂️ <b>Kling O1 Edit</b>\n\n` +
      `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
      `🎥 Відео: <b>Завантажено</b> (🎨 референс стилю/камери)\n\n` +
      `⏱️ <b>Крок 4: Тривалість відео</b>\n\n` +
      `Оберіть тривалість (3-10 секунд):`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('3с', 'kling_o1_duration_3'),
            Markup.button.callback('4с', 'kling_o1_duration_4'),
            Markup.button.callback('5с', 'kling_o1_duration_5'),
            Markup.button.callback('6с', 'kling_o1_duration_6')
          ],
          [
            Markup.button.callback('7с', 'kling_o1_duration_7'),
            Markup.button.callback('8с', 'kling_o1_duration_8'),
            Markup.button.callback('9с', 'kling_o1_duration_9'),
            Markup.button.callback('10с', 'kling_o1_duration_10')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
  } else {
    // Base type: одразу питаємо про звук
    await ctx.reply(
      `✂️ <b>Kling O1 Edit</b>\n\n` +
      `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
      `🎥 Відео: <b>Завантажено</b> (✂️ редагування)\n\n` +
      `🔊 <b>Крок 4: Звук з відео</b>\n\n` +
      `Зберегти оригінальний звук з відео?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔊 Зберегти звук', 'kling_o1_sound_on'),
            Markup.button.callback('🔇 Без звуку', 'kling_o1_sound_off')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
  }
});

// Крок 4a: Вибір duration (для feature type)
bot.action(/^kling_o1_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const duration = parseInt(ctx.match[1], 10);
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'select_duration') {
    return;
  }

  userState.set(userId, {
    ...state,
    duration: duration,
    step: 'ask_sound'
  });

  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
    `🎥 Відео: <b>Завантажено</b> (🎨 референс)\n` +
    `⏱️ Тривалість: <b>${duration} сек</b>\n\n` +
    `🔊 <b>Крок 5: Звук з відео</b>\n\n` +
    `Зберегти оригінальний звук з відео?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔊 Зберегти звук', 'kling_o1_sound_on'),
          Markup.button.callback('🔇 Без звуку', 'kling_o1_sound_off')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 4b/5: Вибір keep_original_sound
bot.action(/^kling_o1_sound_(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const keepSound = ctx.match[1] === 'on';
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'ask_sound') {
    return;
  }

  userState.set(userId, {
    ...state,
    keepOriginalSound: keepSound,
    step: 'ask_start_image'
  });

  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
    `🎥 Відео: <b>Завантажено</b>\n` +
    `🔊 Звук: <b>${keepSound ? 'Зберегти' : 'Без звуку'}</b>\n\n` +
    `🖼️ <b>Крок 6: Перший/останній кадр</b> (опціонально)\n\n` +
    `Можна вказати перший та останній кадр відео:\n` +
    `• Перший кадр (start_image) — обов'язковий якщо хочете вказати останній\n` +
    `• Останній кадр (end_image) — потребує перший кадр`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🖼️ Додати перший/останній кадр', 'kling_o1_add_frames')],
        [Markup.button.callback('⏭️ Пропустити', 'kling_o1_skip_frames')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 4: Додати frames або пропустити
bot.action('kling_o1_add_frames', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'ask_start_image') {
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_start_image'
  });

  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `📷 <b>Надішліть перший кадр</b> (start_image)\n\n` +
    `Підтримується: JPG, PNG (до 10MB)\n\n` +
    `💡 Після першого кадру можна додати останній кадр (end_image).`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

bot.action('kling_o1_skip_frames', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'ask_start_image') {
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'ask_reference_images'
  });

  const maxRefs = state.referenceVideo ? 4 : 7;
  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `🖼️ <b>Крок 5: Референсні зображення</b> (опціонально)\n\n` +
    `Можна додати до <b>${maxRefs}</b> референсних зображень для елементів, сцен або стилю.\n\n` +
    `💡 У промпті посилайтесь на них як <b>@Image1</b>, <b>@Image2</b> тощо.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Додати зображення', 'kling_o1_add_ref_images')],
        [Markup.button.callback('⏭️ Пропустити → до опису', 'kling_o1_skip_ref_images')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Обробка start_image для kling_o1_edit
bot.on('photo', async (ctx, next) => {
  const userId = ctx.from.id;
  const state = userState.get(userId);

  // ✅ A2E Motion: Обробка фото для анімації (ПЕРЕВІРЯЄМО ПЕРШИМ!)
  if (state?.action === 'a2e_motion_generation' && state?.step === 'waiting_image') {
    console.log('🔥 A2E Motion: Processing photo for user', userId);
    const imageUrl = await getImageUrl(ctx);
    if (!imageUrl) {
      await ctx.reply('❌ Помилка: не вдалося завантажити зображення. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      return;
    }

    console.log('🔥 A2E Motion: Image URL received, setting state to select_duration');

    // Зберігаємо в userCurrentModel для backup
    userCurrentModel.set(userId, 'a2e_motion');

    const newState = {
      action: 'a2e_motion_generation',
      step: 'select_duration',
      modelKey: 'a2e_motion',
      imageUrl: imageUrl
    };
    userState.set(userId, newState);

    console.log('🔥 A2E Motion: State saved:', JSON.stringify(newState));

    const model = models.video.models.find(m => m.key === 'a2e_motion');
    const durations = model.durations || [5, 10, 15, 20];
    const durationButtons = durations.map(d =>
      Markup.button.callback(`${d} сек (${d * model.costPerSecond}⚡)`, `a2e_duration_${d}`)
    );

    await ctx.reply(
      `🔥 <b>Motion без омеженнь</b>\n\n` +
      `✅ Зображення завантажено!\n\n` +
      `⏱️ <b>Крок 2: Оберіть тривалість відео</b>\n\n` +
      `💰 Вартість залежить від тривалості:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          durationButtons,
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING O1 EDIT: Обробка start_image
  if (state?.action === 'kling_o1_edit_generation' && state?.step === 'waiting_start_image') {
    const imageUrl = await getImageUrl(ctx);
    if (!imageUrl) {
      await ctx.reply('❌ Помилка: не вдалося завантажити зображення. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      return;
    }

    userState.set(userId, {
      ...state,
      startImage: imageUrl,
      step: 'ask_end_image'
    });

    await ctx.reply(
      `✂️ <b>Kling O1 Edit</b>\n\n` +
      `✅ Перший кадр: <b>Завантажено</b>\n\n` +
      `📷 <b>Додати останній кадр?</b> (опціонально)\n\n` +
      `Можна додати останній кадр (end_image) або пропустити.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📷 Додати останній кадр', 'kling_o1_add_end_image')],
          [Markup.button.callback('⏭️ Пропустити', 'kling_o1_skip_end_image')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING O1 EDIT: Обробка end_image
  if (state?.action === 'kling_o1_edit_generation' && state?.step === 'waiting_end_image') {
    const imageUrl = await getImageUrl(ctx);
    if (!imageUrl) {
      await ctx.reply('❌ Помилка: не вдалося завантажити зображення. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      return;
    }

    userState.set(userId, {
      ...state,
      endImage: imageUrl,
      step: 'ask_reference_images'
    });

    const maxRefs = state.referenceVideo ? 4 : 7;
    await ctx.reply(
      `✂️ <b>Kling O1 Edit</b>\n\n` +
      `✅ Перший кадр: <b>Завантажено</b>\n` +
      `✅ Останній кадр: <b>Завантажено</b>\n\n` +
      `🖼️ <b>Крок 5: Референсні зображення</b> (опціонально)\n\n` +
      `Можна додати до <b>${maxRefs}</b> референсних зображень.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Додати зображення', 'kling_o1_add_ref_images')],
          [Markup.button.callback('⏭️ Пропустити → до опису', 'kling_o1_skip_ref_images')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING O1 EDIT: Обробка reference_images
  if (state?.action === 'kling_o1_edit_generation' && state?.step === 'waiting_reference_images') {
    const imageUrl = await getImageUrl(ctx);
    if (!imageUrl) {
      await ctx.reply('❌ Помилка: не вдалося завантажити зображення. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      return;
    }

    const maxRefs = state.referenceVideo ? 4 : 7;
    const currentRefs = state.referenceImages || [];
    
    if (currentRefs.length >= maxRefs) {
      await ctx.reply(
        `⚠️ Максимум <b>${maxRefs}</b> референсних зображень!\n\n` +
        `Ви вже додали ${currentRefs.length}. Перейдіть до опису редагування.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✍️ Перейти до опису', 'kling_o1_skip_ref_images')],
            [Markup.button.callback('← Назад', 'video_menu')]
          ])
        }
      );
      return;
    }

    const newRefs = [...currentRefs, imageUrl];
    userState.set(userId, {
      ...state,
      referenceImages: newRefs,
      step: 'waiting_reference_images'
    });

    const remaining = maxRefs - newRefs.length;
    await ctx.reply(
      `✂️ <b>Kling O1 Edit</b>\n\n` +
      `✅ Референсних зображень: <b>${newRefs.length}/${maxRefs}</b>\n\n` +
      `${remaining > 0 ? `Можна додати ще <b>${remaining}</b> зображень.` : 'Досягнуто максимум.'}\n\n` +
      `💡 У промпті посилайтесь на них як <b>@Image1</b>, <b>@Image2</b> тощо.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('➕ Додати ще', 'kling_o1_add_ref_images'),
            Markup.button.callback('✍️ До опису', 'kling_o1_skip_ref_images')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Якщо жоден обробник не спрацював, передаємо наступному handler
  return next();
});

bot.action('kling_o1_add_end_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'ask_end_image') {
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_end_image'
  });

  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `📷 <b>Надішліть останній кадр</b> (end_image)\n\n` +
    `Підтримується: JPG, PNG (до 10MB)`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

bot.action('kling_o1_skip_end_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation' || state.step !== 'ask_end_image') {
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'ask_reference_images'
  });

  const maxRefs = state.referenceVideo ? 4 : 7;
  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `🖼️ <b>Крок 5: Референсні зображення</b> (опціонально)\n\n` +
    `Можна додати до <b>${maxRefs}</b> референсних зображень.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Додати зображення', 'kling_o1_add_ref_images')],
        [Markup.button.callback('⏭️ Пропустити → до опису', 'kling_o1_skip_ref_images')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

bot.action('kling_o1_add_ref_images', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation' || (state.step !== 'ask_reference_images' && state.step !== 'waiting_reference_images')) {
    return;
  }

  const maxRefs = state.referenceVideo ? 4 : 7;
  const currentRefs = state.referenceImages || [];
  
  if (currentRefs.length >= maxRefs) {
    await ctx.answerCbQuery(`Максимум ${maxRefs} зображень!`, true);
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_reference_images'
  });

  const remaining = maxRefs - currentRefs.length;
  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `📷 <b>Надішліть референсне зображення</b>\n\n` +
    `Поточні: ${currentRefs.length}/${maxRefs}\n` +
    `Залишилось: ${remaining}\n\n` +
    `Підтримується: JPG, PNG\n` +
    `💡 У промпті посилайтесь як <b>@Image${currentRefs.length + 1}</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

bot.action('kling_o1_skip_ref_images', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_o1_edit_generation') {
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_prompt'
  });

  const refsCount = state.referenceImages?.length || 0;
  const refsHint = refsCount > 0
    ? `\n\nВи додали ${refsCount} референсних зображень. У промпті посилайтесь на них як @Image1, @Image2 тощо.`
    : '';

  await ctx.reply(
    `✂️ <b>Kling O1 Edit</b>\n\n` +
    `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
    `🎥 Відео: <b>Завантажено</b>${state.startImage ? '\n🖼️ Перший кадр: Завантажено' : ''}${state.endImage ? '\n🖼️ Останній кадр: Завантажено' : ''}\n\n` +
    `✍️ <b>Крок 6: Опишіть редагування</b>\n\n` +
    `Напишіть що потрібно змінити у відео:\n` +
    `• Замінити персонажа\n` +
    `• Змінити середовище\n` +
    `• Змінити стиль\n` +
    `• Інше редагування${refsHint}\n\n` +
    `💡 Приклад: "Замінити персонажа на @Image1, змінити середовище на @Image2"\n\n` +
    `📝 <b>Напишіть опис редагування:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// ==================== SHARED VIDEO RECOVERY POLLING ====================
/**
 * Запускає фоновий polling для відео яке не встигло завершитись під час основного polling.
 * Використовується коли KIE.AI повертає pending: true після таймауту.
 *
 * @param {object} opts
 *   chatId, userId, username, modelKey, modelLabel, taskId,
 *   cost, apiCostObj, deductMeta, promptSnippet, resultMeta (рядок для caption),
 *   isRunway (bool) — чи використовувати runway endpoint для опитування,
 *   monitorOptions (object) — передається в logUsageEvent
 */
async function startVideoRecoveryPolling({
  chatId, userId, username,
  modelKey, modelLabel, taskId,
  cost, deductDescription, deductMeta,
  promptSnippet, captionLine,
  isRunway = false,
  monitorOptions = {}
}) {
  const maxAttempts = 720; // 60 хвилин (720 * 5s)
  const interval = 5000;
  let attempts = 0;

  console.log(`🔄 [Recovery] Starting for ${modelLabel} task ${taskId}, user ${userId}`);

  while (attempts < maxAttempts) {
    try {
      await new Promise(r => setTimeout(r, interval));
      attempts++;

      let job;
      let state;
      let videoUrl;

      if (isRunway) {
        job = await kieAI.fetchRunwayTaskInfoExported(taskId);
        state = job?.state || '';
        videoUrl = job?.videoInfo?.videoUrl || null;
      } else {
        job = await kieAI.fetchTaskRecordInfoExported(taskId);
        state = (job?.state || job?.status || '').toLowerCase();
        videoUrl = kieAI.extractVideoUrlExported(job);
      }

      if (!job) continue;

      console.log(`🔄 [Recovery] ${modelLabel} (${attempts}): taskId=${taskId} state=${state}`);

      if (state === 'success' || state === 'completed') {
        if (!videoUrl) {
          await bot.telegram.sendMessage(chatId,
            `❌ ${modelLabel}: відео згенеровано, але URL не знайдено.\nTaskId: <code>${taskId}</code>\nЗверніться до підтримки.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        // Списуємо токени
        await userBalance.deductTokens(userId, cost, deductDescription, deductMeta);
        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId, modelKey, success: true, isTrial, isFree: isTrial, ...monitorOptions
        });

        await bot.telegram.sendMessage(chatId,
          `✅ <b>${modelLabel} готово!</b>\n\n` +
          `❗️<b>ЗБЕРЕЖІТЬ ВІДЕО В ГАЛЕРЕЮ ЩОБ ОТРИМАТИ ПРАВИЛЬНИЙ РОЗМІР</b>\n\n` +
          `${promptSnippet}\n💰 Витрачено: ${cost}⚡`,
          { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
        );
        await safeSendVideo(chatId, videoUrl, {
          caption: `${captionLine}\n\n💰 Витрачено: ${cost}⚡`,
          ...keyboard.createBackButton('video_menu')
        });
        return;
      }

      if (state === 'fail' || state === 'failed' || state === 'error') {
        const errMsg = job.failMsg || job.failCode || 'Unknown error';
        console.error(`❌ [Recovery] ${modelLabel} task ${taskId} failed: ${errMsg}`);
        await bot.telegram.sendMessage(chatId,
          `❌ ${modelLabel}: генерація не вдалась.\n${errMsg}\n\nТокени НЕ списано.`
        );
        return;
      }
    } catch (e) {
      console.error(`⚠️ [Recovery] ${modelLabel} poll error (${attempts}):`, e.message);
    }
  }

  // Вичерпали всі спроби
  console.error(`❌ [Recovery] ${modelLabel} task ${taskId} never completed`);
  await bot.telegram.sendMessage(chatId,
    `❌ <b>${modelLabel}: Генерація не завершилась</b>\n\n` +
    `Ваші токени НЕ були списані.\n` +
    `TaskId: <code>${taskId}</code>\n\n` +
    `Зверніться до підтримки.`,
    { parse_mode: 'HTML' }
  );
  await adminNotifier.notifyAdmin(bot, new Error(`Recovery exhausted: ${modelLabel} ${taskId}`), {
    userId, username, action: `${modelKey}_recovery`, taskId
  });
}

// ==================== KLING MOTION GENERATION FUNCTION ====================

async function generateKlingMotionVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;
  const model = models.video.models.find(m => m.key === 'kling_motion');

  if (!model) {
    await ctx.reply('❌ Модель Kling Motion не знайдена');
    userState.delete(userId);
    return;
  }

  const modelName = model.name;  // Зберігаємо для безпеки
  const motionCost = state.motionCost;
  const costKey = `${state.mode}_${state.orientation}`;
  const apiCost = model.apiCosts[costKey];

  if (!(await userBalance.hasTokens(userId, motionCost))) {
    await showInsufficientTokens(ctx, motionCost);
    userState.delete(userId);
    return;
  }

  const maxDuration = state.orientation === 'image' ? 10 : 30;

  const statusMsg = await ctx.reply(
    `🔥 <b>Kling Motion Control - Генерація</b>\n\n` +
    `⚙️ Режим: ${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}\n` +
    `🎭 Орієнтація: ${state.orientation === 'image' ? '📷 Image' : '🎥 Video'}\n` +
    `⏱️ Макс: ${maxDuration} сек\n` +
    `🔊 Звук: ${state.keepOriginalSound ? 'Зберегти' : 'Без'}\n\n` +
    `📝 Промпт: "${state.prompt?.substring(0, 100) || '(без промпту)'}"\n\n` +
    `⏱️ Це може зайняти 2-5 хвилин...\n` +
    `💡 <i>Ви можете продовжувати користуватись ботом поки генерація йде!</i>`,
    { parse_mode: 'HTML' }
  );

  // ✅ ОЧИЩУЄМО СТАН ОДРАЗУ - щоб користувач міг працювати з ботом далі
  userState.delete(userId);
  userCurrentModel.delete(userId);

  // ✅ ЗАПУСКАЄМО ГЕНЕРАЦІЮ У ФОНІ
  const generationData = { ...state };

  (async () => {
    try {
      // Перевіряємо чи можемо використовувати KIE.AI
      const userChosenProvider = userProviderChoice.get(userId);
      const canUseKieAI = accessControl.canUseKieAI(userId) && kieAI.isKieAIEnabled;

      const motionModelKey = 'kling_motion';
      let useKieAI = false;
      if (userChosenProvider === 'kie-ai') {
        useKieAI = kieAI.isKieAIImplemented(motionModelKey);
      } else if (userChosenProvider === 'replicate') {
        useKieAI = false;
      } else {
        useKieAI = canUseKieAI && kieAI.isKieAIImplemented(motionModelKey);
      }

      const providerName = useKieAI ? 'KIE.AI' : 'Replicate';
      console.log(`🎯 Kling Motion using provider: ${providerName}`);

      // Генеруємо через обраний провайдер
      const result = useKieAI
        ? await kieAI.generateKlingMotionKieAI(
            generationData.prompt || '',
            generationData.imageUrl,
            generationData.videoUrl,
            generationData.mode === 'pro' ? '1080p' : '720p',
            generationData.orientation
          )
        : await replicate.generateVideoWithKlingMotion(
            generationData.imageUrl,
            generationData.videoUrl,
            generationData.mode,
            generationData.orientation,
            generationData.prompt || '',
            generationData.keepOriginalSound
          );

      if (!result.success && result.pending && result.taskId) {
        console.log(`⏱️ Kling Motion task ${result.taskId} pending — recovery for user ${userId}`);
        await bot.telegram.editMessageText(chatId, statusMsg.message_id, null,
          `⏳ <b>Kling Motion ще генерується...</b>\n\nВідео буде надіслано автоматично.\n🔄 Перевіряємо у фоні...`,
          { parse_mode: 'HTML' }
        );
        startVideoRecoveryPolling({
          chatId, userId, username, modelKey: 'kling_motion', modelLabel: 'Kling Motion',
          taskId: result.taskId, cost: motionCost, deductDescription: `${modelName} generation`,
          deductMeta: { modelKey: 'kling_motion', modelName, apiCost,
            mode: generationData.mode, orientation: generationData.orientation },
          promptSnippet: `⚙️ ${generationData.mode.toUpperCase()} | ${generationData.orientation}`,
          captionLine: `🔥 Kling Motion\n⚙️ ${generationData.mode?.toUpperCase()} | ${generationData.orientation}`,
          monitorOptions: { options: { mode: generationData.mode, orientation: generationData.orientation }, provider: 'kie' }
        });
        return;
      }

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), {
          userId, username, action: 'kling_motion_generation', model: modelName
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації Kling Motion.\n\n${result.error}\n\nСпробуйте ще раз.`
        );

        // 📊 Логуємо невдалу генерацію
        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey: 'kling_motion',
          success: false,
          options: { mode: generationData.mode, orientation: generationData.orientation },
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100),
          provider: useKieAI ? 'kie' : 'replicate'
        });

        return;
      }

      await userBalance.deductTokens(userId, motionCost, `${modelName} generation`, {
        modelKey: 'kling_motion', modelName: modelName, apiCost: apiCost,
        mode: generationData.mode, orientation: generationData.orientation,
        keepOriginalSound: generationData.keepOriginalSound
      });

      // 📊 Логуємо успішну генерацію
      const isTrialMotion = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey: 'kling_motion',
        success: true,
        options: { mode: generationData.mode, orientation: generationData.orientation },
        isTrial: isTrialMotion,
        isFree: isTrialMotion,
        provider: useKieAI ? 'kie' : 'replicate'
      });

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>Kling Motion готово!</b>\n\n` +
        `❗️<b>ЗБЕРЕЖІТЬ ВІДЕО В ГАЛЕРЕЮ ЩОБ ОТРИМАТИ ПРАВИЛЬНИЙ РОЗМІР</b>\n\n` +
        `⚙️ ${generationData.mode === 'pro' ? '💎 PRO' : '⚡ STD'} | ` +
        `${generationData.orientation === 'image' ? '📷' : '🎥'} | ` +
        `${generationData.keepOriginalSound ? '🔊' : '🔇'}\n\n` +
        `💰 Витрачено: ${motionCost}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, result.videoUrl, {
        caption: `🔥 Kling Motion\n\n⚙️ ${generationData.mode.toUpperCase()} | ${generationData.orientation} | ${generationData.keepOriginalSound ? '🔊' : '🔇'}\n\n💰 Витрачено: ${motionCost}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

    } catch (error) {
      console.error('Kling Motion generation failed:', error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'kling_motion_generation' });
      try {
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '❌ Помилка генерації Kling Motion. Спробуйте ще раз.'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації Kling Motion. Спробуйте ще раз.');
      }
    }
  })();
}

// ==================== KLING O1 EDIT GENERATION FUNCTION ====================

async function generateKlingO1EditVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;
  const model = models.video.models.find(m => m.key === 'kling_o1_edit');

  if (!model) {
    await ctx.reply('❌ Модель Kling O1 Edit не знайдена');
    userState.delete(userId);
    return;
  }

  if (!state.referenceVideo) {
    await ctx.reply('❌ Помилка: відсутнє відео для редагування');
    userState.delete(userId);
    return;
  }

  if (!state.prompt) {
    await ctx.reply('❌ Помилка: відсутній опис редагування');
    userState.delete(userId);
    return;
  }

  // Duration: якщо feature type - зі стану, інакше 5 (для base ігнорується API)
  const duration = (state.videoReferenceType === 'feature' && state.duration) ? state.duration : 5;
  const hasVideo = !!state.referenceVideo;
  const costPerSec = hasVideo
    ? (state.mode === 'pro' ? model.costPerSecondProWithVideo : model.costPerSecondWithVideo)
    : (state.mode === 'pro' ? model.costPerSecondPro : model.costPerSecond);
  const apiCostPerSec = hasVideo
    ? (state.mode === 'pro' ? model.apiCostPerSecondProWithVideo : model.apiCostPerSecondWithVideo)
    : (state.mode === 'pro' ? model.apiCostPerSecondPro : model.apiCostPerSecond);
  const klingO1Cost = duration * costPerSec;
  const apiCost = duration * apiCostPerSec;

  if (!(await userBalance.hasTokens(userId, klingO1Cost))) {
    await showInsufficientTokens(ctx, klingO1Cost);
    userState.delete(userId);
    return;
  }

  const statusMsg = await ctx.reply(
    `✂️ <b>Kling O1 Edit - Генерація</b>\n\n` +
    `⚙️ Режим: ${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}\n` +
    `📝 Промпт: "${state.prompt.substring(0, 100)}${state.prompt.length > 100 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти 2-5 хвилин...\n` +
    `💡 <i>Ви можете продовжувати користуватись ботом поки генерація йде!</i>`,
    { parse_mode: 'HTML' }
  );

  userState.delete(userId);
  userCurrentModel.delete(userId);

  const generationData = { ...state };

  (async () => {
    try {
      // Конвертуємо формат посилань на зображення з @Image1, @Image2 в <<<image_1>>>, <<<image_2>>>
      let processedPrompt = generationData.prompt || '';
      if (generationData.referenceImages && generationData.referenceImages.length > 0) {
        for (let i = 0; i < generationData.referenceImages.length; i++) {
          const userFormat = `@Image${i + 1}`;
          const apiFormat = `<<<image_${i + 1}>>>`;
          processedPrompt = processedPrompt.replace(new RegExp(userFormat, 'gi'), apiFormat);
        }
      }

      const result = await replicate.generateVideoWithKlingO1Edit({
        prompt: processedPrompt,
        referenceVideo: generationData.referenceVideo,
        startImage: generationData.startImage || null,
        endImage: generationData.endImage || null,
        referenceImages: generationData.referenceImages || [],
        videoReferenceType: generationData.videoReferenceType || 'feature',  // default 'feature'
        keepOriginalSound: generationData.keepOriginalSound !== undefined ? generationData.keepOriginalSound : true,  // default true
        mode: generationData.mode,
        aspectRatio: generationData.aspectRatio || null,
        duration: generationData.videoReferenceType === 'feature' ? duration : undefined  // для base type ігнорується
      });

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), {
          userId, username, action: 'kling_o1_edit_generation', model: model.name
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації Kling O1 Edit.\n\n${result.error}\n\nСпробуйте ще раз.`
        );

        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey: 'kling_o1_edit',
          success: false,
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100)
        });

        gracefulShutdown.completeGeneration(statusMsg.message_id, false);
        return;
      }

      await userBalance.deductTokens(userId, klingO1Cost, `${model.name} generation`, {
        modelKey: 'kling_o1_edit',
        modelName: model.name,
        apiCost,
        prompt: generationData.prompt,
        hasVideo: true,
        mode: generationData.mode
      });

      const isTrial = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey: 'kling_o1_edit',
        success: true,
        isTrial,
        isFree: isTrial
      });

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>Kling O1 Edit готово!</b>\n\n` +
        `⚙️ Режим: ${generationData.mode === 'pro' ? '💎 PRO' : '⚡ STD'}\n` +
        `📝 Промпт: ${generationData.prompt.substring(0, 100)}...\n\n` +
        `💰 Витрачено: ${klingO1Cost}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, result.videoUrl, {
        caption: `✂️ Kling O1 Edit\n\n⚙️ ${generationData.mode === 'pro' ? '💎 PRO' : '⚡ STD'}\n📝 ${generationData.prompt.substring(0, 80)}...\n\n💰 Витрачено: ${klingO1Cost}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

      gracefulShutdown.completeGeneration(statusMsg.message_id, true);

    } catch (error) {
      console.error('Kling O1 Edit generation failed:', error);
      await adminNotifier.notifyAdmin(bot, error, {
        userId, username, action: 'kling_o1_edit_generation', model: model.name
      });
      try {
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '❌ Помилка генерації Kling O1 Edit. Спробуйте ще раз.'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації Kling O1 Edit. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      }
      gracefulShutdown.completeGeneration(statusMsg.message_id, false);
    }
  })();
}

// ==================== A2E MOTION CALLBACKS ====================

// Крок 2: Вибір тривалості після завантаження зображення
bot.action(/^a2e_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const duration = parseInt(ctx.match[1]);
  let state = userState.get(userId);
  const currentModel = userCurrentModel.get(userId);
  const model = models.video.models.find(m => m.key === 'a2e_motion');

  // DEBUG: детальне логування
  console.log('🔥 A2E Duration callback:', {
    userId,
    duration,
    hasState: !!state,
    stateAction: state?.action,
    stateStep: state?.step,
    currentModel,
    hasModel: !!model
  });

  // Якщо state втрачено але є currentModel - відновлюємо state
  if (!state && currentModel === 'a2e_motion') {
    console.log('🔥 A2E Duration: State lost, but currentModel exists. Asking user to resend image.');
    await ctx.reply(
      '❌ <b>Помилка: втрачено дані</b>\n\n' +
      'Будь ласка, надішліть зображення ще раз.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  if (!state || state.action !== 'a2e_motion_generation') {
    console.log('❌ A2E Duration validation failed:', {
      noState: !state,
      wrongAction: state?.action !== 'a2e_motion_generation',
      actualAction: state?.action
    });
    await ctx.reply('❌ Помилка. Почніть заново: Відео → Motion без омеженнь');
    return;
  }

  // Перевірка наявності imageUrl
  if (!state.imageUrl) {
    console.log('❌ A2E Duration: No imageUrl in state');
    await ctx.reply(
      '❌ <b>Помилка: відсутнє зображення</b>\n\n' +
      'Будь ласка, почніть заново та надішліть зображення.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  const a2eCost = duration * model.costPerSecond;

  userState.set(userId, {
    ...state,
    duration: duration,
    a2eCost: a2eCost,
    step: 'waiting_prompt'
  });

  await ctx.reply(
    `🔥 <b>Motion без омеженнь</b>\n\n` +
    `✅ Зображення: Завантажено\n` +
    `⏱️ Тривалість: <b>${duration} сек</b>\n` +
    `💰 Вартість: <b>${a2eCost}⚡</b>\n\n` +
    `📝 <b>Крок 3: Опишіть рух</b>\n\n` +
    `Напишіть детально який рух/анімацію ви хочете бачити.\n\n` +
    `✍️ <b>Надішліть текстовий промпт:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Крок 4: Пропустити negative prompt
bot.action('a2e_skip_negative', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'a2e_motion_generation' || state.step !== 'waiting_negative_prompt') {
    await ctx.reply('❌ Помилка. Почніть заново: Відео → Motion без омеженнь');
    return;
  }

  const negativePrompt = 'blurry, low quality, chaotic, deformed, watermark, bad anatomy, shaky camera view point';

  const updatedState = {
    ...state,
    negativePrompt: negativePrompt,
    step: 'ready_to_generate'
  };
  userState.set(userId, updatedState);

  await ctx.reply(
    `🔥 <b>Motion без омеженнь</b>\n\n` +
    `✅ Зображення: <b>Завантажено</b>\n` +
    `⏱️ Тривалість: <b>${updatedState.duration} секунд</b>\n` +
    `📝 Промпт: <b>${updatedState.prompt.substring(0, 100)}${updatedState.prompt.length > 100 ? '...' : ''}</b>\n` +
    `🚫 Negative: <b>стандартний</b>\n` +
    `💰 Вартість: <b>${updatedState.a2eCost}⚡</b>\n\n` +
    `🚀 Починаємо генерацію...`,
    { parse_mode: 'HTML' }
  );

  runBackgroundTask(() => generateA2EMotionVideo(ctx, updatedState), 'a2e_motion_generate');
});

// ==================== A2E MOTION GENERATION FUNCTION ====================

async function generateA2EMotionVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;
  const model = models.video.models.find(m => m.key === 'a2e_motion');
  const a2eService = require('./services/a2e');

  if (!model) {
    await ctx.reply('❌ Модель A2E Motion не знайдена');
    userState.delete(userId);
    return;
  }

  if (!state.imageUrl) {
    await ctx.reply('❌ Помилка: відсутнє зображення');
    userState.delete(userId);
    return;
  }

  if (!state.prompt) {
    await ctx.reply('❌ Помилка: відсутній опис руху');
    userState.delete(userId);
    return;
  }

  const duration = state.duration || 5;
  const cost = state.a2eCost || (duration * model.costPerSecond);
  const apiCost = duration * model.apiCostPerSecond;

  if (!(await userBalance.hasTokens(userId, cost))) {
    await showInsufficientTokens(ctx, cost);
    userState.delete(userId);
    return;
  }

  const statusMsg = await ctx.reply(
    `🔥 <b>Motion без омеженнь - Генерація</b>\n\n` +
    `⏱️ Тривалість: ${duration} сек\n` +
    `📝 Промпт: "${state.prompt.substring(0, 100)}${state.prompt.length > 100 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти 2-5 хвилин...\n` +
    `💡 <i>Ви можете продовжувати користуватись ботом поки генерація йде!</i>`,
    { parse_mode: 'HTML' }
  );

  userState.delete(userId);
  userCurrentModel.delete(userId);

  const generationData = { ...state };

  (async () => {
    try {
      // Створюємо задачу в A2E API
      const startResult = await a2eService.startImageToVideoTask({
        imageUrl: generationData.imageUrl,
        prompt: generationData.prompt,
        negativePrompt: generationData.negativePrompt || 'blurry, low quality, chaotic, deformed, watermark, bad anatomy, shaky camera view point',
        videoTime: duration,
        modelType: 'GENERAL',
        extendPrompt: true,
        skipFaceEnhance: false
      });

      if (!startResult.success || !startResult.taskId) {
        await adminNotifier.notifyAdmin(bot, new Error(startResult.error || 'Failed to start A2E task'), {
          userId, username, action: 'a2e_motion_generation', model: model.name
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації A2E Motion.\n\n${startResult.error || 'Не вдалося створити задачу'}\n\nСпробуйте ще раз.`
        );

        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey: 'a2e_motion',
          success: false,
          isTrial,
          isFree: isTrial,
          errorCode: startResult.error?.substring(0, 100)
        });

        gracefulShutdown.completeGeneration(statusMsg.message_id, false);
        return;
      }

      const taskId = startResult.taskId;
      console.log(`🔥 A2E: Task created: ${taskId}, polling for result...`);

      // Polling статусу задачі
      let attempts = 0;
      const maxAttempts = 120; // 10 хвилин (120 * 5 сек)
      const pollInterval = 5000; // 5 секунд

      let finalResult = null;
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        attempts++;

        const detailsResult = await a2eService.getTaskDetails(taskId);
        if (!detailsResult.success) {
          console.error(`A2E: Failed to get task details: ${detailsResult.error}`);
          continue;
        }

        const taskData = detailsResult.data;
        const status = taskData?.status || taskData?.state;

        // Перевіряємо статус задачі
        if (status === 'completed' || status === 'success' || taskData?.video_url || taskData?.result_url) {
          finalResult = {
            success: true,
            videoUrl: taskData.video_url || taskData.result_url || taskData.output_url
          };
          break;
        }

        if (status === 'failed' || status === 'error') {
          finalResult = {
            success: false,
            error: taskData.error_message || taskData.message || 'Task failed'
          };
          break;
        }

        // Якщо статус 'processing' або 'running' - продовжуємо polling
        if (attempts % 12 === 0) { // Кожні 60 секунд
          console.log(`🔥 A2E: Task ${taskId} still processing... (attempt ${attempts}/${maxAttempts})`);
        }
      }

      if (!finalResult) {
        finalResult = {
          success: false,
          error: 'Timeout waiting for A2E task completion'
        };
      }

      if (!finalResult.success || !finalResult.videoUrl) {
        await adminNotifier.notifyAdmin(bot, new Error(finalResult.error || 'A2E generation failed'), {
          userId, username, action: 'a2e_motion_generation', model: model.name,
          taskId: taskId
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації A2E Motion.\n\n${finalResult.error || 'Генерація не вдалась'}\n\nСпробуйте ще раз.`
        );

        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey: 'a2e_motion',
          success: false,
          isTrial,
          isFree: isTrial,
          errorCode: finalResult.error?.substring(0, 100)
        });

        gracefulShutdown.completeGeneration(statusMsg.message_id, false);
        return;
      }

      // Віднімаємо токени
      await userBalance.deductTokens(userId, cost, `${model.name} generation`, {
        modelKey: 'a2e_motion',
        modelName: model.name,
        apiCost,
        prompt: generationData.prompt,
        duration: duration
      });

      // Зберігаємо результат в MongoDB
      try {
        await GenerationResult.create({
          userId,
          username,
          modelKey: 'a2e_motion',
          modelName: model.name,
          resultUrl: finalResult.videoUrl,
          resultType: 'video',
          prompt: generationData.prompt,
          options: {
            duration,
            imageUrl: generationData.imageUrl,
            negativePrompt: generationData.negativePrompt
          },
          duration,
          success: true,
          provider: 'a2e',
          providerTaskId: taskId,
          tokensSpent: cost,
          apiCostUSD: apiCost,
          generatedAt: new Date()
        });
        console.log(`✅ A2E: Result saved to MongoDB for user ${userId}`);
      } catch (dbError) {
        console.error('❌ A2E: Failed to save result to MongoDB:', dbError);
        // Не блокуємо успішну генерацію через помилку БД
      }

      const isTrial = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey: 'a2e_motion',
        success: true,
        isTrial,
        isFree: isTrial
      });

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>Motion без омеженнь готово!</b>\n\n` +
        `⏱️ Тривалість: ${duration} сек\n` +
        `📝 Промпт: ${generationData.prompt.substring(0, 100)}...\n\n` +
        `💰 Витрачено: ${cost}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, finalResult.videoUrl, {
        caption: `🔥 Motion без омеженнь\n\n⏱️ ${duration} сек\n📝 ${generationData.prompt.substring(0, 80)}...\n\n💰 Витрачено: ${cost}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

      gracefulShutdown.completeGeneration(statusMsg.message_id, true);

    } catch (error) {
      console.error('A2E Motion generation failed:', error);
      await adminNotifier.notifyAdmin(bot, error, {
        userId, username, action: 'a2e_motion_generation', model: model.name
      });
      try {
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '❌ Помилка генерації A2E Motion. Спробуйте ще раз.'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації A2E Motion. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      }
      gracefulShutdown.completeGeneration(statusMsg.message_id, false);
    }
  })();
}

// Генерувати Kling відразу
bot.action('kling_generate_now', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  await ctx.reply('🚀 Починаємо генерацію Kling...');
  runBackgroundTask(() => generateKlingVideo(ctx, state), 'kling_generate_now');
});

// ==================== KLING GENERATION FUNCTION ====================

async function generateKlingVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;
  const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
  const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');

  if (!model) {
    await ctx.reply('❌ Модель Kling не знайдена');
    userState.delete(userId);
    return;
  }

  const supportsEndImage = model.supportsEndImage !== false;
  const duration = state.duration || model.durations?.[0] || 5;
  const useAudio = state.generateAudio === true;
  const costPerSec = modelKey === 'kling_v2_6'
    ? getEffectiveKlingV2_6CostPerSecond(userId, model, useAudio)
    : getEffectiveKlingCostPerSecond(userId);
  const apiCostPerSec = useAudio
    ? (model.apiCostPerSecondAudio || model.apiCostPerSecond || 0.07)
    : (model.apiCostPerSecond || model.apiCostPerSecondNoAudio || 0.07);
  const klingCost = state.klingCost || (duration * costPerSec);
  const apiCost = duration * apiCostPerSec;

  if (!(await userBalance.hasTokens(userId, klingCost))) {
    await showInsufficientTokens(ctx, klingCost);
    userState.delete(userId);
    return;
  }

  const hasStartImage = !!state.startImage;
  const hasEndImage = supportsEndImage && !!state.endImage;
  const endImageLine = supportsEndImage ? `🎬 Кінцеве зображення: ${hasEndImage ? 'Так' : 'Ні'}\n` : '';
  const audioLine = state.generateAudio !== undefined ? `🔊 Аудіо: ${useAudio ? 'Так' : 'Ні'}\n` : '';

  const statusMsg = await ctx.reply(
    `<b>${model.name} - Генерація</b>\n\n` +
    `⏱️ Тривалість: ${duration} сек\n` +
    `📐 Пропорції: ${state.aspectRatio || '16:9'}\n` +
    `🖼️ Початкове зображення: ${hasStartImage ? 'Так' : 'Ні'}\n` +
    `${endImageLine}` +
    `${audioLine}` +
    `\n📝 Промпт: "${state.prompt?.substring(0, 100)}${state.prompt?.length > 100 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти 2-5 хвилин...\n` +
    `💡 <i>Ви можете продовжувати користуватись ботом поки генерація йде!</i>`,
    { parse_mode: 'HTML' }
  );

  // ✅ ОЧИЩУЄМО СТАН ОДРАЗУ - щоб користувач міг працювати з ботом далі
  userState.delete(userId);
  userCurrentModel.delete(userId);

  // ✅ ЗАПУСКАЄМО ГЕНЕРАЦІЮ У ФОНІ
  const generationData = { ...state };

  (async () => {
    try {
      // Перевіряємо чи можемо використовувати KIE.AI
      const userChosenProvider = userProviderChoice.get(userId);
      const canUseKieAI = accessControl.canUseKieAI(userId) && kieAI.isKieAIEnabled;

      let useKieAI = false;
      if (userChosenProvider === 'kie-ai') {
        useKieAI = kieAI.isKieAIImplemented(modelKey);
      } else if (userChosenProvider === 'replicate') {
        useKieAI = false;
      } else {
        useKieAI = canUseKieAI && kieAI.isKieAIImplemented(modelKey);
      }

      const providerName = useKieAI ? 'KIE.AI' : 'Replicate';
      console.log(`🎯 Kling using provider: ${providerName}`);

      let result;

      if (useKieAI) {
        // KIE.AI підтримує Kling v2.5 та v2.6
        const version = modelKey === 'kling_v2_6' ? 'v2.6' : 'v2.5';
        const enableSound = generationData.generateAudio === true;

        result = await kieAI.generateKlingVideoKieAI(
          generationData.prompt,
          generationData.startImage || null,
          duration,
          generationData.aspectRatio || '16:9',
          enableSound,
          version
        );
      } else {
        // Replicate
        const generator = modelKey === 'kling_v2_6'
          ? replicate.generateVideoWithKling26
          : replicate.generateVideoWithKling;

        result = modelKey === 'kling_v2_6'
          ? await generator(
            generationData.prompt,
            generationData.startImage || null,
            duration,
            generationData.aspectRatio || '16:9',
            generationData.generateAudio === true,
            model.audioParam || 'generate_audio'
          )
          : await generator(
            generationData.prompt,
            generationData.startImage || null,
            supportsEndImage ? (generationData.endImage || null) : null,
            duration,
            generationData.aspectRatio || '16:9'
          );
      }

      if (!result.success && result.pending && result.taskId) {
        console.log(`⏱️ Kling task ${result.taskId} pending — recovery for user ${userId}`);
        await bot.telegram.editMessageText(chatId, statusMsg.message_id, null,
          `⏳ <b>${model.name} ще генерується...</b>\n\nВідео буде надіслано автоматично.\n🔄 Перевіряємо у фоні...`,
          { parse_mode: 'HTML' }
        );
        startVideoRecoveryPolling({
          chatId, userId, username, modelKey, modelLabel: model.name,
          taskId: result.taskId, cost: klingCost, deductDescription: `${model.name} generation`,
          deductMeta: { modelKey, modelName: model.name, apiCost,
            prompt: generationData.prompt, duration, hasStartImage, hasEndImage,
            generateAudio: generationData.generateAudio === true },
          promptSnippet: `⏱️ ${duration} сек | 📐 ${generationData.aspectRatio || '16:9'}`,
          captionLine: `${model.name}\n⏱️ ${duration}сек | 📐 ${generationData.aspectRatio || '16:9'}`,
          monitorOptions: { options: { duration, generateAudio: generationData.generateAudio === true }, provider: useKieAI ? 'kie' : 'replicate' }
        });
        return;
      }

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), {
          userId, username, action: 'kling_generation', model: model.name,
          prompt: generationData.prompt, duration: duration
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації Kling.\n\n${result.error}\n\nСпробуйте ще раз або оберіть іншу модель.`
        );

        // 📊 Логуємо невдалу генерацію
        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey,
          success: false,
          options: { duration, generateAudio: generationData.generateAudio === true },
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100),
          provider: useKieAI ? 'kie' : 'replicate'
        });

        return;
      }

      await userBalance.deductTokens(userId, klingCost, `${model.name} generation`, {
        modelKey, modelName: model.name, apiCost: apiCost,
        prompt: generationData.prompt, duration: duration,
        hasStartImage: hasStartImage,
        hasEndImage: hasEndImage,
        generateAudio: generationData.generateAudio === true
      });

      // 📊 Логуємо успішну генерацію
      const isTrialKling = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey,
        success: true,
        options: { duration, generateAudio: generationData.generateAudio === true },
        isTrial: isTrialKling,
        isFree: isTrialKling,
        provider: useKieAI ? 'kie' : 'replicate'
      });

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>${model.name} готово!</b>\n\n` +
        `❗️<b>ЗБЕРЕЖІТЬ ВІДЕО В ГАЛЕРЕЮ ЩОБ ОТРИМАТИ ПРАВИЛЬНИЙ РОЗМІР</b>\n\n` +
        `⏱️ Тривалість: ${duration} сек\n` +
        `📐 Пропорції: ${generationData.aspectRatio || '16:9'}\n` +
        `${audioLine}` +
        `📝 Промпт: ${generationData.prompt?.substring(0, 100)}...\n\n` +
        `💰 Витрачено: ${klingCost}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, result.videoUrl, {
        caption: `${model.name}\n\n⏱️ ${duration}сек | 📐 ${generationData.aspectRatio || '16:9'}${audioLine ? ` | ${useAudio ? '🔊 Аудіо' : '🔇 Без аудіо'}` : ''}\n📝 ${generationData.prompt?.substring(0, 80)}...\n\n💰 Витрачено: ${klingCost}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

      // ✅ Записуємо Trial usage
      recordTrialUsage(userId, modelKey);

    } catch (error) {
      console.error('Kling generation failed:', error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'kling_generation', model: model.name });
      try {
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '❌ Помилка генерації Kling. Спробуйте ще раз.'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації Kling. Спробуйте ще раз.');
      }
    }
  })();
}

// ==================== KLING 3.0 (KIE.AI) GENERATION FUNCTION ====================

/** Вартість Kling 3.0 за секунду (токени): з кешу KIE + 30% націнка, якщо KIE_AI_USE_CACHE_PRICING не 'false'. */
/** Ціна Kling 3.0 за секунду; використовуйте getEffectiveKling3CostPerSecond(userId, mode, withAudio) замість цієї функції. */
function getKling3CostPerSecond(model, mode = 'pro', withAudio = false) {
  return withAudio ? (model?.costPerSecondAudio ?? 45) : (model?.costPerSecondNoAudio ?? 23);
}

async function generateKling3Video(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;
  const model = models.video.models.find(m => m.key === 'kling_3');

  if (!model) {
    await ctx.reply('❌ Модель Kling 3.0 не знайдена');
    userState.delete(userId);
    return;
  }

  const multiShots = state.multiShots === true && Array.isArray(state.multiPrompt) && state.multiPrompt.length > 0;
  const prompt = state.prompt || '';
  const duration = state.duration || (multiShots ? state.multiPrompt.reduce((s, x) => s + (x.duration || 0), 0) : 5);
  const aspectRatio = state.aspectRatio || '16:9';
  const mode = state.mode || 'pro';
  const generateAudio = state.generateAudio === true;
  const costPerSec = getEffectiveKling3CostPerSecond(userId, mode, generateAudio);
  const kling3Cost = state.kling3Cost || (duration * costPerSec);
  const imageUrls = state.startImage ? [state.startImage] : [];
  const elements = state.elements || [];
  const klingElements = elements.map(el => ({
    name: el.name,
    description: el.description || el.name,
    ...(el.imageUrls?.length ? { imageUrls: el.imageUrls } : {}),
    ...(el.videoUrl ? { videoUrl: el.videoUrl } : {})
  })).filter(el => el.imageUrls?.length || el.videoUrl);

  if (!multiShots && (!prompt || prompt.length < 5)) {
    await ctx.reply('❌ Введіть промпт (мінімум 5 символів).');
    userState.delete(userId);
    return;
  }
  if (multiShots && (!state.multiPrompt || state.multiPrompt.length === 0)) {
    await ctx.reply('❌ Немає сцен для multi-shot. Почніть заново.');
    userState.delete(userId);
    return;
  }

  if (!(await userBalance.hasTokens(userId, kling3Cost))) {
    await showInsufficientTokens(ctx, kling3Cost);
    userState.delete(userId);
    return;
  }

  const statusMsg = await ctx.reply(
    `🎭 <b>Kling 3.0 Pro 💎 - Генерація</b>\n\n` +
    `⏱️ ${duration} сек | 📐 ${aspectRatio} | ${mode.toUpperCase()} | ${generateAudio ? '🔊' : '🔇'}\n` +
    `📝 "${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти 2–5 хвилин...\n` +
    `💡 <i>Ви можете продовжувати користуватись ботом!</i>`,
    { parse_mode: 'HTML' }
  );

  userState.delete(userId);
  userCurrentModel.delete(userId);

  const generationData = {
    ...state,
    prompt,
    duration,
    aspectRatio,
    mode,
    generateAudio,
    imageUrls,
    kling3Cost,
    klingElements,
    multiShots,
    multiPrompt: state.multiPrompt || []
  };

  (async () => {
    try {
      const result = await kieAI.generateKling3VideoKieAI({
        prompt: multiShots ? '' : generationData.prompt,
        imageUrls: generationData.imageUrls,
        duration: String(Math.min(15, Math.max(3, duration))),
        aspectRatio: generationData.aspectRatio,
        mode: generationData.mode,
        sound: generationData.generateAudio,
        multiShots: generationData.multiShots || false,
        multiPrompt: generationData.multiShots ? generationData.multiPrompt : undefined,
        klingElements: generationData.klingElements?.length ? generationData.klingElements : undefined
      });

      if (!result.success && result.pending && result.taskId) {
        console.log(`⏱️ Kling 3.0 task ${result.taskId} pending — recovery for user ${userId}`);
        await bot.telegram.editMessageText(chatId, statusMsg.message_id, null,
          `⏳ <b>Kling 3.0 Pro ще генерується...</b>\n\nВідео буде надіслано автоматично.\n🔄 Перевіряємо у фоні...`,
          { parse_mode: 'HTML' }
        );
        const apiCostK3 = generationData.duration * (generationData.generateAudio ? model.apiCostPerSecondAudio : model.apiCostPerSecondNoAudio);
        startVideoRecoveryPolling({
          chatId, userId, username, modelKey: 'kling_3', modelLabel: 'Kling 3.0 Pro 💎',
          taskId: result.taskId, cost: kling3Cost, deductDescription: `${model.name} generation`,
          deductMeta: { modelKey: 'kling_3', modelName: model.name, apiCost: apiCostK3,
            prompt: generationData.prompt, duration: generationData.duration,
            hasStartImage: generationData.imageUrls?.length > 0, generateAudio: generationData.generateAudio },
          promptSnippet: `⏱️ ${generationData.duration} сек | 📐 ${generationData.aspectRatio} | ${generationData.generateAudio ? '🔊' : '🔇'}`,
          captionLine: `🎭 Kling 3.0 Pro 💎\n⏱️ ${generationData.duration}сек | 📐 ${generationData.aspectRatio} | ${generationData.generateAudio ? '🔊' : '🔇'}`,
          monitorOptions: { options: { duration: generationData.duration, mode: generationData.mode, generateAudio: generationData.generateAudio }, provider: 'kie' }
        });
        return;
      }

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), {
          userId, username, action: 'kling_3_generation', model: model.name,
          prompt: generationData.prompt, duration: generationData.duration
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації Kling 3.0.\n\n${result.error}\n\nСпробуйте ще раз.`
        );

        // 📊 Логуємо невдалу генерацію
        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey: 'kling_3',
          success: false,
          options: { duration: generationData.duration, mode: generationData.mode, generateAudio: generationData.generateAudio },
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100),
          provider: 'kie'  // Kling 3.0 тільки на KIE.AI
        });

        return;
      }

      const apiCost = generationData.duration * (generationData.generateAudio ? model.apiCostPerSecondAudio : model.apiCostPerSecondNoAudio);
      await userBalance.deductTokens(userId, kling3Cost, `${model.name} generation`, {
        modelKey: 'kling_3', modelName: model.name, apiCost,
        prompt: generationData.prompt, duration: generationData.duration,
        hasStartImage: generationData.imageUrls?.length > 0,
        generateAudio: generationData.generateAudio
      });

      // 📊 Логуємо успішну генерацію
      const isTrialKling3 = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey: 'kling_3',
        success: true,
        options: { duration: generationData.duration, mode: generationData.mode, generateAudio: generationData.generateAudio },
        isTrial: isTrialKling3,
        isFree: isTrialKling3,
        provider: 'kie'  // Kling 3.0 тільки на KIE.AI
      });

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>Kling 3.0 Pro 💎 готово!</b>\n\n` +
        `❗️<b>ЗБЕРЕЖІТЬ ВІДЕО В ГАЛЕРЕЮ ЩОБ ОТРИМАТИ ПРАВИЛЬНИЙ РОЗМІР</b>\n\n` +
        `⏱️ ${generationData.duration} сек | 📐 ${generationData.aspectRatio} | ${generationData.generateAudio ? '🔊' : '🔇'}\n` +
        `📝 Промпт: ${generationData.prompt?.substring(0, 100)}...\n\n` +
        `💰 Витрачено: ${kling3Cost}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, result.videoUrl, {
        caption: `🎭 Kling 3.0 Pro 💎\n\n⏱️ ${generationData.duration}сек | 📐 ${generationData.aspectRatio} | ${generationData.generateAudio ? '🔊' : '🔇'}\n📝 ${generationData.prompt?.substring(0, 80)}...\n\n💰 Витрачено: ${kling3Cost}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

    } catch (error) {
      console.error('Kling 3.0 generation failed:', error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'kling_3_generation', model: model.name });
      try {
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '❌ Помилка генерації Kling 3.0. Спробуйте ще раз.'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації Kling 3.0. Спробуйте ще раз.');
      }
    }
  })();
}

// ==================== RUNWAY TURBO GENERATION FUNCTION ====================

async function generateRunwayTurboVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;
  const model = models.video.models.find(m => m.key === 'runway_turbo');

  if (!model) {
    await ctx.reply('❌ Модель Runway Turbo не знайдена');
    userState.delete(userId);
    return;
  }

  const duration = state.duration || 5;
  const aspectRatio = state.aspectRatio || '16:9';
  const costPerSec = getEffectiveRunwayTurboCostPerSecond(userId);
  const runwayCost = duration * costPerSec;
  const apiCostPerSec = model.apiCostPerSecond || (model.apiCost / 5);
  const apiCost = duration * apiCostPerSec;

  if (!(await userBalance.hasTokens(userId, runwayCost))) {
    await showInsufficientTokens(ctx, runwayCost);
    userState.delete(userId);
    return;
  }

  const statusMsg = await ctx.reply(
    `🎬 <b>Runway Gen-4 Turbo - Генерація</b>\n\n` +
    `⏱️ Тривалість: ${duration} сек\n` +
    `📐 Пропорції: ${aspectRatio}\n` +
    `🖼️ Початкове зображення: Так\n\n` +
    `📝 Промпт: "${state.prompt?.substring(0, 100)}${state.prompt?.length > 100 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти 1-3 хвилини...\n` +
    `💡 <i>Ви можете продовжувати користуватись ботом поки генерація йде!</i>`,
    { parse_mode: 'HTML' }
  );

  // ✅ ОЧИЩУЄМО СТАН ОДРАЗУ - щоб користувач міг працювати з ботом далі
  userState.delete(userId);
  userCurrentModel.delete(userId);

  const generationData = { ...state };

  (async () => {
    try {
      const result = await replicate.generateVideoWithRunwayTurbo(
        generationData.prompt,
        generationData.startImage,
        duration,
        aspectRatio
      );

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), {
          userId, username, action: 'runway_turbo_generation', model: model.name,
          prompt: generationData.prompt, duration: duration
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації Runway Turbo.\n\n${result.error}\n\nСпробуйте ще раз або оберіть іншу модель.`
        );

        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey: 'runway_turbo',
          success: false,
          options: { duration, aspectRatio },
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100)
        });

        return;
      }

      await userBalance.deductTokens(userId, runwayCost, `${model.name} generation`, {
        modelKey: 'runway_turbo',
        modelName: model.name,
        apiCost: apiCost,
        prompt: generationData.prompt,
        duration: duration,
        aspectRatio: aspectRatio,
        hasStartImage: true
      });

      const isTrialRunway = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey: 'runway_turbo',
        success: true,
        options: { duration, aspectRatio },
        isTrial: isTrialRunway,
        isFree: isTrialRunway
      });

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>Runway Gen-4 Turbo готово!</b>\n\n` +
        `❗️<b>ЗБЕРЕЖІТЬ ВІДЕО В ГАЛЕРЕЮ ЩОБ ОТРИМАТИ ПРАВИЛЬНИЙ РОЗМІР</b>\n\n` +
        `⏱️ ${duration} сек | 📐 ${aspectRatio}\n` +
        `📝 Промпт: ${generationData.prompt?.substring(0, 100)}...\n\n` +
        `💰 Витрачено: ${runwayCost.toFixed(1)}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, result.videoUrl, {
        caption: `🎬 Runway Turbo\n\n⏱️ ${duration}сек | 📐 ${aspectRatio}\n📝 ${generationData.prompt?.substring(0, 80)}...\n\n💰 Витрачено: ${runwayCost.toFixed(1)}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

      recordTrialUsage(userId, 'runway_turbo');

    } catch (error) {
      console.error('Runway Turbo generation failed:', error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'runway_turbo_generation', model: model.name });
      try {
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '❌ Помилка генерації Runway Turbo. Спробуйте ще раз.'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації Runway Turbo. Спробуйте ще раз.');
      }
    }
  })();
}

// ==================== VEO GENERATION FUNCTION ====================

async function generateVeoVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;
  const model = models.video.models.find(m => m.key === 'veo');

  if (!model) {
    await ctx.reply('❌ Модель Veo не знайдена');
    userState.delete(userId);
    return;
  }

  const duration = state.duration || 8;
  const generateAudio = state.generateAudio !== false;
  const veoModel = state.veoModel || 'veo3_fast';
  const veoModelLabel = veoModel === 'veo3' ? '💎 Quality' : '⚡ Fast';
  const veoCost = state.veoCost || getEffectiveVeoFlatCost(userId, veoModel);
  const apiCost = getVeoApiCostUSD(veoModel);

  if (!(await userBalance.hasTokens(userId, veoCost))) {
    await showInsufficientTokens(ctx, veoCost);
    userState.delete(userId);
    return;
  }

  const hasStartImage = !!state.startImage;
  const hasLastFrame = !!state.lastFrame;

  const statusMsg = await ctx.reply(
    `🌟 <b>Google Veo 3.1 ${veoModelLabel} - Генерація</b>\n\n` +
    `🎯 Модель: ${veoModelLabel}\n` +
    `📐 Пропорції: ${state.aspectRatio}\n` +
    `⏱️ Тривалість: ${duration} сек\n` +
    `🔊 Аудіо: ${generateAudio ? 'Так' : 'Ні'}\n` +
    `🖼️ Стартове зображення: ${hasStartImage ? 'Так' : 'Ні'}\n` +
    `🎬 Останній кадр: ${hasLastFrame ? 'Так' : 'Ні'}\n\n` +
    `📝 Промпт: "${state.prompt?.substring(0, 100)}${state.prompt?.length > 100 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти ${veoModel === 'veo3' ? '3-8' : '2-5'} хвилин...\n` +
    `💡 <i>Ви можете продовжувати користуватись ботом поки генерація йде!</i>`,
    { parse_mode: 'HTML' }
  );

  // ✅ ОЧИЩУЄМО СТАН ОДРАЗУ - щоб користувач міг працювати з ботом далі
  userState.delete(userId);
  userCurrentModel.delete(userId);

  // ✅ ЗАПУСКАЄМО ГЕНЕРАЦІЮ У ФОНІ (без await на верхньому рівні)
  // Зберігаємо необхідні дані локально
  const generationData = { ...state };

  // Асинхронна функція що виконується у фоні
  (async () => {
    try {
      // Перевіряємо чи можемо використовувати KIE.AI
      const userChosenProvider = userProviderChoice.get(userId);
      const canUseKieAI = accessControl.canUseKieAI(userId) && kieAI.isKieAIEnabled;

      let useKieAI = false;
      if (userChosenProvider === 'kie-ai') {
        useKieAI = kieAI.isKieAIImplemented('veo');
      } else if (userChosenProvider === 'replicate') {
        useKieAI = false;
      } else {
        useKieAI = canUseKieAI && kieAI.isKieAIImplemented('veo');
      }

      const providerName = useKieAI ? 'KIE.AI' : 'Replicate';
      console.log(`🎯 Veo using provider: ${providerName}`);

      // Будуємо масив imageUrls та generationType для KIE.AI Veo
      let veoImageUrls = [];
      let veoGenerationType = null;
      if (generationData.references && generationData.references.length > 0) {
        // Reference mode: масив reference зображень (до 3)
        veoImageUrls = generationData.references.slice(0, 3);
        veoGenerationType = 'REFERENCE_2_VIDEO';
      } else if (generationData.startImage && generationData.lastFrame) {
        // First + last frame mode
        veoImageUrls = [generationData.startImage, generationData.lastFrame];
        veoGenerationType = 'FIRST_AND_LAST_FRAMES_2_VIDEO';
      } else if (generationData.startImage) {
        // Тільки стартовий кадр
        veoImageUrls = [generationData.startImage];
        veoGenerationType = 'FIRST_AND_LAST_FRAMES_2_VIDEO';
      } else if (generationData.lastFrame) {
        // Тільки останній кадр
        veoImageUrls = [generationData.lastFrame];
        veoGenerationType = 'FIRST_AND_LAST_FRAMES_2_VIDEO';
      } else {
        veoGenerationType = 'TEXT_2_VIDEO';
      }

      console.log(`🎥 Veo KIE.AI payload: generationType=${veoGenerationType}, imageUrls=${veoImageUrls.length}, model=${generationData.veoModel || 'veo3_fast'}`);

      const result = useKieAI
        ? await kieAI.generateVeoKieAI(generationData.prompt, {
            imageUrls: veoImageUrls,
            generationType: veoGenerationType,
            aspectRatio: generationData.aspectRatio,
            model: generationData.veoModel || 'veo3_fast',
            generateAudio: generateAudio
          })
        : await replicate.generateVideoWithVeo(
            generationData.prompt,
            generationData.references || [],
            generationData.lastFrame || null,
            generationData.aspectRatio,
            duration,
            '', // negative prompt
            generationData.startImage || null,
            generateAudio
          );

      // ⏱️ PENDING: відео ще генерується після таймауту polling — продовжуємо у фоні
      if (!result.success && result.pending && result.taskId) {
        console.log(`⏱️ Veo task ${result.taskId} pending — starting background recovery for user ${userId}`);
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `⏳ <b>Google Veo 3.1 ще генерується...</b>\n\n` +
          `Генерація займає більше часу ніж очікувалось.\n` +
          `Відео буде надіслано автоматично, коли буде готове.\n\n` +
          `🔄 Продовжуємо перевіряти статус у фоні...`,
          { parse_mode: 'HTML' }
        );

        // Фоновий recovery polling
        const recoveryTaskId = result.taskId;
        (async () => {
          const maxRecoveryAttempts = 2160; // ще 3 години (2160 * 5s)
          const recoveryInterval = 5000;
          let recoveryAttempts = 0;
          while (recoveryAttempts < maxRecoveryAttempts) {
            try {
              await new Promise(r => setTimeout(r, recoveryInterval));
              recoveryAttempts++;
              // Використовуємо Veo-специфічний endpoint
              const job = await kieAI.fetchVeoTaskInfoExported(recoveryTaskId);
              if (!job) continue;
              const jobState = (job.state || job.status || '').toLowerCase();
              if (recoveryAttempts % 12 === 0) { // логуємо кожну хвилину
                console.log(`🔄 Veo recovery poll (${recoveryAttempts}/${maxRecoveryAttempts}): taskId=${recoveryTaskId} state=${jobState}`);
              }
              if (jobState === 'success' || jobState === 'completed') {
                const videoUrl = kieAI.extractVideoUrlExported(job);
                console.log(`📹 Veo recovery extracted URL: ${videoUrl ? videoUrl.substring(0, 100) : 'NULL'}`);
                if (!videoUrl) {
                  console.error(`❌ Veo recovery: no URL. Job keys: ${Object.keys(job).join(',')}`);
                  if (job.info) console.error(`❌ Veo recovery info: ${JSON.stringify(job.info).substring(0, 500)}`);
                  if (job.resultJson) console.error(`❌ Veo recovery resultJson: ${String(job.resultJson).substring(0, 500)}`);
                  await bot.telegram.sendMessage(chatId, `❌ Veo 3.1: відео згенеровано, але URL не знайдено. Зверніться до підтримки. TaskId: ${recoveryTaskId}`);
                  return;
                }
                // Списуємо токени
                await userBalance.deductTokens(userId, veoCost, `${model.name} generation`, {
                  modelKey: 'veo', modelName: model.name, apiCost: apiCost,
                  prompt: generationData.prompt, aspectRatio: generationData.aspectRatio,
                  duration: duration, generateAudio: generateAudio,
                  hasStartImage: hasStartImage,
                  references: generationData.references?.length || 0,
                  hasLastFrame: hasLastFrame
                });
                const isTrialVeo = await isTrialUser(userId);
                await monitoringLoggers.logUsageEvent({
                  userId, modelKey: 'veo', success: true,
                  options: { duration, generateAudio }, isTrial: isTrialVeo, isFree: isTrialVeo
                });
                await bot.telegram.sendMessage(
                  chatId,
                  `✅ <b>Google Veo 3.1 готово!</b>\n\n` +
                  `❗️<b>ЗБЕРЕЖІТЬ ВІДЕО В ГАЛЕРЕЮ ЩОБ ОТРИМАТИ ПРАВИЛЬНИЙ РОЗМІР</b>\n\n` +
                  `📐 Пропорції: ${generationData.aspectRatio}\n` +
                  `⏱️ Тривалість: ${duration} сек\n` +
                  `🔊 Аудіо: ${generateAudio ? 'Так' : 'Ні'}\n` +
                  `📝 Промпт: ${generationData.prompt?.substring(0, 100)}...\n\n` +
                  `💾 <b>Як зберегти:</b>\n` +
                  `1️⃣ Натисніть на відео нижче\n` +
                  `2️⃣ Натисніть ⋮ → "Зберегти"\n\n` +
                  `💰 Витрачено: ${veoCost}⚡`,
                  { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
                );
                await safeSendVideo(chatId, videoUrl, {
                  caption: `🌟 Google Veo 3.1\n\n📐 ${generationData.aspectRatio} | ⏱️ ${duration}сек | ${generateAudio ? '🔊' : '🔇'}\n📝 ${generationData.prompt?.substring(0, 80)}...\n\n💰 Витрачено: ${veoCost}⚡`,
                  ...keyboard.createBackButton('video_menu')
                });
                return;
              }
              if (jobState === 'fail' || jobState === 'failed' || jobState === 'error') {
                const errMsg = job.failMsg || job.failCode || 'Unknown error';
                console.error(`❌ Veo recovery: task ${recoveryTaskId} failed: ${errMsg}`);
                await bot.telegram.sendMessage(chatId, `❌ Veo 3.1: генерація не вдалась.\n${errMsg}`);
                return;
              }
            } catch (e) {
              console.error(`⚠️ Veo recovery poll error (${recoveryAttempts}):`, e.message);
            }
          }
          // Вичерпали всі спроби
          console.error(`❌ Veo recovery: task ${recoveryTaskId} never completed after extended wait`);
          await bot.telegram.sendMessage(chatId,
            `❌ <b>Google Veo 3.1: Генерація не завершилась</b>\n\n` +
            `Ваші токени НЕ були списані.\n` +
            `TaskId: <code>${recoveryTaskId}</code>\n\n` +
            `Зверніться до підтримки якщо відео існує на kie.ai`,
            { parse_mode: 'HTML' }
          );
          await adminNotifier.notifyAdmin(bot, new Error(`Veo recovery exhausted: ${recoveryTaskId}`), {
            userId, username, action: 'veo_generation_recovery', taskId: recoveryTaskId
          });
        })();
        return;
      }

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), {
          userId, username, action: 'veo_generation', model: model.name,
          prompt: generationData.prompt, aspectRatio: generationData.aspectRatio
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації Veo 3.1.\n\n${result.error}\n\nСпробуйте ще раз або оберіть іншу модель.`
        );

        // 📊 Логуємо невдалу генерацію
        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey: 'veo',
          success: false,
          options: { duration, generateAudio },
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100)
        });

        return;
      }

      await userBalance.deductTokens(userId, veoCost, `${model.name} generation`, {
        modelKey: 'veo', modelName: model.name, apiCost: apiCost,
        prompt: generationData.prompt, aspectRatio: generationData.aspectRatio,
        duration: duration, generateAudio: generateAudio,
        hasStartImage: hasStartImage,
        references: generationData.references?.length || 0,
        hasLastFrame: hasLastFrame
      });

      // 📊 Логуємо успішну генерацію
      const isTrialVeo = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey: 'veo',
        success: true,
        options: { duration, generateAudio },
        isTrial: isTrialVeo,
        isFree: isTrialVeo
      });

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      // Попередження перед відео
      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>Google Veo 3.1 готово!</b>\n\n` +
        `❗️<b>ЗБЕРЕЖІТЬ ВІДЕО В ГАЛЕРЕЮ ЩОБ ОТРИМАТИ ПРАВИЛЬНИЙ РОЗМІР</b>\n\n` +
        `📐 Пропорції: ${generationData.aspectRatio}\n` +
        `⏱️ Тривалість: ${duration} сек\n` +
        `🔊 Аудіо: ${generateAudio ? 'Так' : 'Ні'}\n` +
        `📝 Промпт: ${generationData.prompt?.substring(0, 100)}...\n\n` +
        `💾 <b>Як зберегти:</b>\n` +
        `1️⃣ Натисніть на відео нижче\n` +
        `2️⃣ Натисніть ⋮ → "Зберегти"\n\n` +
        `💰 Витрачено: ${veoCost}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, result.videoUrl, {
        caption: `🌟 Google Veo 3.1\n\n📐 ${generationData.aspectRatio} | ⏱️ ${duration}сек | ${generateAudio ? '🔊' : '🔇'}\n📝 ${generationData.prompt?.substring(0, 80)}...\n\n💰 Витрачено: ${veoCost}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

    } catch (error) {
      console.error('Veo 3.1 generation failed:', error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'veo_generation', model: model.name });
      try {
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '❌ Помилка генерації Veo 3.1. Спробуйте ще раз.'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації Veo 3.1. Спробуйте ще раз.');
      }
    }
  })();
}

// ==================== SORA 2 GENERATION FUNCTION ====================

async function generateSoraVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;
  const model = models.video.models.find(m => m.key === 'sora_2');

  if (!model) {
    await ctx.reply('❌ Модель Sora 2 не знайдена');
    userState.delete(userId);
    return;
  }

  const duration = state.duration || 4;
  const aspectRatio = state.aspectRatio || 'portrait';
  const hasReference = !!state.inputReference;
  const soraCost = getEffectiveSora2Cost(userId, model, duration, {
    soraType: hasReference ? (duration >= 15 ? 'image_to_video_15s' : 'image_to_video_10s') : (duration >= 15 ? 'text_to_video_15s' : duration >= 10 ? 'image_to_video_10s' : null)
  });
  const apiCostPerSec = model.apiCostPerSecond || 0;
  const apiCost = duration * apiCostPerSec;

  if (!(await userBalance.hasTokens(userId, soraCost))) {
    await showInsufficientTokens(ctx, soraCost);
    userState.delete(userId);
    return;
  }

  const statusMsg = await ctx.reply(
    `🌌 <b>OpenAI Sora 2 - Генерація</b>\n\n` +
    `📐 Пропорції: ${aspectRatio}\n` +
    `⏱️ Тривалість: ${duration} сек\n` +
    `🖼️ Стартове зображення: ${hasReference ? 'Так' : 'Ні'}\n\n` +
    `📝 Промпт: "${state.prompt?.substring(0, 100)}${state.prompt?.length > 100 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти 2-5 хвилин...\n` +
    `💡 <i>Ви можете продовжувати користуватись ботом поки генерація йде!</i>`,
    { parse_mode: 'HTML' }
  );

  userState.delete(userId);
  userCurrentModel.delete(userId);

  const generationData = { ...state };

  (async () => {
    try {
      const result = await replicate.generateVideoWithSora2(
        generationData.prompt,
        duration,
        aspectRatio,
        generationData.inputReference || null
      );

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), {
          userId, username, action: 'sora_generation', model: model.name,
          prompt: generationData.prompt, aspectRatio: aspectRatio
        });
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          `❌ Помилка генерації Sora 2.\n\n${result.error}\n\nСпробуйте ще раз або оберіть іншу модель.`
        );

        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey: 'sora_2',
          success: false,
          options: { duration },
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100)
        });

        return;
      }

      await userBalance.deductTokens(userId, soraCost, `${model.name} generation`, {
        modelKey: 'sora_2',
        modelName: model.name,
        apiCost: apiCost,
        prompt: generationData.prompt,
        duration: duration,
        aspectRatio: aspectRatio,
        hasStartImage: hasReference
      });

      const isTrialSora = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey: 'sora_2',
        success: true,
        options: { duration },
        isTrial: isTrialSora,
        isFree: isTrialSora
      });

      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);

      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>OpenAI Sora 2 готово!</b>\n\n` +
        `📐 Пропорції: ${aspectRatio}\n` +
        `⏱️ Тривалість: ${duration} сек\n` +
        `📝 Промпт: ${generationData.prompt?.substring(0, 100)}...\n\n` +
        `💾 <b>Як зберегти:</b>\n` +
        `1️⃣ Натисніть на відео нижче\n` +
        `2️⃣ Натисніть ⋮ → "Зберегти"\n\n` +
        `💰 Витрачено: ${soraCost}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, result.videoUrl, {
        caption: `🌌 OpenAI Sora 2\n\n📐 ${aspectRatio} | ⏱️ ${duration}сек\n📝 ${generationData.prompt?.substring(0, 80)}...\n\n💰 Витрачено: ${soraCost}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

    } catch (error) {
      console.error('Sora 2 generation failed:', error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'sora_generation', model: model.name });
      try {
        await bot.telegram.editMessageText(
          chatId, statusMsg.message_id, null,
          '❌ Помилка генерації Sora 2. Спробуйте ще раз.'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації Sora 2. Спробуйте ще раз.');
      }
    }
  })();
}

// Audio Models
bot.action(/^(suno|udio|elevenlabs)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const model = models.audio.models.find(m => m.key === modelKey);

  if (!model) {
    await ctx.answerCbQuery('Модель не знайдена');
    return;
  }

  if (model.available === false) {
    await ctx.answerCbQuery('❌ Модель тимчасово недоступна', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();

  if (!(await userBalance.hasTokens(ctx.from.id, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  userCurrentModel.set(ctx.from.id, modelKey);

  await ctx.reply(
    `${model.name}\n\n🎵 Генерація аудіо\n\nНадішліть текст для озвучення.\n\n💰 Вартість: ${model.cost}⚡\n⏱️ Час генерації: ~20-40 секунд`,
    keyboard.createBackButton('audio_menu')
  );
});

// Navigation
bot.action('welcome_start', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageReplyMarkup();
  } catch (error) {
    // Ignore if message can't be edited
  }
  const user = await userBalance.getUser(ctx.from.id, ctx.from);
  await sendMainMenu(ctx, user);
});

bot.action('audio_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🎙️ Аудіо з AI\n\nВиберіть розділ для роботи з аудіо 👇', keyboard.createInlineMenu(models.audio.models, 2));
});

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  userState.delete(userId);
  userCurrentModel.delete(userId);
  imageGenState.delete(userId);
  await ctx.reply('🏠 Головне меню', keyboard.createMainMenu());
});

bot.action('design_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🎨 Дизайн з AI\n\nВиберіть розділ для роботи з зображенням 👇', keyboard.createInlineMenu(getDesignModelsWithEffectiveCost(ctx.from.id), 1));
});

bot.action('video_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🎬 Створення відео\n\nВиберіть розділ для роботи з відео 👇', keyboard.createInlineMenu(getVideoModelsForUser(ctx.from.id), 1));
});

bot.action('profile_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showProfile(ctx);
});

// Tokens purchase
bot.action('buy_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`⚡ Купити токени\n\n Виберіть пакет 👇`, keyboard.createSubscriptionsMenu(ctx.from.id));
});

bot.action('community', async (ctx) => {
  await ctx.answerCbQuery();
  const message = `👥 <b>Спільнота neuro\u200B.lab\u200B.ai</b>

👩‍💼 <b>Авторка:</b> Анастасія Черевань

📱 <b>Соціальні мережі:</b>
- Instagram: https://www.instagram.com/anastasia.che.ai
- Threads: https://www.threads.com/@anastasia.che.ai

💬 <b>Telegram група:</b>
<a href="t.me/+AFbdgWuqG8UxMTVi">neuro\u200B.lab\u200B.ai</a>

Приєднуйтесь до нашої спільноти! 🚀`;

  await ctx.reply(message, { parse_mode: 'HTML', disable_web_page_preview: false, ...keyboard.createBackButton() });
});

bot.action('legal_info', async (ctx) => {
  await ctx.answerCbQuery();
  const message = `📋 <b>Юридична інформація</b>

Перед оплатою будь ласка ознайомтесь з нашими юридичними документами:

📋 <b>Угода користувача</b> - регулює взаємовідносини між мерчантом та власником картки
🔒 <b>Політика приватності</b> - описує як ми обробляємо вашу персональну інформацію

Натисніть на кнопку нижче щоб ознайомитися з повним текстом документів:`;

  await ctx.reply(message, { parse_mode: 'HTML', ...keyboard.createLegalMenu() });
});

bot.action(/^sub_(starter|basic|pro|premium|starter_test)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const planKey = ctx.match[1];
  const sub = models.subscriptions[planKey];
  const userId = ctx.from.id;
  const telegramId = ctx.from.id;

  if (!sub) {
    await ctx.reply('❌ План не знайдено');
    return;
  }

  if (sub.adminOnly && userId !== getAdminTelegramId()) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  // Розраховуємо ціну за токен та економію (базуємось на актуальному STARTER)
  const starterSub = models.subscriptions.starter;
  const starterTokens = starterSub?.tokensWayForPay ?? starterSub?.tokens;
  const starterPricePerToken = starterTokens ? (starterSub.priceUSD / starterTokens) : 0;
  const planTokens = sub.tokensWayForPay ?? sub.tokens;
  const pricePerToken = planTokens ? (sub.priceUSD / planTokens) : 0;
  const savingsPercent = starterPricePerToken && pricePerToken
    ? Math.round((1 - pricePerToken / starterPricePerToken) * 100)
    : 0;

  // Короткий опис пакету в доларах
  let message = `⚡ <b>Пакет ${sub.name}</b> — $${sub.priceUSD}\n\n`;
  message += `💎 Доступ до всіх моделей\n`;
  message += `⏰ Токени НЕ згорають\n`;
  message += `✨ Комбінуйте як завгодно!\n\n`;

  // Показуємо економію для пакетів більших за STARTER
  if (planKey !== 'starter' && savingsPercent > 0) {
    message += `🔥 <b>Економія ${savingsPercent}%</b> порівняно зі STARTER!\n\n`;
  }

  message += `💰 <b>Вартість:</b> $${sub.priceUSD} — ${sub.tokensWayForPay || sub.tokens}⚡ токенів\n`;
  message += `<i>Також можна розрахуватись Telegram Stars:</i>\n`;
  message += `⭐ ${sub.price}⭐ — ${sub.tokens}⚡ токенів\n\n`;
  message += `💡 <i>Чим більший пакет — тим вигідніше!</i>\n\n`;
  message += `📱 Оберіть спосіб оплати 👇`;

  await ctx.reply(message, { parse_mode: 'HTML', ...keyboard.createPaymentMenu(sub.price, planKey, userId, telegramId) });
});

bot.action(/^pay_stars_(starter|basic|pro|premium|starter_test)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const planKey = ctx.match[1];
  const sub = models.subscriptions[planKey];

  if (!sub) {
    await ctx.reply('❌ План не знайдено');
    return;
  }

  if (sub.adminOnly && ctx.from.id !== getAdminTelegramId()) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  const invoice = {
    title: `${sub.name} - ${sub.tokens}⚡ токенів`,
    description: `Купити ${sub.tokens} токенів`,
    payload: JSON.stringify({ type: 'tokens_purchase', plan: planKey }),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: `${sub.name} пакет`, amount: sub.price }]
  };

  try {
    await ctx.replyWithInvoice(invoice);
  } catch (error) {
    console.error('Payment error:', error);
    await ctx.reply('❌ Помилка створення платежу. Спробуйте пізніше.');
  }
});

// ✅ Telegram Stars: pre-checkout handler (required)
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true);
  } catch (error) {
    console.error('pre_checkout_query error:', error);
  }
});

// ✅ Telegram Stars: successful payment handler
bot.on('successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  const userId = ctx.from.id;

  let payload;
  try {
    payload = JSON.parse(payment.invoice_payload || '{}');
  } catch (e) {
    payload = null;
  }

  if (!payload || payload.type !== 'tokens_purchase') {
    console.warn('⚠️ Unknown payment payload:', payment.invoice_payload);
    return;
  }

  const planKey = payload.plan;
  const sub = models.subscriptions[planKey];
  if (!sub) {
    await ctx.reply('❌ План не знайдено. Зверніться до підтримки.');
    return;
  }

  const tokens = sub.tokens; // Stars — без бонусів
  const amountStars = payment.total_amount;

  try {
    await userBalance.addTokens(userId, tokens, 'stars_payment', {
      plan: sub.name,
      planKey,
      stars: amountStars,
      currency: payment.currency,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      providerPaymentChargeId: payment.provider_payment_charge_id
    });

    // Log payment for revenue stats
    try {
      const PaymentEvent = require('./database/models/PaymentEvent');
      await PaymentEvent.logPayment({
        provider: 'stars',
        providerPaymentId: payment.telegram_payment_charge_id || payment.provider_payment_charge_id,
        planKey,
        planName: sub.name,
        amountStars,
        amountUSD: sub.priceUSD ?? null,
        tokensGranted: tokens,
        status: 'success',
        raw: payment
      });
    } catch (e) {
      console.warn('⚠️ Could not log stars payment:', e.message);
    }

    const user = await userBalance.getUser(userId, { id: userId });
    await ctx.reply(
      `✅ <b>Оплату отримано!</b>\n\n` +
      `⭐ Метод: Telegram Stars\n` +
      `💎 Тариф: ${sub.name}\n` +
      `⚡ Токенів нараховано: ${tokens}\n` +
      `💰 Новий баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
      `Дякуємо за покупку! 🎉`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('❌ Stars payment processing error:', error);
    await ctx.reply(
      '⚠️ Платіж отримано, але токени не нараховані.\n' +
      'Ми вже розбираємось. Напишіть в підтримку.',
      keyboard.createMainMenu()
    );
    await adminNotifier.notifyAdmin(bot, error, { userId, action: 'stars_payment', planKey, amountStars });
  }
});

// ==================== MESSAGE HANDLERS ====================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);
  let text = ctx.message.text;  // let - бо може змінитись при накопиченні довгого промпту

  if (text.startsWith('/')) return;

  // ✅ VEO: Якщо юзер надіслав текст замість зображення — одразу запускаємо TEXT_2_VIDEO
  if (state?.action === 'veo_generation' && (state?.step === 'waiting_start_image' || state?.step === 'ask_start_image' || state?.step === 'ask_last_frame' || state?.step === 'waiting_last_frame')) {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Промпт занадто короткий!\n\n' +
        'Напишіть детальніше що хочете бачити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }
    console.log(`📝 Veo: user sent text instead of image at step=${state.step}, treating as TEXT_2_VIDEO prompt`);
    const textState = {
      ...state,
      startImage: null,
      lastFrame: null,
      prompt: text,
      step: 'ready_to_generate'
    };
    userState.set(userId, textState);
    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію без зображення (TEXT_2_VIDEO)...');
    runBackgroundTask(() => generateVeoVideo(ctx, textState), 'veo_generate_text_fallback');
    return;
  }

  // ✅ VEO: Обробка промпту (останній крок)
  if (state?.action === 'veo_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Промпт занадто короткий!\n\n' +
        'Напишіть детальніше що хочете бачити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію...');
    runBackgroundTask(() => generateVeoVideo(ctx, { ...state, prompt: text }), 'veo_generate_text');
    return;
  }

  // ✅ RUNWAY TURBO: Обробка промпту (останній крок)
  if (state?.action === 'runway_turbo_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Промпт занадто короткий!\n\n' +
        'Напишіть детальніше що хочете бачити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    if (!state.startImage) {
      await ctx.reply('❌ Немає початкового зображення. Почніть заново, оберіть Runway Turbo.');
      userState.delete(userId);
      return;
    }

    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію...');
    runBackgroundTask(() => generateRunwayTurboVideo(ctx, { ...state, prompt: text }), 'runway_turbo_generate_text');
    return;
  }

  // ✅ SORA 2: Обробка промпту (останній крок)
  if (state?.action === 'sora_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Промпт занадто короткий!\n\n' +
        'Напишіть детальніше що хочете бачити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію...');
    runBackgroundTask(() => generateSoraVideo(ctx, { ...state, prompt: text }), 'sora_generate_text');
    return;
  }

  // ✅ KLING: Обробка промпту
  if (state?.action === 'kling_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Промпт занадто короткий!\n\n' +
        'Напишіть детальніше що хочете бачити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    // Зберігаємо промпт і генеруємо
    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію Kling...');
    runBackgroundTask(() => generateKlingVideo(ctx, { ...state, prompt: text }), 'kling_generate_text');
    return;
  }

  // ✅ KLING 3.0 Multi-shot: опис сцени
  if (state?.action === 'kling_3_generation' && state?.step === 'waiting_scene_prompt' && state?.multiShots) {
    if (!text || text.length < 3) {
      await ctx.reply('Опишіть сцену детальніше (мінімум 3 символи).', keyboard.createBackButton('video_menu'));
      return;
    }
    const sceneIndex = (state.sceneIndex || 0) + 1;
    const sceneCount = state.sceneCount || 2;
    userState.set(userId, {
      ...state,
      pendingScenePrompt: text,
      step: 'select_scene_duration'
    });
    const durationButtons = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(d =>
      Markup.button.callback(`${d}с`, `kling_3_scene_dur_${d}`)
    );
    const nextSceneHint = sceneIndex < sceneCount
      ? `\n\n👉 Після вибору тривалості опишіть <b>сцену ${sceneIndex + 1}</b> текстом.`
      : '';
    await ctx.reply(
      `✅ Сцена ${sceneIndex}: «${text.slice(0, 60)}${text.length > 60 ? '…' : ''}»\n\n` +
      `Тривалість цієї сцени (1–12 сек):${nextSceneHint}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          durationButtons.slice(0, 6),
          durationButtons.slice(6, 12),
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING 3.0: Ім’я елемента для kling_elements
  if (state?.action === 'kling_3_generation' && state?.step === 'waiting_element_name') {
    const name = (text || '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() || 'element';
    const safeName = name.slice(0, 50) || 'element';

    userState.set(userId, {
      ...state,
      step: 'waiting_element_media',
      currentElement: { name: safeName, imageUrls: [], videoUrl: null }
    });

    await ctx.reply(
      `✅ Елемент <b>@${safeName}</b>.\n\n` +
      `Надішліть <b>2–4 фото</b> (можна по одному) або <b>1 відео</b> для цього елемента. У описі відео пишіть, наприклад: «… @${safeName} …».`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ KLING 3.0 (KIE.AI): Обробка промпту (останній крок)
  if (state?.action === 'kling_3_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Промпт занадто короткий!\n\n' +
        'Напишіть детальніше що хочете бачити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію Kling 3.0...');
    runBackgroundTask(() => generateKling3Video(ctx, { ...state, prompt: text }), 'kling_3_generate_text');
    return;
  }

  // ✅ A2E Motion: Обробка prompt та перехід до negative prompt
  if (state?.action === 'a2e_motion_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Опис занадто короткий!\n\n' +
        'Напишіть детальніше що має відбуватися на відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'waiting_negative_prompt'
    });

    await ctx.reply(
      `🔥 <b>Motion без омеженнь</b>\n\n` +
      `✅ Промпт: <b>${text.substring(0, 100)}${text.length > 100 ? '...' : ''}</b>\n\n` +
      `🚫 <b>Крок 4: Negative Prompt</b> (опціонально, до 200 символів)\n\n` +
      `Опишіть що НЕ має бути у відео:\n` +
      `• Небажані ефекти\n` +
      `• Помилки якості\n` +
      `• Небажані об'єкти\n\n` +
      `💡 Приклад: "blurry, low quality, watermark, distorted"\n` +
      `💡 Або натисніть "Пропустити" для використання стандартного\n\n` +
      `📝 <b>Напишіть negative prompt або натисніть "Пропустити":</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⏭️ Пропустити (використати стандартний)', 'a2e_skip_negative')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ A2E Motion: Обробка negative prompt
  if (state?.action === 'a2e_motion_generation' && state?.step === 'waiting_negative_prompt') {
    if (text && text.length > 200) {
      await ctx.reply(
        '⚠️ Negative prompt занадто довгий!\n\n' +
        'Максимум 200 символів. Спробуйте скоротити.',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    const negativePrompt = text && text.trim().length > 0 
      ? text.trim() 
      : 'blurry, low quality, chaotic, deformed, watermark, bad anatomy, shaky camera view point';

    const updatedState = {
      ...state,
      negativePrompt: negativePrompt,
      step: 'ready_to_generate'
    };
    userState.set(userId, updatedState);

    await ctx.reply(
      `🔥 <b>Motion без омеженнь</b>\n\n` +
      `✅ Зображення: <b>Завантажено</b>\n` +
      `⏱️ Тривалість: <b>${updatedState.duration} секунд</b>\n` +
      `📝 Промпт: <b>${updatedState.prompt.substring(0, 100)}${updatedState.prompt.length > 100 ? '...' : ''}</b>\n` +
      `🚫 Negative: <b>${negativePrompt.substring(0, 80)}${negativePrompt.length > 80 ? '...' : ''}</b>\n` +
      `💰 Вартість: <b>${updatedState.a2eCost}⚡</b>\n\n` +
      `🚀 Починаємо генерацію...`,
      { parse_mode: 'HTML' }
    );

    runBackgroundTask(() => generateA2EMotionVideo(ctx, updatedState), 'a2e_motion_generate');
    return;
  }

  // ✅ KLING O1 EDIT: Обробка prompt
  if (state?.action === 'kling_o1_edit_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Опис занадто короткий!\n\n' +
        'Напишіть детальніше що потрібно змінити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    // Перевірка на копіювання повідомлення бота
    if (text.includes('NeuroLabAI') || text.includes('БОТ НЕЙРОМЕРЕЖІ') || text.includes('Крок') || text.includes('💰 Орієнтовна вартість')) {
      await ctx.reply(
        '⚠️ Схоже, ви скопіювали повідомлення бота!\n\n' +
        '📝 Будь ласка, напишіть <b>свій опис редагування</b> текстом.\n\n' +
        '💡 Приклад: "Замінити оранжевий автомобіль на сірий"\n' +
        '💡 Або: "Змінити фон на пляж"\n\n' +
        'Якщо ви додали референсні зображення, посилайтесь на них як <b>@Image1</b>, <b>@Image2</b> тощо.',
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }

    const updatedState = {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    };
    userState.set(userId, updatedState);

    const model = models.video.models.find(m => m.key === 'kling_o1_edit');
    // Duration: якщо feature type - зі стану, інакше 5 (для base ігнорується API)
    const duration = (updatedState.videoReferenceType === 'feature' && updatedState.duration) ? updatedState.duration : 5;
    const hasVideo = !!updatedState.referenceVideo;
    const costPerSec = hasVideo
      ? (updatedState.mode === 'pro' ? model.costPerSecondProWithVideo : model.costPerSecondWithVideo)
      : (updatedState.mode === 'pro' ? model.costPerSecondPro : model.costPerSecond);
    const estimatedCost = duration * costPerSec;

    await ctx.reply(
      `✂️ <b>Kling O1 Edit</b>\n\n` +
      `⚙️ Режим: <b>${updatedState.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
      `📝 Промпт: <b>${text.substring(0, 100)}${text.length > 100 ? '...' : ''}</b>\n` +
      `💰 Орієнтовна вартість: <b>${estimatedCost}⚡</b>\n\n` +
      `🚀 Починаємо генерацію...`,
      { parse_mode: 'HTML' }
    );

    runBackgroundTask(() => generateKlingO1EditVideo(ctx, updatedState), 'kling_o1_edit_generate');
    return;
  }

  // ✅ KLING MOTION: Обробка промпту (опціонально)
  if (state?.action === 'kling_motion_generation' && state?.step === 'ask_prompt') {
    // Зберігаємо промпт і генеруємо
    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію Kling Motion...');
    runBackgroundTask(() => generateKlingMotionVideo(ctx, { ...state, prompt: text }), 'kling_motion_generate_text');
    return;
  }

  // ✅ A2E Motion: якщо є активний флоу але користувач надіслав текст замість фото
  if (state?.action === 'a2e_motion_generation') {
    if (state.step === 'waiting_image') {
      await ctx.reply(
        '🖼️ <b>Очікується ЗОБРАЖЕННЯ, а не текст!</b>\n\n' +
        '👉 Для Motion без омеженнь потрібно надіслати фото, яке буде анімоване.\n\n' +
        '📤 Надішліть зображення (JPG, PNG).',
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }
    // Якщо інший step (крім prompt/negative_prompt які обробляються вище) - показуємо повідомлення
    if (state.step !== 'waiting_prompt' && state.step !== 'waiting_negative_prompt' && state.step !== 'select_duration') {
      await ctx.reply(
        '🔥 <b>Motion без омеженнь</b>\n\n' +
        '⚠️ Спочатку завершіть налаштування!\n\n' +
        'Натисніть кнопку Motion без омеженнь в меню відео.',
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }
  }

  // ✅ KLING O1 EDIT: якщо є активний флоу але немає currentModel
  if (state?.action === 'kling_o1_edit_generation') {
    if (state.step === 'waiting_video') {
      await ctx.reply(
        '🎥 <b>Очікується ВІДЕО для редагування, а не текст!</b>\n\n' +
        '👉 Надішліть відео файл (MP4, MOV, WEBM, M4V, GIF, до 200MB).',
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }
    // Якщо step = waiting_prompt - текст обробиться в KLING O1 EDIT обробнику вище (рядок 6677)
    // Якщо інший step - показуємо повідомлення
    if (state.step !== 'waiting_prompt') {
      await ctx.reply(
        '✂️ <b>Kling O1 Edit</b>\n\n' +
        '⚠️ Спочатку завершіть налаштування!\n\n' +
        'Натисніть кнопку Kling O1 Edit в меню відео.',
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }
    // Якщо step = waiting_prompt - не переходимо далі, обробка вже вище
  }

  if (!currentModel && !state?.action) {
    await ctx.reply('Будь ласка, спочатку виберіть модель з меню 👇', keyboard.createMainMenu());
    return;
  }

  // ✅ KLING MOTION: якщо модель обрана але флоу не розпочато
  if (currentModel === 'kling_motion') {
    const motionState = userState.get(userId);

    // Якщо є активний флоу - перевіряємо на якому кроці
    if (motionState?.action === 'kling_motion_generation') {
      if (motionState.step === 'waiting_image') {
        await ctx.reply(
          '📷 <b>Очікується ФОТО персонажа, а не текст!</b>\n\n' +
          '👉 Надішліть фото персонажа.',
          { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
        );
        return;
      }
      if (motionState.step === 'waiting_video') {
        await ctx.reply(
          '🎥 <b>Очікується ВІДЕО з рухами, а не текст!</b>\n\n' +
          '👉 Надішліть відео файл з рухами.',
          { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
        );
        return;
      }
      // Якщо step = ask_prompt - текст обробиться в KLING MOTION обробнику вище
    } else {
      // Флоу не розпочато - направляємо в меню
      await ctx.reply(
        '🔥 <b>Kling Motion Control</b>\n\n' +
        '⚠️ Спочатку налаштуйте параметри!\n\n' +
        'Натисніть кнопку Kling Motion в меню відео.',
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }
  }

  // ✅ VEO: якщо модель veo але немає стану - показуємо що треба обрати aspect ratio
  if (currentModel === 'veo' && !state?.action) {
    await ctx.reply(
      '🌟 <b>Google Veo 3.1</b>\n\n' +
      '⚠️ Спочатку оберіть пропорції відео!\n\n' +
      'Натисніть на кнопку Veo в меню відео.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ RUNWAY TURBO: якщо модель runway_turbo але немає стану
  if (currentModel === 'runway_turbo' && !state?.action) {
    await ctx.reply(
      '🎬 <b>Runway Gen-4 Turbo</b>\n\n' +
      '⚠️ Спочатку натисніть Runway Turbo в меню відео.\n' +
      'Потім: image → промпт.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ SORA 2: якщо модель sora_2 але немає стану
  if (currentModel === 'sora_2' && !state?.action) {
    await ctx.reply(
      '🌌 <b>OpenAI Sora 2</b>\n\n' +
      '⚠️ Спочатку оберіть тривалість та пропорції відео.\n\n' +
      'Натисніть на кнопку Sora 2 в меню відео.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ НОВИЙ ФЛОУ ДЛЯ ГРАФІЧНИХ МОДЕЛЕЙ
  const imgState = imageGenState.get(userId);
  if (imgState && IMAGE_MODELS.includes(currentModel)) {
    if ((currentModel === 'clarity' || currentModel === 'recraft_upscale') && (!imgState.photos || imgState.photos.length === 0)) {
      imageGenState.set(userId, { ...imgState, step: 'waiting_photos' });
      await ctx.reply(
        '🔮 <b>Upscaler</b> потребує зображення.\n\n' +
        '📷 Надішліть фото для покращення якості.',
        { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
      );
      return;
    }

    if (imgState.step === 'waiting_photos') {
      imgState.prompt = text;
      const references = normalizeReferenceOrder(imgState.photos || []);
      const referenceList = Array.isArray(references) ? references : (references ? [references] : []);
      const hasReferences = referenceList.length > 0;

      if (currentModel === 'stable_diffusion' && hasReferences) {
        imageGenState.delete(userId);
        await ctx.reply(
          'ℹ️ Для Stable Diffusion 3.5 з референсом пропорції беруться з самого фото.\n' +
          'Формат обирати не потрібно — запускаю генерацію.',
          { parse_mode: 'HTML' }
        );
        runBackgroundTask(
          () => handleImageGeneration(ctx, text, currentModel, references.length ? references : null),
          'image_generation_references_prompt'
        );
        return;
      }

      if (TEXT_ASPECT_RATIO_MODELS.has(currentModel)) {
        imageGenState.delete(userId);
        userState.set(userId, {
          model: currentModel,
          step: 'waiting_aspect_ratio',
          imageUrl: hasReferences ? references : null,
          prompt: text
        });

        await promptAspectRatioSelection(ctx, {
          modelKey: currentModel,
          promptText: text,
          hasReferences,
          referencesCount: referenceList.length
        });
        return;
      }

      imageGenState.delete(userId);

      await ctx.reply(
        `✅ <b>Промпт збережено!</b>\n\n` +
        `📝 "${text.length > 100 ? text.substring(0, 100) + '...' : text}"\n\n` +
        `🚀 Починаємо генерацію...`,
        { parse_mode: 'HTML' }
      );

      runBackgroundTask(
        () => handleImageGeneration(ctx, text, currentModel, references.length ? references : null),
        'image_generation_references_prompt'
      );
      return;
    }

    if (imgState.step === 'prompt') {
      imgState.prompt = text;
      const references = normalizeReferenceOrder(imgState.photos || []);
      const referenceList = Array.isArray(references) ? references : (references ? [references] : []);
      const hasReferences = referenceList.length > 0;

      if (currentModel === 'stable_diffusion' && hasReferences) {
        imageGenState.delete(userId);
        await ctx.reply(
          'ℹ️ Для Stable Diffusion 3.5 з референсом пропорції беруться з самого фото.\n' +
          'Формат обирати не потрібно — запускаю генерацію.',
          { parse_mode: 'HTML' }
        );
        runBackgroundTask(
          () => handleImageGeneration(ctx, text, currentModel, references.length ? references : null),
          'image_generation_prompt'
        );
        return;
      }

      if (TEXT_ASPECT_RATIO_MODELS.has(currentModel)) {
        imageGenState.delete(userId);
        userState.set(userId, {
          model: currentModel,
          step: 'waiting_aspect_ratio',
          imageUrl: hasReferences ? references : null,
          prompt: text
        });

        await promptAspectRatioSelection(ctx, {
          modelKey: currentModel,
          promptText: text,
          hasReferences,
          referencesCount: referenceList.length
        });
        return;
      }

      imageGenState.delete(userId);

      await ctx.reply(
        `✅ <b>Промпт збережено!</b>\n\n` +
        `📝 "${text.length > 100 ? text.substring(0, 100) + '...' : text}"\n\n` +
        `🚀 Починаємо генерацію...`,
        { parse_mode: 'HTML' }
      );

      runBackgroundTask(
        () => handleImageGeneration(ctx, text, currentModel, references.length ? references : null),
        'image_generation_prompt'
      );
      return;
    }
  }

  if (currentModel === 'clarity' || currentModel === 'recraft_upscale') {
    await ctx.reply('🔮 Upscaler чекає на зображення.\n\nНадішліть фото для покращення якості.', keyboard.createGPTActionsMenu(models.design.models));
    return;
  }

  // ✅ A2E Motion: якщо currentModel встановлено але це image-to-video модель
  if (currentModel === 'a2e_motion') {
    await ctx.reply(
      '🖼️ <b>Motion без омеженнь потребує ЗОБРАЖЕННЯ!</b>\n\n' +
      '👉 Для цієї моделі потрібно надіслати фото, яке буде анімоване.\n\n' +
      '📤 Надішліть зображення (JPG, PNG).',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ MIDJOURNEY: обробка налаштувань (stylization, weirdness, variety)
  if (state?.action === 'midjourney_generation') {
    // Stylization input
    if (state.step === 'awaiting_stylization') {
      const value = parseInt(text);
      if (isNaN(value) || value < 0 || value > 1000) {
        await ctx.reply('❌ Некоректне значення. Надішліть число від 0 до 1000.');
        return;
      }

      console.log(`🔍 [STYLIZATION TEXT] Before update - userId=${userId}, state exists: ${!!userState.get(userId)}, current stylization: ${state.stylization}`);

      // Логування зміни дефолтного значення
      const defaultValue = 100;
      if (value !== defaultValue) {
        console.log(`🎨 Midjourney Stylization змінено з дефолту: userId=${userId}, default=${defaultValue}, new=${value}, diff=${value - defaultValue}`);
      }

      state.stylization = value;
      state.step = 'select_settings';
      state._timestamp = Date.now();

      console.log(`🔍 [STYLIZATION TEXT] After update, before save - stylization=${state.stylization}, step=${state.step}, timestamp=${state._timestamp}`);

      userState.set(userId, state);

      console.log(`🔍 [STYLIZATION TEXT] After save - state in Map: ${!!userState.get(userId)}, stylization in Map: ${userState.get(userId)?.stylization}`);

      const speed = state.speed || 'fast';
      const aspectRatio = state.aspectRatio || '1:1';

      console.log(`🔍 [STYLIZATION TEXT] About to send reply with buttons - speed=${speed}, aspectRatio=${aspectRatio}`);

      await ctx.reply(
        `✅ Stylization встановлено: ${value}\n\n` +
        `⚙️ Оберіть інший параметр або продовжте:`,
        {
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🎨 Stylization', `mj_set_stylization_${speed}_${aspectRatio}`),
              Markup.button.callback('🌀 Weirdness', `mj_set_weirdness_${speed}_${aspectRatio}`)
            ],
            [Markup.button.callback('🎲 Variety', `mj_set_variety_${speed}_${aspectRatio}`)],
            [Markup.button.callback('✅ Продовжити', `mj_settings_done_${speed}_${aspectRatio}`)],
            [Markup.button.callback('← Назад', 'midjourney')]
          ])
        }
      );

      console.log(`🔍 [STYLIZATION TEXT] After reply sent - state still in Map: ${!!userState.get(userId)}, stylization still in Map: ${userState.get(userId)?.stylization}`);

      return;
    }

    // Weirdness input
    if (state.step === 'awaiting_weirdness') {
      const value = parseInt(text);
      if (isNaN(value) || value < 0 || value > 3000) {
        await ctx.reply('❌ Некоректне значення. Надішліть число від 0 до 3000.');
        return;
      }

      console.log(`🔍 [WEIRDNESS TEXT] Before update - userId=${userId}, state exists: ${!!userState.get(userId)}, current weirdness: ${state.weirdness}`);

      // Логування зміни дефолтного значення
      const defaultValue = 0;
      if (value !== defaultValue) {
        console.log(`🌀 Midjourney Weirdness змінено з дефолту: userId=${userId}, default=${defaultValue}, new=${value}, diff=+${value}`);
      }

      state.weirdness = value;
      state.step = 'select_settings';
      state._timestamp = Date.now();

      console.log(`🔍 [WEIRDNESS TEXT] After update, before save - weirdness=${state.weirdness}, step=${state.step}, timestamp=${state._timestamp}`);

      userState.set(userId, state);

      console.log(`🔍 [WEIRDNESS TEXT] After save - state in Map: ${!!userState.get(userId)}, weirdness in Map: ${userState.get(userId)?.weirdness}`);

      const speed = state.speed || 'fast';
      const aspectRatio = state.aspectRatio || '1:1';

      console.log(`🔍 [WEIRDNESS TEXT] About to send reply with buttons - speed=${speed}, aspectRatio=${aspectRatio}`);

      await ctx.reply(
        `✅ Weirdness встановлено: ${value}\n\n` +
        `⚙️ Оберіть інший параметр або продовжте:`,
        {
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🎨 Stylization', `mj_set_stylization_${speed}_${aspectRatio}`),
              Markup.button.callback('🌀 Weirdness', `mj_set_weirdness_${speed}_${aspectRatio}`)
            ],
            [Markup.button.callback('🎲 Variety', `mj_set_variety_${speed}_${aspectRatio}`)],
            [Markup.button.callback('✅ Продовжити', `mj_settings_done_${speed}_${aspectRatio}`)],
            [Markup.button.callback('← Назад', 'midjourney')]
          ])
        }
      );

      console.log(`🔍 [WEIRDNESS TEXT] After reply sent - state still in Map: ${!!userState.get(userId)}, weirdness still in Map: ${userState.get(userId)?.weirdness}`);

      return;
    }

    // Variety input
    if (state.step === 'awaiting_variety') {
      const value = parseInt(text);
      if (isNaN(value) || value < 0 || value > 100) {
        await ctx.reply('❌ Некоректне значення. Надішліть число від 0 до 100.');
        return;
      }

      console.log(`🔍 [VARIETY TEXT] Before update - userId=${userId}, state exists: ${!!userState.get(userId)}, current variety: ${state.variety}`);

      // Логування зміни дефолтного значення
      const defaultValue = 50;
      if (value !== defaultValue) {
        console.log(`🎲 Midjourney Variety змінено з дефолту: userId=${userId}, default=${defaultValue}, new=${value}, diff=${value - defaultValue}`);
      }

      state.variety = value;
      state.step = 'select_settings';
      state._timestamp = Date.now();

      console.log(`🔍 [VARIETY TEXT] After update, before save - variety=${state.variety}, step=${state.step}, timestamp=${state._timestamp}`);

      userState.set(userId, state);

      console.log(`🔍 [VARIETY TEXT] After save - state in Map: ${!!userState.get(userId)}, variety in Map: ${userState.get(userId)?.variety}`);

      const speed = state.speed || 'fast';
      const aspectRatio = state.aspectRatio || '1:1';

      console.log(`🔍 [VARIETY TEXT] About to send reply with buttons - speed=${speed}, aspectRatio=${aspectRatio}`);

      await ctx.reply(
        `✅ Variety встановлено: ${value}\n\n` +
        `⚙️ Оберіть інший параметр або продовжте:`,
        {
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🎨 Stylization', `mj_set_stylization_${speed}_${aspectRatio}`),
              Markup.button.callback('🌀 Weirdness', `mj_set_weirdness_${speed}_${aspectRatio}`)
            ],
            [Markup.button.callback('🎲 Variety', `mj_set_variety_${speed}_${aspectRatio}`)],
            [Markup.button.callback('✅ Продовжити', `mj_settings_done_${speed}_${aspectRatio}`)],
            [Markup.button.callback('← Назад', 'midjourney')]
          ])
        }
      );

      console.log(`🔍 [VARIETY TEXT] After reply sent - state still in Map: ${!!userState.get(userId)}, variety still in Map: ${userState.get(userId)?.variety}`);

      return;
    }
  }

  // ✅ MIDJOURNEY: обробка промпту
  if (state?.action === 'midjourney_generation' && state?.step === 'waiting_prompt') {
    console.log('🖼️ Midjourney: Processing prompt for user', userId);
    runBackgroundTask(() => handleMidjourneyGeneration(ctx, text), 'midjourney_generation');
    return;
  }

  const handlers = {
    claude_vision: () => handleClaudeText(ctx, text),
    claude_text: () => handleClaudeText(ctx, text),
    claude: () => handleClaudeText(ctx, text),
    claude_voice: () => handleClaudeText(ctx, text),
    sora_watermark_remover: () => handleSoraWatermarkRemover(ctx, text),
    midjourney: () => handleMidjourneyGeneration(ctx, text),
    flux: () => handleImageGeneration(ctx, text, 'flux'),
    stable_diffusion: () => handleImageGeneration(ctx, text, 'stable_diffusion'),
    nano_banana: () => handleImageGeneration(ctx, text, 'nano_banana'),
    nano_banana_2k: () => handleImageGeneration(ctx, text, 'nano_banana_2k'),
    nano_banana_4k: () => handleImageGeneration(ctx, text, 'nano_banana_4k'),
    seedream_4k: () => handleImageGeneration(ctx, text, 'seedream_4k'),
    ideogram: () => handleImageGeneration(ctx, text, 'ideogram'),
    kling: () => handleVideoGeneration(ctx, text, 'kling'),
    kling_v2_6: () => handleVideoGeneration(ctx, text, 'kling_v2_6'),
    // kling_3 використовує окремий флоу через state machine (kling_3_generation)
    runway_gen4: () => handleVideoGeneration(ctx, text, 'runway_gen4'),
    suno: () => handleSunoGeneration(ctx, text)
  };
  
  if (handlers[currentModel]) {
    console.log(`🔥 Text handler: calling ${currentModel} handler for user ${userId}`);
    runBackgroundTask(handlers[currentModel], `text_handler_${currentModel}`);
  } else {
    console.log(`⚠️ Text handler: no handler for model "${currentModel}" for user ${userId}`);
    await ctx.reply(`Модель "${currentModel}" ще не підтримується.\nВиберіть іншу модель.`, keyboard.createMainMenu());
  }
});

bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);

  if (currentModel !== 'claude_voice') {
    await ctx.reply('Спочатку активуйте голосовий режим через "💡 Базові помічники" → 🎙️ Говоріть');
    return;
  }

  const statusMsg = await ctx.reply('🎙️ Розпізнаю голос...');

  try {
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const transcription = await groqWhisper.transcribeVoice(fileLink.href);

    if (!transcription.success) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка розпізнавання: ${transcription.error}`);
      return;
    }

    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `📝 Розпізнано: "${transcription.text}"\n\n🤔 Думаю...`);
    runBackgroundTask(() => handleClaudeText(ctx, transcription.text), 'claude_voice');

  } catch (error) {
    console.error('Voice processing error:', error);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Помилка обробки голосу. Спробуйте ще раз.');
  }
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);

  // Debug log
  console.log(`📸 Photo received from user ${userId}:`, {
    currentModel,
    stateAction: state?.action,
    stateStep: state?.step,
    hasState: !!state
  });

  // ✅ A2E Motion: Обробка фото для анімації (перевіряємо першим)
  if (state?.action === 'a2e_motion_generation' && state?.step === 'waiting_image') {
    console.log('🔥 A2E Motion: Processing photo for user', userId);
    const imageUrl = await getImageUrl(ctx);
    if (!imageUrl) {
      await ctx.reply('❌ Помилка: не вдалося завантажити зображення. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      return;
    }

    console.log('🔥 A2E Motion: Image URL received, setting state to select_duration');
    userState.set(userId, {
      ...state,
      imageUrl: imageUrl,
      step: 'select_duration'
    });

    const model = models.video.models.find(m => m.key === 'a2e_motion');
    const durations = model.durations || [5, 10, 15, 20];
    const durationButtons = durations.map(d => 
      Markup.button.callback(`${d} сек (${d * model.costPerSecond}⚡)`, `a2e_duration_${d}`)
    );

    await ctx.reply(
      `🔥 <b>Motion без омеженнь</b>\n\n` +
      `✅ Зображення завантажено!\n\n` +
      `⏱️ <b>Крок 2: Оберіть тривалість відео</b>\n\n` +
      `💰 Вартість залежить від тривалості:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          durationButtons,
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ VEO: Обробка стартового зображення (image-to-video)
  if (state?.action === 'veo_generation' && state?.step === 'waiting_start_image') {
    console.log(`✅ Processing VEO start image for user ${userId}`);
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      startImage: imageUrl,
      step: 'ask_last_frame'
    });

    await ctx.reply(
      `✅ <b>Стартове зображення завантажено!</b>\n\n` +
      `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
      `Зображення для кінця відео - AI створить плавний перехід.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📷 Завантажу останній кадр', 'veo_add_last_frame')],
          [Markup.button.callback('⏭️ Без останнього кадру → далі', 'veo_skip_last_frame')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ VEO: Обробка last_frame
  if (state?.action === 'veo_generation' && state?.step === 'waiting_last_frame') {
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      lastFrame: imageUrl,
      step: 'waiting_prompt'
    });

    await ctx.reply(
      `✅ <b>Останній кадр отримано!</b>\n\n` +
      `✍️ <b>Крок 6: Введіть промпт</b>\n\n` +
      `Опишіть детально що хочете бачити у відео.`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ SORA 2: Обробка стартового зображення (input_reference)
  if (state?.action === 'sora_generation' && state?.step === 'waiting_reference') {
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      inputReference: imageUrl,
      step: 'waiting_prompt'
    });

    await ctx.reply(
      `✅ <b>Стартове зображення отримано!</b>\n\n` +
      `✍️ <b>Крок 4: Введіть промпт</b>\n\n` +
      `Опишіть детально що хочете бачити у відео.`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ KLING 3.0: Обробка стартового зображення
  if (state?.action === 'kling_3_generation' && state?.step === 'waiting_start_image') {
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      startImage: imageUrl,
      elements: state.elements || [],
      step: 'ask_elements'
    });

    await ctx.reply(
      `✅ <b>Стартове зображення завантажено!</b>\n\n` +
      `🔗 <b>Елементи (не обов’язково)</b>\n\n` +
      `Можна додати елементи — фото/відео, на які посилатиметесь у описі через @ім’я (наприклад @dog). Пропустіть, якщо не потрібно.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Додати елемент', 'kling_3_add_element')],
          [Markup.button.callback('⏭️ Пропустити → до опису', 'kling_3_skip_elements')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING 3.0: Збір медіа для елемента (2–4 фото або 1 відео)
  if (state?.action === 'kling_3_generation' && state?.step === 'waiting_element_media' && state?.currentElement) {
    const videoUrl = await getVideoUrl(ctx);
    if (videoUrl) {
      const el = { name: state.currentElement.name, description: state.currentElement.name || state.currentElement.name, videoUrl };
      const elements = [...(state.elements || []), el];
      userState.set(userId, {
        ...state,
        elements,
        currentElement: null,
        step: 'ask_elements'
      });
      await ctx.reply(
        `✅ Елемент <b>@${state.currentElement.name}</b> додано (відео).\n\nДодати ще один елемент чи перейти до опису відео?`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Ще елемент', 'kling_3_add_element')],
            [Markup.button.callback('✅ Готово → опис відео', 'kling_3_skip_elements')],
            [Markup.button.callback('← Назад', 'video_menu')]
          ])
        }
      );
      return;
    }
    const imageUrl = await getImageUrl(ctx);
    if (imageUrl) {
      const cur = state.currentElement;
      const imageUrls = [...(cur.imageUrls || []), imageUrl];
      if (imageUrls.length < 2) {
        userState.set(userId, { ...state, currentElement: { ...cur, imageUrls }, step: 'waiting_element_media' });
        await ctx.reply(
          `📷 Є 1 фото. Надішліть ще мінімум 1 фото (разом 2–4) для елемента @${cur.name}, або 1 відео.`,
          { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
        );
        return;
      }
      const finalUrls = imageUrls.slice(0, 4);
      const el = { name: cur.name, description: cur.name, imageUrls: finalUrls };
      const elements = [...(state.elements || []), el];
      userState.set(userId, { ...state, elements, currentElement: null, step: 'ask_elements' });
      await ctx.reply(
        `✅ Елемент <b>@${cur.name}</b> додано (${finalUrls.length} фото).\n\nДодати ще один елемент чи перейти до опису відео?`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Ще елемент', 'kling_3_add_element')],
            [Markup.button.callback('✅ Готово → опис відео', 'kling_3_skip_elements')],
            [Markup.button.callback('← Назад', 'video_menu')]
          ])
        }
      );
      return;
    }
  }


  // ✅ RUNWAY TURBO: Обробка initial image
  if (state?.action === 'runway_turbo_generation' && state?.step === 'waiting_image') {
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      startImage: imageUrl,
      step: 'select_duration'
    });

    const model = models.video.models.find(m => m.key === 'runway_turbo');
    const durations = model?.durations || [5];
    const costPerSec = model?.costPerSecond || (model?.cost || 22) / 5;
    const durationButtons = durations.map(d => Markup.button.callback(`${d} сек (${(d * costPerSec).toFixed(1)}⚡)`, `runway_turbo_duration_${d}`));

    await ctx.reply(
      `✅ <b>Початкове зображення отримано!</b>\n\n` +
      `⏱️ <b>Крок 2: Оберіть тривалість</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          durationButtons,
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING: Обробка стартового зображення
  if (state?.action === 'kling_generation' && state?.step === 'waiting_start_image') {
    console.log(`✅ Processing Kling start image for user ${userId}`);
    const imageUrl = await getImageUrl(ctx);
    const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
    const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');
    const supportsEndImage = model?.supportsEndImage !== false;

    if (!supportsEndImage) {
      userState.set(userId, {
        ...state,
        startImage: imageUrl,
        endImage: null,
        step: 'waiting_prompt'
      });

      await ctx.reply(
        `✅ <b>Стартове зображення завантажено!</b>\n\n` +
        `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
        `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
        `📐 Пропорції: <b>${state.aspectRatio}</b>\n` +
        `🖼️ Початкове зображення: <b>Так</b>\n` +
        `💰 Вартість: <b>${state.klingCost}⚡</b>\n\n` +
        `📝 <b>Напишіть промпт</b>\n\n` +
        `Опишіть рух/анімацію для відео.\n\n` +
        `✍️ <b>Надішліть текстовий промпт:</b>`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }

    userState.set(userId, {
      ...state,
      startImage: imageUrl,
      step: 'ask_end_image'
    });

    await ctx.reply(
      `✅ <b>Стартове зображення завантажено!</b>\n\n` +
      `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
      `Зображення для кінця відео - AI створить плавний перехід.\n\n` +
      `<b>🎯 Приклад:</b>\n` +
      `• Початок: людина стоїть\n` +
      `• Кінець: людина сидить\n` +
      `• Результат: анімація присідання`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📷 Завантажу end_image', 'kling_add_end_image')],
          [Markup.button.callback('⏭️ Перейти до промпту', 'kling_skip_end_image')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING: Обробка end_image
  if (state?.action === 'kling_generation' && state?.step === 'waiting_end_image') {
    console.log(`✅ Processing Kling end image for user ${userId}`);
    const imageUrl = await getImageUrl(ctx);
    const modelKey = state?.modelKey || userCurrentModel.get(userId) || 'kling';
    const model = models.video.models.find(m => m.key === modelKey) || models.video.models.find(m => m.key === 'kling');
    const audioLine = state?.generateAudio !== undefined
      ? `🔊 Аудіо: <b>${state.generateAudio ? 'Так' : 'Ні'}</b>\n`
      : '';

    userState.set(userId, {
      ...state,
      endImage: imageUrl,
      step: 'waiting_prompt'
    });

    await ctx.reply(
      `✅ <b>Кінцеве зображення завантажено!</b>\n\n` +
      `<b>${model?.name || '🎭 Kling'}</b>\n\n` +
      `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
      `📐 Пропорції: <b>${state.aspectRatio}</b>\n` +
      `🖼️ Початкове зображення: <b>Так</b>\n` +
      `🎬 Кінцеве зображення: <b>Так</b>\n` +
      `${audioLine}` +
      `💰 Вартість: <b>${state.klingCost}⚡</b>\n\n` +
      `📝 <b>Напишіть промпт</b>\n\n` +
      `Опишіть рух/перехід між початковим та кінцевим кадром.\n\n` +
      `✍️ <b>Надішліть текстовий промпт:</b>`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ KLING MOTION: Обробка фото персонажа
  if (state?.action === 'kling_motion_generation' && state?.step === 'waiting_image') {
    console.log(`✅ Processing Kling Motion image for user ${userId}`);
    const imageUrl = await getImageUrl(ctx);

    const maxDuration = state.orientation === 'image' ? 10 : 30;

    userState.set(userId, {
      ...state,
      imageUrl: imageUrl,
      step: 'waiting_video'
    });

    await ctx.reply(
      `✅ <b>Фото персонажа завантажено!</b>\n\n` +
      `🔥 <b>Kling Motion Control</b>\n\n` +
      `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
      `🎭 Орієнтація: <b>${state.orientation === 'image' ? '📷 Image' : '🎥 Video'}</b>\n` +
      `⏱️ Макс: <b>${maxDuration} сек</b>\n` +
      `💰 Вартість: <b>${state.motionCost}⚡</b>\n\n` +
      `🎥 <b>Крок 5: Надішліть ВІДЕО з рухами</b>\n\n` +
      `Це відео з референсними рухами які AI перенесе на персонажа.\n\n` +
      `⏱️ Тривалість відео: до ${maxDuration} секунд\n` +
      `📁 Формат: MP4, MOV\n\n` +
      `📤 <b>Надішліть відео файл:</b>`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }


  if (state?.creative && state?.step === 'waiting_photo') {
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  // ✅ НОВИЙ ФЛОУ: Обробка референс-фото
  const imgState = imageGenState.get(userId);
  if (imgState && imgState.step === 'waiting_photos') {
    const modelKey = imgState.model;
    const model = models.design.models.find(m => m.key === modelKey);
    const maxPhotos = model?.maxImages || 1;
    const mediaGroupId = ctx.message.media_group_id;

    // Якщо це альбом - збираємо всі фото через mediaGroups Map
    if (mediaGroupId) {
      const albumKey = `ref_${mediaGroupId}`;

      if (!mediaGroups.has(albumKey)) {
        mediaGroups.set(albumKey, {
          photos: [],
          model: imgState.model,
          userId,
          timeout: null
        });
      }

      const group = mediaGroups.get(albumKey);
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.telegram.getFile(photo.file_id);
      const photoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
      group.photos.push({ id: ctx.message.message_id, url: photoUrl });

      // Скидаємо таймер
      if (group.timeout) clearTimeout(group.timeout);

      // Чекаємо 500мс на інші фото з альбому
      group.timeout = setTimeout(async () => {
        const finalGroup = mediaGroups.get(albumKey);
        if (!finalGroup) return;

        mediaGroups.delete(albumKey);
        const sortedAlbumPhotos = finalGroup.photos
          .slice()
          .sort((a, b) => a.id - b.id);

        const current = imageGenState.get(userId) || { model: finalGroup.model, step: 'waiting_photos', photos: [] };
        const merged = (current.photos || []).concat(sortedAlbumPhotos);
        const limited = merged.slice(0, maxPhotos);

        imageGenState.set(userId, {
          ...current,
          photos: limited,
          step: 'prompt'
        });

        console.log(`📸 Album for new flow: ${sortedAlbumPhotos.length} photos`);
        if (finalGroup.model === 'recraft_upscale') {
          imageGenState.delete(userId);
          await ctx.reply('🚀 Починаємо upscale...', { parse_mode: 'HTML' });
          runBackgroundTask(
            () => handleImageGeneration(ctx, 'upscale image', finalGroup.model, limited),
            'image_generation_upscale_album'
          );
          return;
        }

        await ctx.reply(
          `✅ <b>Референси отримано</b> (${limited.length}/${maxPhotos})\n\n` +
          `✍️ <b>Крок 2: Введіть промпт</b>`,
          { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
        );
      }, 500);

      return;
    }

    // Одне фото - зберігаємо референс
    const imageUrl = await getImageUrl(ctx);
    if (!imgState.photos) imgState.photos = [];

    if (imgState.photos.length >= maxPhotos) {
      await ctx.reply(
        `⚠️ Досягнуто максимум ${maxPhotos} референсів.\n\n` +
        `✍️ Натисніть "Далі до промпту" для продовження.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⏭️ Далі до промпту', `img_gen_start_${modelKey}`)],
            [Markup.button.callback('← Назад', 'design_menu')]
          ])
        }
      );
      return;
    }

    imgState.photos.push({ id: ctx.message.message_id, url: imageUrl });
    imageGenState.set(userId, imgState);

    const count = imgState.photos.length;
    const reachedLimit = count >= maxPhotos;

    if (modelKey === 'recraft_upscale') {
      const references = normalizeReferenceOrder(imgState.photos || []);
      imageGenState.delete(userId);
      await ctx.reply('🚀 Починаємо upscale...', { parse_mode: 'HTML' });
      runBackgroundTask(
        () => handleImageGeneration(ctx, 'upscale image', modelKey, references.length ? references : null),
        'image_generation_upscale_photo'
      );
      return;
    }

    if (reachedLimit) {
      imageGenState.set(userId, { ...imgState, step: 'prompt' });
      await ctx.reply(
        `✅ Референсів: ${count}/${maxPhotos}\n\n` +
        `✍️ <b>Крок 2: Введіть промпт</b>`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
      );
    } else {
      await ctx.reply(
        `✅ Референс ${count}/${maxPhotos} завантажено!\n\n` +
        `📤 Надішліть ще фото або натисніть "Далі до промпту".`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⏭️ Далі до промпту', `img_gen_start_${modelKey}`)],
            [Markup.button.callback('← Назад', 'design_menu')]
          ])
        }
      );
    }
    return;
  }

  // ✅ Перевірити чи користувач вибрав модель
  if (!currentModel) {
    await ctx.reply(
      '❌ Спочатку виберіть модель для обробки фото.\n\n' +
      '🎨 Оберіть один з розділів:',
      keyboard.createInlineMenu(getDesignModelsWithEffectiveCost(ctx.from.id), 1)
    );
    return;
  }

  // ✅ Спеціальний випадок: користувач обрав "🖼️ Завантажте зображення для аналізу" з гідлінгу Claude
  if (currentModel === 'image') {
    console.log(`🖼️ Image analysis mode selected, redirecting to Claude vision`);
    runBackgroundTask(() => handleClaudeVision(ctx), 'claude_vision_image_mode');
    return;
  }

  // ✅ SORA 2: якщо модель обрана але флоу не розпочато
  if (currentModel === 'sora_2' && !state?.action) {
    await ctx.reply(
      '🌌 <b>OpenAI Sora 2</b>\n\n' +
      '⚠️ Спочатку оберіть тривалість та пропорції відео.\n\n' +
      'Натисніть на кнопку Sora 2 в меню відео.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ Спеціальний випадок: користувач обрав "💌 День Закоханих" креатив
  if (currentModel === 'love_is') {
    console.log(`💌 Love is... creative selected, handling creative photo`);
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  // ❤️ Льодяник креатив
  if (currentModel === 'hearts') {
    console.log(`❤️ Hearts creative selected, handling creative photo`);
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  // 👑 Bridgerton креатив
  if (currentModel === 'bridgerton') {
    console.log(`👑 Bridgerton creative selected, handling creative photo`);
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  // ✨ Порцелянова фігурка креатив
  if (currentModel === 'porcelain_figure') {
    console.log(`✨ Porcelain figure creative selected, handling creative photo`);
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  // 🐱 Котики креатив
  if (currentModel === 'kittens') {
    console.log(`🐱 Kittens creative selected, handling creative photo`);
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  // 🌊 Підводний макро-портрет креатив
  if (currentModel === 'underwater_macro') {
    console.log(`🌊 Underwater macro creative selected, handling creative photo`);
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    if (!mediaGroups.has(mediaGroupId)) {
      mediaGroups.set(mediaGroupId, { photos: [], caption: ctx.message.caption || '', userId, currentModel, timeout: null });
    }

    const group = mediaGroups.get(mediaGroupId);
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const photoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    group.photos.push(photoUrl);

    if (ctx.message.caption) group.caption = ctx.message.caption;
    if (group.timeout) clearTimeout(group.timeout);

    group.timeout = setTimeout(async () => {
      const finalGroup = mediaGroups.get(mediaGroupId);
      mediaGroups.delete(mediaGroupId);
      console.log(`📸 Album received: ${finalGroup.photos.length} photos`);
      runBackgroundTask(() => handleMediaGroup(ctx, finalGroup), 'media_group');
    }, 500);

    return;
  }

  // Обробка одного фото
  const videoModels = ['kling', 'kling_v2_6', 'runway_gen4'];
  const imageModels = ['nano_banana', 'nano_banana_2k', 'nano_banana_4k', 'stable_diffusion', 'seedream_4k', 'ideogram', 'recraft_upscale'];

  // Отримуємо caption як промпт
  let prompt = ctx.message.caption || '';


  // Якщо промпт пустий - використовуємо дефолтний
  if (!prompt) {
    prompt = 'transform this image, masterpiece quality, highly detailed';
  }

  if (currentModel === 'claude_vision') {
    runBackgroundTask(() => handleClaudeVision(ctx), 'claude_vision_photo');
  } else if (currentModel === 'clarity') {
    runBackgroundTask(() => handleClarityUpscaler(ctx), 'clarity_upscaler');
  } else if (currentModel === 'kling_motion' || currentModel === 'kling_motion_minimal') {
    // Kling Motion: зберігаємо фото, чекаємо на відео
    const imageUrl = await getImageUrl(ctx);
    userState.set(userId, { model: currentModel, step: 'waiting_video', imageUrl });
    const videoLengthMsg = currentModel === 'kling_motion_minimal' ? '(<= 10 сек⏱️)' : '(до 5 сек⏱️)';
    await ctx.reply(
      '✅ Фото отримано!\n\n' +
      `🎥 Тепер надішліть ВІДЕО з рухами ${videoLengthMsg}, \n\n які хочете перенести на персонажа з фото.\n\n` +
      '💡 Наприклад: відео танцю, жестів, або будь-яких рухів.\n\n' +
      '⏱️ Після відео почнеться генерація',
      keyboard.createBackButton('video_menu')
    );
  } else if (imageModels.includes(currentModel)) {
    // ✅ ЯК ЩО ЦЕ МОДЕЛЬ З ASPECT RATIO - ПОКАЗАТИ МЕНЮ ВИБОРУ
    if (MODELS_WITH_ASPECT_RATIO.includes(currentModel)) {
      const imageUrl = await getImageUrl(ctx);

      // Зберігаємо дані для подальшої генерації
      const stateData = {
        model: currentModel,
        step: 'waiting_aspect_ratio',
        imageUrl: imageUrl,
        prompt: prompt
      };

      userState.set(userId, stateData);
      console.log(`💾 State saved for user ${userId}:`, stateData);
      console.log(`💾 Checking state immediately:`, userState.get(userId));

      await promptAspectRatioSelection(ctx, {
        modelKey: currentModel,
        promptText: prompt,
        hasReferences: true,
        referencesCount: imageUrl ? 1 : 0
      });
    } else {
      // Для інших моделей просто генерувати
      runBackgroundTask(() => handleImageGeneration(ctx, prompt, currentModel), 'image_generation_photo');
    }
  } else if (videoModels.includes(currentModel)) {
    runBackgroundTask(() => handleVideoGeneration(ctx, prompt, currentModel), 'video_generation_photo');
  } else if (currentModel === 'runway_turbo') {
    await ctx.reply(
      '🎬 <b>Runway Gen-4 Turbo</b>\n\n' +
      'Спочатку введіть промпт, потім додайте image.\n' +
      'Натисніть Runway Turbo в меню відео.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
  } else {
    await ctx.reply('Для аналізу зображень виберіть режим "💡 Claude" → "🖼️ Завантажте зображення"', keyboard.createGPTActionsMenu(models.gpt.actions));
  }
});

// ==================== VIDEO HANDLER ====================

bot.on('video', async (ctx) => {
  const userId = ctx.from.id;
  const state = userState.get(userId);

  console.log('🎥 Video received from user:', userId, 'state:', {
    action: state?.action,
    step: state?.step,
    hasImageUrl: !!state?.imageUrl
  });

  // ✅ KLING 3.0: Відео для елемента (element_input_video_urls)
  if (state?.action === 'kling_3_generation' && state?.step === 'waiting_element_media' && state?.currentElement) {
    const videoUrl = await getVideoUrl(ctx);
    if (videoUrl) {
      const el = {
        name: state.currentElement.name,
        description: state.currentElement.name,
        videoUrl
      };
      const elements = [...(state.elements || []), el];
      userState.set(userId, {
        ...state,
        elements,
        currentElement: null,
        step: 'ask_elements'
      });
      await ctx.reply(
        `✅ Елемент <b>@${state.currentElement.name}</b> додано (відео).\n\nДодати ще один елемент чи перейти до опису відео?`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Ще елемент', 'kling_3_add_element')],
            [Markup.button.callback('✅ Готово → опис відео', 'kling_3_skip_elements')],
            [Markup.button.callback('← Назад', 'video_menu')]
          ])
        }
      );
      return;
    }
  }

  // ✅ KLING O1 EDIT: Обробка референсного відео
  if (state?.action === 'kling_o1_edit_generation' && state?.step === 'waiting_video') {
    const videoFile = ctx.message.video;
    if (!videoFile) {
      await ctx.reply('❌ Помилка: не вдалося отримати відео. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      return;
    }

    // Перевірка розміру (200MB max)
    const fileSizeMB = (videoFile.file_size || 0) / (1024 * 1024);
    if (fileSizeMB > 200) {
      await ctx.reply(
        `❌ Відео занадто велике!\n\n` +
        `Максимальний розмір: 200MB\n` +
        `Ваш файл: ${fileSizeMB.toFixed(2)}MB\n\n` +
        `Спробуйте стиснути відео або використати коротший кліп.`,
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    // Перевірка роздільності (мінімум 720px по обох вимірах)
    const videoWidth = videoFile.width || 0;
    const videoHeight = videoFile.height || 0;
    if (videoWidth < 720 || videoHeight < 720) {
      await ctx.reply(
        `❌ Роздільність відео занадто низька!\n\n` +
        `Мінімальна роздільність: 720x720 пікселів\n` +
        `Ваше відео: ${videoWidth}x${videoHeight}\n\n` +
        `⚠️ Обидва виміри (ширина та висота) повинні бути не менше 720px.\n\n` +
        `Спробуйте використати відео з вищою роздільністю.`,
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    const videoUrl = await getVideoUrl(ctx);
    if (!videoUrl) {
      await ctx.reply('❌ Помилка: не вдалося завантажити відео. Спробуйте ще раз.', keyboard.createBackButton('video_menu'));
      return;
    }

    userState.set(userId, {
      ...state,
      referenceVideo: videoUrl,
      step: 'select_video_type'
    });

    await ctx.reply(
      `✂️ <b>Kling O1 Edit</b>\n\n` +
      `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
      `🎥 Відео: <b>Завантажено</b>\n\n` +
      `🎬 <b>Крок 3: Як використовувати відео?</b>\n\n` +
      `• <b>Feature</b> — як референс стилю/камери (можна змінювати тривалість)\n` +
      `• <b>Base</b> — редагування відео (тривалість як у оригіналі)`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🎨 Feature', 'kling_o1_video_type_feature'),
            Markup.button.callback('✂️ Base', 'kling_o1_video_type_base')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING MOTION: Обробка референсного відео
  if (state?.action === 'kling_motion_generation' && state?.step === 'waiting_video' && state?.imageUrl) {
    const model = models.video.models.find(m => m.key === 'kling_motion');
    const motionCost = state.motionCost;

    if (!(await userBalance.hasTokens(userId, motionCost))) {
      await showInsufficientTokens(ctx, motionCost);
      userState.delete(userId);
      return;
    }

    const videoFile = ctx.message.video;

    // Перевірка розміру (Telegram getFile обмежений до 20MB)
    const fileSizeMB = (videoFile.file_size || 0) / (1024 * 1024);
    const maxDuration = state.orientation === 'image' ? 10 : 30;

    if (fileSizeMB > 20) {
      await ctx.reply(
        `❌ <b>Відео занадто велике для обробки!</b>\n\n` +
        `📦 Максимальний розмір: <b>20MB</b>\n` +
        `📦 Ваш файл: <b>${fileSizeMB.toFixed(2)}MB</b>\n\n` +
        `⏱️ Макс. тривалість: ${maxDuration} сек\n\n` +
        `💡 <b>Рекомендації:</b>\n` +
        `• Використайте коротше відео (до ${maxDuration} секунд)\n` +
        `• Зменшіть роздільність відео\n` +
        `• Стисніть відео перед завантаженням\n\n` +
        `📤 Надішліть відео ще раз:`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }

    console.log(`🎥 Kling Motion: Getting file URL for video ${fileSizeMB.toFixed(2)}MB`);

    let videoUrl;
    try {
      const fileInfo = await ctx.telegram.getFile(videoFile.file_id);
      videoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
    } catch (error) {
      console.error('❌ Kling Motion: Failed to get video file:', error);
      await ctx.reply(
        '❌ Помилка завантаження відео. Спробуйте:\n\n' +
        '• Використати коротше відео\n' +
        '• Зменшити розмір файлу\n' +
        '• Надіслати ще раз',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    userState.set(userId, {
      ...state,
      videoUrl: videoUrl,
      step: 'ask_prompt'
    });


    await ctx.reply(
      `✅ <b>Відео з рухами завантажено!</b>\n\n` +
      `🔥 <b>Kling Motion Control</b>\n\n` +
      `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
      `🎭 Орієнтація: <b>${state.orientation === 'image' ? '📷 Image' : '🎥 Video'}</b>\n` +
      `📷 Фото: ✅\n` +
      `🎥 Відео: ✅\n` +
      `💰 Вартість: <b>${motionCost}⚡</b>\n\n` +
      `📝 <b>Крок 6: Промпт (опціонально)</b>\n\n` +
      `Опишіть додаткові деталі або натисніть "Генерувати".`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚀 Генерувати без промпту', 'motion_generate_now')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Якщо відео не для Kling Motion - показуємо інструкцію
  await ctx.reply(
    '⚠️ Для використання відео:\n\n' +
    '1. Виберіть модель 🔥 Kling Motion Control\n' +
    '2. Оберіть режим та налаштування\n' +
    '3. Надішліть фото персонажа\n' +
    '4. Надішліть відео з рухами\n\n' +
    'Або оберіть іншу модель для генерації відео 👇',
    keyboard.createBackButton('video_menu')
  );
});

// ==================== UNIFIED HANDLERS ====================

async function handleMediaGroup(ctx, group) {
  const { photos, caption, currentModel, userId } = group;
  const model = models.design.models.find(m => m.key === currentModel);

  // ✅ Перевірити чи модель знайдена
  if (!model) {
    console.error(`❌ Model not found in handleMediaGroup: ${currentModel}`);
    await ctx.reply('❌ Модель не знайдена. Спробуйте ще раз.');
    return;
  }

  // Отримуємо промпт з caption
  let finalPrompt = caption || '';


  if (!finalPrompt) {
    finalPrompt = 'transform these images, masterpiece quality, highly detailed';
  }

  // ✅ Перевірити чи модель підтримує багато зображень
  if (model.maxImages && model.maxImages > 1) {
    // ✅ ЯК ЩО ЦЕ МОДЕЛЬ З ASPECT RATIO - ПОКАЗИТИ МЕНЮ ВИБОРУ
    if (MODELS_WITH_ASPECT_RATIO.includes(currentModel)) {
      // Зберігаємо дані для подальшої генерації
      userState.set(userId, {
        model: currentModel,
        step: 'waiting_aspect_ratio',
        imageUrl: photos, // передаємо масив фото
        prompt: finalPrompt
      });

      await promptAspectRatioSelection(ctx, {
        modelKey: currentModel,
        promptText: finalPrompt,
        hasReferences: true,
        referencesCount: photos.length
      });
    } else {
      runBackgroundTask(
        () => handleImageGeneration(ctx, finalPrompt, currentModel, photos),
        'image_generation_media_group'
      );
    }
  } else {
    await ctx.reply(
      `📸 Отримано ${photos.length} фото.\n\n` +
      `⚠️ ${model?.name || 'Ця модель'} підтримує тільки 1 зображення.\n` +
      `Обробляю перше фото...`
    );
    runBackgroundTask(
      () => handleImageGeneration(ctx, finalPrompt, currentModel, photos[0]),
      'image_generation_media_group_single'
    );
  }
}

async function getImageUrl(ctx) {
  if (!ctx.message?.photo) return null;
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = await ctx.telegram.getFile(photo.file_id);
  return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
}

/** Повертає URL файлу відео з повідомлення (для Kling 3.0 element_input_video_urls). */
async function getVideoUrl(ctx) {
  if (!ctx.message?.video) return null;
  const file = await ctx.telegram.getFile(ctx.message.video.file_id);
  return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
}

/** Збирає всі URL фото з повідомлення (1 фото або альбом у media group). */
async function getImageUrlsFromContext(ctx) {
  if (!ctx.message?.photo) return [];
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = await ctx.telegram.getFile(photo.file_id);
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  return [url];
}

async function validateImageCount(photos, maxCount = 14) {
  if (!photos || !Array.isArray(photos)) return photos;
  if (photos.length <= maxCount) return photos;
  return photos.slice(0, maxCount);
}

function normalizeReferenceOrder(references) {
  if (!Array.isArray(references) || references.length === 0) return references;
  if (typeof references[0] === 'string') return references;
  return references
    .slice()
    .sort((a, b) => (a.id || 0) - (b.id || 0))
    .map((ref) => ref.url);
}

function isAbsoluteHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function extractMediaUrl(media) {
  if (!media) return null;
  if (typeof media === 'string') return media;
  if (Array.isArray(media)) {
    return media.length ? extractMediaUrl(media[0]) : null;
  }
  if (typeof media === 'object') {
    if (typeof media.url === 'string') return media.url;
    if (typeof media.output === 'string') return media.output;
    if (typeof media.video === 'string') return media.video;
    if (typeof media.image === 'string') return media.image;
    if (media.output && typeof media.output.url === 'string') return media.output.url;
    if (media.output && Array.isArray(media.output)) return extractMediaUrl(media.output[0]);
    if (typeof media.href === 'string') return media.href;
    if (typeof media.toString === 'function') {
      const asString = media.toString();
      if (typeof asString === 'string') return asString;
    }
  }
  return null;
}

function normalizeMediaUrl(media) {
  const url = extractMediaUrl(media);
  if (!url) return null;
  const trimmed = typeof url === 'string' ? url.trim() : url;
  if (typeof trimmed === 'string' && trimmed.startsWith('//')) return `https:${trimmed}`;
  return trimmed;
}

async function safeSendPhoto(chatId, url, options) {
  const mediaUrl = normalizeMediaUrl(url);
  if (!isAbsoluteHttpUrl(mediaUrl)) {
    throw new Error('Invalid media URL for photo');
  }
  return bot.telegram.sendPhoto(chatId, { url: mediaUrl }, options);
}

async function safeSendVideo(chatId, url, options) {
  const mediaUrl = normalizeMediaUrl(url);
  if (!isAbsoluteHttpUrl(mediaUrl)) {
    throw new Error('Invalid media URL for video');
  }
  return bot.telegram.sendVideo(chatId, { url: mediaUrl }, options);
}

/**
 * 🎁 Nano Banana FREE — генерація через Google Gemini API (безкоштовно)
 * Окремий хендлер, бо не використовує провайдер-фолбек систему
 */
async function handleNanoBananaFreeGeneration(ctx, prompt, model, imageInput, aspectRatio) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const chatId = ctx.chat.id;

  // Перевірка ліміту
  const user = await User.findById(userId);
  const freeUsed = user?.freeUsage?.nano_banana_free || 0;
  const freeLimit = geminiImage.FREE_GENERATIONS_LIMIT;

  if (freeUsed >= freeLimit) {
    await ctx.reply(
      `🎁 <b>Nano Banana FREE</b>\n\n` +
      `❌ Ви вже використали всі ${freeLimit} безкоштовних генерацій!\n\n` +
      `💡 Спробуйте платні моделі для більших можливостей:\n` +
      `• 🍌 Nano Banana — 4⚡ за генерацію\n` +
      `• 🍌 Nano Banana PRO 2K — 15⚡\n` +
      `• 🍌 Nano Banana PRO 4K — 20⚡`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
    );
    return;
  }

  const isAlbum = Array.isArray(imageInput) && imageInput.length > 1;
  const refCount = Array.isArray(imageInput) ? imageInput.length : (imageInput ? 1 : 0);
  const mode = imageInput ? (isAlbum ? `album (${refCount} refs)` : 'img2img') : 'text2img';
  const remaining = freeLimit - freeUsed - 1;

  const statusMsg = await ctx.reply(
    `🍌🎁 Nano Banana FREE генерація (${mode})...\n\n` +
    `🤖 Модель: Gemini 3 Pro Image\n` +
    `📝 Промпт: "${prompt.substring(0, 150)}${prompt.length > 150 ? '...' : ''}"\n` +
    (refCount > 0 ? `📸 Референсів: ${refCount}\n` : '') +
    `📐 Пропорції: ${aspectRatio}\n\n` +
    `📊 Залишиться безкоштовних: ${remaining} з ${freeLimit}`
  );

  try {
    console.log(`🍌🎁 Nano Banana FREE: userId=${userId}, used=${freeUsed}/${freeLimit}, mode=${mode}, refs=${refCount}, aspect=${aspectRatio}`);

    const result = await geminiImage.generateImage(prompt, imageInput, aspectRatio);

    if (!result.success) {
      console.error(`❌ Nano Banana FREE error: ${result.error}`);
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId, username, action: 'nano_banana_free_generation',
        model: model.name, prompt, refs: refCount, aspectRatio
      });

      await bot.telegram.editMessageText(chatId, statusMsg.message_id, null,
        `❌ Помилка генерації Nano Banana FREE.\n\n${result.error}\n\nСпробуйте інший промпт або модель.`
      );
      return;
    }

    // ✅ Інкрементуємо лічильник безкоштовних генерацій
    await User.findByIdAndUpdate(userId, {
      $inc: { 'freeUsage.nano_banana_free': 1 }
    });

    // Видаляємо статусне повідомлення
    try {
      await bot.telegram.deleteMessage(chatId, statusMsg.message_id);
    } catch (e) {
      console.warn('Could not delete status message:', e.message);
    }

    const caption = `🍌🎁 Nano Banana FREE (${mode})\n\n` +
      `📝 Промпт: ${prompt.substring(0, 800)}${prompt.length > 800 ? '...' : ''}\n\n` +
      `💰 Вартість: БЕЗКОШТОВНО 🎁\n` +
      `📊 Залишилось: ${remaining} з ${freeLimit}`;

    // Перевіряємо розмір — якщо >10MB, Telegram не прийме як фото
    const maxPhotoSize = 10 * 1024 * 1024;
    if (result.imageBuffer.length > maxPhotoSize) {
      const fileSizeMB = (result.imageBuffer.length / (1024 * 1024)).toFixed(2);
      await bot.telegram.sendDocument(chatId,
        { source: result.imageBuffer, filename: 'nano_banana_free.png' },
        {
          caption: caption + `\n\n📊 Розмір: ${fileSizeMB} MB (відправлено як файл)`,
          parse_mode: 'HTML',
          ...keyboard.createBackButton('design_menu')
        }
      );
    } else {
      await bot.telegram.sendPhoto(chatId,
        { source: result.imageBuffer, filename: 'nano_banana_free.png' },
        { caption, parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
      );
    }

    // Логування
    const isTrial = await isTrialUser(userId);
    await monitoringLoggers.logUsageEvent({
      userId,
      modelKey: 'nano_banana_free',
      success: true,
      isTrial,
      isFree: true,
      provider: 'google-gemini',
      metadata: { freeUsed: freeUsed + 1, freeLimit, refCount, aspectRatio, model: geminiImage.GEMINI_MODEL }
    });

    console.log(`✅ Nano Banana FREE: userId=${userId}, used=${freeUsed + 1}/${freeLimit}, model=${geminiImage.GEMINI_MODEL}`);

  } catch (error) {
    console.error('❌ Nano Banana FREE generation failed:', error);
    await adminNotifier.notifyAdmin(bot, error, {
      userId, username, action: 'nano_banana_free_generation',
      model: model.name, prompt
    });

    try {
      await bot.telegram.editMessageText(chatId, statusMsg.message_id, null,
        '❌ Помилка генерації. Спробуйте ще раз або оберіть іншу модель.'
      );
    } catch (e) {
      try {
        await bot.telegram.sendMessage(chatId, '❌ Помилка генерації.', keyboard.createBackButton('design_menu'));
      } catch (sendErr) {
        console.error('Could not notify user:', sendErr.message);
      }
    }
  }
}

async function handleImageGeneration(ctx, prompt, modelKey, imageInput = null, aspectRatio = '1:1') {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.design.models.find(m => m.key === modelKey);

  // ✅ Перевіримо чи модель знайдена
  if (!model) {
    console.error(`❌ Model not found: ${modelKey}`);
    await ctx.reply('❌ Модель не знайдена. Спробуйте ще раз.');
    return;
  }

  imageInput = normalizeReferenceOrder(imageInput);

  // 🎁 NANO BANANA FREE — окремий шлях генерації через Google Gemini API
  if (modelKey === 'nano_banana_free') {
    return handleNanoBananaFreeGeneration(ctx, prompt, model, imageInput, aspectRatio);
  }

  const effectiveImageCost = getEffectiveImageCost(userId, model, modelKey);
  if (!(await userBalance.hasTokens(userId, effectiveImageCost))) {
    await showInsufficientTokens(ctx, effectiveImageCost);
    return;
  }

  if (!imageInput && ctx.message?.photo) {
    imageInput = await getImageUrl(ctx);
  }
  if ((modelKey === 'clarity' || modelKey === 'recraft_upscale') && !imageInput) {
    await ctx.reply(
      '🔮 <b>Upscaler</b> потребує зображення.\n\n' +
      '📷 Надішліть фото для покращення якості.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
    );
    return;
  }

  if (model.maxImages && Array.isArray(imageInput)) {
    const originalCount = imageInput.length;
    imageInput = await validateImageCount(imageInput, model.maxImages);
    
    if (originalCount > model.maxImages) {
      await ctx.reply(
        `⚠️ ${model.name} підтримує до ${model.maxImages} зображень.\n\n` +
        `Ви надіслали ${originalCount} фото.\n` +
        `Обробляю перші ${model.maxImages}...`
      );
    }
  }

  const isAlbum = Array.isArray(imageInput) && imageInput.length > 1;
  const mode = imageInput ? (isAlbum ? `album (${imageInput.length})` : 'img2img') : 'text2img';

  // 🛑 Перевіряємо чи не йде shutdown
  if (gracefulShutdown.isInShutdown()) {
    await ctx.reply('⚠️ Бот оновлюється. Спробуйте через 1-2 хвилини.');
    return;
  }

  const statusMsg = await ctx.reply(`${model.name} генерація (${mode})...\n\nПромпт: "${prompt}"`);

  // 🛑 Реєструємо генерацію для graceful shutdown
  const requestId = gracefulShutdown.generateRequestId();
  gracefulShutdown.registerGeneration(requestId, {
    userId,
    chatId: ctx.chat.id,
    model: model.name,
    modelKey
  });

  const chatId = ctx.chat.id;
  const generationData = {
    userId,
    username,
    chatId,
    prompt,
    modelKey,
    modelName: model.name,
    modelCost: effectiveImageCost,
    modelApiCost: model.apiCost,
    imageInput,
    aspectRatio,
    mode,
    statusMsgId: statusMsg.message_id
  };

  (async () => {
    let finished = false;
    try {
      // 🎯 НОВА СИСТЕМА: Автоматичний fallback між провайдерами
      const userChosenProvider = userProviderChoice.get(userId);
      const hasKieAccess = accessControl.canUseKieAI(userId);
      const kieEnabled = kieAI.isKieAIEnabled;
      const canUseKieAI = hasKieAccess && kieEnabled;

      console.log(`🔍 Provider check for ${generationData.modelKey}:`, {
        userId,
        hasKieAccess,
        kieEnabled,
        canUseKieAI,
        userChoice: userChosenProvider,
        isKieImplemented: kieAI.isKieAIImplemented(generationData.modelKey)
      });

      // Генеруємо через систему з fallback
      const result = await providerFallback.generateWithFallback({
        modelKey: generationData.modelKey,
        userChoice: userChosenProvider,
        canUseKieAI,

        // KIE.AI генератор
        kieGenerator: async () => {
          switch (generationData.modelKey) {
            case 'stable_diffusion':
              return await kieAI.generateWithStableDiffusionKieAI(
                generationData.prompt,
                generationData.imageInput,
                generationData.aspectRatio
              );

            case 'nano_banana':
              return await kieAI.generateWithNanoBananaBaseKieAI(
                generationData.prompt,
                generationData.imageInput,
                generationData.aspectRatio,
                'png'
              );

            case 'nano_banana_2k':
              return await kieAI.generateWithNanoBananaKieAI(
                generationData.prompt,
                generationData.imageInput,
                '2K',
                generationData.aspectRatio,
                0.5
              );

            case 'nano_banana_4k':
              return await kieAI.generateWithNanoBananaKieAI(
                generationData.prompt,
                generationData.imageInput,
                '4K',
                generationData.aspectRatio,
                0.5
              );

            case 'seedream_4k':
              return await kieAI.generateWithSeedreamKieAI(
                generationData.prompt,
                generationData.imageInput,
                '4K',
                generationData.aspectRatio,
                0.5
              );

            case 'z_image':
              return await kieAI.generateWithZImageKieAI(
                generationData.prompt,
                generationData.aspectRatio
              );

            default:
              return { success: false, error: `No KIE generator for ${generationData.modelKey}` };
          }
        },

        // Replicate генератор
        replicateGenerator: async () => {
          switch (generationData.modelKey) {
            case 'flux':
              return await replicate.generateWithFlux(generationData.prompt);

            case 'stable_diffusion':
              return await replicate.generateWithStableDiffusion(
                generationData.prompt,
                generationData.imageInput,
                0.8,
                generationData.aspectRatio
              );

            case 'nano_banana':
              return await replicate.generateWithNanoBananaBase(
                generationData.prompt,
                generationData.imageInput,
                generationData.aspectRatio
              );

            case 'nano_banana_2k':
              return await replicate.generateWithNanoBanana(
                generationData.prompt,
                generationData.imageInput,
                '2K',
                generationData.aspectRatio
              );

            case 'nano_banana_4k':
              return await replicate.generateWithNanoBanana(
                generationData.prompt,
                generationData.imageInput,
                '4K',
                generationData.aspectRatio
              );

            case 'seedream_4k':
              return await replicate.generateWithSeedream(
                generationData.prompt,
                generationData.imageInput,
                '4K',
                generationData.aspectRatio
              );

            case 'ideogram':
              return await replicate.generateWithIdeogram(
                generationData.prompt,
                generationData.imageInput,
                0.5,
                generationData.aspectRatio
              );

            case 'clarity':
              const clarityImage = Array.isArray(generationData.imageInput)
                ? generationData.imageInput[0]
                : generationData.imageInput;
              return await replicate.generateWithClarityUpscaler(clarityImage, generationData.prompt);

            case 'recraft_upscale':
              const upscaleImage = Array.isArray(generationData.imageInput)
                ? generationData.imageInput[0]
                : generationData.imageInput;
              return await replicate.generateWithRecraftCrispUpscale(upscaleImage);

            default:
              return { success: false, error: `No Replicate generator for ${generationData.modelKey}` };
          }
        },

        context: { userId, username, modelKey: generationData.modelKey }
      });

      // Провайдер який реально використали
      const actualProvider = result.provider;
      const providerName = actualProvider === 'kie' ? 'KIE.AI' : 'Replicate';

      console.log(`🎯 Used provider: ${providerName} for ${generationData.modelKey}${result.hadFallback ? ' (FALLBACK)' : ''}`);

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), {
          userId, username, action: `${modelKey}_generation`,
          model: generationData.modelName || 'unknown',
          prompt,
          hasImage: !!imageInput,
          provider: providerName,
          triedProviders: result.triedProviders?.join(', '),
          hadFallback: result.hadFallback
        });

        const errorMsg = result.hadFallback
          ? `❌ Помилка генерації.\n\nСпробували: ${result.triedProviders.join(' → ')}\nВсі провайдери недоступні.\n\nСпробуйте ${modelKey === 'stable_diffusion' ? 'написати промпт англійською або ' : ''}іншу модель.`
          : `❌ Помилка генерації (${providerName}).\n\nСпробуйте ${modelKey === 'stable_diffusion' ? 'написати промпт англійською або ' : ''}іншу модель.`;

        await bot.telegram.editMessageText(chatId, generationData.statusMsgId, null, errorMsg);

        const isTrial = await isTrialUser(userId);
        await monitoringLoggers.logUsageEvent({
          userId,
          modelKey,
          success: false,
          isTrial,
          isFree: isTrial,
          errorCode: result.error?.substring(0, 100),
          provider: actualProvider || 'unknown'
        });

        finished = true;
        gracefulShutdown.completeGeneration(requestId, false);
        return;
      }

      await userBalance.deductTokens(userId, generationData.modelCost, `${generationData.modelName} generation`, {
        modelKey,
        modelName: generationData.modelName,
        apiCost: generationData.modelApiCost,
        prompt: generationData.prompt,
        hasImage: !!generationData.imageInput
      });

      const isTrialImg = await isTrialUser(userId);
      await monitoringLoggers.logUsageEvent({
        userId,
        modelKey,
        success: true,
        isTrial: isTrialImg,
        isFree: isTrialImg,
        provider: actualProvider,
        metadata: {
          hadFallback: result.hadFallback,
          triedProviders: result.triedProviders
        }
      });

      const fileSize = await getFileSize(result.imageUrl);
      const maxPhotoSize = 10 * 1024 * 1024; // 10MB

      if (fileSize > maxPhotoSize) {
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        try {
          await bot.telegram.deleteMessage(chatId, generationData.statusMsgId);
        } catch (e) {
          console.warn('Could not delete status message:', e.message);
        }

        await bot.telegram.sendMessage(
          chatId,
          `✅ <b>${generationData.modelName}</b> (${generationData.mode})\n\n` +
          `📝 <b>Промпт:</b> ${generationData.prompt}\n\n` +
          `📊 <b>Розмір:</b> ${fileSizeMB} MB\n` +
          `⚠️ Файл завеликий для відправки в Telegram\n\n` +
          `🔗 <a href="${result.imageUrl}">📥 Натисніть тут щоб завантажити PNG файл</a>\n\n` +
          `💡 <b>⚠️ ВАЖЛИВО - ЗАВАНТАЖТЕ ОДРАЗУ!</b>\n` +
          `Посилання активне тільки <b>1 ГОДИНУ</b>!\n` +
          `Після цього файл буде видалений.\n\n` +
          `📥 <b>Як завантажити:</b>\n` +
          `1️⃣ Натисніть на посилання вище\n` +
          `2️⃣ Файл завантажиться\n` +
          `3️⃣ Збережіть на телефон/комп'ютер\n\n` +
          `💾 <b>Порада:</b> Завжди зберігайте генерації одразу, щоб не втратити!\n\n` +
          `💰 Витрачено: ${generationData.modelCost}⚡`,
          {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...keyboard.createBackButton('design_menu')
          }
        );
      } else {
        try {
          await bot.telegram.deleteMessage(chatId, generationData.statusMsgId);
        } catch (e) {
          console.warn('Could not delete status message:', e.message);
        }

        await safeSendPhoto(chatId, result.imageUrl, {
          caption: `${generationData.modelName} (${generationData.mode})\n\n📝 Промпт: ${generationData.prompt.substring(0, 800)}${generationData.prompt.length > 800 ? '...' : ''}\n\n💰 Витрачено: ${generationData.modelCost}⚡`,
          parse_mode: 'HTML',
          ...keyboard.createBackButton('design_menu')
        });
      }

      finished = true;
      gracefulShutdown.completeGeneration(requestId, true);

    } catch (error) {
      console.error(`${modelKey} generation failed:`, error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: `${modelKey}_generation`, model: model.name, prompt });

      const isTimeout = error?.message?.includes('Timeout waiting for');
      const userMessage = isTimeout
        ? '⏱ Генерація зайняла надто багато часу (таймаут). Спробуйте ще раз або оберіть іншу модель.'
        : '❌ Помилка генерації. Спробуйте іншу модель.';

      try {
        await bot.telegram.editMessageText(chatId, generationData.statusMsgId, null, userMessage);
      } catch (e) {
        try {
          await bot.telegram.sendMessage(chatId, userMessage, keyboard.createBackButton('design_menu'));
        } catch (sendErr) {
          console.error('Could not notify user of generation error:', sendErr.message);
        }
      }

      if (!finished) {
        gracefulShutdown.completeGeneration(requestId, false);
      }
    }
  })();
}

async function handleVideoGeneration(ctx, prompt, modelKey) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.video.models.find(m => m.key === modelKey);

  // 🛑 Перевіряємо чи не йде shutdown
  if (gracefulShutdown.isInShutdown()) {
    await ctx.reply('⚠️ Бот оновлюється. Спробуйте через 1-2 хвилини.');
    return;
  }

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  const imageUrl = await getImageUrl(ctx);
  
  // ✅ Перевіряємо чи модель вимагає зображення (universal check)
  if (model.requiresImage && !imageUrl) {
    const modelNames = {
      'runway_turbo': 'Runway Gen-4 Turbo',
      'runway_gen4': 'Runway Gen-4 Aleph',
      'kling': 'Kling v2.5 Turbo',
      'kling_motion': 'Kling Motion Control'
    };

    const modelName = modelNames[modelKey] || model.name;

    await ctx.reply(
      `⚠️ <b>${modelName}</b> працює тільки з зображеннями!\n\n` +
      `📝 Інструкція:\n` +
      `1. Надішліть зображення\n` +
      `2. Додайте підпис з описом руху/анімації\n\n` +
      `💡 Приклад підпису:\n` +
      `"Camera slowly pans right, person smiles"\n\n` +
      `Спробуйте ще раз або оберіть іншу модель 👇`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  const statusMsg = await ctx.reply(`🎬 Генерую відео через ${model.name}...\n⏱️ Це може зайняти 2-5 хвилин\n\nПромпт: "${prompt}"`);

  const chatId = ctx.chat.id;

  const requestId = gracefulShutdown.generateRequestId();
  gracefulShutdown.registerGeneration(requestId, {
    userId,
    chatId,
    model: model.name,
    modelKey
  });

  const generationData = {
    userId,
    username,
    chatId,
    prompt,
    modelKey,
    modelName: model.name,
    modelCost: model.cost,
    modelApiCost: model.apiCost,
    imageUrl,
    statusMsgId: statusMsg.message_id
  };

  (async () => {
    let finished = false;
    try {
      const videoFunctions = {
        kling: replicate.generateVideoWithKling,
        kling_v2_6: replicate.generateVideoWithKling26,
        runway_gen4: replicate.generateVideoWithRunway,
        runway_turbo: replicate.generateVideoWithRunwayTurbo
      };

      const videoGenerator = videoFunctions[modelKey];
      if (!videoGenerator) {
        const errorMsg = `No video generator for model: ${modelKey}`;
        console.error(errorMsg);
        await adminNotifier.notifyAdmin(bot, new Error(errorMsg), { userId, username, action: `${modelKey}_video_generation`, model: model.name, prompt, hasImage: !!imageUrl });
        await bot.telegram.editMessageText(chatId, generationData.statusMsgId, null, '❌ Помилка генерації відео. Спробуйте іншу модель.');
        finished = true;
        gracefulShutdown.completeGeneration(requestId, false);
        return;
      }

      const result = await videoGenerator(prompt, imageUrl);

      if (!result.success) {
        await adminNotifier.notifyAdmin(bot, new Error(result.error), { userId, username, action: `${modelKey}_video_generation`, model: model.name, prompt, hasImage: !!imageUrl });
        await bot.telegram.editMessageText(chatId, generationData.statusMsgId, null, `❌ Помилка генерації відео.\n\nСпробуйте іншу модель або повторіть пізніше.`);

        finished = true;
        gracefulShutdown.completeGeneration(requestId, false);
        return;
      }

      await userBalance.deductTokens(userId, model.cost, `${model.name} generation`, { modelKey, modelName: model.name, apiCost: model.apiCost, prompt, hasImage: !!imageUrl });
      await bot.telegram.deleteMessage(chatId, generationData.statusMsgId);

      await bot.telegram.sendMessage(
        chatId,
        `✅ <b>${model.name} готово!</b>\n\n` +
        `❗️<b>ЗБЕРЕЖІТЬ ВІДЕО В ГАЛЕРЕЮ ЩОБ ОТРИМАТИ ПРАВИЛЬНИЙ РОЗМІР</b>\n\n` +
        `📝 Промпт: ${prompt}\n\n` +
        `💾 <b>ЗБЕРЕЖІТЬ на пристрій перед закриттям:</b>\n` +
        `1️⃣ Натисніть на відео (☝️ див. нижче)\n` +
        `2️⃣ Натисніть меню ⋮\n` +
        `3️⃣ Оберіть "Зберегти" або "Завантажити"\n\n` +
        `💰 Витрачено: ${model.cost}⚡`,
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );

      await safeSendVideo(chatId, result.videoUrl, {
        caption: `${model.name}\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
        ...keyboard.createBackButton('video_menu')
      });

      finished = true;
      gracefulShutdown.completeGeneration(requestId, true);

    } catch (error) {
      console.error(`${modelKey} video generation failed:`, error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username, action: `${modelKey}_video_generation`, model: model.name, prompt, hasImage: !!imageUrl });
      await bot.telegram.editMessageText(chatId, generationData.statusMsgId, null, '❌ Помилка генерації відео. Спробуйте іншу модель.');

      if (!finished) {
        gracefulShutdown.completeGeneration(requestId, false);
      }
    }
  })();
}

// ==================== SPECIFIC HANDLERS ====================

async function handleClaudeText(ctx, text) {
  const userId = ctx.from.id;
  const textModel = models.gpt.actions.find(a => a.key === 'text');
  
  if (!textModel || !(await userBalance.hasTokens(userId, textModel.cost))) {
    await showInsufficientTokens(ctx, textModel.cost);
    return;
  }
  
  try {
    const statusMsg = await ctx.reply('🤔 Думаю...');
    const history = await userBalance.getConversationHistory(userId);
    const response = await claude.continueConversation(text, history);
    
    if (response.success) {
      await userBalance.saveConversationMessage(userId, 'user', text);
      await userBalance.saveConversationMessage(userId, 'assistant', response.text);
      await userBalance.deductTokens(userId, textModel.cost, 'Claude текстова генерація', { modelKey: 'claude_text', modelName: 'Claude Sonnet 4.5', apiCost: textModel.apiCost });
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.reply(response.text);
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка: ${response.error}`);
    }
  } catch (error) {
    console.error('Claude text error:', error);
    await ctx.reply('❌ Сталася помилка. Спробуйте ще раз.');
  }
}

async function handleClaudeVision(ctx) {
  const userId = ctx.from.id;
  const model = models.gpt.actions.find(m => m.key === 'image');

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  try {
    const statusMsg = await ctx.reply('👀 Аналізую зображення...');
    const imageUrl = await getImageUrl(ctx);
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
    const prompt = ctx.message.caption || 'Опишіть це зображення детально.';
    const response = await claude.analyzeImageWithClaude(imageBase64, prompt, 'image/jpeg');

    if (response.success) {
      await userBalance.saveConversationMessage(userId, 'user', `[Зображення] ${prompt}`);
      await userBalance.saveConversationMessage(userId, 'assistant', response.text);
      await userBalance.deductTokens(userId, model.cost, 'Claude аналіз зображення', { modelKey: 'claude_vision', modelName: 'Claude Vision', apiCost: model.apiCost });
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.reply(response.text);
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка: ${response.error}`);
    }
  } catch (error) {
    console.error('Claude vision error:', error);
    await ctx.reply('❌ Помилка при аналізі зображення.');
  }
}

async function handleSoraWatermarkRemover(ctx, videoUrl) {
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const currentModel = userCurrentModel.get(userId);

  console.log('🧹 Sora Watermark Remover handler called:', {
    userId,
    hasState: !!state,
    stateAction: state?.action,
    stateStep: state?.step,
    currentModel,
    videoUrl: videoUrl.substring(0, 50)
  });

  // Перевірка стану
  if (!state || state.action !== 'sora_watermark_remover' || state.step !== 'waiting_url') {
    console.log('❌ Sora Watermark: Invalid state', {
      noState: !state,
      wrongAction: state?.action !== 'sora_watermark_remover',
      wrongStep: state?.step !== 'waiting_url',
      actualAction: state?.action,
      actualStep: state?.step
    });
    await ctx.reply('❌ Помилка. Почніть заново: 🧠 Помічники → 🧹 Видалити Sora Watermark');
    return;
  }

  // Перевірка URL
  if (!videoUrl.includes('sora.chatgpt.com')) {
    await ctx.reply(
      '❌ <b>Невірний URL!</b>\n\n' +
      'URL має бути з sora.chatgpt.com\n\n' +
      '✅ <b>Приклад:</b>\n' +
      '<code>https://sora.chatgpt.com/g/gen_...</code>\n' +
      '<code>https://sora.chatgpt.com/p/s_...</code>\n\n' +
      '📤 Надішліть правильний URL:',
      { parse_mode: 'HTML' }
    );
    return;
  }

  console.log('✅ Sora Watermark: URL validation passed');

  // Отримуємо динамічну ціну
  console.log('🧹 Sora Watermark: Getting model info...');
  const kieAI = require('./services/kie-ai');
  const modelInfo = await kieAI.getModelInfo('sora-watermark-remover');
  const cost = modelInfo?.cost || 10;

  console.log('✅ Sora Watermark: Model info received:', { cost, apiCost: modelInfo?.apiCost });

  // Перевірка балансу
  console.log('🧹 Sora Watermark: Checking balance for user', userId);
  const hasBalance = await userBalance.hasTokens(userId, cost);
  console.log('🧹 Sora Watermark: Balance check result:', { hasBalance, requiredCost: cost });

  if (!hasBalance) {
    await showInsufficientTokens(ctx, cost);
    userState.delete(userId);
    return;
  }

  console.log('✅ Sora Watermark: Balance sufficient');

  // Очищаємо стан
  console.log('🧹 Sora Watermark: Clearing state...');
  userState.delete(userId);
  userCurrentModel.delete(userId);

  console.log('🧹 Sora Watermark: Sending status message...');
  const statusMsg = await ctx.reply(
    '🧹 <b>Видаляю watermark...</b>\n\n' +
    '⏱️ Це може зайняти 30-60 секунд\n' +
    '📊 Статус: обробка...',
    { parse_mode: 'HTML' }
  );

  console.log('✅ Sora Watermark: Status message sent, starting API call...');

  try {
    const soraWatermarkRemover = require('./services/sora-watermark-remover');

    console.log('🧹 Sora Watermark: Calling removeSoraWatermark API for user', userId);

    // Створюємо задачу
    const createResult = await soraWatermarkRemover.removeSoraWatermark(videoUrl);

    console.log('🧹 Sora Watermark: API result:', {
      success: createResult.success,
      taskId: createResult.taskId,
      error: createResult.error
    });

    if (!createResult.success) {
      // Перевіряємо тип помилки
      const isPermissionError = createResult.error?.toLowerCase().includes('permission') ||
                                 createResult.error?.toLowerCase().includes('access');
      const isCreditsError = createResult.error?.toLowerCase().includes('credits insufficient') ||
                              createResult.error?.toLowerCase().includes('balance');

      let errorMessage = '❌ <b>Помилка створення задачі</b>\n\n';

      if (isCreditsError) {
        errorMessage +=
          '💳 <b>Недостатньо credits на KIE.AI</b>\n\n' +
          'На балансі KIE.AI провайдера недостатньо credits для виконання цього запиту.\n\n' +
          '👨‍💼 <b>Для адміністратора:</b>\n' +
          '• Поповніть баланс на https://kie.ai\n' +
          '• Потрібно ~10 credits на одне видалення watermark\n\n' +
          '📝 <b>Технічна помилка:</b>\n' +
          `<code>${createResult.error}</code>`;
      } else if (isPermissionError) {
        errorMessage +=
          '🔒 <b>Немає доступу до відео</b>\n\n' +
          'KIE.AI API не може отримати доступ до вашого відео.\n\n' +
          '📝 <b>Можливі причини:</b>\n' +
          '• Відео є приватним\n' +
          '• Потрібно опублікувати відео через Share\n' +
          '• URL може бути застарілим\n\n' +
          '💡 <b>Спробуйте:</b>\n' +
          '1. Відкрийте відео на sora.chatgpt.com\n' +
          '2. Натисніть кнопку "Share" (якщо є)\n' +
          '3. Скопіюйте новий публічний URL\n' +
          '4. Надішліть його знову\n\n' +
          '⚠️ На жаль, Sora може не надавати публічних посилань для всіх відео.';
      } else {
        errorMessage += `${createResult.error}`;
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        errorMessage,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const taskId = createResult.taskId;
    let retries = 0;
    const maxRetries = 60;
    const retryDelay = 5000;

    // Polling статусу
    while (retries < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, retryDelay));

      const status = await soraWatermarkRemover.checkTaskStatus(taskId);

      if (status.state === 'success' && status.resultUrls?.[0]) {
        // Списуємо токени
        await userBalance.deductTokens(
          userId,
          cost,
          'Sora Watermark Remover',
          {
            modelKey: 'sora_watermark_remover',
            modelName: 'Sora Watermark Remover',
            apiCost: modelInfo?.apiCost || 0,
            videoUrl
          }
        );

        const user = await userBalance.getUser(userId, ctx.from);

        // Видаляємо статус
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

        // Надсилаємо відео
        await ctx.replyWithVideo(status.resultUrls[0], {
          caption:
            `✅ <b>Watermark видалено!</b>\n\n` +
            `🎬 Оригінальне відео: sora.chatgpt.com\n` +
            `💰 Використано: ${cost}⚡\n` +
            `💰 Залишок: ${user.tokens.toFixed(2)}⚡`,
          parse_mode: 'HTML',
          ...keyboard.createBackButton('main_menu')
        });

        return;
      } else if (status.state === 'fail') {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ <b>Помилка обробки</b>\n\n${status.error}`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Оновлюємо статус
      if (retries % 3 === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `🧹 <b>Видаляю watermark...</b>\n\n` +
          `⏱️ Очікування: ${Math.floor(retries * retryDelay / 1000)}с\n` +
          `📊 Статус: обробка...`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }

      retries++;
    }

    // Таймаут
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      '❌ <b>Перевищено час очікування</b>\n\nСпробуйте пізніше.',
      { parse_mode: 'HTML' }
    );

  } catch (error) {
    console.error('❌ Sora Watermark Remover Error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `❌ <b>Помилка</b>\n\n${error.message}`,
      { parse_mode: 'HTML' }
    );
  }
}

async function handleMidjourneyGeneration(ctx, prompt) {
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'midjourney_generation') {
    console.log('❌ No state for Midjourney generation');
    return;
  }

  const model = models.design.models.find(m => m.key === 'midjourney');
  const speed = state.speed || 'fast';
  const aspectRatio = state.aspectRatio || '1:1';
  const taskType = state.taskType || 'mj_txt2img';
  const fileUrls = state.fileUrls || [];

  // ✨ Розширені налаштування
  const stylization = state.stylization !== undefined ? state.stylization : 100;
  const weirdness = state.weirdness !== undefined ? state.weirdness : 0;
  const variety = state.variety !== undefined ? state.variety : 50;

  // ⚠️ Перевірка чи Midjourney доступний (потрібен KIE.AI API key)
  if (!kieAI.isKieAIEnabled) {
    console.error('❌ Midjourney unavailable: KIE_AI_API_KEY not configured');
    await ctx.reply(
      '⚠️ <b>Midjourney тимчасово недоступний</b>\n\n' +
      'На жаль, сервіс Midjourney зараз не налаштований.\n' +
      'Спробуйте інші моделі або зверніться до адміністратора.\n\n' +
      '💡 Доступні альтернативи:\n' +
      '• 🍌 Nano Banana Pro 2K/4K\n' +
      '• 🌱 Seedream 4K\n' +
      '• 🎨 Ideogram',
      { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
    );
    userState.delete(userId);
    return;
  }

  // Визначаємо вартість залежно від швидкості
  const cost = model.speeds[speed]?.cost || model.cost;
  const apiCost = model.speeds[speed]?.apiCost || model.apiCost;

  console.log('🖼️ Midjourney Generation:', {
    userId,
    speed,
    cost,
    apiCost,
    taskType,
    aspectRatio,
    stylization,
    weirdness,
    variety,
    hasImages: fileUrls.length > 0,
    prompt: prompt.substring(0, 100)
  });

  if (!(await userBalance.hasTokens(userId, cost))) {
    await showInsufficientTokens(ctx, cost);
    return;
  }

  const statusMsg = await ctx.reply(
    `🎨 Генерую зображення через Midjourney...\n\n` +
    `⚡ Швидкість: ${speed}\n` +
    `📐 Пропорції: ${aspectRatio}\n` +
    `🎨 Stylization: ${stylization}\n` +
    `🌀 Weirdness: ${weirdness}\n` +
    `🎲 Variety: ${variety}\n` +
    `⏱️ Це займе ~${speed === 'turbo' ? '30-60' : speed === 'fast' ? '60-90' : '120-180'} секунд`
  );

  try {
    const result = await midjourney.generateImage({
      prompt,
      taskType,
      speed,
      fileUrls: fileUrls.length > 0 ? fileUrls : undefined,
      aspectRatio,
      version: '7',
      stylization,
      weirdness,
      variety
    });

    if (!result.success) {
      // Спеціальна обробка для помилок доступу
      const errorMsg = result.error || 'Unknown error';
      const isAccessError = errorMsg.includes('access permissions') ||
        errorMsg.includes('unauthorized') ||
        errorMsg.includes('Invalid API key') ||
        errorMsg.includes('insufficient credits');

      const isServerError = errorMsg.includes('No response from MidJourney Official') ||
        errorMsg.includes('multiple attempts') ||
        errorMsg.includes('server error') ||
        errorMsg.includes('500');

      console.error('❌ Midjourney error:', errorMsg);

      let userMessage;
      if (isAccessError) {
        userMessage =
          '⚠️ <b>Midjourney тимчасово недоступний</b>\n\n' +
          'На жаль, сервіс зараз не може обробити запит.\n' +
          'Це може бути через технічні роботи або обмеження API.\n\n' +
          '💡 <b>Спробуйте альтернативи:</b>\n' +
          '• 🍌 Nano Banana Pro 2K/4K\n' +
          '• 🌱 Seedream 4K\n' +
          '• 🎯 Ideogram v3.0\n\n' +
          'Або спробуйте Midjourney пізніше.';
      } else if (isServerError) {
        userMessage =
          '⚠️ <b>Midjourney перевантажений</b>\n\n' +
          'Офіційний сервіс Midjourney не відповідає.\n' +
          'Спробуйте через кілька хвилин.\n\n' +
          '💡 <b>Або оберіть альтернативу:</b>\n' +
          '• 🍌 Nano Banana Pro\n' +
          '• 🌱 Seedream\n' +
          '• 🎯 Ideogram';
      } else {
        userMessage = `❌ Помилка генерації\n\nСпробуйте ще раз або оберіть іншу модель.`;
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        userMessage,
        { parse_mode: 'HTML' }
      );

      await adminNotifier.notifyAdmin(
        bot,
        new Error(result.error),
        {
          userId,
          username: ctx.from.username,
          action: 'midjourney_generation',
          model: 'Midjourney',
          speed,
          prompt,
          taskType,
          isAccessError
        }
      );

      userState.delete(userId);
      return;
    }

    console.log('✅ Midjourney task created:', result.taskId);

    // Чекаємо результату (polling або webhook)
    const finalResult = await midjourney.waitForCompletion(result.taskId);

    if (finalResult.success && finalResult.resultUrls && finalResult.resultUrls.length > 0) {
      await userBalance.deductTokens(
        userId,
        cost,
        'Midjourney generation',
        {
          modelKey: 'midjourney',
          modelName: model.name,
          apiCost,
          speed,
          taskType,
          aspectRatio,
          prompt,
          taskId: result.taskId
        }
      );

      const user = await userBalance.getUser(userId, ctx.from);
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

      // Відправляємо результати (4 варіанти)
      const imageUrls = finalResult.resultUrls.slice(0, 4);

      for (let i = 0; i < imageUrls.length; i++) {
        const imageUrl = imageUrls[i];
        const caption = i === 0
          ? `✅ Midjourney (${speed})\n\n` +
            `📝 Промпт: ${prompt.substring(0, 200)}${prompt.length > 200 ? '...' : ''}\n\n` +
            `💰 Використано: ${cost}⚡\n` +
            `💰 Залишок: ${user.tokens.toFixed(2)}⚡\n\n` +
            `💡 Оберіть варіант для Upscale (🔍) або Vary (🎨)`
          : undefined;

        try {
          await safeSendPhoto(ctx.chat.id, imageUrl, {
            caption,
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(`🔍 Upscale #${i + 1}`, `mj_upscale_${result.taskId}_${i + 1}`),
                Markup.button.callback(`🎨 Vary #${i + 1}`, `mj_vary_${result.taskId}_${i + 1}`)
              ]
            ])
          });
        } catch (error) {
          console.error(`Failed to send image ${i + 1}:`, error.message);
        }
      }

      userState.delete(userId);
    } else {
      const errorMsg = finalResult.error || 'Не вдалося отримати результат';
      const isTimeout = errorMsg.includes('Timeout') || errorMsg.includes('timeout');

      let userMessage;
      if (isTimeout) {
        userMessage =
          '⏱️ <b>Генерація триває довше очікуваного</b>\n\n' +
          `Швидкість: ${speed}\n` +
          'Очікуваний час: ~' + (speed === 'turbo' ? '30-60' : speed === 'fast' ? '60-90' : '120-180') + ' секунд\n\n' +
          '💡 Спробуйте:\n' +
          '• Зачекати ще трохи та спробувати знову\n' +
          '• Обрати швидшу опцію (Turbo)\n' +
          '• Використати альтернативну модель';
      } else {
        userMessage = `❌ Помилка: ${errorMsg}`;
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        userMessage,
        { parse_mode: 'HTML' }
      );
      userState.delete(userId);
    }

  } catch (error) {
    console.error('❌ Midjourney generation error:', error);
    await adminNotifier.notifyAdmin(
      bot,
      error,
      {
        userId,
        username: ctx.from.username,
        action: 'midjourney_generation',
        model: 'Midjourney',
        prompt
      }
    );
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Виникла помилка при генерації'
      );
    } catch (e) {
      await ctx.reply('❌ Виникла помилка при генерації');
    }
    userState.delete(userId);
  }
}

async function handleClarityUpscaler(ctx) {
  const userId = ctx.from.id;
  const model = models.design.models.find(m => m.key === 'clarity');

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  const statusMsg = await ctx.reply(`🔮 Покращую якість зображення через Clarity Upscaler...\n\n⏱️ Це може зайняти 30-60 секунд`);

  try {
    const imageUrl = await getImageUrl(ctx);
    const prompt = ctx.message.caption || 'masterpiece, best quality, highres, extremely detailed';
    const result = await replicate.generateWithClarityUpscaler(imageUrl, prompt);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), { userId, username: ctx.from.username, action: 'clarity_upscaler', model: 'Clarity Upscaler', prompt, imageUrl });
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка покращення.\n\nСпробуйте ще раз або оберіть іншу модель.`);
      return;
    }

    await userBalance.deductTokens(userId, model.cost, 'Clarity Upscaler', { modelKey: 'clarity', modelName: model.name, apiCost: model.apiCost, prompt });
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await safeSendPhoto(ctx.chat.id, result.imageUrl, {
      caption: `🔮 Clarity Upscaler\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
      ...keyboard.createBackButton('design_menu')
    });

  } catch (error) {
    console.error('Clarity Upscaler failed:', error);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Помилка покращення зображення. Спробуйте ще раз.');
  }
}

async function handleSunoGeneration(ctx, text) {
  const userId = ctx.from.id;
  const model = models.audio.models.find(m => m.key === 'suno');

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  if (text.length > 500) {
    await ctx.reply(`❌ Текст занадто довгий!\n\nМаксимум: 500 символів\nВаш текст: ${text.length} символів\n\nСкоротіть текст і спробуйте ще раз.`);
    return;
  }

  const statusMsg = await ctx.reply(`🎵 Генерую аудіо через Suno AI Bark...\n\nТекст: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"\n\n⏱️ Це може зайняти 20-40 секунд`);

  try {
    const result = await replicate.generateWithSuno(text);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), { userId, username: ctx.from.username, action: 'suno_generation', model: 'Suno AI Bark', text });
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка генерації аудіо.\n\nСпробуйте ще раз або оберіть іншу модель.`);
      return;
    }

    await userBalance.deductTokens(userId, model.cost, 'Suno audio generation', { modelKey: 'suno', modelName: model.name, apiCost: model.apiCost, text });
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.reply(
      `✅ <b>Аудіо готово!</b>\n\n` +
      `📝 Текст: "${text}"\n\n` +
      `💾 <b>Як зберегти аудіо:</b>\n` +
      `1️⃣ Натисніть на аудіо (☝️ див. нижче)\n` +
      `2️⃣ Натисніть меню ⋮\n` +
      `3️⃣ Оберіть "Зберегти" або "Завантажити"\n\n` +
      `💰 Витрачено: ${model.cost}⚡`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('audio_menu') }
    );

    await ctx.replyWithAudio({ url: result.audioUrl }, {
      caption: `🎵 Suno AI Bark\n\n📝 Текст: ${text}\n\n💰 Витрачено: ${model.cost}⚡`,
      ...keyboard.createBackButton('audio_menu')
    });

  } catch (error) {
    console.error('Suno generation failed:', error);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Помилка генерації аудіо. Спробуйте ще раз.');
  }
}

// ==================== HELPER FUNCTIONS ====================

async function getFileSize(url) {
  try {
    const response = await axios.head(url);
    return parseInt(response.headers['content-length'] || '0');
  } catch (error) {
    console.error('Error getting file size:', error.message);
    return 0;
  }
}

async function showProfile(ctx) {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);

  if (!user) {
    await ctx.reply('❌ Помилка. Спробуйте /start', keyboard.createBackButton());
    return;
  }

  const stats = await userBalance.getUserStats(ctx.from.id);
  
  if (!stats) {
    await ctx.reply('❌ Помилка отримання статистики', keyboard.createBackButton());
    return;
  }
  
  let message = `👤 Ваш профіль\n\n`;
  message += `🆔 ID: ${ctx.from.id}\n`;
  message += `👤 Ім'я: ${ctx.from.first_name}\n`;
  message += `💰 Баланс: ${stats.currentBalance.toFixed(2)}⚡\n`;
  message += `\n📊 Статистика:\n`;
  message += `🎨 Генерацій: ${stats.generationCount}\n`;
  message += `💸 Витрачено: ${stats.totalSpent.toFixed(2)}⚡\n`;
  message += `📅 З нами: ${stats.memberSince.toLocaleDateString('uk-UA')}`;
  
  await ctx.reply(message, keyboard.createProfileMenu());
}

async function showInsufficientTokens(ctx, required) {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);
  const starterPlan = models.subscriptions?.starter;
  const starterTokens = starterPlan?.tokensWayForPay ?? starterPlan?.tokens;
  const starterPrice = starterPlan?.priceUSD;
  const starterName = starterPlan?.name || 'STARTER';
  const starterLine = (starterTokens && starterPrice)
    ? `Рекомендуємо тариф ${starterName} — всього ${starterPrice}$ — ${starterTokens} токенів😍\n\n`
    : '';
  await ctx.reply(
    `Ви використали токени.🙌🏻\n\nНеобхідно: ${required}⚡\nВаш баланс: ${user.tokens.toFixed(2)}⚡\n\nВсі генерації в таких нейромережах коштують нам реальних грошей. Але ми зробили зручний бот, де ви можете користуватись ними прямо в Телеграм 😍\n\n${starterLine}Щоб продовжити, придбайте підписку та отримайте більше токенів👇🏻\n\n`,
    keyboard.createSubscriptionMenu()
  );
}

function getAdminTelegramId() {
  const first = accessControl.ADMIN_ID;
  const id = parseInt(first || '0');
  return Number.isFinite(id) ? id : 0;
}

function getBroadcastPriorityIds() {
  const raw = process.env.BROADCAST_PRIORITY_IDS || '';
  if (!raw.trim()) return [];
  const ids = raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return Array.from(new Set(ids));
}

function resolveBroadcastParseMode(modeArg) {
  const normalized = (modeArg || '').toLowerCase();
  if (['plain', 'text', 'none', 'off'].includes(normalized)) return null;
  return 'HTML';
}

function buildMessageOptions(parseMode) {
  const options = { disable_web_page_preview: true };
  if (parseMode) options.parse_mode = parseMode;
  return options;
}

function buildMediaOptions(caption, parseMode) {
  const options = {};
  if (caption) options.caption = caption;
  if (caption && parseMode) options.parse_mode = parseMode;
  return options;
}

function buildBroadcastConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Надіслати всім', 'broadcast_send')],
    [Markup.button.callback('❌ Скасувати', 'broadcast_cancel')]
  ]);
}

async function sendBroadcastToChatId(chatId, draft) {
  if (draft.type === 'text') {
    return bot.telegram.sendMessage(chatId, draft.text, buildMessageOptions(draft.parseMode));
  }
  if (draft.type === 'photo') {
    return bot.telegram.sendPhoto(chatId, draft.fileId, buildMediaOptions(draft.caption, draft.parseMode));
  }
  if (draft.type === 'video') {
    return bot.telegram.sendVideo(chatId, draft.fileId, buildMediaOptions(draft.caption, draft.parseMode));
  }
  if (draft.type === 'video_note') {
    return bot.telegram.sendVideoNote(chatId, draft.fileId);
  }
  if (draft.type === 'document') {
    return bot.telegram.sendDocument(chatId, draft.fileId, buildMediaOptions(draft.caption, draft.parseMode));
  }

  throw new Error(`Unsupported broadcast type: ${draft.type}`);
}

async function sendBroadcastPreview(ctx, draft) {
  if (draft.type === 'text') {
    await ctx.reply(draft.text, buildMessageOptions(draft.parseMode));
  } else if (draft.type === 'photo') {
    await ctx.replyWithPhoto(draft.fileId, buildMediaOptions(draft.caption, draft.parseMode));
  } else if (draft.type === 'video') {
    await ctx.replyWithVideo(draft.fileId, buildMediaOptions(draft.caption, draft.parseMode));
  } else if (draft.type === 'video_note') {
    await ctx.replyWithVideoNote(draft.fileId);
  } else if (draft.type === 'document') {
    await ctx.replyWithDocument(draft.fileId, buildMediaOptions(draft.caption, draft.parseMode));
  }

  await ctx.reply('Підтвердити розсилку?', buildBroadcastConfirmKeyboard());
}

async function broadcastDraft(draft) {
  try {
    console.log('📢 Starting broadcast...');
    const User = require('./database/models/User');
    const users = await User.find({}, '_id username');
    console.log(`📊 Found ${users.length} users`);

    const priorityIds = getBroadcastPriorityIds();
    const prioritySet = new Set(priorityIds);

    let successCount = 0;
    let failCount = 0;

    if (priorityIds.length) {
      console.log(`⭐ Priority-only broadcast to ${priorityIds.length} users`);
      for (const chatId of priorityIds) {
        try {
          await sendBroadcastToChatId(chatId, draft);
          successCount++;
          console.log(`✅ Sent to ${chatId} (priority)`);
          await new Promise(resolve => setTimeout(resolve, 35));
        } catch (error) {
          failCount++;
          console.error(`❌ Failed to send to ${chatId} (priority):`, error.message);
        }
      }
    }

    // Якщо заданий список, розсилаємо ТІЛЬКИ цим користувачам
    if (priorityIds.length) {
      console.log('ℹ️ Broadcast limited to priority list only.');
      console.log(`✅ Broadcast complete: ${successCount} sent, ${failCount} failed`);
      return { success: successCount, failed: failCount };
    }

    for (const user of users) {
      try {
        const chatId = user._id;
        if (!chatId) {
          console.error('⚠️ User without ID:', user);
          failCount++;
          continue;
        }
        
        await sendBroadcastToChatId(chatId, draft);
        successCount++;
        console.log(`✅ Sent to ${chatId} (@${user.username || 'no_username'})`);
        await new Promise(resolve => setTimeout(resolve, 35));
      } catch (error) {
        failCount++;
        console.error(`❌ Failed to send to ${user._id}:`, error.message);
      }
    }

    console.log(`✅ Broadcast complete: ${successCount} sent, ${failCount} failed`);
    return { success: successCount, failed: failCount };
  } catch (error) {
    console.error('Broadcast error:', error);
    throw error;
  }
}

async function broadcastPayload(draft) {
  return broadcastDraft(draft);
}

async function broadcastMedia(draft) {
  return broadcastDraft(draft);
}

async function broadcastMessage(message, parseMode = null) {
  return broadcastDraft({ type: 'text', text: message, parseMode });
}

// ==================== ЗАПУСК БОТА ====================

async function startBot() {
  try {
    console.log('🚀 Starting neuro.lab.ai Bot...');
    console.log('📡 Connecting to MongoDB...');

    // Pre-cache exchange rate for faster API responses
    console.log('💱 Pre-caching exchange rate...');
    try {
      const rate = await exchangeRate.getRate();
      console.log(`✅ Exchange rate cached: 1 USD = ${rate.toFixed(2)} UAH`);
    } catch (error) {
      console.warn('⚠️ Could not pre-cache exchange rate:', error.message);
    }

    // Pre-cache Telegram Stars rate
    console.log('⭐ Pre-caching Telegram Stars rate...');
    try {
      const telegramStars = require('./services/telegramStars');
      const tgRate = await telegramStars.getStarRate();
      console.log(`✅ Telegram Stars rate cached: 1 Star = $${tgRate.toFixed(4)}`);
    } catch (error) {
      console.warn('⚠️ Could not pre-cache Telegram Stars rate:', error.message);
    }

    // Try to connect to MongoDB, but continue if it fails
    const dbConnected = await db.connect();
    if (dbConnected) {
      console.log('✅ Database connected');
    } else {
      console.log('⚠️ Database connection failed - bot will work in limited mode');
    }

    console.log('🤖 Starting bot...');

    // Виводимо поточні налаштування доступу
    accessControl.printConfig();

    // 🔍 Перевірка стану KIE.AI
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║              KIE.AI PROVIDER STATUS                    ║');
    console.log('╠════════════════════════════════════════════════════════╣');
    console.log(`║ API Key configured:  ${kieAI.isKieAIEnabled ? '✅ YES' : '❌ NO'}`);
    console.log(`║ Supported models:    ${kieAI.SUPPORTED_MODELS.image.length} image, ${kieAI.SUPPORTED_MODELS.video.length} video`);
    if (kieAI.isKieAIEnabled) {
      console.log(`║ Image models:        ${kieAI.SUPPORTED_MODELS.image.join(', ')}`);
    }
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('✅ Bot started successfully!');
    console.log('📱 Bot username: @neuro_lab_ai_bot');

    // 🛑 Ініціалізуємо graceful shutdown (для pm2 restart)
    gracefulShutdown.initShutdownHandlers(bot);

    // 💰 Перевірка цін Replicate при старті
    replicatePricing.logPriceComparison();

    // 💰 Оновлення цін KIE.AI при старті (якщо потрібно)
    try {
      console.log('💰 Checking KIE.AI pricing...');
      await kiePricingSync.updatePricingIfNeeded();

      // Щоденне оновлення цін (раз на 24 години)
      setInterval(async () => {
        console.log('⏰ Daily KIE.AI pricing update...');
        try {
          await kiePricingSync.updatePricingIfNeeded();
          console.log('✅ KIE.AI pricing updated');
        } catch (error) {
          console.error('❌ Failed to update KIE.AI pricing:', error.message);
        }
      }, 24 * 60 * 60 * 1000); // 24 години
    } catch (error) {
      console.error('⚠️ KIE.AI pricing update failed (not critical):', error.message);
    }

    if (isShowBroadCast) {
      console.log('📢 Sending startup broadcast...');
      setTimeout(async () => {
        try {
          const message = '🎉 <b>Бот знову онлайн!</b>\n\n✨ Насолоджуйтесь генераціями!\n\n🆕 Що нового:\n• 🎨 Нові ціни на зображення (в 2-5 разів дешевше!)\n• 🎬 Runway Turbo тепер 14⚡\n💡 Спробуйте зараз! 🚀';
          const stats = await broadcastMessage(message, 'HTML');
          console.log(`📊 Broadcast stats: ${stats.success} успішно, ${stats.failed} помилок`);
          
          const adminIds = accessControl.getAdminIds();
          const report = `📊 Startup broadcast complete:\n✅ Sent: ${stats.success}\n❌ Failed: ${stats.failed}`;
          for (const adminId of adminIds) {
            await bot.telegram.sendMessage(adminId, report);
          }
        } catch (error) {
          console.error('Startup broadcast failed:', error);
        }
      }, 5000);
    }

    // ==================== EXPRESS SERVER ====================
    const app = express();
    const PORT = process.env.PORT || 5500;

    // ⚠️ ВАЖЛИВО: WayForPay webhook - потрібен спеціальний parser для raw JSON!
    // WayForPay надсилає raw JSON без правильного Content-Type header
    app.post('/webhook/wayforpay', express.raw({ type: '*/*' }), (req, res, next) => {
        try {
            let data;

            if (typeof req.body === 'string') {
                // Raw JSON string
                console.log('📥 Parsing raw JSON from WayForPay...');
                data = JSON.parse(req.body);
            } else if (Buffer.isBuffer(req.body)) {
                // Buffer - конвертуємо в string
                console.log('📥 Parsing Buffer from WayForPay...');
                data = JSON.parse(req.body.toString('utf8'));
            } else if (typeof req.body === 'object') {
                // Об'єкт - використовуємо як є
                data = req.body;
            } else {
                console.error('❌ Unexpected body type:', typeof req.body);
                return res.status(400).json({ error: 'Invalid request body' });
            }

            console.log('✅ WayForPay webhook body parsed successfully');
            req.body = data;
            next();
        } catch (error) {
            console.error('❌ Failed to parse WayForPay webhook:', error.message);
            res.status(400).json({ error: 'Invalid JSON' });
        }
    });

    // ✅ Стандартні body parsers для інших маршрутів
    app.use(express.json({ limit: '1mb' })); // Обмеження розміру body
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // ✅ Security headers
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      next();
    });

    // ✅ Simple rate limiting for payment APIs (in-memory)
    const rateLimitMap = new Map();
    const RATE_LIMIT_WINDOW = 60000; // 1 хвилина
    const RATE_LIMIT_MAX = 10; // Максимум 10 запитів на хвилину

    function checkRateLimit(ip, endpoint) {
      const key = `${ip}:${endpoint}`;
      const now = Date.now();
      const record = rateLimitMap.get(key);

      if (!record || now - record.timestamp > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(key, { timestamp: now, count: 1 });
        return true;
      }

      if (record.count >= RATE_LIMIT_MAX) {
        return false;
      }

      record.count++;
      return true;
    }

    // ✅ Rate limiting middleware для платіжних endpoints
    app.use('/api/stripe', (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      if (!checkRateLimit(ip, 'stripe')) {
        console.warn(`⚠️ Rate limit exceeded for IP ${ip} on /api/stripe`);
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      next();
    });

    app.use('/api/wayforpay', (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      if (!checkRateLimit(ip, 'wayforpay')) {
        console.warn(`⚠️ Rate limit exceeded for IP ${ip} on /api/wayforpay`);
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      next();
    });

    app.use('/api/liqpay', (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      if (!checkRateLimit(ip, 'liqpay')) {
        console.warn(`⚠️ Rate limit exceeded for IP ${ip} on /api/liqpay`);
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      next();
    });

    // ✅ CORS для публічних API endpoints (дозволяємо всім - це публічна інформація)
    app.use('/api', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    // Webhook для Stripe (необхідно до express.json())
    app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
      stripeWebhook.handleStripeWebhook(req, res, bot).catch(error => {
        console.error('Webhook handler error:', error);
        res.status(500).json({ error: 'Internal server error' });
      });
    });

    // Webhook для LiqPay (передаємо bot instance для відправки повідомлень)
    const createLiqPayRouter = require('./webhooks/liqpay');
    const liqpayWebhook = createLiqPayRouter(bot);
    app.use('/webhook', liqpayWebhook);

    // Webhook для WayForPay (передаємо bot instance для відправки повідомлень)
    const createWayForPayRouter = require('./webhooks/wayforpay');
    const wayforpayWebhook = createWayForPayRouter(bot);
    app.use('/webhook', wayforpayWebhook);

    // ✅ Admin routes (protected by ADMIN_TOKEN)
    app.use('/admin', adminRoutes);

    // ✅ Schedule monitoring alerts
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_ALERTS === 'true') {
      monitoringAlerts.scheduleAlerts(bot);
      console.log('📢 Monitoring alerts scheduled');
    }


    // ==================== PAGES ====================

    // ✅ Stripe checkout page
    app.get('/pay/stripe', (req, res) => {
      const plan = req.query.plan;

      console.log(`📄 Stripe checkout page requested: plan=${plan}`);

      if (!plan) {
        return res.status(400).send('План не обрано');
      }

      const filePath = __dirname + '/public/stripe-checkout.html';
      console.log(`📂 Sending file: ${filePath}`);
      res.sendFile(filePath);
    });

    // ✅ Stripe checkout route
    // ⚠️ SECURITY: НЕ довіряємо клієнту tokens/amount - беремо з models.js
    app.post('/api/stripe/checkout', async (req, res) => {
      const { userId, plan } = req.body;

      console.log(`📋 Stripe checkout request:`, { userId, plan });

      if (!userId || !plan) {
        console.error('❌ Missing required fields:', { userId, plan });
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: userId, plan'
        });
      }

      // ⚠️ SECURITY: Валідація userId - має бути числом
      const userIdNum = parseInt(userId, 10);
      if (isNaN(userIdNum) || userIdNum <= 0) {
        console.error('❌ Invalid userId:', userId);
        return res.status(400).json({
          success: false,
          error: 'Invalid userId'
        });
      }

      // ⚠️ SECURITY: Валідація плану - беремо дані ТІЛЬКИ з сервера
      const sub = models.subscriptions[plan];
      if (!sub) {
        console.error('❌ Invalid plan:', plan);
        return res.status(400).json({
          success: false,
          error: 'Invalid plan'
        });
      }

      if (sub.adminOnly && userIdNum !== getAdminTelegramId()) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden'
        });
      }

      // ✅ Токени та ціна з серверної конфігурації
      const tokens = sub.tokens; // Для Stripe - без бонусу LiqPay
      const amount = sub.priceUSD * 100; // В центах для Stripe

      console.log(`📋 Validated checkout:`, { userId, plan, tokens, amount: amount / 100 });

      const result = await payment.createStripeCheckout(userId, plan, tokens, amount);

      if (result.success) {
        res.json({
          success: true,
          url: result.url,
          sessionId: result.sessionId
        });
      } else {
        console.error('❌ Stripe checkout error:', result.error);
        res.status(400).json({
          success: false,
          error: result.error
        });
      }
    });

    // ✅ LiqPay checkout page
    app.get('/pay/liqpay', (req, res) => {
      const plan = req.query.plan;

      console.log(`📄 LiqPay checkout page requested: plan=${plan}`);

      if (!plan) {
        return res.status(400).send('План не обрано');
      }

      const filePath = __dirname + '/public/liqpay-checkout.html';
      console.log(`📂 Sending file: ${filePath}`);
      res.sendFile(filePath);
    });

    // ✅ LiqPay checkout API
    app.post('/api/liqpay/checkout', async (req, res) => {
      const { userId, plan } = req.body;
      const liqpay = require('./services/liqpay');

      console.log(`📋 LiqPay checkout request:`, { userId, plan });

      if (!userId || !plan) {
        console.error('❌ Missing required fields:', { userId, plan });
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: userId, plan'
        });
      }

      // ⚠️ SECURITY: Валідація userId - має бути числом
      const userIdNum = parseInt(userId, 10);
      if (isNaN(userIdNum) || userIdNum <= 0) {
        console.error('❌ Invalid userId:', userId);
        return res.status(400).json({
          success: false,
          error: 'Invalid userId'
        });
      }

      try {
        // Отримуємо інформацію про план
        const sub = models.subscriptions[plan];
        if (!sub) {
          return res.status(400).json({
            success: false,
            error: 'Invalid plan'
          });
        }

        if (sub.adminOnly && userIdNum !== getAdminTelegramId()) {
          return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        if (sub.adminOnly && userIdNum !== getAdminTelegramId()) {
          return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        // Отримуємо реальний курс USD/UAH
        const rate = await exchangeRate.getRate();

        // Розраховуємо суму в UAH на основі priceUSD та поточного курсу
        const amountUAH = Math.round(sub.priceUSD * rate);

        // Використовуємо tokensWayForPay (бонус для LiqPay платежу) або звичайні tokens
        // ✅ Отримуємо з плану, НЕ з клієнтського payload!
        const tokenCount = sub.tokensWayForPay || sub.tokens;

        console.log(`📊 LiqPay pricing: priceUSD=${sub.priceUSD}, rate=${rate.toFixed(2)}, amountUAH=${amountUAH}, tokens=${tokenCount}`);

        // Генеруємо унікальний ID замовлення: userId_planKey_timestamp
        const orderId = `${userId}_${plan}_${Date.now()}`;

        // Параметри платежу для LiqPay
        const checkoutParams = {
          order_id: orderId,
          amount: amountUAH,
          currency: 'UAH',
          description: `neuro.lab.ai - ${plan} (${tokenCount}⚡)`,
          server_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/webhook/liqpay`,
          result_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/payment/success?order_id=${orderId}`,
          language: 'uk'
        };

        const checkout = await liqpay.createCheckout(checkoutParams);

        console.log(`✅ LiqPay checkout created for user ${userId}: order_id=${orderId}`);

        // Формуємо посилання на платіж
        const checkoutUrl = `https://www.liqpay.ua/api/3/checkout?data=${checkout.data}&signature=${checkout.signature}`;

        res.json({
          success: true,
          checkoutUrl: checkoutUrl,
          orderId: orderId
        });
      } catch (error) {
        console.error('❌ LiqPay checkout error:', error);
        res.status(400).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ WayForPay checkout page
    app.get('/pay/wayforpay', (req, res) => {
      const plan = req.query.plan;

      console.log(`📄 WayForPay checkout page requested: plan=${plan}`);

      if (!plan) {
        return res.status(400).send('План не обрано');
      }

      const filePath = __dirname + '/public/wayforpay-checkout.html';
      console.log(`📂 Sending file: ${filePath}`);
      res.sendFile(filePath);
    });

    // ✅ WayForPay checkout API
    app.post('/api/wayforpay/checkout', async (req, res) => {
      const { userId, plan } = req.body;
      const wayforpay = require('./services/wayforpay');

      console.log(`📋 WayForPay checkout request:`, { userId, plan });

      if (!userId || !plan) {
        console.error('❌ Missing required fields:', { userId, plan });
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: userId, plan'
        });
      }

      // ⚠️ SECURITY: Валідація userId - має бути числом
      const userIdNum = parseInt(userId, 10);
      if (isNaN(userIdNum) || userIdNum <= 0) {
        console.error('❌ Invalid userId:', userId);
        return res.status(400).json({
          success: false,
          error: 'Invalid userId'
        });
      }

      try {
        // Перевіримо чи є такий план
        const sub = models.subscriptions[plan];
        if (!sub) {
          return res.status(400).json({
            success: false,
            error: 'Invalid plan'
          });
        }

        // Отримуємо кількість токенів з плану (не з клієнтського payload!)
        const tokens = sub.tokensWayForPay || sub.tokens;

        // Отримуємо реальну ціну в UAH
        const rate = await exchangeRate.getRate();
        const amount = sub.priceWayForPayUAH ?? Math.round(sub.priceUSD * rate);

        // Генеруємо унікальний ID замовлення: userId_planKey_timestamp
        const orderReference = `${userId}_${plan}_${Date.now()}`;

        // Параметри платежу для WayForPay
        const checkoutParams = {
          order_id: orderReference,
          amount: amount,
          currency: 'UAH',
          description: `neuro.lab.ai - ${plan} (${tokens}⚡)`,
          result_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/payment/success?order_id=${orderReference}`,
          decline_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/payment/failed?order_id=${orderReference}`,
          server_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/webhook/wayforpay`
        };

        const checkout = await wayforpay.createCheckout(checkoutParams);

        console.log(`✅ WayForPay checkout created for user ${userId}: order_id=${orderReference}`);

        res.json({
          success: true,
          checkoutUrl: checkout.checkoutUrl,
          params: checkout.params,
          orderId: orderReference
        });
      } catch (error) {
        console.error('❌ WayForPay checkout error:', error);
        res.status(400).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Verify WayForPay payment status
    app.get('/api/payment/verify/:orderId', async (req, res) => {
      const { orderId } = req.params;

      try {
        console.log(`🔍 Verifying payment status for order: ${orderId}`);

        // Перевіряємо чи платіж вже обробленый
        const Transaction = require('./database/models/Transaction');

        if (!Transaction) {
          // Якщо модель не існує, повертаємо успіх (webhook обробить)
          return res.json({ success: true, status: 'pending' });
        }

        const transaction = await Transaction.findOne({
          'metadata.orderId': orderId
        });

        if (transaction) {
          console.log(`✅ Payment found in database:`, {
            status: transaction.type,
            orderId
          });
          return res.json({
            success: true,
            status: 'completed',
            transaction: transaction
          });
        }

        // Платіж не знайдено - можливо він відхилено
        console.log(`⚠️ Payment not found in database:`, orderId);
        res.json({
          success: false,
          status: 'failed',
          message: 'Payment not found'
        });
      } catch (error) {
        console.error('❌ Payment verification error:', error);
        res.json({ success: false, status: 'error', error: error.message });
      }
    });

    // ✅ Manual payment processing for WayForPay (fallback when webhook fails)
    app.post('/api/payment/process-wayforpay/:orderId', async (req, res) => {
      const { orderId } = req.params;

      try {
        console.log(`🔄 Manual processing WayForPay payment: ${orderId}`);

        // Парсимо order_id: userId_plan_timestamp
        const parts = orderId.split('_');
        const userId = parseInt(parts[0]);
        const plan = parts[1];

        console.log(`📊 Parsed order: userId=${userId}, plan=${plan}, parts=${JSON.stringify(parts)}`);

        if (!userId || !plan) {
          console.error(`❌ Invalid order format: userId=${userId}, plan=${plan}`);
          return res.json({
            success: false,
            error: 'Invalid order format'
          });
        }

        // Отримуємо інформацію про план
        const sub = models.subscriptions[plan];
        if (!sub) {
          console.error(`❌ Invalid plan: ${plan}`);
          return res.json({
            success: false,
            error: 'Invalid plan'
          });
        }

        console.log(`✅ Plan found: ${sub.name}`);

        // Перевіряємо чи вже оброблено
        const Transaction = require('./database/models/Transaction');
        const existing = await Transaction.findOne({
          'metadata.orderId': orderId,
          type: 'wayforpay_purchase'
        });

        if (existing) {
          console.log(`⚠️ Order ${orderId} already processed`);
          return res.json({
            success: true,
            message: 'Already processed',
            tokens: existing.amount
          });
        }

        // ⚠️ СПРОБУЄМО перевірити статус через CHECK_STATUS API
        console.log(`🔍 Attempting to check payment status via WayForPay API...`);

        let paymentStatus = null;
        try {
          const wayforpay = require('./services/wayforpay');
          paymentStatus = await wayforpay.checkPaymentStatus(orderId);

          console.log(`📊 CHECK_STATUS response:`, paymentStatus);

          // ✅ WayForPay може повертати 'Approved' або 'Completed' для успішних платежів
          if (paymentStatus && (paymentStatus.transactionStatus === 'Approved' || paymentStatus.transactionStatus === 'Completed')) {
            console.log(`✅ Payment is COMPLETED! Processing immediately...`);

            const tokens = sub.tokensWayForPay || sub.tokens;

            // Нараховуємо токени
            await userBalance.addTokens(
              userId,
              tokens,
              'wayforpay_purchase',
              {
                plan: sub.name,
                planKey: plan,
                orderId: orderId,
                processedAt: new Date()
              }
            );

            console.log(`✅ +${tokens}⚡ added to user ${userId}`);

            // Отримуємо користувача для відправки повідомлення
            const user = await userBalance.getUser(userId, { id: userId });

            // Відправляємо повідомлення про успіх
            if (bot) {
              try {
                await bot.telegram.sendMessage(
                  userId,
                  `✅ <b>Оплату отримано!</b>\n\n` +
                  `💳 Метод: WayForPay\n` +
                  `💎 Тариф: ${sub.name}\n` +
                  `⚡ Токенів нараховано: ${tokens}\n` +
                  `💰 Новий баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
                  `Дякуємо за покупку! 🎉`,
                  { parse_mode: 'HTML' }
                );
                console.log(`📨 Success message sent to user ${userId}`);
              } catch (err) {
                console.error('Error sending success message:', err.message);
              }
            }

            return res.json({
              success: true,
              message: 'Payment processed successfully',
              status: 'completed',
              tokens: tokens,
              balance: user.tokens
            });
          }
        } catch (checkError) {
          console.log(`⚠️ Could not check payment status via API: ${checkError.message}`);
          console.log(`💡 Will wait for webhook to process payment`);
        }

        // ⚠️ Якщо CHECK_STATUS не спрацював або статус невідомий - вважаємо платіж очікуючим
        // Webhook обробить платіж коли він буде активний.

        console.log(`📝 Payment is PENDING (waiting for webhook from WayForPay)`);
        console.log(`💡 On PRODUCTION: Webhook from WayForPay will process this payment`);
        console.log(`💡 On LOCAL: Payment stays pending until webhook is manually triggered`);

        // Повідомляємо користувача що платіж очікується
        if (bot) {
          try {
            await bot.telegram.sendMessage(
              userId,
              `⏳ <b>Платіж очікується на обробку</b>\n\n` +
              `💳 Метод: WayForPay\n` +
              `💎 Тариф: ${sub.name}\n` +
              `💰 Сума: 4 UAH\n` +
              `⏳ Статус: Перевірка безпеки\n\n` +
              `Ваш платіж проходить перевірку у фахівців з безпеки WayForPay.\n` +
              `Токени будуть додані коли платіж буде підтверджений (зазвичай протягом кількох хвилин).\n\n` +
              `Замовлення: ${orderId}`,
              { parse_mode: 'HTML' }
            );
            console.log(`📨 Pending message sent to user ${userId}`);
          } catch (err) {
            console.error('Error sending message:', err.message);
          }
        }

        // Повертаємо успіх - платіж ще не оброблений, але очікується webhook
        res.json({
          success: true,
          message: 'Payment is pending webhook confirmation',
          status: 'pending',
          tokens: 0  // Поки не додано, бо платіж ще не підтверджений
        });

      } catch (error) {
        console.error('❌ Manual payment processing error:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Check payment status
    app.get('/api/payment/status/:sessionId', async (req, res) => {
      const { sessionId } = req.params;

      const result = await payment.getCheckoutSession(sessionId);

      if (result.success) {
        res.json({
          success: true,
          status: result.session.payment_status,
          metadata: result.session.metadata
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error
        });
      }
    });

    // ✅ Process completed payment (called from success page)
    app.post('/api/payment/process/:sessionId', async (req, res) => {
      const { sessionId } = req.params;

      console.log(`🔄 Processing payment for session: ${sessionId}`);

      try {
        const result = await payment.getCheckoutSession(sessionId);

        if (!result.success) {
          return res.status(400).json({
            success: false,
            error: 'Failed to retrieve session'
          });
        }

        const session = result.session;

        // Check if payment was actually completed
        if (session.payment_status !== 'paid') {
          return res.json({
            success: false,
            error: 'Payment not completed yet',
            status: session.payment_status
          });
        }

        // Extract metadata
        const { userId, plan, tokens } = session.metadata || {};

        if (!userId || !tokens) {
          console.error('❌ Missing metadata in session:', session.metadata);
          return res.status(400).json({
            success: false,
            error: 'Invalid session metadata'
          });
        }

        // Check if already processed (idempotency)
        const Transaction = require('./database/models/Transaction');
        const existingTransaction = await Transaction.findOne({ sessionId });

        if (existingTransaction) {
          console.log(`⚠️ Transaction already processed for session ${sessionId}`);
          return res.json({
            success: true,
            message: 'Already processed',
            tokens: tokens
          });
        }

        // Credit tokens to user
        await userBalance.addTokens(
          parseInt(userId),
          parseInt(tokens),
          'stripe_payment',
          { plan, sessionId: session.id, amount: session.amount_total }
        );

        // Send message to user
        try {
          await bot.telegram.sendMessage(
            userId,
            `✅ Оплату отримано!\n\n` +
            `💳 Метод: Stripe\n` +
            `💎 Тариф: ${plan}\n` +
            `⚡ Токенів нараховано: ${tokens}\n` +
            `💰 Сума: $${(session.amount_total / 100).toFixed(2)}\n\n` +
            `Дякуємо за покупку! 🎉`,
            { parse_mode: 'HTML' }
          );
        } catch (error) {
          console.error('Error sending message to user:', error.message);
        }

        console.log(`✅ Payment processed successfully for user ${userId}: +${tokens}⚡`);

        res.json({
          success: true,
          message: 'Tokens credited successfully',
          tokens: tokens
        });
      } catch (error) {
        console.error('❌ Error processing payment:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Process LiqPay payment by order_id (для синхронної обробки)
    app.post('/api/liqpay/process/:orderId', async (req, res) => {
      try {
        const { orderId } = req.params;

        console.log(`📋 Processing LiqPay order: ${orderId}`);

        // Розпарсимо замовлення
        const parts = orderId.split('_');
        const userId = parseInt(parts[0]);
        const planKey = parts[1];

        if (!userId || !planKey) {
          return res.status(400).json({
            success: false,
            error: 'Invalid order_id format'
          });
        }

        const sub = models.subscriptions[planKey];
        if (!sub) {
          return res.status(400).json({
            success: false,
            error: 'Plan not found'
          });
        }

        // Додаємо токени
        await userBalance.addTokens(
          userId,
          sub.tokens,
          'liqpay_purchase',
          {
            plan: sub.name,
            tokens: sub.tokens,
            orderId: orderId
          }
        );

        // Отримуємо користувача
        const user = await userBalance.getUser(userId, { id: userId });

        // Відправляємо повідомлення в Telegram
        try {
          await bot.telegram.sendMessage(
            userId,
            `✅ <b>Платіж успішно оброблений!</b>\n\n` +
            `💳 Метод: LiqPay\n` +
            `💎 Тариф: ${sub.name}\n` +
            `⚡ Токенів нараховано: ${sub.tokens}\n` +
            `💰 Новий баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
            `Дякуємо за покупку! 🎉`,
            { parse_mode: 'HTML' }
          );
          console.log(`📨 Success message sent to user ${userId}`);
        } catch (error) {
          console.error('Error sending message:', error.message);
        }

        res.json({
          success: true,
          message: 'Payment processed',
          tokens: sub.tokens,
          balance: user.tokens
        });
      } catch (error) {
        console.error('Error processing LiqPay order:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // ✅ Get subscription plans with dynamic LiqPay prices
    app.get('/api/plans', async (req, res) => {
      try {
        const startTime = Date.now();
        const subscriptions = models.subscriptions;
        const requestUserId = parseInt(req.query.userId || req.query.tg_id || '0', 10);
        const isAdminRequest = requestUserId && requestUserId === getAdminTelegramId();
        const plans = {};

        // Отримуємо актуальний курс USD/UAH (з кешем для швидкості)
        const rate = await exchangeRate.getRate();

        // Отримуємо динамічний курс Telegram Stars (1 Star = ? USD)
        const telegramStars = require('./services/telegramStars');
        const tgStarRate = await telegramStars.getStarRate();

        const fetchTime = Date.now() - startTime;

        // ============================================================
        // TOKEN PRICE CALCULATION PER PLAN
        // Formula: tokenPriceUSD = priceUSD / tokensWayForPay (LiqPay дає більше токенів)
        // ============================================================
        const planKeys = ['starter', 'basic', 'pro', 'premium'];
        if (isAdminRequest) {
          Object.entries(subscriptions).forEach(([key, sub]) => {
            if (sub?.adminOnly && !planKeys.includes(key)) {
              planKeys.push(key);
            }
          });
        }

        const tokenPriceUSDByPlan = planKeys.reduce((acc, key) => {
          const sub = subscriptions[key];
          if (sub?.priceUSD && sub?.tokensWayForPay) {
            acc[key] = +(sub.priceUSD / sub.tokensWayForPay).toFixed(5);
          } else {
            acc[key] = 0;
          }
          return acc;
        }, {});

        // Default tokenPriceUSD = premium plan (найкращий для клієнта, найгірший для нас)
        // Використовується для backwards compatibility та UI calculations
        const tokenPriceUSD = tokenPriceUSDByPlan.premium
          || WORST_CASE_TOKEN_USD
          || 0.02311; // fallback: 110/4760

        // Helper: calculate gross margin for a model
        const calcGrossMargin = (cost, apiCost) => {
          if (!apiCost || apiCost === 0) return null;
          const revenue = cost * tokenPriceUSD;
          const margin = ((revenue - apiCost) / revenue) * 100;
          return +margin.toFixed(1);
        };

        planKeys.forEach(planKey => {
          const sub = subscriptions[planKey];
          if (sub) {
            // Розраховуємо TG Stars динамічно: priceUSD / tgStarRate
            const priceStarsDynamic = Math.round(sub.priceUSD / tgStarRate);

            // Розраховуємо LiqPay ціну: priceUSD * реальний курс
            const priceUAHDynamic = sub.priceWayForPayUAH ?? Math.round(sub.priceUSD * rate);

            plans[planKey] = {
              name: sub.name,
              tokens: sub.tokens,
              tokensWayForPay: sub.tokensWayForPay,
              price: sub.price, // Telegram Stars (оригінальна)
              priceUSD: sub.priceUSD, // Базова ціна в USD
              priceStarsDynamic: priceStarsDynamic, // TG Stars динамічна ціна
              priceUAHDynamic: priceUAHDynamic, // LiqPay динамічна ціна
              exchangeRate: rate, // Поточний курс USD/UAH
              tgStarRate: tgStarRate, // Динамічний курс TG Star до USD
              // Per-plan token price
              tokenPriceUSD: tokenPriceUSDByPlan[planKey],
              features: sub.features  // Показуємо всі features як є
            };
          }
        });

        // ============================================================
        // DESIGN MODELS with debug fields + KIE.AI pricing priority
        // ============================================================
        const designModels = models.design.models
          .filter(m => m.available)
          .map(m => {
            // 🔥 Пріоритет KIE.AI: якщо модель підтримується на KIE, беремо ціну звідти
            let effectiveCost = m.cost;
            let effectiveApiCost = m.apiCost;

            if (kieAI.isKieAIImplemented(m.key)) {
              try {
                const kieCost = kiePricingSync.getKieTokenCostSync(m.key);
                if (typeof kieCost === 'number' && kieCost > 0) {
                  effectiveCost = kieCost;
                  // Отримуємо API cost з KIE (може бути string)
                  const kieApiCost = kiePricingSync.getModelPriceSync(m.key);
                  if (kieApiCost != null) {
                    const parsed = typeof kieApiCost === 'string' ? parseFloat(kieApiCost) : kieApiCost;
                    if (!isNaN(parsed)) effectiveApiCost = parsed;
                  }
                }
              } catch (err) {
                // Fallback to models.js prices
              }
            }

            const result = {
              name: m.name.replace(/[🌀🍌🌊🔮🎯🖼️🎁]/g, '').trim(),
              key: m.key,
              cost: effectiveCost,
              priceUSD: +(effectiveCost * tokenPriceUSD).toFixed(4),
              resolution: m.resolution || m.size || null,
              maxImages: m.maxImages || 1
            };

            // Free model marker
            if (m.freeLimit) {
              result.freeLimit = m.freeLimit;
              result.isFree = true;
              result.provider = 'google-gemini';
            }

            // Debug fields (optional)
            if (effectiveApiCost !== undefined) {
              const usedKie = kieAI.isKieAIImplemented(m.key) && (effectiveCost !== m.cost || m.kieAIOnly);
              result._debug = {
                apiCost: effectiveApiCost,
                grossMarginPct: calcGrossMargin(effectiveCost, effectiveApiCost),
                priceSource: m.googleDirect ? 'google-gemini' : (usedKie ? 'kie-ai' : 'replicate')
              };
            }

            return result;
          });

        // ============================================================
        // VIDEO MODELS with debug fields, durations, minSeconds/maxSeconds
        // ============================================================
        const videoModels = models.video.models
          .filter(m => m.available)
          .map(m => {
            const result = {
              name: m.name.replace(/[🎭🔥🌟🎬🌊💜💎]/g, '').trim(),
              key: m.key
            };

            // Kling - ціна за секунду
            if (m.costPerSecond) {
              result.costPerSecond = m.costPerSecond;
              result.pricePerSecondUSD = +(m.costPerSecond * tokenPriceUSD).toFixed(4);
              result.durations = m.durations || [5, 10];
              result.minSeconds = result.durations[0];
              result.maxSeconds = result.durations[result.durations.length - 1];
              // Debug
              if (m.apiCostPerSecond !== undefined) {
                result._debug = {
                  apiCostPerSecond: m.apiCostPerSecond,
                  grossMarginPct: calcGrossMargin(m.costPerSecond, m.apiCostPerSecond)
                };
              }
            }
            // Kling Motion - різні режими
            else if (m.costs) {
              result.costs = m.costs;
              result.pricesUSD = {};
              Object.entries(m.costs).forEach(([mode, cost]) => {
                result.pricesUSD[mode] = +(cost * tokenPriceUSD).toFixed(2);
              });
              // Debug
              if (m.apiCosts) {
                result._debug = {
                  apiCosts: m.apiCosts,
                  grossMarginsPct: {}
                };
                Object.entries(m.costs).forEach(([mode, cost]) => {
                  const apiCost = m.apiCosts[mode];
                  result._debug.grossMarginsPct[mode] = calcGrossMargin(cost, apiCost);
                });
              }
            }
            // Veo - flat per-video pricing (Fast / Quality)
            else if (m.costFast !== undefined && m.costQuality !== undefined) {
              result.costFast = m.costFast;
              result.costQuality = m.costQuality;
              result.priceFastUSD = +(m.costFast * tokenPriceUSD).toFixed(4);
              result.priceQualityUSD = +(m.costQuality * tokenPriceUSD).toFixed(4);
              // Legacy per-second (backward compat)
              result.costPerSecondAudio = m.costPerSecondAudio;
              result.costPerSecondNoAudio = m.costPerSecondNoAudio;
              result.pricePerSecondAudioUSD = +(m.costPerSecondAudio * tokenPriceUSD).toFixed(4);
              result.pricePerSecondNoAudioUSD = +(m.costPerSecondNoAudio * tokenPriceUSD).toFixed(4);
              result.durations = m.durations || [4, 6, 8];
              result.minSeconds = m.minSeconds || result.durations[0];
              result.maxSeconds = result.durations[result.durations.length - 1];
              result.supportsAudio = true;
              result.pricingModel = 'flat_per_video';
              result._debug = {
                apiCostFast: m.apiCostFast,
                apiCostQuality: m.apiCostQuality,
                grossMarginFastPct: calcGrossMargin(m.costFast, m.apiCostFast / tokenPriceUSD),
                grossMarginQualityPct: calcGrossMargin(m.costQuality, m.apiCostQuality / tokenPriceUSD)
              };
            }
            // Veo legacy - ціна за секунду з/без аудіо
            else if (m.costPerSecondAudio) {
              result.costPerSecondAudio = m.costPerSecondAudio;
              result.costPerSecondNoAudio = m.costPerSecondNoAudio;
              result.pricePerSecondAudioUSD = +(m.costPerSecondAudio * tokenPriceUSD).toFixed(4);
              result.pricePerSecondNoAudioUSD = +(m.costPerSecondNoAudio * tokenPriceUSD).toFixed(4);
              result.durations = m.durations || [4, 6, 8];
              result.minSeconds = m.minSeconds || result.durations[0];
              result.maxSeconds = result.durations[result.durations.length - 1];
              result.supportsAudio = true;
              // Debug
              if (m.apiCostPerSecondAudio !== undefined) {
                result._debug = {
                  apiCostPerSecondAudio: m.apiCostPerSecondAudio,
                  apiCostPerSecondNoAudio: m.apiCostPerSecondNoAudio,
                  grossMarginAudioPct: calcGrossMargin(m.costPerSecondAudio, m.apiCostPerSecondAudio),
                  grossMarginNoAudioPct: calcGrossMargin(m.costPerSecondNoAudio, m.apiCostPerSecondNoAudio)
                };
              }
            }
            // Звичайна модель (фіксована ціна)
            else {
              result.cost = m.cost;
              result.priceUSD = +(m.cost * tokenPriceUSD).toFixed(4);
              // Debug
              if (m.apiCost !== undefined) {
                result._debug = {
                  apiCost: m.apiCost,
                  grossMarginPct: calcGrossMargin(m.cost, m.apiCost)
                };
              }
            }
            return result;
          });

        const totalTime = Date.now() - startTime;
        console.log(`📊 /api/plans response time: ${totalTime}ms (rate fetch: ${fetchTime}ms)`);

        // ============================================================
        // TRIAL PLAN with explicit usage (snake_case keys matching model keys)
        // ============================================================
        const trialTokens = TRIAL_TOKENS;

        // Helper: safe division avoiding 0
        const safeDiv = (tokens, cost) => cost > 0 ? Math.floor(tokens / cost) : 0;

        // Helpers: fetch model config from models.js (single source of truth)
        const getDesignCost = (key, fallback = 0) =>
          models.design.models.find(m => m.key === key)?.cost ?? fallback;
        const getVideoModel = (key) => models.video.models.find(m => m.key === key);
        const getKlingCost = (key, seconds, fallbackPerSec = 6) => {
          const m = getVideoModel(key);
          const perSec = m?.costPerSecond ?? fallbackPerSec;
          return seconds * perSec;
        };
        const getRunwayTurboCost = () => {
          const m = getVideoModel('runway_turbo');
          const durations = m?.durations?.length ? m.durations : [5];
          const minDuration = Math.min(...durations);
          const perSec = m?.costPerSecond ?? (m?.cost ? m.cost / minDuration : 22 / 5);
          return minDuration * perSec;
        };
        const getVeoMinCost = () => {
          const m = getVideoModel('veo');
          const minDuration = m?.minSeconds || (m?.durations?.length ? Math.min(...m.durations) : 4);
          const perSec = m?.costPerSecondAudio ?? m?.costPerSecondNoAudio ?? 28;
          return minDuration * perSec;
        };
        const getKlingMotionMinCost = () => {
          const m = getVideoModel('kling_motion');
          if (!m) return 35;
          if (m.cost) return m.cost;
          if (m.costs) return Math.min(...Object.values(m.costs));
          return 35;
        };

        const blockedModelsDynamic = buildDynamicTrialBlockedModels(trialTokens);
        const isBlockedModel = (key) => blockedModelsDynamic.has(key);
        const blockedModes = models.TRIAL_RESTRICTIONS.blockedModes || {};

        const buildUsageEntry = (key, cost, { blocked = false } = {}) => {
          if (!cost || cost > trialTokens || blocked) return null;
          const entry = {
            count: safeDiv(trialTokens, cost),
            cost: cost
          };
          return entry;
        };

        // Build usage from models.js (single source of truth)
        const trialUsage = {};

        // Design models (available only) — use KIE prices when available
        models.design.models
          .filter(m => m.available)
          .forEach((m) => {
            // Nano Banana FREE — показуємо окремо з freeLimit
            if (m.key === 'nano_banana_free') {
              trialUsage[m.key] = {
                count: m.freeLimit || geminiImage.FREE_GENERATIONS_LIMIT,
                cost: 0,
                isFree: true,
                freeLimit: m.freeLimit || geminiImage.FREE_GENERATIONS_LIMIT
              };
              return;
            }
            const blocked = isBlockedModel(m.key);
            // КIE пріоритет: якщо модель підтримується на KIE — використати KIE ціну
            let cost = m.cost || 0;
            if (kieAI.isKieAIImplemented(m.key)) {
              try {
                const kieCost = kiePricingSync.getKieTokenCostSync(m.key);
                if (typeof kieCost === 'number' && kieCost > 0) cost = kieCost;
              } catch (e) { /* fallback */ }
            }
            const entry = buildUsageEntry(m.key, cost, { blocked });
            if (entry) trialUsage[m.key] = entry;
          });

        // Video models (available OR explicitly blocked)
        const allowedVideoKeys = new Set([
          ...models.video.models.filter(m => m.available).map(m => m.key),
          ...blockedModelsDynamic
        ]);

        models.video.models
          .filter(m => allowedVideoKeys.has(m.key))
          .forEach((m) => {
            // Kling variants (duration-specific keys)
            if (m.key.startsWith('kling') && m.costPerSecond && Array.isArray(m.durations)) {
              m.durations.forEach((duration) => {
                const cost = duration * (m.costPerSecond || 0);
                const modeBlocked = blockedModes[m.key]?.durations?.includes(duration) || false;
                const blocked = isBlockedModel(m.key) || modeBlocked;
                const key = `${m.key}_${duration}s`;
                const entry = buildUsageEntry(key, cost, { blocked });
                if (entry) trialUsage[key] = entry;
              });
              return;
            }

            // Runway Turbo (single entry with min duration)
            if (m.key === 'runway_turbo') {
              const durations = m.durations || [5];
              const minDuration = Math.min(...durations);
              const perSec = m.costPerSecond ?? (m.cost ? m.cost / minDuration : 0);
              const cost = minDuration * perSec;
              const blocked = isBlockedModel(m.key);
              const entry = buildUsageEntry(m.key, cost, { blocked });
              if (entry) trialUsage[m.key] = entry;
              return;
            }

            // Veo (use min duration with audio pricing by default)
            if (m.key === 'veo') {
              const minDuration = m.minSeconds || (m.durations?.length ? Math.min(...m.durations) : 4);
              const perSec = m.costPerSecondAudio ?? m.costPerSecondNoAudio ?? 0;
              const cost = minDuration * perSec;
              const blocked = isBlockedModel(m.key);
              const entry = buildUsageEntry(m.key, cost, { blocked });
              if (entry) trialUsage[m.key] = entry;
              return;
            }

            // Kling Motion (min cost)
            if (m.key === 'kling_motion') {
              const minCost = m.cost ?? (m.costs ? Math.min(...Object.values(m.costs)) : 0);
              const blocked = isBlockedModel(m.key);
              const entry = buildUsageEntry(m.key, minCost, { blocked });
              if (entry) trialUsage[m.key] = entry;
              return;
            }

            // Default fixed-cost models
            if (m.cost) {
              const blocked = isBlockedModel(m.key);
              const entry = buildUsageEntry(m.key, m.cost, { blocked });
              if (entry) trialUsage[m.key] = entry;
            }
          });

        const trialPlan = {
          name: 'TRIAL (FREE)',
          tokens: trialTokens,
          price: 0,
          priceUSD: 0,
          // Explicit usage keyed by model.key (snake_case)
          usage: trialUsage,
          features: [
            `🎁 ${trialTokens}⚡ безкоштовних токенів`,
            '🔒 Обмежений доступ до дорогих моделей',
            '⏱️ Ліміти на кількість генерацій'
          ]
        };

        // Trial restrictions для фронтенду
        const trialRestrictions = {
          blockedModels: Array.from(blockedModelsDynamic),
          blockedModes: models.TRIAL_RESTRICTIONS.blockedModes
        };

        res.json({
          success: true,
          plans: {
            trial: trialPlan,
            ...plans
          },
          // Models for comparison tables
          models: {
            // Default token price (premium-anchored, worst-case for us)
            tokenPriceUSD: tokenPriceUSD,
            // Per-plan token prices for accurate UI calculations
            tokenPriceUSDByPlan: tokenPriceUSDByPlan,
            design: designModels,
            video: videoModels
          },
          // Trial/FREE restrictions
          trialRestrictions,
          rates: {
            'USD/UAH': rate,
            'USD/TGStar': +tgStarRate.toFixed(4) // ✅ number, not string
          },
          responseTime: totalTime,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error fetching plans:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Get current USD/UAH exchange rate
    app.get('/api/exchange-rate', async (req, res) => {
      try {
        const rate = await exchangeRate.getRate();
        res.json({
          success: true,
          rate: rate,
          pair: 'USD/UAH',
          source: exchangeRate.getSource(),
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error getting exchange rate:', error);
        res.status(500).json({
          success: false,
          error: error.message,
          fallbackRate: 45
        });
      }
    });

    // ✅ Get all models with prices (for comparison tables, webpack site, etc.)
    app.get('/api/models', async (req, res) => {
      try {
        const subscriptions = models.subscriptions;

        // ============================================================
        // TOKEN PRICE CALCULATION PER PLAN
        // Formula: tokenPriceUSD = priceUSD / tokensWayForPay
        // ============================================================
        const tokenPriceUSDByPlan = {
          starter: subscriptions.starter ? +(subscriptions.starter.priceUSD / subscriptions.starter.tokensWayForPay).toFixed(5) : 0,
          basic: subscriptions.basic ? +(subscriptions.basic.priceUSD / subscriptions.basic.tokensWayForPay).toFixed(5) : 0,
          pro: subscriptions.pro ? +(subscriptions.pro.priceUSD / subscriptions.pro.tokensWayForPay).toFixed(5) : 0,
          premium: subscriptions.premium ? +(subscriptions.premium.priceUSD / subscriptions.premium.tokensWayForPay).toFixed(5) : 0
        };

        // Default = premium (worst-case for us, best for customer)
        const tokenPriceUSD = tokenPriceUSDByPlan.premium || 0.01930; // 110/5700 = 0.01930

        // Helper: calculate gross margin
        const calcGrossMargin = (cost, apiCost) => {
          if (!apiCost || apiCost === 0) return null;
          const revenue = cost * tokenPriceUSD;
          const margin = ((revenue - apiCost) / revenue) * 100;
          return +margin.toFixed(1);
        };

        const blockedModelsDynamic = buildDynamicTrialBlockedModels(TRIAL_TOKENS);

        res.json({
          success: true,

          // Pricing info
          pricing: {
            tokenPriceUSD: tokenPriceUSD,
            tokenPriceUSDByPlan: tokenPriceUSDByPlan,
            formula: 'priceUSD = cost × tokenPriceUSD',
            note: 'tokenPriceUSD anchored to PREMIUM plan ($110/5700⚡). Smaller plans have higher token cost.'
          },

          // Subscription packages
          subscriptions: Object.entries(models.subscriptions)
            .filter(([key]) => key !== 'trial')
            .reduce((acc, [key, sub]) => {
              acc[key] = {
                name: sub.name,
                tokens: sub.tokens,
                tokensWayForPay: sub.tokensWayForPay,
                price: sub.price,
                priceUSD: sub.priceUSD,
                tokenPriceUSD: tokenPriceUSDByPlan[key]
              };
              return acc;
            }, {}),

          // Design models with debug
          design: models.design.models
            .filter(m => m.available)
            .map(m => {
              const trialAvailable = !blockedModelsDynamic.has(m.key);
              const result = {
                name: m.name.replace(/[🌀🍌🌊🔮🎯🖼️]/g, '').trim(),
                key: m.key,
                cost: m.cost,
                priceUSD: +(m.cost * tokenPriceUSD).toFixed(4),
                resolution: m.resolution || m.size || null,
                maxImages: m.maxImages || 1,
                trial: {
                  available: trialAvailable,
                  minCostTokens: m.cost
                }
              };
              if (m.apiCost !== undefined) {
                result._debug = {
                  apiCost: m.apiCost,
                  grossMarginPct: calcGrossMargin(m.cost, m.apiCost)
                };
              }
              return result;
            }),

          // Video models with debug, durations, minSeconds/maxSeconds
          video: models.video.models
            .filter(m => m.available)
            .map(m => {
              const trialAvailable = !blockedModelsDynamic.has(m.key);
              const result = {
                name: m.name.replace(/[🎭🔥🌟🎬🌊💜💎]/g, '').trim(),
                key: m.key
              };

              // Kling - cost per second
              if (m.costPerSecond) {
                const durations = m.durations || [5, 10];
                const minSeconds = durations[0];
                const minCostTokens = minSeconds * m.costPerSecond;
                result.costPerSecond = m.costPerSecond;
                result.pricePerSecondUSD = +(m.costPerSecond * tokenPriceUSD).toFixed(4);
                result.durations = durations;
                result.minSeconds = minSeconds;
                result.maxSeconds = durations[durations.length - 1];
                result.examples = durations.map(d => ({
                  duration: d,
                  cost: d * m.costPerSecond,
                  priceUSD: +(d * m.costPerSecond * tokenPriceUSD).toFixed(2)
                }));
                result.trial = {
                  available: trialAvailable,
                  minCostTokens,
                  minSeconds
                };
                if (m.apiCostPerSecond !== undefined) {
                  result._debug = {
                    apiCostPerSecond: m.apiCostPerSecond,
                    grossMarginPct: calcGrossMargin(m.costPerSecond, m.apiCostPerSecond)
                  };
                }
              }
              // Kling Motion - multiple modes
              else if (m.costs) {
                const minCostTokens = Math.min(...Object.values(m.costs));
                result.costs = m.costs;
                result.pricesUSD = {};
                Object.entries(m.costs).forEach(([mode, cost]) => {
                  result.pricesUSD[mode] = +(cost * tokenPriceUSD).toFixed(2);
                });
                result.trial = {
                  available: trialAvailable,
                  minCostTokens
                };
                if (m.apiCosts) {
                  result._debug = {
                    apiCosts: m.apiCosts,
                    grossMarginsPct: {}
                  };
                  Object.entries(m.costs).forEach(([mode, cost]) => {
                    result._debug.grossMarginsPct[mode] = calcGrossMargin(cost, m.apiCosts[mode]);
                  });
                }
              }
              // Veo - flat per-video pricing (Fast / Quality)
              else if (m.costFast !== undefined && m.costQuality !== undefined) {
                const durations = m.durations || [4, 6, 8];
                const minSeconds = m.minSeconds || durations[0];
                result.costFast = m.costFast;
                result.costQuality = m.costQuality;
                result.priceFastUSD = +(m.costFast * tokenPriceUSD).toFixed(4);
                result.priceQualityUSD = +(m.costQuality * tokenPriceUSD).toFixed(4);
                result.costPerSecondAudio = m.costPerSecondAudio;
                result.costPerSecondNoAudio = m.costPerSecondNoAudio;
                result.pricePerSecondAudioUSD = +(m.costPerSecondAudio * tokenPriceUSD).toFixed(4);
                result.pricePerSecondNoAudioUSD = +(m.costPerSecondNoAudio * tokenPriceUSD).toFixed(4);
                result.durations = durations;
                result.minSeconds = minSeconds;
                result.maxSeconds = durations[durations.length - 1];
                result.supportsAudio = true;
                result.pricingModel = 'flat_per_video';
                result.trial = {
                  available: trialAvailable,
                  minCostTokens: m.costFast
                };
                result._debug = {
                  apiCostFast: m.apiCostFast,
                  apiCostQuality: m.apiCostQuality,
                  grossMarginFastPct: calcGrossMargin(m.costFast, m.apiCostFast / tokenPriceUSD),
                  grossMarginQualityPct: calcGrossMargin(m.costQuality, m.apiCostQuality / tokenPriceUSD)
                };
              }
              // Veo legacy - cost per second with/without audio
              else if (m.costPerSecondAudio) {
                const durations = m.durations || [4, 6, 8];
                const minSeconds = m.minSeconds || durations[0];
                const perSecMin = Math.min(
                  m.costPerSecondNoAudio ?? Number.POSITIVE_INFINITY,
                  m.costPerSecondAudio ?? Number.POSITIVE_INFINITY
                );
                const minCostTokens = Number.isFinite(perSecMin) ? minSeconds * perSecMin : null;
                result.costPerSecondAudio = m.costPerSecondAudio;
                result.costPerSecondNoAudio = m.costPerSecondNoAudio;
                result.pricePerSecondAudioUSD = +(m.costPerSecondAudio * tokenPriceUSD).toFixed(4);
                result.pricePerSecondNoAudioUSD = +(m.costPerSecondNoAudio * tokenPriceUSD).toFixed(4);
                result.durations = durations;
                result.minSeconds = minSeconds;
                result.maxSeconds = durations[durations.length - 1];
                result.supportsAudio = true;
                result.examples = durations.map(d => ({
                  duration: d,
                  withAudio: {
                    cost: d * m.costPerSecondAudio,
                    priceUSD: +(d * m.costPerSecondAudio * tokenPriceUSD).toFixed(2)
                  },
                  withoutAudio: {
                    cost: d * m.costPerSecondNoAudio,
                    priceUSD: +(d * m.costPerSecondNoAudio * tokenPriceUSD).toFixed(2)
                  }
                }));
                result.trial = {
                  available: trialAvailable,
                  minCostTokens,
                  minSeconds
                };
                if (m.apiCostPerSecondAudio !== undefined) {
                  result._debug = {
                    apiCostPerSecondAudio: m.apiCostPerSecondAudio,
                    apiCostPerSecondNoAudio: m.apiCostPerSecondNoAudio,
                    grossMarginAudioPct: calcGrossMargin(m.costPerSecondAudio, m.apiCostPerSecondAudio),
                    grossMarginNoAudioPct: calcGrossMargin(m.costPerSecondNoAudio, m.apiCostPerSecondNoAudio)
                  };
                }
              }
              // Standard model (fixed price)
              else {
                result.cost = m.cost;
                result.priceUSD = +(m.cost * tokenPriceUSD).toFixed(4);
                result.trial = {
                  available: trialAvailable,
                  minCostTokens: m.cost
                };
                if (m.apiCost !== undefined) {
                  result._debug = {
                    apiCost: m.apiCost,
                    grossMarginPct: calcGrossMargin(m.cost, m.apiCost)
                  };
                }
              }

              return result;
            }),

          // Trial/FREE restrictions
          trialRestrictions: {
            freeTokens: TRIAL_TOKENS,
            blockedModels: Array.from(blockedModelsDynamic),
            blockedModes: models.TRIAL_RESTRICTIONS.blockedModes,
            description: 'Free users have limited access to expensive models'
          },

          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error getting models:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    const botUsername = process.env.BOT_USERNAME || 'neuro_lab_ai_bot';
    const botRedirectUrl = `https://t.me/${botUsername}`;

    app.all('/payment/success', (req, res) => {
      console.log(`✅ Payment success redirect via ${req.method}`);
      res.redirect(botRedirectUrl);
    });

    // ✅ Payment failed page (for declined WayForPay payments)
    app.all('/payment/failed', (req, res) => {
      console.log(`❌ Payment failed redirect via ${req.method}`);
      res.redirect(botRedirectUrl);
    });

    // ✅ Payment cancel page
    app.get('/payment/cancel', (req, res) => {
      const sessionId = req.query.session_id;
      console.log(`❌ Payment cancelled for session: ${sessionId}`);
      res.redirect(botRedirectUrl);
    });

    // ✅ Legal pages - Terms of Service
    app.get('/bot/terms', (req, res) => {
      const filePath = __dirname + '/public/terms.html';
      res.sendFile(filePath);
    });

    // ✅ Legal pages - Privacy Policy
    app.get('/bot/privacy', (req, res) => {
      const filePath = __dirname + '/public/privacy.html';
      res.sendFile(filePath);
    });

    // ✅ Company Information
    app.get('/bot/info', (req, res) => {
      const filePath = __dirname + '/public/info.html';
      res.sendFile(filePath);
    });

    // ✅ Static files (CSS, JS, images, etc.)
    app.use(express.static(__dirname + '/public'));

    // ✅ Catch-all 404
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // ==================== ERROR HANDLING ====================
    app.use((err, req, res, next) => {
      console.error('Express error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    // ==================== START SERVER ====================
    const server = app.listen(PORT, () => {
      console.log(`🌍 Express server running on port ${PORT}`);
      console.log(`📝 Stripe webhook: POST http://127.0.0.1:${PORT}/webhook/stripe`);
      console.log(`🛒 Checkout API: POST http://127.0.0.1:${PORT}/api/stripe/checkout`);
      console.log(`💳 LiqPay webhook: POST http://127.0.0.1:${PORT}/webhook/liqpay`);
      console.log(`💳 LiqPay checkout: GET http://127.0.0.1:${PORT}/pay/liqpay?plan=starter`);
      console.log(`💳 WayForPay webhook: POST http://127.0.0.1:${PORT}/webhook/wayforpay`);
      console.log(`💳 WayForPay checkout: GET http://127.0.0.1:${PORT}/pay/wayforpay?plan=starter`);
      console.log(`💱 Exchange Rate API: GET http://127.0.0.1:${PORT}/api/exchange-rate`);
      console.log(`📊 Plans API: GET http://127.0.0.1:${PORT}/api/plans`);
      console.log(`📈 Admin Dashboard: GET http://127.0.0.1:${PORT}/admin/dashboard?token=YOUR_TOKEN`);
    });

    // ==================== START BOT ====================
    await bot.launch();

    process.once('SIGINT', async () => {
      console.log('\n🛑 Stopping bot...');
      await db.disconnect();
      bot.stop('SIGINT');
    });

    process.once('SIGTERM', async () => {
      console.log('\n🛑 Stopping bot...');
      await db.disconnect();
      bot.stop('SIGTERM');
    });
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

startBot();

bot.catch((err, ctx) => {
  if (err.name === 'TimeoutError') {
    ctx.reply('⏱️ Генерація триває. Чекайте...');
    return;
  }

  console.error('Bot error:', err);
  ctx.reply(`❌ Сталася помилка. Спробуйте ще раз або зверніться до підтримки. ${SUPPORT_USERNAME}`);
});
