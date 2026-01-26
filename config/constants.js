const models = require('./models');

const TRIAL_TOKENS = models.subscriptions?.trial?.tokens;
const WORST_CASE_TOKEN_USD = models._pricingAssumptions?.worstCaseTokenUSD;
const DEFAULT_ALERT_FAIL_RATE_PCT = 10;

module.exports = {
  TRIAL_TOKENS,
  WORST_CASE_TOKEN_USD,
  DEFAULT_ALERT_FAIL_RATE_PCT
};
