const k = require('./services/kie-pricing-sync');

console.log('=== Testing cache re-parse ===');
console.log('ideogram:', k.getModelPriceSync('ideogram'));
console.log('nano_banana:', k.getModelPriceSync('nano_banana'));
console.log('recraft_upscale:', k.getModelPriceSync('recraft_upscale'));
console.log('seedream_4k:', k.getModelPriceSync('seedream_4k'));
console.log('nano_banana_2k:', k.getModelPriceSync('nano_banana_2k'));
console.log('nano_banana_4k:', k.getModelPriceSync('nano_banana_4k'));

console.log('\n=== Token costs ===');
const models = ['nano_banana', 'nano_banana_2k', 'nano_banana_4k', 'seedream_4k', 'ideogram', 'recraft_upscale'];
models.forEach(m => {
  console.log(m + ' tokens:', k.getKieTokenCostSync(m));
});

