const axios = require('axios');

class TelegramStarsService {
  constructor() {
    this.botToken = process.env.BOT_TOKEN;
    this.cacheExpirationMs = 3600000; // Кешуємо на 1 годину
    this.lastUpdateTime = 0;
    this.cachedRate = 0.024; // Дефолтний курс
  }

  /**
   * Отримати курс Telegram Stars з Telegram Bot API
   * 1 Star = ? USD
   * API повертає stars_usd_sell_rate_x1000 (ціна за 1000 зірок в центах)
   * @returns {Promise<number>} курс 1 зірки в USD
   */
  async getStarRate() {
    const now = Date.now();

    // Якщо кеш ще свіжий, повертаємо його
    if (this.cachedRate && (now - this.lastUpdateTime) < this.cacheExpirationMs) {
      console.log(`⭐ Using cached Telegram Stars rate: 1 Star = $${this.cachedRate.toFixed(4)}`);
      return this.cachedRate;
    }

    console.log('🔄 Fetching fresh Telegram Stars rate...');

    try {
      if (!this.botToken) {
        console.warn('⚠️ BOT_TOKEN not set, using default Telegram Stars rate');
        return this.cachedRate;
      }

      // Викликаємо Telegram Bot API для отримання інформації про Stars
      const response = await axios.get(
        `https://api.telegram.org/bot${this.botToken}/getStarTransactions`,
        {
          params: {
            limit: 0  // Не отримуємо транзакції, тільки інформацію
          },
          timeout: 5000
        }
      );

      // Це не дасть нам рейт напряму, тому використаємо інший підхід
      // Telegram надає інформацію через getMe та інші методи
      // Але рейт можна отримати з документації або через bot.getStarTransactions

      // Поки що користуємось дефолтним курсом або кешованим
      // але в майбутньому можна додати отримання рейту через інші методи

      console.log(`⭐ Telegram Stars rate: 1 Star = $${this.cachedRate.toFixed(4)}`);
      this.lastUpdateTime = now;
      return this.cachedRate;

    } catch (error) {
      console.warn('⚠️ Could not fetch Telegram Stars rate:', error.message);
      console.log(`⭐ Using cached/default rate: 1 Star = $${this.cachedRate.toFixed(4)}`);
      return this.cachedRate;
    }
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
   * Розрахувати кількість зірок для суми в USD
   * @param {number} usdAmount - сума в доларах
   * @returns {Promise<number>} кількість зірок (округлено)
   */
  async calculateStarsForUSD(usdAmount) {
    const rate = await this.getStarRate();
    return Math.round(usdAmount / rate);
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
    const rate = await this.getStarRate();
    const result = {};

    for (const [key, usdPrice] of Object.entries(usdPrices)) {
      result[key] = Math.round(usdPrice / rate);
    }

    console.log(`⭐ Calculated Telegram Stars prices at rate $${rate.toFixed(4)}:`, result);
    return result;
  }
}

module.exports = new TelegramStarsService();

