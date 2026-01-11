require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const groqWhisper = require('./services/groq-whisper');
const adminNotifier = require('./utils/adminNotifier');

// Імпортуємо сервіси
const claude = require('./services/claude');
const midjourney = require('./services/midjourney');
const replicate = require('./services/replicate');

// Імпортуємо утиліти
const keyboard = require('./utils/keyboard');
const userBalance = require('./utils/userBalance');
const db = require('./database/connection');

// Імпортуємо конфігурацію
const models = require('./config/models');

// Ініціалізація бота
const bot = new Telegraf(process.env.BOT_TOKEN);

const isDevelopment = process.env.NODE_ENV === 'development';
const isShowBroadCast = process.env.SEND_STARTUP_BROADCAST === 'true' && false;


// ✅ МАСИВ МОДЕЛЕЙ З БАГАТОКРОКОВИМ ПРОЦЕСОМ
const MODELS_WITH_STATE = [
  'kling_motion',           // фото + відео (20s+)
  'kling_motion_minimal',   // фото + відео (<10s)
  'nano_banana_pro'         // вибір розміру (майбутнє)
];

// ✅ MIDDLEWARE: обнуляти стан при callback (крім моделей зі станами)
bot.on('callback_query', async (ctx, next) => {
  const callbackData = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);
  
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

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const currentModel = userCurrentModel.get(userId);
  const state = userState.get(userId);
  
  // Кнопки головного меню (обнуляють стан)
  const menuButtons = [
    '💡 Базові помічники',
    '🎬 Створення відео',
    '🎨 Створення/редагування зображень',
    '🎙️ Аудіо з AI',
    '👤 Профіль',
    '❓ Допомога',
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

ℹ️ Використовуючи бота, ви погоджуєтесь з цією політикою.
`;

// ==================== КОМАНДИ ====================

bot.start(async (ctx) => {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);
  
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
/help - Ця довідка

💡 Як користуватися:
1. Виберіть розділ у головному меню
2. Оберіть модель для генерації
3. Надішліть текстовий запит
4. Чекайте на результат

💰 Токени витрачаються за кожну генерацію
📦 Купіть підписку для отримання більше токенів

👤 Підтримка:
https://t.me/nnn_ddddddd

© 2025 neuro.lab.ai Всі права захищені.`;

  await ctx.reply(helpText, keyboard.createBackButton());
});

bot.command('profile', async (ctx) => {
  await showProfile(ctx);
});

