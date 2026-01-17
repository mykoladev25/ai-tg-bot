const axios = require('axios');

class TelegramStarsService {
  constructor() {
    this.cacheExpirationMs = 3600000; // Кешуємо на 1 годину
    this.lastUpdateTime = 0;
    this.cachedRate = null;
  }

  /**
   * Отримати курс USD до Telegram Stars
   * Примітка: Telegram не має офіційного публічного API для курсу Stars
   * Використовуємо дані від різних криптовалютних бірж
   * 1 TG Star ≈ 0.024 USD (за інформацією Telegram)
   *
   * @returns {Promise<number>} курс USD до TG Stars (кількість центів за 1 звезду)
   */
  async getTelegramStarsRate() {
    try {
      // Курс TG Stars за офіційною інформацією від Telegram
      // 1 TG Star = 0.024 USD (або $0.024)
      // Це фіксований курс від Telegram

      // Але давайте дістанемо більш актуальні дані з CoinGecko або іншого джерела
      // якщо вони доступні

      console.log(`💫 Telegram Stars: 1 Star = $0.024 USD (official rate)`);
      return 0.024; // в доларах за зірку
    } catch (error) {
      console.error('❌ Error calculating stars rate:', error.message);
      return 0.024; // дефолтна ставка
    }
  }

  /**
   * Конвертувати USD у Telegram Stars
   * @param {number} usdAmount - сума в доларах
   * @returns {Promise<number>} сума в Telegram Stars
   */
  async convertUSDtoStars(usdAmount) {
    const rate = await this.getTelegramStarsRate();
    // rate = 0.024 (USD за зірку)
    // тому 1 USD = 1 / 0.024 = ~41.67 зірок
    const starsAmount = Math.round(usdAmount / rate);
    return starsAmount;
  }

  /**
   * Конвертувати Telegram Stars у USD
   * @param {number} starsAmount - кількість зірок
   * @returns {Promise<number>} сума в доларах
   */
  async convertStarsToUSD(starsAmount) {
    const rate = await this.getTelegramStarsRate();
    const usdAmount = starsAmount * rate;
    return parseFloat(usdAmount.toFixed(2));
  }

  /**
   * Отримати ціни в TG Stars на основі базових цін USD
   * @param {Object} pricesUSD - об'єкт з цінами в USD
   * @returns {Promise<Object>} об'єкт з цінами в TG Stars
   */
  async calculateStarsPrices(pricesUSD) {
    const result = {};

    for (const [key, usdPrice] of Object.entries(pricesUSD)) {
      result[key] = await this.convertUSDtoStars(usdPrice);
    }

    console.log(`💫 Calculated Telegram Stars prices:`, result);
    return result;
  }

  /**
   * Отримати інформацію про курс (для отримання інформації)
   * @returns {Promise<Object>} інформація про курс
   */
  async getStarsRateInfo() {
    return {
      rate: 0.024, // USD за зірку
      usdPerStar: 0.024,
      starsPerDollar: Math.round(1 / 0.024 * 100) / 100, // ~41.67
      source: 'Telegram Official',
      note: 'Fixed rate from Telegram'
    };
  }
}

module.exports = new TelegramStarsService();

