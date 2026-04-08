const express = require('express');
const router = express.Router();
const wayforpay = require('../services/wayforpay');
const userBalance = require('../utils/userBalance');
const models = require('../config/models');
const { logPaymentEvent } = require('../monitoring/loggers');

module.exports = function(bot) {

    router.post('/wayforpay', express.text({ type: '*/*' }), async (req, res) => {
        try {
            let data;
            const rawBody = typeof req.rawBody === 'string' && req.rawBody.length > 0
                ? req.rawBody
                : Buffer.isBuffer(req.body)
                    ? req.body.toString('utf8')
                    : typeof req.body === 'string'
                        ? req.body
                        : null;

            if (typeof req.body === 'string') {
                // Raw JSON string
                console.log('📥 Parsing raw JSON from WayForPay...');
                try {
                    data = JSON.parse(req.body);
                } catch (e) {
                    console.error('❌ Failed to parse raw JSON:', e.message);
                    return res.status(400).json({ error: 'Invalid JSON' });
                }
            } else if (typeof req.body === 'object') {
                const keys = Object.keys(req.body);
                if (keys.length === 1 && keys[0].startsWith('{')) {
                    console.log('📥 Extracting JSON from form key...');
                    try {
                        data = JSON.parse(keys[0]);
                    } catch (e) {
                        console.error('❌ Failed to parse JSON from key:', e.message);
                        return res.status(400).json({ error: 'Invalid JSON format' });
                    }
                } else {
                    data = req.body;
                }
            } else {
                console.error('❌ Unexpected body type:', typeof req.body);
                return res.status(400).json({ error: 'Invalid request body' });
            }

            console.log('📥 WayForPay webhook summary:', {
                orderReference: data.orderReference,
                transactionStatus: data.transactionStatus,
                amount: data.amount,
                reasonCode: data.reasonCode,
                authCode: data.authCode,
                reason: data.reason
            });

            if (!wayforpay.verifySignature(data, rawBody)) {
                console.error('❌ WayForPay: Invalid signature');
                return res.status(400).json({ error: 'Invalid signature' });
            }

            const { orderReference, transactionStatus, amount } = data;

            const parts = orderReference.split('_');
            if (parts.length < 3) {
                console.error('❌ Invalid orderReference format:', orderReference);
                return res.status(400).json({ error: 'Invalid orderReference' });
            }

            const userId = parseInt(parts[0]);
            const planKey = parts[1];

            const sub = models.subscriptions[planKey];
            if (!sub) {
                console.error('❌ Invalid plan:', planKey);
                return res.status(400).json({ error: 'Invalid plan' });
            }

            const tokens = sub.tokensWayForPay || sub.tokens;

            if (transactionStatus === 'Approved' || transactionStatus === 'Completed') {
                console.log(`✅ Processing SUCCESSFUL payment: ${orderReference} (status: ${transactionStatus})`);
                const Transaction = require('../database/models/Transaction');
                const existing = await Transaction.findOne({
                    'metadata.orderId': orderReference,
                    type: 'wayforpay_purchase'
                });

                if (existing) {
                    console.log(`⚠️ WayForPay: Order ${orderReference} already processed`);

                    try {
                        const user = await userBalance.getUser(userId, { id: userId });
                        await bot.telegram.sendMessage(
                            userId,
                            `✅ <b>Payment confirmed.</b>\n\n` +
                            `💳 Method: WayForPay\n` +
                            `💎 Plan: ${sub.name}\n` +
                            `⚡ Tokens on balance: ${user.tokens.toFixed(2)}\n\n` +
                            `Thank you for your purchase.`,
                            { parse_mode: 'HTML' }
                        );
                        console.log(`📨 Confirmation message sent to user ${userId}`);
                    } catch (err) {
                        console.error('Error sending confirmation message:', err.message);
                    }
                } else {
                    await userBalance.addTokens(
                        userId,
                        tokens,
                        'wayforpay_purchase',
                        {
                            plan: sub.name,
                            planKey: planKey,
                            orderId: orderReference,
                            amount: amount
                        }
                    );

                    console.log(`✅ WayForPay: +${tokens}⚡ to user ${userId} (${sub.name})`);

                    // ✅ Log payment event for monitoring
                    await logPaymentEvent({
                        userId: String(userId),
                        provider: 'wayforpay',
                        providerPaymentId: orderReference,
                        planKey: planKey,
                        amountUAH: amount,
                        amountUSD: sub.priceUSD || null,
                        tokensGranted: tokens,
                        status: 'success',
                        raw: data
                    });

                    try {
                        const user = await userBalance.getUser(userId, { id: userId });
                        await bot.telegram.sendMessage(
                            userId,
                            `✅ <b>Payment received.</b>\n\n` +
                            `💳 Method: WayForPay\n` +
                            `💎 Plan: ${sub.name}\n` +
                            `⚡ Tokens credited: ${tokens}\n` +
                            `💰 New balance: ${user.tokens.toFixed(2)}⚡\n\n` +
                            `Thank you for your purchase.`,
                            { parse_mode: 'HTML' }
                        );
                        console.log(`📨 Success message sent to user ${userId}`);
                    } catch (err) {
                        console.error('Error sending message to user:', err.message);
                    }
                }
            } else if (transactionStatus === 'Declined' || transactionStatus === 'Failed') {
                console.log(`❌ Processing DECLINED/FAILED payment: ${orderReference} (${transactionStatus})`);
                console.log(`⚠️ NOT adding tokens for declined payment`);

                try {
                    await bot.telegram.sendMessage(
                        userId,
                        `❌ <b>Payment was not successful</b>\n\n` +
                        `💳 Method: WayForPay\n` +
                        `💎 Plan: ${sub.name}\n` +
                        `💰 Amount: ${amount} UAH\n` +
                        `🔴 Status: ${transactionStatus}\n\n` +
                        `Please:\n` +
                        `• Check your card details\n` +
                        `• Make sure the card is active\n` +
                        `• Try another card\n` +
                        `• Contact your bank\n\n` +
                        `Order: ${orderReference}`,
                        { parse_mode: 'HTML' }
                    );
                    console.log(`📨 Decline message sent to user ${userId}`);
                } catch (err) {
                    console.error('Error sending decline message:', err.message);
                }
            } else if (transactionStatus === 'Refunded') {
                console.log(`⚠️ Processing REFUNDED payment: ${orderReference}`);
                console.log(`⚠️ Refund reason: ${data.reason} (code: ${data.reasonCode})`);

                try {
                    const Transaction = require('../database/models/Transaction');

                    const transaction = await Transaction.findOne({
                        'metadata.orderId': orderReference,
                        type: 'wayforpay_purchase'
                    });

                    if (transaction && transaction.status === 'completed') {
                        console.log(`💔 Refunding ${tokens}⚡ to user ${userId}`);
                        console.log(`📝 Refund details:`, {
                            orderId: orderReference,
                            reasonCode: data.reasonCode,
                            reason: data.reason,
                            authCode: data.authCode
                        });

                        const user = await userBalance.getUser(userId, { id: userId });
                        const tokensToRemove = Math.min(tokens, user.tokens || 0);

                        if (tokensToRemove > 0) {
                            await userBalance.removeTokens(
                                userId,
                                tokensToRemove,
                                'wayforpay_refund',
                                {
                                    plan: sub.name,
                                    planKey: planKey,
                                    orderId: orderReference,
                                    amount: amount,
                                    reason: data.reason,
                                    reasonCode: data.reasonCode
                                }
                            );

                            const updatedUser = await userBalance.getUser(userId, { id: userId });
                            await bot.telegram.sendMessage(
                                userId,
                                `⚠️ <b>Payment was refunded</b>\n\n` +
                                `💳 Method: WayForPay\n` +
                                `💎 Plan: ${sub.name}\n` +
                                `⚡ Refunded: ${tokensToRemove}\n` +
                                `💰 Current balance: ${updatedUser.tokens.toFixed(2)}⚡\n\n` +
                                `Reason: ${data.reason}\n` +
                                `Code: ${data.reasonCode}\n\n` +
                                `Order: ${orderReference}`,
                                { parse_mode: 'HTML' }
                            );
                        }

                        await Transaction.updateOne(
                            { 'metadata.orderId': orderReference },
                            {
                                status: 'refunded',
                                'metadata.refundedAt': new Date(),
                                'metadata.refundReason': data.reason,
                                'metadata.refundReasonCode': data.reasonCode
                            }
                        );

                        console.log(`💔 Refund processed: ${orderReference}`);
                    } else {
                        console.log(`ℹ️ Refund for non-existent or already refunded transaction: ${orderReference}`);
                    }
                } catch (err) {
                    console.error('Error processing refund:', err.message);
                }
            } else if (transactionStatus === 'Pending') {
                console.log(`⏳ Processing PENDING payment: ${orderReference}`);
                console.log(`   Reason: ${data.reason} (code: ${data.reasonCode})`);
                console.log(`   (Waiting for bank verification or next webhook update)`);

                try {
                    await bot.telegram.sendMessage(
                        userId,
                        `⏳ <b>Awaiting confirmation</b>\n\n` +
                        `💳 Method: WayForPay\n` +
                        `💎 Plan: ${sub.name}\n` +
                        `💰 Amount: ${amount} UAH\n\n` +
                        `Your payment is awaiting bank confirmation.\n` +
                        `This can take a few minutes, including 3DS verification.\n\n` +
                        `⚡ Tokens will be credited automatically after successful verification.\n\n` +
                        `Order: ${orderReference}`,
                        { parse_mode: 'HTML' }
                    );
                    console.log(`📨 Pending verification message sent to user ${userId}`);
                } catch (err) {
                    console.error('Error sending pending message:', err.message);
                }
            } else if (transactionStatus === 'Expired') {
                console.log(`⏳ [Expired] Order: ${orderReference}`);

                try {
                    const Transaction = require('../database/models/Transaction');
                    const existingTransaction = await Transaction.findOne({
                        'metadata.orderId': orderReference,
                        type: 'wayforpay_purchase'
                    });

                    if (existingTransaction) {
                        console.log(`ℹ️ [Expired] Ignoring - payment already completed: ${orderReference}`);
                        return;
                    }

                    console.log(`⚠️ [Expired] Payment was NOT completed, notifying user: ${orderReference}`);

                    try {
                        await bot.telegram.sendMessage(
                            userId,
                            `⏳ <b>Payment session expired</b>\n\n` +
                            `💳 Method: WayForPay\n` +
                            `💎 Plan: ${sub.name}\n` +
                            `💰 Amount: ${amount} UAH\n\n` +
                            `The payment session expired before completion.\n` +
                            `Please try again when you are ready.\n\n` +
                            `Order: ${orderReference}`,
                            { parse_mode: 'HTML' }
                        );
                        console.log(`📨 Expired message sent to user ${userId}`);
                    } catch (err) {
                        console.error('Error sending expired message:', err.message);
                    }
                } catch (err) {
                    console.error('Error checking expired payment:', err.message);
                }
            } else {
                console.log(`⚠️ WayForPay: Transaction ${transactionStatus} for order ${orderReference}`);
                if (data.reason) {
                    console.log(`   Reason: ${data.reason} (code: ${data.reasonCode})`);
                }
            }

            const time = Math.floor(Date.now() / 1000);
            const responseSignature = wayforpay.createResponseSignature(orderReference, 'accept', time);

            console.log('📤 Sending WayForPay response:', {
                orderReference,
                status: 'accept',
                time,
                signature: responseSignature.substring(0, 16) + '...'
            });

            res.json({
                orderReference: orderReference,
                status: 'accept',
                time: time,
                signature: responseSignature
            });

        } catch (error) {
            console.error('❌ WayForPay webhook error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
};
