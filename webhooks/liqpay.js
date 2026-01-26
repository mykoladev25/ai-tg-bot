const express = require('express');
const liqpay = require('../services/liqpay');
const userBalance = require('../utils/userBalance');
const models = require('../config/models');

/**
 * Створити router для LiqPay webhook з посиланням на bot
 */
function createLiqPayRouter(bot) {
  const router = express.Router();

  /**
   * Callback від LiqPay - сервер LiqPay надішле сюди результат платежу
   * POST /webhook/liqpay
   */
  router.post('/liqpay', async (req, res) => {
    try {
      const { data, signature } = req.body;

      if (!data || !signature) {
        console.error('❌ LiqPay webhook: Missing data or signature');
        return res.status(400).json({ error: 'Missing data or signature' });
      }

      // Верифікація підпису
      if (!liqpay.verifySignature(data, signature)) {
        console.error('❌ LiqPay webhook: Invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // Декодування даних платежу
      const paymentData = liqpay.decodeParams(data);
      console.log('📡 LiqPay callback received:', {
        status: paymentData.status,
        order_id: paymentData.order_id,
        amount: paymentData.amount,
        currency: paymentData.currency,
        description: paymentData.description
      });

      // Обробка успішного платежу
      if (paymentData.status === 'success') {
        // Розпарсимо замовлення: format "userId_planKey_timestamp"
        const parts = paymentData.order_id.split('_');
        const userId = parts[0];
        const planKey = parts[1];

        if (!userId || !planKey) {
          console.error('❌ LiqPay: Unable to extract userId/planKey from order_id:', paymentData.order_id);
          return res.status(400).json({ error: 'Invalid order_id format' });
        }

        const userIdNum = parseInt(userId);

        // ⚠️ SECURITY: Валідація userId
        if (isNaN(userIdNum) || userIdNum <= 0) {
          console.error('❌ LiqPay: Invalid userId:', userId);
          return res.status(400).json({ error: 'Invalid userId' });
        }

        // Перевіримо чи є такий план
        const sub = models.subscriptions[planKey];

        if (!sub) {
          console.error('❌ LiqPay: Plan not found:', planKey);
          return res.status(400).json({ error: 'Invalid plan' });
        }

        // ⚠️ SECURITY: Перевірка на ідемпотентність - чи платіж вже оброблений
        const Transaction = require('../database/models/Transaction');
        const existingTransaction = await Transaction.findOne({
          'metadata.orderId': paymentData.order_id,
          type: 'addition'
        });

        if (existingTransaction) {
          console.log(`⚠️ LiqPay: Order ${paymentData.order_id} already processed, skipping`);
          return res.json({ status: 'ok', message: 'Already processed' });
        }

        // Обробляємо платіж
        console.log(`✅ LiqPay: Processing payment for user ${userIdNum}, plan: ${planKey}`);

        // Використовуємо tokensWayForPay (бонус) або звичайні tokens
        const tokenCount = sub.tokensWayForPay || sub.tokens;

        await userBalance.addTokens(
          userIdNum,
          tokenCount,
          'liqpay_purchase',
          {
            plan: sub.name,
            tokens: tokenCount,
            bonusTokens: sub.tokensWayForPay ? (sub.tokensWayForPay - sub.tokens) : 0,
            amount: paymentData.amount,
            orderId: paymentData.order_id,
            transactionId: paymentData.transaction_id,
            description: paymentData.description
          }
        );

        console.log(`✅ Tokens added: ${tokenCount}⚡ (${sub.tokensWayForPay ? 'с бонусом' : 'без бонусу'}) for user ${userIdNum}`);

        // Отримуємо користувача для відправки повідомлення
        const user = await userBalance.getUser(userIdNum, { id: userIdNum });

        // Відправляємо повідомлення користувачу в Telegram
        if (bot) {
          try {
            const bonusText = sub.tokensWayForPay ? `\n🎁 <b>+${sub.tokensWayForPay - sub.tokens}⚡ бонус</b> (економія на комісіях LiqPay)` : '';

            await bot.telegram.sendMessage(
              userIdNum,
              `✅ <b>Платіж успішно оброблений!</b>\n\n` +
              `💳 Метод: LiqPay\n` +
              `💎 Тариф: ${sub.name}\n` +
              `⚡ Токенів нараховано: ${tokenCount}${bonusText}\n` +
              `💰 Сума: ${paymentData.amount} ${paymentData.currency}\n` +
              `💵 Новий баланс: ${user.tokens.toFixed(2)}⚡\n\n` +
              `Дякуємо за покупку! 🎉`,
              { parse_mode: 'HTML' }
            );
            console.log(`📨 Success message sent to user ${userIdNum}`);
          } catch (error) {
            console.error(`❌ Error sending message to user ${userIdNum}:`, error.message);
          }
        }

        console.log(`📝 Payment details:
        ✅ Status: ${paymentData.status}
        💰 Amount: ${paymentData.amount} ${paymentData.currency}
        ⚡ Tokens: ${sub.tokens}
        💎 Plan: ${sub.name}
        👤 User: ${userIdNum}
        🆔 Order: ${paymentData.order_id}
      `);
      } else if (paymentData.status === 'failure' || paymentData.status === 'error') {
        console.warn(`⚠️ LiqPay payment failed: ${paymentData.order_id} - ${paymentData.status}`);

        // Відправляємо повідомлення про помилку користувачу
        const parts = paymentData.order_id.split('_');
        const userId = parseInt(parts[0]);
        if (bot && userId) {
          try {
            await bot.telegram.sendMessage(
              userId,
              `❌ <b>Платіж не вдався</b>\n\n` +
              `Статус: ${paymentData.status}\n` +
              `Замовлення: ${paymentData.order_id}\n\n` +
              `Спробуйте ще раз або оберіть інший спосіб оплати.`,
              { parse_mode: 'HTML' }
            );
          } catch (error) {
            console.error(`Error sending error message to user ${userId}:`, error.message);
          }
        }
      } else if (paymentData.status === 'sandbox') {
        console.log(`ℹ️ LiqPay sandbox transaction: ${paymentData.order_id}`);
      } else {
        console.log(`ℹ️ LiqPay transaction status: ${paymentData.status} for order ${paymentData.order_id}`);
      }

      // Обов'язково повертаємо 200 OK, щоб LiqPay знав що callback оброблений
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('❌ LiqPay webhook error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createLiqPayRouter;

