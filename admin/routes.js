const express = require('express');
const path = require('path');
const router = express.Router();
const aggregations = require('../monitoring/aggregations');
const DailySummary = require('../database/models/DailySummary');
const UsageEvent = require('../database/models/UsageEvent');
const PaymentEvent = require('../database/models/PaymentEvent');
const replicatePricing = require('../services/replicatePricing');
const gracefulShutdown = require('../utils/gracefulShutdown');
const { TRIAL_TOKENS } = require('../config/constants');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_TELEGRAM_ID;
const ADMIN_COOKIE_NAME = 'admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const [key, ...valueParts] = entry.split('=');
      cookies[key] = decodeURIComponent(valueParts.join('='));
      return cookies;
    }, {});
}

function createSessionValue() {
  return Buffer.from(JSON.stringify({ token: ADMIN_TOKEN, expiresAt: Date.now() + ADMIN_SESSION_TTL_MS })).toString('base64url');
}

function isValidSession(sessionValue) {
  if (!sessionValue) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(sessionValue, 'base64url').toString('utf8'));
    return parsed.token === ADMIN_TOKEN && Number(parsed.expiresAt) > Date.now();
  } catch (error) {
    return false;
  }
}

router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-login.html'));
});

router.post('/login', express.json(), (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ success: false, error: 'ADMIN_TOKEN is not configured' });
  }

  const token = req.body?.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE_NAME}=${createSessionValue()}; HttpOnly; Path=/admin; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}${secure}`
  );

  return res.json({ success: true });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/admin; SameSite=Strict; Max-Age=0`);
  res.json({ success: true });
});

