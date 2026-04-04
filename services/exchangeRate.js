const axios = require('axios');
const crypto = require('crypto');

class ExchangeRateService {
  constructor() {
    this.cacheExpirationMs = 3600000; 
    this.lastUpdateTime = 0;
    this.cachedRate = null;
    this.cachedSource = null;
    this.merchantAccount = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
    this.merchantSecretKey = process.env.WAYFORPAY_MERCHANT_KEY;
  }

  
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
        console.log(`💱 WayForPay USD/UAH rate: ${rate.toFixed(2)}`);
        return rate;
      }

      if (Number(rates)) {
        const rate = Number(rates);
        console.log(`💱 WayForPay USD/UAH rate: ${rate.toFixed(2)}`);
        return rate;
      }

      throw new Error('Could not parse WayForPay rates response');
    } catch (error) {
      console.error('❌ Error fetching from WayForPay:', error.message);
      throw error;
    }
  }

  
  async getUSDtoUAHFromPrivatBank() {
    try {
      const response = await axios.get('https://api.privatbank.ua/p24api/pubinfo?json&exchange&coursid=5', {
        timeout: 3000  
      });

      if (response.data && Array.isArray(response.data)) {
        const usdPair = response.data.find(pair => pair.ccy === 'USD' && pair.base_ccy === 'UAH');

        if (usdPair) {
          const buy = parseFloat(usdPair.buy);
          const sale = parseFloat(usdPair.sale);
          const rate = (buy + sale) / 2;

          console.log(`💱 PrivatBank USD/UAH rate: ${rate.toFixed(2)}`);
          return rate;
        }
      }

      throw new Error('Could not find USD/UAH pair in PrivatBank response');
    } catch (error) {
      console.error('❌ Error fetching from PrivatBank:', error.message);
      throw error;
    }
  }

  
  async getUSDtoUAHFromNBU() {
    try {
      const response = await axios.get('https://bank.gov.ua/NBUStatService/v1/statdataandtimeofchange?valuecode=USD', {
        timeout: 3000  
      });

      if (response.data && response.data.length > 0) {
        const rate = response.data[0].rate;
        console.log(`💱 NBU USD/UAH rate: ${rate.toFixed(2)}`);
        return rate;
      }

      throw new Error('Could not parse NBU response');
    } catch (error) {
      console.error('❌ Error fetching from NBU:', error.message);
      throw error;
    }
  }

  
  async getRate() {
    const now = Date.now();

    if (this.cachedRate && (now - this.lastUpdateTime) < this.cacheExpirationMs) {
      console.log(`💰 Using cached rate: ${this.cachedRate.toFixed(2)} (${this.cachedSource || 'unknown'})`);
      return this.cachedRate;
    }

    console.log('🔄 Fetching fresh exchange rate...');

    try {
      if (this.cachedRate) {
        setImmediate(() => this.updateRateInBackground());
        return this.cachedRate;
      }

      try {
        this.cachedRate = await this.getUSDtoUAHFromWayForPay();
        this.cachedSource = 'WayForPay';
        this.lastUpdateTime = now;
        return this.cachedRate;
      } catch (wayforpayError) {
        console.warn('⚠️ WayForPay API failed, trying PrivatBank...');

        try {
          this.cachedRate = await this.getUSDtoUAHFromPrivatBank();
          this.cachedSource = 'PrivatBank';
          this.lastUpdateTime = now;
          return this.cachedRate;
        } catch (privatBankError) {
          console.warn('⚠️ PrivatBank API failed, trying NBU...');

          this.cachedRate = await this.getUSDtoUAHFromNBU();
          this.cachedSource = 'NBU';
          this.lastUpdateTime = now;
          return this.cachedRate;
        }
      }
    } catch (error) {
      console.error('❌ All exchange rate APIs failed:', error.message);

      const defaultRate = 45;
      console.warn(`⚠️ Using default rate: ${defaultRate}`);
      return defaultRate;
    }
  }

  
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

  
  async convertUSDtoUAH(usdAmount) {
    const rate = await this.getRate();
    return Math.round(usdAmount * rate);
  }

  
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
