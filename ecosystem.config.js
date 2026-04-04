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
    out_file: '/var/log/pm2/neuro-lab-ai-bot-out.log',
    error_file: '/var/log/pm2/neuro-lab-ai-bot-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_memory_restart: '1G',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    merge_logs: true,
    kill_timeout: 35000,
    listen_timeout: 10000,
    restart_delay: 3000,
    shutdown_with_message: true,
    env_production: {
      NODE_ENV: 'production',
      PORT: 5500
    }
  }]
};
