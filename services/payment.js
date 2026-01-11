// services/payment.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function createStripeCheckout(userId, plan, tokens, amount) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card', 'apple_pay', 'google_pay'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${plan} - ${tokens}⚡`,
          description: 'Токени назавжди. Без згорання.',
          images: ['https://yourdomain.com/logo.png']
        },
        unit_amount: Math.round(amount * 100)
      },
      quantity: 1
    }],
    mode: 'payment',
    success_url: `https://t.me/${process.env.BOT_USERNAME}?start=success_{CHECKOUT_SESSION_ID}`,
    cancel_url: `https://t.me/${process.env.BOT_USERNAME}?start=cancel`,
    metadata: {
      userId: userId,
      plan: plan,
      tokens: tokens
    }
  });
  
  return session.url;
}