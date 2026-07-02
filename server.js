require("dotenv").config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.set('trust proxy', 1);

// ==================== MongoDB ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ==================== Middleware ====================
// Webhook must use raw body before JSON parser
app.post('/api/paystack/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-paystack-signature'];
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');
    if (hash !== signature) {
      console.log('Webhook signature mismatch');
      return res.status(401).send('Unauthorized');
    }
    const event = JSON.parse(req.body.toString());
    console.log('Paystack Webhook received:', event);
    // ... webhook logic (keep as before)
    res.sendStatus(200);
  }
);

// JSON parser for all other routes
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Rate Limiting ====================
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ==================== Schemas ====================
// (All schemas – unchanged)
const sessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: '7d' }
});
const messageSchema = new mongoose.Schema({
  user: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  content: { type: String, required: true },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  edited: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const blockedUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  blockedAt: { type: Date, default: Date.now }
});
const transactionSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  user: { type: String, required: true },
  plan: { type: String, enum: ['weekly', 'monthly'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  paymentData: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  mpesa: { type: String, required: true },
  passwordHash: { type: String, required: true },
  subscription: {
    active: { type: Boolean, default: false },
    plan: { type: String, enum: ['weekly', 'monthly', null], default: null },
    expiresAt: { type: Date, default: null }
  },
  createdAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);
const Message = mongoose.model('Message', messageSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const User = mongoose.model('User', userSchema);

const generateToken = () => crypto.randomBytes(32).toString('hex');

// ==================== Admin Auth (JWT) ====================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function generateAdminToken(username) {
  return jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
}

function verifyAdminToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.role === 'admin';
  } catch {
    return false;
  }
}

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = generateAdminToken(username);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid admin credentials' });
  }
});

function adminAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token || !verifyAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  if (verifyAdminToken(token)) {
    req.user = 'admin';
    return next();
  }
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    req.user = session.username;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Auth error' });
  }
}

