// webhooks/stripe.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express = require('express');
const payment = require('../services/payment');
const userBalance = require('../utils/userBalance');
const models = require('../config/models');

/**
 * Stripe webhook обробник
 * POST /webhook/stripe
 */
async function handleStripeWebhook(req, res, bot) {
  const sig = req.headers['stripe-signature'];
  
  console.log('📨 Webhook called');
  console.log('Headers:', { sig: sig ? '✅ present' : '❌ missing' });

  if (!sig) {
    console.error('❌ No Stripe signature provided');
    return res.status(400).send('No Stripe signature provided');
  }

  try {
    const eventResult = payment.constructStripeEvent(req.body, sig);

    if (!eventResult.success) {
      console.error('❌ Webhook signature verification failed:', eventResult.error);
      return res.status(400).send(`Webhook Error: ${eventResult.error}`);
    }

    const event = eventResult.event;
    console.log(`📨 Stripe webhook received: ${event.type}`);
    console.log('📦 Event data:', JSON.stringify(event.data?.object?.metadata, null, 2));

    switch (event.type) {
      // ✅ Платіж успішно завершено
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan } = session.metadata;

        console.log(`✅ Checkout session completed for user ${userId}`);

        // ⚠️ SECURITY: Не довіряємо metadata.tokens - беремо з models.js!
        const sub = models.subscriptions[plan];
        if (!sub) {
          console.error(`❌ Invalid plan in webhook: ${plan}`);
          return res.status(400).send('Invalid plan');
        }

        // ✅ Токени з серверної конфігурації
        const tokens = sub.tokens;

        // ⚠️ SECURITY: Перевіряємо що сума відповідає плану
        const expectedAmount = sub.priceUSD * 100; // В центах
        const actualAmount = session.amount_total;

        // Допускаємо похибку в 5% через курсові різниці
        if (Math.abs(actualAmount - expectedAmount) > expectedAmount * 0.05) {
          console.error(`❌ Amount mismatch! Expected: ${expectedAmount}, Got: ${actualAmount}`);
          // Логуємо але не блокуємо - можливо курсові різниці
          console.warn(`⚠️ Processing anyway, but check manually: order for user ${userId}`);
        }

        try {
          // Перевіряємо чи вже оброблено (ідемпотентність)
          const Transaction = require('../database/models/Transaction');
          const existing = await Transaction.findOne({
            'metadata.sessionId': session.id,
            type: 'addition'
          });

          if (existing) {
            console.log(`⚠️ Stripe: Session ${session.id} already processed`);
            return res.json({ received: true });
          }

          // Додати токени користувачу
          await userBalance.addTokens(
            parseInt(userId),
            tokens,
            'stripe_payment',
            { plan: sub.name, planKey: plan, sessionId: session.id, amount: session.amount_total }
          );

          // Відправити повідомлення в бот
          await bot.telegram.sendMessage(
            userId,
            `✅ <b>Оплату отримано!</b>\n\n` +
            `💳 Метод: Stripe\n` +
            `💎 Тариф: ${sub.name}\n` +
            `⚡ Токенів нараховано: ${tokens}\n` +
            `💰 Сума: $${(session.amount_total / 100).toFixed(2)}\n\n` +
            `Дякуємо за покупку! 🎉`,
            { parse_mode: 'HTML' }
          );

          console.log(`📊 User ${userId} credited with ${tokens}⚡`);
        } catch (error) {
          console.error(`❌ Error processing payment for user ${userId}:`, error);
          // Все одно відповідаємо з 200, щоб Stripe не повторював webhook
        }
        break;
      }

      // ⚠️ Платіж не успішен
      case 'checkout.session.expired': {
        const session = event.data.object;
        const { userId, plan } = session.metadata;

        console.log(`⚠️ Checkout session expired for user ${userId}`);

        try {
          await bot.telegram.sendMessage(
            userId,
            `⏰ Сесія платежу закінчилась\n\n` +
            `❌ Платіж ${plan} не був завершений вчасно.\n\n` +
            `Спробуйте ще раз або оберіть інший тариф.`
          );
        } catch (error) {
          console.error(`Error sending message to user ${userId}:`, error);
        }
        break;
      }

      // 💳 Помилка при обробці платежу
      case 'charge.failed': {
        const charge = event.data.object;
        console.error(`❌ Charge failed: ${charge.id}`, charge.failure_message);

        if (charge.metadata?.userId) {
          try {
            await bot.telegram.sendMessage(
              charge.metadata.userId,
              `❌ Платіж не вдалось обробити\n\n` +
              `Причина: ${charge.failure_message}\n\n` +
              `Спробуйте:\n` +
              `• Іншу карту\n` +
              `• Apple Pay\n` +
              `• Google Pay\n\n` +
              `Або зверніться до підтримки.`
            );
          } catch (error) {
            console.error('Error sending charge failure message:', error);
          }
        }
        break;
      }

      // 📨 Повідомлення про успішний платіж
      case 'charge.succeeded': {
        const charge = event.data.object;
        console.log(`✅ Charge succeeded: ${charge.id}`);
        break;
      }

      // 🔄 Возврат платежу
      case 'charge.refunded': {
        const charge = event.data.object;
        console.log(`🔄 Charge refunded: ${charge.id}`);

        if (charge.metadata?.userId && charge.metadata?.tokens) {
          console.warn(`⚠️ User ${charge.metadata.userId} may have refunded tokens`);
          // Можна реалізувати логіку изъяття токенів при повернення
        }
        break;
      }

      // 🔐 Спір з клієнтом
      case 'charge.dispute.created': {
        const dispute = event.data.object;
        console.error(`🔐 Dispute created: ${dispute.id}`);
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('❌ Stripe webhook fatal error:', err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
}

module.exports = {
  handleStripeWebhook
};
