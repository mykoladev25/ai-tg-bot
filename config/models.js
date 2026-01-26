/**
 * $-ціни нижче рахуються так:
 * 1 токен = WORST_CASE_TOKEN_USD = 110 / 4760 ≈ $0.02311
 * USD_for_user = costTokens * WORST_CASE_TOKEN_USD
 */

const WORST_CASE_TOKEN_USD = 110 / 4760; // ≈ 0.02311...

// Target: 30% profit AFTER fees (payment + tax)
const TARGET_PROFIT_AFTER_FEES = 0.30;

// WayForPay 2% + FOP 5% = 7%
const WAYFORPAY_OVERHEAD = 0.07;

// Net revenue factor after overhead
const NET_REVENUE_FACTOR = 1 - WAYFORPAY_OVERHEAD; // 0.93

// API budget factor to keep 30% profit after fees
const API_BUDGET_FACTOR = 1 - TARGET_PROFIT_AFTER_FEES; // 0.70

// Effective USD per token available for API costs
const EFFECTIVE_TOKEN_USD = WORST_CASE_TOKEN_USD * NET_REVENUE_FACTOR * API_BUDGET_FACTOR;

const TRIAL_RESTRICTIONS = {
  blockedModels: ['veo', 'kling_motion', 'runway_gen4'],
  blockedModes: { kling: { durations: [10] }, kling_v2_6: { durations: [10] } },
  messages: {
    blocked: '🔒 Ця модель доступна тільки для платних користувачів.\n\n💡 Поповніть баланс щоб отримати доступ до всіх можливостей!',
    limited: (remaining) => `⚠️ На Trial залишилось ${remaining} безкоштовних генерацій цієї моделі.\n\n💡 Поповніть баланс для необмеженого доступу!`,
    durationBlocked: '🔒 Тривалість 10+ секунд доступна тільки для платних користувачів.\n\n💡 На Trial доступно тільки 5 секунд.'
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

      // cost=1 токен ≈ $0.023 (для юзера, worst-case). Ти платиш API: $0.008
      { name: '✍️ Пишіть', key: 'text', cost: 1, apiCost: 0.008 },

      // cost=3 токени ≈ $0.069 (worst-case). Ти платиш API: $0.048
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 3, apiCost: 0.048 }
    ]
  },

  video: {
    models: [
      /**
       * Runway Turbo
       * costPerSecond=4 ток/сек ≈ $0.092/сек (worst-case). Ти платиш API: $0.050/сек
       * cost=20 ток (5 сек) ≈ $0.462 за 5с. Ти платиш API: $0.25 за 5с
       */
      {
        name: '🎬 RunWay: Gen-4 Turbo ⚡',
        key: 'runway_turbo',
        costPerSecond: 4,
        apiCostPerSecond: 0.05,
        cost: 20,
        apiCost: 0.25,
        available: true,
        requiresImage: true,
        durations: [5, 10],
        aspectRatios: ['16:9', '9:16']
      },

      /**
       * Kling v2.5
       * costPerSecond=5 ток/сек ≈ $0.116/сек. API: $0.070/сек
       * cost=25 ток (5 сек) ≈ $0.578 за 5с. API: $0.35 за 5с
       */
      {
        name: '🎭 Kling v2.5 Turbo',
        key: 'kling',
        costPerSecond: 5,
        cost: 25,
        apiCostPerSecond: 0.07,
        available: true,
        requiresImage: false,
        durations: [5, 10],
        supportsEndImage: true
      },

      /**
       * Kling v2.6
       * no-audio: costPerSecond=5 ток/сек ≈ $0.116/сек. API: $0.070/сек
       * audio:    costPerSecondAudio=9 ток/сек ≈ $0.208/сек. API: $0.140/сек
       * 5 сек audio: 45 ток ≈ $1.040 за 5с. API: $0.70 за 5с
       */
      {
        name: '🎭 Kling v2.6',
        key: 'kling_v2_6',
        costPerSecond: 5,
        costPerSecondAudio: 9,
        cost: 25,
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
       * std_image: 31 ток ≈ $0.716. API: $0.50
       * std_video: 62 ток ≈ $1.433. API: $1.00
       * pro_video: 124 ток ≈ $2.866. API: $2.00
       */
      {
        name: '🔥 Kling Motion Control',
        key: 'kling_motion',
        costs: { std_image: 31, std_video: 62, pro_image: 62, pro_video: 124 },
        apiCosts: { std_image: 0.50, std_video: 1.00, pro_image: 1.00, pro_video: 2.00 },
        cost: 31,
        maxCost: 124,
        available: true,
        requiresImage: true,
        requiresVideo: true
      },

      /**
       * Veo 3.1
       * audio: costPerSecondAudio=25 ток/сек ≈ $0.578/сек. API: $0.40/сек
       * no-audio: costPerSecondNoAudio=13 ток/сек ≈ $0.300/сек. API: $0.20/сек
       * default 8 сек audio: 200 ток ≈ $4.622. API: $3.20
       */
      {
        name: '🌟 Google Veo 3.1 💎',
        key: 'veo',
        costPerSecondAudio: 25,
        costPerSecondNoAudio: 13,
        minSeconds: 4,
        durations: [4, 8, 12],
        cost: 200,
        apiCostPerSecondAudio: 0.40,
        apiCostPerSecondNoAudio: 0.20,
        available: true,
        requiresImage: false,
        supportsReferences: true
      },

      { name: '🎬 RunWay: Gen-4 Aleph 💎', key: 'runway_gen4', cost: 0, apiCost: 0.9, available: false, requiresImage: true },
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 15, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 12, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      /**
       * Design (30% gross target)
       */

      // cost=5 ток ≈ $0.116. API: $0.065
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 5, apiCost: 0.065, available: true },

      // cost=10 ток ≈ $0.231. API: $0.150
      {
        name: '🍌 Nano Banana PRO 2K',
        key: 'nano_banana_2k',
        cost: 10,
        apiCost: 0.15,
        resolution: '2K',
        maxImages: 14,
        available: true
      },

      // cost=19 ток ≈ $0.439. API: $0.300
      {
        name: '🍌🍌 Nano Banana PRO 4K',
        key: 'nano_banana_4k',
        cost: 19,
        apiCost: 0.30,
        resolution: '4K',
        maxImages: 14,
        available: true
      },

      // cost=3 ток ≈ $0.069. API: $0.040
      { name: '🌊 Seedream 2K', key: 'seedream_2k', cost: 3, apiCost: 0.04, size: '2K', maxImages: 14, available: true },

      // cost=5 ток ≈ $0.116. API: $0.080
      { name: '🌊 Seedream 4.5 4K', key: 'seedream_4k', cost: 5, apiCost: 0.08, size: '4K', maxImages: 14, available: true },

      // cost=2 ток ≈ $0.046. API: $0.020
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 2, apiCost: 0.02, maxImages: 1, available: true },

      // cost=2 ток ≈ $0.046. API: $0.030
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
    trial: {
      name: 'TRIAL',
      tokens: 10,
      price: 0,
      features: ['🎁 15 безкоштовних токенів', '✨ Спробуйте базові моделі', '⚡ Токени НЕ згорають!']
    },
    starter: { name: 'STARTER', tokens: 186, tokensLiqPay: 240, price: 299, priceUSD: 7, features: ['🚀 186⚡ токенів (Telegram Stars)', '🚀 260⚡ токенів (LiqPay)', '💎 Доступ до всіх моделей', '⏰ Токени НЕ згорають', '✨ Комбінуйте як завгодно!', '📉 Чим більший план — тим дешевший ⚡'] },
    basic: { name: 'BASIC', tokens: 620, tokensLiqPay: 810, price: 899, priceUSD: 20, features: ['💎 620⚡ токенів (Telegram Stars)', '💎 870⚡ токенів (LiqPay)', '🎨 Для активних користувачів', '⏰ Токени НЕ згорають', '✨ Комбінуйте як завгодно!', '📉 Чим більший план — тим дешевший ⚡'] },
    pro: { name: 'PRO', tokens: 1500, tokensLiqPay: 1960, price: 1999, priceUSD: 45, features: ['🔥 1500⚡ токенів (Telegram Stars)', '🔥 2100⚡ токенів (LiqPay)', '🚀 Для професіоналів', '⏰ Токени НЕ згорають', '⚡ Найкраще співвідношення', '📉 Чим більший план — тим дешевший ⚡'] },
    premium: { name: 'PREMIUM', tokens: 4080, tokensLiqPay: 5300, price: 4999, priceUSD: 110, features: ['👑 4080⚡ токенів (Telegram Stars)', '👑 5700⚡ токенів (LiqPay)', '💫 Максимум можливостей', '⏰ Токени НЕ згорають', '👑 VIP підтримка 24/7', '📉 Найнижча ціна за ⚡'] }
  },

  _pricingAssumptions: {
    worstCaseTokenUSD: WORST_CASE_TOKEN_USD,
    targetGross: '≈30% after fees',
    pricingRule: 'tokens = ceil(apiCost / (worstCaseTokenUSD * 0.93 * 0.70))',
    note: 'wayforpay fees/taxes included (WAYFORPAY_OVERHEAD = 7%)'
  }
};
