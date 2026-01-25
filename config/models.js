/**
 * Target gross margin (Revenue - API COGS):
 * - Standard models: ~55–65% (competitive + room for ops)
 * - Veo: ~35–40% (competitive; otherwise conversion dies)
 *
 * Calculations anchored to WORST-CASE token value (cheapest plan):
 * PREMIUM: $110 / 4000 = $0.0275 per token
 *
 * Notes:
 * - This is gross margin vs API costs (COGS), not net margin.
 * - If you have high payment fees / retries, consider bumping video costs slightly.
 */

const WORST_CASE_TOKEN_USD = 110 / 4760; // 0.02311

/**
 * TRIAL RESTRICTIONS
 * Моделі/режими заблоковані для Trial користувачів (безкоштовні токени)
 * Причина: захист від зливу бюджету на дорогих генераціях
 */
const TRIAL_RESTRICTIONS = {
    // Повністю заблоковані моделі для Trial
    blockedModels: [
        'veo',              // $0.40/сек з аудіо - дуже дорого
        'kling_motion',     // Motion Control - дорогий + ретраї
        'runway_gen4',      // Преміум відео
    ],

    // Заблоковані режими для окремих моделей
    blockedModes: {
        'kling': {
            durations: [10],  // Тільки 5 сек дозволено, 10 сек - блок
        }
    },

    // Ліміт на кількість генерацій дорогих моделей (за весь час Trial)
    limitedModels: {
        'nano_banana_4k': 1,  // Максимум 1 генерація 4K
        'kling': 2,          // Максимум 2 генерації Kling (будь-якої тривалості)
        'runway_turbo': 1 // Максимум 1 генерація Runway Turbo
    },

    // Повідомлення для заблокованих
    messages: {
        blocked: '🔒 Ця модель доступна тільки для платних користувачів.\n\n💡 Поповніть баланс щоб отримати доступ до всіх можливостей!',
        limited: (remaining) => `⚠️ На Trial залишилось ${remaining} безкоштовних генерацій цієї моделі.\n\n💡 Поповніть баланс для необмеженого доступу!`,
        durationBlocked: '🔒 Тривалість 10+ секунд доступна тільки для платних користувачів.\n\n💡 На Trial доступно тільки 5 секунд.'
    }
};

