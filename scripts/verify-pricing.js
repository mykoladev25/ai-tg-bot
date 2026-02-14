/**
 * Порівняння цін моделей з Replicate/KIE.AI
 */

console.log('🔍 Перевірка відповідності цін моделей\n');
console.log('='.repeat(80));

// Формула: tokens = ceil(apiCost * 1.65 / 0.01)
const TOKEN_USD = 0.01;
const MULTIPLIER = 1.65;

function calculateTokens(apiCost) {
  return Math.ceil(apiCost * MULTIPLIER / TOKEN_USD);
}

// Replicate ціни (з документації)
const replicatePrices = {
  // IMAGE
  nano_banana_2k: 0.15,
  nano_banana_4k: 0.30,
  seedream_4k: 0.04,
  stable_diffusion: 0.07,

  // VIDEO (per second)
  kling_v2_5: 0.07,
  kling_v2_6_no_audio: 0.07,
  kling_v2_6_audio: 0.14,
  veo_no_audio: 0.20,
  veo_audio: 0.40,

  // KLING MOTION
  kling_motion_std_image: 0.50,
  kling_motion_std_video: 1.00,
  kling_motion_pro_image: 1.00,
  kling_motion_pro_video: 2.00
};

// Наші поточні ціни з models.js
const ourPrices = {
  nano_banana_2k: { tokens: 25, apiCost: 0.15 },
  nano_banana_4k: { tokens: 27, apiCost: 0.30 },
  seedream_4k: { tokens: 6, apiCost: 0.04 },
  stable_diffusion: { tokens: 12, apiCost: 0.07 },

  kling_v2_5: { tokensPerSec: 12, apiCostPerSec: 0.07 },
  kling_v2_6_no_audio: { tokensPerSec: 12, apiCostPerSec: 0.07 },
  kling_v2_6_audio: { tokensPerSec: 35, apiCostPerSec: 0.14 },
  veo_no_audio: { tokensPerSec: 33, apiCostPerSec: 0.20 },
  veo_audio: { tokensPerSec: 66, apiCostPerSec: 0.40 },

  kling_motion_std_image: { tokens: 83, apiCost: 0.50 },
  kling_motion_std_video: { tokens: 165, apiCost: 1.00 },
  kling_motion_pro_image: { tokens: 165, apiCost: 1.00 },
  kling_motion_pro_video: { tokens: 330, apiCost: 2.00 }
};

// Перевірка IMAGE моделей
console.log('\n📸 ЗОБРАЖЕННЯ:');
console.log('-'.repeat(80));

['nano_banana_2k', 'nano_banana_4k', 'seedream_4k', 'stable_diffusion'].forEach(key => {
  const replicate = replicatePrices[key];
  const our = ourPrices[key];
  const correctTokens = calculateTokens(replicate);
  const match = our.apiCost === replicate && our.tokens === correctTokens;
  const icon = match ? '✅' : '❌';

  console.log(`${icon} ${key}:`);
  console.log(`   Replicate: $${replicate} → правильно: ${correctTokens}⚡`);
  console.log(`   Наші: $${our.apiCost} → ${our.tokens}⚡`);
  if (!match && our.tokens !== correctTokens) {
    console.log(`   ⚠️  ТРЕБА ЗМІНИТИ: ${our.tokens}⚡ → ${correctTokens}⚡`);
  }
  console.log('');
});

// Перевірка VIDEO моделей
console.log('\n🎬 ВІДЕО (per second):');
console.log('-'.repeat(80));

[
  'kling_v2_5',
  'kling_v2_6_no_audio',
  'kling_v2_6_audio',
  'veo_no_audio',
  'veo_audio'
].forEach(key => {
  const replicate = replicatePrices[key];
  const our = ourPrices[key];
  const correctTokens = calculateTokens(replicate);
  const match = our.apiCostPerSec === replicate && our.tokensPerSec === correctTokens;
  const icon = match ? '✅' : '❌';

  console.log(`${icon} ${key}:`);
  console.log(`   Replicate: $${replicate}/sec → правильно: ${correctTokens}⚡/sec`);
  console.log(`   Наші: $${our.apiCostPerSec}/sec → ${our.tokensPerSec}⚡/sec`);
  if (!match && our.tokensPerSec !== correctTokens) {
    console.log(`   ⚠️  ТРЕБА ЗМІНИТИ: ${our.tokensPerSec}⚡ → ${correctTokens}⚡`);
  }
  console.log('');
});

// Перевірка KLING MOTION
console.log('\n🔥 KLING MOTION CONTROL:');
console.log('-'.repeat(80));

[
  'kling_motion_std_image',
  'kling_motion_std_video',
  'kling_motion_pro_image',
  'kling_motion_pro_video'
].forEach(key => {
  const replicate = replicatePrices[key];
  const our = ourPrices[key];
  const correctTokens = calculateTokens(replicate);
  const match = our.apiCost === replicate && our.tokens === correctTokens;
  const icon = match ? '✅' : '❌';

  console.log(`${icon} ${key}:`);
  console.log(`   Replicate: $${replicate} → правильно: ${correctTokens}⚡`);
  console.log(`   Наші: $${our.apiCost} → ${our.tokens}⚡`);
  if (!match && our.tokens !== correctTokens) {
    console.log(`   ⚠️  ТРЕБА ЗМІНИТИ: ${our.tokens}⚡ → ${correctTokens}⚡`);
  }
  console.log('');
});

console.log('='.repeat(80));
console.log('\n💡 Множник: 1.65x (≈30% profit після fees)');
console.log('💡 1 токен = $0.01');
console.log('💡 Формула: tokens = ceil(apiCost * 1.65 / 0.01)\n');



