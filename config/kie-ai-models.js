/**
 * Довідник моделей KIE.AI
 * Базується на офіційній документації https://docs.kie.ai/ та https://kie.ai/pricing
 *
 * ⚠️ ВАЖЛИВО: Ціни в KIE.AI відрізняються від Replicate!
 * KIE.AI використовує систему "credits" де 1 credit = $0.005 USD
 *
 * Дані отримані з офіційного API: https://api.kie.ai/client/v1/model-pricing/page
 * Останнє оновлення: 13.02.2026
 *
 * Вартість у токенах за KIE-генерації визначається тут: usdToTokens(), getKling3TokenCostPerSecond().
 * kie-pricing-sync лише підставляє актуальні USD з кешу і викликає ці функції.
 */

const KIE_CREDIT_USD = 0.005; // 1 кредит = $0.005

/** Як у config/models.js: 1 токен = $0.01, націнка ~30% */
const TOKEN_USD = 0.01;
const PRICING_MULTIPLIER = 1.65;

/**
 * Перевести ціну KIE (USD) у вартість у токенах для юзера.
 * Використовується для всіх KIE-генерацій (Kling 3.0, тощо).
 */
function usdToTokens(usd) {
  if (usd == null || Number.isNaN(usd)) return 0;
  const n = typeof usd === 'string' ? parseFloat(usd) : usd;
  return Math.ceil(n * PRICING_MULTIPLIER / TOKEN_USD);
}

