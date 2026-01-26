const models = require('./models');

const TRIAL_TOKENS = models.subscriptions?.trial?.tokens;
const WORST_CASE_TOKEN_USD = models._pricingAssumptions?.worstCaseTokenUSD;
const NET_REVENUE_FACTOR = models._pricingAssumptions?.netRevenueFactor;
const API_BUDGET_FACTOR = models._pricingAssumptions?.apiBudgetFactor;
const EFFECTIVE_TOKEN_USD = models._pricingAssumptions?.effectiveTokenUSD;
const DEFAULT_ALERT_FAIL_RATE_PCT = 7;

module.exports = {
  TRIAL_TOKENS,
  WORST_CASE_TOKEN_USD,
  NET_REVENUE_FACTOR,
  API_BUDGET_FACTOR,
  EFFECTIVE_TOKEN_USD,
  DEFAULT_ALERT_FAIL_RATE_PCT
};
