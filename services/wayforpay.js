const crypto = require('crypto');

class WayForPayService {
    constructor() {
        this.merchantAccount = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
        this.merchantSecretKey = process.env.WAYFORPAY_MERCHANT_KEY;
        this.merchantDomainName = process.env.WAYFORPAY_DOMAIN || 'neurolab.fun';
        this.checkoutUrl = 'https://secure.wayforpay.com/pay';
    }

    /**
     * Генерація HMAC_MD5 підпису для WayForPay
     */
    createSignature(params) {
        const signatureParts = [
            this.merchantAccount,
            this.merchantDomainName,
            params.orderReference,
            params.orderDate,
            params.amount,
            params.currency,
            ...params.productName,
            ...params.productCount,
            ...params.productPrice
        ];

        const signatureString = signatureParts.join(';');

        // ⚠️ SECURITY: Не логуємо signature string - може містити чутливі дані
        // console.log('📝 Signature string:', signatureString);

        return crypto
            .createHmac('md5', this.merchantSecretKey)
            .update(signatureString, 'utf8')
            .digest('hex');
    }

    /**
     * Верифікація підпису callback від WayForPay
     */
    verifySignature(data) {
        try {
            const {
                merchantAccount,
                orderReference,
                amount,
                currency,
                authCode,
                cardPan,
                transactionStatus,
                reasonCode,
                merchantSignature
            } = data;

            const signatureParts = [
                merchantAccount,
                orderReference,
                amount,
                currency,
                authCode,
                cardPan,
                transactionStatus,
                reasonCode
            ];

            const signatureString = signatureParts.join(';');
            const calculatedSignature = crypto
                .createHmac('md5', this.merchantSecretKey)
                .update(signatureString, 'utf8')
                .digest('hex');

            const isValid = calculatedSignature === merchantSignature;

            if (!isValid) {
                console.warn('⚠️ WayForPay signature mismatch', {
                    expected: merchantSignature,
                    calculated: calculatedSignature
                });
            }

            return isValid;
        } catch (error) {
            console.error('WayForPay signature verification error:', error);
            return false;
        }
    }

    /**
     * Верифікація статусу платежу через WayForPay API
     * Підпис для CHECK_STATUS: HMAC_MD5(merchantSecretKey, merchantAccount;orderReference)
     * ⚠️ БЕЗ timestamp! Згідно офіційної документації WayForPay
     */
    async checkPaymentStatus(orderReference) {
        try {
            if (!this.merchantAccount) {
                throw new Error('WAYFORPAY_MERCHANT_ACCOUNT не встановлена');
            }

            console.log(`🔍 Checking payment status for order: ${orderReference}`);

            // ✅ ПРАВИЛЬНИЙ ФОРМАТ підпису для CHECK_STATUS:
            // За документацією WayForPay: merchantAccount;orderReference (БЕЗ timestamp!)
            const signatureString = [
                this.merchantAccount,
                orderReference
            ].join(';');

            const signature = crypto
                .createHmac('md5', this.merchantSecretKey)
                .update(signatureString, 'utf8')
                .digest('hex');

            // ⚠️ SECURITY: Не логуємо signature string
            // console.log(`📝 Status check signature string: ${signatureString}`);
            // ⚠️ SECURITY: Не логуємо signatures
            // console.log(`📝 Generated signature: ${signature}`);

            // Робимо запит до WayForPay API
            const axios = require('axios');
            const response = await axios.post(
                'https://api.wayforpay.com/api',
                {
                    transactionType: 'CHECK_STATUS',
                    merchantAccount: this.merchantAccount,
                    orderReference: orderReference,
                    merchantSignature: signature,
                    apiVersion: 1
                },
                {
                    timeout: 10000,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`📊 Payment status response:`, response.data);

            return response.data;
        } catch (error) {
            console.error('❌ Error checking payment status:', error.message);
            return {
                transactionStatus: 'ERROR',
                error: error.message
            };
        }
    }

    /**
     * Генерація підпису для відповіді на callback
     */
    createResponseSignature(orderReference, status, time) {
        const signatureString = [orderReference, status, time].join(';');
        return crypto
            .createHmac('md5', this.merchantSecretKey)
            .update(signatureString, 'utf8')
            .digest('hex');
    }

    async createCheckout(params) {
        try {
            if (!this.merchantAccount) {
                throw new Error('WAYFORPAY_MERCHANT_ACCOUNT не встановлена');
            }
            if (!this.merchantSecretKey) {
                throw new Error('WAYFORPAY_MERCHANT_KEY не встановлена');
            }

            const {
                order_id,
                amount,
                currency = 'UAH',
                description,
                result_url,  // success URL
                decline_url, // failure URL
                server_url
            } = params;

            const orderDate = Math.floor(Date.now() / 1000);
            const productName = [description];
            const productCount = [1];
            const productPrice = [amount];

            const signature = this.createSignature({
                orderReference: order_id,
                orderDate,
                amount,
                currency,
                productName,
                productCount,
                productPrice
            });

            const checkoutParams = {
                merchantAccount: this.merchantAccount,
                merchantDomainName: this.merchantDomainName,
                merchantSignature: signature,
                orderReference: order_id,
                orderDate: orderDate,
                amount: amount,
                currency: currency,
                productName: productName,
                productCount: productCount,
                productPrice: productPrice,
                returnUrl: result_url,
                declineUrl: decline_url,  // ✅ Добавляємо URL для відхилених платежів
                serviceUrl: server_url,
                language: 'UK'
            };

            console.log('✅ WayForPay checkout created:', {
                order_id,
                amount,
                currency,
                returnUrl: result_url,
                declineUrl: decline_url,
                signature: signature.substring(0, 8) + '...'
            });

            return {
                params: checkoutParams,
                checkoutUrl: this.checkoutUrl
            };
        } catch (error) {
            console.error('WayForPay checkout error:', error);
            throw error;
        }
    }
}

module.exports = new WayForPayService();