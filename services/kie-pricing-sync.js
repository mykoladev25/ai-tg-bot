/**
 * Автоматичне оновлення цін з KIE.AI API
 * Запускається раз на день через cron
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const KIE_PRICING_API = 'https://api.kie.ai/client/v1/model-pricing/page';
const CACHE_FILE = path.join(__dirname, '../config/kie-ai-pricing-cache.json');
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 години

/**
 * Отримати ціни з KIE.AI API
 */
async function fetchKieAIPricing() {
  try {
    console.log('📊 Fetching pricing from KIE.AI API...');

    const types = ['', 'image', 'video', 'music', 'chat'];
    const allPricing = {};

    for (const type of types) {
      let currentPage = 1;
      let totalPages = 1;
      const records = [];

      do {
        const response = await axios.post(KIE_PRICING_API, {
          pageNum: currentPage,
          pageSize: 100,
          modelDescription: '',
          interfaceType: type
        });

        const data = response.data.data;
        records.push(...data.records);
        totalPages = data.pages;
        currentPage++;

        await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit
      } while (currentPage <= totalPages);

      if (type === '') {
        allPricing.all = records;
      } else {
        allPricing[type] = records;
      }

      console.log(`  ✅ ${type || 'all'}: ${records.length} models`);
    }

    return allPricing;

  } catch (error) {
    console.error('❌ Failed to fetch KIE.AI pricing:', error.message);
    throw error;
  }
}

/**
 * Парсити ціни для наших моделей
 */
function parseOurModels(pricing) {
  const ourModels = {
    // IMAGE
    nano_banana: findModel(pricing.image, 'nano banana', 'text-to-image'),  // Base model
    nano_banana_2k: findModel(pricing.image, 'nano banana pro', '1/2K'),
    nano_banana_4k: findModel(pricing.image, 'nano banana pro', '4K'),
    seedream_4k: findModel(pricing.image, 'seedream', '4K'),
    stable_diffusion: findModel(pricing.image, 'stable diffusion', '3.5'),
    ideogram: findModels(pricing.image, 'ideogram'),  // All ideogram variants

    // VIDEO
    kling_2_5: findModels(pricing.video, 'kling 2.5'),
    kling_2_6: findModels(pricing.video, 'kling 2.6'),
    kling_3_0: findModels(pricing.video, 'Kling 3.0'),
    kling_motion: findModels(pricing.video, 'motion control'),
    veo: findModels(pricing.video, 'veo'),
    sora_2: findModels(pricing.video, 'sora 2'),
    runway: findModels(pricing.video, 'runway')
  };

  return ourModels;
}

/**
 * Знайти модель за назвою
 */
function findModel(records, ...keywords) {
  return records.find(r =>
    keywords.every(kw =>
      r.modelDescription.toLowerCase().includes(kw.toLowerCase())
    )
  );
}

/**
 * Знайти всі варіанти моделі
 */
function findModels(records, keyword) {
  return records.filter(r =>
    r.modelDescription.toLowerCase().includes(keyword.toLowerCase())
  );
}

/**
 * Зберегти кеш
 */
async function savePricingCache(pricing) {
  const cache = {
    timestamp: Date.now(),
    lastUpdate: new Date().toISOString(),
    pricing,
    parsed: parseOurModels(pricing)
  };

  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  console.log(`💾 Pricing cache saved to: ${CACHE_FILE}`);

  return cache;
}

/**
 * Завантажити кеш
 */
async function loadPricingCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf-8');
    const cache = JSON.parse(data);

    const age = Date.now() - cache.timestamp;
    const hours = Math.floor(age / (60 * 60 * 1000));

    console.log(`📦 Loaded pricing cache (${hours}h old)`);

    return cache;
  } catch (error) {
    console.log('⚠️ No pricing cache found');
    return null;
  }
}

/**
 * Оновити ціни якщо потрібно
 */
