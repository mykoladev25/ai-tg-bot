const axios = require('axios');
const crypto = require('crypto');

class ExchangeRateService {
  constructor() {
    this.cacheExpirationMs = 3600000; // Кешуємо на 1 годину
    this.lastUpdateTime = 0;
    this.cachedRate = null;
    this.cachedSource = null;
    this.merchantAccount = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
    this.merchantSecretKey = process.env.WAYFORPAY_MERCHANT_KEY;
  }

  /**
   * Отримати курс USD/UAH від WayForPay (курс для платежів)
   * @returns {Promise<number>} курс гривні до долара
   */
  async getUSDtoUAHFromWayForPay() {
    try {
      if (!this.merchantAccount || !this.merchantSecretKey) {
        throw new Error('WAYFORPAY credentials not set');
      }

      const orderDate = Math.floor(Date.now() / 1000);
      const signatureString = [this.merchantAccount, orderDate].join(';');
      const merchantSignature = crypto
        .createHmac('md5', this.merchantSecretKey)
        .update(signatureString, 'utf8')
        .digest('hex');

      const response = await axios.post(
        'https://api.wayforpay.com/api',
        {
          apiVersion: 1,
          transactionType: 'CURRENCY_RATES',
          merchantAccount: this.merchantAccount,
          orderDate,
          merchantSignature,
          currency: 'USD'
        },
        {
          timeout: 5000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const data = response.data || {};
      const reasonCode = data.reasonCode || data.REASONCODE;
      if (reasonCode !== 1100) {
        throw new Error(`WayForPay response error: ${data.reason || data.REASON || 'Unknown'}`);
      }

      const rates = data.rates || data.RATES;
      if (rates && typeof rates === 'object' && Number(rates.USD)) {
        const rate = Number(rates.USD);
        console.log(`💱 WayForPay курс USD/UAH: ${rate.toFixed(2)}`);
        return rate;
      }

      if (Number(rates)) {
        const rate = Number(rates);
        console.log(`💱 WayForPay курс USD/UAH: ${rate.toFixed(2)}`);
        return rate;
      }

      throw new Error('Could not parse WayForPay rates response');
    } catch (error) {
      console.error('❌ Error fetching from WayForPay:', error.message);
      throw error;
    }
  }

  /**
   * Отримати курс USD/UAH від ПриватБанку (найбільш актуальний для України)
   * @returns {Promise<number>} курс гривні до долара
   */
  async getUSDtoUAHFromPrivatBank() {
    try {
      // API ПриватБанку для отримання курсів валют
      const response = await axios.get('https://api.privatbank.ua/p24api/pubinfo?json&exchange&coursid=5', {
        timeout: 3000  // Скоротили з 5000 до 3000ms
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
        timeout: 3000  // Скоротили з 5000 до 3000ms
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

    // Якщо кеш ще свіжий (менше 1 години), повертаємо його одразу
    if (this.cachedRate && (now - this.lastUpdateTime) < this.cacheExpirationMs) {
      console.log(`💰 Using cached rate: ${this.cachedRate.toFixed(2)} (${this.cachedSource || 'unknown'})`);
      return this.cachedRate;
    }

    console.log('🔄 Fetching fresh exchange rate...');

    try {
      // Якщо є кеш, повертаємо його а потім оновлюємо у фоні
      if (this.cachedRate) {
        // Запускаємо оновлення у фоні, але одразу повертаємо кеш
        setImmediate(() => this.updateRateInBackground());
        return this.cachedRate;
      }

      // Якщо кешу немає, чекаємо оновлення
      // Спробуємо WayForPay спочатку (курс для платежів)
      try {
        this.cachedRate = await this.getUSDtoUAHFromWayForPay();
        this.cachedSource = 'WayForPay';
        this.lastUpdateTime = now;
        return this.cachedRate;
      } catch (wayforpayError) {
        console.warn('⚠️ WayForPay API failed, trying PrivatBank...');

        // Якщо WayForPay не працює, спробуємо ПриватБанк
        try {
          this.cachedRate = await this.getUSDtoUAHFromPrivatBank();
          this.cachedSource = 'PrivatBank';
          this.lastUpdateTime = now;
          return this.cachedRate;
        } catch (privatBankError) {
          console.warn('⚠️ PrivatBank API failed, trying NBU...');

          // Якщо ПриватБанк не працює, спробуємо НБУ
          this.cachedRate = await this.getUSDtoUAHFromNBU();
          this.cachedSource = 'NBU';
          this.lastUpdateTime = now;
          return this.cachedRate;
        }
      }
    } catch (error) {
      console.error('❌ All exchange rate APIs failed:', error.message);

      // Якщо обидва API не працюють, використовуємо дефолтний курс
      const defaultRate = 45;
      console.warn(`⚠️ Using default rate: ${defaultRate}`);
      return defaultRate;
    }
  }

  /**
   * Оновити курс у фоні (не блокує виконання)
   */
  async updateRateInBackground() {
    try {
      console.log('🔄 Updating exchange rate in background...');
      try {
        this.cachedRate = await this.getUSDtoUAHFromWayForPay();
        this.cachedSource = 'WayForPay';
        this.lastUpdateTime = Date.now();
        console.log(`✅ Background update complete (WayForPay): ${this.cachedRate.toFixed(2)}`);
      } catch (wayforpayError) {
        try {
          this.cachedRate = await this.getUSDtoUAHFromPrivatBank();
          this.cachedSource = 'PrivatBank';
          this.lastUpdateTime = Date.now();
          console.log(`✅ Background update complete (PrivatBank): ${this.cachedRate.toFixed(2)}`);
        } catch (error) {
          this.cachedRate = await this.getUSDtoUAHFromNBU();
          this.cachedSource = 'NBU';
          this.lastUpdateTime = Date.now();
          console.log(`✅ Background update complete (NBU): ${this.cachedRate.toFixed(2)}`);
        }
      }
    } catch (error) {
      console.warn('⚠️ Background update failed:', error.message);
    }
  }

  getSource() {
    return this.cachedSource || 'unknown';
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
