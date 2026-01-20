require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const express = require('express');
const groqWhisper = require('./services/groq-whisper');
const adminNotifier = require('./utils/adminNotifier');

// Імпортуємо сервіси
const claude = require('./services/claude');
const midjourney = require('./services/midjourney');
const replicate = require('./services/replicate');
const payment = require('./services/payment');
const exchangeRate = require('./services/exchangeRate');

// Імпортуємо webhooks
const stripeWebhook = require('./webhooks/stripe');

// Імпортуємо утиліти
const keyboard = require('./utils/keyboard');
const userBalance = require('./utils/userBalance');
const blockedUsersUtil = require('./utils/blockedUsers');
const db = require('./database/connection');

// Імпортуємо конфігурацію
const models = require('./config/models');

// Ініціалізація бота
const bot = new Telegraf(process.env.BOT_TOKEN);

const isDevelopment = false;
const isShowBroadCast = process.env.SEND_STARTUP_BROADCAST === 'true' && false;

// ==================== DATA STORAGE ====================
// Для збирання feedback від користувачів
const feedbackData = new Map(); // userId -> { type, message, timestamp }

// ✅ МОДЕЛІ КОТРІ ПІДТРИМУЮТЬ ВИБІР ASPECT RATIO
const MODELS_WITH_ASPECT_RATIO = [
  'nano_banana_2k',
  'nano_banana_4k',
  'seedream_2k',
  'seedream_4k',
  'stable_diffusion',
  'ideogram'
];

// ✅ МАСИВ МОДЕЛЕЙ З БАГАТОКРОКОВИМ ПРОЦЕСОМ
const MODELS_WITH_STATE = [
  'kling_motion',           // фото + відео (20s+)
  'kling_motion_minimal',   // фото + відео (<10s)
  'nano_banana_pro',        // вибір розміру (майбутнє)
  ...MODELS_WITH_ASPECT_RATIO // добавляємо моделі з вибором aspect ratio
];

// ✅ MIDDLEWARE: обнуляти стан при callback (крім моделей зі станами)
bot.on('callback_query', async (ctx, next) => {
  const callbackData = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);
  
  // ✅ ДОЗВОЛЯЄМО ASPECT RATIO CALLBACKS
  if (callbackData.startsWith('aspect_ratio_')) {
    return next();
  }

  if (MODELS_WITH_STATE.includes(callbackData)) {
    return next();
  }
  
  if (MODELS_WITH_STATE.includes(currentModel) && state) {
    const allowedNavigation = ['video_menu', 'design_menu', 'audio_menu', 'main_menu'];
    if (allowedNavigation.includes(callbackData)) {
      return next();
    }
  }
  
  userCurrentModel.delete(userId);
  userState.delete(userId);
  
  return next();
});

// ==================== FEEDBACK HANDLER ====================

// Обробник для текстового feedback
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Якщо користувач заповнює feedback
  if (feedbackData.has(userId) && !text.startsWith('/')) {
    const feedback = feedbackData.get(userId);

    if (text.length > 1000) {
      await ctx.reply('⚠️ Занадто довгий текст! Максимум 1000 символів.');
      return;
    }

    await sendFeedbackToAdmin(feedback, text, ctx);
    feedbackData.delete(userId);
    return;
  }

  // Перевіряємо чи користувач заблокований
  const isBlocked = await blockedUsersUtil.isUserBlocked(userId);
  if (isBlocked) {
    await ctx.reply('🚫 Ви були заблоковані та не можете користуватися цим ботом.');
    return;
  }

  return next();
});

// Обробник для зображень/фото у feedback
bot.on(['photo', 'document'], async (ctx, next) => {
  const userId = ctx.from.id;

  // Якщо користувач заповнює feedback та надсилає фото/документ
  if (feedbackData.has(userId)) {
    const feedback = feedbackData.get(userId);

    // Отримуємо caption як текст feedback
    const text = ctx.message.caption || '[Скрін з помилкою/проблемою]';

    if (text.length > 1000) {
      await ctx.reply('⚠️ Занадто довгий текст! Максимум 1000 символів.');
      return;
    }

    // Отримуємо ID зображення для пересилання
    let fileId = null;
    if (ctx.message.photo) {
      // Беремо найбільше фото
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
    }

    await sendFeedbackToAdmin(feedback, text, ctx, fileId);
    feedbackData.delete(userId);
    return;
  }

  return next();
});

// Допоміжна функція для відправки feedback адміну
async function sendFeedbackToAdmin(feedback, text, ctx, fileId = null) {
  feedback.message = text;
  feedback.timestamp = new Date();

  // Відправляємо feedback адміну
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (adminId) {
    const adminMessage = `📨 <b>Новий ${feedback.typeName.toLowerCase()}</b>

👤 Від: @${feedback.username} (${feedback.firstName})
🆔 ID: ${feedback.userId}
⏰ ${feedback.timestamp.toLocaleString('uk-UA')}

📝 <b>Текст:</b>
${feedback.message}`;

    const adminKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Прийняти', `feedback_confirm_${feedback.userId}`)],
      [Markup.button.callback('❌ Відхилити', `feedback_decline_${feedback.userId}`)],
      [Markup.button.callback('🚫 Заблокувати', `feedback_block_${feedback.userId}`)]
    ]);

    try {
      // Якщо є зображення/документ, пересилаємо його з текстом
      if (fileId) {
        if (ctx.message.photo) {
          await bot.telegram.sendPhoto(adminId, fileId, {
            caption: adminMessage,
            parse_mode: 'HTML',
            reply_markup: adminKeyboard.reply_markup
          });
        } else if (ctx.message.document) {
          await bot.telegram.sendDocument(adminId, fileId, {
            caption: adminMessage,
            parse_mode: 'HTML',
            reply_markup: adminKeyboard.reply_markup
          });
        }
      } else {
        // Якщо немає зображення, просто надсилаємо текст
        await bot.telegram.sendMessage(adminId, adminMessage, {
          parse_mode: 'HTML',
          ...adminKeyboard
        });
      }
    } catch (error) {
      console.error('❌ Error sending feedback to admin:', error.message);
    }
  }

  // Відповідаємо користувачу
  await ctx.reply(
    `✅ <b>Дякуємо за ваш ${feedback.typeName.toLowerCase()}!</b>

Ми отримали ваше звернення и розглянемо його найближчим часом.`,
    { parse_mode: 'HTML', ...keyboard.createMainMenu() }
  );
}

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  // Перевіряємо чи користувач заблокований
  const isBlocked = await blockedUsersUtil.isUserBlocked(userId);
  if (isBlocked) {
    await ctx.reply('🚫 Ви були заблоковані та не можете користуватися цим ботом.');
    return;
  }

  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);
  
  // Кнопки головного меню (обнуляють стан) - тільки короткі версії
  const menuButtons = [
    '🧠 Помічники',
    '🎨 Креативи',
    '🎬 Відео',
    '🖼️ Зображення',
    '👤 Профіль',
    '❓ Допомога',
    '📝 Feedback',
    '📄 Інструкція'
  ];
  
  // Якщо натиснута кнопка меню - обнуляємо
  if (menuButtons.includes(text)) {
    userCurrentModel.delete(userId);
    userState.delete(userId);
  }
  
  // Якщо звичайний текст (промпт) - НЕ обнуляємо, передаємо далі
  return next();
});

if (isDevelopment) {
  console.log('🛠️ Development mode - maintenance message enabled');
  
  bot.use(async (ctx, next) => {
    const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID || '0');
    
    if (ctx.from.id === adminId) {
      console.log(`✅ Admin ${ctx.from.id} bypassed maintenance`);
      return next();
    }
    
    await ctx.reply(
      '🛠️ Бот тимчасово недоступний\n\n' +
      '⚙️ Триває технічне обслуговування\n' +
      '⏰ Очікуваний час: ~30 хвилин\n\n' +
      'Спробуйте пізніше! Дякуємо за розуміння 🙏'
    );
    
    console.log(`🚫 Blocked user ${ctx.from.id} (@${ctx.from.username}) during maintenance`);
  });
}

const userCurrentModel = new Map();
const userState = new Map();
const mediaGroups = new Map();

const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '@nnn_ddddddd';

const INSTRUCTION_HTML = `
📄 <b>ІНСТРУКЦІЯ</b>

📝 <b>Як користуватися ботом:</b>

<b>1️⃣ GPT / Claude</b>
- Оберіть режим: <i>текст / голос / зображення</i>
- Надішліть запит
- Отримайте відповідь від AI

<b>2️⃣ Генерація зображень</b>
- Оберіть модель (<i>Nano Banana, тощо</i>)
- Опишіть, що хочете побачити
- Очікуйте результат <i>(~30–60 сек)</i>

<b>3️⃣ Генерація відео</b>
- Оберіть модель
- Надішліть текстовий опис
- Відео буде готове <i>за 2–5 хвилин</i>

💰 <b>Токени ⚡</b>
- <b>Кожна генерація списує токени</b>
- 🎁 <b>Безкоштовно:</b> 75⚡ при реєстрації
- 💎 Купіть підписку для більшої кількості

<i>⚡ Тарифи вказані біля кожної моделі</i>

📜 <b>Політика білінгу</b>

- Бот використовує сторонні AI-сервіси
  <i>(Replicate, Runway тощо)</i>

- <b>Ви купуєте внутрішні токени ⚡</b>, а не прямий API-доступ

- <b>Токени списуються за кожну AI-дію</b>

⚠️ <b>Важливо:</b>
- <b>Генерація може не відповідати очікуванням</b> — це особливість AI
- <b>Повернення токенів за виконані дії не передбачено</b>

📋 <b>Юридична інформація:</b>
Перед оплатою ознайомтесь з нашими документами:
- Угода користувача
- Політика приватності

Введіть команду <i>/info</i> для перегляду юридичної інформації.

ℹ️ Використовуючи бота, ви погоджуєтеся з умовами обслуговування.
`;

// ==================== КОМАНДИ ====================

bot.start(async (ctx) => {
  const userId = ctx.from.id;

  // Перевіряємо чи користувач заблокований
  const isBlocked = await blockedUsersUtil.isUserBlocked(userId);
  if (isBlocked) {
    await ctx.reply('🚫 Ви були заблоковані та не можете користуватися цим ботом.');
    return;
  }

  const user = await userBalance.getUser(userId, ctx.from);

  const welcomeMessage = `🏠 Головне меню

Привіт, ${ctx.from.first_name}!

Я neuro\u200B.lab\u200B.ai - ваш помічник з AI генерації.

💰 Ваш баланс: ${user.tokens.toFixed(2)}⚡ FREE

Виберіть бажаний розділ 👇`;

  await ctx.reply(welcomeMessage, keyboard.createMainMenu());
});

bot.command('help', async (ctx) => {
  const helpText = `❓ Допомога

🤖 Доступні команди:
/start - Головне меню
/profile - Ваш профіль
/balance - Перевірити баланс
/history - Історія використання
/clear - Очистити історію розмови
/feedback - Форма зворотнього зв'язку
/info - Юридична інформація та угода користувача
/help - Ця довідка

💡 Як користуватися:
1. Виберіть розділ у головному меню
2. Оберіть модель для генерації
3. Надішліть текстовий запит
4. Чекайте на результат

💰 Токени витрачаються за кожну генерацію
📦 Купіть підписку для отримання більше токенів

👤 Підтримка:
📧 Email: cherevan.n.s@gmail.com
📱 Телефон: +34 605 260 851
💬 Telegram: https://t.me/nnn_ddddddd

📋 Важлива інформація:
🔗 Угода користувача: /info
🔗 Політика приватності: /info
🔗 Інформація про компанію: /info

© 2026 neuro.lab.ai Всі права захищені.`;

  await ctx.reply(helpText, keyboard.createBackButton());
});

bot.command('profile', async (ctx) => {
  await showProfile(ctx);
});

bot.command('balance', async (ctx) => {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);
  await ctx.reply(
    `💰 Ваш баланс: ${user.tokens.toFixed(2)}⚡`,
    keyboard.createBackButton()
  );
});

