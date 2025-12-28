module.exports = {
  gpt: {
    models: [
      { name: '💡 Базові помічники', key: 'gpt_claude', cost: 0, apiCost: 0 },
      { name: '👨‍💼 Активувати GPT Editor', key: 'gpt_editor', cost: 0, apiCost: 0 },
      { name: '🤖 Керування', key: 'gpt_manage', cost: 0, apiCost: 0 },
      { name: '💬 Нова розмова', key: 'new_chat', cost: 0, apiCost: 0 },
      { name: '👤 Профіль', key: 'profile', cost: 0, apiCost: 0 },
      { name: '📄 Інструкція', key: 'instruction', cost: 0, apiCost: 0 }
    ],
    actions: [
      { name: '🎙️ Говоріть', key: 'voice', cost: 0, apiCost: 0 },
      { name: '✍️ Пишіть', key: 'text', cost: 1, apiCost: 0.015 },
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 3, apiCost: 0.048 } // ✅ ПІДВИЩЕНО: було 2⚡
    ]
  },

  video: {
    models: [
      { name: '🎬 RunWay: Gen-4 Turbo ⚡', key: 'runway_turbo', cost: 14, apiCost: 0.25, available: true },
      { name: '🎭 Kling', key: 'kling', cost: 30, apiCost: 0.35, available: true },
      { name: '🎬 RunWay: Gen-4 Aleph 💎', key: 'runway_gen4', cost: 50, apiCost: 0.9, available: false },
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 18, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 15, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 1, apiCost: 0.01, available: true },
      { name: '🍌 Nano Banana PRO', key: 'nano_banana', cost: 2, apiCost: 0.01, available: true },
      { name: '🌊 Seedream 4.5', key: 'seedream', cost: 3, apiCost: 0.03, available: true },
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 4, apiCost: 0.01, available: true },
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 5, apiCost: 0.03, available: true },
      { name: '🖼️ MidJourney', key: 'midjourney', cost: 4, apiCost: 0, available: false }
    ]
  },

  audio: {
    models: [
      { name: '🎵 Suno AI Bark', key: 'suno', cost: 3, apiCost: 0.01, available: false },
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
        '- До 10 зображень (Stable Diffusion)',
        '- До 5 зображень (Nano Banana)',
        '- До 3 зображень (Seedream)',
        '- До 2 покращень (Clarity)',
        '- До 2 зображень (Ideogram)',
        '- До 3 аналізів (Claude Vision)',
        '- До 10 текстів (Claude)'
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
        '+ До 100 зображень (Stable Diffusion)',
        '+ До 50 зображень (Nano Banana)',
        '+ До 33 зображень (Seedream)',
        '+ До 25 покращень (Clarity)',
        '+ До 20 зображень (Ideogram)',
        '+ До 7 відео (Runway Turbo)',
        '+ До 3 відео (Kling)',
        '+ До 33 аналізів (Claude Vision)',
        '+ До 100 текстів (Claude)'
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
        '🎯 Ideogram v3.0',
        '🎭 Kling Video',
        '🎬 Runway Turbo',
        '',
        '+ До 260 зображень (Stable Diffusion)',
        '+ До 130 зображень (Nano Banana)',
        '+ До 86 зображень (Seedream)',
        '+ До 65 покращень (Clarity)',
        '+ До 52 зображень (Ideogram)',
        '+ До 18 відео (Runway Turbo)',
        '+ До 8 відео (Kling)',
        '+ До 86 аналізів (Claude Vision)',
        '+ До 260 текстів (Claude)'
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
        '+ До 600 зображень (Stable Diffusion)',
        '+ До 300 зображень (Nano Banana)',
        '+ До 200 зображень (Seedream)',
        '+ До 150 покращень (Clarity)',
        '+ До 120 зображень (Ideogram)',
        '+ До 42 відео (Runway Turbo)',
        '+ До 20 відео (Kling)',
        '+ До 200 аналізів (Claude Vision)',
        '+ До 600 текстів (Claude)',
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
        '+ До 1500 зображень (Stable Diffusion)',
        '+ До 750 зображень (Nano Banana)',
        '+ До 500 зображень (Seedream)',
        '+ До 375 покращень (Clarity)',
        '+ До 300 зображень (Ideogram)',
        '+ До 107 відео (Runway Turbo)',
        '+ До 50 відео (Kling)',
        '+ До 500 аналізів (Claude Vision)',
        '+ До 1500 текстів (Claude)',
        '+ VIP підтримка 24/7'
      ]
    }
  }
};