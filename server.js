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

// ==================== Middleware (must be before routes) ====================
app.use(express.json());   // Parses JSON bodies
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

// ==================== Exchange Scanning (ccxt) ====================
// (Keep your existing scanning code – it's unchanged, but I'll include it for completeness)
// ... (paste your exchange scanning code here – I'll skip for brevity, but you must keep it)

// ==================== USER AUTH ROUTES ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, mpesa, password, referralCode } = req.body;
    if (!username || !email || !mpesa || !password) return res.status(400).json({ error: 'All fields required' });
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) return res.status(409).json({ error: 'Username or email already exists' });
    const user = new User({ username, email, mpesa, passwordHash: hashPassword(password), referralCode: username });
    if (referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (referrer) user.referredBy = referrer.username;
    }
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
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email });
    if (!user || user.passwordHash !== hashPassword(password))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken();
    await new Session({ token, username: user.username }).save();
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'No token' });
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const user = await User.findOne({ username: session.username });
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ username: user.username, email: user.email, mpesa: user.mpesa, referralCode: user.referralCode, blocked: user.blocked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/subscription', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'No token' });
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const user = await User.findOne({ username: session.username });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const now = new Date();
    const isActive = user.subscription.active && user.subscription.expiresAt && user.subscription.expiresAt > now;
    res.json({ active: isActive, plan: user.subscription.plan, expiresAt: user.subscription.expiresAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== REFERRAL ====================
app.get('/api/referral', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const user = await User.findOne({ username: session.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const link = `${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?ref=${user.referralCode}`;
    res.json({ link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== MESSAGING ====================
app.post('/api/messages', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const user = await User.findOne({ username: session.username });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.blocked) return res.status(403).json({ error: 'You are blocked from sending messages' });
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content required' });
    const msg = new Message({ user: session.username, content, isAdmin: false, read: false });
    await msg.save();
    res.json({ success: true, message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const messages = await Message.find({ user: session.username }).sort({ createdAt: 1 });
    await Message.updateMany({ user: session.username, isAdmin: true, read: false }, { read: true });
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/message/:id', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.user !== session.username) return res.status(403).json({ error: 'Not your message' });
    msg.content = req.body.content;
    msg.updatedAt = new Date();
    await msg.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/message/:id', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.user !== session.username) return res.status(403).json({ error: 'Not your message' });
    await msg.deleteOne();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN ROUTES ====================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    if (!global.adminTokens) global.adminTokens = new Set();
    global.adminTokens.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid admin credentials' });
  }
});

function adminAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token || !global.adminTokens || !global.adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

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
  if (expiresAt) updates['subscription.expiresAt'] = new Date(expiresAt);
  await User.findByIdAndUpdate(req.params.id, updates);
  res.json({ success: true });
});

app.delete('/admin/user/:id', adminAuth, async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get('/admin/messages', adminAuth, async (req, res) => {
  const conversations = await Message.aggregate([
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$user', lastMessage: { $first: '$$ROOT' }, count: { $sum: 1 } } },
    { $sort: { 'lastMessage.createdAt': -1 } }
  ]);
  res.json(conversations.map(c => ({ _id: c._id, lastMessage: c.lastMessage, count: c.count })));
});

app.get('/admin/messages/:username', adminAuth, async (req, res) => {
  const messages = await Message.find({ user: req.params.username }).sort({ createdAt: 1 });
  await Message.updateMany({ user: req.params.username, isAdmin: false, read: false }, { read: true });
  res.json(messages);
});

app.post('/admin/messages', adminAuth, async (req, res) => {
  const { userId, content } = req.body;
  if (!userId || !content) return res.status(400).json({ error: 'Missing fields' });
  const msg = new Message({ user: userId, content, isAdmin: true, read: true });
  await msg.save();
  res.json({ success: true });
});

app.put('/admin/message/:id', adminAuth, async (req, res) => {
  const msg = await Message.findById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  msg.content = req.body.content;
  msg.updatedAt = new Date();
  await msg.save();
  res.json({ success: true });
});

app.delete('/admin/message/:id', adminAuth, async (req, res) => {
  await Message.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.post('/admin/block/:username', adminAuth, async (req, res) => {
  await User.findOneAndUpdate({ username: req.params.username }, { blocked: true });
  res.json({ success: true });
});

app.post('/admin/unblock/:username', adminAuth, async (req, res) => {
  await User.findOneAndUpdate({ username: req.params.username }, { blocked: false });
  res.json({ success: true });
});

// ==================== OPPORTUNITIES ENDPOINTS ====================
// (Keep your existing /api/opportunities and /api/opportunity/:id/details)
// I'll include placeholders – you must paste your actual scanning code here.

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

// ------------------- TEST GET for callback (debug) -------------------
app.get('/api/payment/callback', (req, res) => {
  res.send(`✅ Callback endpoint is reachable. Query: ${JSON.stringify(req.query)}`);
});

// ------------------- REAL CALLBACK (POST/GET) -------------------
// This is the actual callback that Paystack redirects to.
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

// ==================== WEBHOOK (with signature verification) ====================
// Temporary GET test route to verify webhook endpoint is reachable
app.get('/api/payment/webhook', (req, res) => {
  res.send('✅ Webhook endpoint is live.');
});

app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('❌ Webhook signature mismatch');
    return res.sendStatus(401);
  }

  const event = req.body;
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
