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
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 3, apiCost: 0.048 }
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
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 4, apiCost: 0.07, available: true },
      { name: '🍌 Nano Banana PRO 2K', key: 'nano_banana_2k', cost: 10, apiCost: 0.15, resolution: '2K', maxImages: 14, available: true },
      { name: '🍌🍌 Nano Banana PRO 4K', key: 'nano_banana_4k', cost: 20, apiCost: 0.30, resolution: '4K', maxImages: 14, available: true },
      { name: '🌊 Seedream 2K', key: 'seedream_2k', cost: 4, apiCost: 0.04, size: '2K', available: true },
      { name: '🌊 Seedream 4.5 4K', key: 'seedream_4k', cost: 6, apiCost: 0.08, size: '4K', available: true },
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
      '🎁 10⚡ безкоштовних токенів',
      '✨ Спробуйте всі моделі',
      '',
      '💡 Приклади використання:',
      '• 10× Claude Text (1⚡)',
      '• 3× Claude Vision (3⚡)',
      '• 2× Seedream 2K (4⚡)',
      '• 2× Stable Diffusion (4⚡)',
      '• 1× Nano Banana 2K (10⚡)',
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
      '• 100× Claude Text (1⚡)',
      '• 33× Claude Vision (3⚡)',
      '• 25× Seedream 2K (4⚡)',
      '• 16× Seedream 4K (6⚡)',
      '• 25× Stable Diffusion (4⚡)',
      '• 20× Ideogram (5⚡)',
      '• 10× Nano Banana 2K (10⚡)',
      '• 5× Nano Banana 4K (20⚡)',
      '• 7× Runway Turbo (14⚡)',
      '• 3× Kling відео (30⚡)',
      '',
      '⚡ Токени - це валюта!',
      '🎨 Змішуйте моделі як хочете'
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
      '• 300× Claude Text (1⚡)',
      '• 100× Claude Vision (3⚡)',
      '• 75× Seedream 2K (4⚡)',
      '• 50× Seedream 4K (6⚡)',
      '• 75× Stable Diffusion (4⚡)',
      '• 60× Ideogram (5⚡)',
      '• 30× Nano Banana 2K (10⚡)',
      '• 15× Nano Banana 4K (20⚡)',
      '• 21× Runway Turbo (14⚡)',
      '• 10× Kling (30⚡)',
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
      '• 750× Claude Text (1⚡)',
      '• 250× Claude Vision (3⚡)',
      '• 187× Seedream 2K (4⚡)',
      '• 125× Seedream 4K (6⚡)',
      '• 187× Stable Diffusion (4⚡)',
      '• 150× Ideogram (5⚡)',
      '• 75× Nano Banana 2K (10⚡)',
      '• 37× Nano Banana 4K (20⚡)',
      '• 53× Runway Turbo (14⚡)',
      '• 25× Kling (30⚡)',
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
      '• 2000× Claude Text (1⚡)',
      '• 666× Claude Vision (3⚡)',
      '• 500× Seedream 2K (4⚡)',
      '• 333× Seedream 4K (6⚡)',
      '• 500× Stable Diffusion (4⚡)',
      '• 400× Ideogram (5⚡)',
      '• 200× Nano Banana 2K (10⚡)',
      '• 100× Nano Banana 4K (20⚡)',
      '• 142× Runway Turbo (14⚡)',
      '• 66× Kling (30⚡)',
      '',
      '👑 VIP підтримка 24/7',
      '⚡ Найвищий пріоритет',
      '🎁 Ранній доступ до AI'
    ]
  }
}
};