require("dotenv").config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MongoDB Connection ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    setTimeout(() => mongoose.connect(MONGO_URI), 5000);
  });

// ==================== Middleware (order matters!) ====================
// The webhook route must receive raw body BEFORE express.json() runs.
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());   // For all other routes
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Global Error Handlers ====================
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});

// ==================== Health Check ====================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ==================== Schemas ====================
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  mpesa: { type: String, required: true },
  passwordHash: { type: String, required: true },
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: null },
  blocked: { type: Boolean, default: false },
  subscription: {
    active: { type: Boolean, default: false },
    plan: { type: String, enum: ['weekly', 'monthly', null], default: null },
    expiresAt: { type: Date, default: null }
  },
  createdAt: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: '7d' }
});

const transactionSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  user: { type: String, required: true },
  plan: { type: String, enum: ['weekly', 'monthly'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  paystackResponse: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  user: { type: String, required: true },
  content: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Session = mongoose.model('Session', sessionSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Message = mongoose.model('Message', messageSchema);

const hashPassword = p => crypto.createHash('sha256').update(p).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');
function sanitizeReference(str) {
  return str.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/\s/g, '_');
}

// ==================== EXCHANGE SCANNING (ccxt) ====================
// Paste your full scanning code here (the one you already have).
// This is a placeholder; you must keep your existing scanning logic.
// For brevity, I assume you will insert it here.

// ==================== USER AUTH ROUTES ====================
app.post('/api/register', async (req, res) => { /* ... */ });
app.post('/api/login', async (req, res) => { /* ... */ });
app.get('/api/me', async (req, res) => { /* ... */ });
app.get('/api/user/subscription', async (req, res) => { /* ... */ });

// ==================== REFERRAL ====================
app.get('/api/referral', async (req, res) => { /* ... */ });

// ==================== MESSAGING ====================
app.post('/api/messages', async (req, res) => { /* ... */ });
app.get('/api/messages', async (req, res) => { /* ... */ });
app.put('/api/message/:id', async (req, res) => { /* ... */ });
app.delete('/api/message/:id', async (req, res) => { /* ... */ });

// ==================== ADMIN ROUTES ====================
// (Keep your existing admin routes – unchanged)

// ==================== OPPORTUNITIES ENDPOINTS ====================
app.get('/api/opportunities', (req, res) => { /* ... */ });
app.get('/api/opportunity/:id/details', async (req, res) => { /* ... */ });

// ==================== PAYMENT (PAYSTACK) ====================
app.post('/api/paystack/pay', async (req, res) => {
  console.log('📩 Incoming payment request body:', req.body);
  const { plan } = req.body || {};
  if (!plan) {
    return res.status(400).json({ error: 'Missing plan (weekly or monthly)' });
  }

  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const user = await User.findOne({ username: session.username });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.blocked) return res.status(403).json({ error: 'Account blocked' });

    const amountInKobo = plan === 'weekly' ? 100 * 100 : 350 * 100;
    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackSecretKey) return res.status(500).json({ error: 'Payment not configured' });

    const cleanUsername = sanitizeReference(user.username);
    const reference = `arbimine_${cleanUsername}_${Date.now()}`;
    const callbackUrl = `${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}/api/payment/callback`;

    console.log(`💰 Creating Paystack transaction: ${reference} for ${user.email}`);
    console.log(`📌 Callback URL: ${callbackUrl}`); // This logs the URL used

    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: user.email,
      amount: amountInKobo,
      currency: 'KES',
      reference,
      callback_url: callbackUrl,
      channels: ['mobile_money', 'card'],
      metadata: { plan, username: user.username, user_id: user._id.toString() }
    }, {
      headers: { Authorization: `Bearer ${paystackSecretKey}`, 'Content-Type': 'application/json' }
    });

    await Transaction.create({
      reference,
      user: user.username,
      plan,
      amount: amountInKobo / 100,
      status: 'pending',
      paystackResponse: response.data
    });

    if (response.data.status) {
      res.json({ success: true, authorizationUrl: response.data.data.authorization_url, reference });
    } else {
      res.status(400).json({ error: response.data.message || 'Payment initialization failed' });
    }
  } catch (err) {
    console.error('Paystack error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment service error' });
  }
});

// ==================== CALLBACK (ONLY ONE) ====================
app.get('/api/payment/callback', async (req, res) => {
  console.log('🔔 CALLBACK HIT! Full URL:', req.originalUrl);
  console.log('Query params:', req.query);

  const { reference } = req.query;
  if (!reference) {
    console.log('❌ No reference in callback');
    return res.redirect(`${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?payment_status=failed`);
  }
  try {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    const verification = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${secretKey}` }
    });
    console.log(`✅ Verification status: ${verification.data.status}`);
    const transaction = await Transaction.findOne({ reference });
    if (transaction) {
      transaction.status = verification.data.data.status === 'success' ? 'success' : 'failed';
      transaction.paystackResponse = verification.data;
      await transaction.save();
      console.log(`📝 Transaction ${reference} status updated to ${transaction.status}`);
    }
    if (verification.data.status && verification.data.data.status === 'success') {
      const meta = verification.data.data.metadata;
      const plan = meta?.plan;
      const username = meta?.username;
      if (username && plan) {
        const days = plan === 'weekly' ? 7 : 30;
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        await User.findOneAndUpdate(
          { username },
          { 'subscription.active': true, 'subscription.plan': plan, 'subscription.expiresAt': expiresAt }
        );
        console.log(`✅ Subscription updated for ${username}`);
      }
      const redirectUrl = `${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?payment_status=success&reference=${reference}`;
      console.log('🔄 Redirecting to:', redirectUrl);
      return res.redirect(redirectUrl);
    } else {
      console.log('❌ Payment verification failed');
      return res.redirect(`${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?payment_status=failed`);
    }
  } catch (err) {
    console.error('❌ Callback error:', err.message);
    return res.redirect(`${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?payment_status=failed`);
  }
});

// ==================== WEBHOOK ====================
app.post('/api/payment/webhook', (req, res) => {
  const rawBody = req.body; // Buffer because of express.raw() middleware
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('❌ Webhook signature mismatch');
    return res.sendStatus(401);
  }

  const event = JSON.parse(rawBody.toString());
  console.log('✅ Webhook verified:', event.event);

  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    (async () => {
      try {
        const transaction = await Transaction.findOne({ reference });
        if (transaction) {
          transaction.status = 'success';
          transaction.paystackResponse = event;
          await transaction.save();
          console.log(`📝 Webhook: ${reference} marked as success`);
        }
        const metadata = event.data.metadata;
        const plan = metadata?.plan;
        const username = metadata?.username;
        if (username && plan) {
          const days = plan === 'weekly' ? 7 : 30;
          const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
          await User.findOneAndUpdate(
            { username },
            { 'subscription.active': true, 'subscription.plan': plan, 'subscription.expiresAt': expiresAt }
          );
          console.log(`✅ Webhook: subscription updated for ${username}`);
        }
      } catch (err) {
        console.error('Webhook processing error:', err);
      }
    })();
  }

  res.json({ status: 'received' });
});

// ==================== MANUAL TRANSACTION STATUS ====================
app.get('/api/transaction/status', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const { reference } = req.query;
  let query = { user: session.username };
  if (reference) query.reference = reference;

  const tx = await Transaction.findOne(query).sort({ createdAt: -1 });
  if (!tx) return res.status(404).json({ error: 'No transaction found' });
  res.json(tx);
});

// ==================== SERVE ADMIN HTML ====================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== START SERVER ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ArbiMine running on ${PORT}`);
});