module.exports = {
    // Експортуємо Trial обмеження
    TRIAL_RESTRICTIONS,

    gpt: {
        models: [
            {name: '🧠 Базові помічники', key: 'gpt_claude', cost: 0, apiCost: 0},
            {name: '👨‍💼 Активувати GPT Editor', key: 'gpt_editor', cost: 0, apiCost: 0},
            {name: '🤖 Керування', key: 'gpt_manage', cost: 0, apiCost: 0},
            {name: '💬 Нова розмова', key: 'new_chat', cost: 0, apiCost: 0},
            {name: '👤 Профіль', key: 'profile', cost: 0, apiCost: 0},
            {name: '📄 Інструкція', key: 'instruction', cost: 0, apiCost: 0}
        ],
        actions: [
            {name: '🎙️ Говоріть', key: 'voice', cost: 0, apiCost: 0},

            // apiCost 0.008, cost=1 -> gross ~71% on worst-case token. OK.
            {name: '✍️ Пишіть', key: 'text', cost: 1, apiCost: 0.008},

            // apiCost 0.048, cost=5 -> gross healthy.
            {name: '🖼️ Завантажте зображення для аналізу', key: 'image', cost: 5, apiCost: 0.048}
        ]
    },

    video: {
        models: [
            /**
             * Runway Turbo
             * apiCost 0.25
             * cost=22 => revenue 22*0.0275=$0.605; gross ~59%
             */
            {
                name: '🎬 RunWay: Gen-4 Turbo ⚡',
                key: 'runway_turbo',
                costPerSecond: 4.4,
                apiCostPerSecond: 0.05,
                cost: 22,
                apiCost: 0.25,
                available: true,
                requiresImage: true,
                durations: [5, 10],
                aspectRatios: ['16:9', '9:16']
            },

            /**
             * Kling v2.5 Turbo
             * apiCostPerSecond 0.07
             * costPerSecond=6 => revenue 6*0.0275=$0.165; gross ~57.6%
             */
            {
                name: '🎭 Kling v2.5 Turbo',
                key: 'kling',
                costPerSecond: 6,
                cost: 30, // default menu (5 sec): 5 * 6
                apiCostPerSecond: 0.07,
                available: true,
                requiresImage: false,
                durations: [5, 10]
            },

            /**
             * Kling Motion Control
             * Keep within ~45–55% gross (expensive category; needs competitiveness)
             *
             * std_image api 0.50, cost 35 => rev 0.9625; gross ~48%
             * std_video api 1.00, cost 70 => rev 1.925;  gross ~48%
             * pro_video api 2.00, cost 140 => rev 3.85;  gross ~48%
             */
            {
                name: '🔥 Kling Motion Control',
                key: 'kling_motion',
                costs: {
                    std_image: 35,    // STD + image (до 10с)
                    std_video: 70,    // STD + video (до 30с)
                    pro_image: 70,    // PRO + image (до 10с)
                    pro_video: 140    // PRO + video (до 30с)
                },
                apiCosts: {
                    std_image: 0.50,
                    std_video: 1.00,
                    pro_image: 1.00,
                    pro_video: 2.00
                },
                cost: 35,
                maxCost: 140,
                available: true,
                requiresImage: true,
                requiresVideo: true
            },

            /**
             * Google Veo 3.1 (Replicate)
             * with_audio:  $0.40/sec
             * without_audio:$0.20/sec
             *
             * Choose ~35–40% gross to stay sellable.
             * audio costPerSecond=24 => rev 0.66; gross ~39%
             * noAudio costPerSecond=12 => rev 0.33; gross ~39%
             * minSeconds=4 enforced.
             */
            {
                name: '🌟 Google Veo 3.1 💎',
                key: 'veo',
                // Target ~35–40% gross on worst-case token price
                costPerSecondAudio: 28,     // було 24
                costPerSecondNoAudio: 14,   // було 12
                minSeconds: 4,
                durations: [4, 8, 12],
                cost: 224, // дефолт для меню (8 сек з аудіо): 8 * 28
                apiCostPerSecondAudio: 0.40,
                apiCostPerSecondNoAudio: 0.20,
                available: true,
                requiresImage: false,
                supportsReferences: true
            },

            {
                name: '🎬 RunWay: Gen-4 Aleph 💎',
                key: 'runway_gen4',
                cost: 94,
                apiCost: 0.9,
                available: false,
                requiresImage: true
            },
            {name: '🌊 MidJourney Video', key: 'midjourney_video', cost: 15, apiCost: 0, available: false},
            {name: '💜 HeyGen', key: 'heygen', cost: 12, apiCost: 0, available: false}
        ]
    },

    design: {
        models: [
            /**
             * Keep standard models roughly 55–70% gross (competitive enough, funds ops).
             */

            // apiCost 0.065 (офіційна ціна Replicate 2026-01), cost=3 => gross ~58%
            {name: '🌀 Stable Diffusion', key: 'stable_diffusion', cost: 3, apiCost: 0.065, available: true},

            // apiCost 0.15, cost=14 => rev 0.385; gross ~61%
            {
                name: '🍌 Nano Banana PRO 2K',
                key: 'nano_banana_2k',
                cost: 14,
                apiCost: 0.15,
                resolution: '2K',
                maxImages: 14,
                available: true
            },

            // apiCost 0.30, cost=27 => rev 0.7425; gross ~59.6%
            {
                name: '🍌🍌 Nano Banana PRO 4K',
                key: 'nano_banana_4k',
                cost: 27,
                apiCost: 0.30,
                resolution: '4K',
                maxImages: 14,
                available: true
            },

            // apiCost 0.04 (офіційна ціна Replicate 2026-01), cost=3 => gross ~63%
            {
                name: '🌊 Seedream 2K',
                key: 'seedream_2k',
                cost: 3,
                apiCost: 0.1,
                size: '2K',
                maxImages: 14,
                available: true
            },

            // apiCost 0.04 (та сама модель, той самий прайс), cost=4 => gross ~63%
            {
                name: '🌊 Seedream 4.5 4K',
                key: 'seedream_4k',
                cost: 4,
                apiCost: 0.15,
                size: '4K',
                maxImages: 14,
                available: true
            },

            // apiCost 0.02, cost=2 => gross ~63.6%
            {name: '🔮 Clarity Upscaler', key: 'clarity', cost: 2, apiCost: 0.02, maxImages: 1, available: true},

            // apiCost 0.03, cost=3 => gross ~63.6%
            {name: '🎯 Ideogram v3.0', key: 'ideogram', cost: 3, apiCost: 0.03, maxImages: 1, available: true},

            {name: '🖼️ MidJourney', key: 'midjourney', cost: 3, apiCost: 0, available: false}
        ]
    },

    audio: {
        models: [
            {name: '🎵 Suno AI Bark', key: 'suno', cost: 2, apiCost: 0.0023, available: false},
            {name: '🎼 Udio AI', key: 'udio', cost: 6, apiCost: 0, available: false},
            {name: '🎤 ElevenLabs', key: 'elevenlabs', cost: 4, apiCost: 0.03, available: false}
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
                '⚡ Токени НЕ згорають!'
            ]
        },

        starter: {
            name: 'STARTER',
            // Stars: ~260 * 0.714 = 186
            tokens: 186,
            tokensLiqPay: 260,
            price: 299,
            priceUSD: 0.1,
            features: [
                '🚀 186⚡ токенів (Telegram Stars)',
                '🚀 260⚡ токенів (LiqPay)',
                '💎 Доступ до всіх моделей',
                '⏰ Токени НЕ згорають',
                '✨ Комбінуйте як завгодно!',
                '📉 Чим більший план — тим дешевший ⚡'
            ]
        },

        basic: {
            name: 'BASIC',
            // Stars: ~870 * 0.714 = 621
            tokens: 620,
            tokensLiqPay: 870,
            price: 899,
            priceUSD: 20,
            features: [
                '💎 620⚡ токенів (Telegram Stars)',
                '💎 870⚡ токенів (LiqPay)',
                '🎨 Для активних користувачів',
                '⏰ Токени НЕ згорають',
                '✨ Комбінуйте як завгодно!',
                '📉 Чим більший план — тим дешевший ⚡'
            ]
        },

        pro: {
            name: 'PRO',
            // Stars: ~2100 * 0.714 = 1500
            tokens: 1500,
            tokensLiqPay: 2100,
            price: 1999,
            priceUSD: 45,
            features: [
                '🔥 1500⚡ токенів (Telegram Stars)',
                '🔥 2100⚡ токенів (LiqPay)',
                '🚀 Для професіоналів',
                '⏰ Токени НЕ згорають',
                '⚡ Найкраще співвідношення',
                '📉 Чим більший план — тим дешевший ⚡'
            ]
        },

        premium: {
            name: 'PREMIUM',
            // Stars: ~5700 * 0.714 = 4071
            tokens: 4080,
            tokensLiqPay: 5700,
            price: 4999,
            priceUSD: 110,
            features: [
                '👑 4080⚡ токенів (Telegram Stars)',
                '👑 5700⚡ токенів (LiqPay)',
                '💫 Максимум можливостей',
                '⏰ Токени НЕ згорають',
                '👑 VIP підтримка 24/7',
                '📉 Найнижча ціна за ⚡'
            ]
        }
    },

    _pricingAssumptions: {
        worstCaseTokenUSD: WORST_CASE_TOKEN_USD,
        standardModelsGrossTarget: '≈55–65%',
        veoGrossTarget: '≈35–40%'
    }
};
