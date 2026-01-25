module.exports = {
  apps: [{
    name: 'neuro-lab-ai-bot',
    script: './index.js',
    instances: 1,
    exec_mode: 'fork',
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
    min_uptime: '10s',
    merge_logs: true,

    // ⚠️ Graceful shutdown - ВАЖЛИВО для генерацій!
    // Час очікування перед SIGKILL (30 секунд для завершення генерацій)
    kill_timeout: 35000,
    // Час очікування на listen (бот стартує)
    listen_timeout: 10000,
    // Не перезапускати одразу, дати час на shutdown
    restart_delay: 3000,
    // Надсилати SIGINT замість SIGTERM (коректніший для Node.js)
    shutdown_with_message: true,

    // Environment
    env_production: {
      NODE_ENV: 'production',
      PORT: 5500
    }
  }]
};

