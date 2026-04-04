

const axios = require('axios');
const models = require('../config/models');

let pricingCache = null;
let lastPricingUpdate = 0;
const PRICING_CACHE_TTL = 24 * 60 * 60 * 1000; 


const OFFICIAL_PRICING = {
  'stability-ai/stable-diffusion-3.5-large': {
    pricePerRun: 0.065,  // Fixed price per run
    model: 'stable_diffusion',
    lastChecked: '2026-01-25',
    source: 'https://replicate.com/stability-ai/stable-diffusion-3.5-large'
  },

  'google/nano-banana': {
    pricePerRun: 0.039,  // $0.039 per image
    model: 'nano_banana',
    lastChecked: '2026-01-26',
    source: 'https://replicate.com/google/nano-banana'
  },
  'google/nano-banana-pro-2k': {
    pricePerRun: 0.15,  
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

  'bytedance/seedream-4.5-4k': {
    pricePerRun: 0.04,  
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
  'kwaivgi/kling-v2.6-motion-control': {
    priceByMode: {
      std_image: 0.50,
      std_video: 1.00,
      pro_image: 1.00,
      pro_video: 2.00
    },
    model: 'kling_motion',
    lastChecked: '2026-01-27',
    source: 'https://replicate.com/kwaivgi/kling-v2.6-motion-control'
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
  },
  'openai/sora-2': {
    pricePerSecond: 0.10,
    model: 'sora_2',
    lastChecked: '2026-01-26',
    source: 'https://replicate.com/openai/sora-2'
  }
};


const MODEL_MAPPING = {
  'stable_diffusion': 'stability-ai/stable-diffusion-3.5-large',
  'nano_banana': 'google/nano-banana',
  'nano_banana_2k': 'google/nano-banana-pro-2k',
  'nano_banana_4k': 'google/nano-banana-pro-4k',
  'seedream_4k': 'bytedance/seedream-4.5-4k',
  'ideogram': 'ideogram-ai/ideogram-v3',
  'clarity': 'philz1337x/clarity-upscaler',
  'recraft_upscale': 'recraft-ai/recraft-crisp-upscale',
  'sora_2': 'openai/sora-2',
  'kling': 'kwaivgi/kling-v2.5-turbo-pro',
  'kling_v2_6': 'kwaivgi/kling-v2.6',
  'kling_motion': 'kwaivgi/kling-v2.6-motion-control',
  'veo': 'google/veo-3.1',
  'runway_turbo': 'runway/gen-4-turbo'
};


function getOfficialPrice(modelKey) {
  const replicateModel = MODEL_MAPPING[modelKey];
  if (!replicateModel) return null;

  return OFFICIAL_PRICING[replicateModel] || null;
}


function comparePrices() {
  const discrepancies = [];

  for (const model of models.design.models) {
    const official = getOfficialPrice(model.key);
    if (official && official.pricePerRun) {
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
  }

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

    if (official.priceByMode && model.apiCosts) {
      for (const [mode, officialPrice] of Object.entries(official.priceByMode)) {
        const ourPrice = model.apiCosts?.[mode];
        if (!Number.isFinite(ourPrice)) continue;
        const diff = Math.abs(ourPrice - officialPrice);
        const diffPercent = (diff / officialPrice) * 100;
        if (diffPercent > 10) {
          discrepancies.push({
            model: model.key,
            modelName: model.name,
            mode,
            ourPrice,
            officialPrice,
            difference: diff.toFixed(4),
            differencePercent: diffPercent.toFixed(1) + '%',
            source: official.source,
            lastChecked: official.lastChecked
          });
        }
      }
    }
  }

  return discrepancies;
}


function calculateActualCost(modelKey, metrics, options = {}) {
  const official = getOfficialPrice(modelKey);
  if (!official) return null;

  if (official.pricePerRun) {
    return {
      estimatedCost: official.pricePerRun,
      predictTime: metrics?.predict_time || 0,
      source: 'fixed_per_run'
    };
  }

  if (official.pricePerSecond) {
    const duration = options.duration || 5;
    return {
      estimatedCost: official.pricePerSecond * duration,
      duration,
      predictTime: metrics?.predict_time || 0,
      source: 'per_second'
    };
  }

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


function logPriceComparison() {
  console.log('\n📊 ═══════════════════════════════════════');
  console.log('   REPLICATE PRICE CHECK');
  console.log('═══════════════════════════════════════\n');

  const discrepancies = comparePrices();

  if (discrepancies.length === 0) {
    console.log('✅ All prices are up to date. No discrepancies found.\n');
    return;
  }

  console.log(`⚠️ Found ${discrepancies.length} discrepancies:\n`);

  for (const d of discrepancies) {
    console.log(`🔴 ${d.modelName} (${d.model})`);
    console.log(`   Our price: $${d.ourPrice || d.ourPricePerSec}/run`);
    console.log(`   Official:  $${d.officialPrice || d.officialPricePerSec}/run`);
    console.log(`   Difference: ${d.differencePercent}`);
    console.log(`   Source:    ${d.source}`);
    console.log(`   Checked:   ${d.lastChecked}\n`);
  }

  console.log('💡 Update apiCost in config/models.js.\n');
  console.log('═══════════════════════════════════════\n');
}


function getAllOfficialPrices() {
  return OFFICIAL_PRICING;
}


function getSuggestedUpdates() {
  const updates = [];

  for (const [replicateModel, pricing] of Object.entries(OFFICIAL_PRICING)) {
    const modelKey = pricing.model;

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

      if (pricing.priceByMode && ourModel.apiCosts) {
        for (const [mode, price] of Object.entries(pricing.priceByMode)) {
          const current = ourModel.apiCosts?.[mode];
          if (Number.isFinite(current) && current !== price) {
            updates.push({
              modelKey,
              field: `apiCosts.${mode}`,
              currentValue: current,
              suggestedValue: price,
              source: pricing.source
            });
          }
        }
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