// ==================== Auth Routes ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, mpesa, password } = req.body;
    if (!username || !email || !mpesa || !password) return res.status(400).json({ error: 'All fields required' });
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) return res.status(409).json({ error: 'Username or email already exists' });
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({ username, email, mpesa, passwordHash: hashedPassword });
    await user.save();
    const token = generateToken();
    await new Session({ token, username }).save();
    res.json({ success: true, token, username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const identifier = username || email;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Username/email and password required' });
    }
    let user = await User.findOne({ username: identifier });
    if (!user) user = await User.findOne({ email: identifier });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken();
    await new Session({ token, username: user.username }).save();
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', authMiddleware, async (req, res) => {
  try {
    await Session.deleteOne({ token: req.headers.authorization });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ username: user.username, email: user.email, mpesa: user.mpesa });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/subscription', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const now = new Date();
    const isActive = user.subscription.active && user.subscription.expiresAt && user.subscription.expiresAt > now;
    res.json({ active: isActive, plan: user.subscription.plan, expiresAt: user.subscription.expiresAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== Messaging ====================
// ... (all message routes – unchanged – keep from previous version)

// ==================== Admin Messaging ====================
// ... (unchanged)

// ==================== CCXT Exchange Integration ====================
const EXCHANGE_IDS = [
  'kucoin', 'mexc', 'kraken', 'bitfinex', 'bitstamp',
  'coinbase', 'gemini', 'upbit', 'poloniex',
  'whitebit', 'coinex', 'bitmart', 'bitget',
  'okx', 'bingx'
];

const EXCHANGE_NAMES = {
  kucoin: 'KuCoin', mexc: 'MEXC', kraken: 'Kraken', bitfinex: 'Bitfinex',
  bitstamp: 'Bitstamp', coinbase: 'Coinbase', gemini: 'Gemini',
  upbit: 'Upbit', poloniex: 'Poloniex',
  whitebit: 'WhiteBIT', coinex: 'CoinEx', bitmart: 'BitMart',
  bitget: 'Bitget', okx: 'OKX', bingx: 'BingX'
};

const exchangeInstances = {};
for (const id of EXCHANGE_IDS) {
  try {
    const ExchangeClass = ccxt[id];
    if (!ExchangeClass) {
      console.warn(`⚠️ Exchange ${id} not supported – skipping`);
      continue;
    }
    const ex = new ExchangeClass({
      enableRateLimit: true,
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    exchangeInstances[id] = ex;
    console.log(`🔌 ${id} initialized (public)`);
  } catch (err) {
    console.error(`❌ Failed to init ${id}:`, err.message);
  }
}

// Load markets once
async function loadAllMarkets() {
  for (const id of EXCHANGE_IDS) {
    const ex = exchangeInstances[id];
    if (!ex) continue;
    try {
      await ex.loadMarkets();
      console.log(`📊 Markets loaded for ${id}`);
    } catch (err) {
      console.log(`❌ Failed to load markets for ${id}:`, err.message);
    }
  }
}
loadAllMarkets();

// ==================== Arbitrage Scanning ====================
// (All scanning functions – unchanged – keep from previous version)

// ==================== Paystack Charge (with test fallback & detailed logging) ====================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const APP_URL = process.env.APP_URL || 'https://arbimine.onrender.com';
const PLANS = {
  weekly: { amount: 100, duration: 7 },
  monthly: { amount: 350, duration: 30 }
};

function formatPhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.slice(1);
  else if (cleaned.startsWith('254')) { /* already good */ }
  else if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
  if (cleaned.length > 12) cleaned = cleaned.slice(0, 12);
  return cleaned;
}

function getExpiryDate(plan) {
  const days = PLANS[plan]?.duration || 0;
  if (!days) return null;
  const now = new Date(); now.setDate(now.getDate() + days); return now;
}

app.post('/api/paystack/charge', authMiddleware, async (req, res) => {
  console.log('✅ /api/paystack/charge called');
  try {
    const { plan, phone } = req.body;
    if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let rawPhone = phone || user.mpesa;
    let userPhone = formatPhone(rawPhone);
    if (!userPhone || userPhone.length !== 12) {
      return res.status(400).json({ error: 'Phone must be 12 digits (e.g., 254712345678)' });
    }

    const isTestMode = PAYSTACK_SECRET?.startsWith('sk_test_');
    if (isTestMode) {
      const testNumbers = ['254712345678', '254712345679', '254712345680'];
      if (!testNumbers.includes(userPhone)) {
        console.log('⚠️ Test mode: using test number 254712345678 instead of', userPhone);
        userPhone = '254712345678';
      }
    }

    const email = user.email;
    const amount = PLANS[plan].amount;
    const reference = `arbimine_${user.username}_${Date.now()}`;

    const payload = {
      email,
      amount: amount * 100,
      currency: 'KES',
      reference,
      mobile_money: {
        provider: 'mpesa',
        phone: userPhone
      },
      metadata: {
        plan,
        username: user.username,
        user_id: user._id.toString()
      }
    };

    console.log('📤 Sending to Paystack:', JSON.stringify(payload, null, 2));

    const response = await axios.post(
      'https://api.paystack.co/charge',
      payload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('📥 Paystack response status:', response.status);
    console.log('📥 Paystack response data:', JSON.stringify(response.data, null, 2));

    if (response.data.status) {
      await Transaction.create({
        reference,
        user: user.username,
        plan,
        amount,
        status: 'pending',
        paymentData: response.data
      });
      res.json({
        success: true,
        message: isTestMode ? '✅ Test payment sent! (Using test number)' : 'STK push sent. Please enter your PIN.',
        reference
      });
    } else {
      throw new Error(response.data.message || 'Charge initiation failed');
    }
  } catch (err) {
    console.error('❌ Paystack charge error:');
    console.error('Status:', err.response?.status);
    console.error('Data:', JSON.stringify(err.response?.data, null, 2));
    console.error('Message:', err.message);

    const errorMsg = err.response?.data?.message || err.message || 'Payment initiation failed';
    res.status(500).json({ error: errorMsg });
  }
});

// ==================== Webhook ====================
app.post('/api/paystack/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-paystack-signature'];
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
      .digest('hex');
    if (hash !== signature) {
      console.log('Webhook signature mismatch');
      return res.status(401).send('Unauthorized');
    }
    const event = JSON.parse(req.body.toString());
    console.log('Paystack Webhook received:', event);
    try {
      if (event.event === 'charge.success') {
        const data = event.data;
        const reference = data.reference;
        const transaction = await Transaction.findOne({ reference });
        if (!transaction) {
          console.log(`Transaction ${reference} not found`);
          return res.sendStatus(404);
        }
        transaction.status = 'success';
        transaction.paymentData = data;
        await transaction.save();

        const metadata = data.metadata || {};
        const plan = metadata.plan || transaction.plan;
        const username = metadata.username || transaction.user;
        if (username && plan) {
          const expiresAt = getExpiryDate(plan);
          await User.findOneAndUpdate(
            { username },
            { 'subscription.active': true, 'subscription.plan': plan, 'subscription.expiresAt': expiresAt }
          );
          console.log(`✅ Subscription activated for ${username} (${plan})`);
        }
      } else if (event.event === 'charge.failed') {
        const reference = event.data.reference;
        await Transaction.findOneAndUpdate(
          { reference },
          { status: 'failed', paymentData: event.data }
        );
      }
    } catch (err) {
      console.error('Webhook error:', err);
    }
    res.sendStatus(200);
  }
);

app.get('/api/payment/status/:reference', authMiddleware, async (req, res) => {
  const { reference } = req.params;
  try {
    const transaction = await Transaction.findOne({ reference });
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ status: transaction.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Routes ====================
app.get('/admin/users', adminAuth, async (req, res) => {
  const users = await User.find({}, '-passwordHash');
  res.json(users);
});

app.get('/admin/transactions', adminAuth, async (req, res) => {
  const transactions = await Transaction.find().sort({ createdAt: -1 });
  res.json(transactions);
});

app.post('/admin/user/:id/update-subscription', adminAuth, async (req, res) => {
  const { active, plan, expiresAt } = req.body;
  const updates = { 'subscription.active': active };
  if (plan) updates['subscription.plan'] = plan;
  if (active && !expiresAt) {
    const days = plan === 'weekly' ? 7 : 30;
    updates['subscription.expiresAt'] = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  } else if (expiresAt) {
    updates['subscription.expiresAt'] = new Date(expiresAt);
  }
  await User.findByIdAndUpdate(req.params.id, updates);
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/test', (req, res) => res.json({ ok: true }));

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 ArbiMine running on ${PORT}`);
  console.log(`📊 Admin panel: ${PORT === 3000 ? 'http://localhost:3000/admin' : 'on your domain'}`);
});
