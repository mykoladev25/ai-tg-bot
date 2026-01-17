const axios = require('axios');

class ExchangeRateService {
  constructor() {
    this.cacheExpirationMs = 3600000; // Кешуємо на 1 годину
    this.lastUpdateTime = 0;
    this.cachedRate = null;
  }

  /**
   * Отримати курс USD/UAH від ПриватБанку (найбільш актуальний для України)
   * @returns {Promise<number>} курс гривні до долара
   */
  async getUSDtoUAHFromPrivatBank() {
    try {
      // API ПриватБанку для отримання курсів валют
      const response = await axios.get('https://api.privatbank.ua/p24api/pubinfo?json&exchange&coursid=5', {
        timeout: 5000
      });

      if (response.data && Array.isArray(response.data)) {
        // Шукаємо пару USD/UAH
        const usdPair = response.data.find(pair => pair.ccy === 'USD' && pair.base_ccy === 'UAH');

        if (usdPair) {
          // Беремо середину між купівлею та продажем
          const buy = parseFloat(usdPair.buy);
          const sale = parseFloat(usdPair.sale);
          const rate = (buy + sale) / 2;

          console.log(`💱 ПриватБанк курс USD/UAH: ${rate.toFixed(2)}`);
          return rate;
        }
      }

      throw new Error('Could not find USD/UAH pair in PrivatBank response');
    } catch (error) {
      console.error('❌ Error fetching from PrivatBank:', error.message);
      throw error;
    }
  }

  /**
   * Отримати курс USD/UAH від НБУ (National Bank of Ukraine)
   * @returns {Promise<number>} курс гривні до долара
   */
  async getUSDtoUAHFromNBU() {
    try {
      // API НБУ для отримання курсів валют
      const response = await axios.get('https://bank.gov.ua/NBUStatService/v1/statdataandtimeofchange?valuecode=USD', {
        timeout: 5000
      });

      if (response.data && response.data.length > 0) {
        const rate = response.data[0].rate;
        console.log(`💱 НБУ курс USD/UAH: ${rate.toFixed(2)}`);
        return rate;
      }

      throw new Error('Could not parse NBU response');
    } catch (error) {
      console.error('❌ Error fetching from NBU:', error.message);
      throw error;
    }
  }

  /**
   * Отримати актуальний курс USD/UAH з кешуванням
   * Спочатку намагаємось ПриватБанк, потім НБУ, потім дефолт
   * @returns {Promise<number>} курс гривні до долара
   */
  async getRate() {
    const now = Date.now();

    // Якщо кеш ще свіжий, повертаємо його
    if (this.cachedRate && (now - this.lastUpdateTime) < this.cacheExpirationMs) {
      console.log(`💰 Using cached rate: ${this.cachedRate.toFixed(2)} (age: ${Math.round((now - this.lastUpdateTime) / 1000)}s)`);
      return this.cachedRate;
    }

    console.log('🔄 Fetching fresh exchange rate...');

    try {
      // Спробуємо ПриватБанк спочатку (швидше)
      try {
        this.cachedRate = await this.getUSDtoUAHFromPrivatBank();
        this.lastUpdateTime = now;
        return this.cachedRate;
      } catch (privatBankError) {
        console.warn('⚠️ PrivatBank API failed, trying NBU...');

        // Якщо ПриватБанк не працює, спробуємо НБУ
        this.cachedRate = await this.getUSDtoUAHFromNBU();
        this.lastUpdateTime = now;
        return this.cachedRate;
      }
    } catch (error) {
      console.error('❌ Both exchange rate APIs failed:', error.message);

      // Якщо обидва API не працюють, використовуємо дефолтний курс
      // або повертаємо кешований (навіть якщо старий)
      if (this.cachedRate) {
        console.warn(`⚠️ Using stale cached rate: ${this.cachedRate.toFixed(2)}`);
        return this.cachedRate;
      }

      // Дефолтний курс (для екстремальних випадків)
      const defaultRate = 45;
      console.warn(`⚠️ Using default rate: ${defaultRate}`);
      return defaultRate;
    }
  }

  /**
   * Конвертувати USD у UAH
   * @param {number} usdAmount - сума в доларах
   * @returns {Promise<number>} сума в гривнях
   */
  async convertUSDtoUAH(usdAmount) {
    const rate = await this.getRate();
    return Math.round(usdAmount * rate);
  }

  /**
   * Отримати розраховані ціни LiqPay на основі реального курсу
   * @param {Object} prices - об'єкт з цінами в USD
   * @returns {Promise<Object>} об'єкт з цінами в UAH
   */
  async calculateLiqPayPrices(prices) {
    const rate = await this.getRate();
    const result = {};

    for (const [key, usdPrice] of Object.entries(prices)) {
      result[key] = Math.round(usdPrice * rate);
    }

    console.log(`💱 Calculated LiqPay prices at rate ${rate.toFixed(2)}:`, result);
    return result;
  }
}

module.exports = new ExchangeRateService();

