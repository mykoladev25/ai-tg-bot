const { Markup } = require('telegraf');

/**
 * Головне меню бота
 */
function createMainMenu() {
  return Markup.keyboard([
    ['🧠 Помічники', '🎨 Креативи'],
    ['🎬 Відео', '🖼️ Зображення'],
    ['👤 Профіль', '💰 Поповнити баланс'],
    ['📝 Feedback', '❓ Допомога']
  ]).resize();
}

/**
 * Inline меню (кнопки під повідомленням)
 */
function createInlineMenu(buttons, columns = 1) {
  const availableButtons = buttons.filter(btn => btn.available !== false);

  const keyboard = [];

  for (let i = 0; i < availableButtons.length; i += columns) {
    const row = availableButtons.slice(i, i + columns).map(btn => {
      let text;

      // Для Veo показуємо діапазон цін
      if (btn.key === 'veo' && btn.costPerSecondAudio && btn.costPerSecondNoAudio) {
        const minCost = 4 * btn.costPerSecondNoAudio;  // 4 сек без аудіо
        const maxCost = 8 * btn.costPerSecondAudio;    // 8 сек з аудіо
        text = `${btn.name} (${minCost}—${maxCost}⚡)`;
      }
      // Для Kling показуємо діапазон цін
      else if (btn.key !== 'kling_motion' && btn.key.startsWith('kling') && btn.costPerSecond && btn.durations) {
        const minCost = Math.min(...btn.durations) * btn.costPerSecond;
        const maxCost = Math.max(...btn.durations) * btn.costPerSecond;
        text = `${btn.name} (${minCost}—${maxCost}⚡)`;
      }
      // Для Kling Motion показуємо діапазон цін
      else if (btn.key === 'kling_motion' && btn.costs) {
        const minCost = btn.cost || Math.min(...Object.values(btn.costs));
        const maxCost = btn.maxCost || Math.max(...Object.values(btn.costs));
        text = `${btn.name} (${minCost}—${maxCost}⚡)`;
      }
      else if (btn.cost > 0) {
        text = `${btn.name} (${btn.cost}⚡)`;
      } else {
        text = btn.name;
      }

      return Markup.button.callback(text, btn.key);
    });
    keyboard.push(row);
  }

  return Markup.inlineKeyboard(keyboard);
}

/**
 * Кнопка "Назад до головного меню"
 */
function createBackButton(callback = 'main_menu', text = '🏠 Головне меню') {
  return Markup.inlineKeyboard([
    [Markup.button.callback(text, callback)]
  ]);
}

/**
 * Меню GPT з діями
 */
function createGPTActionsMenu(actions) {
  const buttons = actions.map(action => {
    const costText = action.cost > 0 ? ` (${action.cost}⚡)` : '';
    return [{ text: `${action.name}${costText}`, callback_data: `gpt_${action.key}` }];
  });

  return { reply_markup: { inline_keyboard: buttons } };
}

/**
 * Меню покупки токенів
 */
function createSubscriptionMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰 Купити токени', 'buy_subscription')],
    [Markup.button.callback('👥 Спільнота', 'community')],
    [Markup.button.callback('🏠 Головне меню', 'main_menu')]
  ]);
}

/**
 * Меню оплати
 */
function createPaymentMenu(price, plan = 'basic', userId = null, telegramId = null) {
  const appUrl = process.env.APP_URL || 'http://127.0.0.1:5500';
  const isProduction = process.env.NODE_ENV === 'production';

  // Build URL with both userId and telegramId
  let stripeUrl = `${appUrl}/pay/stripe?plan=${plan}`;
  if (userId) {
    stripeUrl += `&userId=${userId}`;
  }
  if (telegramId) {
    stripeUrl += `&tg_id=${telegramId}`;
  }

  // LiqPay URL
  let liqpayUrl = `${appUrl}/pay/liqpay?plan=${plan}`;
  if (userId) {
    liqpayUrl += `&userId=${userId}`;
  }
  if (telegramId) {
    liqpayUrl += `&tg_id=${telegramId}`;
  }

  // WayForPay URL
  let wayforpayUrl = `${appUrl}/pay/wayforpay?plan=${plan}`;
  if (userId) {
    wayforpayUrl += `&userId=${userId}`;
  }
  if (telegramId) {
    wayforpayUrl += `&tg_id=${telegramId}`;
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback(`💫 Telegram Stars (${price}⭐)`, `pay_stars_${plan}`)],
    [Markup.button.url(`💳 WayForPay (Карта/Apple/Google)`, wayforpayUrl)],
    // Use webApp only in production (HTTPS), use regular URL for development
    // [isProduction
    //   ? Markup.button.webApp(`💳 Stripe (Card/Apple/Google)`, stripeUrl)
    //   : Markup.button.url(`💳 Stripe (Card/Apple/Google)`, stripeUrl)
    // ],
    [Markup.button.callback('🔙 Назад', 'buy_subscription')],
    [Markup.button.callback('🏠 Головне меню', 'main_menu')]
  ]);
}

