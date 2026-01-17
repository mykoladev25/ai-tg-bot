# 🚀 Розгортання на Продакшені (Production)

## Вимоги до Продакшену

- ✅ VPS/Хостинг з Node.js
- ✅ Nginx для проксування
- ✅ MongoDB (вже налаштована)
- ✅ HTTPS сертифікат (LetsEncrypt)
- ✅ PM2 або systemd для управління процесом

## Крок 1: Підготовка .env для Продакшену

Переконайтесь, що в `.env` файлі встановлено:

```env
NODE_ENV=production
APP_URL=https://neurolab.fun
PORT=5500

# LiqPay Production Keys (не sandbox!)
LIQPAY_PUBLIC_KEY=pk_live_YOUR_PRODUCTION_KEY
LIQPAY_PRIVATE_KEY=sk_live_YOUR_PRODUCTION_KEY
```

## Крок 2: Налаштування Nginx

Створіть конфіг `/etc/nginx/sites-available/neurolab.fun`:

```nginx
server {
    listen 443 ssl http2;
    server_name neurolab.fun;

    ssl_certificate /etc/letsencrypt/live/neurolab.fun/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/neurolab.fun/privkey.pem;

    # Безпека
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Компресія
    gzip on;
    gzip_types text/plain application/json;

    # Логи
    access_log /var/log/nginx/neurolab_access.log;
    error_log /var/log/nginx/neurolab_error.log;

    # Статичні файли
    location / {
        proxy_pass http://127.0.0.1:5500;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts для довгих запитів (генерація)
        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
    }

    # Webhook повинні мати більший timeout
    location /webhook/ {
        proxy_pass http://127.0.0.1:5500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}

# Редирект HTTP → HTTPS
server {
    listen 80;
    server_name neurolab.fun;
    return 301 https://$server_name$request_uri;
}
```

Активуйте конфіг:
```bash
sudo ln -s /etc/nginx/sites-available/neurolab.fun /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## Крок 3: Запуск Сервера з PM2

### Інсталюйте PM2:
```bash
sudo npm install -g pm2
```

### Створіть конфіг PM2 (`ecosystem.config.js`):
```javascript
module.exports = {
  apps: [{
    name: 'neuro-lab-ai-bot',
    script: './index.js',
    instances: 1,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 5500
    },
    // Логи
    out_file: '/var/log/pm2/neuro-lab-ai-bot-out.log',
    error_file: '/var/log/pm2/neuro-lab-ai-bot-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Автоперезагрузка при краху
    max_memory_restart: '1G',
    watch: false,
    // Автозапуск при перезавантаженні сервера
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
```

### Запустіть сервер:
```bash
pm2 start ecosystem.config.js

# Зберегти конфіг для автозапуску
pm2 save
pm2 startup

# Перевірити статус
pm2 status
pm2 logs neuro-lab-ai-bot
```

## Крок 4: Налаштування Webhook для LiqPay

### У LiqPay Адміністраторі:

1. Перейдіть в **Налаштування** → **Webhooks**
2. Додайте новий вебхук:
   - **URL:** `https://neurolab.fun/webhook/liqpay`
   - **Тип:** POST
   - **События:** payment_success, payment_failure

3. Перевірте SSL сертифікат - він повинен бути válid

## Крок 5: Перевірка

### Тестування локально (перед розгортанням):
```bash
# Перевіріть .env
cat .env | grep -E "APP_URL|NODE_ENV|LIQPAY"

# Запустіть локально в production режимі
NODE_ENV=production npm run dev
```

### Тестування на продакшені:
```bash
# Перевіріть здоров'я сервера
curl https://neurolab.fun/health

# Перевіріть API планів
curl https://neurolab.fun/api/plans

# Перевіріть exchange rate
curl https://neurolab.fun/api/exchange-rate

# Перевіріть LiqPay сторінку
curl https://neurolab.fun/pay/liqpay?plan=starter
```

## Крок 6: Налаштування SSL Сертифіката

### Якщо ще немає сертифіката, встановіть LetsEncrypt:
```bash
sudo apt-get install certbot python3-certbot-nginx

# Отримайте сертифікат
sudo certbot certonly --nginx -d neurolab.fun

# Автоновлення (за замовчуванням включено)
sudo systemctl enable certbot.timer
```

## Проблеми та Вирішення

### 1. nginx повертає 404
**Причина:** Nginx не проксує на Node.js
**Вирішення:**
```bash
# Перевірите конфіг nginx
sudo nginx -t

# Перевірите, чи Port 5500 слухає
sudo netstat -tlnp | grep 5500

# Перевірете логи nginx
sudo tail -f /var/log/nginx/neurolab_error.log
```

### 2. PM2 процес краються
**Причина:** Недостатньо пам'яті або помилка в коді
**Вирішення:**
```bash
# Дивіться логи
pm2 logs neuro-lab-ai-bot --lines 100

# Перезагрузіть процес
pm2 restart neuro-lab-ai-bot

# Перевірете пам'ять
free -h
```

### 3. LiqPay webhook не приймає платежі
**Причина:** HTTPS не налаштований або webhook URL неправильний
**Вирішення:**
```bash
# Перевірете SSL
curl -I https://neurolab.fun

# Тестуйте webhook вручну
curl -X POST https://neurolab.fun/webhook/liqpay \
  -H "Content-Type: application/json" \
  -d '{"data":"test","signature":"test"}'
```

## Моніторинг

### Дивіться логи в реальному часі:
```bash
pm2 logs neuro-lab-ai-bot

# Або через файли
tail -f /var/log/pm2/neuro-lab-ai-bot-out.log
tail -f /var/log/nginx/neurolab_error.log
```

### Налаштуйте резервні копії MongoDB:
```bash
# Щодня о 2:00 ночі
0 2 * * * mongodump --uri="mongodb+srv://..." --out=/backups/mongo-$(date +\%Y\%m\%d)
```

## Розгортання Оновлень

```bash
cd /path/to/neuro-lab-ai-bot

# Отримайте нову версію
git pull origin main

# Встановіть залежності
npm install

# Перезагрузіть PM2
pm2 restart neuro-lab-ai-bot

# Перевірете логи
pm2 logs neuro-lab-ai-bot --lines 50
```

## Список перевірки перед запуском на продакшені

- [ ] `.env` файл має `NODE_ENV=production`
- [ ] `.env` файл має `APP_URL=https://neurolab.fun`
- [ ] LiqPay keys - production keys (не sandbox)
- [ ] Stripe keys - live keys (не test)
- [ ] SSL сертифікат встановлений
- [ ] Nginx налаштований і запущений
- [ ] Node.js запущений через PM2
- [ ] Webhook зареєстрований в LiqPay
- [ ] MongoDB доступна
- [ ] Тестовий платіж пройшов успішно
- [ ] Повідомлення в Telegram приходить

## Контакт для підтримки

Якщо щось не працює:
1. Перевірте логи: `pm2 logs neuro-lab-ai-bot`
2. Перевірте nginx: `sudo tail -f /var/log/nginx/neurolab_error.log`
3. Перевірте MongoDB: `mongo`
4. Зв'яжіться з хостингом для перевірки портів