bot.command('history', async (ctx) => {
  const history = await userBalance.getTransactionHistory(ctx.from.id, 10);
  
  if (history.length === 0) {
    await ctx.reply('📊 Історія порожня', keyboard.createBackButton());
    return;
  }
  
  let text = '📊 Історія останніх операцій:\n\n';
  
  history.forEach((item, index) => {
    const date = new Date(item.createdAt).toLocaleString('uk-UA');
    const sign = item.type === 'deduction' ? '-' : '+';
    text += `${index + 1}. ${date}\n`;
    text += `   ${item.description || 'Транзакція'}\n`;
    text += `   ${sign}${item.amount.toFixed(2)}⚡ (баланс: ${item.balanceAfter.toFixed(2)}⚡)\n\n`;
  });
  
  await ctx.reply(text, keyboard.createBackButton());
});

bot.command('clear', async (ctx) => {
  await userBalance.clearConversationHistory(ctx.from.id);
  await ctx.reply('✅ Історію розмови очищено!', keyboard.createMainMenu());
});

bot.command('info', async (ctx) => {
  const message = `📋 <b>Юридична інформація та Угода користувача</b>

Перед використанням сервісу ознайомтесь з нашими юридичними документами:

<b>📋 Угода користувача</b>
Регулює умови надання послуг та взаємовідносини між користувачем та компанією. Включає описання всіх товарів/послуг та їхні вартості.

<b>🔒 Політика приватності</b>
Описує як ми збираємо, обробляємо та захищаємо вашу персональну інформацію.

Натисніть на кнопку нижче щоб ознайомитися з повним текстом документів:`;

  await ctx.reply(message, { parse_mode: 'HTML', ...keyboard.createLegalMenu() });
});

bot.command('feedback', async (ctx) => {
  const feedbackMenu = `📝 <b>Форма зворотнього зв'язку</b>

Яка причина вашого звернення?

Оберіть категорію 👇`;

  const feedbackKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💡 Побажання', 'feedback_suggestion')],
    [Markup.button.callback('🐛 Проблема', 'feedback_problem')],
    [Markup.button.callback('⭐ Відгук', 'feedback_review')],
    [Markup.button.callback('🔙 Назад', 'main_menu')]
  ]);

  await ctx.reply(feedbackMenu, { parse_mode: 'HTML', ...feedbackKeyboard });
});

// ==================== ADMIN COMMANDS ====================

bot.command('blocklist', async (ctx) => {
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  // Тільки адмін має доступ
  if (ctx.from.id.toString() !== adminId) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  const blockedUsers = await blockedUsersUtil.getAllBlockedUsers();

  if (blockedUsers.length === 0) {
    await ctx.reply('✅ Заблокованих користувачів немає');
    return;
  }

  let message = `🚫 <b>Список заблокованих користувачів</b> (${blockedUsers.length})\n\n`;

  for (let index = 0; index < blockedUsers.length; index++) {
    const user = blockedUsers[index];
    message += `${index + 1}. ID: <code>${user._id}</code>\n`;
    message += `   👤 @${user.username || 'unknown'} (${user.firstName || 'No name'})\n`;
    message += `   🚫 Причина: ${user.reason}\n`;
    message += `   📅 ${new Date(user.blockedAt).toLocaleString('uk-UA')}\n`;
    message += `   /unblock_${user._id}\n\n`;
  }

  await ctx.reply(message, { parse_mode: 'HTML' });
});

bot.command(/^unblock_(\d+)$/, async (ctx) => {
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const userId = parseInt(ctx.match[1]);

  // Тільки адмін має доступ
  if (ctx.from.id.toString() !== adminId) {
    await ctx.reply('❌ Доступ заборонений');
    return;
  }

  // Перевіряємо чи користувач заблокований
  const isBlocked = await blockedUsersUtil.isUserBlocked(userId);
  if (!isBlocked) {
    await ctx.reply(`ℹ️ Користувач ${userId} не заблокований`);
    return;
  }

  // Розблокуємо користувача
  const success = await blockedUsersUtil.unblockUser(userId);

  if (success) {
    await ctx.reply(`✅ Користувач ${userId} розблокований`);

    // Спробуємо повідомити користувача
    try {
      await bot.telegram.sendMessage(
        userId,
        `✅ <b>Ви були розблоковані!</b>

Ви знову можете користуватися ботом. Приносимо вибачення за незручності.

Введіть /start щоб почати`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.warn(`⚠️ Could not notify user ${userId}:`, error.message);
    }

    console.log(`✅ User ${userId} unblocked by admin`);
  } else {
    await ctx.reply(`❌ Помилка при розблокуванні користувача`);
  }
});

// Обробники feedback категорій
bot.action(/^feedback_(suggestion|problem|review)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const feedbackType = ctx.match[1];
  const typeNames = {
    suggestion: '💡 Побажання',
    problem: '🐛 Проблема',
    review: '⭐ Відгук'
  };

  // Зберігаємо тип в sessionStorage
  feedbackData.set(ctx.from.id, {
    type: feedbackType,
    typeName: typeNames[feedbackType],
    userId: ctx.from.id,
    username: ctx.from.username || 'unknown',
    firstName: ctx.from.first_name
  });

  const message = `<b>${typeNames[feedbackType]}</b>

Розскажіть детальніше 👇
(максимум 1000 символів)`;

  await ctx.reply(message, { parse_mode: 'HTML' });
});

// ==================== ADMIN FEEDBACK HANDLERS ====================

// Адмін підтверджує feedback
bot.action(/^feedback_confirm_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = parseInt(ctx.match[1]);
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  if (ctx.from.id.toString() !== adminId) {
    await ctx.answerCbQuery('❌ Доступ заборонений', true);
    return;
  }

  // Оновлюємо повідомлення (якщо це текстове)
  const messageText = ctx.callbackQuery?.message?.text;
  if (messageText) {
    await ctx.editMessageText(
      messageText + '\n\n✅ <b>Статус: Прийнято</b>',
      { parse_mode: 'HTML' }
    );
  } else {
    // Якщо це фото/документ, просто рідим reply
    await ctx.reply('✅ <b>Feedback прийнято</b>', { parse_mode: 'HTML' });
  }

  // Повідомляємо користувачу
  try {
    await bot.telegram.sendMessage(
      userId,
      `✅ <b>Ваше звернення прийнято в роботу</b>

Дякуємо за звернення! Ми розглянули ваше повідомлення та почнемо над ним працювати.

Якщо у вас ще є питання, можете написати нам ще раз командою /feedback`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('❌ Error notifying user:', error.message);
  }

  console.log(`✅ Feedback confirmed from user ${userId}`);
});

// Адмін відхиляє feedback
bot.action(/^feedback_decline_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = parseInt(ctx.match[1]);
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  if (ctx.from.id.toString() !== adminId) {
    await ctx.answerCbQuery('❌ Доступ заборонений', true);
    return;
  }

  // Оновлюємо повідомлення (якщо це текстове)
  const messageText = ctx.callbackQuery?.message?.text;
  if (messageText) {
    await ctx.editMessageText(
      messageText + '\n\n❌ <b>Статус: Відхилено</b>\n<i>Не на часі або порушує політику</i>',
      { parse_mode: 'HTML' }
    );
  } else {
    // Якщо це фото/документ, просто рідим reply
    await ctx.reply('❌ <b>Feedback відхилено</b>', { parse_mode: 'HTML' });
  }

  // Повідомляємо користувачу
  try {
    await bot.telegram.sendMessage(
      userId,
      `❌ <b>Ваше звернення було розглянуто</b>

На жаль, ваше звернення не відповідає нашій політиці або зараз не актуальне.

Якщо у вас ще є питання, ми завжди готові вислухати 💬`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('❌ Error notifying user:', error.message);
  }

  console.log(`❌ Feedback declined from user ${userId}`);
});

// Адмін блокує користувача
bot.action(/^feedback_block_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = parseInt(ctx.match[1]);
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  if (ctx.from.id.toString() !== adminId) {
    await ctx.answerCbQuery('❌ Доступ заборонений', true);
    return;
  }

  // Перевіряємо що адмін не блокує себе
  if (userId === parseInt(adminId)) {
    await ctx.answerCbQuery('❌ Ви не можете заблокувати себе!', true);
    return;
  }

  // Блокуємо користувача в БД
  const success = await blockedUsersUtil.blockUser(
    userId,
    'unknown',
    'Unknown',
    parseInt(adminId),
    'Spam or inappropriate behavior',
    'Blocked via feedback system'
  );

  if (success) {
    // Оновлюємо повідомлення (якщо це текстове)
    const messageText = ctx.callbackQuery?.message?.text;
    if (messageText) {
      await ctx.editMessageText(
        messageText + '\n\n🚫 <b>Статус: Користувач заблокований</b>\n<i>Спам або неадекватна поведінка</i>',
        { parse_mode: 'HTML' }
      );
    } else {
      // Якщо це фото/документ, просто рідим reply
      await ctx.reply('🚫 <b>Користувач заблокований</b>', { parse_mode: 'HTML' });
    }

    // Повідомляємо користувачу про блокування
    try {
      await bot.telegram.sendMessage(
        userId,
        `🚫 <b>Ви були заблоковані</b>

Ваш акаунт був заблокований через порушення правил нашого сервісу (спам, неадекватна поведінка або інші порушення).

Якщо вважаєте це помилкою, зв'яжіться з технічною підтримкою.`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('❌ Error notifying user about block:', error.message);
    }

    console.log(`🚫 User ${userId} blocked`);
  } else {
    await ctx.answerCbQuery('❌ Помилка при блокуванні користувача', true);
  }
});

// Обробники feedback категорій
bot.action(/^feedback_(suggestion|problem|review)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const feedbackType = ctx.match[1];
  const typeNames = {
    suggestion: '💡 Побажання',
    problem: '🐛 Проблема',
    review: '⭐ Відгук'
  };

  // Зберігаємо тип в sessionStorage
  feedbackData.set(ctx.from.id, {
    type: feedbackType,
    typeName: typeNames[feedbackType],
    userId: ctx.from.id,
    username: ctx.from.username || 'unknown',
    firstName: ctx.from.first_name
  });

  const message = `<b>${typeNames[feedbackType]}</b>

Розскажіть детальніше 👇
(максимум 1000 символів)`;

  await ctx.reply(message, { parse_mode: 'HTML' });
});

// ==================== ГОЛОВНЕ МЕНЮ ====================

bot.hears('🧠 Помічники', async (ctx) => {
  await ctx.reply(
    `🧠 Claude\n\n💎 Claude - преміум якість\n\nОберіть режим роботи 👇`,
    keyboard.createGPTActionsMenu(models.gpt.actions)
  );
});

bot.hears('🎬 Відео', async (ctx) => {
  await ctx.reply(
    '🎬 Створення відео\n\nВиберіть розділ для роботи з відео 👇',
    keyboard.createInlineMenu(models.video.models, 1)
  );
});

bot.hears('🖼️ Зображення', async (ctx) => {
  await ctx.reply(
    '🎨 Дизайн з AI\n\nВиберіть розділ для роботи з зображенням 👇',
    keyboard.createInlineMenu(models.design.models, 1)
  );
});

bot.hears('🎙️ Аудіо з AI', async (ctx) => {
  await ctx.reply(
    '🎙️ Аудіо з AI\n\nВиберіть розділ для роботи з аудіо 👇',
    keyboard.createInlineMenu(models.audio.models, 1)
  );
});

bot.hears('👤 Профіль', async (ctx) => {
  await showProfile(ctx);
});

bot.hears('❓ Допомога', async (ctx) => {
  await ctx.reply('❓ Використовуйте /help для перегляду команд', keyboard.createBackButton());
});

bot.hears('📄 Інструкція', async (ctx) => {
  await ctx.reply(INSTRUCTION_HTML, {
    parse_mode: 'HTML',
    ...keyboard.createBackButton()
  });
});

bot.hears('🎨 Креативи', async (ctx) => {
  const creativesMenu = `🎨 <b>Готові креативи</b>

Вибери готовий креатив - будуть згенеровані фотосесії з вшитими промптами 👇`;

  const creativesKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❤️ Романтика', 'creative_romance')],
    [Markup.button.callback('🏎️ Стиль & Техніка', 'creative_tech')],
    [Markup.button.callback('🌃 Urban Vibes', 'creative_urban')],
    [Markup.button.callback('✨ Фентезі', 'creative_fantasy')],
    [Markup.button.callback('🔄 Mash-up', 'creative_mashup')],
    [Markup.button.callback('🏠 Головне меню', 'main_menu')]
  ]);

  await ctx.reply(creativesMenu, { parse_mode: 'HTML', ...creativesKeyboard });
});

