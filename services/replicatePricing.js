/**
 * Replicate Pricing Service
 *
 * Replicate не має публічного API для отримання цін моделей.
 * АЛЕ можна:
 * 1. Парсити ціни зі сторінки моделі (ненадійно)
 * 2. Рахувати реальну вартість з metrics відповіді
 * 3. Вручну оновлювати pricing з офіційних сторінок
 *
 * Цей сервіс допомагає відстежувати реальні витрати та
 * порівнювати з нашими apiCost в models.js
 */

const axios = require('axios');
const models = require('../config/models');

// Кеш для pricing (оновлюється раз на день)
let pricingCache = null;
let lastPricingUpdate = 0;
const PRICING_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 години

/**
 * Офіційні ціни Replicate (станом на 2026-01)
 * Джерело: https://replicate.com/pricing
 *
 * ⚠️ ВАЖЛИВО: Перевіряйте ці ціни регулярно!
 * Replicate може змінювати pricing без попередження.
 */
const OFFICIAL_PRICING = {
  // === ЗОБРАЖЕННЯ ===
  'stability-ai/stable-diffusion-3.5-large': {
    pricePerRun: 0.065,  // Fixed price per run
    model: 'stable_diffusion',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/stability-ai/stable-diffusion-3.5-large'
  },

  // Nano Banana - ціна залежить від resolution!
  'google/nano-banana': {
    pricePerRun: 0.039,  // $0.039 per image
    model: 'nano_banana',
    lastChecked: '2026-01-26',
    source: 'https://replicate.com/google/nano-banana'
  },
  'google/nano-banana-pro-2k': {
    pricePerRun: 0.15,  // 1K та 2K = $0.15
    model: 'nano_banana_2k',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/google/nano-banana-pro'
  },
  'google/nano-banana-pro-4k': {
    pricePerRun: 0.30,  // 4K = $0.30
    model: 'nano_banana_4k',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/google/nano-banana-pro'
  },

  'bytedance/seedream-4.5-2k': {
    pricePerRun: 0.04,  // $0.04 per image (однакова ціна для всіх resolution)
    model: 'seedream_2k',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/bytedance/seedream-4.5'
  },
  'bytedance/seedream-4.5-4k': {
    pricePerRun: 0.04,  // $0.04 per image (однакова ціна для всіх resolution)
    model: 'seedream_4k',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/bytedance/seedream-4.5'
  },

  'ideogram-ai/ideogram-v3': {
    pricePerRun: 0.03,
    model: 'ideogram',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/ideogram-ai/ideogram-v3'
  },

  'philz1337x/clarity-upscaler': {
    pricePerRun: 0.02,
    model: 'clarity',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/philz1337x/clarity-upscaler'
  },
  'recraft-ai/recraft-crisp-upscale': {
    pricePerRun: 0.006,
    model: 'recraft_upscale',
    lastChecked: '2026-01-26',
    source: 'https://replicate.com/recraft-ai/recraft-crisp-upscale'
  },

  // === ВІДЕО ===
  'kwaivgi/kling-v2.5-turbo-pro': {
    pricePerSecond: 0.07,
    model: 'kling',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/kwaivgi/kling-v2.5-turbo-pro'
  },
  'kwaivgi/kling-v2.6': {
    pricePerSecond: 0.07,
    pricePerSecondNoAudio: 0.07,
    pricePerSecondAudio: 0.14,
    model: 'kling_v2_6',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/kwaivgi/kling-v2.6'
  },

  'google/veo-3.1': {
    pricePerSecondAudio: 0.40,
    pricePerSecondNoAudio: 0.20,
    model: 'veo',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/google/veo-3.1'
  },

  'runway/gen-4-turbo': {
    pricePerRun: 0.25,  // 5 sec video
    model: 'runway_turbo',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/runway/gen-4-turbo'
  }
};

/**
 * Мапінг наших моделей до Replicate моделей
 */
const MODEL_MAPPING = {
  'stable_diffusion': 'stability-ai/stable-diffusion-3.5-large',
  'nano_banana': 'google/nano-banana',
  'nano_banana_2k': 'google/nano-banana-pro-2k',
  'nano_banana_4k': 'google/nano-banana-pro-4k',
  'seedream_2k': 'bytedance/seedream-4.5-2k',
  'seedream_4k': 'bytedance/seedream-4.5-4k',
  'ideogram': 'ideogram-ai/ideogram-v3',
  'clarity': 'philz1337x/clarity-upscaler',
  'recraft_upscale': 'recraft-ai/recraft-crisp-upscale',
  'kling': 'kwaivgi/kling-v2.5-turbo-pro',
  'kling_v2_6': 'kwaivgi/kling-v2.6',
  'kling_motion': 'kwaivgi/kling-v2.5-turbo-pro',
  'veo': 'google/veo-3.1',
  'runway_turbo': 'runway/gen-4-turbo'
};

/**
 * Отримати офіційну ціну для моделі
 */
function getOfficialPrice(modelKey) {
  const replicateModel = MODEL_MAPPING[modelKey];
  if (!replicateModel) return null;

  return OFFICIAL_PRICING[replicateModel] || null;
}

/**
 * Порівняти наші ціни з офіційними
 * @returns {Array} Список розбіжностей
 */
