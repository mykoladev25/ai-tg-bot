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

// Зберігаємо стан генерації для кожного користувача
const userState = new Map();

const INSTRUCTION_HTML = `
📄 <b>ІНСТРУКЦІЯ</b>

📝 <b>Як користуватися ботом:</b>

<b>1️⃣ GPT / Claude</b>
• Оберіть режим: <i>текст / голос / зображення</i>
• Надішліть запит
• Отримайте відповідь від AI

<b>2️⃣ Генерація зображень</b>
• Оберіть модель (<i>MidJourney, Nano Banana, тощо</i>)
• Опишіть, що хочете побачити
• Очікуйте результат <i>(~30–60 сек)</i>

<b>3️⃣ Генерація відео</b>
• Оберіть модель
• Надішліть текстовий опис
• Відео буде готове <i>за 2–5 хвилин</i>


💰 <b>Токени ⚡</b>
• <b>Кожна генерація списує токени</b>
• 🎁 <b>Безкоштовно:</b> 5.50⚡ при реєстрації
• 💎 Купіть підписку для більшої кількості

<i>⚡ Тарифи вказані біля кожної моделі</i>


📜 <b>Політика білінгу</b>

• Бот використовує сторонні AI-сервіси
  <i>(Replicate, Runway, MidJourney тощо)</i>

• <b>Ви купуєте внутрішні токени ⚡</b>, а не прямий API-доступ

• <b>Токени списуються за кожну AI-дію</b>

⚠️ <b>Важливо:</b>
• <b>Генерація може не відповідати очікуванням</b> — це особливість AI
• <b>Повернення токенів за виконані дії не передбачено</b>

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
📦 Купіть підписку для отримання більше токенів`;

  await ctx.reply(helpText, keyboard.createBackButton());
});

bot.command('profile', async (ctx) => {
  await showProfile(ctx);
});

