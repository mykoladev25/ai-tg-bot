const { Markup } = require('telegraf');
const { t } = require('./i18n');

function getAppUrl() {
  return (process.env.APP_URL || 'http://127.0.0.1:5500').replace(/\/$/, '');
}

function getPublicUrl(envKey, fallbackPath) {
  const configured = process.env[envKey];
  if (configured) {
    return configured;
  }

  return `${getAppUrl()}${fallbackPath}`;
}

function createMainMenu(localeSource = 'en') {
  return Markup.keyboard([
    [t(localeSource, 'menu.topUpBalance'), t(localeSource, 'menu.creatives')],
    [t(localeSource, 'menu.video'), t(localeSource, 'menu.images')],
    [t(localeSource, 'menu.profile'), t(localeSource, 'menu.assistants')],
    [t(localeSource, 'menu.feedback'), t(localeSource, 'menu.help')]
  ]).resize();
}

function createInlineMenu(buttons, columns = 1) {
  const availableButtons = buttons.filter((button) => button.available !== false);
  const keyboardRows = [];

  for (let index = 0; index < availableButtons.length; index += columns) {
    const row = availableButtons.slice(index, index + columns).map((button) => {
      let text;

      if (button.key === 'veo' && button.costPerSecondAudio && button.costPerSecondNoAudio) {
        const minCost = 4 * button.costPerSecondNoAudio;
        const maxCost = 8 * button.costPerSecondAudio;
        text = `${button.name} (${minCost}—${maxCost}⚡)`;
      } else if (button.key === 'kling_3' && button.durations && (button.costPerSecondNoAudio || button.costPerSecondAudio)) {
        const minCost = Math.min(...button.durations) * (button.costPerSecondNoAudio || 23);
        const maxCost = Math.max(...button.durations) * (button.costPerSecondAudio || 45);
        text = `${button.name} (${minCost}—${maxCost}⚡)`;
      } else if (
        button.key !== 'kling_motion'
        && button.key.startsWith('kling')
        && (button.costPerSecond != null || button.costPerSecondAudio != null)
        && button.durations
      ) {
        const rateWithoutAudio = button.costPerSecond ?? button.costPerSecondNoAudio ?? 12;
        const rateWithAudio = button.costPerSecondAudio ?? button.costPerSecond ?? 12;
        const minCost = Math.min(...button.durations) * rateWithoutAudio;
        const maxCost = Math.max(...button.durations) * rateWithAudio;
        text = `${button.name} (${minCost}—${maxCost}⚡)`;
      } else if (button.key === 'kling_motion' && button.costs) {
        const minCost = button.cost || Math.min(...Object.values(button.costs));
        const maxCost = button.maxCost || Math.max(...Object.values(button.costs));
        text = `${button.name} (${minCost}—${maxCost}⚡)`;
      } else if (button.maxCost && button.cost > 0 && button.maxCost > button.cost) {
        text = `${button.name} (${button.cost}—${button.maxCost}⚡)`;
      } else if (button.cost > 0) {
        text = `${button.name} (${button.cost}⚡)`;
      } else {
        text = button.name;
      }

      return Markup.button.callback(text, button.key);
    });

    keyboardRows.push(row);
  }

  return Markup.inlineKeyboard(keyboardRows);
}

function createBackButton(callback = 'main_menu', text = null, localeSource = 'en') {
  if (text && typeof text === 'object') {
    localeSource = text;
    text = null;
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback(text || t(localeSource, 'common.home'), callback)]
  ]);
}

function createGPTActionsMenu(actions) {
  const buttons = actions.map((action) => {
    const costText = action.cost > 0 ? ` (${action.cost}⚡)` : '';
    return [{ text: `${action.name}${costText}`, callback_data: `gpt_${action.key}` }];
  });

  return { reply_markup: { inline_keyboard: buttons } };
}

function createSubscriptionMenu(localeSource = 'en') {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(localeSource, 'common.buyTokens'), 'buy_subscription')],
    [Markup.button.callback(t(localeSource, 'common.community'), 'community')],
    [Markup.button.callback(t(localeSource, 'common.home'), 'main_menu')]
  ]);
}

