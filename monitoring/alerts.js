const aggregations = require('./aggregations');
const { DEFAULT_ALERT_FAIL_RATE_PCT } = require('../config/constants');
const { getAdminIds } = require('../config/access');

const ALERT_COGS_USD_DAILY = parseFloat(process.env.ALERT_COGS_USD_DAILY) || 50;
const ALERT_TRIAL_BURN_USD_DAILY = parseFloat(process.env.ALERT_TRIAL_BURN_USD_DAILY) || 20;
const ALERT_FAIL_RATE_PCT = Number.isFinite(parseFloat(process.env.ALERT_FAIL_RATE_PCT))
  ? parseFloat(process.env.ALERT_FAIL_RATE_PCT)
  : DEFAULT_ALERT_FAIL_RATE_PCT;
const ALERT_FAIL_RATE_MIN_GENERATIONS = Number.isFinite(parseInt(process.env.ALERT_FAIL_RATE_MIN_GENERATIONS, 10))
  ? parseInt(process.env.ALERT_FAIL_RATE_MIN_GENERATIONS, 10)
  : 5;

const sentAlerts = new Set();

function dashboardUrl() {
  const baseUrl = process.env.BOT_URL || process.env.APP_URL || 'http://127.0.0.1:5500';
  return `${baseUrl.replace(/\/$/, '')}/admin/dashboard`;
}

function shouldSendAlert(type, dateKey) {
  const key = `${dateKey}:${type}`;
  if (sentAlerts.has(key)) {
    return false;
  }
  sentAlerts.add(key);
  return true;
}

async function checkAndAlert(bot) {
  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    console.log('[Alerts] No admin IDs configured. Skipping alerts.');
    return;
  }

  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const summary = await aggregations.getSummary(todayStart.toISOString(), now.toISOString());
    const alerts = [];
    const dateKey = now.toISOString().split('T')[0];

    if (summary.cogs.estimated > ALERT_COGS_USD_DAILY && shouldSendAlert('cogs', dateKey)) {
      alerts.push(
        `🔴 <b>COGS alert</b>\nToday's API cost: $${summary.cogs.estimated.toFixed(2)}\nThreshold: $${ALERT_COGS_USD_DAILY}`
      );
    }

    if (summary.trial.burnUSD > ALERT_TRIAL_BURN_USD_DAILY && shouldSendAlert('trial', dateKey)) {
      alerts.push(
        `🟠 <b>Trial burn alert</b>\nToday's trial API cost: $${summary.trial.burnUSD.toFixed(2)}\nThreshold: $${ALERT_TRIAL_BURN_USD_DAILY}`
      );
    }

    const generationCount = summary.cogs.generations || 0;
    if (generationCount >= ALERT_FAIL_RATE_MIN_GENERATIONS) {
      const successRate = parseFloat(summary.cogs.successRate);
      const failRate = Number.isFinite(successRate) ? 100 - successRate : null;
      if (Number.isFinite(failRate) && failRate > ALERT_FAIL_RATE_PCT && shouldSendAlert('failRate', dateKey)) {
        alerts.push(
          `🟡 <b>Fail rate alert</b>\nToday's fail rate: ${failRate.toFixed(1)}%\nThreshold: ${ALERT_FAIL_RATE_PCT}%\nGenerations: ${generationCount}`
        );
      }
    }

    if (alerts.length === 0) {
      console.log('[Alerts] Metrics are within threshold');
      return { alerts: [], summary };
    }

    const message = [
      '⚠️ <b>Monitoring alerts</b>',
      `📅 ${dateKey}`,
      '',
      alerts.join('\n\n'),
      '',
      `📊 <a href="${dashboardUrl()}">Open dashboard</a>`
    ].join('\n');

    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    }

    console.log(`[Alerts] Sent ${alerts.length} alert(s)`);
    return { alerts, summary };
  } catch (error) {
    console.error('[Alerts] Failed to evaluate alerts:', error.message);
    return { error: error.message };
  }
}

async function generateDailyReport(bot) {
  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    return;
  }

  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayKey = yesterday.toISOString().split('T')[0];
    const summary = await aggregations.getSummary(
      `${yesterdayKey}T00:00:00.000Z`,
      `${yesterdayKey}T23:59:59.999Z`
    );
    const topModels = await aggregations.getTopModels(
      `${yesterdayKey}T00:00:00.000Z`,
      `${yesterdayKey}T23:59:59.999Z`,
      5
    );

    const modelsText = topModels.length
      ? topModels.map((model, index) => `${index + 1}. ${model.modelKey}: ${model.count} generation(s), $${model.cogs.toFixed(2)} COGS`).join('\n')
      : 'No generations';

    const message = [
      '📊 <b>Daily report</b>',
      `📅 ${yesterdayKey}`,
      '',
      `💰 <b>Revenue</b>\n• USD: $${summary.revenue.usd.toFixed(2)}\n• Purchases: ${summary.revenue.purchases}\n• Paid users: ${summary.revenue.paidUsers}`,
      '',
      `🔧 <b>COGS</b>\n• API cost: $${summary.cogs.estimated.toFixed(2)}\n• Generations: ${summary.cogs.generations}\n• Success rate: ${summary.cogs.successRate}%`,
      '',
      `🎁 <b>Trial</b>\n• Burn: $${summary.trial.burnUSD.toFixed(2)}\n• Generations: ${summary.trial.generations}\n• Users: ${summary.trial.users}`,
      '',
      `📈 <b>Gross</b>\n• Estimated: $${summary.gross.estimated.toFixed(2)}\n• Margin: ${summary.gross.marginPercent}%`,
      '',
      `🏆 <b>Top models by COGS</b>\n${modelsText}`,
      '',
      `📊 <a href="${dashboardUrl()}">Open dashboard</a>`
    ].join('\n');

    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    }

    console.log('[Alerts] Daily report sent');
    return { success: true };
  } catch (error) {
    console.error('[Alerts] Failed to generate daily report:', error.message);
    return { error: error.message };
  }
}

function scheduleAlerts(bot) {
  const hourMs = 60 * 60 * 1000;
  setInterval(() => checkAndAlert(bot), hourMs);

  const scheduleNextDailyReport = () => {
    const now = new Date();
    const next9amUtc = new Date(now);
    next9amUtc.setUTCHours(9, 0, 0, 0);

    if (next9amUtc <= now) {
      next9amUtc.setDate(next9amUtc.getDate() + 1);
    }

    const waitMs = next9amUtc.getTime() - now.getTime();
    setTimeout(() => {
      generateDailyReport(bot);
      setInterval(() => generateDailyReport(bot), 24 * hourMs);
    }, waitMs);
  };

  scheduleNextDailyReport();
}

module.exports = {
  checkAndAlert,
  generateDailyReport,
  scheduleAlerts
};