bot.hears('📝 Feedback', async (ctx) => {
  const feedbackMenu = `📝 <b>Форма зворотнього зв'язку</b>

Яка причина вашого звернення?

Оберіть категорію 👇`;

  const feedbackKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💡 Побажання', 'feedback_suggestion')],
    [Markup.button.callback('🐛 Проблема', 'feedback_problem')],
    [Markup.button.callback('⭐ Відгук', 'feedback_review')],
    [Markup.button.callback('🔙 Назад', 'main_menu')]
  ]);

  await ctx.reply(feedbackMenu, { parse_mode: 'HTML', ...feedbackKeyboard });
});

// Отримуємо ціну моделі
const nanoBanana4kModel = models.design.models.find(m => m.key === 'nano_banana_4k');
const CREATIVE_COST = nanoBanana4kModel?.cost || 31;

// Романтична фотосесія
bot.action('creative_romance', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (!(await userBalance.hasTokens(userId, CREATIVE_COST))) {
    await showInsufficientTokens(ctx, CREATIVE_COST);
    return;
  }

  userState.set(userId, {
    creative: 'romance',
    step: 'waiting_photo',
    model: 'nano_banana_4k'
  });

  await ctx.reply(
      `❤️ <b>Готовий креатив: Романтична фотосесія</b>\n\n` +
      `📸 <b>Крок 1/2:</b> Надішліть своє фото\n\n` +
      `💡 <b>Що буде:</b>\n` +
      `• Романтична сцена на заході сонця\n` +
      `• Ніжне тепле світло\n` +
      `• Професійна якість\n` +
      `• Ваші риси обличчя збережуться ✨\n\n` +
      `💰 <b>Вартість:</b> ${CREATIVE_COST}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть фото зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// Стиль & Техніка
bot.action('creative_tech', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (!(await userBalance.hasTokens(userId, CREATIVE_COST))) {
    await showInsufficientTokens(ctx, CREATIVE_COST);
    return;
  }

  userState.set(userId, {
    creative: 'tech',
    step: 'waiting_photo',
    model: 'nano_banana_4k'
  });

  await ctx.reply(
      `🏎️ <b>Готовий креатив: Стиль & Техніка</b>\n\n` +
      `📸 <b>Крок 1/2:</b> Надішліть своє фото\n\n` +
      `💡 <b>Що буде:</b>\n` +
      `• Ви поруч зі спортивним автомобілем\n` +
      `• Стиль модного журналу\n` +
      `• Контрастне професійне освітлення\n` +
      `• Ваші риси обличчя збережуться ✨\n\n` +
      `💰 <b>Вартість:</b> ${CREATIVE_COST}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть фото зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// Urban Vibes
bot.action('creative_urban', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (!(await userBalance.hasTokens(userId, CREATIVE_COST))) {
    await showInsufficientTokens(ctx, CREATIVE_COST);
    return;
  }

  userState.set(userId, {
    creative: 'urban',
    step: 'waiting_photo',
    model: 'nano_banana_4k'
  });

  await ctx.reply(
      `🌃 <b>Готовий креатив: Urban Vibes</b>\n\n` +
      `📸 <b>Крок 1/2:</b> Надішліть своє фото\n\n` +
      `💡 <b>Що буде:</b>\n` +
      `• Ви серед нічного міста з неоном\n` +
      `• Стиль cyberpunk/fashion\n` +
      `• Яскраві кольори, урбаністична естетика\n` +
      `• Ваші риси обличчя збережуться ✨\n\n` +
      `💰 <b>Вартість:</b> ${CREATIVE_COST}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть фото зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// Фентезі
bot.action('creative_fantasy', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (!(await userBalance.hasTokens(userId, CREATIVE_COST))) {
    await showInsufficientTokens(ctx, CREATIVE_COST);
    return;
  }

  userState.set(userId, {
    creative: 'fantasy',
    step: 'waiting_photo',
    model: 'nano_banana_4k'
  });

  await ctx.reply(
      `✨ <b>Готовий креатив: Фентезі</b>\n\n` +
      `📸 <b>Крок 1/2:</b> Надішліть своє фото\n\n` +
      `💡 <b>Що буде:</b>\n` +
      `• Ви з магічним артефактом у лісі\n` +
      `• Магічна атмосфера, містичне світло\n` +
      `• Деталізація одягу та оточення\n` +
      `• Ваші риси обличчя збережуться ✨\n\n` +
      `💰 <b>Вартість:</b> ${CREATIVE_COST}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть фото зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// Mash-up
bot.action('creative_mashup', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (!(await userBalance.hasTokens(userId, CREATIVE_COST))) {
    await showInsufficientTokens(ctx, CREATIVE_COST);
    return;
  }

  userState.set(userId, {
    creative: 'mashup',
    step: 'waiting_photo',
    model: 'nano_banana_4k'
  });

  await ctx.reply(
      `🔄 <b>Готовий креатив: Mash-up</b>\n\n` +
      `📸 <b>Крок 1/2:</b> Надішліть своє фото\n\n` +
      `💡 <b>Що буде:</b>\n` +
      `• Ви + фантастичний об'єкт/тварина\n` +
      `• Сюрреалістичний стиль\n` +
      `• Оригінальна креативна композиція\n` +
      `• Ваші риси обличчя збережуться ✨\n\n` +
      `💰 <b>Вартість:</b> ${CREATIVE_COST}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть фото зараз`,
      {
        parse_mode: 'HTML',
        ...keyboard.createBackButton('main_menu')
      }
  );
});

// ==================== ОБРОБКА ФОТО ДЛЯ КРЕАТИВІВ ====================
// Вставити ПЕРЕД bot.on('photo') handler

async function handleCreativePhoto(ctx, imageUrl) {
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || !state.creative) return false;

  const creativeType = state.creative;
  const model = models.design.models.find(m => m.key === 'nano_banana_4k');

  // Промпти (АНГЛІЙСЬКА + збереження рис обличчя)
  const prompts = {
    romance: `Professional romantic photoshoot at golden hour sunset. Two people holding hands, warm soft lighting, carefully designed outfit details, cinematic quality. Based on uploaded photo, preserve facial features, identity and likeness. High detail portrait, 4K quality.`,

    tech: `Fashion magazine style photoshoot with luxury sports car. One person posing near vehicle, dramatic lighting with strong shadows, high-end lookbook aesthetic. Based on uploaded photo, preserve facial features, identity and likeness. Professional lighting, 4K quality.`,

    urban: `Cyberpunk fashion photoshoot in neon-lit night city. One person among bright neon lights, experimental lighting, urban details in background, vivid colors. Based on uploaded photo, preserve facial features, identity and likeness. Urban aesthetic, 4K quality.`,

    fantasy: `Fantasy fairy tale photoshoot. Person with magical artifact in misty forest, magical atmosphere, mystical lighting, detailed costume design. Based on uploaded photo, preserve facial features, identity and likeness. High detail, 4K quality.`,

    mashup: `Creative surrealist composition. Person with fantastical object or creature, harmonious interaction, vibrant colors, detailed rendering. Based on uploaded photo, preserve facial features, identity and likeness. Original creative style, 4K quality.`
  };

  const prompt = prompts[creativeType];
  const creativeNames = {
    romance: '❤️ Романтика',
    tech: '🏎️ Стиль & Техніка',
    urban: '🌃 Urban Vibes',
    fantasy: '✨ Фентезі',
    mashup: '🔄 Mash-up'
  };

  const statusMsg = await ctx.reply(
      `🎨 <b>Генерую ${creativeNames[creativeType]}...</b>\n\n` +
      `📷 Ваше фото отримано\n` +
      `✨ Зберігаю ваші риси обличчя\n` +
      `⏱️ Це займе ~30-40 секунд\n\n` +
      `💰 Списується: ${model.cost}⚡`,
      { parse_mode: 'HTML' }
  );

  try {
    const result = await replicate.generateWithNanoBanana(prompt, imageUrl, '4K');

    if (!result.success) {
      await adminNotifier.notifyAdmin(
          bot,
          new Error(result.error),
          { userId, username: ctx.from.username, action: `creative_${creativeType}`, model: 'Nano Banana 4K' }
      );
      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Помилка генерації.\n\nСпробуйте ще раз або оберіть іншу модель.`
      );
      userState.delete(userId);
      return true;
    }

    await userBalance.deductTokens(
        userId,
        model.cost,
        `${creativeNames[creativeType]} generation`,
        { modelKey: 'nano_banana_4k', modelName: 'Nano Banana Pro 4K', apiCost: model.apiCost }
    );

    // Перевірити розмір файлу
    const fileSize = await getFileSize(result.imageUrl);
    const maxPhotoSize = 10 * 1024 * 1024; // 10MB

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    if (fileSize > maxPhotoSize) {
      // Файл завеликий - віддати посиланням
      const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

      await ctx.reply(
          `✅ <b>${creativeNames[creativeType]}</b>\n\n` +
          `📊 <b>Розмір:</b> ${fileSizeMB} MB\n` +
          `⚠️ Файл завеликий для Telegram\n\n` +
          `🔗 <a href="${result.imageUrl}">📥 Натисніть для завантаження PNG</a>\n\n` +
          `💡 <b>Як завантажити:</b>\n` +
          `• Натисніть на посилання ☝️\n` +
          `• Файл автоматично завантажиться\n\n` +
          `⏰ Посилання активне 1 годину\n` +
          `💰 Витрачено: ${model.cost}⚡`,
          {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...keyboard.createBackButton('main_menu')
          }
      );
    } else {
      // Файл нормальний - відправити як фото
      await ctx.replyWithPhoto(
          { url: result.imageUrl },
          {
            caption: `✅ ${creativeNames[creativeType]}\n\n💰 Витрачено: ${model.cost}⚡`,
            ...keyboard.createBackButton('main_menu')
          }
      );
    }

    userState.delete(userId);
    return true;

  } catch (error) {
    console.error(`Creative ${creativeType} generation failed:`, error);
    await adminNotifier.notifyAdmin(bot, error, { userId, username: ctx.from.username, action: `creative_${creativeType}` });
    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації. Спробуйте ще раз.'
    );
    userState.delete(userId);
    return true;
  }
}
// ==================== CALLBACK HANDLERS ====================

bot.action('gpt_text', async (ctx) => {
  await ctx.answerCbQuery();
  userCurrentModel.set(ctx.from.id, 'claude_text');
  await ctx.reply(
    '✍️ Режим Claude активовано! 💎\n\n' +
    'Надішліть мені ваше запитання, і я відповім текстом.\n\n' +
    '💡 Claude Sonnet 4.5 - найкраща якість\n' +
    '💰 Вартість: 1⚡ за запит\n' +
    '💡 Підказка: Я запам\'ятовую контекст розмови.',
    keyboard.createBackButton()
  );
});

bot.action('gpt_voice', async (ctx) => {
  await ctx.answerCbQuery();
  userCurrentModel.set(ctx.from.id, 'claude_voice');
  await ctx.reply(
    '🎙️ Режим голосової розмови активовано! 🆓\n\n' +
    'Надішліть голосове повідомлення, і я перетворю його в текст та відповім.\n\n' +
    '💡 Groq Whisper - безкоштовна транскрипція\n' +
    '💰 Відповідь через Claude: 1⚡',
    keyboard.createBackButton()
  );
});

bot.action('gpt_image', async (ctx) => {
  await ctx.answerCbQuery();
  userCurrentModel.set(ctx.from.id, 'claude_vision');
  await ctx.reply(
    '🖼️ Режим Claude Vision активовано! 💎\n\n' +
    'Надішліть мені зображення з підписом (або без), і я його проаналізую.\n\n' +
    '💰 Вартість: 3⚡ за аналіз',
    keyboard.createBackButton()
  );
});

bot.action('new_conversation', async (ctx) => {
  await ctx.answerCbQuery('Історію очищено!');
  await userBalance.clearConversationHistory(ctx.from.id);
  await ctx.reply(
    '✅ Нову розмову розпочато! 👋\n\nНадішліть своє повідомлення.',
    keyboard.createGPTActionsMenu(models.gpt.actions)
  );
});

// ==================== ASPECT RATIO SELECTION ====================
bot.action(/^aspect_ratio_(.+?)_(1:1|4:5|9:16|4:3|3:4|16:9|3:2|2:3|21:9|match_input_image)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const callbackData = ctx.callbackQuery.data;
  const match = callbackData.match(/^aspect_ratio_(.+?)_(1:1|4:5|9:16|4:3|3:4|16:9|3:2|2:3|21:9|match_input_image)$/);
  const userId = ctx.from.id;

  console.log(`📐 Aspect ratio callback: ${callbackData}`);
  console.log(`📐 User ID: ${userId}`);
  console.log(`📐 Regex match result:`, match);
  console.log(`📐 Current userState Map size:`, userState.size);
  console.log(`📐 All userState keys:`, Array.from(userState.keys()));

  if (!match) {
    console.error('❌ Regex не спрацював');
    await ctx.reply('❌ Помилка обробки запиту.');
    return;
  }

  const modelKey = match[1];
  const aspectRatio = match[2];
  const state = userState.get(userId);

  console.log(`📐 Model: ${modelKey}, Ratio: ${aspectRatio}`);
  console.log(`📐 Retrieved state for userId ${userId}:`, state);

  if (!state || !state.imageUrl || !state.prompt) {
    console.error(`❌ Стан відсутній або неповний. State:`, state);
    await ctx.reply('❌ Помилка. Спробуйте завантажити фото знову.');
    userState.delete(userId);
    return;
  }

  console.log(`📐 Aspect ratio selected: ${aspectRatio} for model: ${modelKey}`);

  // Генеруємо з вибраним aspect ratio
  await handleImageGeneration(ctx, state.prompt, modelKey, state.imageUrl, aspectRatio);

  userState.delete(userId);
});

// Design Models
bot.action(/^(midjourney|flux|nano_banana_2k|nano_banana_4k|stable_diffusion|seedream_2k|seedream_4k|clarity|ideogram)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const model = models.design.models.find(m => m.key === modelKey);
  
  if (!model) {
    await ctx.answerCbQuery('Модель не знайдена');
    return;
  }

  if (model.available === false) {
    await ctx.answerCbQuery('❌ Модель тимчасово недоступна', { show_alert: true });
    return;
  }
  
  await ctx.answerCbQuery();
  
  if (model.cost > 0 && !(await userBalance.hasTokens(ctx.from.id, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }
  
  userCurrentModel.set(ctx.from.id, modelKey);

  const messages = {
    clarity: `${model.name}\n\n🔮 Покращення якості зображень\n\nНадішліть фото, яке хочете покращити.\nМожете додати підпис (опис) для кращого результату.\n\n💰 Вартість: ${model.cost}⚡\n📈 Збільшення: 2x (scale factor)\n⏱️ Час обробки: ~30-60 секунд`,
    stable_diffusion: `${model.name}\n\n🎨 Text-to-Image і Image-to-Image\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для редагування\n\n💰 Вартість: ${model.cost}⚡\n⏱️ Час: ~30-40 секунд`,
    ideogram: `${model.name}\n\n🎨 Text-to-Image і Image-to-Image\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для редагування\n\n💰 Вартість: ${model.cost}⚡\n⏱️ Час: ~30-40 секунд`,  
    nano_banana: `${model.name}\n\n🎨 Text-to-Image і Image-to-Image\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для редагування\n\n💡 Підтримка до 14 зображень одночасно!\n💰 Вартість: ${model.cost}⚡\n⏱️ Час: ~20-30 секунд`
  };

  await ctx.reply(
    messages[modelKey] || `${model.name}\n\nНадішліть текстовий опис зображення, яке хочете згенерувати.\n\nВартість: ${model.cost > 0 ? model.cost + '⚡' : 'Безкоштовно'}`,
    keyboard.createBackButton('design_menu')
  );
});

// Video Models
bot.action(/^(kling|kling_motion|kling_motion_minimal|runway_gen4|runway_turbo|luma)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const model = models.video.models.find(m => m.key === modelKey);
  
  if (!model) {
    await ctx.answerCbQuery('Модель не знайдена');
    return;
  }
  
  await ctx.answerCbQuery();
  
  if (!(await userBalance.hasTokens(ctx.from.id, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }
  
  userCurrentModel.set(ctx.from.id, modelKey);
  
  const messages = {
    kling: `${model.name}\n\n🎭 Text-to-Video і Image-to-Video\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для створення відео з зображення\n\n⏱️ Генерація: 2-5 хвилин\n💰 Вартість: ${model.cost}⚡\n📊 Якість: 1080p, 5 секунд`,
    
    kling_motion: `${model.name}\n\n🔥 Motion Transfer: Image + Video → Video 🎬\n\n⚠️ ПОТРІБНО 2 ФАЙЛИ:\n1️⃣ Надішліть ФОТО (персонаж/об'єкт)\n2️⃣ Потім ВІДЕО (референсні рухи)\n\n🎯 Як це працює:\n• Фото: Ваш персонаж/об'єкт\n• Відео: Рухи які хочете перенести\n• Результат: Персонаж з фото виконує рухи з відео!\n\n💡 Приклад:\n📷 Фото: Ваше селфі\n🎥 Відео: Танець\n✨ Результат: Ви танцюєте!\n\n⏱️ Генерація: 2-4 хвилини\n💰 Вартість: ${model.cost}⚡\n📊 Якість: PRO, 5 секунд\n\n👉 Спочатку надішліть ФОТО`,
    
    kling_motion_minimal: `${model.name}\n\n🔥 Motion Transfer: Image + Video → Video 🎬\n\n⚠️ ПОТРІБНО 2 ФАЙЛИ:\n1️⃣ Надішліть ФОТО (персонаж/об'єкт)\n2️⃣ Потім ВІДЕО (референсні рухи)\n\n🎯 Як це працює:\n• Фото: Ваш персонаж/об'єкт\n• Відео: Рухи які хочете перенести\n• Результат: Персонаж з фото виконує рухи з відео!\n\n💡 Приклад:\n📷 Фото: Ваше селфі\n🎥 Відео: Танець\n✨ Результат: Ви танцюєте!\n\n⏱️ Генерація: 1-2 хвилини\n💰 Вартість: ${model.cost}⚡\n📊 Якість: 720p, до 10 секунд\n⚡ Швидша версія для коротких відео!\n\n👉 Спочатку надішліть ФОТО`,

    runway_turbo: `${model.name}\n\n🎬 Image-to-Video ONLY ⚠️\n\n⚠️ ОБОВ'ЯЗКОВО: Надішліть зображення + текстовий опис\n\n📝 Опис має містити деталі руху/анімації\n🖼️ Зображення стане першим кадром відео\n\n💡 Приклад:\n"Camera slowly zooms in, person turns head to the left"\n\n⏱️ Генерація: 1-3 хвилини\n💰 Вартість: ${model.cost}⚡\n📊 Якість: 720p, 5 секунд\n⚡ Найшвидша модель!`,
    
    runway_gen4: `${model.name}\n\n🎬 Image-to-Video ONLY ⚠️\n\n⚠️ ОБОВ'ЯЗКОВО: Надішліть зображення + текстовий опис\n\n📝 Опис має містити деталі руху/анімації\n🖼️ Зображення стане першим кадром відео\n\n💡 Приклад:\n"Slow motion, waves crashing, cinematic"\n\n⏱️ Генерація: 3-5 хвилин\n💰 Вартість: ${model.cost}⚡\n📊 Якість: 1080p, 10 секунд\n💎 Найвища якість!`,
    
    luma: `${model.name}\n\n🌊 Text-to-Video і Image-to-Video\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для створення відео\n\n⏱️ Генерація: 2-4 хвилини\n💰 Вартість: ${model.cost}⚡\n📊 Якість: 1080p, 5 секунд`
  };
  
  await ctx.reply(
    messages[modelKey] || `${model.name}\n\nНадішліть текстовий опис відео або зображення з підписом.\n\n⏱️ Генерація: 2-5 хвилин\n💰 Вартість: ${model.cost}⚡`,
    keyboard.createBackButton('video_menu')
  );
});

// Audio Models
bot.action(/^(suno|udio|elevenlabs)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const model = models.audio.models.find(m => m.key === modelKey);

  if (!model) {
    await ctx.answerCbQuery('Модель не знайдена');
    return;
  }

  if (model.available === false) {
    await ctx.answerCbQuery('❌ Модель тимчасово недоступна', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();

  if (!(await userBalance.hasTokens(ctx.from.id, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  userCurrentModel.set(ctx.from.id, modelKey);

  await ctx.reply(
    `${model.name}\n\n🎵 Генерація аудіо\n\nНадішліть текст для озвучення.\n\n💰 Вартість: ${model.cost}⚡\n⏱️ Час генерації: ~20-40 секунд`,
    keyboard.createBackButton('audio_menu')
  );
});

// Navigation
bot.action('audio_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('🎙️ Аудіо з AI\n\nВиберіть розділ для роботи з аудіо 👇', keyboard.createInlineMenu(models.audio.models, 2));
});

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('🏠 Головне меню', keyboard.createMainMenu());
});

bot.action('design_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('🎨 Дизайн з AI\n\nВиберіть розділ для роботи з зображенням 👇', keyboard.createInlineMenu(models.design.models, 1));
});

bot.action('video_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('🎬 Створення відео\n\nВиберіть розділ для роботи з відео 👇', keyboard.createInlineMenu(models.video.models, 1));
});

// Tokens purchase
bot.action('buy_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`⚡ Купити токени\n\n Виберіть пакет 👇`, keyboard.createSubscriptionsMenu());
});

bot.action('community', async (ctx) => {
  await ctx.answerCbQuery();
  const message = `👥 <b>Спільнота neuro\u200B.lab\u200B.ai</b>

👩‍💼 <b>Авторка:</b> Анастасія Черевань

📱 <b>Соціальні мережі:</b>
- Instagram: https://www.instagram.com/anastasia.che.ai
- Threads: https://www.threads.com/@anastasia.che.ai

💬 <b>Telegram група:</b>
<a href="t.me/+AFbdgWuqG8UxMTVi">neuro\u200B.lab\u200B.ai</a>

Приєднуйтесь до нашої спільноти! 🚀`;

  await ctx.reply(message, { parse_mode: 'HTML', disable_web_page_preview: false, ...keyboard.createBackButton() });
});

bot.action('legal_info', async (ctx) => {
  await ctx.answerCbQuery();
  const message = `📋 <b>Юридична інформація</b>

Перед оплатою будь ласка ознайомтесь з нашими юридичними документами:

📋 <b>Угода користувача</b> - регулює взаємовідносини між мерчантом та власником картки
🔒 <b>Політика приватності</b> - описує як ми обробляємо вашу персональну інформацію

Натисніть на кнопку нижче щоб ознайомитися з повним текстом документів:`;

  await ctx.reply(message, { parse_mode: 'HTML', ...keyboard.createLegalMenu() });
});

bot.action(/^sub_(starter|basic|pro|premium)$/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const planKey = ctx.match[1];
  const sub = models.subscriptions[planKey];
  const userId = ctx.from.id;
  const telegramId = ctx.from.id;

  if (!sub) {
    await ctx.reply('❌ План не знайдено');
    return;
  }

  // Отримуємо актуальний курс USD/UAH для розрахунку LiqPay ціни
  const rate = await exchangeRate.getRate();
  const priceUAH = Math.round(sub.priceUSD * rate);

  let message = `⚡ Пакет токенів ${sub.name}\n\n`;
  message += sub.features.join('\n') + '\n\n';
  message += `💰 Вартість:\n`;
  message += `  ⭐ ${sub.price}⭐ Telegram Stars\n`;
  message += `  💳 ${priceUAH}₴ LiqPay`;
  if (sub.tokensLiqPay) {
    message += ` (+${sub.tokensLiqPay - sub.tokens}⚡ бонус)`;
  }
  message += `\n\n`;
  message += `🎁 Токенів:\n`;
  message += `  ⭐ ${sub.tokens}⚡ за Telegram Stars\n`;
  if (sub.tokensLiqPay) {
    message += `  💳 ${sub.tokensLiqPay}⚡ за LiqPay (економія на комісіях) 🎁\n`;
  }
  message += `\n📱 Оберіть спосіб оплати 👇`;

  await ctx.reply(message, keyboard.createPaymentMenu(sub.price, planKey, userId, telegramId));
});

bot.action(/^pay_stars_(starter|basic|pro|premium)$/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const planKey = ctx.match[1];
  const sub = models.subscriptions[planKey];
  
  if (!sub) {
    await ctx.reply('❌ План не знайдено');
    return;
  }
  
  const invoice = {
    title: `${sub.name} - ${sub.tokens}⚡ токенів`,
    description: `Купити ${sub.tokens} токенів`,
    payload: JSON.stringify({ type: 'tokens_purchase', plan: planKey }),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: `${sub.name} пакет`, amount: sub.price }]
  };
  
  try {
    await ctx.replyWithInvoice(invoice);
  } catch (error) {
    console.error('Payment error:', error);
    await ctx.reply('❌ Помилка створення платежу. Спробуйте пізніше.');
  }
});

