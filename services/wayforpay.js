const crypto = require('crypto');

class WayForPayService {
    constructor() {
        this.merchantAccount = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
        this.merchantSecretKey = process.env.WAYFORPAY_MERCHANT_KEY;
        this.merchantDomainName = process.env.WAYFORPAY_DOMAIN
            || process.env.APP_URL?.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
            || 'example.com';
        this.checkoutUrl = 'https://secure.wayforpay.com/pay';
    }

    /**
     * Generate the HMAC_MD5 signature required by WayForPay.
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

        return crypto
            .createHmac('md5', this.merchantSecretKey)
            .update(signatureString, 'utf8')
            .digest('hex');
    }

    /**
     * Verify a WayForPay callback signature.
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
     * Verify payment status through the WayForPay API.
     */
    async checkPaymentStatus(orderReference) {
        try {
            if (!this.merchantAccount) {
                throw new Error('WAYFORPAY_MERCHANT_ACCOUNT is not configured');
            }

            console.log(`🔍 Checking payment status for order: ${orderReference}`);

            const signatureString = [
                this.merchantAccount,
                orderReference
            ].join(';');

            const signature = crypto
                .createHmac('md5', this.merchantSecretKey)
                .update(signatureString, 'utf8')
                .digest('hex');

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
     * Generate a signature for callback acknowledgements.
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
                throw new Error('WAYFORPAY_MERCHANT_ACCOUNT is not configured');
            }
            if (!this.merchantSecretKey) {
                throw new Error('WAYFORPAY_MERCHANT_KEY is not configured');
            }

            const {
                order_id,
                amount,
                currency = 'UAH',
                description,
                result_url,
                decline_url,
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
                declineUrl: decline_url,
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
