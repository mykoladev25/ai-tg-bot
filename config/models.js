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
      { name: '✍️ Пишіть', key: 'text', cost: 3, apiCost: 0.015 }, // ✅ ОНОВЛЕНО: 2⚡ → 3⚡
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 8, apiCost: 0.048 } // ✅ ОНОВЛЕНО: 5⚡ → 8⚡
    ]
  },

  video: {
    models: [
      { name: '🎬 RunWay: Gen-4 Turbo ⚡', key: 'runway_turbo', cost: 42, apiCost: 0.25, available: true, requiresImage: true }, // ✅ ОНОВЛЕНО: 30⚡ → 42⚡
      { name: '🎭 Kling', key: 'kling', cost: 60, apiCost: 0.35, available: true, requiresImage: false }, // ✅ ОНОВЛЕНО: 35⚡ → 60⚡
      { name: '🎬 RunWay: Gen-4 Aleph 💎', key: 'runway_gen4', cost: 150, apiCost: 0.9, available: false, requiresImage: true }, // ✅ ОНОВЛЕНО: 50⚡ → 150⚡
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 18, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 15, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 12, apiCost: 0.07, available: true }, // ✅ ОНОВЛЕНО: 7⚡ → 12⚡
      { name: '🍌 Nano Banana PRO 2K', key: 'nano_banana_2k', cost: 25, apiCost: 0.15, resolution: '2K', maxImages: 14, available: true }, // ✅ ОНОВЛЕНО: 15⚡ → 25⚡
      { name: '🍌🍌 Nano Banana PRO 4K', key: 'nano_banana_4k', cost: 50, apiCost: 0.30, resolution: '4K', maxImages: 14, available: true }, // ✅ ОНОВЛЕНО: 30⚡ → 50⚡
      { name: '🌊 Seedream 2K', key: 'seedream_2k', cost: 7, apiCost: 0.04, size: '2K', maxImages: 14, available: true }, // ✅ ОНОВЛЕНО: 4⚡ → 7⚡
      { name: '🌊 Seedream 4.5 4K', key: 'seedream_4k', cost: 14, apiCost: 0.08, size: '4K', maxImages: 14, available: true }, // ✅ ОНОВЛЕНО: 8⚡ → 14⚡
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 3, apiCost: 0.01, maxImages: 1, available: true }, // ✅ ОНОВЛЕНО: 4⚡ → 3⚡
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 6, apiCost: 0.03, maxImages: 1, available: true }, // ✅ ОНОВЛЕНО: 5⚡ → 6⚡
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
        '• 3× Claude Text (3⚡)',
        '• 3× Clarity (3⚡)',
        '• 1× Seedream 2K (7⚡)',
        '• 1× Ideogram (6⚡)',
        '• 1× Claude Vision (8⚡)',
        '',
        '⚡ Комбінуйте на свій розсуд!'
      ]
    },
    starter: {
      name: 'STARTER',
      tokens: 150, // ✅ ПІДВИЩЕНО: 100⚡ → 150⚡
      price: 299,
      features: [
        '🚀 150⚡ токенів на місяць',
        '💎 Доступ до всіх моделей',
        '',
        '💡 Приклади використання:',
        '• 50× Claude Text (3⚡)',
        '• 18× Claude Vision (8⚡)',
        '• 21× Seedream 2K (7⚡)',
        '• 10× Seedream 4K (14⚡)',
        '• 50× Clarity (3⚡)',
        '• 25× Ideogram (6⚡)',
        '• 12× Stable Diffusion (12⚡)',
        '• 6× Nano Banana 2K (25⚡)',
        '• 3× Nano Banana 4K (50⚡)',
        '• 3× Runway Turbo (42⚡)',
        '• 2× Kling відео (60⚡)',
        '',
        '⚡ Токени - це валюта!',
        '🎨 Комбінуйте моделі як хочете'
      ]
    },
    basic: {
      name: 'BASIC',
      tokens: 450, // ✅ ПІДВИЩЕНО: 300⚡ → 450⚡
      price: 899,
      features: [
        '💎 450⚡ токенів на місяць',
        '🎨 Для активних користувачів',
        '',
        '📊 Приклади використання:',
        '• 150× Claude Text (3⚡)',
        '• 56× Claude Vision (8⚡)',
        '• 64× Seedream 2K (7⚡)',
        '• 32× Seedream 4K (14⚡)',
        '• 150× Clarity (3⚡)',
        '• 75× Ideogram (6⚡)',
        '• 37× Stable Diffusion (12⚡)',
        '• 18× Nano Banana 2K (25⚡)',
        '• 9× Nano Banana 4K (50⚡)',
        '• 10× Runway Turbo (42⚡)',
        '• 7× Kling (60⚡)',
        '',
        '✨ Комбінуйте як завгодно!',
        '🎬 Більше відео та зображень'
      ]
    },
    pro: {
      name: 'PRO',
      tokens: 1100, // ✅ ПІДВИЩЕНО: 750⚡ → 1100⚡
      price: 1999,
      features: [
        '🔥 1100⚡ токенів на місяць',
        '🚀 Для професіоналів',
        '',
        '🎯 Приклади використання:',
        '• 366× Claude Text (3⚡)',
        '• 137× Claude Vision (8⚡)',
        '• 157× Seedream 2K (7⚡)',
        '• 78× Seedream 4K (14⚡)',
        '• 366× Clarity (3⚡)',
        '• 183× Ideogram (6⚡)',
        '• 91× Stable Diffusion (12⚡)',
        '• 44× Nano Banana 2K (25⚡)',
        '• 22× Nano Banana 4K (50⚡)',
        '• 26× Runway Turbo (42⚡)',
        '• 18× Kling (60⚡)',
        '',
        '✨ Пріоритетна підтримка',
        '⚡ Швидша обробка'
      ]
    },
    premium: {
      name: 'PREMIUM',
      tokens: 2800, // ✅ ПІДВИЩЕНО: 2000⚡ → 2800⚡
      price: 4999,
      features: [
        '👑 2800⚡ токенів на місяць',
        '💫 Максимум можливостей',
        '',
        '🎨 Приклади використання:',
        '• 933× Claude Text (3⚡)',
        '• 350× Claude Vision (8⚡)',
        '• 400× Seedream 2K (7⚡)',
        '• 200× Seedream 4K (14⚡)',
        '• 933× Clarity (3⚡)',
        '• 466× Ideogram (6⚡)',
        '• 233× Stable Diffusion (12⚡)',
        '• 112× Nano Banana 2K (25⚡)',
        '• 56× Nano Banana 4K (50⚡)',
        '• 66× Runway Turbo (42⚡)',
        '• 46× Kling (60⚡)',
        '',
        '👑 VIP підтримка 24/7',
        '⚡ Найвищий пріоритет',
        '🎁 Ранній доступ до AI'
      ]
    }
  }
};