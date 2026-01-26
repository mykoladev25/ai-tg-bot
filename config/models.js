/**
 * Target gross margin (Revenue - API COGS): ~15%
 * Revenue = apiCost / 0.85
 *
 * Token-based pricing anchored to WORST-CASE token value (cheapest token):
 * WORST_CASE_TOKEN_USD = $110 / 4760
 *
 * Tokens per unit:
 * tokens = ceil(apiCost / (0.85 * WORST_CASE_TOKEN_USD))
 */

const WORST_CASE_TOKEN_USD = 110 / 4760; // 0.02311...
const TARGET_GROSS = 0.15;
const EFFECTIVE_TOKEN_USD = (1 - TARGET_GROSS) * WORST_CASE_TOKEN_USD; // 0.85 * token
const LIQPAY_OVERHEAD = 0.07;
const LIQPAY_FACTOR = 1 - LIQPAY_OVERHEAD;
/**
 * TRIAL RESTRICTIONS
 */
const TRIAL_RESTRICTIONS = {
  blockedModels: ['veo', 'kling_motion', 'runway_gen4'],

  blockedModes: {
    kling: { durations: [10] },
    kling_v2_6: { durations: [10] }
  },

  limitedModels: {
    seedream_4k: 3,
    nano_banana_2k: 3,
    nano_banana_4k: 3,
    kling: 2,
    kling_v2_6: 2,
    runway_turbo: 1
  },

  messages: {
    blocked:
      '🔒 Ця модель доступна тільки для платних користувачів.\n\n💡 Поповніть баланс щоб отримати доступ до всіх можливостей!',
    limited: (remaining) =>
      `⚠️ На Trial залишилось ${remaining} безкоштовних генерацій цієї моделі.\n\n💡 Поповніть баланс для необмеженого доступу!`,
    durationBlocked:
      '🔒 Тривалість 10+ секунд доступна тільки для платних користувачів.\n\n💡 На Trial доступно тільки 5 секунд.'
  }
};

