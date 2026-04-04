const crypto = require('crypto');
const axios = require('axios');

class LiqPayService {
  constructor() {
    this.publicKey = process.env.LIQPAY_PUBLIC_KEY;
    this.privateKey = process.env.LIQPAY_PRIVATE_KEY;
    this.serverUrl = process.env.LIQPAY_SERVER_URL || 'https://www.liqpay.ua/api/3';
  }

  
  sign(jsonString) {
    const signString = this.privateKey + jsonString + this.privateKey;
    return crypto.createHash('sha1').update(signString).digest('base64');
  }

  
  encodeParams(params) {
    return Buffer.from(JSON.stringify(params)).toString('base64');
  }

  
  decodeParams(encodedData) {
    return JSON.parse(Buffer.from(encodedData, 'base64').toString('utf-8'));
  }

  
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

  
  verifySignature(data, signature) {
    try {
      const calculatedSignature = this.sign(data);
      return calculatedSignature === signature;
    } catch (error) {
      console.error('LiqPay signature verification error:', error);
      return false;
    }
  }

  
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