function createPaymentMenu(price, plan = 'basic', userId = null, telegramId = null, localeSource = 'en') {
  const appUrl = getAppUrl();

  let wayforpayUrl = `${appUrl}/pay/wayforpay?plan=${plan}`;
  if (userId) {
    wayforpayUrl += `&userId=${userId}`;
  }
  if (telegramId) {
    wayforpayUrl += `&tg_id=${telegramId}`;
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback(t(localeSource, 'payment.telegramStars', { price }), `pay_stars_${plan}`)],
    [Markup.button.url(t(localeSource, 'payment.wayforpay'), wayforpayUrl)],
    [Markup.button.callback(`🔙 ${t(localeSource, 'common.back')}`, 'buy_subscription')],
    [Markup.button.callback(t(localeSource, 'common.home'), 'main_menu')]
  ]);
}

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
      Markup.button.callback('🏠 Menu', 'main_menu')
    ]
  ]);
}

function createConfirmationMenu(action, localeSource = 'en') {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(localeSource, 'common.yes'), `confirm_${action}`),
      Markup.button.callback(t(localeSource, 'common.no'), 'cancel')
    ]
  ]);
}

function createSubscriptionsMenu(userId = null, localeSource = 'en') {
  const models = require('../config/models');
  const accessControl = require('../config/access');
  const subscriptions = models.subscriptions;
  const isAdmin = userId && accessControl.isAdmin(userId);
  const emojis = { starter: '🚀', basic: '💎', pro: '🔥', premium: '👑', starter_test: '🧪' };
  const buttons = [];

  if (isAdmin && subscriptions.starter_test?.adminOnly) {
    buttons.push([Markup.button.callback(t(localeSource, 'subscription.starterTest'), 'sub_starter_test')]);
  }

  buttons.push(
    [
      Markup.button.callback(`${emojis.starter} STARTER`, 'sub_starter'),
      Markup.button.callback(`${emojis.basic} BASIC`, 'sub_basic')
    ],
    [
      Markup.button.callback(`${emojis.pro} PRO`, 'sub_pro'),
      Markup.button.callback(`${emojis.premium} PREMIUM`, 'sub_premium')
    ],
    [Markup.button.callback(t(localeSource, 'common.back'), 'main_menu')]
  );

  return Markup.inlineKeyboard(buttons);
}

function createLegalMenu(localeSource = 'en') {
  const termsUrl = getPublicUrl('TERMS_OF_SERVICE_URL', '/bot/terms');
  const privacyUrl = getPublicUrl('PRIVACY_POLICY_URL', '/bot/privacy');
  const infoUrl = getPublicUrl('COMPANY_INFO_URL', '/bot/info');

  return Markup.inlineKeyboard([
    [Markup.button.url(t(localeSource, 'legal.terms'), termsUrl)],
    [Markup.button.url(t(localeSource, 'legal.privacy'), privacyUrl)],
    [Markup.button.url(t(localeSource, 'legal.company'), infoUrl)],
    [Markup.button.callback(t(localeSource, 'common.home'), 'main_menu')]
  ]);
}

function createProfileMenu(localeSource = 'en') {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(localeSource, 'profile.buyTokens'), 'buy_subscription')],
    [Markup.button.callback(t(localeSource, 'profile.providerChoice'), 'provider_menu')],
    [Markup.button.callback(t(localeSource, 'profile.community'), 'community')],
    [Markup.button.callback(t(localeSource, 'profile.legalInfo'), 'legal_info')],
    [Markup.button.callback(t(localeSource, 'common.home'), 'main_menu')]
  ]);
}

module.exports = {
  createBackButton,
  createConfirmationMenu,
  createGPTActionsMenu,
  createGenerationActionsMenu,
  createInlineMenu,
  createLegalMenu,
  createMainMenu,
  createPaymentMenu,
  createProfileMenu,
  createSubscriptionMenu,
  createSubscriptionsMenu
};
