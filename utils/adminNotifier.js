/**
 * Відправка повідомлень адміну про помилки
 */

const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

/**
 * Відправити помилку адміну
 */
async function notifyAdmin(bot, error, context = {}) {
    if (!ADMIN_TELEGRAM_ID) {
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

        await bot.telegram.sendMessage(ADMIN_TELEGRAM_ID, message, {
            parse_mode: 'HTML'
        });

    } catch (notifyError) {
        console.error('Failed to notify admin:', notifyError);
    }
}

/**
 * Відправити інфо адміну
 */
async function notifyAdminInfo(bot, message) {
    if (!ADMIN_TELEGRAM_ID) {
        return;
    }

    try {
        await bot.telegram.sendMessage(ADMIN_TELEGRAM_ID, message, {
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error('Failed to notify admin:', error);
    }
}

module.exports = {
    notifyAdmin,
    notifyAdminInfo
};