// ==================== MESSAGE HANDLERS ====================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);
  const text = ctx.message.text;
  
  if (text.startsWith('/')) return;
  
  if (!currentModel) {
    await ctx.reply('Будь ласка, спочатку виберіть модель з меню 👇', keyboard.createMainMenu());
    return;
  }
  
  if (currentModel === 'clarity') {
    await ctx.reply('🔮 Clarity Upscaler чекає на зображення.\n\nНадішліть фото для покращення якості.', keyboard.createGPTActionsMenu(models.design.models));
    return;
  }

  if (currentModel === 'kling_motion' || currentModel === 'kling_motion_minimal') {
    const state = userState.get(userId);
    
    if (state?.step === 'waiting_video' && state?.imageUrl) {
      const modelName = currentModel === 'kling_motion_minimal' ? 'ВІДЕО (тривалістю <= 10 сек⏱️)' : 'ВІДЕО';
      await ctx.reply(
        `⚠️ Очікується ${modelName}, а не текст!\n\n` +
        `🎥 Надішліть відео файл з рухами.`,
        keyboard.createBackButton('video_menu')
      );
    } else {
      await ctx.reply(
        '🔥 Kling Motion Control чекає на ФОТО!\n\n' +
        '👉 Надішліть фото персонажа (не текст)',
        keyboard.createBackButton('video_menu')
      );
    }
    return;
  }
  
  const handlers = {
    claude_vision: () => handleClaudeText(ctx, text),
    claude_text: () => handleClaudeText(ctx, text),
    claude: () => handleClaudeText(ctx, text),
    claude_voice: () => handleClaudeText(ctx, text),
    midjourney: () => handleMidjourneyGeneration(ctx, text),
    flux: () => handleImageGeneration(ctx, text, 'flux'),
    stable_diffusion: () => handleImageGeneration(ctx, text, 'stable_diffusion'),
    nano_banana_2k: () => handleImageGeneration(ctx, text, 'nano_banana_2k'),
    nano_banana_4k: () => handleImageGeneration(ctx, text, 'nano_banana_4k'),
    seedream_2k: () => handleImageGeneration(ctx, text, 'seedream_2k'),
    seedream_4k: () => handleImageGeneration(ctx, text, 'seedream_4k'),
    ideogram: () => handleImageGeneration(ctx, text, 'ideogram'),
    kling: () => handleVideoGeneration(ctx, text, 'kling'),
    runway_gen4: () => handleVideoGeneration(ctx, text, 'runway_gen4'),
    runway_turbo: () => handleVideoGeneration(ctx, text, 'runway_turbo'),
    suno: () => handleSunoGeneration(ctx, text)
  };
  
  if (handlers[currentModel]) {
    await handlers[currentModel]();
  } else {
    await ctx.reply(`Модель "${currentModel}" ще не підтримується.\nВиберіть іншу модель.`, keyboard.createMainMenu());
  }
});

bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);

  if (currentModel !== 'claude_voice') {
    await ctx.reply('Спочатку активуйте голосовий режим через "💡 Базові помічники" → 🎙️ Говоріть');
    return;
  }

  const statusMsg = await ctx.reply('🎙️ Розпізнаю голос...');

  try {
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const transcription = await groqWhisper.transcribeVoice(fileLink.href);

    if (!transcription.success) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка розпізнавання: ${transcription.error}`);
      return;
    }

    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `📝 Розпізнано: "${transcription.text}"\n\n🤔 Думаю...`);
    await handleClaudeText(ctx, transcription.text);

  } catch (error) {
    console.error('Voice processing error:', error);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Помилка обробки голосу. Спробуйте ще раз.');
  }
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);  // ← 1. ДОДАТИ
  const mediaGroupId = ctx.message.media_group_id;

  if (state?.creative && state?.step === 'waiting_photo') {
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  if (mediaGroupId) {
    if (!mediaGroups.has(mediaGroupId)) {
      mediaGroups.set(mediaGroupId, { photos: [], caption: ctx.message.caption || '', userId, currentModel, timeout: null });
    }

    const group = mediaGroups.get(mediaGroupId);
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const photoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    group.photos.push(photoUrl);

    if (ctx.message.caption) group.caption = ctx.message.caption;
    if (group.timeout) clearTimeout(group.timeout);

    group.timeout = setTimeout(async () => {
      const finalGroup = mediaGroups.get(mediaGroupId);
      mediaGroups.delete(mediaGroupId);
      console.log(`📸 Album received: ${finalGroup.photos.length} photos`);
      await handleMediaGroup(ctx, finalGroup);
    }, 500);

    return;
  }

  // Обробка одного фото
  const videoModels = ['kling', 'runway_gen4', 'runway_turbo'];
  const imageModels = ['nano_banana_2k', 'nano_banana_4k', 'stable_diffusion', 'seedream_2k', 'seedream_4k', 'ideogram'];
  const prompt = ctx.message.caption || 'transform this image, masterpiece quality, highly detailed';

  if (currentModel === 'claude_vision') {
    await handleClaudeVision(ctx);
  } else if (currentModel === 'clarity') {
    await handleClarityUpscaler(ctx);
  } else if (currentModel === 'kling_motion' || currentModel === 'kling_motion_minimal') {
    // Kling Motion: зберігаємо фото, чекаємо на відео
    const imageUrl = await getImageUrl(ctx);
    userState.set(userId, { model: currentModel, step: 'waiting_video', imageUrl });
    const videoLengthMsg = currentModel === 'kling_motion_minimal' ? '(<= 10 сек⏱️)' : '(до 5 сек⏱️)';
    await ctx.reply(
      '✅ Фото отримано!\n\n' +
      `🎥 Тепер надішліть ВІДЕО з рухами ${videoLengthMsg}, \n\n які хочете перенести на персонажа з фото.\n\n` +
      '💡 Наприклад: відео танцю, жестів, або будь-яких рухів.\n\n' +
      '⏱️ Після відео почнеться генерація',
      keyboard.createBackButton('video_menu')
    );
  } else if (imageModels.includes(currentModel)) {
    // ✅ ЯК ЩО ЦЕ МОДЕЛЬ З ASPECT RATIO - ПОКАЗАТИ МЕНЮ ВИБОРУ
    if (MODELS_WITH_ASPECT_RATIO.includes(currentModel)) {
      const imageUrl = await getImageUrl(ctx);

      // Зберігаємо дані для подальшої генерації
      const stateData = {
        model: currentModel,
        step: 'waiting_aspect_ratio',
        imageUrl: imageUrl,
        prompt: prompt
      };

      userState.set(userId, stateData);
      console.log(`💾 State saved for user ${userId}:`, stateData);
      console.log(`💾 Checking state immediately:`, userState.get(userId));

      // Дозволені aspect ratio для різних моделей
      const aspectRatios = {
        'seedream_2k': ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', 'match_input_image'],
        'seedream_4k': ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', 'match_input_image'],
        'nano_banana_2k': ['1:1', '4:5', '9:16', 'match_input_image'],
        'nano_banana_4k': ['1:1', '4:5', '9:16', 'match_input_image'],
        'stable_diffusion': ['1:1', '4:5', '9:16', 'match_input_image'],
        'ideogram': ['1:1', '4:5', '9:16', 'match_input_image']
      };

      const validRatios = aspectRatios[currentModel] || ['1:1', 'match_input_image'];

      // Маппінг для красивого виведення
      const ratioLabels = {
        '1:1': '📐 1:1 (Square)',
        '4:5': '📱 4:5 (Portrait)',
        '4:3': '🎬 4:3 (Landscape)',
        '3:4': '📱 3:4 (Portrait)',
        '16:9': '🎥 16:9 (Widescreen)',
        '9:16': '📱 9:16 (Vertical)',
        '3:2': '🖼️ 3:2 (Classic)',
        '2:3': '🖼️ 2:3 (Classic Portrait)',
        '21:9': '🎬 21:9 (Ultrawide)',
        'match_input_image': '🔄 Match Input Image'
      };

      // Показуємо меню вибору aspect ratio
      const buttons = validRatios.map(ratio => [
        Markup.button.callback(ratioLabels[ratio], `aspect_ratio_${currentModel}_${ratio}`)
      ]);
      buttons.push([Markup.button.callback('🔙 Назад', 'design_menu')]);

      const aspectRatioMenu = Markup.inlineKeyboard(buttons);

      await ctx.reply(
        `📐 <b>Оберіть пропорції зображення (Aspect Ratio):</b>\n\n` +
        `Модель: ${models.design.models.find(m => m.key === currentModel)?.name || currentModel}\n` +
        `Доступні формати: ${validRatios.join(', ')}`,
        { parse_mode: 'HTML', ...aspectRatioMenu }
      );
    } else {
      // Для інших моделей просто генерувати
      await handleImageGeneration(ctx, prompt, currentModel);
    }
  } else if (videoModels.includes(currentModel)) {
    await handleVideoGeneration(ctx, prompt, currentModel);
  } else {
    await ctx.reply('Для аналізу зображень виберіть режим "💡 Claude" → "🖼️ Завантажте зображення"', keyboard.createGPTActionsMenu(models.gpt.actions));
  }
});

// ==================== VIDEO HANDLER ====================

bot.on('video', async (ctx) => {
  const userId = ctx.from.id;
  const state = userState.get(userId);

  // Перевіряємо чи це Kling Motion (або Minimal) в стані очікування відео
  if ((state?.model === 'kling_motion' || state?.model === 'kling_motion_minimal') && state?.step === 'waiting_video' && state?.imageUrl) {
    const modelKey = state.model;
    const model = models.video.models.find(m => m.key === modelKey);

    if (!(await userBalance.hasTokens(userId, model.cost))) {
      await showInsufficientTokens(ctx, model.cost);
      userState.delete(userId);
      return;
    }

    const videoFile = ctx.message.video;
    const videoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${(await ctx.telegram.getFile(videoFile.file_id)).file_path}`;
    
    const generationTime = modelKey === 'kling_motion_minimal' ? '1-2 хвилини' : '2-4 хвилини';
    const statusMsg = await ctx.reply(
      `🔥 Генерую відео через Kling Motion Control...\n\n` +
      `📷 Фото: отримано\n` +
      `🎥 Референсне відео: отримано\n\n` +
      `⏱️ Це може зайняти ${generationTime}\n` +
      `💡 Переношу рухи з відео на персонажа...`
    );

    try {
      const result = await replicate.generateVideoWithKlingMotion(
        state.imageUrl,
        videoUrl,
        modelKey,  // передаємо тип моделі
        ctx.message.caption || '',
        true // keep_original_sound
      );

      if (!result.success) {
        await adminNotifier.notifyAdmin(
          bot, 
          new Error(result.error), 
          { 
            userId, 
            username: ctx.from.username, 
            action: `${modelKey}_generation`,
            model: model.name
          }
        );
        await ctx.telegram.editMessageText(
          ctx.chat.id, 
          statusMsg.message_id, 
          null, 
          `❌ Помилка генерації.\n\nСпробуйте ще раз або оберіть іншу модель.`
        );
        userState.delete(userId);
        return;
      }

      await userBalance.deductTokens(
        userId, 
        model.cost, 
        `${model.name} generation`, 
        { 
          modelKey: modelKey,
          modelName: model.name,
          apiCost: model.apiCost 
        }
      );
      
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.replyWithVideo(
        { url: result.videoUrl }, 
        {
          caption: `${model.name}\n\n🔥 Motion Transfer завершено!\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('video_menu')
        }
      );
      
      userState.delete(userId);

    } catch (error) {
      console.error(`${modelKey} generation failed:`, error);
      await adminNotifier.notifyAdmin(bot, error, { userId, username: ctx.from.username, action: `${modelKey}_generation`, model: model.name });
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Помилка генерації відео. Спробуйте ще раз.');
      userState.delete(userId);
    }
  } else {
    await ctx.reply(
      '⚠️ Для використання відео:\n\n' +
      '1. Виберіть модель 🔥 Kling Motion Control\n' +
      '2. Надішліть фото персонажа\n' +
      '3. Надішліть відео з рухами\n\n' +
      'Або оберіть іншу модель для генерації відео 👇',
      keyboard.createBackButton('video_menu')
    );
  }
});

// ==================== UNIFIED HANDLERS ====================

async function handleMediaGroup(ctx, group) {
  const { photos, caption, currentModel, userId } = group;
  const model = models.design.models.find(m => m.key === currentModel);

  // ✅ Перевірити чи модель підтримує багато зображень
  if (model?.maxImages && model.maxImages > 1) {
    // ✅ ЯК ЩО ЦЕ МОДЕЛЬ З ASPECT RATIO - ПОКАЗИТИ МЕНЮ ВИБОРУ
    if (MODELS_WITH_ASPECT_RATIO.includes(currentModel)) {
      // Зберігаємо дані для подальшої генерації
      userState.set(userId, {
        model: currentModel,
        step: 'waiting_aspect_ratio',
        imageUrl: photos, // передаємо масив фото
        prompt: caption || 'transform these images, masterpiece quality, highly detailed'
      });

      // Дозволені aspect ratio для різних моделей
      const aspectRatios = {
        'seedream_2k': ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', 'match_input_image'],
        'seedream_4k': ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', 'match_input_image'],
        'nano_banana_2k': ['1:1', '4:5', '9:16', 'match_input_image'],
        'nano_banana_4k': ['1:1', '4:5', '9:16', 'match_input_image'],
        'stable_diffusion': ['1:1', '4:5', '9:16', 'match_input_image'],
        'ideogram': ['1:1', '4:5', '9:16', 'match_input_image']
      };

      const validRatios = aspectRatios[currentModel] || ['1:1', 'match_input_image'];

      // Маппінг для красивого виведення
      const ratioLabels = {
        '1:1': '📐 1:1 (Square)',
        '4:5': '📱 4:5 (Portrait)',
        '4:3': '🎬 4:3 (Landscape)',
        '3:4': '📱 3:4 (Portrait)',
        '16:9': '🎥 16:9 (Widescreen)',
        '9:16': '📱 9:16 (Vertical)',
        '3:2': '🖼️ 3:2 (Classic)',
        '2:3': '🖼️ 2:3 (Classic Portrait)',
        '21:9': '🎬 21:9 (Ultrawide)',
        'match_input_image': '🔄 Match Input Image'
      };

      // Показуємо меню вибору aspect ratio
      const buttons = validRatios.map(ratio => [
        Markup.button.callback(ratioLabels[ratio], `aspect_ratio_${currentModel}_${ratio}`)
      ]);
      buttons.push([Markup.button.callback('🔙 Назад', 'design_menu')]);

      const aspectRatioMenu = Markup.inlineKeyboard(buttons);

      await ctx.reply(
        `📐 <b>Оберіть пропорції зображення (Aspect Ratio):</b>\n\n` +
        `📸 Отримано ${photos.length} фото\n` +
        `Модель: ${model?.name || currentModel}\n` +
        `Доступні формати: ${validRatios.join(', ')}`,
        { parse_mode: 'HTML', ...aspectRatioMenu }
      );
    } else {
      await handleImageGeneration(ctx, caption, currentModel, photos);
    }
  } else {
    await ctx.reply(
      `📸 Отримано ${photos.length} фото.\n\n` +
      `⚠️ ${model?.name || 'Ця модель'} підтримує тільки 1 зображення.\n` +
      `Обробляю перше фото...`
    );
    const prompt = caption || 'transform this image, best quality, highly detailed';
    await handleImageGeneration(ctx, prompt, currentModel, photos[0]);
  }
}

async function getImageUrl(ctx) {
  if (!ctx.message?.photo) return null;
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = await ctx.telegram.getFile(photo.file_id);
  return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
}

async function validateImageCount(photos, maxCount = 14) {
  if (!photos || !Array.isArray(photos)) return photos;
  if (photos.length <= maxCount) return photos;
  return photos.slice(0, maxCount);
}

async function handleImageGeneration(ctx, prompt, modelKey, imageInput = null, aspectRatio = '1:1') {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.design.models.find(m => m.key === modelKey);

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  if (!imageInput && ctx.message?.photo) {
    imageInput = await getImageUrl(ctx);
  }

  if (model.maxImages && Array.isArray(imageInput)) {
    const originalCount = imageInput.length;
    imageInput = await validateImageCount(imageInput, model.maxImages);
    
    if (originalCount > model.maxImages) {
      await ctx.reply(
        `⚠️ ${model.name} підтримує до ${model.maxImages} зображень.\n\n` +
        `Ви надіслали ${originalCount} фото.\n` +
        `Обробляю перші ${model.maxImages}...`
      );
    }
  }

  const isAlbum = Array.isArray(imageInput) && imageInput.length > 1;
  const mode = imageInput ? (isAlbum ? `album (${imageInput.length})` : 'img2img') : 'text2img';

  const statusMsg = await ctx.reply(`${model.name} генерація (${mode})...\n\nПромпт: "${prompt}"`);

  try {
    const replicateFunctions = {
      flux: () => replicate.generateWithFlux(prompt),
      stable_diffusion: () => replicate.generateWithStableDiffusion(prompt, imageInput, 0.8, aspectRatio),
      nano_banana_2k: () => replicate.generateWithNanoBanana(prompt, imageInput, '2K', aspectRatio),
      nano_banana_4k: () => replicate.generateWithNanoBanana(prompt, imageInput, '4K', aspectRatio),
      seedream_2k: () => replicate.generateWithSeedream(prompt, imageInput, '2K', aspectRatio),
      seedream_4k: () => replicate.generateWithSeedream(prompt, imageInput, '4K', aspectRatio),
      ideogram: () => replicate.generateWithIdeogram(prompt, imageInput, 0.5, aspectRatio)
    };

    const result = await replicateFunctions[modelKey]();

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), { userId, username, action: `${modelKey}_generation`, model: model.name, prompt, hasImage: !!imageInput });
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка генерації.\n\nСпробуйте ${modelKey === 'stable_diffusion' ? 'написати промпт англійською або ' : ''}іншу модель.`);
      return;
    }

    await userBalance.deductTokens(userId, model.cost, `${model.name} generation`, { modelKey, modelName: model.name, apiCost: model.apiCost, prompt, hasImage: !!imageInput });

    // ✅ Перевірити розмір файлу ПЕРЕД видаленням statusMsg
    const fileSize = await getFileSize(result.imageUrl);
    const maxPhotoSize = 10 * 1024 * 1024; // 10MB

    if (fileSize > maxPhotoSize) {
      // 🔗 Файл завеликий - надіслати посилання
      const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
      
      // ✅ Видалити statusMsg
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {
        console.warn('Could not delete status message:', e.message);
      }
      
      // ✅ Надіслати нове повідомлення з посиланням
      await ctx.reply(
        `✅ <b>${model.name}</b> (${mode})\n\n` +
        `📝 <b>Промпт:</b> ${prompt}\n\n` +
        `📊 <b>Розмір:</b> ${fileSizeMB} MB\n` +
        `⚠️ Файл завеликий для відправки в Telegram\n\n` +
        `🔗 <a href="${result.imageUrl}">📥 Натисніть тут щоб завантажити PNG файл</a>\n\n` +
        `💡 <b>Як завантажити:</b>\n` +
        `• Натисніть на посилання вище ☝️\n` +
        `• Файл автоматично завантажиться\n` +
        `• Відкрийте його на телефоні/комп'ютері\n\n` +
        `⏰ Посилання активне 1 годину\n` +
        `💰 Витрачено: ${model.cost}⚡`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...keyboard.createBackButton('design_menu')
        }
      );
      
    } else {
      // 📷 Надіслати як фото (<10MB)
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {
        console.warn('Could not delete status message:', e.message);
      }

      await ctx.replyWithPhoto({ url: result.imageUrl }, {
        caption: `${model.name} (${mode})\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
        ...keyboard.createBackButton('design_menu')
      });
    }

  } catch (error) {
    console.error(`${modelKey} generation failed:`, error);
    await adminNotifier.notifyAdmin(bot, error, { userId, username, action: `${modelKey}_generation`, model: model.name, prompt });
    
    // ✅ НЕ видаляти statusMsg, а редагувати його
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації. Спробуйте іншу модель.'
      );
    } catch (e) {
      // Якщо не можемо редагувати - надіслати нове повідомлення
      await ctx.reply('❌ Помилка генерації. Спробуйте іншу модель.', keyboard.createBackButton('design_menu'));
    }
  }
}

async function handleVideoGeneration(ctx, prompt, modelKey) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.video.models.find(m => m.key === modelKey);

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  const imageUrl = await getImageUrl(ctx);
  
  if ((modelKey === 'runway_turbo' || modelKey === 'runway_gen4') && !imageUrl) {
    await ctx.reply(
      `⚠️ ${model.name} працює тільки з зображеннями!\n\n` +
      `📝 Інструкція:\n` +
      `1. Надішліть зображення\n` +
      `2. Додайте підпис з описом руху/анімації\n\n` +
      `💡 Приклад підпису:\n` +
      `"Camera slowly pans right, person smiles"\n\n` +
      `Спробуйте ще раз або оберіть Kling для text-to-video 👇`,
      keyboard.createBackButton('video_menu')
    );
    return;
  }

  const statusMsg = await ctx.reply(`🎬 Генерую відео через ${model.name}...\n⏱️ Це може зайняти 2-5 хвилин\n\nПромпт: "${prompt}"`);

  try {
    const videoFunctions = {
      kling: replicate.generateVideoWithKling,
      runway_gen4: replicate.generateVideoWithRunway,
      runway_turbo: replicate.generateVideoWithRunwayTurbo
    };

    const result = await videoFunctions[modelKey](prompt, imageUrl);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), { userId, username, action: `${modelKey}_video_generation`, model: model.name, prompt, hasImage: !!imageUrl });
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка генерації відео.\n\nСпробуйте іншу модель або повторіть пізніше.`);
      return;
    }

    await userBalance.deductTokens(userId, model.cost, `${model.name} generation`, { modelKey, modelName: model.name, apiCost: model.apiCost, prompt, hasImage: !!imageUrl });
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.replyWithVideo({ url: result.videoUrl }, {
      caption: `${model.name}\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
      ...keyboard.createBackButton('video_menu')
    });

  } catch (error) {
    console.error(`${modelKey} video generation failed:`, error);
    await adminNotifier.notifyAdmin(bot, error, { userId, username, action: `${modelKey}_video_generation`, model: model.name, prompt, hasImage: !!imageUrl });
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Помилка генерації відео. Спробуйте іншу модель.');
  }
}

// ==================== SPECIFIC HANDLERS ====================

async function handleClaudeText(ctx, text) {
  const userId = ctx.from.id;
  const textModel = models.gpt.actions.find(a => a.key === 'text');
  
  if (!textModel || !(await userBalance.hasTokens(userId, textModel.cost))) {
    await showInsufficientTokens(ctx, textModel.cost);
    return;
  }
  
  try {
    const statusMsg = await ctx.reply('🤔 Думаю...');
    const history = await userBalance.getConversationHistory(userId);
    const response = await claude.continueConversation(text, history);
    
    if (response.success) {
      await userBalance.saveConversationMessage(userId, 'user', text);
      await userBalance.saveConversationMessage(userId, 'assistant', response.text);
      await userBalance.deductTokens(userId, textModel.cost, 'Claude текстова генерація', { modelKey: 'claude_text', modelName: 'Claude Sonnet 4.5', apiCost: textModel.apiCost });
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.reply(response.text);
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка: ${response.error}`);
    }
  } catch (error) {
    console.error('Claude text error:', error);
    await ctx.reply('❌ Сталася помилка. Спробуйте ще раз.');
  }
}

