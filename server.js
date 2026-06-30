require("dotenv").config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MongoDB Connection ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB error:', err);
    setTimeout(() => mongoose.connect(MONGO_URI), 5000);
  });

// ==================== Middleware ====================
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Email (nodemailer) ====================
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log('✅ Email transporter configured');
} else {
  console.log('⚠️ Email not configured – skipping notifications');
}

async function sendEmail(to, subject, html) {
  if (!transporter) return false;
  try {
    await transporter.sendMail({ from: SMTP_FROM, to, subject, html });
    console.log(`📧 Email sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error('Email error:', err.message);
    return false;
  }
}
function sendEmailAsync(to, subject, html) {
  sendEmail(to, subject, html).catch(() => {});
}

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
  isAdmin: { type: Boolean, default: false },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const blockedUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  blockedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Session = mongoose.model('Session', sessionSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Message = mongoose.model('Message', messageSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);

const hashPassword = p => crypto.createHash('sha256').update(p).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');
function sanitizeReference(str) {
  return str.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/\s/g, '_');
}

// ==================== DYNAMIC EXCHANGE SCANNER (CCXT) ====================
const EXCHANGE_IDS = [
  'binance', 'bybit', 'okx', 'bitget', 'kucoin', 'gateio', 'htx', 'mexc',
  'kraken', 'coinbase', 'crypto', 'bitfinex', 'gemini', 'bitstamp', 'whitebit',
  'bingx', 'xt', 'lbank', 'phemex', 'coinex', 'ascendex', 'bitmart', 'biconomy',
  'probit', 'toobit', 'weex', 'digifinex', 'orangex', 'kcex', 'deepcoin', 'coinw',
  'fameex', 'hibt', 'blofin', 'tapbit', 'cexio', 'backpack', 'novadax', 'coinsph',
  'bitunix', 'btse', 'coincatch', 'coinstore', 'hotcoin', 'azbit', 'bitrue',
  'koinbx', 'bvox', 'bithumb', 'upbit'
];

// Build public exchange instances
const exchangeInstances = {};
for (const id of EXCHANGE_IDS) {
  try {
    const ExchangeClass = ccxt[id];
    if (!ExchangeClass) {
      console.log(`⚠️ Exchange ${id} not supported by CCXT`);
      continue;
    }
    const ex = new ExchangeClass({ enableRateLimit: true });
    exchangeInstances[id] = ex;
  } catch (err) {
    console.log(`⚠️ Failed to initialize ${id}:`, err.message);
  }
}
console.log(`📊 Loaded ${Object.keys(exchangeInstances).length} exchanges`);

const MIN_PROFIT = 0.2;
const MAX_PROFIT = 100;
let cachedOpportunities = [];
let detailedCache = new Map();
let lastFastScan = 0;
let lastDetailScan = 0;

async function fetchTickers(exchangeId) {
  const ex = exchangeInstances[exchangeId];
  if (!ex) return null;
  try {
    await ex.loadMarkets();
    const tickers = await ex.fetchTickers();
    return { exchangeId, tickers };
  } catch (err) {
    // silent fail
    return null;
  }
}

async function fastScan() {
  console.log('🔄 Fast scan (prices) on', Object.keys(exchangeInstances).length, 'exchanges...');
  const start = Date.now();
  try {
    const ids = Object.keys(exchangeInstances);
    const results = [];
    const chunkSize = 10;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(chunk.map(id => fetchTickers(id)));
      results.push(...chunkResults.filter(r => r !== null));
    }

    const symbolMap = {};
    for (const { exchangeId, tickers } of results) {
      for (const [symbol, ticker] of Object.entries(tickers)) {
        if (!ticker.last || ticker.last <= 0) continue;
        if (!symbol.endsWith('/USDT')) continue;
        const base = symbol.replace('/USDT', '');
        if (!symbolMap[base]) symbolMap[base] = [];
        symbolMap[base].push({
          exchange: exchangeId,
          price: ticker.last,
          volume: ticker.quoteVolume || ticker.baseVolume || 0
        });
      }
    }

    const opportunities = [];
    for (const [symbol, prices] of Object.entries(symbolMap)) {
      if (prices.length < 2) continue;
      prices.sort((a, b) => a.price - b.price);
      const buy = prices[0];
      const sell = prices[prices.length - 1];
      const spread = ((sell.price - buy.price) / buy.price) * 100;
      if (spread < MIN_PROFIT || spread > MAX_PROFIT) continue;
      let liquidity = buy.volume ? buy.volume * buy.price : 0;
      if (liquidity === 0) liquidity = buy.price * 50000;
      opportunities.push({
        id: `${symbol}-${buy.exchange}-${sell.exchange}`,
        symbol,
        buyExchange: buy.exchange.toUpperCase(),
        sellExchange: sell.exchange.toUpperCase(),
        buyPrice: buy.price.toFixed(8),
        sellPrice: sell.price.toFixed(8),
        spread: spread.toFixed(2),
        liquidity: liquidity.toFixed(0)
      });
    }

    cachedOpportunities = opportunities.sort((a, b) => +b.spread - +a.spread);
    lastFastScan = Date.now();
    console.log(`✅ Fast scan: ${cachedOpportunities.length} opportunities in ${Date.now() - start}ms`);
  } catch (err) {
    console.error('Fast scan failed:', err);
  }
}

// ===== Helper functions for detail scan =====
async function fetchRealNetworks(exchangeId, coin) {
  const ex = exchangeInstances[exchangeId];
  if (!ex) return null;
  try {
    await ex.loadMarkets();
    const currencies = await ex.fetchCurrencies();
    const coinData = currencies[coin];
    if (!coinData || !coinData.networks) return null;
    const networks = {};
    for (const [netName, netInfo] of Object.entries(coinData.networks)) {
      let feeUnit = netName === 'TRC20' ? 'USDT' : (netName === 'BEP20' ? 'BNB' : 'ETH');
      networks[netName] = {
        name: netName,
        deposit: netInfo.deposit === true,
        withdraw: netInfo.withdraw === true,
        fee: netInfo.fee || 0,
        feeUnit: feeUnit,
        minWithdraw: netInfo.withdrawMin || 0,
        arrivalTime: netName === 'TRC20' ? '2-5 min' : (netName === 'BEP20' ? '3-8 min' : '10-20 min')
      };
    }
    return { networks, canWithdraw: coinData.withdraw === true, canDeposit: coinData.deposit === true };
  } catch (err) {
    // silent fail
    return null;
  }
}

async function fetchLiquidity(exchangeId, symbol) {
  const ex = exchangeInstances[exchangeId];
  if (!ex) return null;
  try {
    const orderbook = await ex.fetchOrderBook(symbol, 5);
    const bids = orderbook.bids.slice(0, 3);
    return bids.reduce((sum, [price, amount]) => sum + price * amount, 0);
  } catch (err) {
    return null;
  }
}

function computeTradable(buyNetworks, sellNetworks) {
  if (!buyNetworks || !sellNetworks) return false;
  for (const [netName, netInfo] of Object.entries(buyNetworks)) {
    if (sellNetworks[netName] && netInfo.withdraw === true && sellNetworks[netName].deposit === true) {
      return true;
    }
  }
  return false;
}

async function detailScan() {
  const topOps = cachedOpportunities.slice(0, 200);
  if (topOps.length === 0) return;
  console.log('🔍 Detail scan (networks & liquidity) for top', topOps.length, 'opportunities...');
  const start = Date.now();
  let updated = 0;
  for (const opp of topOps) {
    const coin = opp.symbol;
    const buyEx = opp.buyExchange.toLowerCase();
    const sellEx = opp.sellExchange.toLowerCase();
    try {
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
      detailedCache.set(opp.id, {
        ...opp,
        liquidity: finalLiquidity,
        sellLiquidity: sellLiq || opp.liquidity,
        tradable,
        risk,
        buyNetworks: buyNet?.networks || {},
        sellNetworks: sellNet?.networks || {},
        buyWithdraw: buyNet?.canWithdraw || false,
        sellDeposit: sellNet?.canDeposit || false
      });
      updated++;
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      // skip
    }
  }
  lastDetailScan = Date.now();
  console.log(`✅ Detail scan: updated ${updated} opportunities in ${Date.now() - start}ms`);
}

// Schedule scans
fastScan();
setInterval(fastScan, 60000);
setInterval(() => { if (cachedOpportunities.length > 0) detailScan(); }, 120000);
setTimeout(() => { if (cachedOpportunities.length > 0) detailScan(); }, 30000);

// ==================== AUTH ROUTES ====================
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
    sendEmailAsync(
      email,
      'Welcome to ArbiMine!',
      `<h2>Welcome ${username}!</h2><p>Thank you for joining ArbiMine.</p><p>You can now start scanning live arbitrage opportunities.</p>`
    );
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
    sendEmailAsync(
      email,
      '🔐 New login to your ArbiMine account',
      `<p>Your ArbiMine account was just logged into at ${new Date().toLocaleString()}.</p><p>If this was you, ignore this message.</p>`
    );
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

// ==================== OPPORTUNITIES ENDPOINTS ====================
app.get('/api/opportunities', (req, res) => {
  const withDetails = cachedOpportunities.map(opp => {
    const detailed = detailedCache.get(opp.id);
    if (detailed) return detailed;
    return { ...opp, tradable: false, risk: 'medium', buyNetworks: {}, sellNetworks: {}, buyWithdraw: false, sellDeposit: false };
  });
  res.json({ count: withDetails.length, opportunities: withDetails, lastScan: lastFastScan });
});

app.get('/api/opportunity/:id/details', async (req, res) => {
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

// ==================== MESSAGING (User & Admin) ====================
app.post('/api/messages', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message required' });
    const blocked = await BlockedUser.findOne({ username: session.username });
    if (blocked) return res.status(403).json({ error: 'You have been blocked from sending messages' });
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

// Admin messaging
app.get('/admin/messages', adminAuth, async (req, res) => {
  try {
    const users = await Message.distinct('user');
    const conversations = [];
    for (const user of users) {
      const lastMsg = await Message.findOne({ user }).sort({ createdAt: -1 });
      const count = await Message.countDocuments({ user });
      conversations.push({ _id: user, count, lastMessage: lastMsg });
    }
    res.json(conversations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/messages/:user', adminAuth, async (req, res) => {
  try {
    const { user } = req.params;
    const messages = await Message.find({ user }).sort({ createdAt: -1 });
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/messages', adminAuth, async (req, res) => {
  try {
    const { userId, content } = req.body;
    if (!userId || !content) return res.status(400).json({ error: 'User and content required' });
    const msg = new Message({ user: userId, isAdmin: true, content: content.trim() });
    await msg.save();
    const user = await User.findOne({ username: userId });
    if (user) {
      sendEmailAsync(
        user.email,
        '📩 Admin Reply from ArbiMine Support',
        `<p>You have received a new reply from ArbiMine admin:</p><p><em>${content}</em></p><p>Login to your account to view the full conversation.</p>`
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/admin/message/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await Message.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/admin/message/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content required' });
    const msg = await Message.findByIdAndUpdate(id, { content: content.trim() }, { new: true });
    res.json({ success: true, message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/block/:username', adminAuth, async (req, res) => {
  try {
    const { username } = req.params;
    await BlockedUser.findOneAndUpdate({ username }, { username }, { upsert: true });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/unblock/:username', adminAuth, async (req, res) => {
  try {
    const { username } = req.params;
    await BlockedUser.deleteOne({ username });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== PAYMENT (Paystack) ====================
app.post('/api/pesapal/pay', async (req, res) => {
  const { plan } = req.body;
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const user = await User.findOne({ username: session.username });
    if (!user) return res.status(401).json({ error: 'User not found' });
    let amountInKobo = plan === 'weekly' ? 100 * 100 : 350 * 100;
    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackSecretKey) {
      console.error('PAYSTACK_SECRET_KEY missing');
      return res.status(500).json({ error: 'Payment not configured' });
    }
    const cleanUsername = sanitizeReference(user.username);
    const reference = `arbimine_${cleanUsername}_${Date.now()}`;
    const callbackUrl = `${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}/api/payment/callback`;
    console.log(`💰 Initializing Paystack: ${reference} for ${user.email}`);
    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: user.email,
      amount: amountInKobo,
      currency: 'KES',
      reference: reference,
      callback_url: callbackUrl,
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
      console.error('Paystack init error:', response.data);
      res.status(400).json({ error: response.data.message || 'Payment initialization failed' });
    }
  } catch (err) {
    console.error('Paystack error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment service error' });
  }
});

app.get('/api/transaction/:reference', async (req, res) => {
  const { reference } = req.params;
  try {
    const tx = await Transaction.findOne({ reference });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ status: tx.status, plan: tx.plan, amount: tx.amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payment/callback', async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.redirect(`${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?payment_status=failed`);
  try {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    const verification = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${secretKey}` }
    });
    const transaction = await Transaction.findOne({ reference });
    let status = 'failed';
    if (transaction) {
      status = verification.data.data.status === 'success' ? 'success' : 'failed';
      transaction.status = status;
      transaction.paystackResponse = verification.data;
      await transaction.save();
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
        const user = await User.findOne({ username });
        if (user) {
          sendEmailAsync(
            user.email,
            '✅ Payment Successful – ArbiMine Pro Activated',
            `<h2>Thank you for upgrading!</h2><p>Your ${plan} subscription is now active until ${expiresAt.toLocaleString()}.</p><p>Reference: ${reference}</p>`
          );
        }
      }
      return res.redirect(`${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?payment_status=success&reference=${reference}`);
    } else {
      const tx = await Transaction.findOne({ reference });
      if (tx && tx.user) {
        const user = await User.findOne({ username: tx.user });
        if (user) {
          sendEmailAsync(
            user.email,
            '❌ Payment Failed – ArbiMine',
            `<p>Your payment of KES ${tx.amount} for ${tx.plan} plan failed.</p><p>Reference: ${reference}</p><p>Please try again.</p>`
          );
        }
      }
      return res.redirect(`${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?payment_status=failed`);
    }
  } catch (err) {
    console.error('Verification error:', err);
    return res.redirect(`${process.env.APP_URL || 'https://arbimine-ke.onrender.com'}?payment_status=failed`);
  }
});

