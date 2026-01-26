const mongoose = require('mongoose');

const DEFAULT_PURCHASE_RATE = 0.024; // USD per Star (display/purchase)
const DEFAULT_PAYOUT_FACTOR = 0.53; // ≈ 0.0127 / 0.024
const DEFAULT_WITHDRAW_RATE = DEFAULT_PURCHASE_RATE * DEFAULT_PAYOUT_FACTOR;

const PAYOUT_FACTOR_BOUNDS = { min: 0.30, max: 0.90 };
const WITHDRAW_RATE_BOUNDS = { min: 0.005, max: 0.030 };

const parseEnvFloat = (key) => {
  const raw = process.env[key];
  if (!raw) return null;
  const val = parseFloat(raw);
  return Number.isFinite(val) ? val : null;
};

const clampIfOutOfBounds = (val, { min, max }) => {
  if (!Number.isFinite(val)) return null;
  if (val < min || val > max) return null;
  return val;
};

const StarsWithdrawalSchema = new mongoose.Schema({
  starsWithdrawn: { type: Number, required: true },
  usdReceived: { type: Number, required: true },
  purchaseRateAtThatTime: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'stars_withdrawals' });

const StarsWithdrawal = mongoose.models.StarsWithdrawal
  || mongoose.model('StarsWithdrawal', StarsWithdrawalSchema);

class TelegramStarsService {
  constructor() {
    this.botToken = process.env.BOT_TOKEN;
    this.cacheExpirationMs = 3600000; // Кешуємо на 1 годину
    this.lastUpdateTime = 0;
    this.cachedRate = DEFAULT_WITHDRAW_RATE; // Дефолтний withdraw курс
    this.cachedPurchaseRate = DEFAULT_PURCHASE_RATE;
    this.cachedPayoutFactor = DEFAULT_PAYOUT_FACTOR;
  }

  /**
   * Отримати курс Telegram Stars для PURCHASE/DISPLAY (USD per Star)
   * ENV override: TELEGRAM_STARS_PURCHASE_RATE
   */
  async getPurchaseStarRate() {
    const envRate = parseEnvFloat('TELEGRAM_STARS_PURCHASE_RATE');
    if (Number.isFinite(envRate)) {
      this.cachedPurchaseRate = envRate;
      return envRate;
    }

    return this.cachedPurchaseRate || DEFAULT_PURCHASE_RATE;
  }

  /**
   * Отримати payout factor на основі фактичних withdrawals
   * payoutFactor = (usdReceived / starsWithdrawn) / purchaseRateAtThatTime
   * ENV override: TELEGRAM_STARS_PAYOUT_FACTOR
   */
  async getPayoutFactor() {
    const envFactor = parseEnvFloat('TELEGRAM_STARS_PAYOUT_FACTOR');
    const envFactorClamped = clampIfOutOfBounds(envFactor, PAYOUT_FACTOR_BOUNDS);
    if (Number.isFinite(envFactorClamped)) {
      this.cachedPayoutFactor = envFactorClamped;
      return envFactorClamped;
    }

    try {
      const latest = await StarsWithdrawal.findOne().sort({ createdAt: -1 }).lean();
      if (latest?.starsWithdrawn && latest?.usdReceived && latest?.purchaseRateAtThatTime) {
        const effectiveWithdrawRate = latest.usdReceived / latest.starsWithdrawn;
        const payoutFactor = effectiveWithdrawRate / latest.purchaseRateAtThatTime;
        const clamped = clampIfOutOfBounds(payoutFactor, PAYOUT_FACTOR_BOUNDS);
        if (Number.isFinite(clamped)) {
          this.cachedPayoutFactor = clamped;
          return clamped;
        }
        console.warn('⚠️ Payout factor out of bounds, using fallback:', payoutFactor);
      }
    } catch (error) {
      console.warn('⚠️ Could not load Stars withdrawal calibration:', error.message);
    }

    return this.cachedPayoutFactor || DEFAULT_PAYOUT_FACTOR;
  }