function adminAuth(req, res, next) {
  const headerToken = req.headers['x-admin-token'];
  const cookieToken = parseCookies(req)[ADMIN_COOKIE_NAME];

  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
  }

  if (headerToken === ADMIN_TOKEN || isValidSession(cookieToken)) {
    return next();
  }

  if (req.accepts('html')) {
    return res.redirect('/admin/login');
  }

  if (req.path === '/dashboard') {
    return res.redirect('/admin/login');
  }

  if (headerToken !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

router.use(adminAuth);

/**
 * GET /admin/metrics/summary
 * Main dashboard summary
 */
router.get('/metrics/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const summary = await aggregations.getSummary(from, to);
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Admin metrics error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/kie-summary
 * KIE.AI specific dashboard summary
 */
router.get('/metrics/kie-summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const summary = await aggregations.getKieSummary(from, to);
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Admin KIE metrics error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/revenue
 * Revenue breakdown by period
 */
router.get('/metrics/revenue', async (req, res) => {
  try {
    const { from, to, groupBy = 'day' } = req.query;
    const data = await aggregations.getRevenue(from, to, groupBy);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin revenue error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/cogs
 * COGS breakdown by period/model
 */
router.get('/metrics/cogs', async (req, res) => {
  try {
    const { from, to, groupBy = 'day', by } = req.query;
    const data = await aggregations.getCogs(from, to, groupBy, by);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin cogs error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/trial-burn
 * Trial user API cost burn
 */
router.get('/metrics/trial-burn', async (req, res) => {
  try {
    const { from, to, groupBy = 'day' } = req.query;
    const data = await aggregations.getTrialBurn(from, to, groupBy);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin trial-burn error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/fail-rate
 * Generation fail rate by model
 */
router.get('/metrics/fail-rate', async (req, res) => {
  try {
    const { from, to, groupBy = 'day', by = 'model' } = req.query;
    const data = await aggregations.getFailRate(from, to, groupBy, by);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin fail-rate error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/purchases
 * Purchases by plan
 */
router.get('/metrics/purchases', async (req, res) => {
  try {
    const { from, to } = req.query;
    const data = await aggregations.getPurchasesByPlan(from, to);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin purchases error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/top-models
 * Top models by COGS
 */
router.get('/metrics/top-models', async (req, res) => {
  try {
    const { from, to, limit = 10 } = req.query;
    const data = await aggregations.getTopModels(from, to, parseInt(limit));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin top-models error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/top-users
 * Top users by tokens spent
 */
router.get('/metrics/top-users', async (req, res) => {
  try {
    const { from, to, limit = 20 } = req.query;
    const data = await aggregations.getTopUsers(from, to, parseInt(limit));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin top-users error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/kie-top-models
 * Top KIE.AI models by COGS
 */
router.get('/metrics/kie-top-models', async (req, res) => {
  try {
    const { from, to, limit = 10 } = req.query;
    const data = await aggregations.getTopKieModels(from, to, parseInt(limit));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin KIE top-models error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/kie-top-users
 * Top users by KIE.AI tokens spent
 */
router.get('/metrics/kie-top-users', async (req, res) => {
  try {
    const { from, to, limit = 20 } = req.query;
    const data = await aggregations.getTopKieUsers(from, to, parseInt(limit));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin KIE top-users error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /admin/metrics/reset
 * Reset analytics collections (UsageEvent, PaymentEvent, DailySummary)
 * Body: { scope: 'all'|'usage'|'payments'|'daily', confirm: 'RESET' }
 */
router.post('/metrics/reset', async (req, res) => {
  try {
    const { scope = 'all', confirm } = req.body || {};

    if (confirm !== 'RESET') {
      return res.status(400).json({ success: false, error: 'Confirmation required' });
    }

    const result = {};

    if (scope === 'all' || scope === 'usage') {
      const r = await UsageEvent.deleteMany({});
      result.usageEventsDeleted = r.deletedCount || 0;
    }

    if (scope === 'all' || scope === 'payments') {
      const r = await PaymentEvent.deleteMany({});
      result.paymentEventsDeleted = r.deletedCount || 0;
    }

    if (scope === 'all' || scope === 'daily') {
      const r = await DailySummary.deleteMany({});
      result.dailySummariesDeleted = r.deletedCount || 0;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Admin reset error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/metrics/daily
 * Get cached daily summaries
 */
router.get('/metrics/daily', async (req, res) => {
  try {
    const { from, to } = req.query;

    // Default: last 30 days
    const now = new Date();
    const endDay = to || now.toISOString().split('T')[0];
    const startDay = from || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const data = await aggregations.getDailySummaries(startDay, endDay);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin daily error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /admin/metrics/compute-daily
 * Manually trigger daily summary computation
 */
router.post('/metrics/compute-daily', async (req, res) => {
  try {
    const { day } = req.body;
    const dayString = day || new Date().toISOString().split('T')[0];

    const summary = await aggregations.computeDailySummary(dayString);
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Admin compute-daily error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/pricing/check
 * Compare configured pricing against the provider pricing snapshot.
 */
router.get('/pricing/check', (req, res) => {
  try {
    const discrepancies = replicatePricing.comparePrices();
    const officialPrices = replicatePricing.getAllOfficialPrices();
    const suggestedUpdates = replicatePricing.getSuggestedUpdates();

    res.json({
      success: true,
      data: {
        status: discrepancies.length === 0 ? 'OK' : 'NEEDS_UPDATE',
        discrepancies,
        suggestedUpdates,
        officialPrices,
        message: discrepancies.length === 0
          ? 'All configured prices match the current pricing snapshot.'
          : `${discrepancies.length} pricing discrepancy(s) detected. Review apiCost values in config/models.js.`
      }
    });
  } catch (error) {
    console.error('Admin pricing check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/generations/active
 * Inspect active generations before a restart or deployment.
 */
router.get('/generations/active', (req, res) => {
  try {
    const activeCount = gracefulShutdown.getActiveCount();
    const generations = gracefulShutdown.getActiveGenerations();
    const isShuttingDown = gracefulShutdown.isInShutdown();

    res.json({
      success: true,
      data: {
        activeCount,
        isShuttingDown,
        generations,
        message: activeCount === 0
          ? 'No active generations. A restart is safe.'
          : `${activeCount} generation(s) are still running. Wait for completion or expect interruption.`
      }
    });
  } catch (error) {
    console.error('Admin active generations error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/dashboard
 * Serve the admin dashboard application.
 */
router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-dashboard.html'));
});

module.exports = router;
