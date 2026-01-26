/**
 * Monitoring Alerts - сповіщення адміну при проблемах
 *
 * СЛОВНИК:
 * - COGS = Собівартість = скільки ми платимо за API
 * - Trial Burn = "Згоріло на безкоштовних" = API витрати на trial юзерів
 * - Fail Rate = Відсоток помилок генерації
 */

const aggregations = require('./aggregations');
const { DEFAULT_ALERT_FAIL_RATE_PCT } = require('../config/constants');

// Пороги для алертів (з .env або дефолтні)
const ALERT_COGS_USD_DAILY = parseFloat(process.env.ALERT_COGS_USD_DAILY) || 50;
const ALERT_TRIAL_BURN_USD_DAILY = parseFloat(process.env.ALERT_TRIAL_BURN_USD_DAILY) || 20;
const ALERT_FAIL_RATE_PCT = Number.isFinite(parseFloat(process.env.ALERT_FAIL_RATE_PCT))
  ? parseFloat(process.env.ALERT_FAIL_RATE_PCT)
  : DEFAULT_ALERT_FAIL_RATE_PCT;

/**
 * Check daily metrics and send alerts if thresholds exceeded
 */
async function checkAndAlert(bot) {
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminId) {
    console.log('⚠️ [Alerts] ADMIN_TELEGRAM_ID not set, skipping alerts');
    return;
  }

  try {
    // Get today's stats
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const summary = await aggregations.getSummary(
      todayStart.toISOString(),
      now.toISOString()
    );

    const alerts = [];

    // Check COGS
    if (summary.cogs.estimated > ALERT_COGS_USD_DAILY) {
      alerts.push(
        `🔴 <b>COGS Alert!</b>\n` +
        `Today's API costs: $${summary.cogs.estimated.toFixed(2)}\n` +
        `Threshold: $${ALERT_COGS_USD_DAILY}`
      );
    }

    // Check trial burn
    if (summary.trial.burnUSD > ALERT_TRIAL_BURN_USD_DAILY) {
      alerts.push(
        `🟠 <b>Trial Burn Alert!</b>\n` +
        `Today's trial API costs: $${summary.trial.burnUSD.toFixed(2)}\n` +
        `Threshold: $${ALERT_TRIAL_BURN_USD_DAILY}`
      );
    }

    // Check fail rate
    const failRate = 100 - parseFloat(summary.cogs.successRate);
    if (failRate > ALERT_FAIL_RATE_PCT) {
      alerts.push(
        `🟡 <b>Fail Rate Alert!</b>\n` +
        `Today's fail rate: ${failRate.toFixed(1)}%\n` +
        `Threshold: ${ALERT_FAIL_RATE_PCT}%`
      );
    }

    // Send alerts
    if (alerts.length > 0) {
      const message =
        `⚠️ <b>Monitoring Alerts</b>\n` +
        `📅 ${now.toISOString().split('T')[0]}\n\n` +
        alerts.join('\n\n') +
        `\n\n📊 <a href="${process.env.BOT_URL || 'https://neurolab.fun'}/admin/dashboard">View Dashboard</a>`;

      await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });

      console.log(`📢 [Alerts] Sent ${alerts.length} alert(s) to admin`);
    } else {
      console.log('✅ [Alerts] All metrics within thresholds');
    }

    return { alerts, summary };
  } catch (error) {
    console.error('❌ [Alerts] Error checking alerts:', error.message);
    return { error: error.message };
  }
}

/**
 * Generate daily report
 */
async function generateDailyReport(bot) {
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminId) return;

  try {
    // Yesterday's summary
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const summary = await aggregations.getSummary(
      `${yesterdayStr}T00:00:00.000Z`,
      `${yesterdayStr}T23:59:59.999Z`
    );

    // Get top models
    const topModels = await aggregations.getTopModels(
      `${yesterdayStr}T00:00:00.000Z`,
      `${yesterdayStr}T23:59:59.999Z`,
      5
    );

    const modelsText = topModels.length > 0
      ? topModels.map((m, i) =>
          `${i + 1}. ${m.modelKey}: ${m.count} gen, $${m.cogs.toFixed(2)} COGS`
        ).join('\n')
      : 'No generations';

    const message =
      `📊 <b>Daily Report</b>\n` +
      `📅 ${yesterdayStr}\n\n` +

      `💰 <b>Revenue</b>\n` +
      `• USD: $${summary.revenue.usd.toFixed(2)}\n` +
      `• Purchases: ${summary.revenue.purchases}\n` +
      `• Paid Users: ${summary.revenue.paidUsers}\n\n` +

      `🔧 <b>COGS</b>\n` +
      `• API Costs: $${summary.cogs.estimated.toFixed(2)}\n` +
      `• Generations: ${summary.cogs.generations}\n` +
      `• Success Rate: ${summary.cogs.successRate}%\n\n` +

      `🎁 <b>Trial</b>\n` +
      `• Burn: $${summary.trial.burnUSD.toFixed(2)}\n` +
      `• Generations: ${summary.trial.generations}\n` +
      `• Users: ${summary.trial.users}\n\n` +

      `📈 <b>Gross</b>\n` +
      `• Estimated: $${summary.gross.estimated.toFixed(2)}\n` +
      `• Margin: ${summary.gross.marginPercent}%\n\n` +

      `🏆 <b>Top Models (by COGS)</b>\n` +
      modelsText +

      `\n\n📊 <a href="${process.env.BOT_URL || 'https://neurolab.fun'}/admin/dashboard">Full Dashboard</a>`;

    await bot.telegram.sendMessage(adminId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    console.log('📊 [Alerts] Daily report sent');

    return { success: true };
  } catch (error) {
    console.error('❌ [Alerts] Error generating daily report:', error.message);
    return { error: error.message };
  }
}

/**
 * Schedule alerts (call from main app)
 */
function scheduleAlerts(bot) {
  // Check alerts every hour
  const HOUR = 60 * 60 * 1000;
  setInterval(() => checkAndAlert(bot), HOUR);

  // Daily report at 9:00 AM UTC
  const scheduleNextDailyReport = () => {
    const now = new Date();
    const next9am = new Date(now);
    next9am.setUTCHours(9, 0, 0, 0);

    if (next9am <= now) {
      next9am.setDate(next9am.getDate() + 1);
    }

    const msUntil = next9am.getTime() - now.getTime();

    setTimeout(() => {
      generateDailyReport(bot);
      // Schedule next day
      setInterval(() => generateDailyReport(bot), 24 * HOUR);
    }, msUntil);
  };

  scheduleNextDailyReport();

  console.log('📢 [Alerts] Scheduled: hourly checks + daily report at 9:00 UTC');
}

module.exports = {
  checkAndAlert,
  generateDailyReport,
  scheduleAlerts,
  ALERT_COGS_USD_DAILY,
  ALERT_TRIAL_BURN_USD_DAILY,
  ALERT_FAIL_RATE_PCT
};
