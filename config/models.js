/**
 * Токеноміка: models.js — єдине джерело цін для тарифів і всіх моделей (Replicate тощо).
 * 1 токен = $0.01 для юзера.
 * Ціноутворення: tokens = ceil(apiCostUSD * PRICING_MULTIPLIER / TOKEN_USD),
 * PRICING_MULTIPLIER = 1.65 ≈ 30% прибутку після fees.
 *
 * Виняток: KIE.AI (Kling 3.0 тощо) — вартість у токенах рахується з кешу
 * kie-ai-pricing-cache.json (оновлення щорану), з тим самим 30% (1.65).
 * Там ціни нижчі → юзер платить менше токенів за генерацію (= більше генерацій за ті самі токени).
 */

const TOKEN_USD = 0.01;
const PRICING_MULTIPLIER = 1.65;

// Target: ~30% profit AFTER fees (payment + tax) + buffer
const TARGET_PROFIT_AFTER_FEES = 0.30;

// WayForPay 2% + FOP 5% = 7%
const WAYFORPAY_OVERHEAD = 0.07;

// Net revenue factor after overhead
const NET_REVENUE_FACTOR = 1 - WAYFORPAY_OVERHEAD; // 0.93

const TRIAL_RESTRICTIONS = {
  blockedModels: ['veo', 'kling_motion', 'kling_3', 'runway_gen4', 'a2e_image'],
  blockedModes: { kling: { durations: [10] }, kling_v2_6: { durations: [10] } },
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

      // Claude text: $0.008 -> ceil(0.008*1.65/0.01)=2 токени
      { name: '✍️ Пишіть', key: 'text', cost: 2, apiCost: 0.008 },

      // Claude image analysis: $0.048 -> ceil(0.048*1.65/0.01)=8 токенів
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 8, apiCost: 0.048 },

      // Sora Watermark Remover: Dynamic KIE.AI pricing (потребує credits на KIE.AI)
      { name: '🧹 Видалити Sora Watermark', key: 'sora_watermark_remover', cost: 0, apiCost: 0, isDynamic: true, kieModel: 'sora-watermark-remover' }
    ]
  },

  /**
   * Video Models
   *
   * ⚠️ requiresImage: true моделі (image-to-video ONLY):
   * - runway_turbo (RunWay Gen-4 Turbo)
   * - runway_gen4 (RunWay Gen-4 Aleph) - currently unavailable
   * - kling (Kling v2.5 Turbo) - KIE.AI: тільки image-to-video!
   * - kling_motion (Kling Motion Control) - також requiresVideo: true
   *
   * ✅ requiresImage: false моделі (text-to-video + опціонально image-to-video):
   * - kling_v2_6 (Kling v2.6)
   * - kling_3 (Kling 3.0 Pro)
   * - veo (Google Veo 3.1)
   * - sora_2 (OpenAI Sora 2)
   */
  video: {
    models: [
      /**
       * Runway Turbo — $0.25/run
       * tokens = ceil(0.25*1.65/0.01)=42
       * (фіксована ціна за run незалежно від duration)
       */
      {
        name: '🎬 RunWay: Gen-4 Turbo ⚡',
        key: 'runway_turbo',
        costPerSecond: 9,
        apiCostPerSecond: 0.05,
        cost: 45,
        apiCost: 0.25,
        available: true,
        requiresImage: true,
        durations: [5, 10],
        aspectRatios: ['16:9', '9:16']
      },

      /**
       * Kling v2.5 — $0.07/сек
       * tokens/sec = ceil(0.07*1.65/0.01)=12
       * 5s=60, 10s=120
       */
      {
        name: '🎭 Kling v2.5 Turbo',
        key: 'kling',
        costPerSecond: 12,
        cost: 60,
        apiCostPerSecond: 0.07,
        available: true,
        requiresImage: true,  // ⚠️ KIE.AI: Kling v2.5 = тільки image-to-video!
        durations: [5, 10],
        supportsEndImage: true
      },

      /**
       * Kling v2.6 — $0.07/сек video, $0.14/сек audio
       * no-audio tokens/sec = 12
       * audio tokens/sec = ceil(0.21*1.65/0.01)=35
       * 5s audio=175
       */
      {
        name: '🎭 Kling v2.6',
        key: 'kling_v2_6',
        costPerSecond: 12,
        costPerSecondAudio: 35,
        cost: 60,
        apiCostPerSecond: 0.07,
        apiCostPerSecondAudio: 0.14,
        audioParam: 'generate_audio',
        available: true,
        requiresImage: false,
        durations: [5, 10],
        supportsEndImage: false
      },

      /**
       * Kling Motion Control (fixed)
       * std_image $0.50 -> 83
       * std_video $1.00 -> 165
       * pro_image $1.00 -> 165
       * pro_video $2.00 -> 330
       */
      {
        name: '🔥 Kling Motion Control',
        key: 'kling_motion',
        costs: { std_image: 83, std_video: 165, pro_image: 165, pro_video: 330 },
        apiCosts: { std_image: 0.50, std_video: 1.00, pro_image: 1.00, pro_video: 2.00 },
        cost: 83,
        maxCost: 330,
        available: true,
        requiresImage: true,
        requiresVideo: true
      },

      /**
       * Kling 3.0 — Multi-shot & Element References 🆕
       * ⚠️ KIE.AI ONLY - немає на Replicate!
       *
       * KIE.AI pricing (per second):
       * - std with audio: $0.20/сек -> 33 tokens/sec
       * - std without audio: $0.10/сек -> 17 tokens/sec
       * - pro with audio: $0.27/сек -> 45 tokens/sec
       * - pro without audio: $0.135/сек -> 23 tokens/sec
       *
       * Можливості:
       * - Multi-shot: кілька сцен в одному відео
       * - Element refs: використання @element_name
       * - Тривалість: 3-15 секунд
       */
      {
        name: '🎭 Kling 3.0 Pro 💎',
        key: 'kling_3',
        costPerSecondAudio: 45,      // pro with audio
        costPerSecondNoAudio: 23,    // pro without audio
        apiCostPerSecondAudio: 0.27,
        apiCostPerSecondNoAudio: 0.135,
        minSeconds: 3,
        durations: [3, 5, 8, 10, 15],
        cost: 225, // default 5s pro audio = 45*5
        available: true,
        requiresImage: false,
        supportsMultiShot: true,
        supportsElementRefs: true,
        modes: ['std', 'pro'],
        kieAIOnly: true  // ⚠️ Немає на Replicate!
      },

      /**
       * Veo — audio $0.40/сек, no-audio $0.20/сек
       * tokens/sec audio = ceil(0.40*1.65/0.01)=66
       * tokens/sec no-audio = ceil(0.20*1.65/0.01)=33
       */
      {
        name: '🌟 Google Veo 3.1 💎',
        key: 'veo',
        // Flat per-video pricing (KIE.AI)
        costFast: 50,            // veo3_fast: 60 KIE credits = $0.30 → 50 tokens
        costQuality: 208,        // veo3: 250 KIE credits = $1.25 → 208 tokens
        apiCostFast: 0.30,       // $0.30 per video (Fast)
        apiCostQuality: 1.25,    // $1.25 per video (Quality)
        // Legacy per-second (Replicate fallback)
        costPerSecondAudio: 66,
        costPerSecondNoAudio: 33,
        apiCostPerSecondAudio: 0.40,
        apiCostPerSecondNoAudio: 0.20,
        minSeconds: 4,
        durations: [4, 8],
        cost: 208, // default Quality
        available: true,
        requiresImage: false,
        supportsReferences: true
      },

      /**
       * OpenAI Sora 2 (Replicate)
       * Standard quality: $0.10/sec
       * tokens/sec = ceil(0.10*1.65/0.01)=17
       */
      {
        name: '🌌 OpenAI Sora 2',
        key: 'sora_2',
        costPerSecond: 17,
        apiCostPerSecond: 0.10,
        durations: [4, 8, 12],
        aspectRatios: ['portrait', 'landscape'],
        available: true,
        requiresImage: false,
        supportsReferences: true
      },

      /**
       * Kling O1 Edit — редагування відео через Replicate
       * Ціни за секунду:
       * - std: $0.084/сек -> 14 токенів/сек
       * - std-with-video-input: $0.126/сек -> 21 токен/сек
       * - pro: $0.112/сек -> 19 токенів/сек
       * - pro-with-video-input: $0.168/сек -> 28 токенів/сек
       * Тривалість: 3-10 секунд (залежить від вхідного відео)
       */
      {
        name: '✂️ Kling O1 Edit',
        key: 'kling_o1_edit',
        costPerSecond: 14,              // std без відео-input
        costPerSecondWithVideo: 21,     // std з відео-input
        costPerSecondPro: 19,           // pro без відео-input
        costPerSecondProWithVideo: 28,  // pro з відео-input
        apiCostPerSecond: 0.084,
        apiCostPerSecondWithVideo: 0.126,
        apiCostPerSecondPro: 0.112,
        apiCostPerSecondProWithVideo: 0.168,
        minSeconds: 3,
        maxSeconds: 10,
        durations: [3, 5, 7, 10],
        available: true,
        requiresVideo: true,            // Потрібен відео-файл для редагування
        requiresImage: false,
        supportsReferences: true,       // reference_images, start_image, end_image
        modes: ['std', 'pro']
      },

      /**
       * A2E Motion без омежень 🔥
       * На сайті A2E: 5 секунд = 30 credits
       * Собівартість: $10 за 1800 credits = $0.00556 за credit
       * Собівартість 5s: 30 credits × $0.00556 = $0.1668
       * Маржа х2: клієнт платить $0.1668 × 2 = $0.3336
       * У наших токенах (1 токен = $0.01): $0.3336 / $0.01 = 33.36 токенів ≈ 33 токенів
       * Але користувач хоче: 5s = 60 токенів, 10s = 120 токенів, 15s = 180 токенів
       * Це означає: 12 токенів за секунду (більше ніж х2 маржа)
       */
      {
        name: '🔥 Motion без омежень',
        key: 'a2e_motion',
        cost: 60,  // Ціна для 5 секунд (х2 маржа від собівартості)
        apiCost: 0.1668,  // Собівартість 5s: 30 credits × $0.00556
        costPerSecond: 12,  // 12 токенів за секунду (5s=60, 10s=120, 15s=180, 20s=240)
        apiCostPerSecond: 0.03336,  // Собівартість за секунду: 6 credits × $0.00556
        durations: [5, 10, 15, 20],
        available: true,
        requiresImage: true,
        a2eOnly: true  // Тільки через A2E API
      },

      { name: '🎬 RunWay: Gen-4 Aleph 💎', key: 'runway_gen4', cost: 0, apiCost: 0, available: false, requiresImage: true },
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 0, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 0, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      /**
       * Image models (pricing by multiplier 1.65 and $0.01/token)
       */

      // stable_diffusion $0.07 -> 12
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 12, apiCost: 0.07, available: true },

      /**
       * Nano Banana FREE — безкоштовна модель через Google Gemini API
       * gemini-3-pro-image-preview — 5 безкоштовних генерацій для кожного юзера
       * Не використовує Replicate/KIE.AI — напряму Google API
       * Той самий функціонал що і Nano Banana PRO (до 14 референсів, aspect ratio)
       */
      {
        name: '🍌 Nano Banana FREE 🎁',
        key: 'nano_banana_free',
        cost: 0,
        apiCost: 0,
        maxImages: 14,
        available: true,
        freeLimit: 5,
        googleDirect: true  // маркер: через Google Gemini API напряму
      },

      // nano_banana $0.039 -> 7
      {
        name: '🍌 Nano Banana',
        key: 'nano_banana',
        cost: 7,
        apiCost: 0.039,
        maxImages: 3,
        available: true
      },

      // nano_banana_2k $0.15 -> 25
      {
        name: '🍌 Nano Banana PRO 2K',
        key: 'nano_banana_2k',
        cost: 25,
        apiCost: 0.15,
        resolution: '2K',
        maxImages: 14,
        available: true
      },

      // nano_banana_4k $0.30 -> 50
      {
        name: '🍌🍌 Nano Banana PRO 4K',
        key: 'nano_banana_4k',
        cost: 50,
        apiCost: 0.30,
        resolution: '4K',
        maxImages: 14,
        available: true
      },

      // seedream $0.04 -> 7
      { name: '🌊 Seedream 4K', key: 'seedream_4k', cost: 7, apiCost: 0.04, size: '4K', maxImages: 14, available: true },

      // clarity $0.02 -> 4
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 4, apiCost: 0.02, maxImages: 1, available: true },

      // recraft crisp upscale $0.006 -> 1
      { name: '✨ Recraft Crisp Upscale', key: 'recraft_upscale', cost: 1, apiCost: 0.006, maxImages: 1, available: true },

      // ideogram $0.03 -> 5
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 5, apiCost: 0.03, maxImages: 1, available: true },

      /**
       * Зображення без омежень — text2image через A2E API
       * Два рівні якості:
       * - 1080p: 10 A2E credits × $0.00556 = $0.0556 → ceil($0.0556 × 1.65 / $0.01) = 10 токенів
       * - 2K: 25 A2E credits × $0.00556 = $0.139 → ceil($0.139 × 1.65 / $0.01) = 23 токенів
       * Підтримує до 2 референсних зображень
       */
      {
        name: '🔥 Зображення без омежень',
        key: 'a2e_image',
        cost: 10,           // 1080p (мінімальна ціна)
        cost2k: 23,          // 2K
        apiCost: 0.0556,     // Собівартість 1080p
        apiCost2k: 0.139,    // Собівартість 2K
        maxImages: 2,        // Макс. 2 референсних зображення
        available: true,
        a2eOnly: true        // Тільки через A2E API
      },

      /**
       * Z-Image - KIE.AI ONLY 💎
       * Qwen Z-Image: 0.8 credits = $0.004 per image
       * tokens = ceil(0.004 * 1.65 / 0.01) = 1
       * Найдешевша модель зображень!
       */
      {
        name: '⚡ Z-Image 💎',
        key: 'z_image',
        cost: 1,
        apiCost: 0.004,
        maxImages: 1,
        available: true,
        kieAIOnly: true
      },

      /**
       * Midjourney - KIE.AI ONLY 💎
       * Pricing (з націнкою 1.65x):
       * - relaxed: $0.015 → 3 tokens (найдешевше!)
       * - fast: $0.04 → 7 tokens (стандарт)
       * - turbo: $0.08 → 14 tokens (найшвидше)
       * - video: $0.30 → 50 tokens
       * - upscale/vary: безкоштовно
       *
       * ⚠️ Доступно тільки через KIE.AI!
       */
      {
        name: '🖼️ MidJourney 💎',
        key: 'midjourney',
        cost: 7,  // fast (default)
        apiCost: 0.04,
        speeds: {
          relaxed: { cost: 3, apiCost: 0.015 },
          fast: { cost: 7, apiCost: 0.04 },
          turbo: { cost: 14, apiCost: 0.08 }
        },
        video: {
          cost: 50,
          apiCost: 0.30
        },
        upscale: {
          cost: 0,
          apiCost: 0
        },
        vary: {
          cost: 0,
          apiCost: 0
        },
        maxImages: 4,  // Генерує 4 варіанти одразу
        available: false, // ⚠️ Тимчасово вимкнено (KIE.AI access issue)
        kieAIOnly: true
      }
    ]
  },

  audio: {
    models: [
      { name: '🎵 Suno AI Bark', key: 'suno', cost: 0, apiCost: 0, available: false },
      { name: '🎼 Udio AI', key: 'udio', cost: 0, apiCost: 0, available: false },
      { name: '🎤 ElevenLabs', key: 'elevenlabs', cost: 0, apiCost: 0, available: false }
    ]
  },

  subscriptions: {
    trial: {
      name: 'TRIAL',
      tokens: 7,
      price: 0,
      priceUSD: 0,
      features: ['🎁 7 безкоштовних токенів', '✨ Спробуйте базові моделі', '⚡ Токени НЕ згорають!']
    },

    starter: {
      name: 'STARTER',
      tokens: 700,
      tokensWayForPay: 700,
      priceUSD: 7,
      price: 552,
      features: ['🚀 700⚡ токенів', '💎 Доступ до всіх моделей', '⏰ Токени НЕ згорають', '✨ Комбінуйте як завгодно!']
    },

    starter_test: {
      name: 'STARTER TEST',
      tokens: 100,
      tokensWayForPay: 10,
      priceUSD: 0.1,
      price: 10,
      priceWayForPayUAH: 4,
      adminOnly: true,
      features: ['🧪 Тестовий пакет', '⚡ 10 токенів', '🔒 Тільки для адміна']
    },

    basic: {
      name: 'BASIC',
      tokens: 1500,
      tokensWayForPay: 1500,
      priceUSD: 15,
      price: 1182,
      features: ['💎 1500⚡ токенів', '🎨 Для активних користувачів', '⏰ Токени НЕ згорають', '✨ Комбінуйте як завгодно!']
    },

    pro: {
      name: 'PRO',
      tokens: 2900,
      tokensWayForPay: 2900,
      priceUSD: 29,
      price: 2284,
      features: ['🔥 2900⚡ токенів', '🚀 Для професіоналів', '⏰ Токени НЕ згорають', '⚡ Найкраще співвідношення']
    },

    premium: {
      name: 'PREMIUM',
      tokens: 5900,
      tokensWayForPay: 5900,
      priceUSD: 59,
      price: 4646,
      features: ['👑 5900⚡ токенів', '💫 Максимум можливостей', '⏰ Токени НЕ згорають', '👑 VIP підтримка']
    }
  },


  _pricingAssumptions: {
    tokenUSD: TOKEN_USD,
    pricingMultiplier: PRICING_MULTIPLIER,
    wayforpayOverhead: WAYFORPAY_OVERHEAD,
    targetProfitAfterFees: TARGET_PROFIT_AFTER_FEES,
    netRevenueFactor: NET_REVENUE_FACTOR,
    pricingRule: 'tokens = ceil(apiCostUSD * PRICING_MULTIPLIER / TOKEN_USD)',
    note: 'прибутковість закладена через PRICING_MULTIPLIER=1.65 (≈30% після fees + буфер)'
  }
};
