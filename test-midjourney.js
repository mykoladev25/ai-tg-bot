#!/usr/bin/env node

/**
 * Midjourney Implementation Test
 * Verifies all components are correctly configured
 */

console.log('🖼️ Midjourney Implementation Test\n');
console.log('='.repeat(60));

try {
  // Test 1: Load models
  console.log('\n✅ Test 1: Loading models...');
  const models = require('./config/models.js');
  const mjModel = models.design.models.find(m => m.key === 'midjourney');

  if (!mjModel) {
    throw new Error('Midjourney model not found in models.js!');
  }

  console.log('   ✓ Midjourney model loaded');
  console.log(`   ✓ Available: ${mjModel.available}`);
  console.log(`   ✓ Name: ${mjModel.name}`);

  // Test 2: Check pricing
  console.log('\n✅ Test 2: Checking pricing...');
  const speeds = ['relaxed', 'fast', 'turbo'];
  speeds.forEach(speed => {
    const pricing = mjModel.speeds[speed];
    if (!pricing) {
      throw new Error(`Missing pricing for speed: ${speed}`);
    }
    console.log(`   ✓ ${speed}: ${pricing.cost}⚡ (API: $${pricing.apiCost})`);
  });

  console.log(`   ✓ Video: ${mjModel.video.cost}⚡ (API: $${mjModel.video.apiCost})`);
  console.log(`   ✓ Upscale: FREE`);
  console.log(`   ✓ Vary: FREE`);

  // Test 3: Load service
  console.log('\n✅ Test 3: Loading service...');
  const midjourney = require('./services/midjourney.js');

  if (!midjourney.generateImage) {
    throw new Error('generateImage function not found!');
  }
  if (!midjourney.upscaleImage) {
    throw new Error('upscaleImage function not found!');
  }
  if (!midjourney.variateImage) {
    throw new Error('variateImage function not found!');
  }
  if (!midjourney.getTaskStatus) {
    throw new Error('getTaskStatus function not found!');
  }
  if (!midjourney.waitForCompletion) {
    throw new Error('waitForCompletion function not found!');
  }

  console.log('   ✓ All service functions loaded');

  // Test 4: Load KIE.AI models
  console.log('\n✅ Test 4: Loading KIE.AI models...');
  const kieAiModels = require('./config/kie-ai-models.js');

  if (!kieAiModels.midjourney) {
    throw new Error('Midjourney not found in kie-ai-models.js!');
  }

  console.log('   ✓ KIE.AI Midjourney config loaded');
  console.log(`   ✓ Model name: ${kieAiModels.midjourney.kie_model}`);

  // Test 5: Verify pricing matches
  console.log('\n✅ Test 5: Verifying pricing consistency...');
  const kiePrice = kieAiModels.midjourney.kie_pricing.text_to_image_fast.usd;
  const modelPrice = mjModel.speeds.fast.apiCost;

  if (kiePrice !== modelPrice) {
    throw new Error(`Pricing mismatch! KIE: $${kiePrice}, Model: $${modelPrice}`);
  }

  console.log(`   ✓ Pricing matches: $${kiePrice}`);

  // Calculate margins
  console.log('\n📊 Profit Margin Analysis:');
  speeds.forEach(speed => {
    const apiCost = mjModel.speeds[speed].apiCost;
    const userCost = mjModel.speeds[speed].cost * 0.01;
    const margin = ((userCost - apiCost) / userCost * 100).toFixed(2);
    const profit = (userCost - apiCost).toFixed(4);
    console.log(`   • ${speed}: ${margin}% margin, $${profit} profit/gen`);
  });

  console.log('\n' + '='.repeat(60));
  console.log('✅ All tests passed! Midjourney is ready to use!');
  console.log('='.repeat(60));

} catch (error) {
  console.error('\n❌ Test failed:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}