app.post('/api/payment/webhook', async (req, res) => {
  const event = req.body;
  console.log('Webhook received:', event);
  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    const transaction = await Transaction.findOne({ reference });
    if (transaction) {
      transaction.status = 'success';
      transaction.paystackResponse = event;
      await transaction.save();
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
      const user = await User.findOne({ username });
      if (user) {
        sendEmailAsync(
          user.email,
          '✅ Payment Successful – ArbiMine Pro Activated (Webhook)',
          `<h2>Thank you for upgrading!</h2><p>Your ${plan} subscription is now active until ${expiresAt.toLocaleString()}.</p><p>Reference: ${reference}</p>`
        );
      }
      console.log(`Subscription updated via webhook for ${username}`);
    }
  }
  res.json({ status: 'received' });
});

// ==================== ADMIN ====================
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
  if (active && !expiresAt) {
    const days = plan === 'weekly' ? 7 : 30;
    updates['subscription.expiresAt'] = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  } else if (expiresAt) {
    updates['subscription.expiresAt'] = new Date(expiresAt);
  }
  await User.findByIdAndUpdate(req.params.id, updates);
  res.json({ success: true });
});

app.delete('/admin/user/:id', adminAuth, async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== Health Check ====================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ==================== START SERVER ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ArbiMine running on ${PORT}`);
});
