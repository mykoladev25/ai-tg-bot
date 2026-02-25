#!/bin/bash

# 🚀 Manual Deploy Script
# Usage: ./deploy.sh

set -e  # Exit on error

SERVER="root@5.189.135.71"
APP_DIR="/var/www/ai-tg-bot"
PM2_APP="neurolab-bot"

echo "🚀 Starting deployment to neurolab.fun..."
echo ""

# SSH and run commands
ssh "$SERVER" << 'ENDSSH'
  set -e

  echo "📂 Navigating to app directory..."
  cd /var/www/ai-tg-bot

  echo "🔄 Fetching latest changes from main..."
  git fetch origin main
  git reset --hard origin/main

  echo "📦 Installing dependencies..."
  npm install --production --no-audit

  echo "♻️  Restarting PM2 process..."
  pm2 restart neurolab-bot --update-env

  echo "⏳ Waiting for app to start..."
  sleep 3

  echo ""
  echo "✅ Deployment completed!"
  echo ""

  echo "📊 PM2 Status:"
  pm2 list | grep neurolab || pm2 list

  echo ""
  echo "📝 Recent logs (last 30 lines):"
  pm2 logs neurolab-bot --lines 30 --nostream || true

  echo ""
  echo "🎉 Deploy finished successfully!"
ENDSSH

echo ""
echo "✨ All done! App is running on neurolab.fun"

