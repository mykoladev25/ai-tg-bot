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
      { name: '✍️ Пишіть', key: 'text', cost: 2, apiCost: 0.015 }, // ✅ ОНОВЛЕНО: 1⚡ → 2⚡
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 5, apiCost: 0.048 } // ✅ ОНОВЛЕНО: 3⚡ → 5⚡
    ]
  },

  video: {
    models: [
      { name: '🎬 RunWay: Gen-4 Turbo ⚡', key: 'runway_turbo', cost: 25, apiCost: 0.25, available: true }, // ✅ ОНОВЛЕНО: 14⚡ → 25⚡
      { name: '🎭 Kling', key: 'kling', cost: 35, apiCost: 0.35, available: true }, // ✅ ОНОВЛЕНО: 30⚡ → 35⚡
      { name: '🎬 RunWay: Gen-4 Aleph 💎', key: 'runway_gen4', cost: 50, apiCost: 0.9, available: false },
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 18, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 15, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 7, apiCost: 0.07, available: true }, // ✅ ОНОВЛЕНО: 4⚡ → 7⚡
      { name: '🍌 Nano Banana PRO 2K', key: 'nano_banana_2k', cost: 15, apiCost: 0.15, resolution: '2K', maxImages: 14, available: true }, // ✅ ОНОВЛЕНО: 10⚡ → 15⚡
      { name: '🍌🍌 Nano Banana PRO 4K', key: 'nano_banana_4k', cost: 30, apiCost: 0.30, resolution: '4K', maxImages: 14, available: true }, // ✅ ОНОВЛЕНО: 20⚡ → 30⚡
      { name: '🌊 Seedream 2K', key: 'seedream_2k', cost: 4, apiCost: 0.04, size: '2K', maxImages: 14, available: true },
      { name: '🌊 Seedream 4.5 4K', key: 'seedream_4k', cost: 8, apiCost: 0.08, size: '4K', maxImages: 14, available: true }, // ✅ ОНОВЛЕНО: 6⚡ → 8⚡
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 4, apiCost: 0.01, maxImages: 1, available: true },
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 5, apiCost: 0.03, maxImages: 1, available: true },
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
        '🎁 10⚡ безкоштовних токенів',
        '✨ Спробуйте всі моделі',
        '',
        '💡 Приклади використання:',
        '• 5× Claude Text (2⚡)',
        '• 2× Claude Vision (5⚡)',
        '• 2× Seedream 2K (4⚡)',
        '• 2× Clarity (4⚡)',
        '• 1× Stable Diffusion (7⚡)',
        '',
        '⚡ Комбінуйте на свій розсуд!'
      ]
    },
    starter: {
      name: 'STARTER',
      tokens: 100,
      price: 299,
      features: [
        '🚀 100⚡ токенів на місяць',
        '💎 Доступ до всіх моделей',
        '',
        '💡 Приклади використання:',
        '• 50× Claude Text (2⚡)',
        '• 20× Claude Vision (5⚡)',
        '• 25× Seedream 2K (4⚡)',
        '• 12× Seedream 4K (8⚡)',
        '• 25× Clarity (4⚡)',
        '• 20× Ideogram (5⚡)',
        '• 14× Stable Diffusion (7⚡)',
        '• 6× Nano Banana 2K (15⚡)',
        '• 3× Nano Banana 4K (30⚡)',
        '• 4× Runway Turbo (25⚡)',
        '• 2× Kling відео (35⚡)',
        '',
        '⚡ Токени - це валюта!',
        '🎨 Комбінуйте моделі як хочете'
      ]
    },
    basic: {
      name: 'BASIC',
      tokens: 300,
      price: 899,
      features: [
        '💎 300⚡ токенів на місяць',
        '🎨 Для активних користувачів',
        '',
        '📊 Приклади використання:',
        '• 150× Claude Text (2⚡)',
        '• 60× Claude Vision (5⚡)',
        '• 75× Seedream 2K (4⚡)',
        '• 37× Seedream 4K (8⚡)',
        '• 75× Clarity (4⚡)',
        '• 60× Ideogram (5⚡)',
        '• 42× Stable Diffusion (7⚡)',
        '• 20× Nano Banana 2K (15⚡)',
        '• 10× Nano Banana 4K (30⚡)',
        '• 12× Runway Turbo (25⚡)',
        '• 8× Kling (35⚡)',
        '',
        '✨ Комбінуйте як завгодно!',
        '🎬 Більше відео та зображень'
      ]
    },
    pro: {
      name: 'PRO',
      tokens: 750,
      price: 1999,
      features: [
        '🔥 750⚡ токенів на місяць',
        '🚀 Для професіоналів',
        '',
        '🎯 Приклади використання:',
        '• 375× Claude Text (2⚡)',
        '• 150× Claude Vision (5⚡)',
        '• 187× Seedream 2K (4⚡)',
        '• 93× Seedream 4K (8⚡)',
        '• 187× Clarity (4⚡)',
        '• 150× Ideogram (5⚡)',
        '• 107× Stable Diffusion (7⚡)',
        '• 50× Nano Banana 2K (15⚡)',
        '• 25× Nano Banana 4K (30⚡)',
        '• 30× Runway Turbo (25⚡)',
        '• 21× Kling (35⚡)',
        '',
        '✨ Пріоритетна підтримка',
        '⚡ Швидша обробка'
      ]
    },
    premium: {
      name: 'PREMIUM',
      tokens: 2000,
      price: 4999,
      features: [
        '👑 2000⚡ токенів на місяць',
        '💫 Максимум можливостей',
        '',
        '🎨 Приклади використання:',
        '• 1000× Claude Text (2⚡)',
        '• 400× Claude Vision (5⚡)',
        '• 500× Seedream 2K (4⚡)',
        '• 250× Seedream 4K (8⚡)',
        '• 500× Clarity (4⚡)',
        '• 400× Ideogram (5⚡)',
        '• 285× Stable Diffusion (7⚡)',
        '• 133× Nano Banana 2K (15⚡)',
        '• 66× Nano Banana 4K (30⚡)',
        '• 80× Runway Turbo (25⚡)',
        '• 57× Kling (35⚡)',
        '',
        '👑 VIP підтримка 24/7',
        '⚡ Найвищий пріоритет',
        '🎁 Ранній доступ до AI'
      ]
    }
  }
};