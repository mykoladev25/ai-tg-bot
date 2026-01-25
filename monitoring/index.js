/**
 * Monitoring Module - main export
 */

const loggers = require('./loggers');
const aggregations = require('./aggregations');
const alerts = require('./alerts');

module.exports = {
  // Loggers
  logUsageEvent: loggers.logUsageEvent,
  logPaymentEvent: loggers.logPaymentEvent,
  generateRequestId: loggers.generateRequestId,
  getModelConfig: loggers.getModelConfig,
  calculateApiCost: loggers.calculateApiCost,
  calculateTokenCost: loggers.calculateTokenCost,
  determinePlan: loggers.determinePlan,
  isTrialUser: loggers.isTrialUser,
  TOKEN_PRICE_USD: loggers.TOKEN_PRICE_USD,

  // Aggregations
  getSummary: aggregations.getSummary,
  getRevenue: aggregations.getRevenue,
  getCogs: aggregations.getCogs,
  getTrialBurn: aggregations.getTrialBurn,
  getFailRate: aggregations.getFailRate,
  getPurchasesByPlan: aggregations.getPurchasesByPlan,
  getTopModels: aggregations.getTopModels,
  computeDailySummary: aggregations.computeDailySummary,
  getDailySummaries: aggregations.getDailySummaries,

  // Alerts
  checkAndAlert: alerts.checkAndAlert,
  generateDailyReport: alerts.generateDailyReport,
  scheduleAlerts: alerts.scheduleAlerts
};

