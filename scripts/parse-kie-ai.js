/**
 * Скрипт для парсингу KIE.AI маркетплейсу
 * Перевіряє доступні моделі та їх ціни
 */

const axios = require('axios');

async function parseKieAIMarket() {
  try {
    console.log('🔍 Парсимо KIE.AI маркетплейс...\n');

    // Відомі моделі які ми використовуємо
    const modelsToCheck = [
      { name: 'Nano Banana Pro', path: '/market/google/nano-banana-pro' },
      { name: 'Seedream 4.5', path: '/market/bytedance/seedream-4.5' },
      { name: 'Stable Diffusion 3.5', path: '/market/stability-ai/stable-diffusion-3.5' },
      { name: 'Kling v2.5', path: '/market/kling/v2.5' },
      { name: 'Kling v2.6', path: '/market/kling/v2.6' },
      { name: 'Kling Motion Control', path: '/market/kling/motion-control' },
      { name: 'Google Veo 3.1', path: '/market/google/veo-3.1' }
    ];

    for (const model of modelsToCheck) {
      try {
        const response = await axios.get(`https://docs.kie.ai${model.path}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          },
          timeout: 10000
        });

        const html = response.data;

        // Шукаємо ціни в HTML
        const priceMatches = html.match(/\$\d+\.?\d*/g) || [];
        const uniquePrices = [...new Set(priceMatches)].slice(0, 5);

        console.log(`✅ ${model.name}:`);
        console.log(`   URL: https://docs.kie.ai${model.path}`);
        if (uniquePrices.length > 0) {
          console.log(`   Ціни знайдені: ${uniquePrices.join(', ')}`);
        } else {
          console.log(`   Ціни не знайдені (можливо динамічний контент)`);
        }

        // Шукаємо модель ідентифікатор
        const modelIdMatch = html.match(/model["\']?\s*:\s*["']([^"']+)["']/i);
        if (modelIdMatch) {
          console.log(`   Model ID: ${modelIdMatch[1]}`);
        }

        console.log('');

      } catch (error) {
        console.log(`❌ ${model.name}: Помилка - ${error.message}\n`);
      }
    }

    console.log('\n📊 Перевірка завершена!');

  } catch (error) {
    console.error('❌ Помилка парсингу:', error.message);
  }
}

parseKieAIMarket();