function comparePrices() {
  const discrepancies = [];

  // Перевіряємо design models
  for (const model of models.design.models) {
    const official = getOfficialPrice(model.key);
    if (official && official.pricePerRun) {
      const diff = Math.abs(model.apiCost - official.pricePerRun);
      const diffPercent = (diff / official.pricePerRun) * 100;

      if (diffPercent > 10) { // Різниця > 10%
        discrepancies.push({
          model: model.key,
          modelName: model.name,
          ourPrice: model.apiCost,
          officialPrice: official.pricePerRun,
          difference: diff.toFixed(4),
          differencePercent: diffPercent.toFixed(1) + '%',
          source: official.source,
          lastChecked: official.lastChecked
        });
      }
    }
  }

  // Перевіряємо video models
  for (const model of models.video.models) {
    const official = getOfficialPrice(model.key);
    if (!official) continue;

    if (official.pricePerRun && model.apiCost) {
      const diff = Math.abs(model.apiCost - official.pricePerRun);
      const diffPercent = (diff / official.pricePerRun) * 100;

      if (diffPercent > 10) {
        discrepancies.push({
          model: model.key,
          modelName: model.name,
          ourPrice: model.apiCost,
          officialPrice: official.pricePerRun,
          difference: diff.toFixed(4),
          differencePercent: diffPercent.toFixed(1) + '%',
          source: official.source,
          lastChecked: official.lastChecked
        });
      }
    }

    if (official.pricePerSecond && model.apiCostPerSecond) {
      const diff = Math.abs(model.apiCostPerSecond - official.pricePerSecond);
      const diffPercent = (diff / official.pricePerSecond) * 100;

      if (diffPercent > 10) {
        discrepancies.push({
          model: model.key,
          modelName: model.name,
          ourPricePerSec: model.apiCostPerSecond,
          officialPricePerSec: official.pricePerSecond,
          difference: diff.toFixed(4),
          differencePercent: diffPercent.toFixed(1) + '%',
          source: official.source,
          lastChecked: official.lastChecked
        });
      }
    }
  }

  return discrepancies;
}

/**
 * Розрахувати реальну вартість з metrics відповіді Replicate
 * @param {string} modelKey - Ключ нашої моделі
 * @param {object} metrics - metrics з відповіді Replicate
 * @param {object} options - Додаткові опції (duration, audio, etc.)
 */
function calculateActualCost(modelKey, metrics, options = {}) {
  const official = getOfficialPrice(modelKey);
  if (!official) return null;

  // Для моделей з фіксованою ціною за run
  if (official.pricePerRun) {
    return {
      estimatedCost: official.pricePerRun,
      predictTime: metrics?.predict_time || 0,
      source: 'fixed_per_run'
    };
  }

  // Для моделей з ціною за секунду (відео)
  if (official.pricePerSecond) {
    const duration = options.duration || 5;
    return {
      estimatedCost: official.pricePerSecond * duration,
      duration,
      predictTime: metrics?.predict_time || 0,
      source: 'per_second'
    };
  }

  // Для Veo з audio/no-audio
  if (official.pricePerSecondAudio) {
    const duration = options.duration || 8;
    const hasAudio = options.generateAudio !== false;
    const pricePerSec = hasAudio ? official.pricePerSecondAudio : official.pricePerSecondNoAudio;

    return {
      estimatedCost: pricePerSec * duration,
      duration,
      hasAudio,
      predictTime: metrics?.predict_time || 0,
      source: 'veo_pricing'
    };
  }

  return null;
}

/**
 * Логування для порівняння цін (викликати при старті бота)
 */
function logPriceComparison() {
  console.log('\n📊 ═══════════════════════════════════════');
  console.log('   ПЕРЕВІРКА ЦІН REPLICATE');
  console.log('═══════════════════════════════════════\n');

  const discrepancies = comparePrices();

  if (discrepancies.length === 0) {
    console.log('✅ Всі ціни актуальні! Розбіжностей немає.\n');
    return;
  }

  console.log(`⚠️ Знайдено ${discrepancies.length} розбіжностей:\n`);

  for (const d of discrepancies) {
    console.log(`🔴 ${d.modelName} (${d.model})`);
    console.log(`   Наша ціна: $${d.ourPrice || d.ourPricePerSec}/run`);
    console.log(`   Офіційна:  $${d.officialPrice || d.officialPricePerSec}/run`);
    console.log(`   Різниця:   ${d.differencePercent}`);
    console.log(`   Джерело:   ${d.source}`);
    console.log(`   Перевірено: ${d.lastChecked}\n`);
  }

  console.log('💡 Оновіть apiCost в config/models.js!\n');
  console.log('═══════════════════════════════════════\n');
}

/**
 * Отримати всі офіційні ціни
 */
function getAllOfficialPrices() {
  return OFFICIAL_PRICING;
}

/**
 * Отримати рекомендовані оновлення для models.js
 */
function getSuggestedUpdates() {
  const updates = [];

  for (const [replicateModel, pricing] of Object.entries(OFFICIAL_PRICING)) {
    const modelKey = pricing.model;

    // Знаходимо модель в нашому конфігу
    let ourModel = models.design.models.find(m => m.key === modelKey);
    if (!ourModel) {
      ourModel = models.video.models.find(m => m.key === modelKey);
    }

    if (ourModel) {
      if (pricing.pricePerRun && ourModel.apiCost !== pricing.pricePerRun) {
        updates.push({
          modelKey,
          field: 'apiCost',
          currentValue: ourModel.apiCost,
          suggestedValue: pricing.pricePerRun,
          source: pricing.source
        });
      }

      if (pricing.pricePerSecond && ourModel.apiCostPerSecond !== pricing.pricePerSecond) {
        updates.push({
          modelKey,
          field: 'apiCostPerSecond',
          currentValue: ourModel.apiCostPerSecond,
          suggestedValue: pricing.pricePerSecond,
          source: pricing.source
        });
      }
    }
  }

  return updates;
}

module.exports = {
  getOfficialPrice,
  comparePrices,
  calculateActualCost,
  logPriceComparison,
  getAllOfficialPrices,
  getSuggestedUpdates,
  OFFICIAL_PRICING,
  MODEL_MAPPING
};
