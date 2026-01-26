/**
 * Admin API Routes - protected metrics endpoints
 * Protected via ADMIN_TOKEN header or query param
 */

const express = require('express');
const router = express.Router();
const aggregations = require('../monitoring/aggregations');
const DailySummary = require('../database/models/DailySummary');
const UsageEvent = require('../database/models/UsageEvent');
const PaymentEvent = require('../database/models/PaymentEvent');
const replicatePricing = require('../services/replicatePricing');
const gracefulShutdown = require('../utils/gracefulShutdown');

// Auth middleware
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_TELEGRAM_ID;

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;

  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
  }

  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Apply auth to all routes
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
 * Перевірка актуальності цін Replicate
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
          ? '✅ Всі ціни актуальні!'
          : `⚠️ Знайдено ${discrepancies.length} розбіжностей. Оновіть apiCost в models.js`
      }
    });
  } catch (error) {
    console.error('Admin pricing check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/generations/active
 * Перегляд активних генерацій (для моніторингу перед рестартом)
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
          ? '✅ Немає активних генерацій. Можна робити restart.'
          : `⚠️ ${activeCount} активних генерацій. Зачекайте або вони будуть перервані.`
      }
    });
  } catch (error) {
    console.error('Admin active generations error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/dashboard
 * Serve admin dashboard HTML
 */
router.get('/dashboard', (req, res) => {
  // Token passed in query for dashboard access
  const token = req.query.token;

  res.send(`
<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>neuro.lab.ai - Адмін панель</title>
  <style>
    :root {
      --bg: #0f0f0f;
      --card: #1a1a1a;
      --border: #333;
      --text: #e0e0e0;
      --text-muted: #888;
      --accent: #00d4ff;
      --success: #00c853;
      --warning: #ffab00;
      --danger: #ff5252;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px;
      min-height: 100vh;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .header h1 { font-size: 24px; color: var(--accent); }
    .period-select {
      display: flex;
      gap: 8px;
    }
    .period-btn {
      padding: 8px 16px;
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .period-btn:hover, .period-btn.active {
      background: var(--accent);
      color: var(--bg);
      border-color: var(--accent);
    }
    .danger-btn {
      padding: 10px 16px;
      background: var(--danger);
      border: 1px solid var(--danger);
      color: #fff;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 13px;
      font-weight: 600;
    }
    .danger-btn:hover {
      filter: brightness(0.95);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card-title {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }
    .card-hint {
      font-size: 10px;
      color: var(--text-muted);
      margin-bottom: 8px;
      font-style: italic;
    }
    .card-value {
      font-size: 28px;
      font-weight: 700;
    }
    .card-value.success { color: var(--success); }
    .card-value.warning { color: var(--warning); }
    .card-value.danger { color: var(--danger); }
    .card-subtitle {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .section-title {
      font-size: 18px;
      margin-bottom: 8px;
      color: var(--accent);
    }
    .section-hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 500;
    }
    td { font-size: 14px; }
    .loading {
      text-align: center;
      padding: 40px;
      color: var(--text-muted);
    }
    .error {
      background: rgba(255, 82, 82, 0.1);
      border: 1px solid var(--danger);
      color: var(--danger);
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-success { background: rgba(0, 200, 83, 0.2); color: var(--success); }
    .badge-warning { background: rgba(255, 171, 0, 0.2); color: var(--warning); }
    .badge-danger { background: rgba(255, 82, 82, 0.2); color: var(--danger); }
    .legend {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .legend h3 {
      font-size: 14px;
      color: var(--accent);
      margin-bottom: 12px;
    }
    .legend-item {
      display: flex;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .legend-term {
      font-weight: bold;
      min-width: 120px;
      color: var(--text);
    }
    .legend-desc {
      color: var(--text-muted);
    }
    /* Tabs */
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0;
    }
    .tab-btn {
      padding: 12px 20px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 14px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .tab-btn:hover {
      color: var(--text);
    }
    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .price-status {
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .price-status.ok {
      background: rgba(0, 200, 83, 0.1);
      border: 1px solid var(--success);
      color: var(--success);
    }
    .price-status.warning {
      background: rgba(255, 171, 0, 0.1);
      border: 1px solid var(--warning);
      color: var(--warning);
    }
    .price-link {
      color: var(--accent);
      text-decoration: none;
    }
    .price-link:hover {
      text-decoration: underline;
    }
    @media (max-width: 768px) {
      .cards { grid-template-columns: 1fr 1fr; }
      .header { flex-direction: column; gap: 16px; }
      .tabs { overflow-x: auto; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>📊 Адмін панель neuro.lab.ai</h1>
    <div class="period-select">
      <button class="period-btn" data-days="1">Сьогодні</button>
      <button class="period-btn" data-days="7">7 днів</button>
      <button class="period-btn active" data-days="30">30 днів</button>
      <button class="period-btn" data-days="90">90 днів</button>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab-btn active" data-tab="metrics">📊 Метрики</button>
    <button class="tab-btn" data-tab="pricing">💰 Ціни Replicate</button>
  </div>

  <div id="error" class="error" style="display:none;"></div>

  <!-- Tab: Metrics -->
  <div id="tab-metrics" class="tab-content active">
    <div class="legend">
      <h3>📖 Словник термінів</h3>
      <div class="legend-item">
        <span class="legend-term">💰 Дохід</span>
        <span class="legend-desc">— скільки грошей отримали від клієнтів</span>
      </div>
      <div class="legend-item">
        <span class="legend-term">💸 Собівартість</span>
        <span class="legend-desc">— скільки МИ платимо за API (Replicate, тощо)</span>
      </div>
      <div class="legend-item">
        <span class="legend-term">💳 Replicate баланс</span>
        <span class="legend-desc">— залишок коштів на Replicate (з моменту стартового депозита)</span>
      </div>
      <div class="legend-item">
        <span class="legend-term">📈 Прибуток</span>
        <span class="legend-desc">— Дохід мінус Собівартість мінус бонуси новим (15⚡)</span>
      </div>
      <div class="legend-item">
        <span class="legend-term">🔥 Trial витрати</span>
        <span class="legend-desc">— собівартість генерацій безкоштовних юзерів (вони не платять, ми - платимо)</span>
      </div>
      <div class="legend-item">
        <span class="legend-term">🆓 Безкоштовні</span>
        <span class="legend-desc">— юзери, що запустили бота, але ще не купили жодного тарифу</span>
      </div>
      <div class="legend-item">
        <span class="legend-term">📊 Маржа</span>
        <span class="legend-desc">— відсоток прибутку від доходу (чим більше - тим краще)</span>
      </div>
    </div>

    <div class="cards" id="summary">
      <div class="loading">Завантаження...</div>
    </div>

    <div class="section">
      <h2 class="section-title">🧹 Управління статистикою</h2>
      <p class="section-hint">Обнулити аналітику (usage_events, payment_events, daily_summaries). Баланси користувачів не чіпає.</p>
      <button id="reset-stats-btn" class="danger-btn">Обнулити статистику</button>
    </div>

    <div class="section">
      <h2 class="section-title">💳 Покупки по тарифах</h2>
      <p class="section-hint">Скільки разів купили кожен пакет токенів</p>
      <table id="purchases-table">
        <thead>
          <tr>
            <th>Пакет</th>
            <th>К-сть</th>
            <th>Дохід $</th>
            <th>Токенів</th>
            <th>Юзерів</th>
          </tr>
        </thead>
        <tbody id="purchases-body">
          <tr><td colspan="5" class="loading">Завантаження...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2 class="section-title">🤖 Топ моделей по витратах</h2>
      <p class="section-hint">Які моделі найбільше "з'їдають" на API (собівартість)</p>
      <table id="models-table">
        <thead>
          <tr>
            <th>Модель</th>
            <th>Генерацій</th>
            <th>Собівартість $</th>
            <th>Дохід $</th>
            <th>Маржа</th>
            <th>Помилок</th>
          </tr>
        </thead>
        <tbody id="models-body">
          <tr><td colspan="6" class="loading">Завантаження...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Tab: Pricing -->
  <div id="tab-pricing" class="tab-content">
    <div class="legend">
      <h3>💡 Що це таке?</h3>
      <div class="legend-item">
        <span class="legend-desc">Перевірка чи наші ціни (apiCost в models.js) відповідають офіційним цінам Replicate.</span>
      </div>
      <div class="legend-item">
        <span class="legend-desc">Якщо є розбіжності — треба оновити apiCost, інакше рахуємо прибуток неправильно!</span>
      </div>
    </div>

    <div id="pricing-status" class="price-status ok">
      Завантаження...
    </div>

    <div class="section">
      <h2 class="section-title">📋 Офіційні ціни Replicate</h2>
      <p class="section-hint">Ціни з офіційних сторінок моделей (перевірено: 2026-01-25)</p>
      <table id="pricing-table">
        <thead>
          <tr>
            <th>Модель</th>
            <th>Наша ціна</th>
            <th>Офіційна</th>
            <th>Статус</th>
            <th>Джерело</th>
          </tr>
        </thead>
        <tbody id="pricing-body">
          <tr><td colspan="5" class="loading">Завантаження...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="section" id="discrepancies-section" style="display:none;">
      <h2 class="section-title">⚠️ Розбіжності (потрібно виправити)</h2>
      <p class="section-hint">Ці моделі мають неправильні apiCost в config/models.js</p>
      <table id="discrepancies-table">
        <thead>
          <tr>
            <th>Модель</th>
            <th>Наша ціна</th>
            <th>Офіційна</th>
            <th>Різниця</th>
            <th>Дія</th>
          </tr>
        </thead>
        <tbody id="discrepancies-body"></tbody>
      </table>
    </div>
  </div>

  <script>
    const TOKEN = '${token || ''}';
    const API_BASE = '/admin';
    
    let currentDays = 30;
    
    async function fetchAPI(endpoint) {
      const url = API_BASE + endpoint + (endpoint.includes('?') ? '&' : '?') + 'token=' + TOKEN;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Помилка API: ' + res.status);
      return res.json();
    }

    async function postAPI(endpoint, body) {
      const url = API_BASE + endpoint + (endpoint.includes('?') ? '&' : '?') + 'token=' + TOKEN;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      if (!res.ok) throw new Error('Помилка API: ' + res.status);
      return res.json();
    }
    
    function formatUSD(val) {
      return '$' + (val || 0).toFixed(2);
    }
    
    function formatPct(val) {
      return (val || 0).toFixed(1) + '%';
    }

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        
        if (btn.dataset.tab === 'pricing') {
          loadPricing();
        }
      });
    });

    async function loadPricing() {
      try {
        const data = await fetchAPI('/pricing/check');
        if (!data.success) throw new Error(data.error);

        const statusEl = document.getElementById('pricing-status');
        if (data.data.status === 'OK') {
          statusEl.className = 'price-status ok';
          statusEl.textContent = '✅ Всі ціни актуальні! Розбіжностей немає.';
        } else {
          statusEl.className = 'price-status warning';
          statusEl.textContent = '⚠️ ' + data.data.message;
        }

        // Pricing table
        const tbody = document.getElementById('pricing-body');
        const prices = data.data.officialPrices;
        tbody.innerHTML = Object.entries(prices).map(([key, p]) => {
          // Спеціальна обробка для Veo (два варіанти цін)
          let priceDisplay = '';
          let unit = '/run';
          
          if (p.pricePerSecondAudio && p.pricePerSecondNoAudio) {
            // Veo - показуємо обидва варіанти
            priceDisplay = \`$\${p.pricePerSecondAudio.toFixed(2)}/сек 🔊<br>$\${p.pricePerSecondNoAudio.toFixed(2)}/сек 🔇\`;
          } else if (p.pricePerSecond) {
            priceDisplay = \`$\${p.pricePerSecond.toFixed(2)}/сек\`;
          } else if (p.pricePerRun) {
            priceDisplay = \`$\${p.pricePerRun.toFixed(2)}/run\`;
          }
          
          const isOk = !data.data.discrepancies.find(d => d.model === p.model);
          return \`
            <tr>
              <td><strong>\${p.model}</strong></td>
              <td>—</td>
              <td>\${priceDisplay}</td>
              <td><span class="badge badge-\${isOk ? 'success' : 'danger'}">\${isOk ? '✅ OK' : '❌'}</span></td>
              <td><a href="\${p.source}" target="_blank" class="price-link">Replicate ↗</a></td>
            </tr>
          \`;
        }).join('');

        // Discrepancies
        if (data.data.discrepancies.length > 0) {
          document.getElementById('discrepancies-section').style.display = 'block';
          const dBody = document.getElementById('discrepancies-body');
          dBody.innerHTML = data.data.discrepancies.map(d => \`
            <tr>
              <td><strong>\${d.modelName}</strong><br><small>\${d.model}</small></td>
              <td class="danger">$\${d.ourPrice || d.ourPricePerSec}</td>
              <td class="success">$\${d.officialPrice || d.officialPricePerSec}</td>
              <td><span class="badge badge-danger">\${d.differencePercent}</span></td>
              <td><a href="\${d.source}" target="_blank" class="price-link">Перевірити ↗</a></td>
            </tr>
          \`).join('');
        } else {
          document.getElementById('discrepancies-section').style.display = 'none';
        }

      } catch (err) {
        document.getElementById('pricing-status').className = 'price-status warning';
        document.getElementById('pricing-status').textContent = 'Помилка: ' + err.message;
      }
    }
    
    async function loadDashboard() {
      const now = new Date();
      const from = new Date(now.getTime() - currentDays * 24 * 60 * 60 * 1000).toISOString();
      const to = now.toISOString();
      
      try {
        // Summary
        const summary = await fetchAPI('/metrics/summary?from=' + from + '&to=' + to);
        if (summary.success) {
          const d = summary.data;
          const freeUsersTotal = d.users?.freeTotal ?? 0;
          const freeUsersNew = d.users?.freeNew ?? 0;
          const trialBonus = d.trialBonus || {};
          const trialBonusUSD = trialBonus.liabilityUSD || 0;
          const trialBonusUsers = trialBonus.newUsers || 0;
          const trialTokensPerUser = trialBonus.tokensPerUser || 15;
          const rb = d.replicateBalance || {};
          const remainingUSD = Number(rb.remainingUSD) || 0;
          const remainingClass = remainingUSD < 0 ? 'danger' : remainingUSD < 20 ? 'warning' : 'success';
          const remainingLabel = remainingUSD < 0 ? 'Потрібно поповнити' : 'Залишок на Replicate';
          const remainingValue = formatUSD(Math.abs(remainingUSD));
          const fundedValue = formatUSD(rb.fundedUSD || 0);
          const spentValue = formatUSD(rb.spentUSD || 0);
          document.getElementById('summary').innerHTML = \`
            <div class="card">
              <div class="card-title">💰 Дохід</div>
              <div class="card-hint">Скільки заплатили клієнти</div>
              <div class="card-value success">\${formatUSD(d.revenue.usd)}</div>
              <div class="card-subtitle">\${d.revenue.purchases} покупок</div>
            </div>
            <div class="card">
              <div class="card-title">💸 Собівартість</div>
              <div class="card-hint">Скільки ми платимо API</div>
              <div class="card-value warning">\${formatUSD(d.cogs.estimated)}</div>
              <div class="card-subtitle">\${d.cogs.generations} генерацій</div>
            </div>
            <div class="card">
              <div class="card-title">💳 Replicate баланс</div>
              <div class="card-hint">\${remainingLabel}</div>
              <div class="card-value \${remainingClass}">\${remainingValue}</div>
              <div class="card-subtitle">Поповнено \${fundedValue} • Витрачено \${spentValue}</div>
            </div>
            <div class="card">
              <div class="card-title">📈 Прибуток</div>
              <div class="card-hint">Дохід - Собівартість - бонуси новим (\${trialTokensPerUser}⚡)</div>
              <div class="card-value">\${formatUSD(d.gross.estimated)}</div>
              <div class="card-subtitle">\${d.gross.marginPercent}% маржа • -\${formatUSD(trialBonusUSD)} бонуси (\${trialBonusUsers} юз.)</div>
            </div>
            <div class="card">
              <div class="card-title">🔥 Trial витрати</div>
              <div class="card-hint">Безкоштовні юзери "з'їли"</div>
              <div class="card-value danger">\${formatUSD(d.trial.burnUSD)}</div>
              <div class="card-subtitle">\${d.trial.users} trial юзерів</div>
            </div>
            <div class="card">
              <div class="card-title">🆓 Безкоштовні юзери</div>
              <div class="card-hint">Запустили бота, але не купляли</div>
              <div class="card-value">\${freeUsersTotal}</div>
              <div class="card-subtitle">+\${freeUsersNew} за період</div>
            </div>
            <div class="card">
              <div class="card-title">✅ Успішність</div>
              <div class="card-hint">% вдалих генерацій</div>
              <div class="card-value">\${d.cogs.successRate}%</div>
              <div class="card-subtitle">\${d.cogs.activeUsers} активних юзерів</div>
            </div>
            <div class="card">
              <div class="card-title">👥 Платних юзерів</div>
              <div class="card-hint">Хто купив токени</div>
              <div class="card-value success">\${d.revenue.paidUsers}</div>
              <div class="card-subtitle">за період</div>
            </div>
          \`;
        }
        
        // Purchases
        const purchases = await fetchAPI('/metrics/purchases?from=' + from + '&to=' + to);
        if (purchases.success) {
          const tbody = document.getElementById('purchases-body');
          if (purchases.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5">Немає покупок за період</td></tr>';
          } else {
            tbody.innerHTML = purchases.data.map(p => \`
              <tr>
                <td><strong>\${p._id}</strong></td>
                <td>\${p.count}</td>
                <td>\${formatUSD(p.totalUSD)}</td>
                <td>\${p.totalTokens}⚡</td>
                <td>\${p.uniqueUsers}</td>
              </tr>
            \`).join('');
          }
        }
        
        // Top models
        const models = await fetchAPI('/metrics/top-models?from=' + from + '&to=' + to + '&limit=10');
        if (models.success) {
          const tbody = document.getElementById('models-body');
          if (models.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6">Немає генерацій за період</td></tr>';
          } else {
            tbody.innerHTML = models.data.map(m => {
              const marginClass = m.margin > 50 ? 'success' : m.margin > 30 ? 'warning' : 'danger';
              const failClass = m.failRate < 5 ? 'success' : m.failRate < 15 ? 'warning' : 'danger';
              return \`
                <tr>
                  <td><strong>\${m.modelKey}</strong></td>
                  <td>\${m.count}</td>
                  <td>\${formatUSD(m.cogs)}</td>
                  <td>\${formatUSD(m.revenue)}</td>
                  <td><span class="badge badge-\${marginClass}">\${formatPct(m.margin)}</span></td>
                  <td><span class="badge badge-\${failClass}">\${formatPct(m.failRate)}</span></td>
                </tr>
              \`;
            }).join('');
          }
        }
        
        document.getElementById('error').style.display = 'none';
      } catch (err) {
        document.getElementById('error').textContent = 'Помилка: ' + err.message;
        document.getElementById('error').style.display = 'block';
      }
    }
    
    // Period buttons
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentDays = parseInt(btn.dataset.days);
        loadDashboard();
      });
    });
    
    // Initial load
    loadDashboard();

    // Reset stats button
    const resetBtn = document.getElementById('reset-stats-btn');
    resetBtn.addEventListener('click', async () => {
      const confirmed = window.confirm('Це видалить аналітику (usage/payment/daily). Баланси користувачів не чіпає. Продовжити?');
      if (!confirmed) return;
      const phrase = window.prompt('Введіть RESET для підтвердження:');
      if (phrase !== 'RESET') return;

      try {
        const resp = await postAPI('/metrics/reset', { scope: 'all', confirm: 'RESET' });
        if (!resp.success) throw new Error(resp.error || 'Помилка');
        await loadDashboard();
        alert('Статистику обнулено.');
      } catch (err) {
        alert('Помилка: ' + err.message);
      }
    });
    
    // Auto-refresh every 5 minutes
    setInterval(loadDashboard, 5 * 60 * 1000);
  </script>
</body>
</html>
  `);
});

module.exports = router;