bot.command('balance', async (ctx) => {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);
  await ctx.reply(
    `💰 Ваш баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
    `📦 Підписка: ${user.subscription || 'Немає'}\n` +
    `${user.subscriptionExpiry ? `⏰ До: ${user.subscriptionExpiry.toLocaleDateString()}` : ''}`,
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
    const date = new Date(item.createdAt).toLocaleString('uk-UA');  // ← createdAt
    const sign = item.type === 'deduction' ? '-' : '+';
    text += `${index + 1}. ${date}\n`;
    text += `   ${item.description || 'Транзакція'}\n`;  // ← description
    text += `   ${sign}${item.amount.toFixed(2)}⚡ (баланс: ${item.balanceAfter.toFixed(2)}⚡)\n\n`;  // ← balanceAfter
  });
  
  await ctx.reply(text, keyboard.createBackButton());
});

bot.command('clear', async (ctx) => {
  await userBalance.clearConversationHistory(ctx.from.id);
  await ctx.reply('✅ Історію розмови очищено!', keyboard.createMainMenu());
});

// ==================== ГОЛОВНЕ МЕНЮ ====================

bot.hears('💡 Claude', async (ctx) => {
  const message = `💡 Claude

🎙️ Говоріть
✍️ Пишіть
🖼️ Завантажте зображення для аналізу

Neurolab AI відповість на ваше запитання текстом або голосом + 🌐 вихід в інтернет (тільки версія 4 моделі).`;

  await ctx.reply(
      `💡 Claude\n\n🎙️ Говоріть\n✍️ Пишіть\n🖼️ Завантажте зображення для аналізу`,
      keyboard.createGPTActionsMenu(models.gpt.actions)
  );
  await userBalance.setCurrentModel(ctx.from.id, 'claude');
});

bot.hears('🎬 Створення відео', async (ctx) => {
  await ctx.reply(
    '🎬 Створення відео\n\nВиберіть розділ для роботи з відео 👇',
    keyboard.createInlineMenu(models.video.models, 1)
  );
});

bot.hears('🎨 Дизайн з AI', async (ctx) => {
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

// GPT Actions
bot.action('gpt_text', async (ctx) => {
  await ctx.answerCbQuery();
  await userBalance.setCurrentModel(ctx.from.id, 'claude_text');
  await ctx.reply(
    '✍️ Режим текстової розмови активовано!\n\n' +
    'Надішліть мені ваше запитання, і я відповім текстом.\n\n' +
    '💡 Підказка: Я запам\'ятовую контекст розмови, тому можете продовжувати діалог.',
    keyboard.createBackButton()
  );
});

bot.action('gpt_voice', async (ctx) => {
  await ctx.answerCbQuery();
  await userBalance.setCurrentModel(ctx.from.id, 'claude_voice');
  await ctx.reply(
      '🎙️ Режим голосової розмови активовано!\n\n' +
      'Надішліть голосове повідомлення, і я перетворю його в текст та відповім.\n\n' +
      '💡 Groq Whisper - безкоштовна транскрипція',
      keyboard.createBackButton()
  );
});

bot.action('gpt_image', async (ctx) => {
  await ctx.answerCbQuery();
  await userBalance.setCurrentModel(ctx.from.id, 'claude_vision');
  await ctx.reply(
    '🖼️ Режим аналізу зображень активовано!\n\n' +
    'Надішліть мені зображення з підписом (або без), і я його проаналізую.',
    keyboard.createBackButton()
  );
});

bot.action('new_conversation', async (ctx) => {
  await ctx.answerCbQuery('Історію очищено!');

  const userId = ctx.from.id;
  await userBalance.clearConversationHistory(userId);

  // Скидаємо модель на GPT текстову
  await userBalance.setCurrentModel(userId, 'claude_text');

  await ctx.reply('✅ Нову розмову розпочато! 👋\n\nНадішліть своє повідомлення, щоб почати чат із GPT.',
      keyboard.createGPTActionsMenu(models.gpt.actions)
  );
});

// Design Models
bot.action(/^(midjourney|flux|nano_banana|stable_diffusion|seedream|clarity|ideogram)$/, async (ctx) => {
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
  
  if (model.cost > 0 && !await userBalance.hasTokens(ctx.from.id, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }
  
  await userBalance.setCurrentModel(ctx.from.id, modelKey);

  if (modelKey === 'clarity') {
    await ctx.reply(
        `${model.name}\n\n` +
        `🔮 Покращення якості зображень\n\n` +
        `Надішліть фото, яке хочете покращити.\n` +
        `Можете додати підпис (опис) для кращого результату.\n\n` +
        `💰 Вартість: ${model.cost}⚡\n` +
        `📈 Збільшення: 2x (scale factor)\n` +
        `⏱️ Час обробки: ~30-60 секунд`,
        keyboard.createBackButton('design_menu')
    );
  } else {
    await ctx.reply(
        `${model.name}\n\n` +
        `Надішліть текстовий опис зображення, яке хочете згенерувати.\n\n` +
        `Вартість: ${model.cost > 0 ? model.cost + '⚡' : 'Безкоштовно'}`,
        keyboard.createBackButton('design_menu')
    );
  }
});

// Video Models
bot.action(/^(kling|runway_gen4|runway_turbo|luma)$/, async (ctx) => {
  const modelKey = ctx.match[1];
  const model = models.video.models.find(m => m.key === modelKey);
  
  if (!model) {
    await ctx.answerCbQuery('Модель не знайдена');
    return;
  }
  
  await ctx.answerCbQuery();
  
  if (!await userBalance.hasTokens(ctx.from.id, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }
  
  await userBalance.setCurrentModel(ctx.from.id, modelKey);
  
  await ctx.reply(
    `${model.name}\n\n` +
      `Надішліть текстовий опис відео, яке хочете згенерувати, або надішліть картинку з підписом/описом.\n\n` +
      `⏱️ Генерація займе 2-5 хвилин\n` +
      `💰 Вартість: ${model.cost}⚡`,
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

  if (!await userBalance.hasTokens(ctx.from.id, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.setCurrentModel(ctx.from.id, modelKey);

  await ctx.reply(
      `${model.name}\n\n` +
      `🎵 Генерація аудіо\n\n` +
      `Надішліть текст для озвучення.\n\n` +
      `💰 Вартість: ${model.cost}⚡\n` +
      `⏱️ Час генерації: ~20-40 секунд`,
      keyboard.createBackButton('audio_menu')
  );
});

// Audio Navigation
bot.action('audio_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply(
      '🎙️ Аудіо з AI\n\nВиберіть розділ для роботи з аудіо 👇',
      keyboard.createInlineMenu(models.audio.models, 2)
  );
});

// Navigation
bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('🏠 Головне меню', keyboard.createMainMenu());
});

bot.action('design_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply(
    '🎨 Дизайн з AI\n\nВиберіть розділ для роботи з зображенням 👇',
    keyboard.createInlineMenu(models.design.models, 1)
  );
});

bot.action('video_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply(
    '🎬 Створення відео\n\nВиберіть розділ для роботи з відео 👇',
    keyboard.createInlineMenu(models.video.models, 1)
  );
});

// Subscription
bot.action('buy_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  const sub = models.subscriptions.basic;
  
  let message = `💳 Підписка ${sub.name}\n\n`;
  message += sub.features.join('\n') + '\n\n';
  message += `💰 Вартість: ${sub.price}⭐ (Telegram Stars)\n`;
  message += `🎁 Токенів: ${sub.tokens}⚡`;
  
  await ctx.reply(message, keyboard.createPaymentMenu(sub.price));
});

// Community button
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

  await ctx.reply(message, {
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    ...keyboard.createBackButton()
  });
});

bot.action('pay_stars', async (ctx) => {
  await ctx.answerCbQuery();
  
  const sub = models.subscriptions.basic;
  const invoice = {
    title: `${sub.name} Підписка`,
    description: 'Підписка на 1 місяць з 260 токенами',
    payload: JSON.stringify({ type: 'subscription', plan: 'basic' }),
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
    const sub = models.subscriptions.basic;
    await userBalance.addTokens(userId, sub.tokens, 'subscription_purchase');
    await userBalance.setSubscription(userId, sub.name, 30);
    
    const user = await userBalance.getUser(userId, ctx.from);

    
    await ctx.reply(
      `✅ Оплата успішна!\n\n` +
      `🎉 Ви отримали ${sub.tokens}⚡ токенів\n` +
      `💰 Новий баланс: ${user.tokens.toFixed(2)}⚡\n` +
      `📦 Підписка: ${sub.name}\n\n` +
      `Дякуємо за підтримку! 💙`,
      keyboard.createMainMenu()
    );
  }
});

// ==================== MESSAGE HANDLERS ====================

// Обробка текстових повідомлень
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = await userBalance.getCurrentModel(userId);
  const text = ctx.message.text;
  
  // Ігноруємо команди
  if (text.startsWith('/')) return;
  
  if (!currentModel) {
    await ctx.reply(
      'Будь ласка, спочатку виберіть модель з меню 👇',
      keyboard.createMainMenu()
    );
    return;
  }
  
  // Обробка різних моделей
  if (currentModel === 'clarity') {
    await ctx.reply(
        '🔮 Clarity Upscaler чекає на зображення.\n\nНадішліть фото для покращення якості.',
        keyboard.createGPTActionsMenu(models.design.models)
    );
    return;
  }
  else if (currentModel === 'claude_vision' || currentModel === 'claude_text' || currentModel === 'claude') {
    await handleClaudeText(ctx, text);
  } else if (currentModel === 'midjourney') {
    await handleMidjourneyGeneration(ctx, text);
  } else if (currentModel === 'flux') {
    await handleFluxGeneration(ctx, text);
  } else if (currentModel === 'stable_diffusion') {
    await handleStableDiffusionGeneration(ctx, text);
  } else if (currentModel === 'nano_banana') {
    await handleNanoBananaGeneration(ctx, text);
  } else if (currentModel === 'seedream') {
    await handleSeedreamGeneration(ctx, text);
  } else if (currentModel === 'ideogram') {
    await handleIdeogramGeneration(ctx, text);
  } else if (currentModel === 'kling') {
    await handleKlingVideo(ctx, text);
  } else if (currentModel === 'runway_gen4') {
    await handleRunwayVideo(ctx, text);
  } else if (currentModel === 'runway_turbo') {
    await handleRunwayTurboVideo(ctx, text);
  } else if (currentModel === 'suno') {
    await handleSunoGeneration(ctx, text);
  } else {
    await ctx.reply(
      `Модель "${currentModel}" ще не підтримується.\nВиберіть іншу модель.`,
      keyboard.createMainMenu()
    );
  }
});

// Обробка голосових повідомлень
// Обробка голосових повідомлень
bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = await userBalance.getCurrentModel(userId);

  if (currentModel !== 'claude_voice') {
    await ctx.reply('Спочатку активуйте голосовий режим через GPT → 🎙️ Говоріть');
    return;
  }

  const statusMsg = await ctx.reply('🎙️ Розпізнаю голос...');

  try {
    // Отримати посилання на файл
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);

    // Транскрибувати через Groq
    const transcription = await groqWhisper.transcribeVoice(fileLink.href);

    if (!transcription.success) {
      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Помилка розпізнавання: ${transcription.error}`
      );
      return;
    }

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `📝 Розпізнано: "${transcription.text}"\n\n🤔 Думаю...`
    );

    // Відправити в Claude
    await handleClaudeText(ctx, transcription.text);

    // Видалити статус
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

  } catch (error) {
    console.error('Voice processing error:', error);
    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка обробки голосу. Спробуйте ще раз.'
    );
  }
});