/**
 * Меню після генерації (для Midjourney з варіаціями)
 */
function createGenerationActionsMenu(taskId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('U1', `upscale_${taskId}_1`),
      Markup.button.callback('U2', `upscale_${taskId}_2`),
      Markup.button.callback('U3', `upscale_${taskId}_3`),
      Markup.button.callback('U4', `upscale_${taskId}_4`)
    ],
    [
      Markup.button.callback('V1', `vary_${taskId}_1`),
      Markup.button.callback('V2', `vary_${taskId}_2`),
      Markup.button.callback('V3', `vary_${taskId}_3`),
      Markup.button.callback('V4', `vary_${taskId}_4`)
    ],
    [
      Markup.button.callback('🔄 Regenerate', `regen_${taskId}`),
      Markup.button.callback('🏠 Меню', 'main_menu')
    ]
  ]);
}

/**
 * Меню підтвердження
 */
function createConfirmationMenu(action) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Так', `confirm_${action}`),
      Markup.button.callback('❌ Ні', 'cancel')
    ]
  ]);
}

/**
 * Створити меню підписок динамічно
 */
function createSubscriptionsMenu() {
  const models = require('../config/models');
  const subscriptions = models.subscriptions;
  
  const paidPlans = ['starter', 'basic', 'pro', 'premium'];
  const emojis = { starter: '🚀', basic: '💎', pro: '🔥', premium: '👑' };

  // Показуємо tokensWayForPay (більше токенів за картку) на кнопках
  const getTokens = (plan) => subscriptions[plan].tokensWayForPay || subscriptions[plan].tokens;

  // По 2 кнопки в ряд
  const buttons = [
    [
      Markup.button.callback(`${emojis.starter} ${getTokens('starter')}⚡`, 'sub_starter'),
      Markup.button.callback(`${emojis.basic} ${getTokens('basic')}⚡`, 'sub_basic')
    ],
    [
      Markup.button.callback(`${emojis.pro} ${getTokens('pro')}⚡`, 'sub_pro'),
      Markup.button.callback(`${emojis.premium} ${getTokens('premium')}⚡`, 'sub_premium')
    ],
    [Markup.button.callback('← Назад', 'main_menu')]
  ];

  return Markup.inlineKeyboard(buttons);
}

/**
 * Меню з юридичною інформацією (Угода користувача, Політика приватності, Інформація про компанію)
 */
function createLegalMenu() {
  const termsUrl = process.env.TERMS_OF_SERVICE_URL || 'https://neurolab.fun/bot/terms';
  const privacyUrl = process.env.PRIVACY_POLICY_URL || 'https://neurolab.fun/bot/privacy';
  const infoUrl = process.env.COMPANY_INFO_URL || 'https://neurolab.fun/bot/info';

  return Markup.inlineKeyboard([
    [Markup.button.url('📋 Угода користувача', termsUrl)],
    [Markup.button.url('🔒 Політика приватності', privacyUrl)],
    [Markup.button.url('ℹ️ Інформація про компанію', infoUrl)],
    [Markup.button.callback('🏠 Головне меню', 'main_menu')]
  ]);
}

/**
 * Кнопки для профілю з доступом до юридичної інформації
 */
function createProfileMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰 Купити токени', 'buy_subscription')],
    [Markup.button.callback('👥 Спільнота', 'community')],
    [Markup.button.callback('📋 Юридична інформація', 'legal_info')],
    [Markup.button.callback('🏠 Головне меню', 'main_menu')]
  ]);
}

module.exports = {
  createMainMenu,
  createInlineMenu,
  createBackButton,
  createGPTActionsMenu,
  createSubscriptionMenu,
  createPaymentMenu,
  createGenerationActionsMenu,
  createConfirmationMenu,
  createSubscriptionsMenu,
  createLegalMenu,
  createProfileMenu
};
