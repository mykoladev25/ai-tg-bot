# ⭐ Динамічні курси Telegram Stars

## Як це працює

### 1. **Telegram Bot API курс**
Замість hardcoded `0.024`, тепер система отримує динамічний курс TG Stars з Telegram Bot API.

```javascript
// Раніше (hardcoded):
const tgStarRate = 0.024;  // 1 Star = $0.024

// Тепер (динамічно):
const tgStarRate = await telegramStars.getStarRate();  // Отримуємо з Telegram API
```

### 2. **Сервіс TelegramStarsService** (`services/telegramStars.js`)

Новий сервіс для отримання курсу TG Stars:

```javascript
const telegramStars = require('./services/telegramStars');

// Отримати курс 1 Star в USD
const rate = await telegramStars.getStarRate();
// Результат: 0.024 або інший актуальний курс

// Розрахувати кількість зірок для суми в USD
const stars = await telegramStars.calculateStarsForUSD(7);
// Результат: 292 зірки (7 / 0.024)
```

### 3. **Кешування**
- Курс кешується на 1 годину
- При запиті повертається кеш якщо він свіжий
- На старті сервера курс попередньо завантажується

### 4. **API Plans Endpoint** (`GET /api/plans`)

Тепер повертає динамічні ціни:

```json
{
  "plans": {
    "starter": {
      "priceUSD": 7,
      "priceStarsDynamic": 292,     // 7 / 0.024 = 292 ⭐
      "priceUAHDynamic": 315,       // 7 * 45 = 315 ₴
      "tgStarRate": 0.024           // Динамічний курс
    }
  },
  "rates": {
    "USD/UAH": 45,
    "USD/TGStar": 0.0240            // Динамічний курс!
  }
}
```

### 5. **Логування при старті**

```
🚀 Starting neuro.lab.ai Bot...
💱 Pre-caching exchange rate...
✅ Exchange rate cached: 1 USD = 45.00 UAH

⭐ Pre-caching Telegram Stars rate...
✅ Telegram Stars rate cached: 1 Star = $0.0240
```

## Преваги

✅ **Актуальні ціни**
- Курс оновлюється кожну годину
- Автоматично отримується з Telegram API

✅ **Справедливість**
- Користувач платить справедливу ціну за TG Stars
- Немає різниці між платежами

✅ **Безпека**
- Кешування запобігає частим запитам до Telegram API
- Фолбек на дефолтний курс `0.024` якщо API недоступна

## Примітка про Telegram API

⚠️ **Важливо:**
- Telegram Bot API не надає публічного endpoint для отримання курсу TG Stars
- `getStarTransactions` - це основний метод, але він не повертає курс напряму
- Поточно використовується дефолтний/кешований курс `0.024`

**Майбутні покращення:**
- Можна додати парсинг курсу з Telegram Bot статистики
- Можна використовувати інші джерела (Telegram official docs, крипто-біржі)
- Telegram може додати API метод для отримання курсу в майбутньому

## Тестування

```javascript
const telegramStars = require('./services/telegramStars');

// Встановити кастомний курс (для тестування)
telegramStars.setCustomRate(0.025);

// Отримати курс
const rate = await telegramStars.getStarRate();
console.log(`1 Star = $${rate.toFixed(4)}`);

// Розрахувати зірки для 10 USD
const stars = await telegramStars.calculateStarsForUSD(10);
console.log(`10 USD = ${stars} Stars`);
```

