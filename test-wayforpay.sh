#!/bin/bash

# 🧪 WayForPay Integration Test Script
# Тестування всіх WayForPay endpoints

echo "🧪 Тестування WayForPay інтеграції..."
echo "===================================="

BASE_URL="http://127.0.0.1:5500"

# 1️⃣ Тест здоров'я сервера
echo ""
echo "1️⃣ Перевірка здоров'я сервера..."
curl -s "$BASE_URL/health" | jq . || echo "❌ Health check failed"

# 2️⃣ Тест отримання планів
echo ""
echo "2️⃣ Отримання доступних планів..."
curl -s "$BASE_URL/api/plans" | jq '.plans | keys' || echo "❌ Plans fetch failed"

# 3️⃣ Тест WayForPay checkout page
echo ""
echo "3️⃣ Тест сторінки WayForPay checkout для starter плану..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/pay/wayforpay?plan=starter&userId=123&tg_id=123")
echo "HTTP Status: $HTTP_CODE"
if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ WayForPay checkout page is accessible"
else
    echo "❌ WayForPay checkout page returned $HTTP_CODE"
fi

# 4️⃣ Тест API checkout для користувача
echo ""
echo "4️⃣ Тест API WayForPay checkout для користувача..."
CHECKOUT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/wayforpay/checkout" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "123",
    "plan": "starter",
    "tokens": 240,
    "amount": 149
  }')

echo "$CHECKOUT_RESPONSE" | jq . || echo "❌ Checkout API failed"

# 5️⃣ Тест webhook signature verification
echo ""
echo "5️⃣ Тест webhook (сигнатура)..."

# Формуємо тестові дані для webhook
MERCHANT_ACCOUNT="test_account"
ORDER_REFERENCE="123_starter_1234567890"
AMOUNT="149"
CURRENCY="UAH"
TRANSACTION_STATUS="Completed"
MERCHANT_KEY="test_key"

# Генеруємо MD5 сигнатуру (потрібен інший інструмент, curl не підтримує MD5 нативно)
# Це просто тестовий запит
WEBHOOK_RESPONSE=$(curl -s -X POST "$BASE_URL/webhook/wayforpay" \
  -H "Content-Type: application/json" \
  -d '{
    "merchantAccount": "'$MERCHANT_ACCOUNT'",
    "orderReference": "'$ORDER_REFERENCE'",
    "amount": '$AMOUNT',
    "currency": "'$CURRENCY'",
    "transactionStatus": "'$TRANSACTION_STATUS'",
    "transactionId": "test_transaction_123",
    "merchantSignature": "test_signature_invalid"
  }')

echo "$WEBHOOK_RESPONSE" | jq . || echo "Response: $WEBHOOK_RESPONSE"

# 6️⃣ Тест exchange rate
echo ""
echo "6️⃣ Отримання курсу обміну USD/UAH..."
curl -s "$BASE_URL/api/exchange-rate" | jq . || echo "❌ Exchange rate fetch failed"

# 7️⃣ Перевірка що WayForPay маршрути зареєстровані
echo ""
echo "7️⃣ Перевірка логів (очікуємо WayForPay повідомлень)..."
echo "Очікуемие логи:"
echo "  ✅ 'WayForPay checkout page requested: plan=starter'"
echo "  ✅ 'WayForPay checkout request'"
echo "  ✅ 'WayForPay webhook: (логування callback)'"

echo ""
echo "===================================="
echo "✅ Тестування завершено!"
echo ""
echo "💡 Порадди:"
echo "1. Перевірте що .env містить WAYFORPAY_MERCHANT_ACCOUNT та WAYFORPAY_MERCHANT_KEY"
echo "2. Додайте webhook URL у WayForPay Merchant Portal"
echo "3. Протестуйте платіж через бота"
echo ""
echo "📖 Документація: WAYFORPAY_SETUP.md"

