const kieAI = require('../services/kie-ai');

function isAvailableOnKIE(modelKey) {
  return kieAI.isKieAIImplemented(modelKey);
}

function isAvailableOnReplicate(modelKey) {
  const kieOnlyModels = [
    'kling_3',
    'midjourney',
    'seedream_5_lite',
    'z_image',
    'gpt_image_2',
    'seedance_2_fast'
  ];

  return !kieOnlyModels.includes(modelKey);
}

function getAvailableProviders(modelKey) {
  const providers = [];

  if (isAvailableOnKIE(modelKey)) {
    providers.push('kie');
  }

  if (isAvailableOnReplicate(modelKey)) {
    providers.push('replicate');
  }

  return providers;
}

function selectProviders(modelKey, userChoice, canUseKieAI) {
  const availableProviders = getAvailableProviders(modelKey);

  if (availableProviders.length === 1) {
    return {
      primary: availableProviders[0],
      fallback: null,
      enableFallback: false,
      reason: 'single_provider'
    };
  }

  if (availableProviders.length === 0) {
    return {
      primary: null,
      fallback: null,
      enableFallback: false,
      reason: 'no_provider'
    };
  }

  if (userChoice === 'kie-ai') {
    if (!canUseKieAI) {
      return {
        primary: 'replicate',
        fallback: null,
        enableFallback: false,
        reason: 'no_kie_access'
      };
    }

    return {
      primary: 'kie',
      fallback: null,
      enableFallback: false,
      reason: 'user_choice_kie'
    };
  }

  if (userChoice === 'replicate') {
    return {
      primary: 'replicate',
      fallback: null,
      enableFallback: false,
      reason: 'user_choice_replicate'
    };
  }

  if (canUseKieAI && availableProviders.includes('kie')) {
    return {
      primary: 'kie',
      fallback: 'replicate',
      enableFallback: true,
      reason: 'auto_kie_priority'
    };
  }

  return {
    primary: 'replicate',
    fallback: null,
    enableFallback: false,
    reason: 'no_kie_access'
  };
}

async function generateWithFallback(options) {
  const {
    modelKey,
    userChoice,
    canUseKieAI,
    kieGenerator,
    replicateGenerator
  } = options;

  const selection = selectProviders(modelKey, userChoice, canUseKieAI);
  console.log('Provider selection:', {
    modelKey,
    primary: selection.primary,
    fallback: selection.fallback,
    enableFallback: selection.enableFallback,
    reason: selection.reason
  });

  if (!selection.primary) {
    return {
      success: false,
      provider: null,
      error: `Model ${modelKey} is not available from any configured provider`,
      triedProviders: []
    };
  }

  const triedProviders = [];
  let lastError = null;

  try {
    const generator = selection.primary === 'kie' ? kieGenerator : replicateGenerator;
    if (!generator) {
      throw new Error(`Missing generator for ${selection.primary}`);
    }

    triedProviders.push(selection.primary);
    const result = await generator();

    if (result.success) {
      return {
        ...result,
        provider: selection.primary,
        triedProviders,
        hadFallback: false
      };
    }

    lastError = result.error || 'Unknown error';
  } catch (error) {
    lastError = error.message;
    console.error(`${selection.primary} provider error:`, error);
  }

  if (selection.fallback && selection.enableFallback) {
    try {
      const generator = selection.fallback === 'kie' ? kieGenerator : replicateGenerator;
      if (!generator) {
        throw new Error(`Missing generator for ${selection.fallback}`);
      }

      triedProviders.push(selection.fallback);
      const result = await generator();

      if (result.success) {
        return {
          ...result,
          provider: selection.fallback,
          triedProviders,
          hadFallback: true,
          primaryError: lastError
        };
      }

      lastError = result.error || lastError || 'Unknown error';
    } catch (error) {
      lastError = error.message || lastError;
      console.error(`${selection.fallback} fallback error:`, error);
    }
  }

  return {
    success: false,
    provider: selection.primary,
    error: lastError || 'Generation failed',
    triedProviders,
    hadFallback: triedProviders.length > 1
  };
}

module.exports = {
  generateWithFallback,
  getAvailableProviders,
  isAvailableOnKIE,
  isAvailableOnReplicate,
  selectProviders
};
