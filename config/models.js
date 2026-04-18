

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
      '🔒 This model is available only to paid users.\n\n💡 Top up your balance to unlock all features.',
    limited: (remaining) =>
      `⚠️ Trial has ${remaining} free generations left for this model.\n\n💡 Top up your balance for unlimited access.`,
    durationBlocked:
      '🔒 Durations above 10 seconds are available only to paid users.\n\n💡 Trial users can generate up to 5 seconds.'
  }
};

module.exports = {
  TRIAL_RESTRICTIONS,

  gpt: {
    models: [
      { name: '🧠 Core assistants', key: 'gpt_claude', cost: 0, apiCost: 0 },
      { name: '👨‍💼 Enable GPT Editor', key: 'gpt_editor', cost: 0, apiCost: 0 },
      { name: '🤖 Controls', key: 'gpt_manage', cost: 0, apiCost: 0 },
      { name: '💬 New conversation', key: 'new_chat', cost: 0, apiCost: 0 },
      { name: '👤 Profile', key: 'profile', cost: 0, apiCost: 0 },
      { name: '📄 Guide', key: 'instruction', cost: 0, apiCost: 0 }
    ],
    actions: [
      { name: '🎙️ Voice', key: 'voice', cost: 0, apiCost: 0 },

      { name: '✍️ Text', key: 'text', cost: 1, apiCost: 0.008 },

      { name: '🖼️ Upload an image for analysis', key: 'image', cost: 1, apiCost: 0.048 },
    ]
  },

  
  video: {
    models: [
      
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

      
      {
        name: '🎭 Kling v2.5 Turbo',
        key: 'kling',
        costPerSecond: 12,
        cost: 60,
        apiCostPerSecond: 0.07,
        available: true,
        requiresImage: true,  
        durations: [5, 10],
        supportsEndImage: true
      },

      
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
        kieAIOnly: true  
      },

      
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
        // Google Gemini direct pricing (audio included by default, billed per second)
        geminiCostPerSecondFast: 25,      // ceil(0.15 * 1.65 / 0.01)
        geminiCostPerSecondQuality: 66,   // ceil(0.40 * 1.65 / 0.01)
        geminiApiCostPerSecondFast: 0.15,
        geminiApiCostPerSecondQuality: 0.40,
        minSeconds: 4,
        durations: [4, 6, 8],
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
        available: false,
        requiresImage: false,
        supportsReferences: true
      },

      /**
       * ByteDance Seedance 2 — KIE.AI ONLY
       * Pricing API (checked 2026-04-04):
       * - no_video_input:
       *   - 480p: $0.095/sec
       *   - 720p: $0.205/sec
       * - with_video_input:
       *   - 480p: $0.0575/sec
       *   - 720p: $0.125/sec
       *
       * Telegram flow currently defaults to no_video_input pricing unless
       * reference video URLs are explicitly attached to the generation state.
       */
      {
        name: '🎞️ ByteDance Seedance 2 💎',
        key: 'seedance_2',
        costPerSecond: 16,  // fallback/min = 480p
        apiCostPerSecond: 0.095,
        costPerSecondByResolution: {
          '480p': 16,
          '720p': 34,
          // Keep 1080p at a fixed pricing floor even if KIE cache is missing or under-reports it.
          '1080p': 85
        },
        apiCostPerSecondByResolution: {
          '480p': 0.095,
          '720p': 0.205,
          '1080p': 0.51
        },
        costPerSecondByInputTypeAndResolution: {
          no_video_input: {
            '480p': 16,
            '720p': 34,
            '1080p': 85
          },
          with_video_input: {
            '480p': 10,
            '720p': 21,
            '1080p': 52
          }
        },
        apiCostPerSecondByInputTypeAndResolution: {
          no_video_input: {
            '480p': 0.095,
            '720p': 0.205,
            '1080p': 0.51
          },
          with_video_input: {
            '480p': 0.0575,
            '720p': 0.125,
            '1080p': 0.31
          }
        },
        cost: 63,
        maxCost: 1275,
        minSeconds: 4,
        durations: [4, 5, 6, 8, 10, 12, 15],
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        available: true,
        requiresImage: false,
        supportsReferences: true,
        supportsAudio: true,
        kieAIOnly: true
      },

      /**
       * ByteDance Seedance 2 Fast — KIE.AI ONLY
       * Pricing API (checked 2026-04-04):
       * - no_video_input:
       *   - 480p: $0.0775/sec
       *   - 720p: $0.165/sec
       * - with_video_input:
       *   - 480p: $0.045/sec
       *   - 720p: $0.10/sec
       *
       * Telegram flow currently defaults to no_video_input pricing unless
       * reference video URLs are explicitly attached to the generation state.
       */
      {
        name: '⚡ ByteDance Seedance 2 Fast',
        key: 'seedance_2_fast',
        costPerSecond: 13,  // fallback/min = 480p
        apiCostPerSecond: 0.0775,
        costPerSecondByResolution: {
          '480p': 13,
          '720p': 28
        },
        apiCostPerSecondByResolution: {
          '480p': 0.0775,
          '720p': 0.165
        },
        costPerSecondByInputTypeAndResolution: {
          no_video_input: {
            '480p': 13,
            '720p': 28
          },
          with_video_input: {
            '480p': 8,
            '720p': 17
          }
        },
        apiCostPerSecondByInputTypeAndResolution: {
          no_video_input: {
            '480p': 0.0775,
            '720p': 0.165
          },
          with_video_input: {
            '480p': 0.045,
            '720p': 0.10
          }
        },
        cost: 52,
        maxCost: 409,
        minSeconds: 4,
        durations: [4, 5, 6, 8, 10, 12, 15],
        resolutions: ['480p', '720p'],
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        available: true,
        requiresImage: false,
        supportsReferences: true,
        supportsAudio: true,
        kieAIOnly: true
      },

      
      {
        name: '✂️ Kling O1 Edit',
        key: 'kling_o1_edit',
        costPerSecond: 14,              
        costPerSecondWithVideo: 21,     
        costPerSecondPro: 19,           
        costPerSecondProWithVideo: 28,  
        apiCostPerSecond: 0.084,
        apiCostPerSecondWithVideo: 0.126,
        apiCostPerSecondPro: 0.112,
        apiCostPerSecondProWithVideo: 0.168,
        minSeconds: 3,
        maxSeconds: 10,
        durations: [3, 5, 7, 10],
        available: true,
        requiresVideo: true,            
        requiresImage: false,
        supportsReferences: true,       // reference_images, start_image, end_image
        modes: ['std', 'pro']
      },

      
      {
        name: '🔥 Unlimited Motion',
        key: 'a2e_motion',
        cost: 60,  
        apiCost: 0.1668,  
        costPerSecond: 12,  
        apiCostPerSecond: 0.03336,  
        durations: [5, 10, 15, 20],
        available: true,
        requiresImage: true,
        a2eOnly: true  
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

      
      {
        name: '🍌 Nano Banana FREE 🎁',
        key: 'nano_banana_free',
        cost: 0,
        apiCost: 0,
        maxImages: 14,
        available: true,
        freeLimit: 3,
        googleDirect: true  
      },

      
      {
        name: '🍌 Nano Banana 2',
        key: 'nano_banana_2',
        cost: 12, // default 1K
        apiCost: 0.067, // default 1K
        costsBySize: {
          '0.5K': 8,
          '1K': 12,
          '2K': 17,
          '4K': 25
        },
        apiCostsBySize: {
          '0.5K': 0.045,
          '1K': 0.067,
          '2K': 0.101,
          '4K': 0.151
        },
        maxImages: 14,
        available: true,
        googleDirect: true,
        googleModel: 'gemini-3.1-flash-image-preview',
        imageSize: '1K'
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

      
      {
        name: '🍌 Nano Banana PRO',
        key: 'nano_banana_pro',
        cost: 25,            
        maxCost: 50,         // 4K
        apiCost: 0.15,       // 2K
        apiCostMax: 0.30,    // 4K
        maxImages: 14,
        available: true,
        costsBySize: {
          '2K': 25,
          '4K': 50
        },
        apiCostsBySize: {
          '2K': 0.15,
          '4K': 0.30
        }
      },

      // nano_banana_2k $0.15 -> 25
      {
        name: '🍌 Nano Banana PRO 2K',
        key: 'nano_banana_2k',
        cost: 25,
        apiCost: 0.15,
        resolution: '2K',
        maxImages: 14,
        available: true,
        menuHidden: true 
      },

      // nano_banana_4k $0.30 -> 50
      {
        name: '🍌🍌 Nano Banana PRO 4K',
        key: 'nano_banana_4k',
        cost: 50,
        apiCost: 0.30,
        resolution: '4K',
        maxImages: 14,
        available: true,
        menuHidden: true 
      },

      // seedream $0.04 -> 7
      { name: '🌊 Seedream 4K', key: 'seedream_4k', cost: 7, apiCost: 0.04, size: '4K', maxImages: 14, available: true },

      /**
       * Seedream 5.0 Lite — KIE.AI ONLY
       * 5.5 credits/image = $0.0275
       * basic = 2K, high = 3K
       * tokens = ceil(0.0275 * 1.65 / 0.01) = 5
       */
      {
        name: '🌊 Seedream 5.0 Lite',
        key: 'seedream_5_lite',
        cost: 5,
        apiCost: 0.0275,
        size: '3K',
        maxImages: 14,
        available: true,
        kieAIOnly: true
      },

      // clarity $0.02 -> 4
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 4, apiCost: 0.02, maxImages: 1, available: true },

      // recraft crisp upscale $0.006 -> 1
      { name: '✨ Recraft Crisp Upscale', key: 'recraft_upscale', cost: 1, apiCost: 0.006, maxImages: 1, available: true },

      // ideogram $0.03 -> 5
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 5, apiCost: 0.03, maxImages: 1, available: true },

      
      {
        name: '🔥 Unlimited Images',
        key: 'a2e_image',
        cost: 10,           
        cost2k: 23,          // 2K
        apiCost: 0.0556,     
        apiCost2k: 0.139,    
        maxImages: 2,        
        available: true,
        a2eOnly: true        
      },

      
      {
        name: '⚡ Z-Image 💎',
        key: 'z_image',
        cost: 1,
        apiCost: 0.004,
        maxImages: 1,
        available: true,
        kieAIOnly: true
      },

      
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
        maxImages: 4,  
        available: false, 
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
      features: ['🎁 7 free tokens', '✨ Try the core models', '⚡ Tokens do not expire']
    },

    starter: {
      name: 'STARTER',
      tokens: 700,
      tokensWayForPay: 700,
      priceUSD: 7,
      price: 552,
      features: ['🚀 700⚡ tokens', '💎 Access to all models', '⏰ Tokens do not expire', '✨ Use them however you like']
    },

    starter_test: {
      name: 'STARTER TEST',
      tokens: 100,
      tokensWayForPay: 10,
      priceUSD: 0.1,
      price: 10,
      priceWayForPayUAH: 4,
      adminOnly: true,
      features: ['🧪 Test package', '⚡ 10 tokens', '🔒 Admin only']
    },

    basic: {
      name: 'BASIC',
      tokens: 1500,
      tokensWayForPay: 1500,
      priceUSD: 15,
      price: 1182,
      features: ['💎 1500⚡ tokens', '🎨 For active users', '⏰ Tokens do not expire', '✨ Use them however you like']
    },

    pro: {
      name: 'PRO',
      tokens: 2900,
      tokensWayForPay: 2900,
      priceUSD: 29,
      price: 2284,
      features: ['🔥 2900⚡ tokens', '🚀 For professionals', '⏰ Tokens do not expire', '⚡ Best value']
    },

    premium: {
      name: 'PREMIUM',
      tokens: 5900,
      tokensWayForPay: 5900,
      priceUSD: 59,
      price: 4646,
      features: ['👑 5900⚡ tokens', '💫 Maximum capability', '⏰ Tokens do not expire', '👑 VIP support']
    }
  },


  _pricingAssumptions: {
    tokenUSD: TOKEN_USD,
    pricingMultiplier: PRICING_MULTIPLIER,
    wayforpayOverhead: WAYFORPAY_OVERHEAD,
    targetProfitAfterFees: TARGET_PROFIT_AFTER_FEES,
    netRevenueFactor: NET_REVENUE_FACTOR,
    pricingRule: 'tokens = ceil(apiCostUSD * PRICING_MULTIPLIER / TOKEN_USD)',
    note: 'pricing is based on PRICING_MULTIPLIER=1.65 (about 30% after fees plus buffer)'
  }
};
