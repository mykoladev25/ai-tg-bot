// services/payment.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Створити Stripe checkout сесію для платежу
 */
async function createStripeCheckout(userId, plan, tokens, amount) {
  try {
    // amount передається у центах з фронтенду (299 = $2.99)
    const amountInCents = typeof amount === 'number' ? Math.round(amount) : Math.round(parseFloat(amount));

    // Build checkout session config
    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${plan} - ${tokens}⚡ токенів`,
            description: 'Токени назавжди. Без згорання.',
            images: ['https://yourapp.com/logo.png']
          },
          unit_amount: amountInCents // уже в центах
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.APP_URL || 'https://yourapp.com'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'https://yourapp.com'}/payment/cancel`,
      metadata: {
        userId: userId.toString(),
        plan: plan,
        tokens: tokens.toString(),
        type: 'subscription'
      }
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);

    console.log(`✅ Stripe checkout created for user ${userId}: ${session.url}`);
    return {
      success: true,
      url: session.url,
      sessionId: session.id
    };
  } catch (error) {
    console.error('❌ Stripe checkout error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Отримати інформацію про Stripe сесію
 */
async function getCheckoutSession(sessionId) {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      success: true,
      session: session
    };
  } catch (error) {
    console.error('❌ Stripe session retrieval error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Обробити webhook від Stripe
 */
function constructStripeEvent(body, signature) {
  try {
    const isDevMode = process.env.NODE_ENV !== 'production';
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // В режимі розробки - дозволяємо webhook без перевірки (для тестування локально)
    if (isDevMode && (!webhookSecret || webhookSecret === 'whsec_YOUR_WEBHOOK_SECRET_HERE')) {
      console.warn('⚠️ STRIPE_WEBHOOK_SECRET not configured - webhook verification skipped (dev mode)');

      // Парсимо тіло webhook як JSON
      let event;
      try {
        event = typeof body === 'string' ? JSON.parse(body) : body;
      } catch (e) {
        throw new Error('Invalid webhook body format');
      }

      return {
        success: true,
        event: event
      };
    }

    // В продакшені - обов'язково перевіряємо
    if (!webhookSecret || webhookSecret === 'whsec_YOUR_WEBHOOK_SECRET_HERE') {
      console.error('❌ STRIPE_WEBHOOK_SECRET not configured in production!');
      return {
        success: false,
        error: 'Webhook secret not configured'
      };
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      webhookSecret
    );

    return {
      success: true,
      event: event
    };
  } catch (error) {
    console.error('❌ Stripe webhook error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Отримати інформацію про платіж
 */
async function getPaymentIntent(paymentIntentId) {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return {
      success: true,
      paymentIntent: paymentIntent
    };
  } catch (error) {
    console.error('❌ Stripe payment intent error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  createStripeCheckout,
  getCheckoutSession,
  constructStripeEvent,
  getPaymentIntent
};
