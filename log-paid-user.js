const db = require('./database/connection');
const models = require('./config/models');
const userBalance = require('./utils/userBalance');
const { logPaymentEvent } = require('./monitoring/loggers');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    args[key] = value;
    if (value !== true) i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const userId = Number(args.userId || args.user || args.id);
  const planKey = String(args.plan || 'starter').toLowerCase();
  const durationDays = Number(args.durationDays || 30);
  const provider = String(args.provider || 'wayforpay').toLowerCase();
  const providerPaymentId = String(
    args.providerPaymentId || `manual_${userId}_${planKey}_${Date.now()}`
  );

  if (!Number.isFinite(userId)) {
    console.error('❌ Missing or invalid --userId');
    process.exit(1);
  }

  const plan = models.subscriptions[planKey];
  if (!plan) {
    console.error(`❌ Unknown plan: ${planKey}`);
    process.exit(1);
  }

  if (!['liqpay', 'wayforpay', 'stars', 'stripe'].includes(provider)) {
    console.error(`❌ Invalid provider: ${provider}`);
    process.exit(1);
  }

  const tokensGranted = plan.tokensWayForPay || plan.tokens;
  const amountUSD = Number(args.amountUSD ?? plan.priceUSD ?? 0);
  const amountUAH = Number(args.amountUAH ?? plan.price ?? 0);

  await db.connect();

  const user = await userBalance.getUser(userId, { id: userId });
  if (!user) {
    console.error('❌ Failed to get or create user');
    process.exit(1);
  }

  await userBalance.setSubscription(userId, plan.name, durationDays);

  await logPaymentEvent({
    userId: String(userId),
    provider,
    providerPaymentId,
    planKey,
    amountUSD,
    amountUAH,
    tokensGranted,
    status: 'success',
    raw: { manual: true }
  });

  console.log(`✅ Updated admin info for user: ${userId} (${plan.name})`);
  console.log(`✅ Logged payment event (tokensGranted=${tokensGranted})`);
  console.log(`✅ Subscription set for ${durationDays} days`);

  await db.disconnect();
}

main().catch((error) => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});
