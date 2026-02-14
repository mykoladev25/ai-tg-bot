# neuro\u200B.lab\u200B.ai Bot

Telegram бот з інтеграціями AI моделей: Claude, Midjourney, Flux, Runway та інші.

## 🚀 Можливості

- 💡 **GPT/Claude**: Текстові діалоги та аналіз зображень
- 🎨 **Генерація зображень**: Midjourney, Flux, Stable Diffusion
- 🎬 **Генерація відео**: Kling, Runway, Luma
- 💰 **Система токенів**: Власний баланс користувачів
- 💳 **Оплата**: Інтеграція з Telegram Stars
- 📊 **Статистика**: Історія використання

## 📦 Встановлення

### 1. Клонування репозиторію

```bash
git clone <your-repo>
cd syntx-ai-bot
```

### 2. Встановлення залежностей

```bash
npm install
```

### 3. Налаштування змінних середовища

Створіть файл `.env` на основі `.env.example`:

```bash
cp .env.example .env
```

### 4. Отримання API ключів

#### Telegram Bot Token
1. Знайдіть [@BotFather](https://t.me/botfather) в Telegram
2. Відправте `/newbot` і дотримуйтесь інструкцій
3. Скопіюйте отриманий токен

#### Anthropic (Claude) API
1. Зареєструйтесь на [console.anthropic.com](https://console.anthropic.com/)
2. Створіть API ключ в розділі API Keys
3. Додайте баланс на акаунт ($5 мінімум)

#### Replicate API (Flux, Kling, Runway)
1. Зареєструйтесь на [replicate.com](https://replicate.com/)
2. Перейдіть в [Account Settings](https://replicate.com/account/api-tokens)
3. Створіть новий API token
4. Додайте баланс для використання моделей

#### Midjourney API
Використовуйте один з сервісів:
- [MidjourneyAPI.io](https://www.midjourneyapi.io/)
- [GoAPI](https://www.goapi.ai/)
- Або власний Discord bot

#### KIE.AI (Kling 3.0 тощо)
1. Зареєструйтесь на [kie.ai](https://kie.ai/), отримайте API ключ.
2. У `.env` додайте: `KIE_AI_API_KEY=ваш_ключ`.
3. **Доступ**: `KIE_AI_ACCESS=admin_only` (за замовчуванням) — генерації KIE тільки для адміна; для всіх: `all_users`.
4. **Ціна**: вартість Kling 3.0 рахується з кешу `config/kie-ai-pricing-cache.json` з націнкою 30%. Щоб під тести використовувати фіксовані ціни з `config/models.js`, встановіть `KIE_AI_USE_CACHE_PRICING=false`.

## 🏃 Запуск

### Розробка (з автоперезапуском)
```bash
npm run dev
```

### Продакшн
```bash
npm start
```

## 📁 Структура проекту

```
syntx-ai-bot/
├── config/
│   └── models.js          # Конфігурація всіх AI моделей
├── services/
│   ├── claude.js          # Інтеграція з Claude API
│   ├── midjourney.js      # Інтеграція з Midjourney
│   └── replicate.js       # Інтеграція з Replicate (Flux, Kling, etc)
├── utils/
│   ├── keyboard.js        # Клавіатури Telegram
│   ├── userBalance.js     # Система балансу користувачів
│   └── database.js        # Збереження даних
├── index.js               # Головний файл бота
├── package.json
├── .env.example
└── README.md
```

## 🛠️ Основні функції

### Команди бота

- `/start` - Головне меню
- `/profile` - Ваш профіль
- `/balance` - Перевірити баланс
- `/history` - Історія використання
- `/clear` - Очистити історію розмови
- `/help` - Довідка

### Модулі

#### Claude (GPT)
```javascript
const claude = require('./services/claude');

// Текстова розмова
const response = await claude.chatWithClaude('Привіт!');

// Аналіз зображення
const analysis = await claude.analyzeImageWithClaude(imageBase64, 'Опиши це зображення');
```

#### Midjourney
```javascript
const midjourney = require('./services/midjourney');

// Генерація зображення
const result = await midjourney.generateImage('a beautiful sunset');

// Upscale
const upscaled = await midjourney.upscaleImage(taskId, 1);
```

#### Replicate (Flux, Kling, Runway)
```javascript
const replicate = require('./services/replicate');

// Flux - генерація зображення
const image = await replicate.generateWithFlux('cyberpunk city');

// Kling - генерація відео
const video = await replicate.generateVideoWithKling('walking through forest');

// Runway - генерація відео
const runway = await replicate.generateVideoWithRunway('cinematic shot');
```

## 💰 Система токенів

## 🔧 Розширення функціоналу

### Додавання нової AI моделі

1. Додайте конфігурацію в `config/models.js`:
```javascript
design: {
  models: [
    { name: '🆕 New Model', key: 'new_model', cost: 5 }
  ]
}
```

2. Створіть сервіс або додайте функцію в існуючий:
```javascript
async function generateWithNewModel(prompt) {
  // Ваша логіка
}
```

3. Додайте обробник в `index.js`:
```javascript
bot.action('new_model', async (ctx) => {
  // Обробка вибору моделі
});
```

### Підключення бази даних

```javascript
// Приклад з MongoDB
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  userId: Number,
  tokens: Number,
  subscription: String,
  // ...
});

const User = mongoose.model('User', UserSchema);
```

## 🐛 Відлагодження

Увімкніть детальне логування:

```javascript
// В index.js
bot.use((ctx, next) => {
  console.log('Update:', JSON.stringify(ctx.update, null, 2));
  return next();
});
```

## 📝 TODO

- [ ] Додати більше AI моделей
- [ ] Підключити реальну базу даних
- [ ] Додати адмін панель
- [ ] Метрики та аналітика
- [ ] Обробка голосових повідомлень
- [ ] Генерація аудіо (Suno, Udio)
- [ ] Промокоди
- [ ] Реферальна система

## 🤝 Підтримка

Якщо виникли питання або проблеми, створіть Issue в репозиторії.

## 📄 Ліцензія

MIT

## ⚠️ Важливо

- Не публікуйте `.env` файл в git
- Тримайте API ключі в секреті
- Регулярно робіть backup даних користувачів
- Слідкуйте за балансом API акаунтів
- Тестуйте на невеликій аудиторії перед запуском

## 🚀 Деплой

### На VPS/Dedicated Server

```bash
# Клонуйте репозиторій
git clone <your-repo>
cd syntx-ai-bot

# Встановіть залежності
npm install

# Налаштуйте .env

# Використовуйте PM2 для запуску
npm install -g pm2
pm2 start index.js --name syntx-bot
pm2 save
pm2 startup
```

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

CMD ["node", "index.js"]
```

```bash
docker build -t syntx-bot .
docker run -d --env-file .env syntx-bot
```

## 📊 Моніторинг

Рекомендовані інструменти:
- **PM2** - для управління процесами
- **Winston** - для логування
- **Prometheus + Grafana** - для метрик

---

Створено з ❤️ для neuro\u200B.lab\u200B.ai
# ai-tg-bot
# ai-tg-bot
