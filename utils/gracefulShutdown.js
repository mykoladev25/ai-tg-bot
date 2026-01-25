/**
 * Graceful Shutdown Handler
 *
 * Відстежує активні генерації та забезпечує коректне завершення
 * при рестарті/зупинці бота (pm2 restart, SIGTERM, etc.)
 */

// Зберігаємо активні генерації
const activeGenerations = new Map(); // requestId -> { userId, chatId, model, startTime }

// Статус shutdown
let isShuttingDown = false;
let shutdownTimeout = null;

// Час очікування завершення генерацій (30 секунд)
const SHUTDOWN_TIMEOUT = 30 * 1000;

/**
 * Реєструє нову генерацію
 */
function registerGeneration(requestId, data) {
  if (isShuttingDown) {
    console.log(`⚠️ [Shutdown] Відхилено нову генерацію під час shutdown: ${requestId}`);
    return false;
  }

  activeGenerations.set(requestId, {
    ...data,
    startTime: Date.now()
  });

  console.log(`📝 [Generation] Registered: ${requestId} | Model: ${data.model} | User: ${data.userId}`);
  console.log(`📊 [Generation] Active: ${activeGenerations.size}`);

  return true;
}

/**
 * Завершує генерацію (успіх або помилка)
 */
function completeGeneration(requestId, success = true) {
  const gen = activeGenerations.get(requestId);
  if (gen) {
    const duration = ((Date.now() - gen.startTime) / 1000).toFixed(1);
    console.log(`${success ? '✅' : '❌'} [Generation] Completed: ${requestId} | ${duration}s | Active: ${activeGenerations.size - 1}`);
    activeGenerations.delete(requestId);
  }
}

/**
 * Отримати кількість активних генерацій
 */
function getActiveCount() {
  return activeGenerations.size;
}

/**
 * Отримати всі активні генерації
 */
function getActiveGenerations() {
  return Array.from(activeGenerations.entries()).map(([id, data]) => ({
    requestId: id,
    ...data,
    runningTime: Math.round((Date.now() - data.startTime) / 1000)
  }));
}

/**
 * Перевірити чи йде shutdown
 */
function isInShutdown() {
  return isShuttingDown;
}

/**
 * Ініціалізує graceful shutdown handlers
 * @param {Telegraf} bot - інстанс бота для надсилання повідомлень
 */
function initShutdownHandlers(bot) {
  const shutdown = async (signal) => {
    if (isShuttingDown) {
      console.log(`⚠️ [Shutdown] Already in progress...`);
      return;
    }

    isShuttingDown = true;
    console.log(`\n🛑 [Shutdown] Received ${signal}, starting graceful shutdown...`);
    console.log(`📊 [Shutdown] Active generations: ${activeGenerations.size}`);

    // Повідомляємо користувачів з активними генераціями
    if (activeGenerations.size > 0) {
      console.log(`📨 [Shutdown] Notifying users about pending generations...`);

      for (const [requestId, data] of activeGenerations) {
        try {
          await bot.telegram.sendMessage(
            data.chatId || data.userId,
            `⚠️ <b>Технічне оновлення</b>\n\n` +
            `Бот перезавантажується для оновлення.\n\n` +
            `🔄 Ваша генерація (<b>${data.model}</b>) могла не завершитись.\n` +
            `💡 Якщо ви не отримали результат — спробуйте ще раз через 1-2 хвилини.\n\n` +
            `Вибачте за незручності! 🙏`,
            { parse_mode: 'HTML' }
          );
          console.log(`📨 [Shutdown] Notified user ${data.userId} about ${requestId}`);
        } catch (err) {
          console.error(`❌ [Shutdown] Failed to notify user ${data.userId}:`, err.message);
        }
      }
    }

    // Чекаємо завершення активних генерацій (макс SHUTDOWN_TIMEOUT)
    if (activeGenerations.size > 0) {
      console.log(`⏳ [Shutdown] Waiting for ${activeGenerations.size} generations to complete (max ${SHUTDOWN_TIMEOUT/1000}s)...`);

      const startWait = Date.now();
      while (activeGenerations.size > 0 && (Date.now() - startWait) < SHUTDOWN_TIMEOUT) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`⏳ [Shutdown] Still waiting... Active: ${activeGenerations.size}`);
      }

      if (activeGenerations.size > 0) {
        console.log(`⚠️ [Shutdown] Timeout! ${activeGenerations.size} generations were interrupted.`);
      }
    }

    console.log(`✅ [Shutdown] Graceful shutdown complete. Exiting...`);

    // Зупиняємо бота
    try {
      await bot.stop(signal);
    } catch (err) {
      console.error('Error stopping bot:', err.message);
    }

    process.exit(0);
  };

  // Обробники сигналів
  process.once('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
  process.once('SIGTERM', () => shutdown('SIGTERM')); // pm2 stop/restart
  process.once('SIGUSR2', () => shutdown('SIGUSR2')); // nodemon restart

  console.log('✅ [Shutdown] Graceful shutdown handlers initialized');
}

/**
 * Генерує унікальний ID для генерації
 */
function generateRequestId() {
  return `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = {
  registerGeneration,
  completeGeneration,
  getActiveCount,
  getActiveGenerations,
  isInShutdown,
  initShutdownHandlers,
  generateRequestId
};

