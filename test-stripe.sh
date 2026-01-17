#!/bin/bash

# Тест Stripe інтеграції

echo "🧪 Тестування Stripe інтеграції..."
echo "=================================="

BASE_URL="http://127.0.0.1:5500"

# 1️⃣ Тест здоров'я сервера
echo ""
echo "1️⃣ Перевірка здоров'я сервера..."
curl -s "$BASE_URL/health" | jq . || echo "❌ Health check failed"

# 2️⃣ Тест отримання планів
echo ""
echo "2️⃣ Отримання доступних планів..."
curl -s "$BASE_URL/api/plans" | jq '.plans | keys' || echo "❌ Plans fetch failed"

# 3️⃣ Тест Stripe checkout page
echo ""
echo "3️⃣ Тест сторінки Stripe checkout для starter плану..."
STRIPE_PAGE=$(curl -s -w "%{http_code}" "$BASE_URL/pay/stripe?plan=starter")
echo "HTTP Status: $(echo "$STRIPE_PAGE" | tail -c 4)"

# 4️⃣ Тест API checkout (без дійсного sessionId)
echo ""
echo "4️⃣ Тест API checkout для користувача..."
curl -s -X POST "$BASE_URL/api/stripe/checkout" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "1234567890",
    "plan": "starter",
    "tokens": 240,
    "amount": 299
  }' | jq '.success' || echo "❌ Checkout API failed"

echo ""
echo "=================================="
echo "✅ Тестування завершено!"