// Обробка фото
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const currentModel = await userBalance.getCurrentModel(userId);
  const videoModelsAcceptingImage = ['kling', 'runway_gen4', 'runway_turbo'];

  if (currentModel === 'claude_vision') {
    await handleClaudeVision(ctx);
  } else if (currentModel === 'clarity') {
    await handleClarityUpscaler(ctx);
  } else if (videoModelsAcceptingImage.includes(currentModel)) {
    const prompt = ctx.message.caption || '';
    if (currentModel === 'kling') {
      await handleKlingVideo(ctx, prompt);
    } else if (currentModel === 'runway_gen4') {
      await handleRunwayVideo(ctx, prompt);
    } else if (currentModel === 'runway_turbo') {
      await handleRunwayTurboVideo(ctx, prompt);
    }
  } else {
    await ctx.reply(
        'Для аналізу зображень виберіть режим "💡 Claude" → "🖼️ Завантажте зображення"',
        keyboard.createGPTActionsMenu(models.gpt.actions)
    );
  }
});

// ==================== ГЕНЕРАЦІЯ ====================

async function handleClaudeText(ctx, text) {
  const userId = ctx.from.id;
  
  const textModel = models.gpt.actions.find(a => a.key === 'text');
  
  if (!textModel) {
    await ctx.reply('❌ Модель не знайдено');
    return;
  }
  
  if (!(await userBalance.hasTokens(userId, textModel.cost))) {
    await ctx.reply(
      `❌ Недостатньо токенів!\n\n` +
      `Потрібно: ${textModel.cost}⚡\n` +
      `Поповніть баланс через /buy`,
      keyboard.createMainMenu()
    );
    return;
  }
  
  try {
    const statusMsg = await ctx.reply('🤔 Думаю...');
    
    const history = await userBalance.getConversationHistory(userId);
    const response = await claude.continueConversation(text, history);
    
    if (response.success) {
      await userBalance.saveConversationMessage(userId, 'user', text);
      await userBalance.saveConversationMessage(userId, 'assistant', response.text);
      
      await userBalance.deductTokens(
        userId,
        textModel.cost,
        'Claude текстова генерація',
        {
          modelKey: 'claude_text',
          modelName: 'Claude Sonnet 4.5',
          apiCost: textModel.apiCost
        }
      );
      
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.reply(response.text, keyboard.createGPTActionsMenu(models.gpt.actions));
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ Помилка: ${response.error}`
      );
    }
  } catch (error) {
    console.error('Claude text error:', error);
    await ctx.reply('❌ Сталася помилка. Спробуйте ще раз.');
  }
}

async function handleClaudeVision(ctx) {
  const userId = ctx.from.id;
  const model = models.gpt.actions.find(m => m.key === 'image');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  try {
    const statusMsg = await ctx.reply('👀 Аналізую зображення...');

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');

    const prompt = ctx.message.caption || 'Опишіть це зображення детально.';

    await userBalance.deductTokens(userId, model.cost, 'Claude аналіз зображення', { prompt });

    const response = await claude.analyzeImageWithClaude(imageBase64, prompt, 'image/jpeg');

    if (response.success) {
      await userBalance.saveConversationMessage(userId, 'user', `[Зображення] ${prompt}`);
      await userBalance.saveConversationMessage(userId, 'assistant', response.text);

      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.reply(response.text, keyboard.createGPTActionsMenu(models.gpt.actions));
    } else {
      await userBalance.addTokens(userId, model.cost, 'claude_vision_refund');

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Помилка: ${response.error}\n\nТокени повернуто.`
      );
    }
  } catch (error) {
    console.error('Claude vision error:', error);

    await userBalance.addTokens(userId, model.cost, 'claude_vision_error_refund');

    await ctx.reply('❌ Помилка при аналізі зображення.\nТокени повернуто.');
  }
}

