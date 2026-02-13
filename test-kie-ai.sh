#!/bin/bash

# Quick Test Script for KIE.AI Integration
# Простий скрипт для тестування KIE.AI

set -e

echo "🧪 KIE.AI Integration Test"
echo "==========================="
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "❌ .env файл не знайдено!"
    echo "Будь ласка, скопіюйте .env.example в .env та заповніть параметри"
    exit 1
fi

# Check if KIE_AI_API_KEY is set
if grep -q "KIE_AI_API_KEY=" .env; then
    KIE_KEY=$(grep "KIE_AI_API_KEY=" .env | cut -d '=' -f2)
    if [ -z "$KIE_KEY" ] || [ "$KIE_KEY" = "" ]; then
        echo "⚠️  KIE_AI_API_KEY не встановлена в .env"
        echo "    KIE.AI генерації будуть відключені"
        echo "    Система буде використовувати Replicate для всіх користувачів"
    else
        echo "✅ KIE_AI_API_KEY встановлена"
        echo "   KIE.AI буде доступна для адміністраторів"
    fi
else
    echo "⚠️  KIE_AI_API_KEY не знайдена в .env"
    echo "    Додайте цей параметр для активації KIE.AI"
fi

# Check ADMIN_TELEGRAM_ID
if grep -q "ADMIN_TELEGRAM_ID=" .env; then
    ADMIN_ID=$(grep "ADMIN_TELEGRAM_ID=" .env | cut -d '=' -f2)
    if [ -z "$ADMIN_ID" ] || [ "$ADMIN_ID" = "" ]; then
        echo "❌ ADMIN_TELEGRAM_ID не встановлена!"
        exit 1
    else
        echo "✅ ADMIN_TELEGRAM_ID: $ADMIN_ID"
        echo "   Тільки цей користувач матиме доступ до KIE.AI"
    fi
else
    echo "❌ ADMIN_TELEGRAM_ID не знайдена в .env"
    exit 1
fi

echo ""
echo "📋 Налаштування:"
echo "   - KIE.AI буде використовуватись ТІЛЬКИ для адміністратора"
echo "   - Інші користувачі будуть використовувати Replicate"
echo "   - Генерації через KIE.AI будуть залоговані як (KIE.AI)"
echo ""

echo "🚀 Як тестувати:"
echo "   1. Запустіть бота: npm run dev"
echo "   2. Напишіть боту від адміна: /start"
echo "   3. Виберіть модель та зробіть генерацію"
echo "   4. Перевірте логи для 'Using provider: KIE.AI'"
echo ""

echo "📊 Перевірка модулів..."

# Check if kie-ai.js exists
if [ -f "services/kie-ai.js" ]; then
    echo "✅ services/kie-ai.js існує"
else
    echo "❌ services/kie-ai.js НЕ знайдено!"
    exit 1
fi

# Check if index.js has KIE.AI imports
if grep -q "require('./services/kie-ai')" index.js; then
    echo "✅ KIE.AI імпортована в index.js"
else
    echo "❌ KIE.AI не імпортована в index.js"
    exit 1
fi

echo ""
echo "✅ Всі перевірки пройдені!"
echo "KIE.AI готова до використання!"

