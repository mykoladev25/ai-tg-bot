const crypto = require('crypto');
const axios = require('axios');

class LiqPayService {
  constructor() {
    this.publicKey = process.env.LIQPAY_PUBLIC_KEY;
    this.privateKey = process.env.LIQPAY_PRIVATE_KEY;
    this.serverUrl = process.env.LIQPAY_SERVER_URL || 'https://www.liqpay.ua/api/3';
  }

  /**
   * Знак LiqPay - конкатенація приватного ключа, JSON у base64 та приватного ключа
   */
  sign(jsonString) {
    const signString = this.privateKey + jsonString + this.privateKey;
    return crypto.createHash('sha1').update(signString).digest('base64');
  }

  /**
   * Кодування параметрів платежу в base64
   */
  encodeParams(params) {
    return Buffer.from(JSON.stringify(params)).toString('base64');
  }

  /**
   * Декодування параметрів платежу з base64
   */
  decodeParams(encodedData) {
    return JSON.parse(Buffer.from(encodedData, 'base64').toString('utf-8'));
  }

  /**
   * Створення платежу через LiqPay
   * @param {Object} params - параметри платежу
   * @returns {Promise<Object>} - результат з посиланням на платіж
   */
  async createCheckout(params) {
    try {
      const defaultParams = {
        public_key: this.publicKey,
        version: '3',
        action: 'pay',
        currency: 'UAH',
        ...params
      };

      const encodedParams = this.encodeParams(defaultParams);
      const signature = this.sign(encodedParams);

      return {
        data: encodedParams,
        signature: signature,
        publicKey: this.publicKey,
        params: defaultParams
      };
    } catch (error) {
      console.error('LiqPay checkout creation error:', error);
      throw error;
    }
  }

  /**
   * Верифікація підпису callback'а з LiqPay
   * @param {string} data - закодовані дані від callback
   * @param {string} signature - підпис від LiqPay
   * @returns {boolean} - чи правильний підпис
   */
  verifySignature(data, signature) {
    try {
      const calculatedSignature = this.sign(data);
      return calculatedSignature === signature;
    } catch (error) {
      console.error('LiqPay signature verification error:', error);
      return false;
    }
  }

  /**
   * Отримання статусу платежу
   * @param {string} orderId - ID замовлення
   * @returns {Promise<Object>} - статус платежу
   */
  async getStatus(orderId) {
    try {
      const params = {
        public_key: this.publicKey,
        version: '3',
        action: 'status',
        order_id: orderId
      };

      const encodedParams = this.encodeParams(params);
      const signature = this.sign(encodedParams);

      const response = await axios.post(`${this.serverUrl}/status`, {
        data: encodedParams,
        signature: signature
      });

      return response.data;
    } catch (error) {
      console.error('LiqPay status check error:', error);
      throw error;
    }
  }

  /**
   * Рефунд платежу
   * @param {string} orderId - ID замовлення
   * @param {number} amount - сума для повернення (опціонально для частичного рефунду)
   * @returns {Promise<Object>} - результат рефунду
   */
  async refund(orderId, amount = null) {
    try {
      const params = {
        public_key: this.publicKey,
        version: '3',
        action: 'refund',
        order_id: orderId
      };

      if (amount) {
        params.amount = amount;
      }

      const encodedParams = this.encodeParams(params);
      const signature = this.sign(encodedParams);

      const response = await axios.post(`${this.serverUrl}/refund`, {
        data: encodedParams,
        signature: signature
      });

      return response.data;
    } catch (error) {
      console.error('LiqPay refund error:', error);
      throw error;
    }
  }
}

module.exports = new LiqPayService();