module.exports = {
  KIE_CREDIT_USD,
  TOKEN_USD,
  PRICING_MULTIPLIER,
  usdToTokens,

  // ==================== IMAGE MODELS ====================

  /**
   * Google Nano Banana Pro
   * https://docs.kie.ai/market/google/nano-banana-pro
   *
   * KIE.AI Pricing:
   * - Перевіряйте актуальні ціни на https://kie.ai/pricing
   * - Ціни можуть змінюватись
   *
   * Replicate Pricing (для порівняння):
   * - 1K: $0.15/image
   * - 2K: $0.15/image
   * - 4K: $0.30/image
   */
  nano_banana_pro: {
    kie_model: 'nano-banana-pro',
    replicate_model: 'google/nano-banana-pro',
    replicate_pricing: {
      '1K': 0.15,
      '2K': 0.15,
      '4K': 0.30
    },
    features: {
      max_images: 14,
      aspect_ratios: ['match_input_image', '1:1', '4:5', '9:16'],
      resolutions: ['1K', '2K', '4K']
    },
    notes: 'KIE.AI ціни можуть бути вигіднішими - перевіряйте на kie.ai/pricing'
  },

  /**
   * ByteDance Seedream 4.5
   * https://docs.kie.ai/market/bytedance/seedream-4.5
   *
   * Replicate Pricing: $0.04/image
   */
  seedream: {
    kie_model: 'seedream-4.5',
    replicate_model: 'bytedance/seedream-4.5',
    replicate_pricing: {
      per_image: 0.04
    },
    features: {
      max_images: 14,
      aspect_ratios: ['match_input_image', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'],
      resolutions: ['1K', '2K', '4K']
    }
  },

  /**
   * Stability AI Stable Diffusion 3.5
   * https://docs.kie.ai/market/stability-ai/stable-diffusion-3.5
   *
   * Replicate Pricing: $0.07/image
   */
  stable_diffusion: {
    kie_model: 'stable-diffusion-3.5',
    replicate_model: 'stability-ai/stable-diffusion-3.5-large',
    replicate_pricing: {
      per_image: 0.07
    },
    features: {
      aspect_ratios: ['1:1', '16:9', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21']
    }
  },

  // ==================== VIDEO MODELS ====================

  /**
   * Kling v2.5 Turbo Pro
   * https://docs.kie.ai/market/kling/v2.5-turbo-pro
   *
   * Replicate Pricing: $0.07/second
   */
  kling_v2_5: {
    kie_model: 'kling-2.5',
    replicate_model: 'kwaivgi/kling-v2.5-turbo-pro',
    replicate_pricing: {
      per_second: 0.07
    },
    features: {
      durations: [5, 10],
      aspect_ratios: ['16:9', '9:16'],
      supports_end_image: true
    }
  },

  /**
   * Kling v2.6
   * https://docs.kie.ai/market/kling/v2.6
   *
   * KIE.AI Pricing (з офіційного API):
   * - 5s без аудіо: 55 credits = $0.275
   * - 5s з аудіо: 110 credits = $0.55
   * - 10s без аудіо: 110 credits = $0.55
   * - 10s з аудіо: 220 credits = $1.10
   *
   * Replicate Pricing (для порівняння):
   * - Video only: $0.07/second
   * - With audio: $0.14/second
   *
   * ⚠️ KIE.AI дешевше на 21.43% порівняно з Fal.ai!
   */
  kling_v2_6: {
    kie_model: 'kling-2.6',
    kie_pricing: {
      '5s_no_audio': { credits: 55, usd: 0.275 },
      '5s_audio': { credits: 110, usd: 0.55 },
      '10s_no_audio': { credits: 110, usd: 0.55 },
      '10s_audio': { credits: 220, usd: 1.10 }
    },
    replicate_pricing: {
      per_second_video: 0.07,
      per_second_audio: 0.14
    },
    features: {
      durations: [5, 10],
      aspect_ratios: ['16:9', '9:16'],
      supports_audio: true
    },
    notes: 'KIE.AI: 21.43% дешевше ніж Fal.ai'
  },

  /**
   * Kling 3.0 (НОВА МОДЕЛЬ!)
   * https://kie.ai/kling-3-0
   *
   * KIE.AI Pricing (з офіційного API):
   * - 720p без аудіо: 20 credits/sec = $0.10/sec
   * - 720p з аудіо: 30 credits/sec = $0.15/sec
   * - 1080p без аудіо: 27 credits/sec = $0.135/sec
   * - 1080p з аудіо: 40 credits/sec = $0.20/sec
   *
   * ⚠️ Discount: 40.48% дешевше ніж Fal.ai!
   */
  kling_3_0: {
    kie_model: 'kling-3.0',
    kie_pricing: {
      '720p_no_audio': { credits_per_sec: 20, usd_per_sec: 0.10 },
      '720p_audio': { credits_per_sec: 30, usd_per_sec: 0.15 },
      '1080p_no_audio': { credits_per_sec: 27, usd_per_sec: 0.135 },
      '1080p_audio': { credits_per_sec: 40, usd_per_sec: 0.20 }
    },
    features: {
      resolutions: ['720p', '1080p'],
      supports_audio: true
    },
    notes: 'НОВА МОДЕЛЬ! 40.48% дешевше ніж Fal.ai'
  },

  /**
   * Kling Motion Control
   * https://docs.kie.ai/market/kling/motion-control
   *
   * Replicate Pricing (фіксовані ціни):
   * - STD (720p) + Image orientation (до 10s): $0.50
   * - STD (720p) + Video orientation (до 30s): $1.00
   * - PRO (1080p) + Image orientation (до 10s): $1.00
   * - PRO (1080p) + Video orientation (до 30s): $2.00
   */
  kling_motion: {
    kie_model: 'kling-2.6/motion-control',
    replicate_pricing: {
      std_image: 0.50,    // 720p, до 10s
      std_video: 1.00,    // 720p, до 30s
      pro_image: 1.00,    // 1080p, до 10s
      pro_video: 2.00     // 1080p, до 30s
    },
    features: {
      modes: ['720p', '1080p'],  // STD=720p, PRO=1080p
      character_orientations: ['image', 'video'],
      max_duration_image: 10,
      max_duration_video: 30,
      requires: ['image', 'video']
    },
    notes: 'mode="720p" → STD, mode="1080p" → PRO'
  },

  /**
   * Google Veo 3.1
   * https://docs.kie.ai/market/google/veo-3.1
   *
   * Replicate Pricing:
   * - With audio: $0.40/second
   * - Without audio: $0.20/second
   */
  veo: {
    kie_model: 'veo-3.1',
    replicate_model: 'google/veo-3.1',
    replicate_pricing: {
      per_second_audio: 0.40,
      per_second_no_audio: 0.20
    },
    features: {
      durations: [4, 8],
      aspect_ratios: ['16:9', '9:16'],
      resolutions: ['720p', '1080p'],
      supports_audio: true,
      supports_reference_images: true,
      max_reference_images: 3,
      supports_last_frame: true
    }
  },

  /**
   * OpenAI Sora 2 (доступна на KIE.AI!)
   * https://kie.ai/sora-2
   *
   * KIE.AI Pricing (з офіційного API):
   * - Text-to-video 15s stable: 40 credits = $0.20
   * - Image-to-video 10s stable: 35 credits = $0.175
   * - Image-to-video 15s stable: 40 credits = $0.20
   *
   * ⚠️ Discount: 80-82.5% дешевше ніж Fal.ai ($1.00 на Fal vs $0.20 на KIE)!
   */
  sora_2: {
    kie_model: 'sora-2',
    kie_pricing: {
      'text_to_video_15s': { credits: 40, usd: 0.20, fal_price: 1.00, discount: '80%' },
      'image_to_video_10s': { credits: 35, usd: 0.175, fal_price: 1.00, discount: '82.5%' },
      'image_to_video_15s': { credits: 40, usd: 0.20, fal_price: 1.00, discount: '80%' }
    },
    features: {
      durations: [10, 15],
      modes: ['text-to-video', 'image-to-video']
    },
    notes: '🔥 ВЕЛИЧЕЗНА ЗНИЖКА! 80%+ дешевше ніж Fal.ai!'
  },

  // ==================== HELPER FUNCTIONS ====================

  /**
   * Отримати назву моделі для KIE.AI API
   */
  getKieAIModelName(modelKey) {
    const mapping = {
      'nano_banana_2k': 'nano-banana-pro',
      'nano_banana_4k': 'nano-banana-pro',
      'seedream_2k': 'seedream-4.5',
      'seedream_4k': 'seedream-4.5',
      'stable_diffusion': 'stable-diffusion-3.5',
      'kling': 'kling-2.5',
      'kling_v2_6': 'kling-2.6',
      'kling_3_0': 'kling-3.0',
      'kling_motion': 'kling-2.6/motion-control',
      'veo': 'veo-3.1',
      'sora_2': 'sora-2'
    };
    return mapping[modelKey] || modelKey;
  },

  /**
   * Отримати ціну моделі з Replicate (для розрахунків)
   * ⚠️ ВАЖЛИВО: KIE.AI ціни можуть відрізнятись!
   * Ці ціни використовуються тільки для розрахунку токенів у нашій системі
   */
  getReplicatePrice(modelKey, options = {}) {
    const { resolution = '2K', duration = 5, audio = false, mode = 'std', orientation = 'image' } = options;

    switch(modelKey) {
      case 'nano_banana_2k':
        return 0.15;
      case 'nano_banana_4k':
        return 0.30;
      case 'seedream_2k':
      case 'seedream_4k':
        return 0.04;
      case 'stable_diffusion':
        return 0.07;
      case 'kling':
        return 0.07 * duration;
      case 'kling_v2_6':
        return audio ? (0.14 * duration) : (0.07 * duration);
      case 'kling_motion':
        const modeKey = `${mode}_${orientation}`;
        const prices = { std_image: 0.50, std_video: 1.00, pro_image: 1.00, pro_video: 2.00 };
        return prices[modeKey] || 0.50;
      case 'veo':
        return audio ? (0.40 * duration) : (0.20 * duration);
      default:
        return 0;
    }
  },

  /**
   * Отримати ціну з KIE.AI (реальна ціна провайдера в USD)
   */
  getKieAIPrice(modelKey, options = {}) {
    const { duration = 5, audio = false, resolution = '1080p' } = options;

    switch(modelKey) {
      case 'kling_v2_6':
        const key = `${duration}s_${audio ? 'audio' : 'no_audio'}`;
        return this.kling_v2_6.kie_pricing[key]?.usd || 0;

      case 'kling_3_0':
        const resKey = `${resolution}_${audio ? 'audio' : 'no_audio'}`;
        return (this.kling_3_0.kie_pricing[resKey]?.usd_per_sec || 0) * duration;

      case 'sora_2':
        // За замовчуванням text-to-video 15s
        return this.sora_2.kie_pricing['text_to_video_15s'].usd;

      default:
        return 0;
    }
  },

  /**
   * Вартість Kling 3.0 у токенах за секунду (для списання з балансу).
   * Джерело USD: з кешу (usdFromCache) якщо передано, інакше з this.kling_3_0.kie_pricing.
   * @param {string} mode - 'pro' (1080p) або 'std' (720p)
   * @param {Object} usdFromCache - опційно { costPerSecondAudio, costPerSecondNoAudio } з kie-pricing-cache (оновлення щорану)
   * @returns {{ costPerSecondAudio: number, costPerSecondNoAudio: number }}
   */
  getKling3TokenCostPerSecond(mode = 'pro', usdFromCache = null) {
    const resolution = mode === 'pro' ? '1080p' : '720p';
    let usdAudio, usdNoAudio;
    const k = this.kling_3_0.kie_pricing;
    const staticAudio = k[`${resolution}_audio`]?.usd_per_sec;
    const staticNoAudio = k[`${resolution}_no_audio`]?.usd_per_sec;
    if (usdFromCache && (usdFromCache.costPerSecondAudio != null || usdFromCache.costPerSecondNoAudio != null)) {
      usdAudio = usdFromCache.costPerSecondAudio ?? staticAudio;
      usdNoAudio = usdFromCache.costPerSecondNoAudio ?? staticNoAudio;
    } else {
      usdAudio = staticAudio;
      usdNoAudio = staticNoAudio;
    }
    return {
      costPerSecondAudio: usdToTokens(usdAudio ?? 0.20),
      costPerSecondNoAudio: usdToTokens(usdNoAudio ?? 0.135)
    };
  },

  /**
   * Перевірити чи модель підтримується KIE.AI
   */
  isKieAISupported(modelKey) {
    const supported = [
      'nano_banana_2k', 'nano_banana_4k',
      'seedream_2k', 'seedream_4k',
      'stable_diffusion',
      'kling', 'kling_v2_6', 'kling_3_0', 'kling_motion',
      'veo', 'sora_2'
    ];
    return supported.includes(modelKey);
  },

  /**
   * Інформація про систему ціноутворення
   */
  pricingInfo: {
    kie_ai: {
      credit_usd: KIE_CREDIT_USD,
      note: '1 credit = $0.005 USD на KIE.AI',
      url: 'https://kie.ai/pricing',
      api_endpoint: 'https://api.kie.ai/client/v1/model-pricing/page',
      advantages: [
        '✅ Kling 2.6: 21.43% дешевше ніж Fal.ai',
        '✅ Kling 3.0: 40.48% дешевше ніж Fal.ai',
        '✅ Sora 2: 80%+ дешевше ніж Fal.ai',
        '✅ Стабільні ціни без сюрпризів'
      ]
    },
    replicate: {
      note: 'Ціни Replicate використовуються для розрахунку токенів у боті',
      our_multiplier: 1.65,
      our_token_usd: 0.01,
      formula: 'tokens = ceil(replicatePrice * 1.65 / 0.01)'
    },
    important: '⚠️ KIE.AI часто дешевше за Replicate! Рекомендуємо використовувати KIE.AI'
  }
};