module.exports = {
  TRIAL_RESTRICTIONS,

  gpt: {
    models: [
      { name: '🧠 Базові помічники', key: 'gpt_claude', cost: 0, apiCost: 0 },
      { name: '👨‍💼 Активувати GPT Editor', key: 'gpt_editor', cost: 0, apiCost: 0 },
      { name: '🤖 Керування', key: 'gpt_manage', cost: 0, apiCost: 0 },
      { name: '💬 Нова розмова', key: 'new_chat', cost: 0, apiCost: 0 },
      { name: '👤 Профіль', key: 'profile', cost: 0, apiCost: 0 },
      { name: '📄 Інструкція', key: 'instruction', cost: 0, apiCost: 0 }
    ],
    actions: [
      { name: '🎙️ Говоріть', key: 'voice', cost: 0, apiCost: 0 },

      // apiCost 0.008 => ceil(0.008 / EFFECTIVE_TOKEN_USD) = 1
      { name: '✍️ Пишіть', key: 'text', cost: 1, apiCost: 0.008 },

      // apiCost 0.048 => ceil(0.048 / EFFECTIVE_TOKEN_USD) = 3
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 3, apiCost: 0.048 }
    ]
  },

  video: {
    models: [
      /**
       * Runway Turbo
       * apiCostPerSecond 0.05 => ceil(0.05 / EFFECTIVE_TOKEN_USD) = 3 ток/сек
       * default 5s => 15 ток
       */
      {
        name: '🎬 RunWay: Gen-4 Turbo ⚡',
        key: 'runway_turbo',
        costPerSecond: 3,
        apiCostPerSecond: 0.05,
        cost: 15,     // 5 sec * 3
        apiCost: 0.25,
        available: true,
        requiresImage: true,
        durations: [5, 10],
        aspectRatios: ['16:9', '9:16']
      },

      /**
       * Kling v2.5
       * apiCostPerSecond 0.07 => ceil(...) = 4 ток/сек
       * default 5s => 20 ток
       */
      {
        name: '🎭 Kling v2.5 Turbo',
        key: 'kling',
        costPerSecond: 4,
        cost: 20,
        apiCostPerSecond: 0.07,
        available: true,
        requiresImage: false,
        durations: [5, 10],
        supportsEndImage: true
      },

      /**
       * Kling v2.6
       * no audio: 0.07 => 4 ток/сек
       * audio:    0.14 => 8 ток/сек
       */
      {
        name: '🎭 Kling v2.6',
        key: 'kling_v2_6',
        costPerSecond: 4,
        costPerSecondAudio: 8,
        cost: 20, // default 5s no-audio
        apiCostPerSecond: 0.07,
        apiCostPerSecondAudio: 0.14,
        audioParam: 'generate_audio',
        available: true,
        requiresImage: false,
        durations: [5, 10],
        supportsEndImage: false
      },

      /**
       * Kling Motion Control
       * std_image 0.50 => 26 ток
       * std_video 1.00 => 51 ток
       * pro_video 2.00 => 102 ток
       */
      {
        name: '🔥 Kling Motion Control',
        key: 'kling_motion',
        costs: {
          std_image: 26,
          std_video: 51,
          pro_image: 51,
          pro_video: 102
        },
        apiCosts: {
          std_image: 0.50,
          std_video: 1.00,
          pro_image: 1.00,
          pro_video: 2.00
        },
        cost: 26,
        maxCost: 102,
        available: true,
        requiresImage: true,
        requiresVideo: true
      },

      /**
       * Veo 3.1
       * audio 0.40 => 21 ток/сек
       * noAudio 0.20 => 11 ток/сек
       * default 8s audio => 168 ток
       */
      {
        name: '🌟 Google Veo 3.1 💎',
        key: 'veo',
        costPerSecondAudio: 21,
        costPerSecondNoAudio: 11,
        minSeconds: 4,
        durations: [4, 8, 12],
        cost: 168,
        apiCostPerSecondAudio: 0.40,
        apiCostPerSecondNoAudio: 0.20,
        available: true,
        requiresImage: false,
        supportsReferences: true
      },

      {
        name: '🎬 RunWay: Gen-4 Aleph 💎',
        key: 'runway_gen4',
        cost: 0, // disabled anyway
        apiCost: 0.9,
        available: false,
        requiresImage: true
      },
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 15, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 12, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      /**
       * 15% gross everywhere
       */
      // 0.065 => ceil(...) = 4
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 4, apiCost: 0.065, available: true },

      // 0.15 => ceil(...) = 8
      {
        name: '🍌 Nano Banana PRO 2K',
        key: 'nano_banana_2k',
        cost: 8,
        apiCost: 0.15,
        resolution: '2K',
        maxImages: 14,
        available: true
      },

      // 0.30 => ceil(...) = 16
      {
        name: '🍌🍌 Nano Banana PRO 4K',
        key: 'nano_banana_4k',
        cost: 16,
        apiCost: 0.30,
        resolution: '4K',
        maxImages: 14,
        available: true
      },

      // 0.04 => ceil(...) = 3
      { name: '🌊 Seedream 2K', key: 'seedream_2k', cost: 3, apiCost: 0.04, size: '2K', maxImages: 14, available: true },

      // 0.04 => ceil(...) = 3  (якщо реально apiCost інший для 4K — тоді перерахую)
      { name: '🌊 Seedream 4.5 4K', key: 'seedream_4k', cost: 3, apiCost: 0.04, size: '4K', maxImages: 14, available: true },

      // 0.02 => 2
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 2, apiCost: 0.02, maxImages: 1, available: true },

      // 0.03 => 2
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 2, apiCost: 0.03, maxImages: 1, available: true },

      { name: '🖼️ MidJourney', key: 'midjourney', cost: 3, apiCost: 0, available: false }
    ]
  },

  audio: {
    models: [
      { name: '🎵 Suno AI Bark', key: 'suno', cost: 2, apiCost: 0.0023, available: false },
      { name: '🎼 Udio AI', key: 'udio', cost: 6, apiCost: 0, available: false },
      { name: '🎤 ElevenLabs', key: 'elevenlabs', cost: 4, apiCost: 0.03, available: false }
    ]
  },

  subscriptions: {
    trial: { name: 'TRIAL', tokens: 75, price: 0, features: ['🎁 75⚡ безкоштовних токенів', '✨ Спробуйте всі моделі', '⚡ Токени НЕ згорають!'] },
    starter: { name: 'STARTER', tokens: 186, tokensLiqPay: Math.floor(260 * LIQPAY_FACTOR), price: 299, priceUSD: 7, features: ['🚀 186⚡ токенів (Telegram Stars)', '🚀 260⚡ токенів (LiqPay)', '💎 Доступ до всіх моделей', '⏰ Токени НЕ згорають', '✨ Комбінуйте як завгодно!', '📉 Чим більший план — тим дешевший ⚡'] },
    basic: { name: 'BASIC', tokens: 620, tokensLiqPay: Math.floor(870 * LIQPAY_FACTOR), price: 899, priceUSD: 20, features: ['💎 620⚡ токенів (Telegram Stars)', '💎 870⚡ токенів (LiqPay)', '🎨 Для активних користувачів', '⏰ Токени НЕ згорають', '✨ Комбінуйте як завгодно!', '📉 Чим більший план — тим дешевший ⚡'] },
    pro: { name: 'PRO', tokens: 1500, tokensLiqPay: Math.floor(2100 * LIQPAY_FACTOR), price: 1999, priceUSD: 45, features: ['🔥 1500⚡ токенів (Telegram Stars)', '🔥 2100⚡ токенів (LiqPay)', '🚀 Для професіоналів', '⏰ Токени НЕ згорають', '⚡ Найкраще співвідношення', '📉 Чим більший план — тим дешевший ⚡'] },
    premium: { name: 'PREMIUM', tokens: 4080, tokensLiqPay: Math.floor(5700 * LIQPAY_FACTOR), price: 4999, priceUSD: 110, features: ['👑 4080⚡ токенів (Telegram Stars)', '👑 5700⚡ токенів (LiqPay)', '💫 Максимум можливостей', '⏰ Токени НЕ згорають', '👑 VIP підтримка 24/7', '📉 Найнижча ціна за ⚡'] }
  },

  _pricingAssumptions: {
    worstCaseTokenUSD: WORST_CASE_TOKEN_USD,
    targetGross: '≈15%',
    pricingRule: 'tokens = ceil(apiCost / (0.85 * worstCaseTokenUSD))'
  }
};
