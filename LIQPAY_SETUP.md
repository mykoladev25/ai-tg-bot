# 💳 LiqPay Integration Guide

## Що таке LiqPay?

**LiqPay** - це український платіжний шлюз, який дозволяє приймати платежі карткою, мобільними гаманцями та інші способи оплати.

## Налаштування LiqPay

### 1. Реєстрація на LiqPay

1. Перейдіть на https://www.liqpay.ua/admin/business
2. Зареєструйтеся або увійдіть в свій акаунт
3. Пройдіть верифікацію як бізнес

### 2. Отримання API ключів

1. Перейдіть в **Адміністрування** → **API**
2. Скопіюйте:
   - **Public Key** (публічний ключ)
   - **Private Key** (приватний ключ)

### 3. Налаштування вебхука

1. У розділі **Webhooks** додайте новий вебхук:
   - **URL:** `https://neurolab.fun/webhook/liqpay`
   - **Тип:** `POST`
   - **События:** Выберите "payment_success" и "payment_failure"

2. Скопіюйте вебхук-URL у ваш файл `.env`:

### 4. Оновлення `.env` файлу

```env
# ==================== LIQPAY CONFIGURATION ====================
# LiqPay Merchant Public Key (з https://www.liqpay.ua/admin/business)
LIQPAY_PUBLIC_KEY=pk_live_xxxxxxxxxxxxxxxxxxxxxxxx

# LiqPay Merchant Private Key
LIQPAY_PRIVATE_KEY=sk_live_xxxxxxxxxxxxxxxxxxxxxxxx

# LiqPay Server URL
LIQPAY_SERVER_URL=https://www.liqpay.ua/api/3
```

### 5. Тестування в режимі sandbox

Для тестування використовуйте тестові ключі:

```env
LIQPAY_PUBLIC_KEY=pk_test_xxxxxxxxxxxxxxxxxxxxxxxx
LIQPAY_PRIVATE_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxx
```

Тестові карти:
- **Карта:** 4111 1111 1111 1111
- **Дата:** Будь-яка майбутня дата (напр. 12/25)
- **CVV:** Будь-яке 3-значне число (напр. 123)

## Особливості реалізації

### API Endpoints

#### Checkout сторінка
```
GET /pay/liqpay?plan=starter&userId=1017736637
```

####창 checkout API
```
POST /api/liqpay/checkout
Content-Type: application/json

{
  "userId": "1017736637",
  "plan": "starter",
  "amount": 99,
  "tokens": 240
}

Response:
{
  "success": true,
  "checkoutUrl": "https://www.liqpay.ua/api/3/checkout?data=...",
  "orderId": "1017736637_starter_1234567890"
}
```

#### Webhook обробник
```
POST /webhook/liqpay
Content-Type: application/json

{
  "data": "base64_encoded_payment_data",
  "signature": "hashed_signature"
}
```

### Безпека

1. **Підпис верифікації:** Кожна транзакція від LiqPay підписується приватним ключем
2. **Порядок підпису:** `private_key + base64_data + private_key` → SHA1 хеш
3. **Verifikacija:** Бот перевіряє підпис перед кредитуванням токенів

### Формат замовлення (Order ID)

```
{userId}_{planKey}_{timestamp}

Приклад: 1017736637_starter_1704960000000
```

## Налаштування меню платіжних методів

У файлі `utils/keyboard.js` функція `createPaymentMenu()` містить кнопку LiqPay:

```javascript
[Markup.button.url(`💳 LiqPay (Карта/Apple/Google)`, liqpayUrl)],
```

## Обробка платежів

### Успішний платіж

При успішному платежі:
1. Вебхук отримує дані від LiqPay
2. Бот перевіряє підпис
3. Токени додаються на рахунок користувача
4. Відправляється повідомлення користувачу

### Невдалий платіж

Якщо платіж не вдався:
- Користувачу надсилається сповіщення
- Токени НЕ додаються
- Замовлення залишається в статусі "failed"

## Способи оплати, які підтримуються LiqPay

- 💳 Карти (Visa, Mastercard)
- 🍎 Apple Pay
- 🔷 Google Pay
- 🏦 ПриватБанк (Приват24)
- 💸 Інші способи

## Дебаг та логування

Все протоколюється в консоль:

```
📄 LiqPay checkout page requested: plan=starter
✅ LiqPay checkout created for user 1017736637: order_id=1017736637_starter_1234567890
📡 LiqPay callback received: {status: 'success', order_id: '...', amount: 99}
✅ Subscription processed: STARTER for user 1017736637
```

## Документація LiqPay

- 📖 [LiqPay API Documentation](https://www.liqpay.ua/en/doc)
- 🔐 [Security & Signatures](https://www.liqpay.ua/en/doc/en/authentication)
- 🛠️ [REST API Reference](https://www.liqpay.ua/en/doc/en/pay)

## Поширені проблеми

### Вебхук не приймає платежі

- Перевірте, що URL вебхука правильний (має бути HTTPS у продакшені)
- Перевірте, що вебхук активний в адміністраторі LiqPay
- Перевірте логи серверу для помилок

### Помилка верифікації підпису

- Переконайтесь, що `LIQPAY_PRIVATE_KEY` правильно встановлений в `.env`
- Перевірте, що ключ не містить додатків пробілів

### Платіж успішний, але токени не додались

- Перевірте ідентифікатор користувача в замовленні
- Переконайтесь, що користувач існує в базі даних
- Перевірте логи MongoDB для помилок

## Контакт та підтримка

Якщо виникли питання:
- 📧 Email: support@neurolab.fun
- 💬 Telegram: @neuro_lab_ai_bot
- 📝 GitHub Issues: [посилання на репозиторій]

