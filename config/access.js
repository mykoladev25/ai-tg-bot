/**
 * Конфіглогіки доступу до функцій
 * Централізоване місце для контролю хто має доступ до яких функцій
 */

// ==================== FEATURE FLAGS ====================

/**
 * Контролювати хто має доступ до вибору провайдера
 *
 * Режими:
 * - 'admin_only' (DEFAULT) - тільки для адміністратора
 * - 'all_users' - для всіх користувачів
 * - 'disabled' - функція вимкнена повністю
 */
const PROVIDER_CHOICE_ACCESS = process.env.PROVIDER_CHOICE_ACCESS || 'admin_only';

/**
 * Контролювати хто має доступ до KIE.AI функцій
 *
 * Режими:
 * - 'admin_only' (DEFAULT) - тільки для адміністратора
 * - 'all_users' - для всіх користувачів
 * - 'disabled' - функція вимкнена повністю
 */
const KIE_AI_ACCESS = process.env.KIE_AI_ACCESS || 'admin_only';

/**
 * Список користувачів які мають повний доступ
 * (незалежно від режимів вище)
 */
const WHITELIST_USERS = (process.env.WHITELIST_USERS || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0);

/**
 * Список користувачів яких слід заблокувати від доступу
 */
const BLACKLIST_USERS = (process.env.BLACKLIST_USERS || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0);

/**
 * Адміністратор
 */
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '';

// ==================== PERMISSION CHECKS ====================

/**
 * Перевіряємо чи користувач є адміністратором
 */
function isAdmin(userId) {
  return String(userId) === String(ADMIN_ID);
}

/**
 * Перевіряємо чи користувач у whitelist
 */
function isWhitelisted(userId) {
  return WHITELIST_USERS.includes(String(userId));
}

/**
 * Перевіряємо чи користувач у blacklist
 */
function isBlacklisted(userId) {
  return BLACKLIST_USERS.includes(String(userId));
}

/**
 * Головна функція для перевірки доступу до функції
 *
 * @param {number} userId - ID користувача
 * @param {string} feature - назва функції ('provider_choice', 'kie_ai')
 * @returns {boolean} - true якщо доступ дозволений
 */
function hasAccess(userId, feature) {
  // Blacklist перевіряємо першим - блокуємо навіть адмінів якщо вони у blacklist
  if (isBlacklisted(userId)) {
    console.warn(`⛔ User ${userId} is blacklisted`);
    return false;
  }

  // Whitelist - автоматичний доступ
  if (isWhitelisted(userId)) {
    console.log(`✅ User ${userId} is whitelisted`);
    return true;
  }

  // Адміни мають доступ до всього
  if (isAdmin(userId)) {
    console.log(`👑 Admin access: ${userId}`);
    return true;
  }

  // Перевіряємо режим доступу для конкретної функції
  let accessMode = 'admin_only'; // default

  if (feature === 'provider_choice') {
    accessMode = PROVIDER_CHOICE_ACCESS;
  } else if (feature === 'kie_ai') {
    accessMode = KIE_AI_ACCESS;
  }

  if (accessMode === 'all_users') {
    console.log(`📊 User ${userId} has ${feature} access (all_users mode)`);
    return true;
  } else if (accessMode === 'admin_only') {
    console.log(`🔒 User ${userId} denied ${feature} (admin_only mode)`);
    return false;
  } else if (accessMode === 'disabled') {
    console.log(`❌ Feature ${feature} is disabled`);
    return false;
  }

  return false;
}

/**
 * Перевірка для команди /provider
 */
function canUseProviderChoice(userId) {
  return hasAccess(userId, 'provider_choice');
}

/**
 * Перевірка для KIE.AI генерацій
 */
function canUseKieAI(userId) {
  return hasAccess(userId, 'kie_ai');
}

// ==================== DEBUG / LOGGING ====================

/**
 * Вивести поточні налаштування
 */
function printConfig() {
  console.log(`
╔════════════════════════════════════════════════════════╗
║         PROVIDER ACCESS CONFIGURATION                  ║
╠════════════════════════════════════════════════════════╣
║ PROVIDER_CHOICE_ACCESS: ${PROVIDER_CHOICE_ACCESS.padEnd(40)} ║
║ KIE_AI_ACCESS:         ${KIE_AI_ACCESS.padEnd(40)} ║
║ ADMIN_ID:              ${ADMIN_ID.padEnd(40)} ║
║ WHITELIST_USERS:       ${WHITELIST_USERS.length} користувачів       ${' '.repeat(29)} ║
║ BLACKLIST_USERS:       ${BLACKLIST_USERS.length} користувачів       ${' '.repeat(29)} ║
╚════════════════════════════════════════════════════════╝
  `);
}

// ==================== EXPORT ====================

module.exports = {
  // Constants
  PROVIDER_CHOICE_ACCESS,
  KIE_AI_ACCESS,
  WHITELIST_USERS,
  BLACKLIST_USERS,
  ADMIN_ID,

  // Functions
  isAdmin,
  isWhitelisted,
  isBlacklisted,
  hasAccess,
  canUseProviderChoice,
  canUseKieAI,

  // Helpers
  printConfig
};

