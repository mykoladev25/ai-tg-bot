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
      { name: '✍️ Пишіть', key: 'text', cost: 1, apiCost: 0.008 },
      { name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 5, apiCost: 0.048 }
    ]
  },

  video: {
    models: [
      { name: '🎬 RunWay: Gen-4 Turbo ⚡', key: 'runway_turbo', cost: 26, apiCost: 0.25, available: true, requiresImage: true },
      { name: '🎭 Kling', key: 'kling', cost: 37, apiCost: 0.35, available: true, requiresImage: false },
      { name: '🔥 Kling Motion <10s', key: 'kling_motion_minimal', cost: 104, apiCost: 1, available: true, requiresImage: true },
      { name: '🔥 Kling Motion 20s+ 💎', key: 'kling_motion', cost: 256, apiCost: 2.46, available: true, requiresImage: true },
      { name: '🎬 RunWay: Gen-4 Aleph 💎', key: 'runway_gen4', cost: 94, apiCost: 0.9, available: false, requiresImage: true },
      { name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 15, apiCost: 0, available: false },
      { name: '💜 HeyGen', key: 'heygen', cost: 12, apiCost: 0, available: false }
    ]
  },

  design: {
    models: [
      { name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 1, apiCost: 0.01, available: true },
      { name: '🍌 Nano Banana PRO 2K', key: 'nano_banana_2k', cost: 16, apiCost: 0.15, resolution: '2K', maxImages: 14, available: true },
      { name: '🍌🍌 Nano Banana PRO 4K', key: 'nano_banana_4k', cost: 31, apiCost: 0.30, resolution: '4K', maxImages: 14, available: true },
      { name: '🌊 Seedream 2K', key: 'seedream_2k', cost: 3, apiCost: 0.03, size: '2K', maxImages: 14, available: true },
      { name: '🌊 Seedream 4.5 4K', key: 'seedream_4k', cost: 6, apiCost: 0.06, size: '4K', maxImages: 14, available: true },
      { name: '🔮 Clarity Upscaler', key: 'clarity', cost: 2, apiCost: 0.02, maxImages: 1, available: true },
      { name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 3, apiCost: 0.03, maxImages: 1, available: true },
      { name: '🖼️ MidJourney', key: 'midjourney', cost: 3, apiCost: 0, available: false }
    ]
  },

  audio: {
    models: [
      { name: '🎵 Suno AI Bark', key: 'suno', cost: 2, apiCost: 0.0023, available: false },
      { name: '🎼 Udio AI', key: 'udio', cost: 6, apiCost: 0, available: false },
      { name: '🎤 ElevenLabs', key: 'elevenlabs', cost: 4, apiCost: 0.03, available: false }
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
        '• 75× Stable Diffusion (1⚡)',
        '• 25× Seedream 2K (3⚡)',
        '• 12× Seedream 4K (6⚡)',
        '• 25× Ideogram (3⚡)',
        '• 37× Clarity (2⚡)',
        '• 4× Nano Banana 2K (16⚡)',
        '• 2× Nano Banana 4K (31⚡)',
        '• 2× Kling відео (37⚡)',
        '',
        '⚡ Токени НЕ згорають!'
      ]
    },

    starter: {
      name: 'STARTER',
      tokens: 240,
      tokensLiqPay: 290,
      price: 299,
      priceUSD: 7,
      features: [
        '🚀 240⚡ токенів',
        '💎 Доступ до всіх моделей',
        '⏰ Токени НЕ згорають',
        '',
        '💡 Що можна згенерувати:',
        '• 240× Stable Diffusion (1⚡)',
        '• 80× Seedream 2K (3⚡)',
        '• 40× Seedream 4K (6⚡)',
        '• 80× Ideogram (3⚡)',
        '• 120× Clarity (2⚡)',
        '• 15× Nano Banana 2K (16⚡)',
        '• 7× Nano Banana 4K (31⚡)',
        '• 9× Runway Turbo (26⚡)',
        '• 6× Kling відео (37⚡)',
        '• 2× Kling Motion <10s (104⚡)',
        '',
        '✨ Комбінуйте як завгодно!'
      ]
    },

    basic: {
      name: 'BASIC',
      tokens: 720,
      tokensLiqPay: 870,
      price: 899,
      priceUSD: 20,
      features: [
        '💎 720⚡ токенів',
        '🎨 Для активних користувачів',
        '⏰ Токени НЕ згорають',
        '',
        '📊 Що можна згенерувати:',
        '• 720× Stable Diffusion (1⚡)',
        '• 240× Seedream 2K (3⚡)',
        '• 120× Seedream 4K (6⚡)',
        '• 240× Ideogram (3⚡)',
        '• 360× Clarity (2⚡)',
        '• 45× Nano Banana 2K (16⚡)',
        '• 23× Nano Banana 4K (31⚡)',
        '• 27× Runway Turbo (26⚡)',
        '• 19× Kling відео (37⚡)',
        '• 6× Kling Motion <10s (104⚡)',
        '• 2× Kling Motion 20s+ 💎 (256⚡)',
        '',
        '✨ Комбінуйте як завгодно!',
        '🎬 Акцент на відео та зображення'
      ]
    },

    pro: {
      name: 'PRO',
      tokens: 1600,
      tokensLiqPay: 1930,
      price: 1999,
      priceUSD: 45,
      features: [
        '🔥 1600⚡ токенів',
        '🚀 Для професіоналів',
        '⏰ Токени НЕ згорають',
        '',
        '🎯 Що можна згенерувати:',
        '• 1600× Stable Diffusion (1⚡)',
        '• 533× Seedream 2K (3⚡)',
        '• 266× Seedream 4K (6⚡)',
        '• 533× Ideogram (3⚡)',
        '• 800× Clarity (2⚡)',
        '• 100× Nano Banana 2K (16⚡)',
        '• 51× Nano Banana 4K (31⚡)',
        '• 61× Runway Turbo (26⚡)',
        '• 43× Kling відео (37⚡)',
        '• 15× Kling Motion <10s (104⚡)',
        '• 6× Kling Motion 20s+ 💎 (256⚡)',
        '',
        '✨ Пріоритетна підтримка',
        '⚡ Найкраще співвідношення'
      ]
    },

    premium: {
      name: 'PREMIUM',
      tokens: 4000,
      tokensLiqPay: 4830,
      price: 4999,
      priceUSD: 110,
      features: [
        '👑 4000⚡ токенів',
        '💫 Максимум можливостей',
        '⏰ Токени НЕ згорають',
        '',
        '🎨 Що можна згенерувати:',
        '• 4000× Stable Diffusion (1⚡)',
        '• 1333× Seedream 2K (3⚡)',
        '• 666× Seedream 4K (6⚡)',
        '• 1333× Ideogram (3⚡)',
        '• 2000× Clarity (2⚡)',
        '• 250× Nano Banana 2K (16⚡)',
        '• 129× Nano Banana 4K (31⚡)',
        '• 153× Runway Turbo (26⚡)',
        '• 108× Kling відео (37⚡)',
        '• 38× Kling Motion <10s (104⚡)',
        '• 15× Kling Motion 20s+ 💎 (256⚡)',
        '',
        '👑 VIP підтримка 24/7',
        '⚡ Найвищий пріоритет',
        '🎁 Ранній доступ до нових AI'
      ]
    }
  }
};