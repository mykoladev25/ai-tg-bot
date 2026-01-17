#!/bin/bash

echo "🧪 Testing neuro-lab-ai-bot API..."
echo ""

BASE_URL="http://127.0.0.1:5500"

# Перевіряємо здоров'я сервера
echo "1️⃣ Testing health check..."
curl -s "$BASE_URL/health" | jq . 2>/dev/null || echo "❌ Health check failed"
echo ""

# Перевіряємо API планів
echo "2️⃣ Testing /api/plans endpoint..."
curl -s "$BASE_URL/api/plans" | jq . 2>/dev/null || echo "❌ Plans endpoint failed"
echo ""

# Перевіряємо Stripe checkout page
echo "3️⃣ Testing /pay/stripe page..."
curl -s -w "HTTP Status: %{http_code}\n" "$BASE_URL/pay/stripe?plan=starter" | head -n 1
echo ""

echo "✅ Testing complete!"

