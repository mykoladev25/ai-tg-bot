const PROVIDER_CHOICE_ACCESS = process.env.PROVIDER_CHOICE_ACCESS || 'all_users';
const KIE_AI_ACCESS = process.env.KIE_AI_ACCESS || 'all_users';
const KIE_AI_USE_CACHE_PRICING = process.env.KIE_AI_USE_CACHE_PRICING !== 'false';

const WHITELIST_USERS = (process.env.WHITELIST_USERS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const BLACKLIST_USERS = (process.env.BLACKLIST_USERS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const ADMIN_IDS = [
  process.env.ADMIN_TELEGRAM_ID,
  process.env.ADMIN_TELEGRAM_ID_2
]
  .filter(Boolean)
  .map((id) => String(id).trim())
  .filter(Boolean);

const ADMIN_ID = ADMIN_IDS[0] || '';

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function getAdminIds() {
  return [...ADMIN_IDS];
}

function isWhitelisted(userId) {
  return WHITELIST_USERS.includes(String(userId));
}

function isBlacklisted(userId) {
  return BLACKLIST_USERS.includes(String(userId));
}

function hasAccess(userId, feature) {
  if (isBlacklisted(userId)) {
    console.warn(`Access denied for blacklisted user ${userId}`);
    return false;
  }

  if (isWhitelisted(userId)) {
    console.log(`Whitelist access granted for user ${userId}`);
    return true;
  }

  if (isAdmin(userId)) {
    console.log(`Admin access granted for user ${userId}`);
    return true;
  }

  let accessMode = 'admin_only';
  if (feature === 'provider_choice') {
    accessMode = PROVIDER_CHOICE_ACCESS;
  } else if (feature === 'kie_ai') {
    accessMode = KIE_AI_ACCESS;
  }

  if (accessMode === 'all_users') {
    return true;
  }

  if (accessMode === 'admin_only' || accessMode === 'disabled') {
    return false;
  }

  return false;
}

function canUseProviderChoice(userId) {
  return hasAccess(userId, 'provider_choice');
}

function canUseKieAI(userId) {
  return hasAccess(userId, 'kie_ai');
}

function printConfig() {
  const pricingMode = KIE_AI_USE_CACHE_PRICING ? 'cache pricing' : 'models.js pricing';
  console.log(`
╔════════════════════════════════════════════════════════╗
║               ACCESS CONFIGURATION                    ║
╠════════════════════════════════════════════════════════╣
║ PROVIDER_CHOICE_ACCESS: ${PROVIDER_CHOICE_ACCESS.padEnd(40)} ║
║ KIE_AI_ACCESS:         ${KIE_AI_ACCESS.padEnd(40)} ║
║ KIE pricing mode:      ${pricingMode.padEnd(40)} ║
║ ADMIN_IDS:             ${(ADMIN_IDS.join(', ') || 'none').padEnd(40)} ║
║ WHITELIST_USERS:       ${String(WHITELIST_USERS.length).padEnd(40)} ║
║ BLACKLIST_USERS:       ${String(BLACKLIST_USERS.length).padEnd(40)} ║
╚════════════════════════════════════════════════════════╝
  `);
}

module.exports = {
  ADMIN_ID,
  ADMIN_IDS,
  BLACKLIST_USERS,
  KIE_AI_ACCESS,
  KIE_AI_USE_CACHE_PRICING,
  PROVIDER_CHOICE_ACCESS,
  WHITELIST_USERS,
  canUseKieAI,
  canUseProviderChoice,
  getAdminIds,
  hasAccess,
  isAdmin,
  isBlacklisted,
  isWhitelisted,
  printConfig
};
