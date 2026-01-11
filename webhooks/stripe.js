app.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, plan, tokens } = session.metadata;
      
      // Додати токени користувачу
      await userBalance.addTokens(userId, parseInt(tokens), 'stripe_payment', { plan });
      
      // Відправити повідомлення в бот
      await bot.telegram.sendMessage(userId, 
        `✅ Оплату отримано!\n\n` +
        `💎 Тариф: ${plan}\n` +
        `⚡ Токенів нараховано: ${tokens}\n\n` +
        `Дякуємо за покупку! 🎉`
      );
    }
    
    res.json({received: true});
  } catch (err) {
    console.error('Stripe webhook error:', err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});