async function updatePricingIfNeeded() {
  const cache = await loadPricingCache();

  // Перевіряємо чи потрібно оновлювати
  if (cache) {
    const age = Date.now() - cache.timestamp;
    if (age < UPDATE_INTERVAL) {
      const hoursLeft = Math.ceil((UPDATE_INTERVAL - age) / (60 * 60 * 1000));
      console.log(`✅ Pricing is fresh (next update in ${hoursLeft}h)`);
      return cache;
    }
  }

  // Оновлюємо
  console.log('🔄 Updating pricing from KIE.AI...');
  const pricing = await fetchKieAIPricing();
  return await savePricingCache(pricing);
}

/**
 * Отримати актуальні ціни
 */
async function getCurrentPricing() {
  let cache = await loadPricingCache();

  if (!cache) {
    console.log('⚠️ No cache, fetching pricing...');
    const pricing = await fetchKieAIPricing();
    cache = await savePricingCache(pricing);
  }

  return cache;
}

/**
 * Форсувати оновлення
 */
async function forceUpdate() {
  console.log('🔄 Force updating pricing from KIE.AI...');
  const pricing = await fetchKieAIPricing();
  return await savePricingCache(pricing);
}

/**
 * Отримати ціну для моделі з актуального кешу
 */
function getModelPrice(cache, modelKey, options = {}) {
  const { duration, audio, resolution } = options;
  const quality = options.quality || '720p';  // Додано для Runway

  try {
    const parsed = cache.parsed;

    switch(modelKey) {
      case 'nano_banana_2k':
        return parsed.nano_banana_2k?.usdPrice || '0.09';

      case 'nano_banana_4k':
        return parsed.nano_banana_4k?.usdPrice || '0.12';

      // Seedream: KIE support підтвердив що немає API для отримання ціни (19.02.2026)
      // Офіційна ціна: 6.5 credits = $0.032 per image
      // Повертаємо null щоб використовувався fallback з kie-ai-models.js
      case 'seedream_2k':
      case 'seedream_4k':
        return parsed.seedream_4k?.usdPrice || null;

      case 'stable_diffusion':
        return parsed.stable_diffusion?.usdPrice || null;

      case 'ideogram': {
        // Ideogram: використовуємо TURBO режим (найдешевший для text-to-image)
        // Шукаємо "ideogram v3, text-to-image, TURBO"
        const ideogram = parsed.ideogram?.find(m => {
          const desc = m.modelDescription.toLowerCase();
          return desc.includes('text-to-image') && desc.includes('turbo');
        });
        return ideogram?.usdPrice || null;
      }

      case 'kling_v2_6':
        const kling26 = parsed.kling_2_6?.find(m => {
          const desc = m.modelDescription.toLowerCase();
          const hasDuration = desc.includes(`${duration}s`) || desc.includes(`${duration}.0s`);
          const hasAudio = audio ? desc.includes('with audio') : desc.includes('without audio');
          return hasDuration && hasAudio;
        });
        return kling26?.usdPrice || null;

      case 'kling_3_0':
        const kling30 = parsed.kling_3_0?.find(m => {
          const desc = m.modelDescription.toLowerCase();
          const hasRes = desc.includes(resolution?.toLowerCase() || '1080p');
          const hasAudio = audio ? desc.includes('with audio') : desc.includes('without audio');
          return hasRes && hasAudio;
        });
        return kling30 ? parseFloat(kling30.usdPrice) : null;

      case 'kling':
        // Kling 2.5: per video, є 5.0s та 10.0s
        const kling25 = parsed.kling_2_5?.find(m => {
          const desc = m.modelDescription.toLowerCase();
          return desc.includes(`${duration}s`) || desc.includes(`${duration}.0s`);
        });
        return kling25?.usdPrice || null;

      case 'runway_turbo': {
        const dur = duration || 5;
        const qual = quality || '720p';
        const rw = parsed.runway?.find(m => {
          const d = (m.modelDescription || '').toLowerCase();
          return d.includes('runway') && (d.includes(`${dur}.0s`) || d.includes(`${dur}s`)) && d.includes(qual);
        });
        return rw?.usdPrice || null;
      }

      case 'kling_motion':
        const res = (resolution || '720p').toLowerCase();
        const motion = parsed.kling_motion?.find(m => {
          const d = (m.modelDescription || '').toLowerCase();
          return d.includes('motion') && d.includes(res);
        });
        return motion?.usdPrice || null;

      default:
        return null;
    }
  } catch (error) {
    console.error(`Error getting price for ${modelKey}:`, error.message);
    return null;
  }
}