async function handleMidjourneyGeneration(ctx, prompt) {
  const userId = ctx.from.id;
  const model = models.design.models.find(m => m.key === 'midjourney');
  
  if (!await userBalance.deductTokens(userId, model.cost, 'Midjourney generation', { prompt })) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }
  
  const user = await userBalance.getUser(userId, ctx.from);

  const statusMsg = await ctx.reply(
    `🎨 Генерую зображення через Midjourney...\n\n` +
    `⏱️ Це займе ~30-60 секунд\n` +
    `💰 Залишок: ${user.tokens.toFixed(2)}⚡`
  );
  
  try {
    const result = await midjourney.generateImage(prompt);
    
    if (result.success) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.replyWithPhoto(
        { url: result.imageUrl },
        {
          caption: `✅ Готово!\n\nPrompt: ${prompt}\n\n💰 Використано: ${model.cost}⚡`,
          ...keyboard.createGenerationActionsMenu(result.taskId)
        }
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ Помилка генерації: ${result.error}\n\n💰 Токени повернуто`
      );
      await userBalance.addTokens(userId, model.cost, 'refund');
    }
  } catch (error) {
    console.error('Midjourney error:', error);
    await ctx.reply('❌ Сталася помилка');
    await userBalance.addTokens(userId, model.cost, 'refund');
  }
}

async function handleFluxGeneration(ctx, prompt) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.design.models.find(m => m.key === 'flux');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'flux_generation', { prompt });

  const statusMsg = await ctx.reply(
      `💎 Генерую через FLUX 1.1 Pro...\n\n` +
      `Промпт: "${prompt}"`
  );

  try {
    const result = await replicate.generateWithFlux(prompt);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'flux_generation',
        model: 'FLUX 1.1 Pro',
        prompt
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте іншу модель або повторіть пізніше.`
      );

      await userBalance.addTokens(userId, model.cost, 'flux_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithPhoto(
        { url: result.imageUrl },
        {
          caption: `💎 FLUX 1.1 Pro\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('design_menu')
        }
    );

  } catch (error) {
    console.error('FLUX generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'flux_generation',
      model: 'FLUX 1.1 Pro',
      prompt
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації. Токени повернуто.\nСпробуйте іншу модель.'
    );

    await userBalance.addTokens(userId, model.cost, 'flux_error_refund');
  }
}

async function handleStableDiffusionGeneration(ctx, prompt) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.design.models.find(m => m.key === 'stable_diffusion');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'stable_diffusion_generation', { prompt });

  const statusMsg = await ctx.reply(
      `🌀 Генерую через Stable Diffusion...\n\n` +
      `Промпт: "${prompt}"`
  );

  try {
    const result = await replicate.generateWithStableDiffusion(prompt);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'stable_diffusion_generation',
        model: 'Stable Diffusion SDXL',
        prompt
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте іншу модель або повторіть пізніше.`
      );

      await userBalance.addTokens(userId, model.cost, 'stable_diffusion_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithPhoto(
        { url: result.imageUrl },
        {
          caption: `🌀 Stable Diffusion\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('design_menu')
        }
    );

  } catch (error) {
    console.error('Stable Diffusion generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'stable_diffusion_generation',
      model: 'Stable Diffusion SDXL',
      prompt
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації. Токени повернуто.\nСпробуйте іншу модель.'
    );

    await userBalance.addTokens(userId, model.cost, 'stable_diffusion_error_refund');
  }
}

async function handleKlingVideo(ctx, prompt) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.video.models.find(m => m.key === 'kling');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'kling_video', { prompt });

  let imageUrl = null;

  // Перевіряємо, чи користувач надіслав картинку
  if (ctx.message?.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    imageUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  }

  const statusMsg = await ctx.reply(
      `🎭 Генерую відео через Kling...\n⏱️ Це може зайняти 2-5 хвилин\n\n` +
      `Промпт: "${prompt}"`
  );

  try {
    const result = await replicate.generateVideoWithKling(prompt, imageUrl);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'kling_video_generation',
        model: 'Kling Video',
        prompt,
        hasImage: !!imageUrl
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації відео.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте іншу модель або повторіть пізніше.`
      );

      await userBalance.addTokens(userId, model.cost, 'kling_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithVideo(
        { url: result.videoUrl },
        {
          caption: `🎭 Kling Video\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('video_menu')
        }
    );

  } catch (error) {
    console.error('Kling video generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'kling_video_generation',
      model: 'Kling Video',
      prompt,
      hasImage: !!imageUrl
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації відео. Токени повернуто.\nСпробуйте іншу модель.'
    );

    await userBalance.addTokens(userId, model.cost, 'kling_error_refund');
  }
}

/**
 * Обробка генерації через Nano Banana Pro
 */
async function handleNanoBananaGeneration(ctx, prompt) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.design.models.find(m => m.key === 'nano_banana');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'nano_banana_generation', { prompt });

  const statusMsg = await ctx.reply(
      `🍌 Генерую через Nano Banana Pro...\n\n` +
      `Промпт: "${prompt}"`
  );

  try {
    const result = await replicate.generateWithNanoBanana(prompt);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {  // ← bot замість ctx.telegram
        userId,
        username,
        action: 'nano_banana_generation',
        model: 'Nano Banana Pro',
        prompt
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте іншу модель або повторіть пізніше.`
      );

      await userBalance.addTokens(userId, model.cost, 'nano_banana_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithPhoto(
        { url: result.imageUrl },
        {
          caption: `🍌 Nano Banana Pro\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('design_menu')
        }
    );

  } catch (error) {
    console.error('Nano Banana generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {  // ← bot замість ctx.telegram
      userId,
      username,
      action: 'nano_banana_generation',
      model: 'Nano Banana Pro',
      prompt
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації. Токени повернуто.\nСпробуйте іншу модель.'
    );

    await userBalance.addTokens(userId, model.cost, 'nano_banana_error_refund');
  }
}

/**
 * Обробка генерації через Seedream 4.5
 */
async function handleSeedreamGeneration(ctx, prompt) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.design.models.find(m => m.key === 'seedream');

  if (!userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'seedream_generation', { prompt });

  const statusMsg = await ctx.reply(
      `🌊 Генерую через Seedream 4.5...\n\n` +
      `Промпт: "${prompt}"`
  );

  try {
    const result = await replicate.generateWithSeedream(prompt);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'seedream_generation',
        model: 'Seedream 4.5',
        prompt
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте іншу модель або повторіть пізніше.`
      );

      await userBalance.addTokens(userId, model.cost, 'seedream_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithPhoto(
        { url: result.imageUrl },
        {
          caption: `🌊 Seedream 4.5\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('design_menu')
        }
    );

  } catch (error) {
    console.error('Seedream generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'seedream_generation',
      model: 'Seedream 4.5',
      prompt
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації. Токени повернуто.\nСпробуйте іншу модель.'
    );

    await userBalance.addTokens(userId, model.cost, 'seedream_error_refund');
  }
}

/**
 * Обробка покращення зображення через Clarity Upscaler
 */
async function handleClarityUpscaler(ctx) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.design.models.find(m => m.key === 'clarity');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'clarity_upscaler', { action: 'upscale' });

  const statusMsg = await ctx.reply(
      `🔮 Покращую якість зображення через Clarity Upscaler...\n\n` +
      `⏱️ Це може зайняти 30-60 секунд`
  );

  try {
    // Отримати URL зображення
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const imageUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    // Промпт з caption або дефолтний
    const prompt = ctx.message.caption || 'masterpiece, best quality, highres, extremely detailed';

    const result = await replicate.generateWithClarityUpscaler(imageUrl, prompt);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'clarity_upscaler',
        model: 'Clarity Upscaler',
        prompt,
        imageUrl
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка покращення.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте ще раз або оберіть іншу модель.`
      );

      await userBalance.addTokens(userId, model.cost, 'clarity_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithPhoto(
        { url: result.imageUrl },
        {
          caption: `🔮 Clarity Upscaler\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('design_menu')
        }
    );

  } catch (error) {
    console.error('Clarity Upscaler failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'clarity_upscaler',
      model: 'Clarity Upscaler'
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка покращення зображення. Токени повернуто.\nСпробуйте ще раз.'
    );

    await userBalance.addTokens(userId, model.cost, 'clarity_error_refund');
  }
}

/**
 * Обробка генерації через Ideogram v3 Turbo
 */
async function handleIdeogramGeneration(ctx, prompt) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.design.models.find(m => m.key === 'ideogram');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'ideogram_generation', { prompt });

  const statusMsg = await ctx.reply(
      `🎯 Генерую через Ideogram v3 Turbo...\n\n` +
      `Промпт: "${prompt}"`
  );

  try {
    const result = await replicate.generateWithIdeogram(prompt);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'ideogram_generation',
        model: 'Ideogram v3 Turbo',
        prompt
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте іншу модель або повторіть пізніше.`
      );

      await userBalance.addTokens(userId, model.cost, 'ideogram_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithPhoto(
        { url: result.imageUrl },
        {
          caption: `🎯 Ideogram v3 Turbo\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('design_menu')
        }
    );

  } catch (error) {
    console.error('Ideogram generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'ideogram_generation',
      model: 'Ideogram v3 Turbo',
      prompt
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації. Токени повернуто.\nСпробуйте іншу модель.'
    );

    await userBalance.addTokens(userId, model.cost, 'ideogram_error_refund');
  }
}

async function handleRunwayVideo(ctx, prompt) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.video.models.find(m => m.key === 'runway_gen4');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'runway_video', { prompt });

  let imageUrl = null;

  if (ctx.message?.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    imageUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  }

  const statusMsg = await ctx.reply(
      `🎬 Генерую відео через Runway Gen-4 Aleph...\n⏱️ Це займе 2-4 хвилини\n\n` +
      `Промпт: "${prompt}"`
  );

  try {
    const result = await replicate.generateVideoWithRunway(prompt, imageUrl);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'runway_video_generation',
        model: 'Runway Gen-4',
        prompt,
        hasImage: !!imageUrl
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації відео.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте іншу модель або повторіть пізніше.`
      );

      await userBalance.addTokens(userId, model.cost, 'runway_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithVideo(
        { url: result.videoUrl },
        {
          caption: `🎬 Runway Gen-4\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('video_menu')
        }
    );

  } catch (error) {
    console.error('Runway video generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'runway_video_generation',
      model: 'Runway Gen-4',
      prompt,
      hasImage: !!imageUrl
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації відео. Токени повернуто.\nСпробуйте іншу модель.'
    );

    await userBalance.addTokens(userId, model.cost, 'runway_error_refund');
  }
}

/**
 * Обробка генерації аудіо через Suno AI Bark
 */
async function handleSunoGeneration(ctx, text) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.audio.models.find(m => m.key === 'suno');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  // Перевірка довжини тексту
  if (text.length > 500) {
    await ctx.reply(
        '❌ Текст занадто довгий!\n\n' +
        'Максимум: 500 символів\n' +
        `Ваш текст: ${text.length} символів\n\n` +
        'Скоротіть текст і спробуйте ще раз.'
    );
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'suno_generation', { text });

  const statusMsg = await ctx.reply(
      `🎵 Генерую аудіо через Suno AI Bark...\n\n` +
      `Текст: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"\n\n` +
      `⏱️ Це може зайняти 20-40 секунд`
  );

  try {
    const result = await replicate.generateWithSuno(text);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'suno_generation',
        model: 'Suno AI Bark',
        text
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації аудіо.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте ще раз або оберіть іншу модель.`
      );

      await userBalance.addTokens(userId, model.cost, 'suno_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithAudio(
        { url: result.audioUrl },
        {
          caption: `🎵 Suno AI Bark\n\n📝 Текст: ${text}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('audio_menu')
        }
    );

  } catch (error) {
    console.error('Suno generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'suno_generation',
      model: 'Suno AI Bark',
      text
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації аудіо. Токени повернуто.\nСпробуйте ще раз.'
    );

    await userBalance.addTokens(userId, model.cost, 'suno_error_refund');
  }
}

/**
 * Обробка генерації відео через Runway Gen-4 Turbo
 */
async function handleRunwayTurboVideo(ctx, prompt) {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'unknown';
  const model = models.video.models.find(m => m.key === 'runway_turbo');

  if (!await userBalance.hasTokens(userId, model.cost)) {
    await showInsufficientTokens(ctx, model.cost);
    return;
  }

  await userBalance.deductTokens(userId, model.cost, 'runway_turbo_video', { prompt });

  let imageUrl = null;

  if (ctx.message?.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    imageUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  }

  const statusMsg = await ctx.reply(
      `🎬 Генерую відео через Runway Gen-4 Turbo...\n⏱️ Це займе 1-2 хвилини\n\n` +
      `Промпт: "${prompt}"`
  );

  try {
    const result = await replicate.generateVideoWithRunwayTurbo(prompt, imageUrl);

    if (!result.success) {
      await adminNotifier.notifyAdmin(bot, new Error(result.error), {
        userId,
        username,
        action: 'runway_turbo_video_generation',
        model: 'Runway Gen-4 Turbo',
        prompt,
        hasImage: !!imageUrl
      });

      await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Тимчасова помилка генерації відео.\n\n` +
          `Токени повернуто на баланс.\n` +
          `Спробуйте іншу модель або повторіть пізніше.`
      );

      await userBalance.addTokens(userId, model.cost, 'runway_turbo_refund');
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    await ctx.replyWithVideo(
        { url: result.videoUrl },
        {
          caption: `🎬 Runway Gen-4 Turbo\n\n📝 Промпт: ${prompt}\n\n💰 Витрачено: ${model.cost}⚡`,
          ...keyboard.createBackButton('video_menu')
        }
    );

  } catch (error) {
    console.error('Runway Turbo video generation failed:', error);

    await adminNotifier.notifyAdmin(bot, error, {
      userId,
      username,
      action: 'runway_turbo_video_generation',
      model: 'Runway Gen-4 Turbo',
      prompt,
      hasImage: !!imageUrl
    });

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Помилка генерації відео. Токени повернуто.\nСпробуйте іншу модель.'
    );

    await userBalance.addTokens(userId, model.cost, 'runway_turbo_error_refund');
  }
}

// ==================== HELPER FUNCTIONS ====================

async function showProfile(ctx) {
  const user = await userBalance.getUser(ctx.from.id, ctx.from);

  if (!user) {
      await ctx.reply('❌ Помилка. Спробуйте /start', keyboard.createBackButton());
      return;
  }

  const stats = await userBalance.getUserStats(ctx.from.id);
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
  const user = await userBalance.getUser(ctx.from.id);
  
  const message = `⚠️ Недостатньо токенів!\n\n` +
    `Необхідно: ${required}⚡\n` +
    `Ваш баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
    `🔥 P.S. Ви можете безкоштовно генерувати зображення щоденно в DALL-e 3 у нашій спільноті та у FLUX всередині чат-бота Neurolab AI.`;
  
  await ctx.reply(message, keyboard.createSubscriptionMenu());
}

// ==================== ЗАПУСК БОТА ====================

async function startBot() {
  console.log('🚀 Starting neuro.lab.ai Bot...');
  
  // Завантажуємо дані користувачів (якщо є)
  // const savedUsers = await database.loadUsersFromFile();
  // if (savedUsers.size > 0) {
  //   console.log(`Loaded ${savedUsers.size} users from database`);
  // }
  
  // Налаштовуємо періодичне збереження
  // database.setupPeriodicSave(users, 5);
  // database.setupExitHandler(users);
  
  // Запускаємо бота
  async function startBot() {
  try {
    // Підключаємось до MongoDB
    console.log('📡 Connecting to MongoDB...');
    await db.connect();
    
    // Запускаємо бота
    console.log('🤖 Starting bot...');
    await bot.launch();
    console.log('✅ Bot started successfully!');
    
    // Graceful shutdown
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
    console.error('❌ Failed to start bot:',
       error);
    process.exit(1);
  }
}

startBot();
}

startBot();

// Обробка помилок
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Сталася помилка. Спробуйте ще раз або зверніться до підтримки.');
});
