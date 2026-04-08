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

    extractRawJsonField(rawBody, fieldName) {
        if (typeof rawBody !== 'string' || !rawBody) {
            return null;
        }

        const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = rawBody.match(new RegExp(`"${escapedFieldName}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|[^,}\\r\\n]+)`));

        if (!match) {
            return null;
        }

        const token = match[1].trim();
        if (token.startsWith('"')) {
            try {
                return JSON.parse(token);
            } catch (error) {
                return token.slice(1, -1);
            }
        }

        return token;
    }

    getCallbackSignatureFieldValue(fieldName, data, rawBody) {
        const rawValue = this.extractRawJsonField(rawBody, fieldName);
        if (rawValue !== null && rawValue !== undefined) {
            return String(rawValue);
        }

        const parsedValue = data?.[fieldName];
        return parsedValue === undefined || parsedValue === null ? '' : String(parsedValue);
    }

    signaturesEqual(expected, actual) {
        const left = String(expected || '');
        const right = String(actual || '');

        if (left.length !== right.length) {
            return false;
        }

        return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
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
    verifySignature(data, rawBody = null) {
        try {
            const signatureParts = [
                'merchantAccount',
                'orderReference',
                'amount',
                'currency',
                'authCode',
                'cardPan',
                'transactionStatus',
                'reasonCode'
            ].map((fieldName) => this.getCallbackSignatureFieldValue(fieldName, data, rawBody));

            const merchantSignature = this.getCallbackSignatureFieldValue('merchantSignature', data, rawBody).trim();

            const signatureString = signatureParts.join(';');
            const calculatedSignature = crypto
                .createHmac('md5', this.merchantSecretKey)
                .update(signatureString, 'utf8')
                .digest('hex');

            const isValid = this.signaturesEqual(calculatedSignature, merchantSignature);

            if (!isValid) {
                console.warn('⚠️ WayForPay signature mismatch', {
                    expected: merchantSignature,
                    calculated: calculatedSignature,
                    orderReference: signatureParts[1],
                    amount: signatureParts[2]
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
