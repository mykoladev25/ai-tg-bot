/**
 * Admin API Routes - protected metrics endpoints
 * Protected via ADMIN_TOKEN header or query param
 */

const express = require('express');
const router = express.Router();
const aggregations = require('../monitoring/aggregations');
const DailySummary = require('../database/models/DailySummary');
const replicatePricing = require('../services/replicatePricing');

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
    @media (max-width: 768px) {
      .cards { grid-template-columns: 1fr 1fr; }
      .header { flex-direction: column; gap: 16px; }
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
      <span class="legend-term">📈 Прибуток</span>
      <span class="legend-desc">— Дохід мінус Собівартість = наш заробіток</span>
    </div>
    <div class="legend-item">
      <span class="legend-term">🔥 Trial витрати</span>
      <span class="legend-desc">— собівартість генерацій безкоштовних юзерів (вони не платять, ми - платимо)</span>
    </div>
    <div class="legend-item">
      <span class="legend-term">📊 Маржа</span>
      <span class="legend-desc">— відсоток прибутку від доходу (чим більше - тим краще)</span>
    </div>
  </div>

  <div id="error" class="error" style="display:none;"></div>

  <div class="cards" id="summary">
    <div class="loading">Завантаження...</div>
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
    
    function formatUSD(val) {
      return '$' + (val || 0).toFixed(2);
    }
    
    function formatPct(val) {
      return (val || 0).toFixed(1) + '%';
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
              <div class="card-title">📈 Прибуток</div>
              <div class="card-hint">Дохід - Собівартість</div>
              <div class="card-value">\${formatUSD(d.gross.estimated)}</div>
              <div class="card-subtitle">\${d.gross.marginPercent}% маржа</div>
            </div>
            <div class="card">
              <div class="card-title">🔥 Trial витрати</div>
              <div class="card-hint">Безкоштовні юзери "з'їли"</div>
              <div class="card-value danger">\${formatUSD(d.trial.burnUSD)}</div>
              <div class="card-subtitle">\${d.trial.users} trial юзерів</div>
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
    
    // Auto-refresh every 5 minutes
    setInterval(loadDashboard, 5 * 60 * 1000);
  </script>
</body>
</html>
  `);
});

module.exports = router;

