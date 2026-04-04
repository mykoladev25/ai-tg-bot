const { getAdminIds } = require('../config/access');

async function notifyAdmin(bot, error, context = {}) {
  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    console.error('ADMIN_TELEGRAM_ID is not configured');
    return;
  }

  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
    let message = `🚨 <b>System error</b>\n\n🕐 ${timestamp} UTC\n\n`;

    if (context.userId) {
      message += `👤 User ID: ${context.userId}\n`;
    }
    if (context.username) {
      message += `👤 Username: @${context.username}\n`;
    }
    if (context.action) {
      message += `⚡ Action: ${context.action}\n`;
    }
    if (context.model) {
      message += `🤖 Model: ${context.model}\n`;
    }
    if (context.prompt) {
      message += `📝 Prompt: ${String(context.prompt).slice(0, 100)}...\n`;
    }

    message += `\n❌ <b>Error</b>\n<code>${error.message || error}</code>\n`;

    if (error.stack) {
      message += `\n📋 Stack\n<code>${error.stack.slice(0, 500)}...</code>`;
    }

    if (message.length > 4000) {
      message = `${message.slice(0, 3900)}\n\n... truncated`;
    }

    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'HTML'
      });
    }
  } catch (notifyError) {
    console.error('Failed to notify admin:', notifyError);
  }
}

async function notifyAdminInfo(bot, message) {
  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    return;
  }

  try {
    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'HTML'
      });
    }
  } catch (error) {
    console.error('Failed to notify admin:', error);
  }
}

module.exports = {
  notifyAdmin,
  notifyAdminInfo
};
