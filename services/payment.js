const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function createStripeCheckout(userId, plan, tokens, amount) {
  try {
    const amountInCents = typeof amount === 'number'
      ? Math.round(amount)
      : Math.round(parseFloat(amount));

    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${plan} - ${tokens}⚡ tokens`,
            description: 'Tokens never expire.',
            images: ['https://yourapp.com/logo.png']
          },
          unit_amount: amountInCents
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.APP_URL || 'https://yourapp.com'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'https://yourapp.com'}/payment/cancel`,
      metadata: {
        userId: userId.toString(),
        plan,
        tokens: tokens.toString(),
        type: 'subscription'
      }
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);

    console.log(`Stripe checkout created for user ${userId}: ${session.id}`);
    return {
      success: true,
      url: session.url,
      sessionId: session.id
    };
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function getCheckoutSession(sessionId) {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      success: true,
      session
    };
  } catch (error) {
    console.error('Stripe session retrieval error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

function constructStripeEvent(body, signature) {
  try {
    const isDevMode = process.env.NODE_ENV !== 'production';
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (isDevMode && !webhookSecret) {
      console.warn('STRIPE_WEBHOOK_SECRET is not configured. Stripe signature verification is skipped in development mode.');

      let event;
      try {
        event = typeof body === 'string' ? JSON.parse(body) : body;
      } catch (error) {
        throw new Error('Invalid webhook body format');
      }

      return {
        success: true,
        event
      };
    }

    if (!webhookSecret) {
      return {
        success: false,
        error: 'Webhook secret is not configured'
      };
    }

    const stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const event = stripeClient.webhooks.constructEvent(body, signature, webhookSecret);

    return {
      success: true,
      event
    };
  } catch (error) {
    console.error('Stripe webhook error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

async function getPaymentIntent(paymentIntentId) {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return {
      success: true,
      paymentIntent
    };
  } catch (error) {
    console.error('Stripe payment intent error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  constructStripeEvent,
  createStripeCheckout,
  getCheckoutSession,
  getPaymentIntent
};
