const activeGenerations = new Map();

let isShuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 30 * 1000;

function registerGeneration(requestId, data) {
  if (isShuttingDown) {
    console.log(`[Shutdown] Rejected new generation during shutdown: ${requestId}`);
    return false;
  }

  activeGenerations.set(requestId, {
    ...data,
    startTime: Date.now()
  });

  console.log(`[Generation] Registered ${requestId}. Active: ${activeGenerations.size}`);
  return true;
}

function completeGeneration(requestId, success = true) {
  const generation = activeGenerations.get(requestId);
  if (!generation) {
    return;
  }

  const durationSeconds = ((Date.now() - generation.startTime) / 1000).toFixed(1);
  console.log(`[Generation] ${success ? 'Completed' : 'Failed'} ${requestId} in ${durationSeconds}s. Active: ${activeGenerations.size - 1}`);
  activeGenerations.delete(requestId);
}

function getActiveCount() {
  return activeGenerations.size;
}

function getActiveGenerations() {
  return Array.from(activeGenerations.entries()).map(([requestId, data]) => ({
    requestId,
    ...data,
    runningTime: Math.round((Date.now() - data.startTime) / 1000)
  }));
}

function isInShutdown() {
  return isShuttingDown;
}

function generateRequestId() {
  return `gen_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function initShutdownHandlers(bot) {
  const shutdown = async (signal) => {
    if (isShuttingDown) {
      console.log('[Shutdown] Already in progress');
      return;
    }

    isShuttingDown = true;
    console.log(`[Shutdown] Received ${signal}. Active generations: ${activeGenerations.size}`);

    if (activeGenerations.size > 0) {
      for (const [requestId, data] of activeGenerations) {
        try {
          await bot.telegram.sendMessage(
            data.chatId || data.userId,
            [
              '⚠️ <b>Maintenance update</b>',
              '',
              'The bot is restarting and your generation may not complete.',
              `Model: <b>${data.model}</b>`,
              'If you do not receive a result, retry in a minute.'
            ].join('\n'),
            { parse_mode: 'HTML' }
          );
          console.log(`[Shutdown] Notified user ${data.userId} about ${requestId}`);
        } catch (error) {
          console.error(`[Shutdown] Failed to notify user ${data.userId}:`, error.message);
        }
      }
    }

    if (activeGenerations.size > 0) {
      const startedWaitingAt = Date.now();
      while (activeGenerations.size > 0 && (Date.now() - startedWaitingAt) < SHUTDOWN_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    try {
      await bot.stop(signal);
    } catch (error) {
      console.error('Error stopping bot:', error.message);
    }

    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGUSR2', () => shutdown('SIGUSR2'));

  console.log('Graceful shutdown handlers initialized');
}

module.exports = {
  completeGeneration,
  generateRequestId,
  getActiveCount,
  getActiveGenerations,
  initShutdownHandlers,
  isInShutdown,
  registerGeneration
};
