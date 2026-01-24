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

// Для накопичення довгих промптів (коли > 4096 символів)
const pendingPrompts = new Map(); // userId -> { prompt: string, model: string }

// ==================== TRIAL RESTRICTIONS ====================
const { TRIAL_RESTRICTIONS } = models;

/**
 * Перевіряє чи користувач на Trial (не робив покупок)
 */
async function isTrialUser(userId) {
  try {
    const user = await userBalance.getUser(userId);
    // Trial = користувач НЕ має жодної покупки (totalTokensPurchased = 0)
    // Тобто має тільки початковий бонус 75⚡
    return user.totalTokensPurchased === 0;
  } catch (e) {
    return true; // За замовчуванням вважаємо Trial
  }
}

/**
 * Отримує Trial usage з бази даних
 */
async function getTrialUsage(userId, modelKey) {
  try {
    const user = await userBalance.getUser(userId);
    return user.trialUsage?.[modelKey] || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Записує Trial usage в базу даних
 */
async function recordTrialUsage(userId, modelKey) {
  try {
    const User = require('./database/models/User');
    await User.findByIdAndUpdate(userId, {
      $inc: { [`trialUsage.${modelKey}`]: 1 }
    });
    console.log(`📊 Trial usage recorded: user ${userId}, model ${modelKey}`);
  } catch (e) {
    console.error('Error recording trial usage:', e.message);
  }
}

/**
 * Перевіряє Trial обмеження для моделі
 * @returns {object} { allowed: boolean, message?: string }
 */
async function checkTrialRestrictions(userId, modelKey, options = {}) {
  // Перевіряємо чи користувач на Trial
  const isTrial = await isTrialUser(userId);
  if (!isTrial) {
    return { allowed: true }; // Платний користувач - без обмежень
  }

  // 1. Перевірка повністю заблокованих моделей
  if (TRIAL_RESTRICTIONS.blockedModels.includes(modelKey)) {
    return {
      allowed: false,
      message: TRIAL_RESTRICTIONS.messages.blocked
    };
  }

  // 2. Перевірка заблокованих режимів (наприклад, тривалість)
  const blockedModes = TRIAL_RESTRICTIONS.blockedModes[modelKey];
  if (blockedModes) {
    // Перевірка тривалості для Kling
    if (blockedModes.durations && options.duration) {
      if (blockedModes.durations.includes(options.duration)) {
        return {
          allowed: false,
          message: TRIAL_RESTRICTIONS.messages.durationBlocked
        };
      }
    }
  }

  // 3. Перевірка лімітованих моделей (читаємо з бази)
  const limit = TRIAL_RESTRICTIONS.limitedModels[modelKey];
  if (limit) {
    const currentUsage = await getTrialUsage(userId, modelKey);

    if (currentUsage >= limit) {
      return {
        allowed: false,
        message: TRIAL_RESTRICTIONS.messages.blocked
      };
    }

    // Повертаємо warning якщо це остання безкоштовна генерація
    const remaining = limit - currentUsage;
    if (remaining <= 1) {
      return {
        allowed: true,
        warning: TRIAL_RESTRICTIONS.messages.limited(remaining)
      };
    }
  }

  return { allowed: true };
}


// ✅ МОДЕЛІ КОТРІ ПІДТРИМУЮТЬ ДОВГІ ПРОМПТИ (накопичення через "...")
const MODELS_WITH_LONG_PROMPTS = [
  'nano_banana_2k',
  'nano_banana_4k',
  'seedream_2k',
  'seedream_4k',
  'ideogram',
  'veo'
];

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
  'kling',                  // duration + aspect + start_image + end_image
  'kling_motion',           // mode + orientation + sound + фото + відео
  'veo',                    // aspect ratio + prompt + references + last_frame
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

  // ✅ ДОЗВОЛЯЄМО VEO CALLBACKS
  if (callbackData.startsWith('veo_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО KLING CALLBACKS
  if (callbackData.startsWith('kling_')) {
    return next();
  }

  // ✅ ДОЗВОЛЯЄМО KLING MOTION CALLBACKS
  if (callbackData.startsWith('motion_')) {
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
  
  // ✅ Дозволяємо veo state
  if (state?.action === 'veo_generation') {
    return next();
  }

  // ✅ Дозволяємо kling state
  if (state?.action === 'kling_generation') {
    return next();
  }

  // ✅ Дозволяємо kling_motion state
  if (state?.action === 'kling_motion_generation') {
    return next();
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

<b>1️⃣ Базові помічники (Claude AI)</b>
- <b>✍️ Текст:</b> напишіть запит → отримайте відповідь
- <b>🎙️ Голос:</b> надішліть голосове → AI розпізнає і відповість
- <b>🖼️ Аналіз фото:</b> надішліть зображення → AI опише/проаналізує

<b>2️⃣ Генерація зображень</b>
- Оберіть модель (<i>Nano Banana, Seedream, Ideogram тощо</i>)
- Опишіть що хочете побачити (промпт)
- 💡 <b>Довгий промпт?</b> Надсилайте частинами з <code>...</code> в кінці
- Можна додати до 14 референс-фото!
- Очікуйте результат <i>(~20–60 сек)</i>

<b>3️⃣ Генерація відео</b>
- Оберіть модель (<i>Kling, Veo, Runway тощо</i>)
- Налаштуйте параметри (тривалість, пропорції)
- Надішліть промпт або фото
- Відео буде готове <i>за 1–5 хвилин</i>

💰 <b>Токени ⚡</b>
- <b>Кожна генерація списує токени</b>
- 🎁 <b>Безкоштовно:</b> 75⚡ при реєстрації
- 💎 Поповніть баланс для необмеженого доступу
- 📉 <b>Чим більший пакет — тим вигідніше!</b>

<i>⚡ Вартість вказана біля кожної моделі</i>

📜 <b>Політика білінгу</b>

- Бот використовує сторонні AI-сервіси
  <i>(Replicate, Google, Runway тощо)</i>

- <b>Ви купуєте внутрішні токени ⚡</b>, а не прямий API-доступ

- <b>Токени списуються за кожну AI-дію</b>

⚠️ <b>Важливо:</b>
- <b>Генерація може не відповідати очікуванням</b> — це особливість AI
- <b>Повернення токенів за виконані дії не передбачено</b>

🔥 <b>⚠️ ЗАВЖДИ ЗАВАНТАЖУЙТЕ ОДРАЗУ! ⚠️</b>
<b>Великі файли (>10MB) активні ТІЛЬКИ 1 ГОДИНУ!</b>
Звичайні фото/відео Telegram зберігає автоматично.

📥 <b>Як зберегти результат:</b>
1️⃣ Натисніть на згенерований файл
2️⃣ Натисніть меню ⋮ або утримуйте палець
3️⃣ Оберіть "Зберегти" / "Завантажити"

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

bot.command('clear', async (ctx) => {
  const userId = ctx.from.id;

  // Очищаємо накопичений промпт
  const hadPrompt = pendingPrompts.has(userId);
  pendingPrompts.delete(userId);

  // Очищаємо стан генерації (але НЕ обрану модель!)
  const hadState = userState.has(userId);
  userState.delete(userId);
  // НЕ видаляємо userCurrentModel - користувач може продовжити з тією ж моделлю

  if (hadPrompt || hadState) {
    const currentModel = userCurrentModel.get(userId);
    await ctx.reply(
      '🧹 <b>Очищено!</b>\n\n' +
      (hadPrompt ? '✅ Накопичений промпт видалено\n' : '') +
      (hadState ? '✅ Стан генерації скинуто\n' : '') +
      (currentModel ? `\n📌 Обрана модель: <b>${currentModel}</b>\nМожете продовжити генерацію.` : '\nМожете почати заново.'),
      { parse_mode: 'HTML' }
    );
  } else {
    await ctx.reply(
      '✅ Нічого очищати - все чисто!',
      keyboard.createMainMenu()
    );
  }
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
    [Markup.button.callback('💌 До Дня Закоханих', 'creative_love_is')],
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

// Отримуємо ціни моделей
const nanoBanana2kModel = models.design.models.find(m => m.key === 'nano_banana_2k');
const nanoBanana4kModel = models.design.models.find(m => m.key === 'nano_banana_4k');
const CREATIVE_COST_2K = nanoBanana2kModel?.cost || 16;
const CREATIVE_COST_4K = nanoBanana4kModel?.cost || 31;
const CREATIVE_COST = CREATIVE_COST_4K; // Default для інших креативів

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

// ==================== UKRAINIAN ROMANTIC QUOTES FOR LOVE IS... ====================
// Точно 25 цитат, як запропоновано
const UKRAINIAN_LOVE_QUOTES = [
  "засинати, тримаючись за руки",
  "ділити останній шматочок і не шкодувати",
  "сміятися з дурниць, які розумієте лише ви двоє",
  "пити чай на кухні й говорити 'як ти?' по-справжньому",
  "обіймати міцніше, коли день був важкий",
  "пам'ятати про 'я з тобою' без зайвих слів",
  "робити з дому місце, куди хочеться повертатися",
  "підтримувати мрії одне одного, навіть маленькі",
  "разом прибирати без драми і з музикою",
  "приносити каву саме так, як ти любиш",
  "писати 'я скучив/скучила' першими",
  "вміти миритися швидше, ніж ображатися",
  "радіти простим вечорам більше, ніж гучним планам",
  "зберігати теплість навіть у дрібних клопотах",
  "робити компліменти не 'за щось', а 'просто так'",
  "ділити парасолю і сміятися під дощем",
  "помічати одне одного в натовпі з першого погляду",
  "планувати майбутнє й не поспішати — разом",
  "підставляти плече, а не читати нотації",
  "бути командою у всьому — навіть у дрібницях",
  "цілувати в щоку, коли ти не очікуєш",
  "берегти ваші 'маленькі традиції'",
  "вміти слухати, а не лише відповідати",
  "казати 'дякую' за буденні речі",
  "робити фото смішними, а спогади — теплими"
];

const ROMANTIC_SCENARIOS = [
  // Класичні романтичні
  "holding hands",
  "hugging warmly",
  "sharing umbrella",
  "dancing together",
  "giving flowers",
  "sitting together",
  "walking together",
  "looking at stars",
  "sharing ice cream",

  // Ніжні жести
  "gentle forehead kiss",
  "playing with hair",
  "nose to nose",
  "piggyback ride",
  "carried in arms",
  "head on shoulder",
  "intertwined fingers",
  "whispering secrets",

  // Веселі активності
  "pillow fight",
  "making funny faces",
  "building blanket fort",
  "taking silly selfie",
  "sharing headphones",
  "cooking together",
  "playing video games",
  "eating pizza together",

  // Побутові милоти
  "morning coffee together",
  "breakfast in bed",
  "doing dishes together",
  "grocery shopping",
  "reading books together",
  "watching sunset",
  "building snowman",
  "catching raindrops",

  // Сюрреалістичні
  "floating with balloons",
  "sitting on clouds",
  "riding bicycle in sky",
  "surrounded by hearts",
  "standing on rainbow",
  "flying with birds",
  "dancing on stars",

  // Пригоди
  "running in rain",
  "jumping in puddles",
  "autumn leaf pile",
  "beach walking",
  "mountain hiking",
  "picnic in park",
  "riding tandem bike",

  // Творчі моменти
  "drawing each other",
  "taking photos",
  "making heart shapes",
  "blowing bubbles",
  "playing guitar together",
  "singing karaoke",

  // Затишні
  "wrapped in blanket",
  "cuddling on couch",
  "sleeping together",
  "sharing hot cocoa",
  "warming by fireplace",
  "under starry blanket",

  // Playful
  "feeding each other",
  "sharing cotton candy",
  "ice cream cone fight",
  "stealing hoodie",
  "tickle fight",
  "rock paper scissors"
];

const BACKGROUND_COLORS = [
  // Пастельні рожеві
  "soft pink",
  "blush pink",
  "rose pink",
  "peachy pink",
  "baby pink",

  // Фіолетові відтінки
  "lavender",
  "lilac",
  "light purple",
  "periwinkle",
  "mauve",

  // Зелені та м'ятні
  "mint green",
  "sage green",
  "seafoam",
  "pistachio",
  "pale turquoise",

  // Персикові та коралові
  "peach",
  "apricot",
  "light coral",
  "salmon pink",
  "melon",

  // Блакитні
  "sky blue",
  "powder blue",
  "baby blue",
  "ice blue",
  "aqua",

  // Жовті та кремові
  "cream yellow",
  "butter yellow",
  "lemon chiffon",
  "vanilla",
  "champagne",

  // Особливі
  "cotton candy",
  "pearl white",
  "rose gold",
  "champagne pink",
  "ivory cream"
];

const HEART_COLORS = [
  // Рожево-червоні
  "pink, red, purple",
  "pink, coral, magenta",
  "red, crimson, scarlet",
  "hot pink, purple, violet",

  // Яскраві мікси
  "fuchsia, pink, rose",
  "coral, peach, pink",
  "ruby, cherry, rose",
  "magenta, pink, lavender",

  // Пастельні комбінації
  "baby pink, blush, rose",
  "lavender, lilac, pink",
  "peach, coral, cream",
  "mint, pink, lavender",

  // Теплі тони
  "orange, coral, pink",
  "gold, rose, pink",
  "salmon, peach, coral",
  "tangerine, pink, red",

  // Холодні відтінки
  "purple, violet, magenta",
  "blue, purple, pink",
  "teal, pink, purple",
  "indigo, purple, pink",

  // Яскраві контрасти
  "neon pink, hot pink, magenta",
  "electric pink, fuchsia, purple",
  "bright red, pink, orange",

  // Ніжні градієнти
  "soft pink, rose, blush",
  "cream, peach, pink",
  "white, pink, rose",
  "vanilla, coral, pink"
];

// Бонус: додаткові деталі для унікальності
const CUTE_DETAILS = [
  "with floating hearts around",
  "with sparkles and stars",
  "with small flowers in background",
  "with musical notes floating",
  "with cute clouds nearby",
  "with ribbon or bow decoration",
  "with small butterflies",
  "with gentle glow effect",
  "with confetti around",
  "with small hearts and stars",
  "with whimsical swirls",
  "with little gift boxes",
  "with feathers floating",
  "with soap bubbles",
  "with golden shimmer"
];

// До Дня Закоханих - Love is... комік
bot.action('creative_love_is', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (!(await userBalance.hasTokens(userId, CREATIVE_COST_2K))) {
    await showInsufficientTokens(ctx, CREATIVE_COST_2K);
    return;
  }

  // Генеруємо випадкові елементи
  const randomQuote = UKRAINIAN_LOVE_QUOTES[Math.floor(Math.random() * UKRAINIAN_LOVE_QUOTES.length)];
  const randomScenario = ROMANTIC_SCENARIOS[Math.floor(Math.random() * ROMANTIC_SCENARIOS.length)];
  const randomBgColor = BACKGROUND_COLORS[Math.floor(Math.random() * BACKGROUND_COLORS.length)];
  const randomHeartColors = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
  const randomDetail = CUTE_DETAILS[Math.floor(Math.random() * CUTE_DETAILS.length)];

  userState.set(userId, {
    creative: 'love_is',
    step: 'waiting_photo',
    model: 'nano_banana_2k',
    loveIsData: {
      quote: randomQuote,
      scenario: randomScenario,
      bgColor: randomBgColor,
      heartColors: randomHeartColors,
      detail: randomDetail
    }
  });

  // ✅ ВАЖНО: Встановити currentModel щоб система знала яку модель використовувати
  userCurrentModel.set(userId, 'love_is');

  await ctx.reply(
      `💌 <b>Готовий креатив: День Закоханих "Love is..."</b>\n\n` +
      `📸 <b>Крок 1/1:</b> Надішліть фото пари\n\n` +
      `💰 <b>Вартість:</b> ${CREATIVE_COST_2K}⚡\n` +
      `⏱️ <b>Час:</b> ~30-40 секунд\n\n` +
      `👉 Надішліть фото пари тепер`,
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

  // Промпти (АНГЛІЙСЬКА + збереження рис обличчя)
  const prompts = {
    romance: `Professional romantic photoshoot at golden hour sunset. Two people holding hands, warm soft lighting, carefully designed outfit details, cinematic quality. Based on uploaded photo, preserve facial features, identity and likeness. High detail portrait, 4K quality.`,

    tech: `Fashion magazine style photoshoot with luxury sports car. One person posing near vehicle, dramatic lighting with strong shadows, high-end lookbook aesthetic. Based on uploaded photo, preserve facial features, identity and likeness. Professional lighting, 4K quality.`,

    urban: `Cyberpunk fashion photoshoot in neon-lit night city. One person among bright neon lights, experimental lighting, urban details in background, vivid colors. Based on uploaded photo, preserve facial features, identity and likeness. Urban aesthetic, 4K quality.`,

    fantasy: `Fantasy fairy tale photoshoot. Person with magical artifact in misty forest, magical atmosphere, mystical lighting, detailed costume design. Based on uploaded photo, preserve facial features, identity and likeness. High detail, 4K quality.`,

    mashup: `Creative surrealist composition. Person with fantastical object or creature, harmonious interaction, vibrant colors, detailed rendering. Based on uploaded photo, preserve facial features, identity and likeness. Original creative style, 4K quality.`,

    love_is: (() => {
      const data = state.loveIsData;
      return `GOAL: Transform the uploaded photo of a real couple into a cute vintage bubblegum-wrapper "Love Is"-style sticker panel (romantic mini-comic). Keep the couple recognizable (hair, face proportions, key features), but simplify into classic chibi cartoon characters.

STYLE (match the classic "Love Is" sticker vibe):
- 1990s romantic sticker/comic illustration
- big heads, small bodies, tiny hands/feet, simple rounded shapes
- clean black outline with slightly varied line weight
- soft pastel watercolor fills + minimal shading (gentle gradients)
- subtle paper grain / print texture, tiny ink imperfections like vintage print
- warm, innocent, playful mood; cute facial expressions; light blush on cheeks
- no modern 3D, no anime, no hyperrealism, no painterly oil look

COMPOSITION / LAYOUT (single panel):
- Pure white background
- A thin black rectangular frame around the whole panel (like a sticker card), even margins
- Top-left header text: "Love is…" (exactly this, with three dots) in simple black print/handwritten-like feel, small size
- Top-right: a small heart icon (solid red/pink) inside the frame
- Illustration area: couple centered in the upper 65-70% of the panel, full bodies visible, no cropping
- Caption area: lower 30-35% reserved for Ukrainian caption text

COUPLE TRANSFORMATION RULES:
- Preserve identity cues: hair color/style, skin tone, face shape, eyebrows, glasses (if any), beard/mustache (if any)
- Keep the pose/interaction similar to the photo if it reads well; otherwise convert to a classic sweet pose: ${data.scenario}
- Simplify clothing into solid pastel blocks; keep recognizable colors/pattern hints
- Add small cute details typical for sticker comics: tiny hearts floating above, minimal props ${data.detail}

TEXT RULES (CRITICAL):
- Only two text elements:
  1) Top-left: "Love is…" (exactly this format, not "Love is...")
  2) Bottom: ONE Ukrainian sentence that MUST start with three dots "..."
- The bottom sentence is: "...${data.quote}"
- Do NOT add numbers, copyrights, signatures, watermarks, extra captions, or English translation
- Typography: simple, clean, NOT fancy cursive

NEGATIVE / AVOID:
- no anime, no manga, no 3D render, no photorealism
- no complex backgrounds, no gradients behind the panel, no colored backdrop
- no extra text, no English line, no page numbers, no watermark, no copyright marks
- no blurry lines, no messy typography, no distorted faces, no extra fingers/limbs

OUTPUT: Single sticker-style panel with "Love is…" at top-left and Ukrainian caption at bottom.`;
    })()
  };

  const prompt = prompts[creativeType];

  // Вибираємо правильну модель для кожного креативу
  const modelKey = creativeType === 'love_is' ? 'nano_banana_2k' : 'nano_banana_4k';
  const model = models.design.models.find(m => m.key === modelKey);

  const creativeNames = {
    love_is: '💌 День Закоханих',
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
    // Вибираємо правильну точність для моделі
    const resolution = modelKey === 'nano_banana_2k' ? '2K' : '4K';
    const result = await replicate.generateWithNanoBanana(prompt, imageUrl, resolution);

    if (!result.success) {
      await adminNotifier.notifyAdmin(
          bot,
          new Error(result.error),
          { userId, username: ctx.from.username, action: `creative_${creativeType}`, model: model.name }
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
        { modelKey: modelKey, modelName: model.name, apiCost: model.apiCost }
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
          `⚠️ <b>ВАЖЛИВО - ЗАВАНТАЖТЕ ОДРАЗУ!</b>\n` +
          `Посилання активне тільки <b>1 ГОДИНУ</b>!\n` +
          `Після цього файл буде видалений.\n\n` +
          `💾 <b>Як завантажити:</b>\n` +
          `1️⃣ Натисніть на посилання вище\n` +
          `2️⃣ Файл завантажиться\n` +
          `3️⃣ Збережіть на телефон/комп'ютер\n\n` +
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
            caption: `✅ ${creativeNames[creativeType]}\n\n⚠️ Посилання активне 1 ГОДИНУ - завантажте одразу! 📥\n\n💰 Витрачено: ${model.cost}⚡`,
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

  // ✅ TRIAL CHECK: Перевірка обмежень для nano_banana_4k
  const trialCheck = await checkTrialRestrictions(ctx.from.id, modelKey);
  if (!trialCheck.allowed) {
    await ctx.answerCbQuery();
    await ctx.reply(
      trialCheck.message,
      { parse_mode: 'HTML', ...keyboard.createSubscriptionsMenu() }
    );
    return;
  }
  // Показуємо warning якщо це остання безкоштовна генерація
  if (trialCheck.warning) {
    await ctx.reply(trialCheck.warning, { parse_mode: 'HTML' });
  }

  await ctx.answerCbQuery();

  if (model.cost > 0 && !(await userBalance.hasTokens(ctx.from.id, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  userCurrentModel.set(ctx.from.id, modelKey);

  // Інструкція про довгі промпти для моделей що підтримують
  const longPromptHint = MODELS_WITH_LONG_PROMPTS.includes(modelKey)
    ? `\n\n💡 <b>Довгий промпт?</b>\n` +
      `• Надсилайте текст частинами з <code>...</code> в кінці\n` +
      `• Остання частина - без крапок\n` +
      `• Потім надішліть фото (до 14 шт) - використається накопичений промпт`
    : '';

  const messages = {
    clarity: `${model.name}\n\n🔮 Покращення якості зображень\n\nНадішліть фото, яке хочете покращити.\nМожете додати підпис (опис) для кращого результату.\n\n💰 Вартість: ${model.cost}⚡\n📈 Збільшення: 2x (scale factor)\n⏱️ Час обробки: ~30-60 секунд`,
    stable_diffusion: `${model.name}\n\n🎨 Text-to-Image і Image-to-Image\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для редагування\n\n💰 Вартість: ${model.cost}⚡\n⏱️ Час: ~30-40 секунд${longPromptHint}`,
    ideogram: `${model.name}\n\n🎨 Text-to-Image і Image-to-Image\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для редагування\n\n💰 Вартість: ${model.cost}⚡\n⏱️ Час: ~30-40 секунд${longPromptHint}`,
    nano_banana: `${model.name}\n\n🎨 Text-to-Image і Image-to-Image\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для редагування\n\n💡 Підтримка до 14 зображень одночасно!\n💰 Вартість: ${model.cost}⚡\n⏱️ Час: ~20-30 секунд${longPromptHint}`,
    seedream: `${model.name}\n\n🎨 Text-to-Image і Image-to-Image\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для редагування\n\n💰 Вартість: ${model.cost}⚡\n⏱️ Час: ~20-40 секунд${longPromptHint}`
  };

  // Для nano_banana та seedream моделей використовуємо спільний шаблон
  let messageKey = modelKey;
  if (modelKey.startsWith('nano_banana')) messageKey = 'nano_banana';
  if (modelKey.startsWith('seedream')) messageKey = 'seedream';
  const defaultMessage = `${model.name}\n\nНадішліть текстовий опис зображення, яке хочете згенерувати.\n\nВартість: ${model.cost > 0 ? model.cost + '⚡' : 'Безкоштовно'}${longPromptHint}`;

  await ctx.reply(
    messages[messageKey] || defaultMessage,
    { parse_mode: 'HTML', ...keyboard.createBackButton('design_menu') }
  );
});

// Video Models
bot.action(/^(kling|kling_motion|runway_gen4|runway_turbo|veo|luma)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const model = models.video.models.find(m => m.key === modelKey);

  if (!model) {
    await ctx.answerCbQuery('Модель не знайдена');
    return;
  }

  await ctx.answerCbQuery();

  // ✅ TRIAL CHECK: Перевірка обмежень для безкоштовних користувачів
  const trialCheck = await checkTrialRestrictions(ctx.from.id, modelKey);
  if (!trialCheck.allowed) {
    await ctx.reply(
      trialCheck.message,
      { parse_mode: 'HTML', ...keyboard.createSubscriptionsMenu() }
    );
    return;
  }
  // Показуємо warning якщо це остання безкоштовна генерація
  if (trialCheck.warning) {
    await ctx.reply(trialCheck.warning, { parse_mode: 'HTML' });
  }

  if (!(await userBalance.hasTokens(ctx.from.id, model.cost))) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  userCurrentModel.set(ctx.from.id, modelKey);

  // Для Kling Motion показуємо спеціальне меню з вибором mode та orientation
  if (modelKey === 'kling_motion') {
    const minCost = model.cost || 52;
    const maxCost = model.maxCost || 208;

    await ctx.reply(
      `🔥 <b>Kling Motion Control</b>\n\n` +
      `🎬 <b>Крок 1: Оберіть режим якості</b>\n\n` +
      `<b>⚡ STD</b> — Стандартний (швидше, дешевше)\n` +
      `<b>💎 PRO</b> — Професійний (вища якість)\n\n` +
      `💰 Вартість: ${minCost}—${maxCost}⚡`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⚡ STD', 'motion_mode_std'),
            Markup.button.callback('💎 PRO', 'motion_mode_pro')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Для Kling показуємо спеціальне меню з вибором тривалості
  if (modelKey === 'kling') {
    const minCost = 5 * model.costPerSecond;   // 5 сек
    const maxCost = 10 * model.costPerSecond;  // 10 сек

    await ctx.reply(
      `🎭 <b>Kling v2.5 Turbo Pro</b>\n\n` +
      `📐 <b>Крок 1: Оберіть тривалість відео</b>\n\n` +
      `⏱️ <b>5 секунд</b> — ${minCost}⚡\n` +
      `⏱️ <b>10 секунд</b> — ${maxCost}⚡\n\n` +
      `📊 Якість: 1080p\n` +
      `💰 Вартість: ${minCost}—${maxCost}⚡`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`5 сек (${minCost}⚡)`, 'kling_duration_5'),
            Markup.button.callback(`10 сек (${maxCost}⚡)`, 'kling_duration_10')
          ],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Для Veo показуємо спеціальне меню з вибором aspect ratio
  if (modelKey === 'veo') {
    const aspectMenu = Markup.inlineKeyboard([
      [Markup.button.callback('🎬 16:9 (Горизонтальне)', 'veo_aspect_16:9')],
      [Markup.button.callback('📱 9:16 (Вертикальне)', 'veo_aspect_9:16')],
      [Markup.button.callback('← Назад', 'video_menu')]
    ]);

    // Розрахунок діапазону цін
    const minCost = 4 * model.costPerSecondNoAudio;  // 4 сек без аудіо
    const maxCost = 8 * model.costPerSecondAudio;    // 8 сек з аудіо

    await ctx.reply(
      `🌟 <b>Google Veo 3.1 💎</b>\n\n` +
      `📐 <b>Крок 1: Оберіть пропорції відео</b>\n\n` +
      `<b>🎬 16:9</b> — YouTube, кіно, горизонтальне\n` +
      `<b>📱 9:16</b> — TikTok, Reels, Stories\n\n` +
      `💡 <i>Референс-зображення працюють тільки з 16:9</i>\n\n` +
      `⏱️ Тривалість: 4, 6 або 8 секунд\n` +
      `🔊 Аудіо: опціонально\n` +
      `📊 Якість: 1080p\n` +
      `💰 Вартість: ${minCost}—${maxCost}⚡`,
      { parse_mode: 'HTML', ...aspectMenu }
    );
    return;
  }

  const messages = {

    runway_turbo: `${model.name}\n\n🎬 Image-to-Video ONLY ⚠️\n\n⚠️ ОБОВ'ЯЗКОВО: Надішліть зображення + текстовий опис\n\n📝 Опис має містити деталі руху/анімації\n🖼️ Зображення стане першим кадром відео\n\n💡 Приклад:\n"Camera slowly zooms in, person turns head to the left"\n\n⏱️ Генерація: 1-3 хвилини\n💰 Вартість: ${model.cost}⚡\n📊 Якість: 720p, 5 секунд\n⚡ Найшвидша модель!`,

    runway_gen4: `${model.name}\n\n🎬 Image-to-Video ONLY ⚠️\n\n⚠️ ОБОВ'ЯЗКОВО: Надішліть зображення + текстовий опис\n\n📝 Опис має містити деталі руху/анімації\n🖼️ Зображення стане першим кадром відео\n\n💡 Приклад:\n"Slow motion, waves crashing, cinematic"\n\n⏱️ Генерація: 3-5 хвилин\n💰 Вартість: ${model.cost}⚡\n📊 Якість: 1080p, 10 секунд\n💎 Найвища якість!`,

    luma: `${model.name}\n\n🌊 Text-to-Video і Image-to-Video\n\n📝 Надішліть текстовий опис для генерації\n🖼️ АБО надішліть фото з підписом для створення відео\n\n⏱️ Генерація: 2-4 хвилини\n💰 Вартість: ${model.cost}⚡\n📊 Якість: 1080p, 5 секунд`
  };

  await ctx.reply(
    messages[modelKey] || `${model.name}\n\nНадішліть текстовий опис відео або зображення з підписом.\n\n⏱️ Генерація: 2-5 хвилин\n💰 Вартість: ${model.cost}⚡`,
    keyboard.createBackButton('video_menu')
  );
});

// ==================== VEO 3.1 CALLBACKS ====================

// Крок 1: Вибір aspect ratio
bot.action(/^veo_aspect_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const aspectRatio = ctx.match[1]; // "16:9" або "9:16"

  // Зберігаємо стан
  userState.set(userId, {
    action: 'veo_generation',
    step: 'select_duration',
    aspectRatio: aspectRatio,
    duration: 8,
    generateAudio: true,
    references: [],
    lastFrame: null
  });

  // Функція розрахунку ціни Veo
  const veoModel = models.video.models.find(m => m.key === 'veo');
  const calcVeoCost = (dur, audio) => {
    const costPerSec = audio ? veoModel.costPerSecondAudio : veoModel.costPerSecondNoAudio;
    return dur * costPerSec;
  };

  // Меню вибору тривалості з цінами
  await ctx.reply(
    `🌟 <b>Google Veo 3.1 💎</b>\n\n` +
    `📐 Пропорції: <b>${aspectRatio === '16:9' ? '🎬 Горизонтальне' : '📱 Вертикальне'}</b>\n\n` +
    `⏱️ <b>Крок 2: Оберіть тривалість відео</b>\n\n` +
    `💰 Ціни (з аудіо / без аудіо):\n` +
    `• 4 сек: ${calcVeoCost(4, true)}⚡ / ${calcVeoCost(4, false)}⚡\n` +
    `• 6 сек: ${calcVeoCost(6, true)}⚡ / ${calcVeoCost(6, false)}⚡\n` +
    `• 8 сек: ${calcVeoCost(8, true)}⚡ / ${calcVeoCost(8, false)}⚡`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`4сек`, 'veo_duration_4'),
          Markup.button.callback(`6сек`, 'veo_duration_6'),
          Markup.button.callback(`8сек`, 'veo_duration_8')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 2: Вибір тривалості
bot.action(/^veo_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const duration = parseInt(ctx.match[1]);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Veo 3.1');
    return;
  }

  userState.set(userId, {
    ...state,
    duration: duration,
    step: 'select_audio'
  });

  // Розрахунок цін
  const veoModel = models.video.models.find(m => m.key === 'veo');
  const costWithAudio = duration * veoModel.costPerSecondAudio;
  const costNoAudio = duration * veoModel.costPerSecondNoAudio;

  // Меню вибору аудіо з цінами
  await ctx.reply(
    `🌟 <b>Google Veo 3.1 💎</b>\n\n` +
    `📐 Пропорції: <b>${state.aspectRatio === '16:9' ? '🎬 Горизонтальне' : '📱 Вертикальне'}</b>\n` +
    `⏱️ Тривалість: <b>${duration} секунд</b>\n\n` +
    `🔊 <b>Крок 3: Аудіо</b>\n\n` +
    `Veo 3.1 може генерувати звук для відео.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`🔊 З аудіо (${costWithAudio}⚡)`, 'veo_audio_on')],
        [Markup.button.callback(`🔇 Без аудіо (${costNoAudio}⚡)`, 'veo_audio_off')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 3: Вибір аудіо
bot.action(/^veo_audio_(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);
  const generateAudio = ctx.match[1] === 'on';

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Veo 3.1');
    return;
  }

  // Розрахунок фінальної ціни
  const veoModel = models.video.models.find(m => m.key === 'veo');
  const costPerSec = generateAudio ? veoModel.costPerSecondAudio : veoModel.costPerSecondNoAudio;
  const finalCost = state.duration * costPerSec;

  userState.set(userId, {
    ...state,
    generateAudio: generateAudio,
    veoCost: finalCost,
    step: 'waiting_prompt'
  });

  await ctx.reply(
    `🌟 <b>Google Veo 3.1 💎</b>\n\n` +
    `📐 Пропорції: <b>${state.aspectRatio === '16:9' ? '🎬 Горизонтальне' : '📱 Вертикальне'}</b>\n` +
    `⏱️ Тривалість: <b>${state.duration} секунд</b>\n` +
    `🔊 Аудіо: <b>${generateAudio ? 'Так' : 'Ні'}</b>\n` +
    `💰 Вартість: <b>${finalCost}⚡</b>\n\n` +
    `📝 <b>Крок 4: Напишіть промпт</b>\n\n` +
    `Опишіть детально що хочете бачити у відео.\n\n` +
    `💡 <b>Приклади:</b>\n` +
    `• A woman walking through a sunlit forest\n` +
    `• Drone shot of a city at sunset, cinematic\n` +
    `• A cat playing with a ball, slow motion\n\n` +
    `✍️ <b>Надішліть текстовий промпт:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// ==================== VEO START IMAGE CALLBACKS ====================

// Користувач хоче додати стартове зображення
bot.action('veo_add_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Veo 3.1');
    return;
  }

  const idealSize = state.aspectRatio === '16:9' ? '1280×720' : '720×1280';

  userState.set(userId, {
    ...state,
    step: 'waiting_start_image'
  });

  await ctx.reply(
    `🖼️ <b>Завантажте стартове зображення</b>\n\n` +
    `Це зображення стане <b>першим кадром</b> вашого відео.\n` +
    `AI анімує його згідно з промптом.\n\n` +
    `💡 Ідеальний розмір: ${idealSize}\n` +
    `📁 Формат: JPG або PNG\n\n` +
    `📤 <b>Надішліть одне фото:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Користувач пропускає стартове зображення - переходимо до референсів/last_frame
bot.action('veo_skip_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  // Для 16:9 - питаємо про референси
  if (state.aspectRatio === '16:9') {
    userState.set(userId, {
      ...state,
      step: 'ask_references',
      startImage: null
    });

    await ctx.reply(
      `📸 <b>Референс-зображення (опціонально)</b>\n\n` +
      `Референси допомагають AI зберегти консистентність персонажів/об'єктів у відео.\n\n` +
      `<b>🎯 Для чого:</b>\n` +
      `• Персонаж у відео буде схожий на фото\n` +
      `• Стиль/кольори збережуться\n` +
      `• Об'єкти виглядатимуть як на референсі\n\n` +
      `📌 Можна завантажити до 3 зображень`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📸 Додати референси (до 3)', 'veo_add_references')],
          [Markup.button.callback('⏭️ Без референсів', 'veo_skip_references')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
  } else {
    // Для 9:16 - референси не працюють, питаємо про last_frame
    userState.set(userId, {
      ...state,
      step: 'ask_last_frame',
      startImage: null
    });

    await ctx.reply(
      `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
      `<b>Що це:</b> Зображення для кінця відео.\n` +
      `AI створить плавний перехід від початку до цього кадру.\n\n` +
      `<b>🎯 Приклад:</b>\n` +
      `• Початок: людина стоїть\n` +
      `• Кінець: людина сидить\n` +
      `• AI згенерує рух присідання`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📷 Завантажу last frame', 'veo_add_last_frame')],
          [Markup.button.callback('⏭️ Генерувати без', 'veo_skip_last_frame')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
  }
});

// ==================== VEO REFERENCES CALLBACKS ====================

// Крок: Після стартового зображення - питаємо про референси
bot.action('veo_add_references', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново, оберіть Veo 3.1');
    return;
  }

  // Референси працюють тільки з 16:9
  if (state.aspectRatio !== '16:9') {
    await ctx.reply(
      `⚠️ <b>Референс-зображення працюють тільки з 16:9!</b>\n\n` +
      `Ви обрали ${state.aspectRatio}. Референси будуть проігноровані.\n` +
      `Хочете змінити пропорції на 16:9?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Змінити на 16:9', 'veo_change_to_16:9')],
          [Markup.button.callback('➡️ Продовжити без референсів', 'veo_skip_references')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_references'
  });

  await ctx.reply(
    `📸 <b>Завантажте референс-зображення</b>\n\n` +
    `📌 <b>Правила:</b>\n` +
    `• Від 1 до 3 зображень\n` +
    `• Ідеальний розмір: 1280×720 (16:9)\n` +
    `• Формат: JPG або PNG\n\n` +
    `<b>🎯 Для чого референси:</b>\n` +
    `• Персонаж/обличчя буде схоже на фото\n` +
    `• Стиль/кольори з референсу\n` +
    `• Об'єкти/локації з фото\n\n` +
    `📤 Надішліть від 1 до 3 фото, потім натисніть "✅ Готово"`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Готово (завантажив)', 'veo_references_done')],
        [Markup.button.callback('⏭️ Пропустити референси', 'veo_skip_references')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Змінити на 16:9 для референсів
bot.action('veo_change_to_16:9', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state) {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    aspectRatio: '16:9',
    step: 'waiting_references'
  });

  await ctx.reply(
    `✅ Пропорції змінено на <b>16:9</b>\n\n` +
    `📸 <b>Завантажте референс-зображення</b>\n\n` +
    `📤 Надішліть від 1 до 3 фото, потім натисніть "✅ Готово"`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Готово (завантажив)', 'veo_references_done')],
        [Markup.button.callback('⏭️ Пропустити референси', 'veo_skip_references')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Референси завантажені - переходимо до last_frame
bot.action('veo_references_done', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  const refCount = state.references?.length || 0;

  // Якщо є референси - last_frame ігнорується, генеруємо одразу
  if (refCount > 0) {
    await ctx.reply(
      `✅ <b>Референсів завантажено: ${refCount}</b>\n\n` +
      `⚠️ <i>Last frame ігнорується при використанні референсів</i>\n\n` +
      `🚀 Починаємо генерацію...`,
      { parse_mode: 'HTML' }
    );
    await generateVeoVideo(ctx, state);
    return;
  }

  // Якщо референсів немає - питаємо про last_frame
  userState.set(userId, {
    ...state,
    step: 'ask_last_frame'
  });

  await ctx.reply(
    `🎬 <b>Чи є у вас останній кадр (last frame)?</b>\n\n` +
    `<b>Що це:</b> Зображення для кінця відео.\n` +
    `AI створить плавний перехід від початку до цього кадру.\n\n` +
    `<b>🎯 Приклад:</b>\n` +
    `• Початок: людина стоїть\n` +
    `• Кінець: людина сидить\n` +
    `• AI згенерує рух присідання`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📷 Так, завантажу', 'veo_add_last_frame')],
        [Markup.button.callback('⏭️ Ні, генерувати без', 'veo_skip_last_frame')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Пропустити референси
bot.action('veo_skip_references', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'ask_last_frame',
    references: []
  });

  await ctx.reply(
    `🎬 <b>Чи є у вас останній кадр (last frame)?</b>\n\n` +
    `<b>Що це:</b> Зображення для кінця відео.\n` +
    `AI створить плавний перехід від початку до цього кадру.\n\n` +
    `<b>🎯 Приклад:</b>\n` +
    `• Початок: людина стоїть\n` +
    `• Кінець: людина сидить\n` +
    `• AI згенерує рух присідання`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📷 Так, завантажу', 'veo_add_last_frame')],
        [Markup.button.callback('⏭️ Ні, генерувати без', 'veo_skip_last_frame')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Додати last frame
bot.action('veo_add_last_frame', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_last_frame'
  });

  await ctx.reply(
    `📷 <b>Завантажте останній кадр</b>\n\n` +
    `Надішліть <b>одне зображення</b>, яке буде кінцем відео.\n\n` +
    `💡 <b>Порада:</b> Використовуйте зображення того ж розміру що й aspect ratio (${state.aspectRatio === '16:9' ? '1280×720' : '720×1280'})`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Пропустити last frame - генеруємо
bot.action('veo_skip_last_frame', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  await ctx.reply('🚀 Починаємо генерацію...');
  await generateVeoVideo(ctx, state);
});

// Генерувати одразу (без додаткових опцій)
bot.action('veo_generate_now', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'veo_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  await ctx.reply('🚀 Починаємо генерацію...');
  await generateVeoVideo(ctx, state);
});

// ==================== KLING v2.5 CALLBACKS ====================

// Крок 1: Вибір тривалості
bot.action(/^kling_duration_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const duration = parseInt(ctx.match[1]);
  const model = models.video.models.find(m => m.key === 'kling');
  const klingCost = duration * model.costPerSecond;

  // ✅ TRIAL CHECK: 10 секунд заблоковано для Trial
  const trialCheck = await checkTrialRestrictions(userId, 'kling', { duration });
  if (!trialCheck.allowed) {
    await ctx.reply(
      trialCheck.message,
      { parse_mode: 'HTML', ...keyboard.createSubscriptionsMenu() }
    );
    return;
  }

  userState.set(userId, {
    action: 'kling_generation',
    step: 'select_aspect',
    duration: duration,
    klingCost: klingCost
  });

  await ctx.reply(
    `🎭 <b>Kling v2.5 Turbo Pro</b>\n\n` +
    `⏱️ Тривалість: <b>${duration} секунд</b>\n` +
    `💰 Вартість: <b>${klingCost}⚡</b>\n\n` +
    `📐 <b>Крок 2: Оберіть пропорції</b>\n\n` +
    `<i>Ігнорується якщо завантажите стартове зображення</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🎬 16:9', 'kling_aspect_16:9'),
          Markup.button.callback('📱 9:16', 'kling_aspect_9:16')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 2: Вибір aspect ratio
bot.action(/^kling_aspect_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const aspectRatio = ctx.match[1];
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    aspectRatio: aspectRatio,
    step: 'ask_start_image'
  });

  await ctx.reply(
    `🎭 <b>Kling v2.5 Turbo Pro</b>\n\n` +
    `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
    `📐 Пропорції: <b>${aspectRatio}</b>\n` +
    `💰 Вартість: <b>${state.klingCost}⚡</b>\n\n` +
    `🖼️ <b>Крок 3: Стартове зображення (опціонально)</b>\n\n` +
    `Зображення стане першим кадром відео.\n` +
    `AI анімує його згідно з промптом.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🖼️ Завантажу зображення', 'kling_add_start_image')],
        [Markup.button.callback('⏭️ Без зображення (text-to-video)', 'kling_skip_start_image')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 3a: Додати стартове зображення
bot.action('kling_add_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_start_image'
  });

  await ctx.reply(
    `🖼️ <b>Завантажте стартове зображення</b>\n\n` +
    `Це зображення стане <b>першим кадром</b> відео.\n\n` +
    `📤 <b>Надішліть одне фото:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Крок 3b: Пропустити стартове зображення
bot.action('kling_skip_start_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    startImage: null,
    step: 'waiting_prompt'
  });

  await ctx.reply(
    `🎭 <b>Kling v2.5 Turbo Pro</b>\n\n` +
    `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
    `📐 Пропорції: <b>${state.aspectRatio}</b>\n` +
    `💰 Вартість: <b>${state.klingCost}⚡</b>\n\n` +
    `📝 <b>Крок 4: Напишіть промпт</b>\n\n` +
    `Опишіть детально що хочете бачити у відео.\n\n` +
    `💡 <b>Приклади:</b>\n` +
    `• A dog running on the beach, slow motion\n` +
    `• Cinematic drone shot of mountains at sunrise\n` +
    `• A dancer performing ballet, elegant movements\n\n` +
    `✍️ <b>Надішліть текстовий промпт:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Крок 4 (після start_image): Питаємо про end_image
bot.action('kling_ask_end_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  await ctx.reply(
    `🎭 <b>Kling v2.5 Turbo Pro</b>\n\n` +
    `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
    `<b>Що це:</b> Зображення для кінця відео.\n` +
    `AI створить плавний перехід від першого до останнього кадру.\n\n` +
    `<b>🎯 Приклад:</b>\n` +
    `• Початок: людина стоїть\n` +
    `• Кінець: людина сидить\n` +
    `• Результат: анімація присідання`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📷 Завантажу end_image', 'kling_add_end_image')],
        [Markup.button.callback('⏭️ Перейти до промпту', 'kling_skip_end_image')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Додати end_image
bot.action('kling_add_end_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    step: 'waiting_end_image'
  });

  await ctx.reply(
    `📷 <b>Завантажте останній кадр</b>\n\n` +
    `Це зображення стане кінцевим кадром відео.\n\n` +
    `📤 <b>Надішліть одне фото:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Пропустити end_image - перейти до промпту
bot.action('kling_skip_end_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    endImage: null,
    step: 'waiting_prompt'
  });

  await ctx.reply(
    `🎭 <b>Kling v2.5 Turbo Pro</b>\n\n` +
    `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
    `📐 Пропорції: <b>${state.aspectRatio}</b>\n` +
    `🖼️ Start image: <b>${state.startImage ? 'Так' : 'Ні'}</b>\n` +
    `💰 Вартість: <b>${state.klingCost}⚡</b>\n\n` +
    `📝 <b>Напишіть промпт</b>\n\n` +
    `Опишіть детально що хочете бачити у відео.\n\n` +
    `✍️ <b>Надішліть текстовий промпт:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// ==================== KLING MOTION CONTROL CALLBACKS ====================

// Крок 1: Вибір mode (STD/PRO)
bot.action(/^motion_mode_(std|pro)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const mode = ctx.match[1];
  const model = models.video.models.find(m => m.key === 'kling_motion');

  userState.set(userId, {
    action: 'kling_motion_generation',
    step: 'select_orientation',
    mode: mode
  });

  // Показуємо ціни для обраного mode
  const imageCost = model.costs[`${mode}_image`];
  const videoCost = model.costs[`${mode}_video`];

  await ctx.reply(
    `🔥 <b>Kling Motion Control</b>\n\n` +
    `⚙️ Режим: <b>${mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n\n` +
    `🎭 <b>Крок 2: Оберіть орієнтацію персонажа</b>\n\n` +
    `<b>📷 Image</b> — орієнтація з фото (до 10 сек) — ${imageCost}⚡\n` +
    `<b>🎥 Video</b> — орієнтація з відео (до 30 сек) — ${videoCost}⚡`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`📷 Image (${imageCost}⚡)`, 'motion_orient_image'),
          Markup.button.callback(`🎥 Video (${videoCost}⚡)`, 'motion_orient_video')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 2: Вибір orientation (image/video)
bot.action(/^motion_orient_(image|video)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const orientation = ctx.match[1];
  const state = userState.get(userId);
  const model = models.video.models.find(m => m.key === 'kling_motion');

  if (!state || state.action !== 'kling_motion_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  const costKey = `${state.mode}_${orientation}`;
  const motionCost = model.costs[costKey];
  const maxDuration = orientation === 'image' ? 10 : 30;

  userState.set(userId, {
    ...state,
    orientation: orientation,
    motionCost: motionCost,
    step: 'ask_sound'
  });

  await ctx.reply(
    `🔥 <b>Kling Motion Control</b>\n\n` +
    `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
    `🎭 Орієнтація: <b>${orientation === 'image' ? '📷 Image' : '🎥 Video'}</b>\n` +
    `⏱️ Макс тривалість: <b>${maxDuration} сек</b>\n` +
    `💰 Вартість: <b>${motionCost}⚡</b>\n\n` +
    `🔊 <b>Крок 3: Звук з відео</b>\n\n` +
    `Зберегти оригінальний звук з референсного відео?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔊 Зберегти звук', 'motion_sound_on'),
          Markup.button.callback('🔇 Без звуку', 'motion_sound_off')
        ],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    }
  );
});

// Крок 3: Вибір keep_original_sound
bot.action(/^motion_sound_(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const keepSound = ctx.match[1] === 'on';
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_motion_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  userState.set(userId, {
    ...state,
    keepOriginalSound: keepSound,
    step: 'waiting_image'
  });

  const maxDuration = state.orientation === 'image' ? 10 : 30;

  await ctx.reply(
    `🔥 <b>Kling Motion Control</b>\n\n` +
    `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
    `🎭 Орієнтація: <b>${state.orientation === 'image' ? '📷 Image' : '🎥 Video'}</b>\n` +
    `⏱️ Макс: <b>${maxDuration} сек</b>\n` +
    `🔊 Звук: <b>${keepSound ? 'Зберегти' : 'Без звуку'}</b>\n` +
    `💰 Вартість: <b>${state.motionCost}⚡</b>\n\n` +
    `📷 <b>Крок 4: Надішліть ФОТО персонажа</b>\n\n` +
    `Це зображення персонажа який буде анімований.\n\n` +
    `📤 <b>Надішліть одне фото:</b>`,
    { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
  );
});

// Генерувати Kling Motion
bot.action('motion_generate_now', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_motion_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  await ctx.reply('🚀 Починаємо генерацію Kling Motion...');
  await generateKlingMotionVideo(ctx, state);
});

// ==================== KLING MOTION GENERATION FUNCTION ====================

async function generateKlingMotionVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.video.models.find(m => m.key === 'kling_motion');

  if (!model) {
    await ctx.reply('❌ Модель Kling Motion не знайдена');
    userState.delete(userId);
    return;
  }

  const motionCost = state.motionCost;
  const costKey = `${state.mode}_${state.orientation}`;
  const apiCost = model.apiCosts[costKey];

  if (!(await userBalance.hasTokens(userId, motionCost))) {
    await showInsufficientTokens(ctx, motionCost);
    userState.delete(userId);
    return;
  }

  const maxDuration = state.orientation === 'image' ? 10 : 30;

  const statusMsg = await ctx.reply(
    `🔥 <b>Kling Motion Control - Генерація</b>\n\n` +
    `⚙️ Режим: ${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}\n` +
    `🎭 Орієнтація: ${state.orientation === 'image' ? '📷 Image' : '🎥 Video'}\n` +
    `⏱️ Макс: ${maxDuration} сек\n` +
    `🔊 Звук: ${state.keepOriginalSound ? 'Зберегти' : 'Без'}\n\n` +
    `📝 Промпт: "${state.prompt?.substring(0, 100) || '(без промпту)'}"\n\n` +
    `⏱️ Це може зайняти 2-5 хвилин...`,
    { parse_mode: 'HTML' }
  );

  try {
    const result = await replicate.generateVideoWithKlingMotion(
      state.imageUrl,
      state.videoUrl,
      state.mode,
      state.orientation,
      state.prompt || '',
      state.keepOriginalSound
    );

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId, username, action: 'kling_motion_generation', model: model.name
      });
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `❌ Помилка генерації Kling Motion.\n\n${result.error}\n\nСпробуйте ще раз.`
      );
      userState.delete(userId);
      return;
    }

    await userBalance.deductTokens(userId, motionCost, `${model.name} generation`, {
      modelKey: 'kling_motion', modelName: model.name, apiCost: apiCost,
      mode: state.mode, orientation: state.orientation,
      keepOriginalSound: state.keepOriginalSound
    });

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.reply(
      `✅ <b>Kling Motion готово!</b>\n\n` +
      `⚠️ <b>ЗАВАНТАЖТЕ ОДРАЗУ!</b> Посилання активне 1 ГОДИНУ!\n\n` +
      `⚙️ ${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'} | ` +
      `${state.orientation === 'image' ? '📷' : '🎥'} | ` +
      `${state.keepOriginalSound ? '🔊' : '🔇'}\n\n` +
      `💰 Витрачено: ${motionCost}⚡`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );

    await ctx.replyWithVideo(
      { url: result.videoUrl },
      {
        caption: `🔥 Kling Motion\n\n⚙️ ${state.mode.toUpperCase()} | ${state.orientation} | ${state.keepOriginalSound ? '🔊' : '🔇'}\n⏰ Посилання видалиться через 1 годину!\n\n💰 Витрачено: ${motionCost}⚡`,
        ...keyboard.createBackButton('video_menu')
      }
    );

    userState.delete(userId);

  } catch (error) {
    console.error('Kling Motion generation failed:', error);
    await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'kling_motion_generation' });
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      '❌ Помилка генерації Kling Motion. Спробуйте ще раз.'
    );
    userState.delete(userId);
  }
}

// Генерувати Kling відразу
bot.action('kling_generate_now', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userState.get(userId);

  if (!state || state.action !== 'kling_generation') {
    await ctx.reply('❌ Помилка. Почніть заново.');
    return;
  }

  await ctx.reply('🚀 Починаємо генерацію Kling...');
  await generateKlingVideo(ctx, state);
});

// ==================== KLING GENERATION FUNCTION ====================

async function generateKlingVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.video.models.find(m => m.key === 'kling');

  if (!model) {
    await ctx.reply('❌ Модель Kling не знайдена');
    userState.delete(userId);
    return;
  }

  const duration = state.duration || 5;
  const klingCost = state.klingCost || (duration * model.costPerSecond);
  const apiCost = duration * model.apiCostPerSecond;

  if (!(await userBalance.hasTokens(userId, klingCost))) {
    await showInsufficientTokens(ctx, klingCost);
    userState.delete(userId);
    return;
  }

  const hasStartImage = !!state.startImage;
  const hasEndImage = !!state.endImage;

  const statusMsg = await ctx.reply(
    `🎭 <b>Kling v2.5 - Генерація</b>\n\n` +
    `⏱️ Тривалість: ${duration} сек\n` +
    `📐 Пропорції: ${state.aspectRatio || '16:9'}\n` +
    `🖼️ Start image: ${hasStartImage ? 'Так' : 'Ні'}\n` +
    `🎬 End image: ${hasEndImage ? 'Так' : 'Ні'}\n\n` +
    `📝 Промпт: "${state.prompt?.substring(0, 100)}${state.prompt?.length > 100 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти 2-5 хвилин...`,
    { parse_mode: 'HTML' }
  );

  try {
    const result = await replicate.generateVideoWithKling(
      state.prompt,
      state.startImage || null,
      state.endImage || null,
      duration,
      state.aspectRatio || '16:9'
    );

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId, username, action: 'kling_generation', model: model.name,
        prompt: state.prompt, duration: duration
      });
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `❌ Помилка генерації Kling.\n\n${result.error}\n\nСпробуйте ще раз або оберіть іншу модель.`
      );
      userState.delete(userId);
      return;
    }

    await userBalance.deductTokens(userId, klingCost, `${model.name} generation`, {
      modelKey: 'kling', modelName: model.name, apiCost: apiCost,
      prompt: state.prompt, duration: duration,
      hasStartImage: hasStartImage,
      hasEndImage: hasEndImage
    });

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.reply(
      `✅ <b>Kling v2.5 готово!</b>\n\n` +
      `⏱️ Тривалість: ${duration} сек\n` +
      `📐 Пропорції: ${state.aspectRatio || '16:9'}\n` +
      `📝 Промпт: ${state.prompt?.substring(0, 100)}...\n\n` +
      `💰 Витрачено: ${klingCost}⚡`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );

    await ctx.replyWithVideo(
      { url: result.videoUrl },
      {
        caption: `🎭 Kling v2.5\n\n⏱️ ${duration}сек | 📐 ${state.aspectRatio || '16:9'}\n📝 ${state.prompt?.substring(0, 80)}...\n\n💰 Витрачено: ${klingCost}⚡`,
        ...keyboard.createBackButton('video_menu')
      }
    );

    // ✅ Записуємо Trial usage
    recordTrialUsage(userId, 'kling');

    userState.delete(userId);

  } catch (error) {
    console.error('Kling generation failed:', error);
    await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'kling_generation', model: model.name });
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      '❌ Помилка генерації Kling. Спробуйте ще раз.'
    );
    userState.delete(userId);
  }
}

// ==================== VEO GENERATION FUNCTION ====================

async function generateVeoVideo(ctx, state) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.video.models.find(m => m.key === 'veo');

  if (!model) {
    await ctx.reply('❌ Модель Veo не знайдена');
    userState.delete(userId);
    return;
  }

  // Динамічний розрахунок ціни
  const duration = state.duration || 8;
  const generateAudio = state.generateAudio !== false;
  const costPerSec = generateAudio ? model.costPerSecondAudio : model.costPerSecondNoAudio;
  const veoCost = state.veoCost || (duration * costPerSec);
  const apiCostPerSec = generateAudio ? model.apiCostPerSecondAudio : model.apiCostPerSecondNoAudio;
  const apiCost = duration * apiCostPerSec;

  if (!(await userBalance.hasTokens(userId, veoCost))) {
    await showInsufficientTokens(ctx, veoCost);
    userState.delete(userId);
    return;
  }

  const hasStartImage = !!state.startImage;
  const hasReferences = state.references?.length > 0;
  const hasLastFrame = !!state.lastFrame;

  const statusMsg = await ctx.reply(
    `🌟 <b>Google Veo 3.1 - Генерація</b>\n\n` +
    `📐 Пропорції: ${state.aspectRatio}\n` +
    `⏱️ Тривалість: ${duration} сек\n` +
    `🔊 Аудіо: ${generateAudio ? 'Так' : 'Ні'}\n` +
    `🖼️ Стартове зображення: ${hasStartImage ? 'Так' : 'Ні'}\n` +
    `📸 Референсів: ${state.references?.length || 0}\n` +
    `🎬 Last frame: ${hasLastFrame ? 'Так' : 'Ні'}\n\n` +
    `📝 Промпт: "${state.prompt?.substring(0, 100)}${state.prompt?.length > 100 ? '...' : ''}"\n\n` +
    `⏱️ Це може зайняти 2-5 хвилин...`,
    { parse_mode: 'HTML' }
  );

  try {
    const result = await replicate.generateVideoWithVeo(
      state.prompt,
      state.references || [],
      state.lastFrame || null,
      state.aspectRatio,
      duration,
      '', // negative prompt
      state.startImage || null,
      generateAudio
    );

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId, username, action: 'veo_generation', model: model.name,
        prompt: state.prompt, aspectRatio: state.aspectRatio
      });
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `❌ Помилка генерації Veo 3.1.\n\n${result.error}\n\nСпробуйте ще раз або оберіть іншу модель.`
      );
      userState.delete(userId);
      return;
    }

    await userBalance.deductTokens(userId, veoCost, `${model.name} generation`, {
      modelKey: 'veo', modelName: model.name, apiCost: apiCost,
      prompt: state.prompt, aspectRatio: state.aspectRatio,
      duration: duration, generateAudio: generateAudio,
      hasStartImage: hasStartImage,
      references: state.references?.length || 0,
      hasLastFrame: hasLastFrame
    });

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    // Попередження перед відео
    await ctx.reply(
      `✅ <b>Google Veo 3.1 готово!</b>\n\n` +
      `⚠️ <b>ВАЖЛИВО - ЗАВАНТАЖТЕ ОДРАЗУ!</b>\n` +
      `Посилання активне тільки <b>1 ГОДИНУ</b>!\n\n` +
      `📐 Пропорції: ${state.aspectRatio}\n` +
      `⏱️ Тривалість: ${duration} сек\n` +
      `🔊 Аудіо: ${generateAudio ? 'Так' : 'Ні'}\n` +
      `📝 Промпт: ${state.prompt?.substring(0, 100)}...\n\n` +
      `💾 <b>Як зберегти:</b>\n` +
      `1️⃣ Натисніть на відео нижче\n` +
      `2️⃣ Натисніть ⋮ → "Зберегти"\n\n` +
      `💰 Витрачено: ${veoCost}⚡`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );

    await ctx.replyWithVideo(
      { url: result.videoUrl },
      {
        caption: `🌟 Google Veo 3.1\n\n📐 ${state.aspectRatio} | ⏱️ ${duration}сек | ${generateAudio ? '🔊' : '🔇'}\n📝 ${state.prompt?.substring(0, 80)}...\n⏰ Посилання видалиться через 1 годину!\n\n💰 Витрачено: ${veoCost}⚡`,
        ...keyboard.createBackButton('video_menu')
      }
    );

    userState.delete(userId);

  } catch (error) {
    console.error('Veo 3.1 generation failed:', error);
    await adminNotifier.notifyAdmin(bot, error, { userId, username, action: 'veo_generation', model: model.name });
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      '❌ Помилка генерації Veo 3.1. Спробуйте ще раз.'
    );
    userState.delete(userId);
  }
}

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
  await ctx.reply('🎙️ Аудіо з AI\n\nВиберіть розділ для роботи з аудіо 👇', keyboard.createInlineMenu(models.audio.models, 2));
});

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🏠 Головне меню', keyboard.createMainMenu());
});

bot.action('design_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🎨 Дизайн з AI\n\nВиберіть розділ для роботи з зображенням 👇', keyboard.createInlineMenu(models.design.models, 1));
});

bot.action('video_menu', async (ctx) => {
  await ctx.answerCbQuery();
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

  // Розраховуємо ціну за токен та економію
  const pricePerToken = sub.priceUSD / sub.tokens;
  const starterPricePerToken = 7 / 220; // базова ціна STARTER
  const savingsPercent = Math.round((1 - pricePerToken / starterPricePerToken) * 100);

  // Короткий опис пакету в доларах
  let message = `⚡ <b>Пакет ${sub.name}</b> — $${sub.priceUSD}\n\n`;
  message += `💎 Доступ до всіх моделей\n`;
  message += `⏰ Токени НЕ згорають\n`;
  message += `✨ Комбінуйте як завгодно!\n\n`;

  // Показуємо економію для пакетів більших за STARTER
  if (savingsPercent > 0) {
    message += `🔥 <b>Економія ${savingsPercent}%</b> порівняно зі STARTER!\n\n`;
  }

  message += `💰 <b>Вартість:</b> $${sub.priceUSD} — ${sub.tokensLiqPay || sub.tokens}⚡ токенів\n`;
  message += `📊 <b>Ціна за токен:</b> $${pricePerToken.toFixed(4)}\n\n`;
  message += `<i>Також можна розрахуватись Telegram Stars:</i>\n`;
  message += `⭐ ${sub.price}⭐ — ${sub.tokens}⚡ токенів\n\n`;
  message += `💡 <i>Чим більший пакет — тим вигідніше!</i>\n\n`;
  message += `📱 Оберіть спосіб оплати 👇`;

  await ctx.reply(message, { parse_mode: 'HTML', ...keyboard.createPaymentMenu(sub.price, planKey, userId, telegramId) });
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
  const state = userState.get(userId);
  let text = ctx.message.text;  // let - бо може змінитись при накопиченні довгого промпту

  if (text.startsWith('/')) return;

  // ✅ VEO: Обробка промпту
  if (state?.action === 'veo_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Промпт занадто короткий!\n\n' +
        'Напишіть детальніше що хочете бачити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    // Зберігаємо промпт і питаємо про стартове зображення
    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ask_start_image'
    });

    const model = models.video.models.find(m => m.key === 'veo');
    const idealSize = state.aspectRatio === '16:9' ? '1280×720' : '720×1280';

    // Питаємо про стартове зображення (працює для обох пропорцій)
    await ctx.reply(
      `✅ <b>Промпт збережено!</b>\n\n` +
      `📝 "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"\n\n` +
      `🖼️ <b>Крок 3: Стартове зображення (опціонально)</b>\n\n` +
      `<b>Що це:</b> Зображення яке стане першим кадром відео.\n` +
      `AI анімує його згідно з промптом.\n\n` +
      `<b>🎯 Приклади:</b>\n` +
      `• Фото людини → відео де вона рухається\n` +
      `• Пейзаж → камера летить над ним\n` +
      `• Продукт → обертання 360°\n\n` +
      `💡 Ідеальний розмір: ${idealSize}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🖼️ Завантажу зображення', 'veo_add_start_image')],
          [Markup.button.callback('⏭️ Без зображення (text-to-video)', 'veo_skip_start_image')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING: Обробка промпту
  if (state?.action === 'kling_generation' && state?.step === 'waiting_prompt') {
    if (!text || text.length < 5) {
      await ctx.reply(
        '⚠️ Промпт занадто короткий!\n\n' +
        'Напишіть детальніше що хочете бачити у відео (мінімум 5 символів).',
        keyboard.createBackButton('video_menu')
      );
      return;
    }

    // Зберігаємо промпт і генеруємо
    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію Kling...');
    await generateKlingVideo(ctx, { ...state, prompt: text });
    return;
  }

  // ✅ KLING MOTION: Обробка промпту (опціонально)
  if (state?.action === 'kling_motion_generation' && state?.step === 'ask_prompt') {
    // Зберігаємо промпт і генеруємо
    userState.set(userId, {
      ...state,
      prompt: text,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Промпт збережено! Починаємо генерацію Kling Motion...');
    await generateKlingMotionVideo(ctx, { ...state, prompt: text });
    return;
  }

  if (!currentModel) {
    await ctx.reply('Будь ласка, спочатку виберіть модель з меню 👇', keyboard.createMainMenu());
    return;
  }
  
  if (currentModel === 'clarity') {
    await ctx.reply('🔮 Clarity Upscaler чекає на зображення.\n\nНадішліть фото для покращення якості.', keyboard.createGPTActionsMenu(models.design.models));
    return;
  }

  // ✅ KLING MOTION: якщо модель обрана але флоу не розпочато
  if (currentModel === 'kling_motion') {
    const motionState = userState.get(userId);

    // Якщо є активний флоу - перевіряємо на якому кроці
    if (motionState?.action === 'kling_motion_generation') {
      if (motionState.step === 'waiting_image') {
        await ctx.reply(
          '📷 <b>Очікується ФОТО персонажа, а не текст!</b>\n\n' +
          '👉 Надішліть фото персонажа.',
          { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
        );
        return;
      }
      if (motionState.step === 'waiting_video') {
        await ctx.reply(
          '🎥 <b>Очікується ВІДЕО з рухами, а не текст!</b>\n\n' +
          '👉 Надішліть відео файл з рухами.',
          { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
        );
        return;
      }
      // Якщо step = ask_prompt - текст обробиться в KLING MOTION обробнику вище
    } else {
      // Флоу не розпочато - направляємо в меню
      await ctx.reply(
        '🔥 <b>Kling Motion Control</b>\n\n' +
        '⚠️ Спочатку налаштуйте параметри!\n\n' +
        'Натисніть кнопку Kling Motion в меню відео.',
        { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
      );
      return;
    }
  }

  // ✅ VEO: якщо модель veo але немає стану - показуємо що треба обрати aspect ratio
  if (currentModel === 'veo' && !state?.action) {
    await ctx.reply(
      '🌟 <b>Google Veo 3.1</b>\n\n' +
      '⚠️ Спочатку оберіть пропорції відео!\n\n' +
      'Натисніть на кнопку Veo в меню відео.',
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ ДОВГІ ПРОМПТИ: накопичення через "..." в кінці
  // ВАЖЛИВО: перевіряємо що currentModel існує і підтримує довгі промпти
  if (currentModel && MODELS_WITH_LONG_PROMPTS.includes(currentModel)) {
    const pending = pendingPrompts.get(userId);
    const continuePrompt = text.trim().endsWith('...');

    if (continuePrompt) {
      // Користувач хоче продовжити - накопичуємо
      const cleanText = text.trim().slice(0, -3); // Прибираємо "..."
      const accumulated = pending ? pending.prompt + '\n' + cleanText : cleanText;

      pendingPrompts.set(userId, {
        prompt: accumulated,
        model: currentModel
      });

      const charCount = accumulated.length;
      await ctx.reply(
        `📝 <b>Промпт накопичено</b>\n\n` +
        `📊 Символів: <b>${charCount}</b>\n` +
        `🔄 Продовжуйте надсилати текст з <code>...</code> в кінці\n\n` +
        `✅ Коли готово - надішліть останню частину <b>БЕЗ</b> трьох крапок\n\n` +
        `💡 Або надішліть <code>/clear</code> щоб очистити`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Готово - об'єднуємо якщо є накопичене
    if (pending) {
      text = pending.prompt + '\n' + text.trim();
      pendingPrompts.delete(userId);
      console.log(`📝 Long prompt assembled: ${text.length} chars for ${currentModel}`);
    }
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
  const state = userState.get(userId);

  // Debug log
  console.log(`📸 Photo received from user ${userId}:`, {
    currentModel,
    stateAction: state?.action,
    stateStep: state?.step,
    hasState: !!state
  });

  // ✅ VEO: Обробка стартового зображення (image-to-video)
  if (state?.action === 'veo_generation' && state?.step === 'waiting_start_image') {
    console.log(`✅ Processing VEO start image for user ${userId}`);
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      startImage: imageUrl,
      step: 'ask_references_after_start'
    });

    // Для 16:9 - питаємо про референси
    if (state.aspectRatio === '16:9') {
      await ctx.reply(
        `✅ <b>Стартове зображення завантажено!</b>\n\n` +
        `📸 <b>Референс-зображення (опціонально)</b>\n\n` +
        `Референси допомагають AI зберегти консистентність персонажів.\n\n` +
        `📌 Можна завантажити до 3 зображень`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📸 Додати референси (до 3)', 'veo_add_references')],
            [Markup.button.callback('⏭️ Без референсів → генерувати', 'veo_generate_now')],
            [Markup.button.callback('← Назад', 'video_menu')]
          ])
        }
      );
    } else {
      // Для 9:16 - референси не працюють, питаємо про last_frame
      await ctx.reply(
        `✅ <b>Стартове зображення завантажено!</b>\n\n` +
        `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
        `Зображення для кінця відео - AI створить плавний перехід.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📷 Завантажу last frame', 'veo_add_last_frame')],
            [Markup.button.callback('⏭️ Генерувати без', 'veo_generate_now')],
            [Markup.button.callback('← Назад', 'video_menu')]
          ])
        }
      );
    }
    return;
  }

  // ✅ VEO: Обробка референс-зображень
  if (state?.action === 'veo_generation' && state?.step === 'waiting_references') {
    const imageUrl = await getImageUrl(ctx);
    const currentRefs = state.references || [];

    if (currentRefs.length >= 3) {
      await ctx.reply(
        '⚠️ Максимум 3 референс-зображення!\n\n' +
        'Натисніть "✅ Готово" щоб продовжити.',
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Готово', 'veo_references_done')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      );
      return;
    }

    currentRefs.push(imageUrl);
    userState.set(userId, {
      ...state,
      references: currentRefs
    });

    await ctx.reply(
      `✅ Референс ${currentRefs.length}/3 завантажено!\n\n` +
      (currentRefs.length < 3
        ? `📤 Надішліть ще ${3 - currentRefs.length} фото або натисніть "✅ Готово"`
        : `📸 Досягнуто максимум. Натисніть "✅ Готово"`),
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Готово', 'veo_references_done')],
        [Markup.button.callback('← Назад', 'video_menu')]
      ])
    );
    return;
  }

  // ✅ VEO: Обробка last_frame
  if (state?.action === 'veo_generation' && state?.step === 'waiting_last_frame') {
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      lastFrame: imageUrl,
      step: 'ready_to_generate'
    });

    await ctx.reply('🚀 Last frame отримано! Починаємо генерацію...');
    await generateVeoVideo(ctx, { ...state, lastFrame: imageUrl });
    return;
  }

  // ✅ KLING: Обробка стартового зображення
  if (state?.action === 'kling_generation' && state?.step === 'waiting_start_image') {
    console.log(`✅ Processing Kling start image for user ${userId}`);
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      startImage: imageUrl,
      step: 'ask_end_image'
    });

    await ctx.reply(
      `✅ <b>Стартове зображення завантажено!</b>\n\n` +
      `🎬 <b>Останній кадр (опціонально)</b>\n\n` +
      `Зображення для кінця відео - AI створить плавний перехід.\n\n` +
      `<b>🎯 Приклад:</b>\n` +
      `• Початок: людина стоїть\n` +
      `• Кінець: людина сидить\n` +
      `• Результат: анімація присідання`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📷 Завантажу end_image', 'kling_add_end_image')],
          [Markup.button.callback('⏭️ Перейти до промпту', 'kling_skip_end_image')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // ✅ KLING: Обробка end_image
  if (state?.action === 'kling_generation' && state?.step === 'waiting_end_image') {
    console.log(`✅ Processing Kling end image for user ${userId}`);
    const imageUrl = await getImageUrl(ctx);

    userState.set(userId, {
      ...state,
      endImage: imageUrl,
      step: 'waiting_prompt'
    });

    await ctx.reply(
      `✅ <b>End image завантажено!</b>\n\n` +
      `🎭 <b>Kling v2.5 Turbo Pro</b>\n\n` +
      `⏱️ Тривалість: <b>${state.duration} сек</b>\n` +
      `📐 Пропорції: <b>${state.aspectRatio}</b>\n` +
      `🖼️ Start image: <b>Так</b>\n` +
      `🎬 End image: <b>Так</b>\n` +
      `💰 Вартість: <b>${state.klingCost}⚡</b>\n\n` +
      `📝 <b>Напишіть промпт</b>\n\n` +
      `Опишіть рух/перехід між початковим та кінцевим кадром.\n\n` +
      `✍️ <b>Надішліть текстовий промпт:</b>`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ KLING MOTION: Обробка фото персонажа
  if (state?.action === 'kling_motion_generation' && state?.step === 'waiting_image') {
    console.log(`✅ Processing Kling Motion image for user ${userId}`);
    const imageUrl = await getImageUrl(ctx);

    const maxDuration = state.orientation === 'image' ? 10 : 30;

    userState.set(userId, {
      ...state,
      imageUrl: imageUrl,
      step: 'waiting_video'
    });

    await ctx.reply(
      `✅ <b>Фото персонажа завантажено!</b>\n\n` +
      `🔥 <b>Kling Motion Control</b>\n\n` +
      `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
      `🎭 Орієнтація: <b>${state.orientation === 'image' ? '📷 Image' : '🎥 Video'}</b>\n` +
      `⏱️ Макс: <b>${maxDuration} сек</b>\n` +
      `💰 Вартість: <b>${state.motionCost}⚡</b>\n\n` +
      `🎥 <b>Крок 5: Надішліть ВІДЕО з рухами</b>\n\n` +
      `Це відео з референсними рухами які AI перенесе на персонажа.\n\n` +
      `⏱️ Тривалість відео: до ${maxDuration} секунд\n` +
      `📁 Формат: MP4, MOV\n\n` +
      `📤 <b>Надішліть відео файл:</b>`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );
    return;
  }

  // ✅ Перевірити чи користувач вибрав модель
  if (!currentModel) {
    await ctx.reply(
      '❌ Спочатку виберіть модель для обробки фото.\n\n' +
      '🎨 Оберіть один з розділів:',
      keyboard.createInlineMenu(models.design.models, 1)
    );
    return;
  }

  // ✅ Спеціальний випадок: користувач обрав "🖼️ Завантажте зображення для аналізу" з гідлінгу Claude
  if (currentModel === 'image') {
    console.log(`🖼️ Image analysis mode selected, redirecting to Claude vision`);
    await handleClaudeVision(ctx);
    return;
  }

  // ✅ Спеціальний випадок: користувач обрав "💌 День Закоханих" креатив
  if (currentModel === 'love_is') {
    console.log(`💌 Love is... creative selected, handling creative photo`);
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  if (state?.creative && state?.step === 'waiting_photo') {
    const imageUrl = await getImageUrl(ctx);
    const handled = await handleCreativePhoto(ctx, imageUrl);
    if (handled) return;
  }

  const mediaGroupId = ctx.message.media_group_id;

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

  // ✅ Перевіряємо чи є накопичений промпт для довгих промптів
  const pendingPrompt = pendingPrompts.get(userId);
  let prompt = ctx.message.caption || '';

  if (pendingPrompt && MODELS_WITH_LONG_PROMPTS.includes(currentModel)) {
    // Використовуємо накопичений промпт + caption якщо є
    prompt = prompt ? pendingPrompt.prompt + '\n' + prompt : pendingPrompt.prompt;
    pendingPrompts.delete(userId);
    console.log(`📝 Using accumulated prompt for photo: ${prompt.length} chars`);
  }

  // Якщо промпт пустий - використовуємо дефолтний
  if (!prompt) {
    prompt = 'transform this image, masterpiece quality, highly detailed';
  }

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

  // ✅ KLING MOTION: Обробка референсного відео
  if (state?.action === 'kling_motion_generation' && state?.step === 'waiting_video' && state?.imageUrl) {
    const model = models.video.models.find(m => m.key === 'kling_motion');
    const motionCost = state.motionCost;

    if (!(await userBalance.hasTokens(userId, motionCost))) {
      await showInsufficientTokens(ctx, motionCost);
      userState.delete(userId);
      return;
    }

    const videoFile = ctx.message.video;
    const videoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${(await ctx.telegram.getFile(videoFile.file_id)).file_path}`;

    userState.set(userId, {
      ...state,
      videoUrl: videoUrl,
      step: 'ask_prompt'
    });

    const maxDuration = state.orientation === 'image' ? 10 : 30;

    await ctx.reply(
      `✅ <b>Відео з рухами завантажено!</b>\n\n` +
      `🔥 <b>Kling Motion Control</b>\n\n` +
      `⚙️ Режим: <b>${state.mode === 'pro' ? '💎 PRO' : '⚡ STD'}</b>\n` +
      `🎭 Орієнтація: <b>${state.orientation === 'image' ? '📷 Image' : '🎥 Video'}</b>\n` +
      `📷 Фото: ✅\n` +
      `🎥 Відео: ✅\n` +
      `💰 Вартість: <b>${motionCost}⚡</b>\n\n` +
      `📝 <b>Крок 6: Промпт (опціонально)</b>\n\n` +
      `Опишіть додаткові деталі або натисніть "Генерувати".`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚀 Генерувати без промпту', 'motion_generate_now')],
          [Markup.button.callback('← Назад', 'video_menu')]
        ])
      }
    );
    return;
  }

  // Якщо відео не для Kling Motion - показуємо інструкцію
  await ctx.reply(
    '⚠️ Для використання відео:\n\n' +
    '1. Виберіть модель 🔥 Kling Motion Control\n' +
    '2. Оберіть режим та налаштування\n' +
    '3. Надішліть фото персонажа\n' +
    '4. Надішліть відео з рухами\n\n' +
    'Або оберіть іншу модель для генерації відео 👇',
    keyboard.createBackButton('video_menu')
  );
});

// ==================== UNIFIED HANDLERS ====================

async function handleMediaGroup(ctx, group) {
  const { photos, caption, currentModel, userId } = group;
  const model = models.design.models.find(m => m.key === currentModel);

  // ✅ Перевірити чи модель знайдена
  if (!model) {
    console.error(`❌ Model not found in handleMediaGroup: ${currentModel}`);
    await ctx.reply('❌ Модель не знайдена. Спробуйте ще раз.');
    return;
  }

  // ✅ Перевіряємо чи є накопичений промпт
  const pendingPrompt = pendingPrompts.get(userId);
  let finalPrompt = caption || '';

  if (pendingPrompt && MODELS_WITH_LONG_PROMPTS.includes(currentModel)) {
    finalPrompt = finalPrompt ? pendingPrompt.prompt + '\n' + finalPrompt : pendingPrompt.prompt;
    pendingPrompts.delete(userId);
    console.log(`📝 Using accumulated prompt for album: ${finalPrompt.length} chars`);
  }

  if (!finalPrompt) {
    finalPrompt = 'transform these images, masterpiece quality, highly detailed';
  }

  // ✅ Перевірити чи модель підтримує багато зображень
  if (model.maxImages && model.maxImages > 1) {
    // ✅ ЯК ЩО ЦЕ МОДЕЛЬ З ASPECT RATIO - ПОКАЗИТИ МЕНЮ ВИБОРУ
    if (MODELS_WITH_ASPECT_RATIO.includes(currentModel)) {
      // Зберігаємо дані для подальшої генерації
      userState.set(userId, {
        model: currentModel,
        step: 'waiting_aspect_ratio',
        imageUrl: photos, // передаємо масив фото
        prompt: finalPrompt
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
      await handleImageGeneration(ctx, finalPrompt, currentModel, photos);
    }
  } else {
    await ctx.reply(
      `📸 Отримано ${photos.length} фото.\n\n` +
      `⚠️ ${model?.name || 'Ця модель'} підтримує тільки 1 зображення.\n` +
      `Обробляю перше фото...`
    );
    await handleImageGeneration(ctx, finalPrompt, currentModel, photos[0]);
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

  // ✅ Перевіримо чи модель знайдена
  if (!model) {
    console.error(`❌ Model not found: ${modelKey}`);
    await ctx.reply('❌ Модель не знайдена. Спробуйте ще раз.');
    return;
  }

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

    // ✅ Записуємо Trial usage для лімітованих моделей
    if (TRIAL_RESTRICTIONS.limitedModels[modelKey]) {
      recordTrialUsage(userId, modelKey);
    }

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
        `💡 <b>⚠️ ВАЖЛИВО - ЗАВАНТАЖТЕ ОДРАЗУ!</b>\n` +
        `Посилання активне тільки <b>1 ГОДИНУ</b>!\n` +
        `Після цього файл буде видалений.\n\n` +
        `📥 <b>Як завантажити:</b>\n` +
        `1️⃣ Натисніть на посилання вище\n` +
        `2️⃣ Файл завантажиться\n` +
        `3️⃣ Збережіть на телефон/комп'ютер\n\n` +
        `💾 <b>Порада:</b> Завжди зберігайте генерації одразу, щоб не втратити!\n\n` +
        `💰 Витрачено: ${model.cost}⚡`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...keyboard.createBackButton('design_menu')
        }
      );
      
    } else {
      // 📷 Надіслати як фото (<10MB) - Telegram збереже на своїх серверах
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {
        console.warn('Could not delete status message:', e.message);
      }

      await ctx.replyWithPhoto({ url: result.imageUrl }, {
        caption: `${model.name} (${mode})\n\n📝 Промпт: ${prompt.substring(0, 800)}${prompt.length > 800 ? '...' : ''}\n\n💰 Витрачено: ${model.cost}⚡`,
        parse_mode: 'HTML',
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

    // ✅ Надіслати попередження ПЕРЕД видео
    await ctx.reply(
      `✅ <b>${model.name} готово!</b>\n\n` +
      `⚠️ <b>ВАЖЛИВО - ЗАВАНТАЖТЕ ОДРАЗУ!</b>\n` +
      `Посилання на відео активне тільки <b>1 ГОДИНУ</b>!\n\n` +
      `📝 Промпт: ${prompt}\n\n` +
      `💾 <b>ЗБЕРЕЖІТЬ на пристрій перед закриттям:</b>\n` +
      `1️⃣ Натисніть на відео (☝️ див. нижче)\n` +
      `2️⃣ Натисніть меню ⋮\n` +
      `3️⃣ Оберіть "Зберегти" або "Завантажити"\n\n` +
      `💰 Витрачено: ${model.cost}⚡`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('video_menu') }
    );

    await ctx.replyWithVideo({ url: result.videoUrl }, {
      caption: `${model.name}\n\n📝 Промпт: ${prompt}\n⏰ Посилання видалиться через 1 годину!\n\n💰 Витрачено: ${model.cost}⚡`,
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
        caption: `✅ Готово!\n\nPrompt: ${prompt}\n⏰ Посилання видалиться через 1 годину!\n\n💰 Використано: ${model.cost}⚡\n💰 Залишок: ${user.tokens.toFixed(2)}⚡`,
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
      caption: `🔮 Clarity Upscaler\n\n📝 Промпт: ${prompt}\n⏰ Посилання видалиться через 1 годину!\n\n💰 Витрачено: ${model.cost}⚡`,
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

    // ✅ Попередження про видалення ПЕРЕД аудіо
    await ctx.reply(
      `✅ <b>Аудіо готово!</b>\n\n` +
      `⚠️ <b>ЗАВАНТАЖТЕ ОДРАЗУ!</b>\n` +
      `Посилання активне тільки <b>1 ГОДИНУ</b>!\n\n` +
      `📝 Текст: "${text}"\n\n` +
      `💾 <b>Як зберегти аудіо:</b>\n` +
      `1️⃣ Натисніть на аудіо (☝️ див. нижче)\n` +
      `2️⃣ Натисніть меню ⋮\n` +
      `3️⃣ Оберіть "Зберегти" або "Завантажити"\n\n` +
      `💰 Витрачено: ${model.cost}⚡`,
      { parse_mode: 'HTML', ...keyboard.createBackButton('audio_menu') }
    );

    await ctx.replyWithAudio({ url: result.audioUrl }, {
      caption: `🎵 Suno AI Bark\n\n📝 Текст: ${text}\n⏰ Видалиться через 1 годину!\n\n💰 Витрачено: ${model.cost}⚡`,
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

    // ⚠️ ВАЖЛИВО: WayForPay webhook - потрібен спеціальний parser для raw JSON!
    // WayForPay надсилає raw JSON без правильного Content-Type header
    app.post('/webhook/wayforpay', express.raw({ type: '*/*' }), (req, res, next) => {
        try {
            let data;

            if (typeof req.body === 'string') {
                // Raw JSON string
                console.log('📥 Parsing raw JSON from WayForPay...');
                data = JSON.parse(req.body);
            } else if (Buffer.isBuffer(req.body)) {
                // Buffer - конвертуємо в string
                console.log('📥 Parsing Buffer from WayForPay...');
                data = JSON.parse(req.body.toString('utf8'));
            } else if (typeof req.body === 'object') {
                // Об'єкт - використовуємо як є
                data = req.body;
            } else {
                console.error('❌ Unexpected body type:', typeof req.body);
                return res.status(400).json({ error: 'Invalid request body' });
            }

            console.log('✅ WayForPay webhook body parsed successfully');
            req.body = data;
            next();
        } catch (error) {
            console.error('❌ Failed to parse WayForPay webhook:', error.message);
            res.status(400).json({ error: 'Invalid JSON' });
        }
    });

    // ✅ Стандартні body parsers для інших маршрутів
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

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

    // Webhook для WayForPay (передаємо bot instance для відправки повідомлень)
    const createWayForPayRouter = require('./webhooks/wayforpay');
    const wayforpayWebhook = createWayForPayRouter(bot);
    app.use('/webhook', wayforpayWebhook);


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
      const { userId, plan } = req.body;
      const liqpay = require('./services/liqpay');

      console.log(`📋 LiqPay checkout request:`, { userId, plan });

      if (!userId || !plan) {
        console.error('❌ Missing required fields:', { userId, plan });
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: userId, plan'
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
        // ✅ Отримуємо з плану, НЕ з клієнтського payload!
        const tokenCount = sub.tokensLiqPay || sub.tokens;

        console.log(`📊 LiqPay pricing: priceUSD=${sub.priceUSD}, rate=${rate.toFixed(2)}, amountUAH=${amountUAH}, tokens=${tokenCount}`);

        // Генеруємо унікальний ID замовлення: userId_planKey_timestamp
        const orderId = `${userId}_${plan}_${Date.now()}`;

        // Параметри платежу для LiqPay
        const checkoutParams = {
          order_id: orderId,
          amount: amountUAH,
          currency: 'UAH',
          description: `neuro.lab.ai - ${plan} (${tokenCount}⚡)`,
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

    // ✅ WayForPay checkout page
    app.get('/pay/wayforpay', (req, res) => {
      const plan = req.query.plan;

      console.log(`📄 WayForPay checkout page requested: plan=${plan}`);

      if (!plan) {
        return res.status(400).send('План не обрано');
      }

      const filePath = __dirname + '/public/wayforpay-checkout.html';
      console.log(`📂 Sending file: ${filePath}`);
      res.sendFile(filePath);
    });

    // ✅ WayForPay checkout API
    app.post('/api/wayforpay/checkout', async (req, res) => {
      const { userId, plan } = req.body;
      const wayforpay = require('./services/wayforpay');

      console.log(`📋 WayForPay checkout request:`, { userId, plan });

      if (!userId || !plan) {
        console.error('❌ Missing required fields:', { userId, plan });
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: userId, plan'
        });
      }

      try {
        // Перевіримо чи є такий план
        const sub = models.subscriptions[plan];
        if (!sub) {
          return res.status(400).json({
            success: false,
            error: 'Invalid plan'
          });
        }

        // Отримуємо кількість токенів з плану (не з клієнтського payload!)
        const tokens = sub.tokensLiqPay || sub.tokens;

        // Отримуємо реальну ціну в UAH
        const rate = await exchangeRate.getRate();
        const amount = Math.round(sub.priceUSD * rate);

        // Генеруємо унікальний ID замовлення: userId_planKey_timestamp
        const orderReference = `${userId}_${plan}_${Date.now()}`;

        // Параметри платежу для WayForPay
        const checkoutParams = {
          order_id: orderReference,
          amount: amount,
          currency: 'UAH',
          description: `neuro.lab.ai - ${plan} (${tokens}⚡)`,
          result_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/payment/success?order_id=${orderReference}`,
          decline_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/payment/failed?order_id=${orderReference}`,
          server_url: `${process.env.APP_URL || 'http://127.0.0.1:5500'}/webhook/wayforpay`
        };

        const checkout = await wayforpay.createCheckout(checkoutParams);

        console.log(`✅ WayForPay checkout created for user ${userId}: order_id=${orderReference}`);

        res.json({
          success: true,
          checkoutUrl: checkout.checkoutUrl,
          params: checkout.params,
          orderId: orderReference
        });
      } catch (error) {
        console.error('❌ WayForPay checkout error:', error);
        res.status(400).json({
          success: false,
          error: error.message
        });
      }
    });

    // ✅ Verify WayForPay payment status
    app.get('/api/payment/verify/:orderId', async (req, res) => {
      const { orderId } = req.params;

      try {
        console.log(`🔍 Verifying payment status for order: ${orderId}`);

        // Перевіряємо чи платіж вже обробленый
        const Transaction = require('./database/models/Transaction');

        if (!Transaction) {
          // Якщо модель не існує, повертаємо успіх (webhook обробить)
          return res.json({ success: true, status: 'pending' });
        }

        const transaction = await Transaction.findOne({
          'metadata.orderId': orderId
        });

        if (transaction) {
          console.log(`✅ Payment found in database:`, {
            status: transaction.type,
            orderId
          });
          return res.json({
            success: true,
            status: 'completed',
            transaction: transaction
          });
        }

        // Платіж не знайдено - можливо він відхилено
        console.log(`⚠️ Payment not found in database:`, orderId);
        res.json({
          success: false,
          status: 'failed',
          message: 'Payment not found'
        });
      } catch (error) {
        console.error('❌ Payment verification error:', error);
        res.json({ success: false, status: 'error', error: error.message });
      }
    });

    // ✅ Manual payment processing for WayForPay (fallback when webhook fails)
    app.post('/api/payment/process-wayforpay/:orderId', async (req, res) => {
      const { orderId } = req.params;

      try {
        console.log(`🔄 Manual processing WayForPay payment: ${orderId}`);

        // Парсимо order_id: userId_plan_timestamp
        const parts = orderId.split('_');
        const userId = parseInt(parts[0]);
        const plan = parts[1];

        console.log(`📊 Parsed order: userId=${userId}, plan=${plan}, parts=${JSON.stringify(parts)}`);

        if (!userId || !plan) {
          console.error(`❌ Invalid order format: userId=${userId}, plan=${plan}`);
          return res.json({
            success: false,
            error: 'Invalid order format'
          });
        }

        // Отримуємо інформацію про план
        const sub = models.subscriptions[plan];
        if (!sub) {
          console.error(`❌ Invalid plan: ${plan}`);
          return res.json({
            success: false,
            error: 'Invalid plan'
          });
        }

        console.log(`✅ Plan found: ${sub.name}`);

        // Перевіряємо чи вже оброблено
        const Transaction = require('./database/models/Transaction');
        const existing = await Transaction.findOne({
          'metadata.orderId': orderId,
          type: 'wayforpay_purchase'
        });

        if (existing) {
          console.log(`⚠️ Order ${orderId} already processed`);
          return res.json({
            success: true,
            message: 'Already processed',
            tokens: existing.amount
          });
        }

        // ⚠️ СПРОБУЄМО перевірити статус через CHECK_STATUS API
        console.log(`🔍 Attempting to check payment status via WayForPay API...`);

        let paymentStatus = null;
        try {
          const wayforpay = require('./services/wayforpay');
          paymentStatus = await wayforpay.checkPaymentStatus(orderId);

          console.log(`📊 CHECK_STATUS response:`, paymentStatus);

          // ✅ WayForPay може повертати 'Approved' або 'Completed' для успішних платежів
          if (paymentStatus && (paymentStatus.transactionStatus === 'Approved' || paymentStatus.transactionStatus === 'Completed')) {
            console.log(`✅ Payment is COMPLETED! Processing immediately...`);

            const tokens = sub.tokensLiqPay || sub.tokens;

            // Нараховуємо токени
            await userBalance.addTokens(
              userId,
              tokens,
              'wayforpay_purchase',
              {
                plan: sub.name,
                planKey: plan,
                orderId: orderId,
                processedAt: new Date()
              }
            );

            console.log(`✅ +${tokens}⚡ added to user ${userId}`);

            // Отримуємо користувача для відправки повідомлення
            const user = await userBalance.getUser(userId, { id: userId });

            // Відправляємо повідомлення про успіх
            if (bot) {
              try {
                await bot.telegram.sendMessage(
                  userId,
                  `✅ <b>Оплату отримано!</b>\n\n` +
                  `💳 Метод: WayForPay\n` +
                  `💎 Тариф: ${sub.name}\n` +
                  `⚡ Токенів нараховано: ${tokens}\n` +
                  `💰 Новий баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
                  `Дякуємо за покупку! 🎉`,
                  { parse_mode: 'HTML' }
                );
                console.log(`📨 Success message sent to user ${userId}`);
              } catch (err) {
                console.error('Error sending success message:', err.message);
              }
            }

            return res.json({
              success: true,
              message: 'Payment processed successfully',
              status: 'completed',
              tokens: tokens,
              balance: user.tokens
            });
          }
        } catch (checkError) {
          console.log(`⚠️ Could not check payment status via API: ${checkError.message}`);
          console.log(`💡 Will wait for webhook to process payment`);
        }

        // ⚠️ Якщо CHECK_STATUS не спрацював або статус невідомий - вважаємо платіж очікуючим
        // Webhook обробить платіж коли він буде активний.

        console.log(`📝 Payment is PENDING (waiting for webhook from WayForPay)`);
        console.log(`💡 On PRODUCTION: Webhook from WayForPay will process this payment`);
        console.log(`💡 On LOCAL: Payment stays pending until webhook is manually triggered`);

        // Повідомляємо користувача що платіж очікується
        if (bot) {
          try {
            await bot.telegram.sendMessage(
              userId,
              `⏳ <b>Платіж очікується на обробку</b>\n\n` +
              `💳 Метод: WayForPay\n` +
              `💎 Тариф: ${sub.name}\n` +
              `💰 Сума: 4 UAH\n` +
              `⏳ Статус: Перевірка безпеки\n\n` +
              `Ваш платіж проходить перевірку у фахівців з безпеки WayForPay.\n` +
              `Токени будуть додані коли платіж буде підтверджений (зазвичай протягом кількох хвилин).\n\n` +
              `Замовлення: ${orderId}`,
              { parse_mode: 'HTML' }
            );
            console.log(`📨 Pending message sent to user ${userId}`);
          } catch (err) {
            console.error('Error sending message:', err.message);
          }
        }

        // Повертаємо успіх - платіж ще не оброблений, але очікується webhook
        res.json({
          success: true,
          message: 'Payment is pending webhook confirmation',
          status: 'pending',
          tokens: 0  // Поки не додано, бо платіж ще не підтверджений
        });

      } catch (error) {
        console.error('❌ Manual payment processing error:', error);
        res.status(500).json({
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

        // Ціна 1 токена в USD (STARTER план - найгірший випадок)
        const tokenPriceUSD = 7 / 260; // ≈ $0.0269

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

        // Моделі для comparison таблиць
        const designModels = models.design.models
          .filter(m => m.available)
          .map(m => ({
            name: m.name.replace(/[🌀🍌🌊🔮🎯🖼️]/g, '').trim(),
            key: m.key,
            cost: m.cost,
            priceUSD: +(m.cost * tokenPriceUSD).toFixed(3)
          }));

        const videoModels = models.video.models
          .filter(m => m.available)
          .map(m => {
            const result = {
              name: m.name.replace(/[🎭🔥🌟🎬🌊💜💎]/g, '').trim(),
              key: m.key
            };
            if (m.costPerSecond) {
              result.costPerSecond = m.costPerSecond;
              result.pricePerSecondUSD = +(m.costPerSecond * tokenPriceUSD).toFixed(3);
            } else if (m.costs) {
              result.costs = m.costs;
            } else if (m.costPerSecondAudio) {
              result.costPerSecondAudio = m.costPerSecondAudio;
              result.costPerSecondNoAudio = m.costPerSecondNoAudio;
              result.pricePerSecondAudioUSD = +(m.costPerSecondAudio * tokenPriceUSD).toFixed(3);
              result.pricePerSecondNoAudioUSD = +(m.costPerSecondNoAudio * tokenPriceUSD).toFixed(3);
            } else {
              result.cost = m.cost;
              result.priceUSD = +(m.cost * tokenPriceUSD).toFixed(2);
            }
            return result;
          });

        const totalTime = Date.now() - startTime;
        console.log(`📊 /api/plans response time: ${totalTime}ms (rate fetch: ${fetchTime}ms)`);

        res.json({
          success: true,
          plans,
          // Додаємо ціни моделей для comparison
          models: {
            tokenPriceUSD: +tokenPriceUSD.toFixed(4),
            design: designModels,
            video: videoModels
          },
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

    // ✅ Get all models with prices (for comparison tables, webpack site, etc.)
    app.get('/api/models', async (req, res) => {
      try {
        // Ціна 1 токена в USD (найгірший випадок - STARTER план)
        // STARTER: $7 за 260 токенів LiqPay
        const tokenPriceUSD = 7 / 260; // ≈ $0.0269 за токен

        res.json({
          success: true,

          // Формула для розрахунку ціни в USD: cost * tokenPriceUSD
          pricing: {
            tokenPriceUSD: tokenPriceUSD,
            formula: 'priceUSD = cost * tokenPriceUSD',
            note: 'Ціна розрахована за STARTER планом ($7/260⚡). Більші плани дешевші за токен.'
          },

          // Пакети токенів
          subscriptions: Object.entries(models.subscriptions)
            .filter(([key]) => key !== 'trial')
            .reduce((acc, [key, sub]) => {
              acc[key] = {
                name: sub.name,
                tokens: sub.tokens,
                tokensLiqPay: sub.tokensLiqPay,
                price: sub.price,
                priceUSD: sub.priceUSD,
                pricePerToken: (sub.priceUSD / sub.tokensLiqPay).toFixed(4)
              };
              return acc;
            }, {}),

          // Моделі генерації зображень
          design: models.design.models
            .filter(m => m.available)
            .map(m => ({
              name: m.name.replace(/[🌀🍌🌊🔮🎯🖼️]/g, '').trim(),
              key: m.key,
              cost: m.cost,
              priceUSD: (m.cost * tokenPriceUSD).toFixed(3),
              resolution: m.resolution || m.size || null,
              maxImages: m.maxImages || 1
            })),

          // Моделі генерації відео
          video: models.video.models
            .filter(m => m.available)
            .map(m => {
              const result = {
                name: m.name.replace(/[🎭🔥🌟🎬🌊💜]/g, '').trim(),
                key: m.key
              };

              // Kling v2.5 - ціна за секунду
              if (m.costPerSecond) {
                result.costPerSecond = m.costPerSecond;
                result.pricePerSecondUSD = (m.costPerSecond * tokenPriceUSD).toFixed(3);
                result.durations = m.durations;
                result.examples = m.durations.map(d => ({
                  duration: d,
                  cost: d * m.costPerSecond,
                  priceUSD: (d * m.costPerSecond * tokenPriceUSD).toFixed(2)
                }));
              }
              // Kling Motion - різні режими
              else if (m.costs) {
                result.costs = m.costs;
                result.pricesUSD = Object.entries(m.costs).reduce((acc, [mode, cost]) => {
                  acc[mode] = (cost * tokenPriceUSD).toFixed(2);
                  return acc;
                }, {});
              }
              // Veo - ціна за секунду з/без аудіо
              else if (m.costPerSecondAudio) {
                result.costPerSecondAudio = m.costPerSecondAudio;
                result.costPerSecondNoAudio = m.costPerSecondNoAudio;
                result.pricePerSecondAudioUSD = (m.costPerSecondAudio * tokenPriceUSD).toFixed(3);
                result.pricePerSecondNoAudioUSD = (m.costPerSecondNoAudio * tokenPriceUSD).toFixed(3);
                result.durations = m.durations;
                result.examples = m.durations.map(d => ({
                  duration: d,
                  withAudio: {
                    cost: d * m.costPerSecondAudio,
                    priceUSD: (d * m.costPerSecondAudio * tokenPriceUSD).toFixed(2)
                  },
                  withoutAudio: {
                    cost: d * m.costPerSecondNoAudio,
                    priceUSD: (d * m.costPerSecondNoAudio * tokenPriceUSD).toFixed(2)
                  }
                }));
              }
              // Звичайна модель
              else {
                result.cost = m.cost;
                result.priceUSD = (m.cost * tokenPriceUSD).toFixed(2);
              }

              return result;
            }),

          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error getting models:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.all('/payment/success', (req, res) => {
      console.log(`✅ Payment success page accessed via ${req.method}`);
      res.sendFile(__dirname + '/public/payment-success.html');
    });

    // ✅ Payment failed page (for declined WayForPay payments)
    app.all('/payment/failed', (req, res) => {
      console.log(`❌ Payment failed page accessed via ${req.method}`);
      res.sendFile(__dirname + '/public/payment-failed.html');
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

    // ✅ Static files (CSS, JS, images, etc.)
    app.use(express.static(__dirname + '/public'));

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
      console.log(`💳 WayForPay webhook: POST http://127.0.0.1:${PORT}/webhook/wayforpay`);
      console.log(`💳 WayForPay checkout: GET http://127.0.0.1:${PORT}/pay/wayforpay?plan=starter`);
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

