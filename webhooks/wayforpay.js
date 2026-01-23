const express = require('express');
const router = express.Router();
const wayforpay = require('../services/wayforpay');
const userBalance = require('../utils/userBalance');
const models = require('../config/models');

module.exports = function(bot) {

    // ⚠️ ВАЖЛИВО: WayForPay надсилає raw JSON, не urlencoded!
    // Потрібен спеціальний парсер
    router.post('/wayforpay', express.text({ type: '*/*' }), async (req, res) => {
        try {
            // WayForPay може надсилати дані різними способами
            let data;

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
                // Перевіряємо чи це "JSON як ключ" проблема
                const keys = Object.keys(req.body);
                if (keys.length === 1 && keys[0].startsWith('{')) {
                    // JSON прийшов як ключ об'єкта (неправильна обробка urlencoded)
                    console.log('📥 Extracting JSON from form key...');
                    try {
                        data = JSON.parse(keys[0]);
                    } catch (e) {
                        console.error('❌ Failed to parse JSON from key:', e.message);
                        return res.status(400).json({ error: 'Invalid JSON format' });
                    }
                } else {
                    // Нормальний об'єкт
                    data = req.body;
                }
            } else {
                console.error('❌ Unexpected body type:', typeof req.body);
                return res.status(400).json({ error: 'Invalid request body' });
            }

            console.log('📥 WayForPay webhook received (full data):', JSON.stringify(data, null, 2));
            console.log('📥 WayForPay webhook summary:', {
                orderReference: data.orderReference,
                transactionStatus: data.transactionStatus,
                amount: data.amount,
                reasonCode: data.reasonCode,
                authCode: data.authCode,
                reason: data.reason
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

            // ✅ WayForPay може надсилати 'Approved' або 'Completed' як статус успішного платежу
            // (Підтримуємо обидва для максимальної надійності)
            if (transactionStatus === 'Approved' || transactionStatus === 'Completed') {
                console.log(`✅ Processing SUCCESSFUL payment: ${orderReference} (status: ${transactionStatus})`);
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
            } else if (transactionStatus === 'Refunded') {
                // ⚠️ Платіж був повернений (chargeback, fraud, тощо)
                console.log(`⚠️ Processing REFUNDED payment: ${orderReference}`);
                console.log(`⚠️ Refund reason: ${data.reason} (code: ${data.reasonCode})`);

                try {
                    const Transaction = require('../database/models/Transaction');

                    // Перевіряємо чи існує такий платіж
                    const transaction = await Transaction.findOne({
                        'metadata.orderId': orderReference,
                        type: 'wayforpay_purchase'
                    });

                    if (transaction && transaction.status === 'completed') {
                        // Якщо платіж був оброблений як успішний, то потрібно забрати токени
                        console.log(`💔 Refunding ${tokens}⚡ to user ${userId}`);
                        console.log(`📝 Refund details:`, {
                            orderId: orderReference,
                            reasonCode: data.reasonCode,
                            reason: data.reason,
                            authCode: data.authCode
                        });

                        // Забираємо токени
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

                            // Повідомляємо користувача про повернення
                            const updatedUser = await userBalance.getUser(userId, { id: userId });
                            await bot.telegram.sendMessage(
                                userId,
                                `⚠️ <b>Платіж був повернений</b>\n\n` +
                                `💳 Метод: WayForPay\n` +
                                `💎 Тариф: ${sub.name}\n` +
                                `⚡ Повернено: ${tokensToRemove}\n` +
                                `💰 Поточний баланс: ${updatedUser.tokens.toFixed(2)}⚡\n\n` +
                                `Причина: ${data.reason}\n` +
                                `Код: ${data.reasonCode}\n\n` +
                                `Замовлення: ${orderReference}`,
                                { parse_mode: 'HTML' }
                            );
                        }

                        // Оновлюємо статус транзакції в БД
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
                // ⏳ Платіж очікує на 3DS верифікацію або банківське підтвердження
                console.log(`⏳ Processing PENDING payment: ${orderReference}`);
                console.log(`   Reason: ${data.reason} (code: ${data.reasonCode})`);
                console.log(`   (Waiting for bank verification or next webhook update)`);

                // Повідомляємо користувача що платіж очікує на підтвердження
                try {
                    await bot.telegram.sendMessage(
                        userId,
                        `⏳ <b>Очікування підтвердження</b>\n\n` +
                        `💳 Метод: WayForPay\n` +
                        `💎 Тариф: ${sub.name}\n` +
                        `💰 Сума: ${amount} UAH\n\n` +
                        `Ваш платіж очікує на підтвердження від банку.\n` +
                        `Це може зайняти кілька хвилин (до 3DS верифікації).\n\n` +
                        `⚡ Токени будуть нараховані автоматично після успішної верифікації.\n\n` +
                        `Замовлення: ${orderReference}`,
                        { parse_mode: 'HTML' }
                    );
                    console.log(`📨 Pending verification message sent to user ${userId}`);
                } catch (err) {
                    console.error('Error sending pending message:', err.message);
                }
            } else if (transactionStatus === 'Expired') {
                // ❌ Платіж закінчився (user не завершив операцію)
                console.log(`❌ Processing EXPIRED payment: ${orderReference}`);
                console.log(`   Reason: ${data.reason} (code: ${data.reasonCode})`);

                try {
                    await bot.telegram.sendMessage(
                        userId,
                        `❌ <b>Платіж закінчився</b>\n\n` +
                        `💳 Метод: WayForPay\n` +
                        `💎 Тариф: ${sub.name}\n` +
                        `💰 Сума: ${amount} UAH\n` +
                        `🔴 Статус: Сесія закінчена\n\n` +
                        `Ваша сесія платежу закінчилась без завершення.\n` +
                        `Спробуйте ще раз.\n\n` +
                        `Замовлення: ${orderReference}`,
                        { parse_mode: 'HTML' }
                    );
                    console.log(`📨 Expired message sent to user ${userId}`);
                } catch (err) {
                    console.error('Error sending expired message:', err.message);
                }
            } else {
                console.log(`⚠️ WayForPay: Transaction ${transactionStatus} for order ${orderReference}`);
                if (data.reason) {
                    console.log(`   Reason: ${data.reason} (code: ${data.reasonCode})`);
                }
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