  /**
   * Отримати курс Telegram Stars для WITHDRAW (USD per Star)
   * withdrawRate = purchaseRate * payoutFactor
   * ENV override: TELEGRAM_STARS_WITHDRAW_RATE
   */
  async getStarRate() {
    const now = Date.now();

    const envWithdrawRate = parseEnvFloat('TELEGRAM_STARS_WITHDRAW_RATE');
    const envWithdrawClamped = clampIfOutOfBounds(envWithdrawRate, WITHDRAW_RATE_BOUNDS);
    if (Number.isFinite(envWithdrawClamped)) {
      this.cachedRate = envWithdrawClamped;
      this.lastUpdateTime = now;
      console.log(`⭐ Using ENV withdraw rate: 1 Star = $${envWithdrawClamped.toFixed(4)}`);
      return envWithdrawClamped;
    }

    if (this.cachedRate && (now - this.lastUpdateTime) < this.cacheExpirationMs) {
      console.log(`⭐ Using cached Telegram Stars withdraw rate: 1 Star = $${this.cachedRate.toFixed(4)}`);
      return this.cachedRate;
    }

    const purchaseRate = await this.getPurchaseStarRate();
    const payoutFactor = await this.getPayoutFactor();
    const withdrawRate = purchaseRate * payoutFactor;
    const clampedWithdraw = clampIfOutOfBounds(withdrawRate, WITHDRAW_RATE_BOUNDS);

    if (!Number.isFinite(clampedWithdraw)) {
      console.warn('⚠️ Withdraw rate out of bounds, using fallback');
      this.cachedRate = DEFAULT_WITHDRAW_RATE;
    } else {
      this.cachedRate = clampedWithdraw;
    }

    this.lastUpdateTime = now;
    console.log(`⭐ Telegram Stars withdraw rate: 1 Star = $${this.cachedRate.toFixed(4)} (purchase $${purchaseRate.toFixed(4)} × payout ${payoutFactor.toFixed(2)})`);
    return this.cachedRate;
  }

  /**
   * Отримати курс TG Stars в UAH
   * @param {number} uahRate - курс USD/UAH
   * @returns {Promise<number>} курс TG Star в UAH
   */
  async getStarRateUAH(uahRate) {
    const starRate = await this.getStarRate();
    return starRate * uahRate;
  }

  /**
   * Записати факт withdrawal для автокалібрування
   * @param {number} starsWithdrawn
   * @param {number} usdReceived
   * @param {number} [purchaseRateAtThatTime]
   */
  async recordWithdrawal(starsWithdrawn, usdReceived, purchaseRateAtThatTime = null) {
    try {
      const purchaseRate = purchaseRateAtThatTime || await this.getPurchaseStarRate();
      const record = await StarsWithdrawal.create({
        starsWithdrawn,
        usdReceived,
        purchaseRateAtThatTime: purchaseRate
      });
      this.lastUpdateTime = 0; // force refresh
      console.log('⭐ Recorded Stars withdrawal calibration:', {
        starsWithdrawn,
        usdReceived,
        purchaseRateAtThatTime: purchaseRate
      });
      return record;
    } catch (error) {
      console.warn('⚠️ Failed to record Stars withdrawal calibration:', error.message);
      return null;
    }
  }

  /**
   * USD -> Stars using WITHDRAW rate
   * @param {number} usdAmount
   * @param {number} [bufferPct] - safety buffer in %
   */
  async usdToStars(usdAmount, bufferPct = 0) {
    const rate = await this.getStarRate();
    const buffered = usdAmount * (1 + (bufferPct / 100));
    return Math.ceil(buffered / rate);
  }

  /**
   * Stars -> USD using WITHDRAW rate
   * @param {number} stars
   */
  async starsToUsd(stars) {
    const rate = await this.getStarRate();
    return stars * rate;
  }

  /**
   * Розрахувати кількість зірок для суми в USD
   * @param {number} usdAmount - сума в доларах
   * @returns {Promise<number>} кількість зірок (округлено)
   */
  async calculateStarsForUSD(usdAmount) {
    return this.usdToStars(usdAmount);
  }

  /**
   * Встановити кастомний курс (для тестування)
   * @param {number} rate - курс 1 Star = ? USD
   */
  setCustomRate(rate) {
    this.cachedRate = rate;
    this.lastUpdateTime = Date.now();
    console.log(`⭐ Custom Telegram Stars rate set: 1 Star = $${rate.toFixed(4)}`);
  }

  /**
   * Отримати розраховані ціни Telegram Stars на основі USD
   * @param {Object} usdPrices - об'єкт з цінами в USD
   * @returns {Promise<Object>} об'єкт з цінами в TG Stars
   */
  async calculateStarsPrices(usdPrices) {
    const result = {};

    for (const [key, usdPrice] of Object.entries(usdPrices)) {
      result[key] = await this.usdToStars(usdPrice);
    }

    const rate = await this.getStarRate();
    console.log(`⭐ Calculated Telegram Stars prices at withdraw rate $${rate.toFixed(4)}:`, result);
    return result;
  }
}

/**
 * Usage example (safety buffer +2%):
 * const stars = await telegramStars.usdToStars(7, 2);
 * // $7 plan -> Stars with 2% buffer using withdraw rate
 */

module.exports = new TelegramStarsService();
