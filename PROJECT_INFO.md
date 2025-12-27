# 📂 Структура проекту neuro\u200B.lab\u200B.ai Bot

## 📁 Кореневі файли

### package.json
Конфігурація Node.js проекту з залежностями:
- telegraf - Telegram Bot Framework
- @anthropic-ai/sdk - Claude API
- axios - HTTP клієнт
- dotenv - Змінні середовища

### index.js (25KB)
**Головний файл бота** з усією логікою:
- Ініціалізація бота
- Обробка команд (/start, /help, /profile, тощо)
- Обробка текстових повідомлень
- Обробка фото
- Callback handlers для всіх кнопок
- Генерація контенту через AI моделі
- Система платежів через Telegram Stars
- Управління станом користувачів

### .env.example
Шаблон для змінних середовища:
- BOT_TOKEN - Токен Telegram бота
- ANTHROPIC_API_KEY - Ключ Claude API
- MIDJOURNEY_API_KEY - Ключ Midjourney API
- REPLICATE_API_KEY - Ключ Replicate API

### .gitignore
Список файлів для ігнорування git:
- node_modules/
- .env
- data/
- logs/

---

## 📁 config/

### models.js (3.5KB)
**Конфігурація всіх AI моделей:**

```javascript
{
  gpt: {
    models: [...],      // Claude, GPT моделі
    actions: [...]      // Дії (текст, голос, зображення)
  },
  video: {
    models: [...]       // Kling, Runway, Luma, тощо
  },
  design: {
    models: [...]       // Midjourney, Flux, Stable Diffusion
  },
  audio: {
    models: [...]       // Suno, Udio, ElevenLabs
  },
  subscriptions: {
    basic: {...}        // Параметри підписки
  }
}
```

Кожна модель має:
- name - Назва для відображення
- key - Унікальний ідентифікатор
- cost - Вартість в токенах

---

## 📁 services/

### claude.js (2.5KB)
**Інтеграція з Claude API:**

Функції:
- `chatWithClaude(message, history)` - Текстова розмова
- `analyzeImageWithClaude(imageBase64, prompt)` - Аналіз зображень
- `continueConversation(userMessage, history)` - Продовження діалогу

Використовує:
- @anthropic-ai/sdk
- model: claude-sonnet-4-20250514
- max_tokens: 4096

### midjourney.js (5KB)
**Інтеграція з Midjourney API:**

Функції:
- `generateImage(prompt)` - Генерація зображення
- `upscaleImage(taskId, index)` - Upscale варіанту
- `variateImage(taskId, index)` - Створення варіацій

Процес:
1. POST /imagine - створення задачі
2. Polling GET /result/:taskId - очікування результату
3. Повернення URL зображення

Час генерації: ~30-60 секунд

### replicate.js (8KB)
**Інтеграція з Replicate API для Flux, Kling, Runway:**

Функції:
- `generateWithFlux(prompt)` - Flux генерація зображень
- `generateVideoWithKling(prompt, imageUrl)` - Kling відео
- `generateVideoWithRunway(prompt, imageUrl)` - Runway відео
- `generateWithStableDiffusion(prompt)` - SD генерація

Всі функції використовують polling pattern:
1. POST /predictions - створення
2. GET /predictions/:id - перевірка статусу
3. Повторювати до "succeeded" або "failed"

Час генерації:
- Зображення: 10-30 секунд
- Відео: 2-5 хвилин

---

## 📁 utils/

### keyboard.js (4KB)
**Генератори клавіатур для Telegram:**

Функції:
- `createMainMenu()` - Головне меню (Reply Keyboard)
- `createInlineMenu(buttons, columns)` - Inline кнопки
- `createBackButton(callback)` - Кнопка "Назад"
- `createGPTActionsMenu()` - Меню GPT дій
- `createSubscriptionMenu()` - Меню підписки
- `createPaymentMenu(price)` - Меню оплати
- `createGenerationActionsMenu(taskId)` - U1-U4, V1-V4 для MJ
- `createConfirmationMenu(action)` - Підтвердження дії

### userBalance.js (5.5KB)
**Система балансу користувачів (in-memory):**

Дані користувача:
```javascript
{
  id: Number,
  tokens: Number,
  subscription: String,
  subscriptionExpiry: Date,
  conversationHistory: Array,
  currentModel: String,
  history: Array,
  createdAt: Date,
  lastActivity: Date
}
```