/**
 * Той самий множник що в config/models.js (30% прибутку).
 * Вартість у токенах рахується в config/kie-ai-models.js (usdToTokens, getKling3TokenCostPerSecond).
 */
const kieAiModels = require('../config/kie-ai-models');
const TOKEN_USD = kieAiModels.TOKEN_USD;
const PRICING_MULTIPLIER = kieAiModels.PRICING_MULTIPLIER;

/**
 * Отримати актуальну ціну для моделі в USD (синхронна версія для швидкого доступу)
 */
function getModelPriceSync(modelKey, options = {}) {
  try {
    const fs = require('fs');
    const cacheData = fs.readFileSync(CACHE_FILE, 'utf-8');
    const cache = JSON.parse(cacheData);
    return getModelPrice(cache, modelKey, options);
  } catch (error) {
    // Якщо кеш недоступний - повертаємо fallback ціни
    console.warn(`⚠️ KIE.AI pricing cache unavailable, using fallback prices`);
    return null;
  }
}

/**
 * Вартість Kling 3.0 у токенах за секунду. USD беруться з кешу (якщо є), переведення в токени — у kie-ai-models.js.
 * @param {Object} options - { mode: 'pro'|'std' }
 * @returns {{ costPerSecondAudio: number, costPerSecondNoAudio: number } | null}
 */
function getKling3TokenCostPerSecondSync(options = {}) {
  const { mode = 'pro' } = options;
  const resolution = mode === 'pro' ? '1080p' : '720p';
  try {
    const usdAudio = getModelPriceSync('kling_3_0', { resolution, audio: true });
    const usdNoAudio = getModelPriceSync('kling_3_0', { resolution, audio: false });
    const usdFromCache = (usdAudio != null || usdNoAudio != null)
      ? { costPerSecondAudio: usdAudio ?? null, costPerSecondNoAudio: usdNoAudio ?? null }
      : null;
    return kieAiModels.getKling3TokenCostPerSecond.call(kieAiModels, mode, usdFromCache);
  } catch (e) {
    return null;
  }
}

/** Моделі зображень, для яких є KIE-ціна в кеші */
const KIE_IMAGE_MODELS = ['nano_banana_2k', 'nano_banana_4k', 'seedream_2k', 'seedream_4k', 'ideogram', 'stable_diffusion'];

/** Опорна тривалість для переведення Veo "per video" → "per second" (мін. тривалість у боті). */
const VEO_REF_DURATION_SEC = 4;

/**
 * Veo: вартість у токенах за секунду з KIE-кешу.
 * В кеші ціни "per video" (Fast $0.30, Quality $1.25). Fast → без аудіо, Quality → з аудіо.
 * @returns {{ costPerSecondNoAudio: number, costPerSecondAudio: number } | null}
 */
function getVeoTokenCostPerSecondSync() {
  try {
    const fs = require('fs');
    const cacheData = fs.readFileSync(CACHE_FILE, 'utf-8');
    const cache = JSON.parse(cacheData);
    const list = cache.parsed?.veo;
    if (!Array.isArray(list) || list.length === 0) return null;

    const desc = (m) => (m.modelDescription || '').toLowerCase();
    const fast = list.find(m => desc(m).includes('text-to-video') && desc(m).includes('fast'));
    const quality = list.find(m => desc(m).includes('text-to-video') && desc(m).includes('quality'));
    if (!fast?.usdPrice || !quality?.usdPrice) return null;

    const usdFast = parseFloat(fast.usdPrice);
    const usdQuality = parseFloat(quality.usdPrice);
    if (Number.isNaN(usdFast) || Number.isNaN(usdQuality)) return null;

    const usdPerSecNoAudio = usdFast / VEO_REF_DURATION_SEC;
    const usdPerSecAudio = usdQuality / VEO_REF_DURATION_SEC;

    return {
      costPerSecondNoAudio: kieAiModels.usdToTokens(usdPerSecNoAudio),
      costPerSecondAudio: kieAiModels.usdToTokens(usdPerSecAudio)
    };
  } catch (e) {
    return null;
  }
}

