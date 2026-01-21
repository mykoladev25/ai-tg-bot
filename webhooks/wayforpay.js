const express = require('express');
const router = express.Router();
const wayforpay = require('../services/wayforpay');
const userBalance = require('../utils/userBalance');
const models = require('../config/models');

module.exports = function(bot) {

    router.post('/wayforpay', express.json(), async (req, res) => {
        try {
            const data = req.body;

            console.log('📥 WayForPay webhook received (full data):', JSON.stringify(data, null, 2));
            console.log('📥 WayForPay webhook summary:', {
                orderReference: data.orderReference,
                transactionStatus: data.transactionStatus,
                amount: data.amount,
                reasonCode: data.reasonCode,
                authCode: data.authCode
            });

            // Верифікуємо підпис
            if (!wayforpay.verifySignature(data)) {
                console.error('❌ WayForPay: Invalid signature');
                return res.status(400).json({ error: 'Invalid signature' });
            }

            const { orderReference, transactionStatus, amount } = data;

            // Парсимо order_id: userId_plan_timestamp
            const parts = orderReference.split('_');
            if (parts.length < 3) {
                console.error('❌ Invalid orderReference format:', orderReference);
                return res.status(400).json({ error: 'Invalid orderReference' });
            }

            const userId = parseInt(parts[0]);
            const planKey = parts[1];

            // ✅ Визначаємо токени з плану на СЕРВЕРІ!
            const sub = models.subscriptions[planKey];
            if (!sub) {
                console.error('❌ Invalid plan:', planKey);
                return res.status(400).json({ error: 'Invalid plan' });
            }

            const tokens = sub.tokensLiqPay || sub.tokens;

            // WayForPay відправляє 'Completed' як статус успішного платежу
            if (transactionStatus === 'Completed') {
                console.log(`✅ Processing COMPLETED payment: ${orderReference}`);
                // Перевіряємо чи вже оброблено (ідемпотентність)
                const Transaction = require('../database/models/Transaction');
                const existing = await Transaction.findOne({
                    'metadata.orderId': orderReference,
                    type: 'wayforpay_purchase'
                });

                if (existing) {
                    console.log(`⚠️ WayForPay: Order ${orderReference} already processed`);

                    // ✅ ВАЖЛИВО: Все одно відправляємо повідомлення користувачу
                    // (можливо webhook прийшов пізніше ніж користувач попав на success page)
                    try {
                        const user = await userBalance.getUser(userId, { id: userId });
                        await bot.telegram.sendMessage(
                            userId,
                            `✅ <b>Оплату підтверджено!</b>\n\n` +
                            `💳 Метод: WayForPay\n` +
                            `💎 Тариф: ${sub.name}\n` +
                            `⚡ Токенів на балансі: ${user.tokens.toFixed(2)}\n\n` +
                            `Дякуємо за покупку! 🎉`,
                            { parse_mode: 'HTML' }
                        );
                        console.log(`📨 Confirmation message sent to user ${userId}`);
                    } catch (err) {
                        console.error('Error sending confirmation message:', err.message);
                    }
                } else {
                    // Нараховуємо токени
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

                    // Повідомляємо користувача
                    try {
                        const user = await userBalance.getUser(userId, { id: userId });
                        await bot.telegram.sendMessage(
                            userId,
                            `✅ <b>Оплату отримано!</b>\n\n` +
                            `💳 Метод: WayForPay\n` +
                            `💎 Тариф: ${sub.name}\n` +
                            `⚡ Токенів нараховано: ${tokens}\n` +
                            `💰 Новий баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
                            `Дякуємо за покупку! 🎉`,
                            { parse_mode: 'HTML' }
                        );
                        console.log(`📨 Success message sent to user ${userId}`);
                    } catch (err) {
                        console.error('Error sending message to user:', err.message);
                    }
                }
            } else if (transactionStatus === 'Declined' || transactionStatus === 'Failed') {
                // Платіж відхилений
                console.log(`❌ Processing DECLINED/FAILED payment: ${orderReference} (${transactionStatus})`);
                console.log(`⚠️ NOT adding tokens for declined payment`);

                try {
                    await bot.telegram.sendMessage(
                        userId,
                        `❌ <b>Платіж не був успішним</b>\n\n` +
                        `💳 Метод: WayForPay\n` +
                        `💎 Тариф: ${sub.name}\n` +
                        `💰 Сума: ${amount} UAH\n` +
                        `🔴 Статус: ${transactionStatus}\n\n` +
                        `Будь ласка:\n` +
                        `• Перевірте реквізити картки\n` +
                        `• Переконайтесь, що карта активна\n` +
                        `• Спробуйте іншу карту\n` +
                        `• Зверніться до вашого банку\n\n` +
                        `Замовлення: ${orderReference}`,
                        { parse_mode: 'HTML' }
                    );
                    console.log(`📨 Decline message sent to user ${userId}`);
                } catch (err) {
                    console.error('Error sending decline message:', err.message);
                }
            } else {
                console.log(`⚠️ WayForPay: Transaction ${transactionStatus} for order ${orderReference}`);
            }

            // Відповідаємо WayForPay (обов'язково!)
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