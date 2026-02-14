/**
 * Відправка повідомлень адміну про помилки
 */

const { getAdminIds } = require('../config/access');

/**
 * Відправити помилку адмінам (усім з ADMIN_TELEGRAM_ID, ADMIN_TELEGRAM_ID_2, ...)
 */
async function notifyAdmin(bot, error, context = {}) {
    const adminIds = getAdminIds();
    if (adminIds.length === 0) {
        console.error('⚠️ ADMIN_TELEGRAM_ID not configured');
        return;
    }

    try {
        const timestamp = new Date().toLocaleString('uk-UA');

        let message = `🚨 <b>Системна помилка</b>\n\n`;
        message += `🕐 ${timestamp}\n\n`;

        // Контекст
        if (context.userId) {
            message += `👤 User ID: ${context.userId}\n`;
        }
        if (context.username) {
            message += `👤 Username: @${context.username}\n`;
        }
        if (context.action) {
            message += `⚡ Дія: ${context.action}\n`;
        }
        if (context.model) {
            message += `🤖 Модель: ${context.model}\n`;
        }
        if (context.prompt) {
            message += `📝 Промпт: ${context.prompt.substring(0, 100)}...\n`;
        }

        message += `\n❌ <b>Помилка:</b>\n`;
        message += `<code>${error.message || error}</code>\n\n`;

        // Stack trace (перші 500 символів)
        if (error.stack) {
            const stackPreview = error.stack.substring(0, 500);
            message += `📋 Stack:\n<code>${stackPreview}...</code>`;
        }

        // Обрізаємо якщо дуже довге (Telegram ліміт 4096)
        if (message.length > 4000) {
            message = message.substring(0, 3900) + '\n\n... (обрізано)';
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

/**
 * Відправити інфо усім адмінам
 */
async function notifyAdminInfo(bot, message) {
    const adminIds = getAdminIds();
    if (adminIds.length === 0) return;

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