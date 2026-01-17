# ✅ Production Deployment Checklist

## 📋 Перед розгортанням на Production

### 1. 🔐 Безпека (.env)
- [ ] `NODE_ENV=production`
- [ ] `APP_URL=https://neurolab.fun` (не localhost!)
- [ ] Всі API ключі мають бути production ключами (не sandbox/test)
- [ ] `.env` файл НЕ закомічений в git (у `.gitignore`)
- [ ] STRIPE_SECRET_KEY починається з `sk_live_`
- [ ] STRIPE_PUBLISHABLE_KEY починається з `pk_live_`
- [ ] LIQPAY_PUBLIC_KEY починається з `pk_live_` (не `sandbox_`)
- [ ] LIQPAY_PRIVATE_KEY починається з `sk_live_` (не `sandbox_`)

### 2. 🌐 Domain & SSL
- [ ] Domain заповідано на neurolab.fun
- [ ] SSL сертифікат встановлений (LetsEncrypt)
- [ ] HTTPS працює без помилок
- [ ] Редирект HTTP → HTTPS налаштований

### 3. 📡 Nginx
- [ ] Nginx конфіг скопійований в `/etc/nginx/sites-available/neurolab.fun`
- [ ] Конфіг активований: `sudo ln -s sites-available/neurolab.fun sites-enabled/`
- [ ] `sudo nginx -t` пройшов без помилок
- [ ] `sudo systemctl reload nginx` успішно виконаний
- [ ] Nginx слухає на портах 80 та 443

### 4. 🚀 Node.js Server
- [ ] PM2 встановлений: `npm install -g pm2`
- [ ] `ecosystem.config.js` розташований в кореневій директорії
- [ ] Dependencies встановлені: `npm install`
- [ ] Тестовий запуск: `NODE_ENV=production npm run dev` - без помилок
- [ ] PM2 конфіг завантажений: `pm2 start ecosystem.config.js`
- [ ] Сохранено для автозапуску: `pm2 save` + `pm2 startup`
- [ ] Порт 5500 слухає: `sudo lsof -i :5500`

### 5. 🗄️ MongoDB
- [ ] MongoDB доступна з серверу
- [ ] `MONGODB_URI` в .env правильна
- [ ] Тест підключення успішний

### 6. 💳 Payment Systems

#### Stripe
- [ ] Live API ключі встановлені
- [ ] Webhook зареєстрований: `https://neurolab.fun/webhook/stripe`
- [ ] Webhook Secret встановлено в .env
- [ ] Тестовий платіж пройшов успішно

#### LiqPay
- [ ] Production ключі встановлені в LiqPay Адміністраторі
- [ ] Production ключі скопійовані в .env
- [ ] Webhook зареєстрований: `https://neurolab.fun/webhook/liqpay`
- [ ] Webhook активний в LiqPay Settings
- [ ] Тестовий платіж пройшов успішно

### 7. 🤖 Telegram Bot
- [ ] Bot Token правильний
- [ ] Bot Username в .env правильна
- [ ] Admin Telegram ID встановлено
- [ ] Test сповіщення приходить в Telegram при старті

### 8. ✅ Testing

#### Health Check
```bash
curl https://neurolab.fun/health
# Очікується: {"status":"ok","timestamp":"..."}
```

#### API Plans
```bash
curl https://neurolab.fun/api/plans
# Повинні прийти всі плани з ціною
```

#### Exchange Rate
```bash
curl https://neurolab.fun/api/exchange-rate
# Повинен прийти курс USD/UAH
```

#### LiqPay Checkout
```bash
curl https://neurolab.fun/pay/liqpay?plan=starter
# Повинна прийти HTML сторінка
```

#### Webhook Paths
```bash
# Stripe webhook
curl -X POST https://neurolab.fun/webhook/stripe -H "Content-Type: application/json"

# LiqPay webhook
curl -X POST https://neurolab.fun/webhook/liqpay -H "Content-Type: application/json"
```

### 9. 📊 Моніторинг

#### Налаштуйте логування
```bash
# Дивіться логи в реальному часі
pm2 logs neuro-lab-ai-bot

# Дивіться помилки nginx
sudo tail -f /var/log/nginx/neurolab_error.log

# Перевірте дисковий простір
df -h

# Перевірте оперативну пам'ять
free -h
```

#### Налаштуйте алерти (опціонально)
- [ ] Email алерти при краху процесу
- [ ] Disk space alerts (< 10% вільно)
- [ ] Memory usage alerts (> 80%)

### 10. 🔄 Backup & Recovery

#### MongoDB Backup
```bash
# Щодня о 2:00 ночи
0 2 * * * mongodump --uri="mongodb+srv://..." --out=/backups/mongo-$(date +\%Y\%m\%d)
```

#### Backup Scripts
- [ ] Налаштовано автоматичне резервне копіювання
- [ ] Логи-файлы архівуються
- [ ] Старі backup'и видаляються (> 30 днів)

### 11. 📝 Documentation

- [ ] PRODUCTION_DEPLOYMENT.md оновлено
- [ ] .env.example створено
- [ ] README містить інструкції для розгортання
- [ ] Credentials зберігаються безпечно (не в git)

### 12. 🧪 Final Testing

#### Повна послідовність тесту:
1. [ ] Запустіть сервер: `pm2 start ecosystem.config.js`
2. [ ] Перевірте здоров'я: `curl https://neurolab.fun/health`
3. [ ] Відкрийте сторінку LiqPay у браузері
4. [ ] Проведіть тестовий платіж через LiqPay
5. [ ] Перевірте повідомлення в Telegram
6. [ ] Перевірте, чи додалися токени
7. [ ] Перевірте логи без помилок

---

## 🚨 Emergency Procedures

### Якщо щось не працює:

```bash
# 1. Перевірте процес
pm2 status
pm2 logs neuro-lab-ai-bot --lines 100

# 2. Перезагрузіть процес
pm2 restart neuro-lab-ai-bot

# 3. Перевірте nginx
sudo systemctl status nginx
sudo nginx -t

# 4. Перезавантажте nginx
sudo systemctl reload nginx

# 5. Перевірте MongoDB
mongo --uri "mongodb+srv://..." --eval "db.adminCommand('ping')"

# 6. Перевірте порти
sudo netstat -tlnp | grep -E "80|443|5500"

# 7. Прочитайте помилки
sudo tail -f /var/log/nginx/neurolab_error.log
pm2 logs neuro-lab-ai-bot --err --lines 50
```

### Откат на попередню версію:

```bash
# 1. Зупиніть процес
pm2 stop neuro-lab-ai-bot

# 2. Встановіть попередню версію
git checkout <previous-commit>
npm install

# 3. Запустіть знову
pm2 restart neuro-lab-ai-bot

# 4. Перевірте
pm2 logs neuro-lab-ai-bot
```

---

## ✨ При успішному розгортанні:

- [ ] `https://neurolab.fun` працює без SSL помилок
- [ ] `https://neurolab.fun/health` повертає 200
- [ ] LiqPay форма завантажується
- [ ] Тестовий платіж пройшов
- [ ] Токени додалися користувачу
- [ ] Повідомлення прийшло в Telegram
- [ ] Логи чисті від помилок

🎉 **Production готовий до запуску!**

