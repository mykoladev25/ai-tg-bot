

const KIE_CREDIT_USD = 0.005; 


const TOKEN_USD = 0.01;
const PRICING_MULTIPLIER = 1.65;


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

  
  nano_banana: {
    kie_model: 'google/nano-banana',
    kie_pricing: {
      credits: 4.0,
      usd: 0.02,  // 4.0 × $0.005
      note: 'Fetched from the official KIE.AI pricing API (2026-02-13)'
    },
    replicate_model: 'google/nano-banana',
    replicate_pricing: {
      per_image: 0.039
    },
    features: {
      max_images: 3,
      image_sizes: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', 'auto'],
      output_formats: ['png', 'jpeg']
    },
    notes: '💡 Base Nano Banana model. Use nano_banana_2k or nano_banana_4k for higher quality.'
  },

  
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
    notes: 'KIE.AI pricing may be lower. Check kie.ai/pricing.'
  },

  
  seedream: {
    kie_model: 'seedream-4.5',
    kie_pricing: {
      credits: 6.5,
      usd: 0.0325,  // 6.5 × $0.005
      note: 'Confirmed by KIE support on 2026-02-19. There is no pricing API endpoint for this model.'
    },
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

  
  seedream_5_lite: {
    kie_model_text_to_image: 'seedream/5-lite-text-to-image',
    kie_model_image_to_image: 'seedream/5-lite-image-to-image',
    kie_pricing: {
      per_image: {
        credits: 5.5,
        usd: 0.0275,
        note: 'Official KIE.AI price: 5.5 credits per image'
      },
      discounted_effective_usd: 0.025
    },
    replicate_model: null,
    replicate_pricing: null,
    features: {
      supports_text_to_image: true,
      supports_image_to_image: true,
      max_images: 14,
      aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
      qualities: {
        basic: '2K',
        high: '3K'
      },
      max_prompt_length_text_to_image: 2995,
      max_prompt_length_image_to_image: 2996
    },
    notes: 'KIE.AI only. Approximately 21% cheaper than official/Fal.ai rates.'
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

  
  z_image: {
    kie_model: 'z-image',
    kie_pricing: {
      credits: 0.8,
      usd: 0.004,
      note: 'Qwen Z-Image. Retrieved from the KIE.AI pricing API.'
    },
    replicate_model: null,  
    replicate_pricing: null,
    features: {
      max_images: 1,
      aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
      max_prompt_length: 1000
    },
    notes: '⚠️ Available only on KIE.AI. This is the cheapest image model.'
  },

  
  midjourney: {
    kie_model: 'midjourney',
    kie_pricing: {
      text_to_image_relaxed: { credits: 3, usd: 0.015 },
      text_to_image_fast: { credits: 8, usd: 0.04 },
      text_to_image_turbo: { credits: 16, usd: 0.08 },
      image_to_image_relaxed: { credits: 3, usd: 0.015 },
      image_to_image_fast: { credits: 8, usd: 0.04 },
      image_to_image_turbo: { credits: 16, usd: 0.08 },
      image_to_video: { credits: 60, usd: 0.30 },
      upscale: { credits: 0, usd: 0 },  
      vary: { credits: 0, usd: 0 }      
    },
    replicate_model: null,  
    replicate_pricing: null,
    features: {
      speeds: ['relaxed', 'fast', 'turbo'],
      versions: ['7', '6.1', '6', '5.2', '5.1', 'niji6', 'niji7'],
      aspect_ratios: ['1:2', '9:16', '2:3', '3:4', '5:6', '6:5', '4:3', '3:2', '1:1', '16:9', '2:1'],
      supports_image_to_image: true,
      supports_image_to_video: true,
      supports_style_reference: true,
      supports_omni_reference: true,
      supports_upscale: true,
      supports_vary: true,
      max_prompt_length: 2000
    },
    notes: '⚠️ Available only on KIE.AI. Not available on Replicate.'
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
    notes: 'KIE.AI: 21.43% cheaper than Fal.ai'
  },

  
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
    notes: 'NEW MODEL. 40.48% cheaper than Fal.ai'
  },

  
  kling_motion: {
    kie_model: 'kling-2.6/motion-control',
    replicate_pricing: {
      std_image: 0.50,    
      std_video: 1.00,    
      pro_image: 1.00,    
      pro_video: 2.00     
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

  
  sora_2: {
    kie_model_text_to_video: 'sora-2-text-to-video',
    kie_model_image_to_video: 'sora-2-image-to-video',
    kie_pricing: {
      'text_to_video_15s': { credits: 40, usd: 0.20, fal_price: 1.00, discount: '80%' },
      'image_to_video_10s': { credits: 35, usd: 0.175, fal_price: 1.00, discount: '82.5%' },
      'image_to_video_15s': { credits: 40, usd: 0.20, fal_price: 1.00, discount: '80%' }
    },
    replicate_pricing: {
      per_second: 0.10,  
      '4s': 0.40,
      '8s': 0.80,
      '12s': 1.20
    },
    features: {
      durations: [10, 15],  
      replicate_durations: [4, 8, 12],  // Replicate: 4, 8, 12s
      modes: ['text-to-video', 'image-to-video'],
      qualities: ['stable'],  
      aspect_ratios: ['portrait', 'landscape']
    },
    notes: '🔥 Major discount. More than 80% cheaper than Fal.ai. This is the standard Sora 2 model, not the Pro version.'
  },

  /**
   * ByteDance Seedance 2
   * https://docs.kie.ai/market/bytedance/seedance-2
   *
   * KIE.AI Pricing (pricing API, checked 2026-04-04):
   * - 480p no video input: $0.095/sec
   * - 720p no video input: $0.205/sec
   * - 480p with video input: $0.057/sec
   * - 720p with video input: $0.125/sec
   *
   * Note:
   * - Our current Telegram flow uses text-to-video / no-video-input pricing.
   * - Video-input pricing is stored for future multimodal flows.
   */
  seedance_2: {
    kie_model: 'bytedance/seedance-2',
    kie_pricing: {
      no_video_input: {
        '480p': { usd_per_sec: 0.095, credits_per_sec: 19 },
        '720p': { usd_per_sec: 0.205, credits_per_sec: 41 },
        // KIE docs expose 1080p for Seedance 2.0, but the pricing cache still lacks it.
        // Keep this as the floor until the pricing API exposes a native 1080p row.
        '1080p': { usd_per_sec: 0.51, credits_per_sec: 102 }
      },
      with_video_input: {
        '480p': { usd_per_sec: 0.0575, credits_per_sec: 11.5 },
        '720p': { usd_per_sec: 0.125, credits_per_sec: 25 },
        '1080p': { usd_per_sec: 0.31, credits_per_sec: 62 }
      }
    },
    features: {
      durations: [4, 5, 6, 8, 10, 12, 15],
      resolutions: ['480p', '720p', '1080p'],
      aspect_ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
      supports_audio: true,
      supports_reference_images: true,
      supports_reference_videos: true,
      supports_reference_audio: true,
      supports_last_frame: true
    },
    notes: 'KIE.AI only. Telegram flow defaults to no-video-input pricing unless reference video URLs are attached.'
  },

  /**
   * ByteDance Seedance 2 Fast
   * https://docs.kie.ai/market/bytedance/seedance-2-fast
   *
   * KIE.AI Pricing (pricing API, checked 2026-04-04):
   * - 480p no video input: $0.0775/sec
   * - 720p no video input: $0.165/sec
   * - 480p with video input: $0.045/sec
   * - 720p with video input: $0.10/sec
   *
   * Note:
   * - The pricing API omits creditUnit for "720p no video input", but USD aligns
   *   with the rest of Seedance entries, so it is treated as per-second pricing.
   */
  seedance_2_fast: {
    kie_model: 'bytedance/seedance-2-fast',
    kie_pricing: {
      no_video_input: {
        '480p': { usd_per_sec: 0.0775, credits_per_sec: 15.5 },
        '720p': { usd_per_sec: 0.165, credits_per_sec: 33 }
      },
      with_video_input: {
        '480p': { usd_per_sec: 0.045, credits_per_sec: 9 },
        '720p': { usd_per_sec: 0.10, credits_per_sec: 20 }
      }
    },
    features: {
      durations: [4, 5, 6, 8, 10, 12, 15],
      resolutions: ['480p', '720p'],
      aspect_ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
      supports_audio: true,
      supports_reference_images: true,
      supports_reference_videos: true,
      supports_reference_audio: true,
      supports_last_frame: true
    },
    notes: 'KIE.AI only. Fast variant with lower per-second cost and quicker generation.'
  },

  // ==================== HELPER FUNCTIONS ====================

  
  getKieAIModelName(modelKey) {
    const mapping = {
      'nano_banana_2k': 'nano-banana-pro',
      'nano_banana_4k': 'nano-banana-pro',
      'seedream_2k': 'seedream-4.5',
      'seedream_4k': 'seedream-4.5',
      'seedream_5_lite': 'seedream-5-lite',
      'stable_diffusion': 'stable-diffusion-3.5',
      'z_image': 'z-image',
      'kling': 'kling-2.5',
      'kling_v2_6': 'kling-2.6',
      'kling_3_0': 'kling-3.0',
      'kling_motion': 'kling-2.6/motion-control',
      'veo': 'veo-3.1',
      'sora_2': 'sora-2',
      'seedance_2': 'bytedance/seedance-2',
      'seedance_2_fast': 'bytedance/seedance-2-fast'
    };
    return mapping[modelKey] || modelKey;
  },

  
  getReplicatePrice(modelKey, options = {}) {
    const {
      resolution = '2K',
      duration = 5,
      audio = false,
      mode = 'std',
      orientation = 'image',
      inputType = 'no_video_input'
    } = options;

    switch(modelKey) {
      case 'nano_banana_2k':
        return 0.15;
      case 'nano_banana_4k':
        return 0.30;
      case 'seedream_2k':
      case 'seedream_4k':
        return 0.0325;  
      case 'seedream_5_lite':
        return 0.0275;  // KIE.AI only: 5.5 credits × $0.005 = $0.0275
      case 'ideogram':
        return 0.0175;  
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
      case 'seedance_2': {
        const usdPerSec = this.seedance_2.kie_pricing?.[inputType]?.[resolution]?.usd_per_sec;
        return usdPerSec ? usdPerSec * duration : 0;
      }
      case 'seedance_2_fast': {
        const usdPerSec = this.seedance_2_fast.kie_pricing?.[inputType]?.[resolution]?.usd_per_sec;
        return usdPerSec ? usdPerSec * duration : 0;
      }
      default:
        return 0;
    }
  },

  
  getKieAIPrice(modelKey, options = {}) {
    const { duration = 5, audio = false, resolution = '1080p' } = options;

    switch(modelKey) {
      case 'kling_v2_6':
        const key = `${duration}s_${audio ? 'audio' : 'no_audio'}`;
        return this.kling_v2_6.kie_pricing[key]?.usd || 0;

      case 'kling_3_0':
        const resKey = `${resolution}_${audio ? 'audio' : 'no_audio'}`;
        return (this.kling_3_0.kie_pricing[resKey]?.usd_per_sec || 0) * duration;

      case 'sora_2': {
        const type = options.type || 'text_to_video_15s';
        const p = this.sora_2.kie_pricing[type];
        return p ? p.usd : this.sora_2.kie_pricing['text_to_video_15s'].usd;
      }

      case 'seedance_2':
      case 'seedance_2_fast': {
        const inputType = options.inputType || 'no_video_input';
        const resolution = options.resolution || '480p';
        const duration = options.duration || 1;
        const pricing = this[modelKey]?.kie_pricing?.[inputType]?.[resolution];
        return pricing?.usd_per_sec ? pricing.usd_per_sec * duration : 0;
      }

      case 'seedream_5_lite':
        return this.seedream_5_lite.kie_pricing.per_image.usd;

      default:
        return 0;
    }
  },

  
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

    const fallbackAudio = mode === 'pro' ? 0.20 : 0.15;      // 1080p: $0.20, 720p: $0.15
    const fallbackNoAudio = mode === 'pro' ? 0.135 : 0.10;   // 1080p: $0.135, 720p: $0.10

    return {
      costPerSecondAudio: usdToTokens(usdAudio ?? fallbackAudio),
      costPerSecondNoAudio: usdToTokens(usdNoAudio ?? fallbackNoAudio)
    };
  },

  
  isKieAISupported(modelKey) {
    const supported = [
      'nano_banana_2k', 'nano_banana_4k',
      'seedream_2k', 'seedream_4k', 'seedream_5_lite',
      'stable_diffusion',
      'z_image',
      'kling', 'kling_v2_6', 'kling_3_0', 'kling_motion',
      'veo', 'sora_2',
      'seedance_2', 'seedance_2_fast'
    ];
    return supported.includes(modelKey);
  },

  
  pricingInfo: {
    kie_ai: {
      credit_usd: KIE_CREDIT_USD,
      note: '1 credit = $0.005 USD on KIE.AI',
      url: 'https://kie.ai/pricing',
      api_endpoint: 'https://api.kie.ai/client/v1/model-pricing/page',
      advantages: [
        '✅ Kling 2.6: 21.43% cheaper than Fal.ai',
        '✅ Kling 3.0: 40.48% cheaper than Fal.ai',
        '✅ Sora 2: 80%+ cheaper than Fal.ai',
        '✅ Seedance 2 / Fast: available directly on KIE.AI',
        '✅ Seedream 5.0 Lite: about 21% cheaper than official/Fal.ai',
        '✅ Stable pricing without surprises'
      ]
    },
    replicate: {
      note: 'Replicate pricing is used to calculate bot token costs',
      our_multiplier: 1.65,
      our_token_usd: 0.01,
      formula: 'tokens = ceil(replicatePrice * 1.65 / 0.01)'
    },
    important: '⚠️ KIE.AI is often cheaper than Replicate. KIE.AI is recommended when available.'
  }
};