async function handleClaudeVision(ctx) {
  const userId = ctx.from.id;
  const model = models.gpt.actions.find(m => m.key === 'image');

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  try {
    const statusMsg = await ctx.reply('👀 Аналізую зображення...');
    const imageUrl = await getImageUrl(ctx);
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
    const prompt = ctx.message.caption || 'Опишіть це зображення детально.';
    const response = await claude.analyzeImageWithClaude(imageBase64, prompt, 'image/jpeg');

    if (response.success) {
      await userBalance.saveConversationMessage(userId, 'user', `[Зображення] ${prompt}`);
      await userBalance.saveConversationMessage(userId, 'assistant', response.text);
      await userBalance.deductTokens(userId, model.cost, 'Claude аналіз зображення', { modelKey: 'claude_vision', modelName: 'Claude Vision', apiCost: model.apiCost });
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.reply(response.text);
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка: ${response.error}`);
    }
  } catch (error) {
    console.error('Claude vision error:', error);
    await ctx.reply('❌ Помилка при аналізі зображення.');
  }
}

async function handleMidjourneyGeneration(ctx, prompt) {
  const userId = ctx.from.id;
  const model = models.design.models.find(m => m.key === 'midjourney');
  
  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  const statusMsg = await ctx.reply(`🎨 Генерую зображення через Midjourney...\n\n⏱️ Це займе ~30-60 секунд`);
  
  try {
    const result = await midjourney.generateImage(prompt);
    
    if (result.success) {
      await userBalance.deductTokens(userId, model.cost, 'Midjourney generation', { modelKey: 'midjourney', modelName: model.name, apiCost: model.apiCost, prompt });
      const user = await userBalance.getUser(userId, ctx.from);
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.replyWithPhoto({ url: result.imageUrl }, {
        caption: `✅ Готово!\n\nPrompt: ${prompt}\n\n💰 Використано: ${model.cost}⚡\n💰 Залишок: ${user.tokens.toFixed(2)}⚡`,
        ...keyboard.createGenerationActionsMenu(result.taskId)
      });
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка генерації: ${result.error}`);
    }
  } catch (error) {
    console.error('Midjourney error:', error);
    await ctx.reply('❌ Сталася помилка');
  }
}

