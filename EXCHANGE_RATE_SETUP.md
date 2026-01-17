# 💱 Динамічний обмін валют для LiqPay

## Огляд

Система автоматично отримує актуальний курс USD/UAH від ПриватБанку та НБУ для динамічного розрахунку цін LiqPay у гривнях. Це гарантує, що ціни завжди відповідають реальному ринковому курсу.

## Архітектура

### 1. Exchange Rate Service (`services/exchangeRate.js`)

Сервіс відповідає за:
- ✅ Отримання курсу від ПриватБанку (основне джерело)
- ✅ Резервний варіант: НБУ (якщо ПриватБанк недоступний)
- ✅ Кешування курсу на 1 годину
- ✅ Автоматичний fallback на дефолтний курс (45 грн)

### 2. API Endpoints

#### GET `/api/exchange-rate`
Отримати поточний курс USD/UAH

**Response:**
```json
{
  "success": true,
  "rate": 45.67,
  "pair": "USD/UAH",
  "source": "PrivatBank/NBU",
  "timestamp": "2026-01-18T10:30:00.000Z"
}
```

#### GET `/api/plans`
Отримати плани з динамічними LiqPay цінами

**Response:**
```json
{
  "success": true,
  "exchangeRate": 45.67,
  "plans": {
    "starter": {
      "name": "STARTER",
      "tokens": 240,
      "price": 299,
      "priceUAH": 199,
      "priceUAHDynamic": 215,
      "exchangeRate": 45.67,
      "features": [...]
    },
    ...
  },
  "timestamp": "2026-01-18T10:30:00.000Z"
}
```

## Як працює розрахунок

### Формула розрахунку LiqPay ціни:

```
basePriceUSD = TelegramStarsPrice / 100 * 0.24
dynamicPriceUAH = basePriceUSD * currentExchangeRate
```

**Приклад:**
- Telegram Stars ціна: 299 ⭐
- Конвертація в USD: 299 / 100 * 0.24 = ~$0.72
- При курсі 45.67: 0.72 * 45.67 = ~33 грн
- Але використовуємо мінімум $10: 10 * 45.67 = ~457 грн

### Джерела даних про курс

#### 1. ПриватБанк (основне)
- **URL:** https://api.privatbank.ua/p24api/pubinfo?json&exchange&coursid=5
- **Переваги:** швидше, більш актуальний
- **Формат:** JSON з купівлею/продажем
- **Розрахунок:** середина між buy/sale

#### 2. НБУ (резервне)
- **URL:** https://bank.gov.ua/NBUStatService/v1/statdataandtimeofchange?valuecode=USD
- **Переваги:** офіційний курс центробанку
- **Недолік:** можна опновлюється раз на день

## Кешування

Курс кешується на **1 годину** для зменшення навантаження на API:

```javascript
// Якщо кеш свіжий (< 1 години), використовуємо його
if (cacheAge < 3600000) {
  return cachedRate;
}

// Інакше отримуємо новий курс
const newRate = await fetchNewRate();
```

## Fallback механізм

Якщо обидва API недоступні:
1. Використовуємо старий кешований курс (якщо є)
2. Якщо немає кешу - використовуємо дефолтний 45 грн
3. Система продовжує працювати, але з можливо неактуальним курсом

```javascript
try {
  rate = await getFromPrivatBank();
} catch {
  rate = await getFromNBU();
}
// Якщо обидва не працюють:
rate = cachedRate || 45;
```

## Обновлення LiqPay Webhook

Webhook обробляє платежі з динамічними цінами:

```javascript
// Webhook отримує order_id з курсом
const orderId = `${userId}_${plan}_${timestamp}`;

// LiqPay повертає реальну суму в гривнях
const amount = paymentData.amount; // напр. 215 грн

// Розраховуємо токени на основі суми
const tokens = calculateTokensByAmount(amount);
```

## Моніторинг та логування

Система логує всі операції:

```
🔄 Fetching fresh exchange rate...
💱 ПриватБанк курс USD/UAH: 45.67
💱 Calculated LiqPay prices at rate 45.67: { starter: 215, basic: 537, ... }
💱 Using cached rate: 45.67 (age: 1234s)
⚠️ PrivatBank API failed, trying NBU...
❌ Both exchange rate APIs failed
⚠️ Using stale cached rate: 45.67
⚠️ Using default rate: 45
```

## Конфігурація

Змінні оточення в `.env`:

```env
# За замовчуванням дефолтний курс (якщо API недоступні)
EXCHANGE_RATE_DEFAULT=45

# Час кешування (мс) - за замовчуванням 1 година
EXCHANGE_RATE_CACHE_TTL=3600000
```

## Приклад використання

### 1. Отримати ціни в фронтенді (liqpay-checkout.html)

```javascript
// Завантажити плани з динамічними цінами
const response = await fetch('/api/plans');
const data = await response.json();

// data.plans.starter.priceUAHDynamic = 215 (реальна ціна в гривнях)
// data.exchangeRate = 45.67 (поточний курс)
```

### 2. Показати курс у меню

```javascript
// На LiqPay сторінці
console.log(`💱 Поточний курс USD/UAH: ${data.exchangeRate.toFixed(2)}`);
```

### 3. Перевірити курс вручну

```bash
curl http://127.0.0.1:5500/api/exchange-rate | jq .
```

## Тестування

### 1. Тест отримання курсу

```bash
# Очікуємо курс ~45+
curl http://127.0.0.1:5500/api/exchange-rate

# Видповідь:
{
  "success": true,
  "rate": 45.67,
  "source": "PrivatBank/NBU"
}
```

### 2. Тест планів з динамічними цінами

```bash
curl http://127.0.0.1:5500/api/plans | jq '.plans.starter'

# Видповідь:
{
  "name": "STARTER",
  "tokens": 240,
  "price": 299,
  "priceUAHDynamic": 215,
  "exchangeRate": 45.67
}
```

## Проблеми та рішення

### Проблема: ціни не оновлюються
**Рішення:** очистити кеш та перезавантажити сторінку

```bash
# Логи помогут діагностувати
tail -f logs/bot.log | grep "exchange\|rate"
```

### Проблема: курс неправильний
**Рішення:**
1. Перевірити доступність ПриватБанку та НБУ
2. Перевірити відповідь API вручну
3. Встановити ручний курс в `.env`

## Майбутні поліпшення

- [ ] Додати інші джерела курсів (OpenExchangeRates, Xe.com)
- [ ] Кешувати курс в Redis (для масштабування)
- [ ] Додати історію курсів
- [ ] Налаштовувальні margin/комісія за конвертацію
- [ ] Вебхук від ПриватБанку для отримання курсу в реальному часі

