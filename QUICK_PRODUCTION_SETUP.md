# 🚀 Neuro.Lab.AI Bot - Production Deployment Guide

## 🎯 Що було зроблено

### ✅ LiqPay Інтеграція
- Динамічні ціни на основі реального курсу USD/UAH
- Webhook обробник для платежів
- Синхронне додавання токенів
- Повідомлення в Telegram

### ✅ Конфігураційні файли
Для розгортання на production створено:
- `ecosystem.config.js` - конфіг PM2
- `nginx.conf.example` - конфіг Nginx
- `PRODUCTION_DEPLOYMENT.md` - детальна інструкція
- `DEPLOYMENT_CHECKLIST.md` - чеклист перед запуском
- `.env.example` - приклад環境 змінних

## 🔧 Quick Start для Production

### 1. Завантажте проект на сервер
```bash
cd /path/to/deployment
git clone https://github.com/yourusername/neuro-lab-ai-bot.git
cd neuro-lab-ai-bot
```

### 2. Встановіть залежності
```bash
npm install
```

### 3. Налаштуйте .env
```bash
cp .env.example .env
# Відредагуйте .env з вашими production ключами
nano .env

# Важливо встановити:
# NODE_ENV=production
# APP_URL=https://neurolab.fun
# Всі API ключі (production, не test)
```

### 4. Налаштуйте Nginx
```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/neurolab.fun
sudo ln -s /etc/nginx/sites-available/neurolab.fun /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 5. Запустіть сервер з PM2
```bash
# Інсталюйте PM2 глобально
sudo npm install -g pm2

# Запустіть додаток
pm2 start ecosystem.config.js

# Збережіть конфіг
pm2 save
pm2 startup
```

### 6. Перевірте
```bash
# Health check
curl https://neurolab.fun/health

# API plans
curl https://neurolab.fun/api/plans

# LiqPay checkout
curl https://neurolab.fun/pay/liqpay?plan=starter
```

## 📋 Важливі кроки

### Перед запуском обов'язково:

1. **Оновіть API ключі у .env:**
   - [ ] STRIPE_SECRET_KEY = `sk_live_...` (не test!)
   - [ ] STRIPE_PUBLISHABLE_KEY = `pk_live_...`
   - [ ] LIQPAY_PUBLIC_KEY = `pk_live_...` (не sandbox!)
   - [ ] LIQPAY_PRIVATE_KEY = `sk_live_...` (не sandbox!)
   - [ ] Всі інші production ключи

2. **Налаштуйте webhook в LiqPay:**
   - Перейдіть в https://www.liqpay.ua/admin/business
   - Додайте webhook: `https://neurolab.fun/webhook/liqpay`
   - Вибідіть events: payment_success, payment_failure

3. **Налаштуйте webhook в Stripe:**
   - Перейдіть в https://dashboard.stripe.com/webhooks
   - Додайте endpoint: `https://neurolab.fun/webhook/stripe`
   - Вибідіть events: payment_intent.succeeded

4. **Переконайтесь:**
   - [ ] SSL сертифікат встановлений (HTTPS працює)
   - [ ] MongoDB доступна
   - [ ] Всі ports (80, 443, 5500) відкриті
   - [ ] NODE_ENV=production в .env

## 🔍 Моніторинг

### Дивіться логи:
```bash
# Реальний час
pm2 logs neuro-lab-ai-bot

# Помилки Nginx
sudo tail -f /var/log/nginx/neurolab_error.log

# Система
pm2 monit
```

### Перезавантажте при оновленні:
```bash
cd /path/to/deployment
git pull origin main
npm install
pm2 restart neuro-lab-ai-bot
```

## 🚨 Troubleshooting

### 404 на neurolab.fun
- Перевірте nginx конфіг: `sudo nginx -t`
- Перевірте, чи Node.js слухає: `sudo lsof -i :5500`
- Перевірте PM2 статус: `pm2 status`

### LiqPay платежі не обробляються
- Перевірте webhook зареєстрований в LiqPay
- Перевірте production ключи в .env
- Дивіться логи: `pm2 logs neuro-lab-ai-bot`

### Інші помилки
- Дивіться: PRODUCTION_DEPLOYMENT.md
- Дивіться: DEPLOYMENT_CHECKLIST.md

## 📚 Документація

- **PRODUCTION_DEPLOYMENT.md** - Детальна інструкція розгортання
- **DEPLOYMENT_CHECKLIST.md** - Чеклист перед запуском
- **LIQPAY_SETUP.md** - LiqPay конфігурація
- **EXCHANGE_RATE_SETUP.md** - Динамічні курси

## 🆘 Контакт для помощи

Якщо щось не працює:
1. Прочитайте документацію вище
2. Перевірте логи: `pm2 logs neuro-lab-ai-bot --err --lines 100`
3. Скопіюйте помилку та контактуйте розробника

---

**Успішного розгортання! 🚀**

