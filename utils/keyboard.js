const { Markup } = require('telegraf');

/**
 * Головне меню бота
 */
function createMainMenu() {
  return Markup.keyboard([
    ['🧠 Помічники', '🎨 Креативи'],
    ['🎬 Відео', '🖼️ Зображення'],
    ['👤 Профіль', '❓ Допомога'],
    ['📝 Feedback', '📄 Інструкція']
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
      const text = btn.cost > 0 ? `${btn.name} (${btn.cost}⚡)` : btn.name;
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

  return Markup.inlineKeyboard([
    [Markup.button.callback(`💫 Telegram Stars (${price}⭐)`, `pay_stars_${plan}`)],
    [Markup.button.url(`💳 LiqPay (Карта/Apple/Google)`, liqpayUrl)],
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
  
  const buttons = [];
  
  const paidPlans = ['starter', 'basic', 'pro', 'premium'];
  
  paidPlans.forEach(planKey => {
    const sub = subscriptions[planKey];
    if (sub) {
      let emoji = '';
      if (planKey === 'starter') emoji = '🚀';
      else if (planKey === 'basic') emoji = '💎';
      else if (planKey === 'pro') emoji = '🔥';
      else if (planKey === 'premium') emoji = '👑';
      
      buttons.push([
        Markup.button.callback(
          `${emoji} ${sub.name}\n ${sub.tokens}⚡ | ⭐ ${sub.price}`,
          `sub_${planKey}`
        )
      ]);
    }
  });
  
  buttons.push([Markup.button.callback('🔙 Назад', 'main_menu')]);
  
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