async function handleClarityUpscaler(ctx) {
  const userId = ctx.from.id;
  const model = models.design.models.find(m => m.key === 'clarity');

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  const statusMsg = await ctx.reply(`🔮 Покращую якість зображення через Clarity Upscaler...\n\n⏱️ Це може зайняти 30-60 секунд`);

  try {
    const imageUrl = await getImageUrl(ctx);
    const prompt = ctx.message.caption || 'masterpiece, best quality, highres, extremely detailed';
    const result = await replicate.generateWithClarityUpscaler(imageUrl, prompt);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), { userId, username: ctx.from.username, action: 'clarity_upscaler', model: 'Clarity Upscaler', prompt, imageUrl });
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка покращення.\n\nСпробуйте ще раз або оберіть іншу модель.`);
      return;
    }

    await userBalance.deductTokens(userId, model.cost, 'Clarity Upscaler', { modelKey: 'clarity', modelName: model.name, apiCost: model.apiCost, prompt });
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.replyWithPhoto({ url: result.imageUrl }, {
      caption: `🔮 Clarity Upscaler\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
      ...keyboard.createBackButton('design_menu')
    });

  } catch (error) {
    console.error('Clarity Upscaler failed:', error);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Помилка покращення зображення. Спробуйте ще раз.');
  }
}

