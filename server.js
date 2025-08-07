import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Basic CORS (lock this down in production)
const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

// Utilities — validate amount (cents) and currency
function isValidAmount(v) {
  return Number.isInteger(v) && v > 0 && v <= 5_000_00_00; // up to $500k
}
const allowedCurrencies = new Set(['usd', 'cad', 'eur', 'gbp', 'aud']);

// If you want to compute the price server-side, accept a packageCode instead
// and look up its price. For now we accept amountInCents but still validate.
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amountInCents, currency = 'usd', metadata = {} } = req.body;

    if (!isValidAmount(amountInCents)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!allowedCurrencies.has(String(currency).toLowerCase())) {
      return res.status(400).json({ error: 'Unsupported currency' });
    }

    const intent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: String(currency).toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: Object.fromEntries(
        Object.entries(metadata || {}).map(([k, v]) => [k, String(v)])
      ),
    });

    return res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// (Optional but recommended) Webhook to confirm success server-side.
// In Stripe dashboard, set the endpoint URL and add the signing secret.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // set this in .env if you use webhooks
  let event;

  try {
    event = endpointSecret
      ? stripe.webhooks.constructEvent(req.body, sig, endpointSecret)
      : JSON.parse(req.body); // not recommended, but avoids signature check if not configured
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      // TODO: mark order as paid using pi.metadata.orderId, etc.
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.warn('Payment failed:', pi.last_payment_error?.message);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
});

// Health
app.get('/', (_req, res) => res.send('Stripe backend OK'));

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Server listening on :${port}`);
});
