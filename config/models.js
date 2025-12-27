module.exports = {
  gpt: {
    models: [
      { name: '💡 Claude', key: 'gpt_claude', cost: 0, apiCost: 0 },
      { name: '👨‍💼 Активувати GPT Editor', key: 'gpt_editor', cost: 0, apiCost: 0 },
      { name: '🤖 Керування', key: 'gpt_manage', cost: 0, apiCost: 0 },
      { name: '💬 Нова розмова', key: 'new_chat', cost: 0, apiCost: 0 },
      { name: '👤 Профіль', key: 'profile', cost: 0, apiCost: 0 },
      { name: '📄 Інструкція', key: 'instruction', cost: 0, apiCost: 0 }
    ],
    actions: [
      { name: '🎙️ Говоріть', key: 'voice', cost: 0, apiCost: 0 }, // Groq Whisper безкоштовно
      { name: '✍️ Пишіть', key: 'text', cost: 0.5, apiCost: 0.015 }, // Claude Sonnet
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 1, apiCost: 0.048 } // Claude Vision
    ]
  },

  video: {
    models: [
      { name: '🎬 RunWay(Aleph): Gen-4 💎', key: 'runway_gen4', cost: 25, apiCost: 0.9, available: true },
      { name: '🎬 RunWay: Gen-4 Turbo ⚡', key: 'runway_turbo', cost: 18, apiCost: 0.45, available: true },
      { name: '🎭 Kling', key: 'kling', cost: 10, apiCost: 0.025, available: true },
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 18, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 15, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      { name: '🖼️ MidJourney', key: 'midjourney', cost: 4, apiCost: 0, available: false },
      { name: '🍌 Nano Banana PRO', key: 'nano_banana', cost: 5, apiCost: 0.003, available: true }, // Google
      { name: '🌊 Seedream 4.5', key: 'seedream', cost: 6, apiCost: 0.003, available: true }, // ByteDance
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 7, apiCost: 0.017, available: true }, // philz1337x - $0.017
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 2, apiCost: 0.0039, available: true }, // $0.0039
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 8, apiCost: 0.03, available: true } // Turbo - $0.03
    ]
  },

  audio: {
    models: [
      { name: '🎵 Suno AI Bark', key: 'suno', cost: 3, apiCost: 0.0023, available: true },
      { name: '🎼 Udio AI', key: 'udio', cost: 8, apiCost: 0, available: false },
      { name: '🎤 ElevenLabs', key: 'elevenlabs', cost: 5, apiCost: 0.03, available: false }
    ]
  },

  subscriptions: {
    trial: {
      name: 'TRIAL',
      tokens: 10,
      price: 0,
      features: [
        '🎁 Безкоштовні пробні токени',
        '✅ Спробуйте всі доступні моделі',
        '',
        'Можливості:',
        '- До 5 зображень (Stable Diffusion)',
        '- До 2 зображень (Nano Banana)',
        '- До 1 зображення (Seedream)',
        '- До 1 відео (Kling)',
        '- До 10 аналізів зображень Claude',
        '- Необмежені текстові запити'
      ]
    },
    starter: {
      name: 'STARTER',
      tokens: 100,
      price: 299,
      features: [
        '🚀 Стартовий пакет',
        '',
        'Доступно:',
        '+ До 50 зображень (Stable Diffusion)',
        '+ До 20 зображень (Nano Banana)',
        '+ До 16 зображень (Seedream)',
        '+ До 14 покращень (Clarity Upscaler)',
        '+ До 12 зображень (Ideogram Turbo)',
        '+ До 10 відео (Kling)',
        '+ До 6 відео (Runway)',
        '+ До 100 аналізів зображень',
        '+ Необмежені текстові запити Claude'
      ]
    },
    basic: {
      name: 'BASIC',
      tokens: 260,
      price: 799,
      features: [
        '💎 BASIC',
        '',
        'Доступні моделі:',
        '🌀 Stable Diffusion',
        '🍌 Nano Banana PRO',
        '🌊 Seedream 4.5',
        '🔮 Clarity Upscaler',
        '🎯 Ideogram v3.0 Turbo',
        '🎭 Kling Video',
        '🎬 Runway Gen-4',
        '',
        '+ До 130 зображень (Stable Diffusion)',
        '+ До 52 зображень (Nano Banana)',
        '+ До 43 зображень (Seedream)',
        '+ До 37 покращень (Clarity)',
        '+ До 31 зображення (Ideogram)',
        '+ До 26 відео (Kling)',
        '+ До 17 відео (Runway)',
        '+ До 260 аналізів зображень',
        '+ Необмежені текстові запити'
      ]
    },
    pro: {
      name: 'PRO',
      tokens: 600,
      price: 1699,
      features: [
        '🔥 PRO',
        '',
        'Усі моделі з BASIC +',
        '',
        '+ До 300 зображень (Stable Diffusion)',
        '+ До 120 зображень (Nano Banana)',
        '+ До 100 зображень (Seedream)',
        '+ До 85 покращень (Clarity)',
        '+ До 75 зображень (Ideogram)',
        '+ До 60 відео (Kling)',
        '+ До 40 відео (Runway)',
        '+ До 600 аналізів зображень',
        '+ Необмежені текстові запити',
        '+ Пріоритетна підтримка'
      ]
    },
    premium: {
      name: 'PREMIUM',
      tokens: 1500,
      price: 3999,
      features: [
        '👑 PREMIUM',
        '',
        'Усі моделі + максимальні можливості',
        '',
        '+ До 750 зображень (Stable Diffusion)',
        '+ До 300 зображень (Nano Banana)',
        '+ До 250 зображень (Seedream)',
        '+ До 215 покращень (Clarity)',
        '+ До 187 зображень (Ideogram)',
        '+ До 150 відео (Kling)',
        '+ До 100 відео (Runway)',
        '+ До 1500 аналізів зображень',
        '+ Необмежені текстові запити',
        '+ VIP підтримка 24/7'
      ]
    }
  }
};