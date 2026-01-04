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
      { name: '✍️ Пишіть', key: 'text', cost: 3, apiCost: 0.008 }, // ✅ ВИПРАВЛЕНО: 0.015 → 0.008
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 8, apiCost: 0.048 } // ✅ Правильно
    ]
  },

  video: {
    models: [
      { name: '🎬 RunWay: Gen-4 Turbo ⚡', key: 'runway_turbo', cost: 42, apiCost: 0.25, available: true, requiresImage: true }, // ✅ Правильно
      { name: '🎭 Kling', key: 'kling', cost: 60, apiCost: 0.35, available: true, requiresImage: false }, // ✅ Правильно
      { name: '🎬 RunWay: Gen-4 Aleph 💎', key: 'runway_gen4', cost: 150, apiCost: 0.9, available: false, requiresImage: true }, // ✅ Правильно
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 18, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 15, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 12, apiCost: 0.01, available: true }, // ✅ ВИПРАВЛЕНО: 0.07 → 0.01
      { name: '🍌 Nano Banana PRO 2K', key: 'nano_banana_2k', cost: 25, apiCost: 0.15, resolution: '2K', maxImages: 14, available: true }, // ✅ Правильно
      { name: '🍌🍌 Nano Banana PRO 4K', key: 'nano_banana_4k', cost: 50, apiCost: 0.30, resolution: '4K', maxImages: 14, available: true }, // ✅ Правильно (подвоєно)
      { name: '🌊 Seedream 2K', key: 'seedream_2k', cost: 7, apiCost: 0.03, size: '2K', maxImages: 14, available: true }, // ✅ ВИПРАВЛЕНО: 0.04 → 0.03
      { name: '🌊 Seedream 4.5 4K', key: 'seedream_4k', cost: 14, apiCost: 0.06, size: '4K', maxImages: 14, available: true }, // ✅ ВИПРАВЛЕНО: 0.08 → 0.06 (подвоєно)
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 3, apiCost: 0.02, maxImages: 1, available: true }, // ✅ ВИПРАВЛЕНО: 0.01 → 0.02
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 6, apiCost: 0.03, maxImages: 1, available: true }, // ✅ Правильно
      { name: '🖼️ MidJourney', key: 'midjourney', cost: 4, apiCost: 0, available: false }
    ]
  },

  audio: {
    models: [
      { name: '🎵 Suno AI Bark', key: 'suno', cost: 3, apiCost: 0.0023, available: false }, // ✅ ВИПРАВЛЕНО: 0.01 → 0.0023
      { name: '🎼 Udio AI', key: 'udio', cost: 8, apiCost: 0, available: false },
      { name: '🎤 ElevenLabs', key: 'elevenlabs', cost: 5, apiCost: 0.03, available: false }
    ]
  },

  subscriptions: {
    trial: {
      name: 'TRIAL',
      tokens: 75,
      price: 0,
      features: [
        '🎁 75⚡ безкоштовних токенів',
        '✨ Спробуйте всі моделі',
        '',
        '💡 Що можна згенерувати:',
        '• 25× Claude Text (3⚡)',
        '• 9× Claude Vision (8⚡)',
        '• 10× Seedream 2K (7⚡)',
        '• 12× Ideogram (6⚡)',
        '• 25× Clarity Upscaler (3⚡)',
        '• 6× Stable Diffusion (12⚡)',
        '• 1× Kling відео (60⚡)',
        '',
        '⚡ Токени НЕ згорають!'
      ]
    },
    
    starter: {
      name: 'STARTER',
      tokens: 600,
      price: 299,
      features: [
        '🚀 600⚡ токенів',
        '💎 Доступ до всіх моделей',
        '⏰ Токени НЕ згорають',
        '',
        '💡 Що можна згенерувати:',
        '• 200× Claude Text (3⚡)',
        '• 75× Claude Vision (8⚡)',
        '• 85× Seedream 2K (7⚡)',
        '• 100× Ideogram (6⚡)',
        '• 200× Clarity (3⚡)',
        '• 50× Stable Diffusion (12⚡)',
        '• 24× Nano Banana 2K (25⚡)',
        '• 14× Runway Turbo (42⚡)',
        '• 10× Kling відео (60⚡)',
        '',
        '✨ Комбінуйте як завгодно!'
      ]
    },
    
    basic: {
      name: 'BASIC',
      tokens: 2000,
      price: 899,
      features: [
        '💎 2000⚡ токенів',
        '🎨 Для активних користувачів',
        '⏰ Токени НЕ згорають',
        '',
        '📊 Що можна згенерувати:',
        '• 666× Claude Text (3⚡)',
        '• 250× Claude Vision (8⚡)',
        '• 285× Seedream 2K (7⚡)',
        '• 142× Seedream 4K (14⚡)',
        '• 333× Ideogram (6⚡)',
        '• 666× Clarity (3⚡)',
        '• 166× Stable Diffusion (12⚡)',
        '• 80× Nano Banana 2K (25⚡)',
        '• 40× Nano Banana 4K (50⚡)',
        '• 47× Runway Turbo (42⚡)',
        '• 33× Kling (60⚡)',
        '',
        '🎬 Акцент на відео та зображення'
      ]
    },
    
    pro: {
      name: 'PRO',
      tokens: 5000,
      price: 1999,
      features: [
        '🔥 5000⚡ токенів',
        '🚀 Для професіоналів',
        '⏰ Токени НЕ згорають',
        '',
        '🎯 Що можна згенерувати:',
        '• 1666× Claude Text (3⚡)',
        '• 625× Claude Vision (8⚡)',
        '• 714× Seedream 2K (7⚡)',
        '• 357× Seedream 4K (14⚡)',
        '• 833× Ideogram (6⚡)',
        '• 1666× Clarity (3⚡)',
        '• 416× Stable Diffusion (12⚡)',
        '• 200× Nano Banana 2K (25⚡)',
        '• 100× Nano Banana 4K (50⚡)',
        '• 119× Runway Turbo (42⚡)',
        '• 83× Kling (60⚡)',
        '',
        '✨ Пріоритетна підтримка',
        '⚡ Найкраще співвідношення'
      ]
    },
    
    premium: {
      name: 'PREMIUM',
      tokens: 12500,
      price: 4999,
      features: [
        '👑 12500⚡ токенів',
        '💫 Максимум можливостей',
        '⏰ Токени НЕ згорають',
        '',
        '🎨 Що можна згенерувати:',
        '• 4166× Claude Text (3⚡)',
        '• 1562× Claude Vision (8⚡)',
        '• 1785× Seedream 2K (7⚡)',
        '• 892× Seedream 4K (14⚡)',
        '• 2083× Ideogram (6⚡)',
        '• 4166× Clarity (3⚡)',
        '• 1041× Stable Diffusion (12⚡)',
        '• 500× Nano Banana 2K (25⚡)',
        '• 250× Nano Banana 4K (50⚡)',
        '• 297× Runway Turbo (42⚡)',
        '• 208× Kling (60⚡)',
        '',
        '👑 VIP підтримка 24/7',
        '⚡ Найвищий пріоритет',
        '🎁 Ранній доступ до нових AI'
      ]
    }
  }
};