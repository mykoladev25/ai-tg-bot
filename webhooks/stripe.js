const payment = require('../services/payment');
const userBalance = require('../utils/userBalance');
const models = require('../config/models');

async function handleStripeWebhook(req, res, bot) {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }

  try {
    const eventResult = payment.constructStripeEvent(req.body, signature);
    if (!eventResult.success) {
      return res.status(400).send(`Webhook error: ${eventResult.error}`);
    }

    const event = eventResult.event;
    console.log(`Stripe webhook received: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan } = session.metadata;
        const subscription = models.subscriptions[plan];

        if (!subscription) {
          return res.status(400).send('Invalid plan');
        }

        const expectedAmount = subscription.priceUSD * 100;
        const actualAmount = session.amount_total;
        if (Math.abs(actualAmount - expectedAmount) > expectedAmount * 0.05) {
          console.warn(`Stripe amount mismatch for user ${userId}. Expected ${expectedAmount}, got ${actualAmount}.`);
        }

        try {
          const Transaction = require('../database/models/Transaction');
          const existing = await Transaction.findOne({
            'metadata.sessionId': session.id,
            type: 'addition'
          });

          if (existing) {
            return res.json({ received: true });
          }

          await userBalance.addTokens(
            parseInt(userId, 10),
            subscription.tokens,
            'stripe_payment',
            {
              plan: subscription.name,
              planKey: plan,
              sessionId: session.id,
              amount: actualAmount
            }
          );

          await bot.telegram.sendMessage(
            userId,
            [
              '✅ <b>Payment received</b>',
              '',
              '💳 Provider: Stripe',
              `💎 Plan: ${subscription.name}`,
              `⚡ Tokens credited: ${subscription.tokens}`,
              `💰 Amount: $${(actualAmount / 100).toFixed(2)}`,
              '',
              'Thanks for your purchase.'
            ].join('\n'),
            { parse_mode: 'HTML' }
          );
        } catch (error) {
          console.error(`Failed to process Stripe session ${session.id}:`, error);
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object;
        const { userId, plan } = session.metadata;

        try {
          await bot.telegram.sendMessage(
            userId,
            [
              '⏰ Payment session expired',
              '',
              `The ${plan} payment session was not completed in time.`,
              'Please try again from the bot.'
            ].join('\n')
          );
        } catch (error) {
          console.error(`Failed to notify user ${userId} about an expired session:`, error);
        }
        break;
      }

      case 'charge.failed': {
        const charge = event.data.object;
        if (charge.metadata?.userId) {
          try {
            await bot.telegram.sendMessage(
              charge.metadata.userId,
              [
                '❌ Payment failed',
                '',
                `Reason: ${charge.failure_message || 'Unknown error'}`,
                'Try another card or payment method.'
              ].join('\n')
            );
          } catch (error) {
            console.error('Failed to notify user about a failed charge:', error);
          }
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        console.warn(`Stripe refund detected: ${charge.id}`);
        break;
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object;
        console.error(`Stripe dispute created: ${dispute.id}`);
        break;
      }

      default:
        console.log(`Unhandled Stripe webhook event: ${event.type}`);
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook fatal error:', error);
    return res.status(400).send(`Webhook error: ${error.message}`);
  }
}

module.exports = {
  handleStripeWebhook
};
