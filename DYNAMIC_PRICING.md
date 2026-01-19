# 💱 Динамічна ціна - Архітектура

## Як тепер працює

### 1. **Models (config/models.js)**
Містить тільки базові ціни в USD:
```javascript
starter: {
  price: 299,        // Telegram Stars (оригінальна - для інформації)
  priceUSD: 7,       // Базова ціна в USD
  tokens: 240        // Кількість токенів
}
```

### 2. **Три джерела динамічних курсів:**

#### 💱 Exchange Rate API (USD/UAH)
- **Джерело:** ПриватБанк або НБУ
- **Оновлення:** кожну годину
- **Фолбек:** дефолтний курс 45 UAH

#### ⭐ Telegram Stars API (USD/TGStar)
- **Джерело:** Telegram Bot API (getStarRate)
- **Оновлення:** кожну годину
- **Фолбек:** дефолтний курс 0.024 USD
- **Сервіс:** `services/telegramStars.js`

#### 💳 LiqPay (USD/UAH)
- **Розрахунок:** priceUSD × exchangeRate
- **Приклад:** 7 USD × 45 = 315 ₴

### 3. **API Plans (/api/plans)**
Повертає динамічні ціни обома методами:
```javascript
{
  "plans": {
    "starter": {
      "priceUSD": 7,
      "priceStarsDynamic": 292,      // 7 / 0.024 = 292 ⭐
      "priceUAHDynamic": 315,        // 7 * 45 = 315 ₴
      "exchangeRate": 45,
      "tgStarRate": 0.024            // Динамічно з Telegram API!
    }
  },
  "rates": {
    "USD/UAH": 45,
    "USD/TGStar": "0.0240"          // Динамічна ціна TG Stars
  }
}
```

### 4. **Фронтенд (liqpay-checkout.html, stripe-checkout.html)**
- Завантажує дані з `/api/plans`
- Отримує динамічні ціни для обох методів оплати
- Показує ціни з поточними курсами

### 5. **LiqPay Checkout API (/api/liqpay/checkout)**
Розраховує суму в гривнях на сервері:
```javascript
const rate = await exchangeRate.getRate();  // Реальний курс USD/UAH
const amountUAH = Math.round(sub.priceUSD * rate);  // Динамічна сума
```

---

## Розрахунки

### STARTER план (7$)
- **Telegram Stars:** 7 / 0.024 = ~292⭐ (замість 299⭐)
- **LiqPay:** 7 × 45 = 315₴ (замість 199₴)

### PREMIUM план (110$)
- **Telegram Stars:** 110 / 0.024 = ~4583⭐ (замість 4999⭐)
- **LiqPay:** 110 × 45 = 4950₴ (замість 1999₴)

---

## Потік даних

```
User -> /api/plans
   ↓
1. Отримуємо USD/UAH курс (ПриватБанк)
2. Отримуємо USD/TGStar курс (Telegram Bot API)
   ↓
Розраховуємо:
- priceStarsDynamic = priceUSD / tgStarRate
- priceUAHDynamic = priceUSD * uahRate
   ↓
Повертаємо з обома цінами
   ↓
Фронтенд показує:
⭐ 292 Telegram Stars
💳 315₴ LiqPay
   ↓
User вибирає спосіб оплати
   ↓
Успіх!
```

---

## Кешування

```
На старті сервера:
💱 Exchange rate cache → 1 USD = 45.00 UAH (свіже)
⭐ TG Stars cache → 1 Star = $0.0240 (свіже)

При запиті (менше за 1 годину):
💰 Using cached rate: 45.00 UAH (age: 5min)
⭐ Using cached rate: 0.0240 (age: 3min)

Після 1 години:
🔄 Fetching fresh exchange rate...
🔄 Fetching fresh Telegram Stars rate...
```

---

## Важливо!

⚠️ **BACKEND розраховує ціни, не фронтенд!**
- Фронтенд показує інформацію з API
- Фронтенд НЕ розраховує курси
- Бекенд розраховує суми самостійно

✅ **Це забезпечує:**
- Безпеку (клієнт не може змінити ціну)
- Актуальність (завжди свіжі курси)
- Справедливість (користувач платить реальну ціну)


