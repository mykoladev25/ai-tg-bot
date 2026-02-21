/**
 * Provider Fallback System
 *
 * Автоматичний fallback між KIE.AI та Replicate з пріоритетом на KIE
 *
 * Логіка:
 * 1. Перевіряємо де модель доступна (KIE, Replicate, обидва)
 * 2. Якщо модель тільки на одному провайдері - використовуємо його
 * 3. Якщо на обох - пробуємо KIE спершу (дешевше)
 * 4. Якщо KIE падає - автоматично fallback на Replicate
 * 5. Якщо користувач явно обрав провайдер - поважаємо вибір (без fallback)
 */

const kieAI = require('../services/kie-ai');

/**
 * Перевірити чи модель доступна на KIE.AI
 */
function isAvailableOnKIE(modelKey) {
  return kieAI.isKieAIImplemented(modelKey);
}

/**
 * Перевірити чи модель доступна на Replicate
 */
function isAvailableOnReplicate(modelKey) {
  // Моделі які є ТІЛЬКИ на KIE (не на Replicate)
  const kieOnlyModels = [
    'kling_3',           // Kling 3.0 Pro
    'midjourney',        // Midjourney
    'z_image'            // Z-Image (Qwen)
  ];

  return !kieOnlyModels.includes(modelKey);
}

/**
 * Визначити доступні провайдери для моделі
 */
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

/**
 * Вибрати провайдер з урахуванням вибору користувача
 *
 * @param {string} modelKey - Ключ моделі
 * @param {string} userChoice - Вибір користувача ('kie-ai', 'replicate', 'auto', null)
 * @param {boolean} canUseKieAI - Чи має користувач доступ до KIE.AI
 * @returns {Object} { primary, fallback, enableFallback }
 */
function selectProviders(modelKey, userChoice, canUseKieAI) {
  const available = getAvailableProviders(modelKey);

  // Якщо модель доступна тільки на одному провайдері
  if (available.length === 1) {
    return {
      primary: available[0],
      fallback: null,
      enableFallback: false,
      reason: 'single_provider'
    };
  }

  // Якщо модель недоступна взагалі
  if (available.length === 0) {
    return {
      primary: null,
      fallback: null,
      enableFallback: false,
      reason: 'no_provider'
    };
  }

  // Модель доступна на обох провайдерах

  // Користувач явно обрав KIE.AI
  if (userChoice === 'kie-ai') {
    if (!canUseKieAI) {
      // Немає доступу до KIE - fallback на Replicate
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
      enableFallback: false,  // Користувач обрав KIE - не робимо fallback
      reason: 'user_choice_kie'
    };
  }

  // Користувач явно обрав Replicate
  if (userChoice === 'replicate') {
    return {
      primary: 'replicate',
      fallback: null,
      enableFallback: false,  // Користувач обрав Replicate - не робимо fallback
      reason: 'user_choice_replicate'
    };
  }

  // AUTO режим або немає вибору - розумний вибір з fallback
  if (canUseKieAI && available.includes('kie')) {
    return {
      primary: 'kie',
      fallback: 'replicate',
      enableFallback: true,  // AUTO - дозволяємо fallback
      reason: 'auto_kie_priority'
    };
  }

  // Немає доступу до KIE - тільки Replicate
  return {
    primary: 'replicate',
    fallback: null,
    enableFallback: false,
    reason: 'no_kie_access'
  };
}

/**
 * Виконати генерацію з автоматичним fallback
 *
 * @param {Object} options
 * @param {string} options.modelKey - Ключ моделі
 * @param {string} options.userChoice - Вибір користувача провайдера
 * @param {boolean} options.canUseKieAI - Чи має доступ до KIE.AI
 * @param {Function} options.kieGenerator - async () => result для KIE.AI
 * @param {Function} options.replicateGenerator - async () => result для Replicate
 * @param {Object} options.context - Контекст для логування (userId, modelName, etc)
 * @returns {Promise<Object>} { success, provider, ...result }
 */
async function generateWithFallback(options) {
  const {
    modelKey,
    userChoice,
    canUseKieAI,
    kieGenerator,
    replicateGenerator,
    context = {}
  } = options;

  const selection = selectProviders(modelKey, userChoice, canUseKieAI);

  console.log('🎯 Provider selection:', {
    modelKey,
    primary: selection.primary,
    fallback: selection.fallback,
    enableFallback: selection.enableFallback,
    reason: selection.reason
  });

  // Якщо немає доступних провайдерів
  if (!selection.primary) {
    return {
      success: false,
      provider: null,
      error: `Модель ${modelKey} недоступна на жодному провайдері`,
      triedProviders: []
    };
  }

  const triedProviders = [];
  let lastError = null;

  // Пробуємо primary провайдер
  try {
    const generator = selection.primary === 'kie' ? kieGenerator : replicateGenerator;

    if (!generator) {
      throw new Error(`No generator function for ${selection.primary}`);
    }

    console.log(`🔥 Trying PRIMARY: ${selection.primary} for ${modelKey}`);
    triedProviders.push(selection.primary);

    const result = await generator();

    if (result.success) {
      console.log(`✅ ${selection.primary} succeeded for ${modelKey}`);
      return {
        ...result,
        provider: selection.primary,
        triedProviders,
        hadFallback: false
      };
    }

    // Primary провайдер повернув помилку
    lastError = result.error || 'Unknown error';
    console.log(`❌ ${selection.primary} failed: ${lastError}`);

  } catch (error) {
    lastError = error.message;
    console.error(`❌ ${selection.primary} exception:`, error);
  }

  // Якщо є fallback і він дозволений - пробуємо
  if (selection.fallback && selection.enableFallback) {
    try {
      const generator = selection.fallback === 'kie' ? kieGenerator : replicateGenerator;

      if (!generator) {
        throw new Error(`No generator function for ${selection.fallback}`);
      }

      console.log(`🔄 Trying FALLBACK: ${selection.fallback} for ${modelKey}`);
      triedProviders.push(selection.fallback);

      const result = await generator();

      if (result.success) {
        console.log(`✅ ${selection.fallback} succeeded (FALLBACK) for ${modelKey}`);
        return {
          ...result,
          provider: selection.fallback,
          triedProviders,
          hadFallback: true,
          primaryError: lastError
        };
      }

      lastError = result.error || 'Unknown error';
      console.log(`❌ ${selection.fallback} failed: ${lastError}`);

    } catch (error) {
      lastError = error.message;
      console.error(`❌ ${selection.fallback} exception:`, error);
    }
  }

  // Всі провайдери не спрацювали
  return {
    success: false,
    provider: null,
    error: lastError,
    triedProviders,
    hadFallback: selection.enableFallback
  };
}

module.exports = {
  isAvailableOnKIE,
  isAvailableOnReplicate,
  getAvailableProviders,
  selectProviders,
  generateWithFallback
};