bot.command('balance', async (ctx) => {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);
  await ctx.reply(
    `💰 Ваш баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
    `📦 Підписка: ${user.subscription?.type || 'Немає'}\n` +
    `${user.subscription?.expiresAt ? `⏰ До: ${new Date(user.subscription.expiresAt).toLocaleDateString()}` : ''}`,
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

// ==================== ГОЛОВНЕ МЕНЮ ====================

bot.hears('💡 Базові помічники', async (ctx) => {
  await ctx.reply(
    `💡 Claude\n\n💎 Claude - преміум якість\n\nОберіть режим роботи 👇`,
    keyboard.createGPTActionsMenu(models.gpt.actions)
  );
});

bot.hears('🎬 Створення відео', async (ctx) => {
  await ctx.reply(
    '🎬 Створення відео\n\nВиберіть розділ для роботи з відео 👇',
    keyboard.createInlineMenu(models.video.models, 1)
  );
});

bot.hears('🎨 Створення/редагування зображень', async (ctx) => {
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

// Subscription
bot.action('buy_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`💎 Оберіть підписку\n\n Виберіть план 👇`, keyboard.createSubscriptionsMenu());
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

bot.action(/^sub_(starter|basic|pro|premium)$/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const planKey = ctx.match[1];
  const sub = models.subscriptions[planKey];
  
  if (!sub) {
    await ctx.reply('❌ Підписка не знайдена');
    return;
  }
  
  let message = `💳 Підписка ${sub.name}\n\n`;
  message += sub.features.join('\n') + '\n\n';
  message += `💰 Вартість: ${sub.price}⭐ (Telegram Stars)\n`;
  message += `🎁 Токенів: ${sub.tokens}⚡`;
  
  await ctx.reply(message, keyboard.createPaymentMenu(sub.price, planKey));
});

bot.action(/^pay_stars_(starter|basic|pro|premium)$/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const planKey = ctx.match[1];
  const sub = models.subscriptions[planKey];
  
  if (!sub) {
    await ctx.reply('❌ Підписка не знайдена');
    return;
  }
  
  const invoice = {
    title: `${sub.name} Підписка`,
    description: `Підписка на 1 місяць з ${sub.tokens} токенами`,
    payload: JSON.stringify({ type: 'subscription', plan: planKey }),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: `${sub.name} підписка`, amount: sub.price }]
  };
  
  try {
    await ctx.replyWithInvoice(invoice);
  } catch (error) {
    console.error('Payment error:', error);
    await ctx.reply('❌ Помилка створення платежу. Спробуйте пізніше.');
  }
});

// Payment handlers
bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('successful_payment', async (ctx) => {
  const userId = ctx.from.id;
  const payload = JSON.parse(ctx.message.successful_payment.invoice_payload);
  
  if (payload.type === 'subscription') {
    const planKey = payload.plan;
    const sub = models.subscriptions[planKey];
    
    if (!sub) {
      await ctx.reply('❌ Помилка: підписка не знайдена');
      return;
    }
    
    await userBalance.addTokens(userId, sub.tokens, 'subscription_purchase', { plan: sub.name, price: sub.price });
    await userBalance.setSubscription(userId, sub.name, 30);
    
    const user = await userBalance.getUser(userId, ctx.from);
    
    await ctx.reply(
      `✅ Оплата успішна!\n\n🎉 Ви отримали ${sub.tokens}⚡ токенів\n💰 Новий баланс: ${user.tokens.toFixed(2)}⚡\n📦 Підписка: ${sub.name}\n\nДякуємо за підтримку! 💙`,
      keyboard.createMainMenu()
    );
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
  const mediaGroupId = ctx.message.media_group_id;

  // Обробка альбомів
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
    await handleImageGeneration(ctx, prompt, currentModel);
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
  const { photos, caption, currentModel } = group;
  const model = models.design.models.find(m => m.key === currentModel);

  // ✅ Перевірити чи модель підтримує багато зображень
  if (model?.maxImages && model.maxImages > 1) {
    await handleImageGeneration(ctx, caption, currentModel, photos);
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

async function handleImageGeneration(ctx, prompt, modelKey, imageInput = null) {
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
      stable_diffusion: () => replicate.generateWithStableDiffusion(prompt, imageInput),
      nano_banana_2k: () => replicate.generateWithNanoBanana(prompt, imageInput, '2K'),
      nano_banana_4k: () => replicate.generateWithNanoBanana(prompt, imageInput, '4K'),
      seedream_2k: () => replicate.generateWithSeedream(prompt, imageInput, '2K'),
      seedream_4k: () => replicate.generateWithSeedream(prompt, imageInput, '4K'),
      ideogram: () => replicate.generateWithIdeogram(prompt, imageInput, 0.5)
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
  message += `📦 Підписка: ${stats.subscriptionType || 'Немає'}\n`;
  if (stats.subscriptionExpiry) {
    message += `⏰ До: ${stats.subscriptionExpiry.toLocaleDateString('uk-UA')}\n`;
  }
  message += `\n📊 Статистика:\n`;
  message += `🎨 Генерацій: ${stats.generationCount}\n`;
  message += `💸 Витрачено: ${stats.totalSpent.toFixed(2)}⚡\n`;
  message += `📅 З нами: ${stats.memberSince.toLocaleDateString('uk-UA')}`;
  
  await ctx.reply(message, keyboard.createSubscriptionMenu());
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
    await db.connect();
    
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