/**
 * Вартість у токенах при виборі провайдера KIE (для показу та списання).
 * Тільки для користувачів з userProviderChoice === 'kie-ai'. Replicate не змінюється.
 * @param {string} modelKey - ключ моделі
 * @param {Object} options - для відео: duration, audio, mode, orientation тощо
 * @returns {number | { costPerSecond, costPerSecondAudio, costPerSecondNoAudio } | { cost } | null} null = використовувати Replicate
 */
function getKieTokenCostSync(modelKey, options = {}) {
  try {
    const { duration, audio, resolution } = options;

    // Зображення: одна ціна за генерацію
    if (KIE_IMAGE_MODELS.includes(modelKey)) {
      let usd = getModelPriceSync(modelKey);

      // Fallback для Seedream: KIE support підтвердив що немає API (19.02.2026)
      // Використовуємо hardcoded ціну з kie-ai-models.js
      if (usd == null && (modelKey === 'seedream_2k' || modelKey === 'seedream_4k')) {
        usd = kieAiModels.getReplicatePrice(modelKey);
        console.log(`💡 Using hardcoded Seedream price: $${usd} (6.5 credits)`);
      }

      // ✅ Ideogram тепер береться з кешу (ideogram v3 text-to-image TURBO)
      // Fallback більше не потрібен

      if (usd == null) return null;
      const n = typeof usd === 'string' ? parseFloat(usd) : usd;
      if (Number.isNaN(n)) return null;
      return kieAiModels.usdToTokens(n);
    }

    // Kling 2.6: за секунду (з кешу за 5s/10s)
    if (modelKey === 'kling_v2_6') {
      const usd5No = getModelPriceSync('kling_v2_6', { duration: 5, audio: false });
      const usd5Aud = getModelPriceSync('kling_v2_6', { duration: 5, audio: true });
      if (usd5No == null && usd5Aud == null) return null;
      const perSecNo = usd5No != null ? parseFloat(usd5No) / 5 : null;
      const perSecAud = usd5Aud != null ? parseFloat(usd5Aud) / 5 : null;
      return {
        costPerSecondNoAudio: perSecNo != null ? kieAiModels.usdToTokens(perSecNo) : null,
        costPerSecondAudio: perSecAud != null ? kieAiModels.usdToTokens(perSecAud) : null
      };
    }

    // Kling 2.5: per video у кеші (5.0s, 10.0s) → переводимо в costPerSecond
    if (modelKey === 'kling') {
      const usd5 = getModelPriceSync('kling', { duration: 5 });
      if (usd5 == null) return null;
      const u = parseFloat(usd5);
      if (Number.isNaN(u)) return null;
      const perSec = u / 5;
      return { costPerSecond: kieAiModels.usdToTokens(perSec) };
    }

    // Runway Turbo: per video за тривалістю (5s, 10s)
    if (modelKey === 'runway_turbo') {
      const d = options.duration || 5;
      const usd = getModelPriceSync('runway_turbo', { duration: d });
      if (usd == null) return null;
      const u = parseFloat(usd);
      if (Number.isNaN(u)) return null;
      return { cost: kieAiModels.usdToTokens(u), costPerSecond: kieAiModels.usdToTokens(u / d) };
    }

    // Kling Motion: 720P (std) та 1080P (pro) за секунду; конвенція image 5s, video 10s
    if (modelKey === 'kling_motion') {
      const usd720 = getModelPriceSync('kling_motion', { resolution: '720p' });
      const usd1080 = getModelPriceSync('kling_motion', { resolution: '1080p' });
      if (usd720 == null && usd1080 == null) return null;
      const sec720 = usd720 != null ? parseFloat(usd720) : 0.03;
      const sec1080 = usd1080 != null ? parseFloat(usd1080) : 0.045;
      return {
        costs: {
          std_image: kieAiModels.usdToTokens(sec720 * 5),
          std_video: kieAiModels.usdToTokens(sec720 * 10),
          pro_image: kieAiModels.usdToTokens(sec1080 * 5),
          pro_video: kieAiModels.usdToTokens(sec1080 * 10)
        }
      };
    }

    // Veo: в кеші "per video" (Fast / Quality). Переводимо в токени/сек за опорною тривалістю 4 сек.
    // Fast → без аудіо, Quality → з аудіо (конвенція, бо в KIE немає окремого audio/noAudio).
    if (modelKey === 'veo') {
      const veoRates = getVeoTokenCostPerSecondSync();
      return veoRates;
    }

    // Sora 2: фіксована вартість за відео (з kie-ai-models)
    if (modelKey === 'sora_2') {
      const type = options.soraType || 'text_to_video_15s';
      const usd = kieAiModels.getKieAIPrice.call(kieAiModels, 'sora_2', { type });
      if (usd == null || usd === 0) return null;
      return { cost: kieAiModels.usdToTokens(usd) };
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Логувати порівняння ціни KIE.AI vs Replicate
 */
async function logPriceComparison(modelKey, options = {}) {
  try {
    const cache = await getCurrentPricing();
    const kiePrice = getModelPrice(cache, modelKey, options);

    if (kiePrice) {
      console.log(`💰 KIE.AI price for ${modelKey}: $${kiePrice}`);
      return parseFloat(kiePrice);
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Показати звіт про ціни
 */
async function showPricingReport() {
  const cache = await getCurrentPricing();
  const parsed = cache.parsed;

  console.log('\n📊 KIE.AI Pricing Report');
  console.log('='.repeat(80));
  console.log(`Last update: ${cache.lastUpdate}`);
  console.log('');

  // IMAGE
  console.log('🎨 IMAGE MODELS:');
  if (parsed.nano_banana_2k) {
    console.log(`  Nano Banana 2K: ${parsed.nano_banana_2k.creditPrice} credits = $${parsed.nano_banana_2k.usdPrice}`);
  }
  if (parsed.nano_banana_4k) {
    console.log(`  Nano Banana 4K: ${parsed.nano_banana_4k.creditPrice} credits = $${parsed.nano_banana_4k.usdPrice}`);
  }
  console.log('');

  // VIDEO
  console.log('🎬 VIDEO MODELS:');
  if (parsed.kling_2_6?.length) {
    console.log(`  Kling 2.6: ${parsed.kling_2_6.length} variants`);
    parsed.kling_2_6.forEach(m => {
      console.log(`    - ${m.modelDescription}: ${m.creditPrice} credits = $${m.usdPrice}`);
    });
  }
  if (parsed.kling_3_0?.length) {
    console.log(`  Kling 3.0: ${parsed.kling_3_0.length} variants`);
    parsed.kling_3_0.forEach(m => {
      console.log(`    - ${m.modelDescription}: ${m.creditPrice} credits = $${m.usdPrice}`);
    });
  }
  console.log('');

  console.log('='.repeat(80));
}

module.exports = {
  fetchKieAIPricing,
  updatePricingIfNeeded,
  getCurrentPricing,
  forceUpdate,
  getModelPrice,
  getModelPriceSync,
  getKling3TokenCostPerSecondSync,
  getKieTokenCostSync,
  KIE_IMAGE_MODELS,
  logPriceComparison,
  showPricingReport,
  CACHE_FILE,
  PRICING_MULTIPLIER,
  TOKEN_USD
};

// CLI команди
if (require.main === module) {
  const command = process.argv[2];

  (async () => {
    try {
      switch(command) {
        case 'fetch':
          await fetchKieAIPricing();
          break;

        case 'update':
          await forceUpdate();
          console.log('✅ Pricing updated');
          break;

        case 'report':
          await showPricingReport();
          break;

        case 'check':
          await updatePricingIfNeeded();
          break;

        default:
          console.log('Usage:');
          console.log('  node services/kie-pricing-sync.js fetch   - Fetch pricing');
          console.log('  node services/kie-pricing-sync.js update  - Force update');
          console.log('  node services/kie-pricing-sync.js report  - Show report');
          console.log('  node services/kie-pricing-sync.js check   - Update if needed');
      }
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  })();
}