Функції:
- `getUser(userId)` - Отримати/створити користувача
- `hasTokens(userId, amount)` - Перевірка балансу
- `deductTokens(userId, amount, action)` - Відняти токени
- `addTokens(userId, amount, reason)` - Додати токени
- `setSubscription(userId, type, days)` - Встановити підписку
- `hasActiveSubscription(userId)` - Перевірка підписки
- `saveConversationMessage(userId, role, content)` - Зберегти повідомлення
- `getConversationHistory(userId)` - Отримати історію
- `clearConversationHistory(userId)` - Очистити історію
- `setCurrentModel(userId, modelKey)` - Встановити модель
- `getCurrentModel(userId)` - Отримати модель
- `getTransactionHistory(userId, limit)` - Історія транзакцій
- `getUserStats(userId)` - Статистика користувача
- `getAllUsers()` - Всі користувачі (для адміна)
- `getActiveUsersCount(hoursAgo)` - Активні користувачі

### database.js (3.5KB)
**Утиліти для збереження даних в файл:**

Функції:
- `initDataDir()` - Створити data/ директорію
- `saveUsersToFile(usersMap)` - Зберегти в data/users.json
- `loadUsersFromFile()` - Завантажити з data/users.json
- `setupPeriodicSave(usersMap, minutes)` - Автозбереження
- `setupExitHandler(usersMap)` - Збереження при виході
- `createBackup()` - Створити backup
- `cleanOldBackups(keepLast)` - Видалити старі backups

---

## 📁 handlers/ (порожня)
Директорія для майбутніх handler файлів:
- menuHandler.js
- gptHandler.js
- videoHandler.js
- designHandler.js
- paymentHandler.js

---

## 📄 Документація

### README.md (8KB)
Повна документація проекту:
- Опис можливостей
- Інструкції встановлення
- Як отримати API ключі
- Структура проекту
- Основні функції
- Приклади коду
- Розширення функціоналу
- TODO список
- Деплой інструкції

### QUICKSTART.md (5KB)
Швидкий старт за 7 кроків:
1. Встановлення залежностей
2. Отримання Bot Token
3. Отримання Claude API Key
4. Отримання Replicate Key
5. Налаштування .env
6. Запуск бота
7. Тестування

Включає секцію з типовими проблемами та рішеннями.

### EXAMPLES.md (11KB)
Детальні приклади використання:
- 12 базових сценаріїв
- 3 складних use cases
- Приклади промптів
- Поширені помилки
- Best practices

---

## 📊 Статистика проекту

**Загальний розмір:** ~104KB (без node_modules)
**Файлів коду:** 8 JavaScript файлів
**Рядків коду:** ~1,200 LOC
**Документації:** 4 markdown файли

**Основні залежності:**
```json
{
  "telegraf": "^4.16.3",
  "@anthropic-ai/sdk": "^0.32.1",
  "axios": "^1.6.2",
  "dotenv": "^16.3.1"
}
```

---

## 🔄 Потік даних

```
Користувач → Telegram
    ↓
Telegraf Bot (index.js)
    ↓
Перевірка балансу (userBalance.js)
    ↓
Вибір сервісу:
    ├→ claude.js → Anthropic API → Відповідь
    ├→ midjourney.js → MJ API → Зображення
    ├→ replicate.js → Replicate → Зображення/Відео
    ↓
Збереження транзакції (userBalance.js)
    ↓
Відправка результату → Telegram → Користувач
```

---

## 🚀 Швидке розгортання

```bash
# 1. Розпакувати архів
tar -xzf syntx-ai-bot.tar.gz
cd syntx-ai-bot

# 2. Встановити залежності
npm install

# 3. Налаштувати .env
cp .env.example .env
nano .env

# 4. Запустити
npm run dev
```

---

## 📝 Примітки

### Безпека:
- Всі API ключі в .env (не комітяться в git)
- Валідація вхідних даних
- Обробка помилок на всіх рівнях

### Масштабування:
- In-memory база → можна замінити на MongoDB/PostgreSQL
- Додавання нових моделей через config/models.js
- Модульна структура для легкого розширення

### Моніторинг:
- Console.log для базового логування
- Можна додати Winston/Bunyan
- Метрики через Prometheus

---

Створено для neuro\u200B.lab\u200B.ai Bot
Версія: 1.0.0
Дата: 16.12.2025
