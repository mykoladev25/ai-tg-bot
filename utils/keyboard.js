const { Markup } = require('telegraf');

/**
 * Головне меню бота
 */
function createMainMenu() {
  return Markup.keyboard([
    ['💡 Claude'],
    ['🎙️ Аудіо з AI', '🎬 Створення відео'],
    ['🎨 Дизайн з AI'],
    ['👤 Профіль', '❓ Допомога', '📄 Інструкція']
  ])
    .resize()
    .persistent();
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
 * Меню покупки підписки
 */
function createSubscriptionMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💳 Купити підписку', 'buy_subscription')],
    [Markup.button.callback('👥 Спільнота', 'community')],
    [Markup.button.callback('🏠 Головне меню', 'main_menu')]
  ]);
}

/**
 * Меню оплати
 */
function createPaymentMenu(price) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`✨ Оплатити ${price}⭐`, 'pay_stars')],
    // [Markup.button.callback('🎁 Ввести промокод', 'enter_promo')],
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

module.exports = {
  createMainMenu,
  createInlineMenu,
  createBackButton,
  createGPTActionsMenu,
  createSubscriptionMenu,
  createPaymentMenu,
  createGenerationActionsMenu,
  createConfirmationMenu
};