async function handleSunoGeneration(ctx, text) {
  const userId = ctx.from.id;
  const model = models.audio.models.find(m => m.key === 'suno');

  if (!(await userBalance.hasTokens(userId, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  if (text.length > 500) {
    await ctx.reply(`❌ Текст занадто довгий!\n\nМаксимум: 500 символів\nВаш текст: ${text.length} символів\n\nСкоротіть текст і спробуйте ще раз.`);
    return;
  }

  const statusMsg = await ctx.reply(`🎵 Генерую аудіо через Suno AI Bark...\n\nТекст: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"\n\n⏱️ Це може зайняти 20-40 секунд`);

  try {
    const result = await replicate.generateWithSuno(text);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), { userId, username: ctx.from.username, action: 'suno_generation', model: 'Suno AI Bark', text });
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Помилка генерації аудіо.\n\nСпробуйте ще раз або оберіть іншу модель.`);
      return;
    }

    await userBalance.deductTokens(userId, model.cost, 'Suno audio generation', { modelKey: 'suno', modelName: model.name, apiCost: model.apiCost, text });
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.replyWithAudio({ url: result.audioUrl }, {
      caption: `🎵 Suno AI Bark\n\n📝 Текст: ${text}\n\n💰 Витрачено: ${model.cost}⚡`,
      ...keyboard.createBackButton('audio_menu')
    });

  } catch (error) {
    console.error('Suno generation failed:', error);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Помилка генерації аудіо. Спробуйте ще раз.');
  }
}

// ==================== HELPER FUNCTIONS ====================

async function getFileSize(url) {
  try {
    const response = await axios.head(url);
    return parseInt(response.headers['content-length'] || '0');
  } catch (error) {
    console.error('Error getting file size:', error.message);
    return 0;
  }
}

async function showProfile(ctx) {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);

  if (!user) {
    await ctx.reply('❌ Помилка. Спробуйте /start', keyboard.createBackButton());
    return;
  }

  const stats = await userBalance.getUserStats(ctx.from.id);
  
  if (!stats) {
    await ctx.reply('❌ Помилка отримання статистики', keyboard.createBackButton());
    return;
  }
  
  let message = `👤 Ваш профіль\n\n`;
  message += `🆔 ID: ${ctx.from.id}\n`;
  message += `👤 Ім'я: ${ctx.from.first_name}\n`;
  message += `💰 Баланс: ${stats.currentBalance.toFixed(2)}⚡\n`;
  message += `\n📊 Статистика:\n`;
  message += `🎨 Генерацій: ${stats.generationCount}\n`;
  message += `💸 Витрачено: ${stats.totalSpent.toFixed(2)}⚡\n`;
  message += `📅 З нами: ${stats.memberSince.toLocaleDateString('uk-UA')}`;
  
  await ctx.reply(message, keyboard.createProfileMenu());
}

async function showInsufficientTokens(ctx, required) {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);
  await ctx.reply(
    `⚠️ Недостатньо токенів!\n\nНеобхідно: ${required}⚡\nВаш баланс: ${user.tokens.toFixed(2)}⚡\n\nКупіть підписку та отримайте більше токенів 👇`,
    keyboard.createSubscriptionMenu()
  );
}

async function broadcastMessage(message, parseMode = null) {
  try {
    console.log('📢 Starting broadcast...');
    const User = require('./database/models/User');
    const users = await User.find({}, '_id username');
    console.log(`📊 Found ${users.length} users`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (const user of users) {
      try {
        const chatId = user._id;
        if (!chatId) {
          console.error('⚠️ User without ID:', user);
          failCount++;
          continue;
        }
        
        await bot.telegram.sendMessage(chatId, message, { parse_mode: parseMode, disable_web_page_preview: true });
        successCount++;
        console.log(`✅ Sent to ${chatId} (@${user.username || 'no_username'})`);
        await new Promise(resolve => setTimeout(resolve, 35));
      } catch (error) {
        failCount++;
        console.error(`❌ Failed to send to ${user._id}:`, error.message);
      }
    }
    
    console.log(`✅ Broadcast complete: ${successCount} sent, ${failCount} failed`);
    return { success: successCount, failed: failCount };
  } catch (error) {
    console.error('Broadcast error:', error);
    throw error;
  }
}

// ==================== ЗАПУСК БОТА ====================

async function startBot() {
  try {
    console.log('🚀 Starting neuro.lab.ai Bot...');
    console.log('📡 Connecting to MongoDB...');

    // Pre-cache exchange rate for faster API responses
    console.log('💱 Pre-caching exchange rate...');
    try {
      const rate = await exchangeRate.getRate();
      console.log(`✅ Exchange rate cached: 1 USD = ${rate.toFixed(2)} UAH`);
    } catch (error) {
      console.warn('⚠️ Could not pre-cache exchange rate:', error.message);
    }

    // Pre-cache Telegram Stars rate
    console.log('⭐ Pre-caching Telegram Stars rate...');
    try {
      const telegramStars = require('./services/telegramStars');
      const tgRate = await telegramStars.getStarRate();
      console.log(`✅ Telegram Stars rate cached: 1 Star = $${tgRate.toFixed(4)}`);
    } catch (error) {
      console.warn('⚠️ Could not pre-cache Telegram Stars rate:', error.message);
    }

    // Try to connect to MongoDB, but continue if it fails
    const dbConnected = await db.connect();
    if (dbConnected) {
      console.log('✅ Database connected');
    } else {
      console.log('⚠️ Database connection failed - bot will work in limited mode');
    }

    console.log('🤖 Starting bot...');
    console.log('✅ Bot started successfully!');
    console.log('📱 Bot username: @neuro_lab_ai_bot');

    if (isShowBroadCast) {
      console.log('📢 Sending startup broadcast...');
      setTimeout(async () => {
        try {
          const message = '🎉 <b>Бот знову онлайн!</b>\n\n✨ Насолоджуйтесь генераціями!\n\n🆕 Що нового:\n• 🎨 Нові ціни на зображення (в 2-5 разів дешевше!)\n• 🎬 Runway Turbo тепер 14⚡\n💡 Спробуйте зараз! 🚀';
          const stats = await broadcastMessage(message, 'HTML');
          console.log(`📊 Broadcast stats: ${stats.success} успішно, ${stats.failed} помилок`);
          
          const adminId = parseInt(process.env.ADMIN_USER_ID || '0');
          if (adminId) {
            await bot.telegram.sendMessage(adminId, `📊 Startup broadcast complete:\n✅ Sent: ${stats.success}\n❌ Failed: ${stats.failed}`);
          }
        } catch (error) {
          console.error('Startup broadcast failed:', error);
        }
      }, 5000);
    }

    // ==================== EXPRESS SERVER ====================
    const app = express();
    const PORT = process.env.PORT || 5500;

    // Webhook для Stripe (необхідно до express.json())
    app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
      stripeWebhook.handleStripeWebhook(req, res, bot).catch(error => {
        console.error('Webhook handler error:', error);
        res.status(500).json({ error: 'Internal server error' });
      });
    });

    // Webhook для LiqPay (передаємо bot instance для відправки повідомлень)
    const createLiqPayRouter = require('./webhooks/liqpay');
    const liqpayWebhook = createLiqPayRouter(bot);
    app.use('/webhook', liqpayWebhook);

    // Інші middleware
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(__dirname + '/public'));

    // ==================== PAGES ====================

    // ✅ Stripe checkout page
    app.get('/pay/stripe', (req, res) => {
      const plan = req.query.plan;

      console.log(`📄 Stripe checkout page requested: plan=${plan}`);

      if (!plan) {
        return res.status(400).send('План не обрано');
      }

      const filePath = __dirname + '/public/stripe-checkout.html';
      console.log(`📂 Sending file: ${filePath}`);
      res.sendFile(filePath);
    });

    // ✅ Stripe checkout route
    app.post('/api/stripe/checkout', async (req, res) => {
      const { userId, plan, tokens, amount } = req.body;

      console.log(`📋 Checkout request:`, { userId, plan, tokens, amount });

      if (!userId || !plan || !tokens || amount === undefined) {
        console.error('❌ Missing required fields:', { userId, plan, tokens, amount });
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: userId, plan, tokens, amount'
        });
      }

      const result = await payment.createStripeCheckout(userId, plan, tokens, amount);

      if (result.success) {
        res.json({
          success: true,
          url: result.url,
          sessionId: result.sessionId
        });
      } else {
        console.error('❌ Stripe checkout error:', result.error);
        res.status(400).json({
          success: false,
          error: result.error
        });
      }
    });

    // ✅ LiqPay checkout page
    app.get('/pay/liqpay', (req, res) => {
      const plan = req.query.plan;

      console.log(`📄 LiqPay checkout page requested: plan=${plan}`);

      if (!plan) {
        return res.status(400).send('План не обрано');
      }

      const filePath = __dirname + '/public/liqpay-checkout.html';
      console.log(`📂 Sending file: ${filePath}`);
      res.sendFile(filePath);
    });

    // ✅ LiqPay checkout API
    app.post('/api/liqpay/checkout', async (req, res) => {
      const { userId, plan, tokens } = req.body;
      const liqpay = require('./services/liqpay');

      console.log(`📋 LiqPay checkout request:`, { userId, plan, tokens });

      if (!userId || !plan || !tokens) {
        console.error('❌ Missing required fields:', { userId, plan, tokens });
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: userId, plan, tokens'
        });
      }

      try {
        // Отримуємо інформацію про план
        const sub = models.subscriptions[plan];
        if (!sub) {
          return res.status(400).json({
            success: false,
            error: 'Invalid plan'
          });
        }

        // Отримуємо реальний курс USD/UAH
        const rate = await exchangeRate.getRate();

        // Розраховуємо суму в UAH на основі priceUSD та поточного курсу
        const amountUAH = Math.round(sub.priceUSD * rate);

        // Використовуємо tokensLiqPay (бонус для LiqPay платежу) або звичайні tokens
        const tokenCount = sub.tokensLiqPay || sub.tokens;

        console.log(`📊 LiqPay pricing: priceUSD=${sub.priceUSD}, rate=${rate.toFixed(2)}, amountUAH=${amountUAH}, tokens=${tokenCount}`);

        // Генеруємо унікальний ID замовлення: userId_planKey_timestamp
        const orderId = `${userId}_${plan}_${Date.now()}`;

        // Параметри платежу для LiqPay
        const checkoutParams = {
          order_id: orderId,
          amount: amountUAH,
          currency: 'UAH',
          description: `neuro.lab.ai - ${plan} (${tokens}⚡)`,
          server_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/webhook/liqpay`,
          result_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/payment/success?order_id=${orderId}`,
          language: 'uk'
        };

        const checkout = await liqpay.createCheckout(checkoutParams);

        console.log(`✅ LiqPay checkout created for user ${userId}: order_id=${orderId}`);

        // Формуємо посилання на платіж
        const checkoutUrl = `https://www.liqpay.ua/api/3/checkout?data=${checkout.data}&signature=${checkout.signature}`;

        res.json({
          success: true,
          checkoutUrl: checkoutUrl,
          orderId: orderId
        });
      } catch (error) {
        console.error('❌ LiqPay checkout error:', error);
        res.status(400).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Check payment status
    app.get('/api/payment/status/:sessionId', async (req, res) => {
      const { sessionId } = req.params;

      const result = await payment.getCheckoutSession(sessionId);

      if (result.success) {
        res.json({
          success: true,
          status: result.session.payment_status,
          metadata: result.session.metadata
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error
        });
      }
    });

    // ✅ Process completed payment (called from success page)
    app.post('/api/payment/process/:sessionId', async (req, res) => {
      const { sessionId } = req.params;

      console.log(`🔄 Processing payment for session: ${sessionId}`);

      try {
        const result = await payment.getCheckoutSession(sessionId);

        if (!result.success) {
          return res.status(400).json({
            success: false,
            error: 'Failed to retrieve session'
          });
        }

        const session = result.session;

        // Check if payment was actually completed
        if (session.payment_status !== 'paid') {
          return res.json({
            success: false,
            error: 'Payment not completed yet',
            status: session.payment_status
          });
        }

        // Extract metadata
        const { userId, plan, tokens } = session.metadata || {};

        if (!userId || !tokens) {
          console.error('❌ Missing metadata in session:', session.metadata);
          return res.status(400).json({
            success: false,
            error: 'Invalid session metadata'
          });
        }

        // Check if already processed (idempotency)
        const Transaction = require('./database/models/Transaction');
        const existingTransaction = await Transaction.findOne({ sessionId });

        if (existingTransaction) {
          console.log(`⚠️ Transaction already processed for session ${sessionId}`);
          return res.json({
            success: true,
            message: 'Already processed',
            tokens: tokens
          });
        }

        // Credit tokens to user
        await userBalance.addTokens(
          parseInt(userId),
          parseInt(tokens),
          'stripe_payment',
          { plan, sessionId: session.id, amount: session.amount_total }
        );

        // Send message to user
        try {
          await bot.telegram.sendMessage(
            userId,
            `✅ Оплату отримано!\n\n` +
            `💳 Метод: Stripe\n` +
            `💎 Тариф: ${plan}\n` +
            `⚡ Токенів нараховано: ${tokens}\n` +
            `💰 Сума: $${(session.amount_total / 100).toFixed(2)}\n\n` +
            `Дякуємо за покупку! 🎉`,
            { parse_mode: 'HTML' }
          );
        } catch (error) {
          console.error('Error sending message to user:', error.message);
        }

        console.log(`✅ Payment processed successfully for user ${userId}: +${tokens}⚡`);

        res.json({
          success: true,
          message: 'Tokens credited successfully',
          tokens: tokens
        });
      } catch (error) {
        console.error('❌ Error processing payment:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Process LiqPay payment by order_id (для синхронної обробки)
    app.post('/api/liqpay/process/:orderId', async (req, res) => {
      try {
        const { orderId } = req.params;

        console.log(`📋 Processing LiqPay order: ${orderId}`);

        // Розпарсимо замовлення
        const parts = orderId.split('_');
        const userId = parseInt(parts[0]);
        const planKey = parts[1];

        if (!userId || !planKey) {
          return res.status(400).json({
            success: false,
            error: 'Invalid order_id format'
          });
        }

        const sub = models.subscriptions[planKey];
        if (!sub) {
          return res.status(400).json({
            success: false,
            error: 'Plan not found'
          });
        }

        // Додаємо токени
        await userBalance.addTokens(
          userId,
          sub.tokens,
          'liqpay_purchase',
          {
            plan: sub.name,
            tokens: sub.tokens,
            orderId: orderId
          }
        );

        // Отримуємо користувача
        const user = await userBalance.getUser(userId, { id: userId });

        // Відправляємо повідомлення в Telegram
        try {
          await bot.telegram.sendMessage(
            userId,
            `✅ <b>Платіж успішно оброблений!</b>\n\n` +
            `💳 Метод: LiqPay\n` +
            `💎 Тариф: ${sub.name}\n` +
            `⚡ Токенів нараховано: ${sub.tokens}\n` +
            `💰 Новий баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
            `Дякуємо за покупку! 🎉`,
            { parse_mode: 'HTML' }
          );
          console.log(`📨 Success message sent to user ${userId}`);
        } catch (error) {
          console.error('Error sending message:', error.message);
        }

        res.json({
          success: true,
          message: 'Payment processed',
          tokens: sub.tokens,
          balance: user.tokens
        });
      } catch (error) {
        console.error('Error processing LiqPay order:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // ✅ Get subscription plans with dynamic LiqPay prices
    app.get('/api/plans', async (req, res) => {
      try {
        const startTime = Date.now();
        const subscriptions = models.subscriptions;
        const plans = {};

        // Отримуємо актуальний курс USD/UAH (з кешем для швидкості)
        const rate = await exchangeRate.getRate();

        // Отримуємо динамічний курс Telegram Stars (1 Star = ? USD)
        const telegramStars = require('./services/telegramStars');
        const tgStarRate = await telegramStars.getStarRate();

        const fetchTime = Date.now() - startTime;

        ['starter', 'basic', 'pro', 'premium'].forEach(planKey => {
          const sub = subscriptions[planKey];
          if (sub) {
            // Розраховуємо TG Stars динамічно: priceUSD / tgStarRate
            const priceStarsDynamic = Math.round(sub.priceUSD / tgStarRate);

            // Розраховуємо LiqPay ціну: priceUSD * реальний курс
            const priceUAHDynamic = Math.round(sub.priceUSD * rate);

            plans[planKey] = {
              name: sub.name,
              tokens: sub.tokens,
              tokensLiqPay: sub.tokensLiqPay,
              price: sub.price, // Telegram Stars (оригінальна)
              priceUSD: sub.priceUSD, // Базова ціна в USD
              priceStarsDynamic: priceStarsDynamic, // TG Stars динамічна ціна
              priceUAHDynamic: priceUAHDynamic, // LiqPay динамічна ціна
              exchangeRate: rate, // Поточний курс USD/UAH
              tgStarRate: tgStarRate, // Динамічний курс TG Star до USD
              features: sub.features  // Показуємо всі features як є
            };
          }
        });

        const totalTime = Date.now() - startTime;
        console.log(`📊 /api/plans response time: ${totalTime}ms (rate fetch: ${fetchTime}ms)`);

        res.json({
          success: true,
          plans,
          rates: {
            'USD/UAH': rate,
            'USD/TGStar': tgStarRate.toFixed(4)
          },
          responseTime: totalTime,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error fetching plans:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Get current USD/UAH exchange rate
    app.get('/api/exchange-rate', async (req, res) => {
      try {
        const rate = await exchangeRate.getRate();
        res.json({
          success: true,
          rate: rate,
          pair: 'USD/UAH',
          source: 'PrivatBank/NBU',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error getting exchange rate:', error);
        res.status(500).json({
          success: false,
          error: error.message,
          fallbackRate: 45
        });
      }
    });

    // ✅ Get LiqPay prices calculated by exchange rate
    app.get('/payment/success', (req, res) => {
      const sessionId = req.query.session_id;
      const orderId = req.query.order_id;
      const paymentId = sessionId || orderId;

      console.log(`✅ Payment success page requested:`, { sessionId, orderId });

      const filePath = __dirname + '/public/payment-success.html';
      res.sendFile(filePath);
    });

    // ✅ Payment cancel page
    app.get('/payment/cancel', (req, res) => {
      const sessionId = req.query.session_id;
      console.log(`❌ Payment cancelled for session: ${sessionId}`);

      res.send(`
        <!DOCTYPE html>
        <html lang="uk">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>❌ Платіж скасовано</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .container {
              background: white;
              border-radius: 12px;
              box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
              max-width: 500px;
              width: 100%;
              padding: 40px;
              text-align: center;
            }
            h1 { color: #c33; font-size: 28px; margin-bottom: 20px; }
            p { color: #666; font-size: 16px; margin-bottom: 30px; line-height: 1.5; }
            .button {
              display: inline-block;
              padding: 14px 32px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-weight: 600;
              transition: transform 0.2s;
            }
            .button:hover { transform: translateY(-2px); }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Платіж скасовано</h1>
            <p>Ви скасували платіж. Спробуйте знову, коли будете готові.</p>
            <a href="javascript:history.back()" class="button">← Повернутись</a>
          </div>
        </body>
        </html>
      `);
    });

    // ✅ Legal pages - Terms of Service
    app.get('/bot/terms', (req, res) => {
      const filePath = __dirname + '/public/terms.html';
      res.sendFile(filePath);
    });

    // ✅ Legal pages - Privacy Policy
    app.get('/bot/privacy', (req, res) => {
      const filePath = __dirname + '/public/privacy.html';
      res.sendFile(filePath);
    });

    // ✅ Company Information
    app.get('/bot/info', (req, res) => {
      const filePath = __dirname + '/public/info.html';
      res.sendFile(filePath);
    });

    // ✅ Catch-all 404
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // ==================== ERROR HANDLING ====================
    app.use((err, req, res, next) => {
      console.error('Express error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    // ==================== START SERVER ====================
    const server = app.listen(PORT, () => {
      console.log(`🌍 Express server running on port ${PORT}`);
      console.log(`📝 Stripe webhook: POST http://127.0.0.1:${PORT}/webhook/stripe`);
      console.log(`🛒 Checkout API: POST http://127.0.0.1:${PORT}/api/stripe/checkout`);
      console.log(`💳 LiqPay webhook: POST http://127.0.0.1:${PORT}/webhook/liqpay`);
      console.log(`💳 LiqPay checkout: GET http://127.0.0.1:${PORT}/pay/liqpay?plan=starter`);
      console.log(`💱 Exchange Rate API: GET http://127.0.0.1:${PORT}/api/exchange-rate`);
      console.log(`📊 Plans API: GET http://127.0.0.1:${PORT}/api/plans`);
    });

    // ==================== START BOT ====================
    await bot.launch();
    
    process.once('SIGINT', async () => {
      console.log('\n🛑 Stopping bot...');
      await db.disconnect();
      bot.stop('SIGINT');
    });
    
    process.once('SIGTERM', async () => {
      console.log('\n🛑 Stopping bot...');
      await db.disconnect();
      bot.stop('SIGTERM');
    });
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

startBot();

bot.catch((err, ctx) => {
  if (err.name === 'TimeoutError') {
    ctx.reply('⏱️ Генерація триває. Чекайте...');
    return;
  }

  console.error('Bot error:', err);
  ctx.reply(`❌ Сталася помилка. Спробуйте ще раз або зверніться до підтримки. ${SUPPORT_USERNAME}`);
});

