require("dotenv").config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CORS ====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==================== MongoDB ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Schemas ====================
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
const sessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: '7d' }
});
const messageSchema = new mongoose.Schema({
  user: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const blockedUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  blockedAt: { type: Date, default: Date.now }
});
const tradeSchema = new mongoose.Schema({
  user: { type: String, required: true },
  symbol: { type: String, required: true },
  buyExchange: { type: String, required: true },
  sellExchange: { type: String, required: true },
  buyPrice: Number,
  sellPrice: Number,
  amount: Number,
  investment: Number,
  grossProfit: Number,
  tradingFees: Number,
  withdrawalFees: Number,
  depositFees: Number,
  totalFees: Number,
  netProfit: Number,
  roi: Number,
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  txId: { type: String, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Session = mongoose.model('Session', sessionSchema);
const Message = mongoose.model('Message', messageSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);
const Trade = mongoose.model('Trade', tradeSchema);

// ==================== Auth helpers ====================
const hashPassword = p => crypto.createHash('sha256').update(p).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');

// ==================== Exchange Integration ====================
// ... (keep all your existing exchange code: SUPPORTED_EXCHANGES, buildExchange, EXCHANGE_CREDENTIALS, exchangeInstances, EXCHANGES, safeGet, extractSymbol, fastScan, detailScan, cachedOpportunities, etc.) ...
// For brevity, we'll include it all but this is a summary.
// Make sure you copy your full exchange code from your previous working version.

// ==================== Admin Auth ====================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const adminTokens = new Set();

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid admin credentials' });
  }
});

function adminAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ==================== User Auth (for opportunities) ====================
async function userAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    // Attach user info to request
    req.user = session.username;
    next();
  } catch (err) {
    console.error('User auth error:', err);
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
    const user = new User({ username, email, mpesa, passwordHash: hashPassword(password) });
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
    res.json({ username: user.username, email: user.email, mpesa: user.mpesa });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== Messaging ====================
app.post('/api/messages', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message required' });
    const blocked = await BlockedUser.findOne({ username: session.username });
    if (blocked) return res.status(403).json({ error: 'You have been blocked' });
    const msg = new Message({ user: session.username, isAdmin: false, content: content.trim() });
    await msg.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const messages = await Message.find({ user: session.username }).sort({ createdAt: -1 });
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== Admin Routes ====================
app.get('/admin/users', adminAuth, async (req, res) => {
  const users = await User.find({}, '-passwordHash');
  res.json(users);
});

app.get('/admin/messages', adminAuth, async (req, res) => {
  const messages = await Message.find().sort({ createdAt: -1 });
  res.json(messages);
});

// ==================== Opportunities (now use userAuth) ====================
app.get('/api/opportunities', userAuth, (req, res) => {
  console.log(`📊 /api/opportunities called by ${req.user}, cached: ${cachedOpportunities.length}`);
  const withDetails = cachedOpportunities.map(opp => {
    const detailed = detailedCache.get(opp.id);
    if (detailed) return detailed;
    return { ...opp, tradable: false, risk: 'medium', buyNetworks: {}, sellNetworks: {}, buyWithdraw: false, sellDeposit: false };
  });
  const scanning = cachedOpportunities.length === 0 && Date.now() - lastFastScan > 5000;
  res.json({
    count: withDetails.length,
    opportunities: withDetails,
    lastScan: lastFastScan,
    lastDetail: lastDetailScan,
    scanning
  });
});

app.get('/api/opportunity/:id/details', userAuth, async (req, res) => {
  const { id } = req.params;
  const cached = detailedCache.get(id);
  if (cached) return res.json(cached);
  const opp = cachedOpportunities.find(o => o.id === id);
  if (!opp) return res.status(404).json({ error: 'Not found' });
  const coin = opp.symbol;
  const buyEx = opp.buyExchange.toLowerCase();
  const sellEx = opp.sellExchange.toLowerCase();
  const [buyNet, sellNet, buyLiq, sellLiq] = await Promise.all([
    fetchRealNetworks(buyEx, coin),
    fetchRealNetworks(sellEx, coin),
    fetchLiquidity(buyEx, opp.symbol),
    fetchLiquidity(sellEx, opp.symbol)
  ]);
  const tradable = computeTradable(buyNet?.networks, sellNet?.networks);
  const spreadNum = parseFloat(opp.spread);
  let risk = 'medium';
  if (!tradable) risk = 'high';
  else if (spreadNum < 1) risk = 'low';
  else if (spreadNum > 3) risk = 'high';
  else risk = 'medium';
  const finalLiquidity = (buyLiq && buyLiq > 0) ? buyLiq : (opp.liquidity > 0 ? opp.liquidity : 5000);
  const result = {
    ...opp,
    liquidity: finalLiquidity,
    sellLiquidity: sellLiq || opp.liquidity,
    tradable,
    risk,
    buyNetworks: buyNet?.networks || {},
    sellNetworks: sellNet?.networks || {},
    buyWithdraw: buyNet?.canWithdraw || false,
    sellDeposit: sellNet?.canDeposit || false
  };
  detailedCache.set(id, result);
  res.json(result);
});

// ==================== Balance ====================
app.get('/api/balance/:exchange', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  // ... (balance logic unchanged) ...
  // (keep your existing balance code)
});

// ==================== Deposit Address ====================
app.get('/api/deposit-address/:exchange/:currency/:network', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  // ... (deposit address logic) ...
});

// ==================== Withdrawal Info ====================
app.get('/api/withdrawal-info/:exchange/:currency/:network', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  // ... (withdrawal info logic) ...
});

// ==================== Execute Trade ====================
app.post('/api/trade/execute', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  // ... (trade execution logic unchanged) ...
});

// ==================== Trade History ====================
app.get('/api/trades', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const trades = await Trade.find({ user: session.username }).sort({ createdAt: -1 });
  res.json(trades);
});

// ==================== Admin page ====================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== Start server ====================
app.listen(PORT, () => console.log(`🚀 Arbitrage Master running on ${PORT}`));
