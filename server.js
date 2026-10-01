require("dotenv").config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const nodemailer = require("nodemailer");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.set('trust proxy', 1);

// ==================== PayHero Config ====================
const PAYHERO_BASIC_AUTH_TOKEN = process.env.PAYHERO_BASIC_AUTH_TOKEN?.trim();
const PAYHERO_CHANNEL_ID = parseInt(process.env.PAYHERO_CHANNEL_ID, 10);
const PAYHERO_BASE_URL = 'https://backend.payhero.co.ke/api/v2';
const PAYHERO_CALLBACK_URL = process.env.PAYHERO_CALLBACK_URL || 'https://arbimine-miyc.onrender.com/api/payhero/callback';

// ==================== MongoDB ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ==================== Middleware ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many requests.' } });
app.use('/api/', limiter);

// ==================== Schemas ====================
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
const transactionSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  user: { type: String, required: true },
  plan: { type: String, enum: ['weekly', 'monthly', 'threeDay'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  failureReason: { type: String, default: null },
  paymentData: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  mpesa: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  isBlocked: { type: Boolean, default: false },
  subscription: {
    active: { type: Boolean, default: false },
    plan: { type: String, enum: ['weekly', 'monthly', 'threeDay', null], default: null },
    expiresAt: { type: Date, default: null }
  },
  createdAt: { type: Date, default: Date.now }
});
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  totpSecret: { type: String, default: null },
  isTotpEnabled: { type: Boolean, default: false }
});
const planSettingsSchema = new mongoose.Schema({
  weeklyAmount: { type: Number, default: 261 },
  weeklyDuration: { type: Number, default: 7 },
  monthlyAmount: { type: Number, default: 900 },
  monthlyDuration: { type: Number, default: 30 },
  threeDayAmount: { type: Number, default: 150 },
  threeDayDuration: { type: Number, default: 3 }
});
const settingsSchema = new mongoose.Schema({
  referralBaseUrl: { type: String, default: "https://arbimine-miyc.onrender.com" },
  updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);
const Message = mongoose.model('Message', messageSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const User = mongoose.model('User', userSchema);
const Admin = mongoose.model('Admin', adminSchema);
const PlanSettings = mongoose.model('PlanSettings', planSettingsSchema);
const Settings = mongoose.model('Settings', settingsSchema);

const generateToken = () => crypto.randomBytes(32).toString('hex');

// ==================== Admin setup ====================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function generateAdminToken(u) { return jwt.sign({ username: u, role: 'admin' }, JWT_SECRET, { expiresIn: '1d' }); }
function verifyAdminToken(t) { try { const d = jwt.verify(t, JWT_SECRET); return d.role === 'admin'; } catch { return false; } }
function adminAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token || !verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function ensureAdmin() {
  const a = await Admin.findOne({ username: ADMIN_USERNAME });
  if (!a) {
    const h = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await new Admin({ username: ADMIN_USERNAME, passwordHash: h, isTotpEnabled: false }).save();
    console.log('🔐 Default admin created');
  }
}
async function ensurePlanSettings() {
  if (!(await PlanSettings.findOne())) { await new PlanSettings().save(); console.log('📊 Default plans created'); }
}
async function ensureSettings() {
  if (!(await Settings.findOne())) await new Settings().save();
}
ensureAdmin(); ensurePlanSettings(); ensureSettings();

// ==================== Admin Auth ====================
const tempAdminSessions = new Map();
const pendingTotpSecrets = new Map();

app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    let admin = await Admin.findOne({ username });
    if (!admin) {
      const h = await bcrypt.hash(ADMIN_PASSWORD, 10);
      admin = new Admin({ username: ADMIN_USERNAME, passwordHash: h, isTotpEnabled: false });
      await admin.save();
    }
    const match = await bcrypt.compare(password, admin.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    if (admin.isTotpEnabled) {
      const tempToken = crypto.randomBytes(32).toString('hex');
      tempAdminSessions.set(tempToken, { username, expires: Date.now() + 300000 });
      return res.json({ success: true, tempToken, requiresOtp: true });
    }
    res.json({ success: true, token: generateAdminToken(username) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/verify-otp', async (req, res) => {
  const { tempToken, otp } = req.body;
  const session = tempAdminSessions.get(tempToken);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: 'Session expired' });
  const admin = await Admin.findOne({ username: session.username });
  if (!admin?.totpSecret) return res.status(401).json({ error: '2FA not set up' });
  if (!authenticator.verify({ token: otp, secret: admin.totpSecret })) return res.status(401).json({ error: 'Invalid OTP' });
  tempAdminSessions.delete(tempToken);
  res.json({ success: true, token: generateAdminToken(session.username) });
});

app.get('/admin/settings/plans', adminAuth, async (req, res) => res.json(await PlanSettings.findOne()));
app.put('/admin/settings/plans', adminAuth, async (req, res) => {
  let s = await PlanSettings.findOne() || new PlanSettings();
  Object.assign(s, req.body);
  await s.save();
  res.json({ success: true, settings: s });
});
app.get('/admin/users', adminAuth, async (req, res) => res.json(await User.find({}, '-passwordHash').limit(200).lean()));
app.get('/admin/transactions', adminAuth, async (req, res) => res.json(await Transaction.find().sort({ createdAt: -1 }).limit(200).lean()));
app.get('/admin/stats', adminAuth, async (req, res) => {
  const totalUsers = await User.estimatedDocumentCount();
  const activeSubs = await User.countDocuments({ "subscription.active": true });
  const totalRevenue = await Transaction.aggregate([{ $match: { status: "success" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
  const failedPayments = await Transaction.countDocuments({ status: "failed" });
  res.json({ totalUsers, activeSubs, totalRevenue: totalRevenue[0]?.total || 0, failedPayments });
});

// ==================== User Auth ====================
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  if (verifyAdminToken(token)) { req.user = 'admin'; return next(); }
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    req.user = session.username;
    const user = await User.findOne({ username: req.user });
    if (user?.subscription?.expiresAt && user.subscription.expiresAt < new Date()) {
      user.subscription.active = false;
      user.subscription.plan = null;
      await user.save();
    }
    next();
  } catch (err) { res.status(500).json({ error: 'Auth error' }); }
}

// ===== REGISTER (auto-login) =====
app.post('/api/register', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password;
    let username = (req.body.username || '').trim();
    let mpesa = (req.body.mpesa || '').trim().replace(/\D/g, '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Auto-derive missing fields
    if (!username) username = email.split('@')[0] + '_' + Math.floor(Math.random() * 9999);
    if (!mpesa) mpesa = '254' + Math.floor(100000000 + Math.random() * 900000000);

    const existing = await User.findOne({ $or: [{ username }, { email }, { mpesa }] });
    if (existing) {
      let error = 'Account already exists';
      if (existing.email === email) error = 'Email already registered';
      else if (existing.username === username) error = 'Username already taken';
      else if (existing.mpesa === mpesa) error = 'M-Pesa already in use';
      return res.status(409).json({ error });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await new User({ username, email, mpesa, passwordHash }).save();

    const token = generateToken();
    await new Session({ token, username: user.username }).save();

    res.json({
      success: true,
      token,
      username: user.username,
      email: user.email,
      mpesa: user.mpesa
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== LOGIN (flexible field names) =====
app.post('/api/login', async (req, res) => {
  try {
    const identifier =
      req.body.identifier ||
      req.body.username ||
      req.body.email ||
      req.body.mpesa ||
      req.body.phone ||
      req.body.login;

    const password = req.body.password;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const user = await User.findOne({
      $or: [
        { username: identifier },
        { email: String(identifier).toLowerCase() },
        { mpesa: String(identifier).replace(/\D/g, '') }
      ]
    });

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.isBlocked) return res.status(403).json({ error: 'Account blocked' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken();
    await new Session({ token, username: user.username }).save();

    res.json({ success: true, token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', authMiddleware, async (req, res) => {
  await Session.deleteOne({ token: req.headers.authorization });
  res.json({ success: true });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.user });
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ username: user.username, email: user.email, mpesa: user.mpesa });
});

app.get('/api/user/subscription', authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.user });
  if (!user) return res.status(401).json({ error: 'User not found' });
  const now = new Date();
  const isActive = user.subscription.active && user.subscription.expiresAt && user.subscription.expiresAt > now;
  const s = await PlanSettings.findOne();
  res.json({
    active: isActive,
    plan: user.subscription.plan,
    expiresAt: user.subscription.expiresAt,
    plans: {
      threeDay: { amount: s.threeDayAmount, duration: s.threeDayDuration },
      weekly: { amount: s.weeklyAmount, duration: s.weeklyDuration },
      monthly: { amount: s.monthlyAmount, duration: s.monthlyDuration }
    }
  });
});

app.post('/api/user/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  const user = await User.findOne({ username: req.user });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) return res.status(401).json({ error: 'Wrong password' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ success: true });
});

app.post('/api/user/change-mpesa', authMiddleware, async (req, res) => {
  const { newMpesa, password } = req.body;
  if (!newMpesa || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = await User.findOne({ username: req.user });
  if (!(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Wrong password' });
  const exists = await User.findOne({ mpesa: newMpesa });
  if (exists && exists.username !== req.user) return res.status(409).json({ error: 'M-Pesa already in use' });
  user.mpesa = newMpesa;
  await user.save();
  res.json({ success: true });
});

// ==================== Messaging ====================
app.post('/api/messages', authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.user });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Message required' });
  const msg = new Message({ user: req.user, isAdmin: false, content: content.trim(), status: 'sent' });
  await msg.save();
  res.json({ success: true, message: msg });
});

app.get('/api/messages', authMiddleware, async (req, res) => {
  const messages = await Message.find({ user: req.user, deleted: false }).sort({ createdAt: -1 });
  res.json(messages);
});

// ==================== Exchange instances ====================
const EXCHANGE_IDS = ['kucoin','mexc','kraken','huobi','gateio','coinex','crypto','xt','poloniex','bitfinex','upbit','whitebit','indodax'];
const EXCHANGE_NAMES = { kucoin:'KuCoin', mexc:'MEXC', kraken:'Kraken', huobi:'HTX', gateio:'Gate.io', coinex:'CoinEx', crypto:'Crypto.com', xt:'XT.COM', poloniex:'Poloniex', bitfinex:'Bitfinex', upbit:'Upbit', whitebit:'WhiteBIT', indodax:'Indodax' };

const exchangeInstances = {};
for (const id of EXCHANGE_IDS) {
  try {
    const Cls = ccxt[id];
    if (!Cls) continue;
    exchangeInstances[id] = new Cls({ enableRateLimit: true, timeout: 30000 });
  } catch (err) { console.error(`Init ${id} failed:`, err.message); }
}

// ==================== MANUAL Scanning ====================
let cachedOpportunities = [];
let detailedCache = new Map();
let aiCache = new Map();
let lastFastScan = 0;
let lastDetailScan = 0;
let isScanning = false;
let scanIntervals = { fast: null, detail: null };
let marketsLoaded = false;

const FAST_SCAN_INTERVAL = 60000;
const DETAIL_SCAN_INTERVAL = 120000;
const DETAIL_OPP_LIMIT = 200;
const MIN_PROFIT = 0.2;
const MAX_PROFIT = 100;
const FREE_TIER_MAX_SPREAD = 2.0;

const SYMBOL_BLACKLIST = new Set(['US','USD','MEA','SCA','AVAIL','HOME','GUA','ESPORTS','KRL','SIREN','STG','VANRY','PRCL','DGB','SWEAT','NAVX','TAIKO','DEXE','IOTX','VELODROME','SAND','MANA','CHZ','GALA']);

setInterval(() => aiCache.clear(), 60 * 60 * 1000);

async function loadAllMarkets() {
  if (marketsLoaded) return;
  for (const id of EXCHANGE_IDS) {
    const ex = exchangeInstances[id];
    if (!ex) continue;
    try { await ex.loadMarkets(); console.log(`📊 Markets loaded: ${id}`); } catch {}
  }
  marketsLoaded = true;
}

async function fastScan() {
  console.log('🔄 Fast scan...');
  const allTickers = {};
  for (const id of EXCHANGE_IDS) {
    const ex = exchangeInstances[id];
    if (!ex) continue;
    try { allTickers[id] = await ex.fetchTickers(); await new Promise(r => setTimeout(r, 300)); } catch {}
  }
  const pairMap = {};
  for (const [exId, tickers] of Object.entries(allTickers)) {
    for (const [pair, t] of Object.entries(tickers)) {
      const isUSDT = pair.endsWith('/USDT');
      const isIDR = pair.endsWith('/IDR') && exId === 'indodax';
      if (!isUSDT && !isIDR) continue;
      const symbol = pair.replace('/USDT', '').replace('/IDR', '');
      if (SYMBOL_BLACKLIST.has(symbol)) continue;
      const price = t.last || t.ask || t.bid || 0;
      if (!price) continue;
      if (!pairMap[symbol]) pairMap[symbol] = {};
      pairMap[symbol][exId] = { price, volume: t.quoteVolume || t.volume || 0, pair, bid: t.bid || 0, ask: t.ask || 0, currency: isUSDT ? 'USDT' : 'IDR' };
    }
  }
  const opps = [];
  for (const [symbol, exchanges] of Object.entries(pairMap)) {
    const usdtEntries = Object.entries(exchanges).filter(([_, d]) => d.currency === 'USDT');
    if (usdtEntries.length < 2) continue;
    usdtEntries.sort((a, b) => a[1].price - b[1].price);
    const [buyEx, buy] = usdtEntries[0];
    const [sellEx, sell] = usdtEntries[usdtEntries.length - 1];
    const spread = ((sell.price - buy.price) / buy.price) * 100;
    if (spread < MIN_PROFIT || spread > MAX_PROFIT) continue;
    let liq = buy.volume ? buy.volume * buy.price : 0;
    if (!liq) liq = buy.price * 50000 * (spread > 10 ? 0.3 : spread > 5 ? 0.6 : 1);
    opps.push({
      id: `${symbol}-${buyEx}-${sellEx}`, symbol,
      buyExchange: EXCHANGE_NAMES[buyEx] || buyEx, sellExchange: EXCHANGE_NAMES[sellEx] || sellEx,
      buyPrice: buy.price.toFixed(8), sellPrice: sell.price.toFixed(8),
      spread: spread.toFixed(2), liquidity: liq.toFixed(0),
      buyPair: buy.pair, sellPair: sell.pair,
      buyBid: buy.bid, buyAsk: buy.ask, sellBid: sell.bid, sellAsk: sell.ask,
      timestamp: Date.now(), volume: buy.volume || sell.volume || 0,
      tradable: true, risk: 'medium', buyNetworks: {}, sellNetworks: {}, buyWithdraw: false, sellDeposit: false
    });
  }
  cachedOpportunities = opps.sort((a, b) => +b.spread - +a.spread);
  lastFastScan = Date.now();
  console.log(`✅ Fast scan: ${cachedOpportunities.length} opps`);
  if (cachedOpportunities.length) detailScan();
}

async function detailScan() {
  const valid = cachedOpportunities.slice(0, DETAIL_OPP_LIMIT);
  for (const opp of valid) {
    if (!detailedCache.has(opp.id)) {
      detailedCache.set(opp.id, { ...opp, risk: parseFloat(opp.spread) > 3 ? 'high' : parseFloat(opp.spread) < 1 ? 'low' : 'medium' });
    }
  }
  lastDetailScan = Date.now();
}

async function startScanning() {
  if (isScanning) return;
  isScanning = true;
  console.log('▶️ Scanning STARTED');
  await loadAllMarkets();
  await fastScan();
  scanIntervals.fast = setInterval(fastScan, FAST_SCAN_INTERVAL);
  scanIntervals.detail = setInterval(() => cachedOpportunities.length && detailScan(), DETAIL_SCAN_INTERVAL);
}

function stopScanning() {
  if (!isScanning) return;
  isScanning = false;
  console.log('⏹️ Scanning STOPPED');
  if (scanIntervals.fast) clearInterval(scanIntervals.fast);
  if (scanIntervals.detail) clearInterval(scanIntervals.detail);
  scanIntervals.fast = null; scanIntervals.detail = null;
}

app.post('/api/scan/start', authMiddleware, async (req, res) => {
  try { await startScanning(); res.json({ success: true, scanning: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/scan/stop', authMiddleware, (req, res) => { stopScanning(); res.json({ success: true, scanning: false }); });
app.get('/api/scan/status', authMiddleware, (req, res) => res.json({ scanning: isScanning, lastScan: lastFastScan, opportunities: cachedOpportunities.length }));

// ==================== AI ====================
const AI_API_URL = process.env.AI_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-3.5-turbo';

function fallbackAI(o) {
  const s = parseFloat(o.spread) || 0;
  const l = parseFloat(o.liquidity) || 0;
  if (s > 1 && l > 10000) return { score: 85, risk: 'low', recommendation: 'Strong buy', summary: 'High spread and good liquidity.' };
  if (s > 0.5) return { score: 70, risk: 'medium', recommendation: 'Moderate', summary: 'Decent spread.' };
  if (s > 0.3) return { score: 55, risk: 'medium', recommendation: 'Caution', summary: 'Small spread.' };
  return { score: 30, risk: 'high', recommendation: 'Avoid', summary: 'Low spread.' };
}
async function getAI(o) {
  if (!AI_API_KEY) return fallbackAI(o);
  try {
    const r = await axios.post(AI_API_URL, {
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'Crypto arbitrage expert. Return JSON only: {score, risk, recommendation, summary}' },
        { role: 'user', content: `${o.symbol} ${o.buyExchange}→${o.sellExchange} spread ${o.spread}% liq ${o.liquidity}` }
      ],
      temperature: 0.3, max_tokens: 150
    }, { headers: { Authorization: `Bearer ${AI_API_KEY}` }, timeout: 10000 });
    const parsed = JSON.parse(r.data.choices[0].message.content.replace(/```json|```/g, '').trim());
    return { score: parsed.score || 50, risk: parsed.risk || 'medium', recommendation: parsed.recommendation || 'Consider', summary: parsed.summary || '' };
  } catch { return fallbackAI(o); }
}

app.get('/api/opportunities', authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.user });
  if (!user) return res.status(401).json({ error: 'User not found' });
  const isPro = user.subscription.active && user.subscription.expiresAt > new Date();
  let opps = cachedOpportunities.map(o => detailedCache.get(o.id) || o);
  if (!isPro) opps = opps.filter(o => parseFloat(o.spread) <= FREE_TIER_MAX_SPREAD);
  const top = opps.slice(0, 20);
  for (const o of top) {
    if (!aiCache.has(o.id)) aiCache.set(o.id, await getAI(o));
    const a = aiCache.get(o.id);
    o.aiScore = a.score; o.aiRisk = a.risk; o.aiRecommendation = a.recommendation; o.aiSummary = a.summary;
  }
  res.json({
    count: opps.length, opportunities: opps,
    totalAvailable: cachedOpportunities.length, shownCount: opps.length,
    isPro, freeTierLimit: FREE_TIER_MAX_SPREAD,
    lastScan: lastFastScan, lastDetail: lastDetailScan, scanning: isScanning
  });
});

// ==================== PayHero Payment ====================
function getExpiryDate(plan, s) {
  let d;
  if (plan === 'weekly') d = s.weeklyDuration;
  else if (plan === 'monthly') d = s.monthlyDuration;
  else if (plan === 'threeDay') d = s.threeDayDuration;
  if (!d) return null;
  const dt = new Date(); dt.setDate(dt.getDate() + d); return dt;
}

function normalizeMsisdn(v) {
  let p = String(v || '').replace(/\D/g, '');
  if (p.startsWith('254')) return p;
  if (p.startsWith('0')) return '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) return '254' + p;
  return p;
}

app.post('/api/payhero/initialize', authMiddleware, async (req, res) => {
  try {
    const { plan, phone } = req.body;
    if (!['weekly','monthly','threeDay'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    if (!PAYHERO_BASIC_AUTH_TOKEN || !PAYHERO_CHANNEL_ID) return res.status(500).json({ error: 'PayHero not configured on server' });

    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const s = await PlanSettings.findOne();
    const amount = plan === 'weekly' ? s.weeklyAmount : plan === 'monthly' ? s.monthlyAmount : s.threeDayAmount;
    const msisdn = normalizeMsisdn(phone || user.mpesa);
    if (!msisdn.startsWith('254') || msisdn.length !== 12) return res.status(400).json({ error: 'Invalid M-Pesa number' });

    const reference = `ARBIMINE_${user.username}_${Date.now()}`;
    const payload = {
      amount: Number(amount),
      phone_number: msisdn,
      channel_id: PAYHERO_CHANNEL_ID,
      provider: 'm-pesa',
      external_reference: reference,
      callback_url: PAYHERO_CALLBACK_URL
    };
    const authHeader = PAYHERO_BASIC_AUTH_TOKEN.startsWith('Basic ') ? PAYHERO_BASIC_AUTH_TOKEN : `Basic ${PAYHERO_BASIC_AUTH_TOKEN}`;

    const r = await axios.post(`${PAYHERO_BASE_URL}/payments`, payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      timeout: 30000, validateStatus: () => true
    });

    const ok = r.status >= 200 && r.status < 300 && (r.data?.success === true || r.data?.status === true);

    await Transaction.create({
      reference, user: user.username, plan, amount,
      status: ok ? 'pending' : 'failed',
      failureReason: ok ? null : (r.data?.message || 'STK push rejected'),
      paymentData: r.data
    });

    if (!ok) return res.status(400).json({ success: false, error: r.data?.message || 'STK push failed', details: r.data });

    res.json({ success: true, reference, message: '📱 Check your phone for the M-PESA prompt.' });
  } catch (err) {
    console.error('PayHero init error:', err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.post('/api/payhero/callback', async (req, res) => {
  try {
    console.log('📬 PayHero callback:', JSON.stringify(req.body, null, 2));
    const d = req.body?.response || req.body;
    const reference = d?.external_reference || d?.User_Reference || null;
    const resultCode = d?.ResultCode !== undefined ? d.ResultCode : d?.result_code;
    const resultDesc = d?.ResultDesc || d?.result_desc || null;
    const statusRaw = d?.Status || d?.status;

    let status = 'failed';
    let reason = resultDesc || 'Transaction failed';

    if (resultCode === 0 || resultCode === '0' || String(statusRaw).toLowerCase() === 'success') {
      status = 'success'; reason = 'Payment successful';
    } else if (resultCode === 1032) reason = 'Request cancelled by user';
    else if (resultCode === 1037) reason = 'Request timed out';
    else if (resultCode === 1) reason = 'Insufficient funds';
    else if (resultCode === 2001) reason = 'Wrong PIN entered';

    if (!reference) return res.status(200).json({ status: 'received' });

    const tx = await Transaction.findOne({ reference });
    if (tx) {
      tx.status = status;
      tx.failureReason = status === 'success' ? null : reason;
      tx.paymentData = { ...(tx.paymentData || {}), callback: req.body };
      await tx.save();
      if (status === 'success') {
        const s = await PlanSettings.findOne();
        const expiresAt = getExpiryDate(tx.plan, s);
        await User.findOneAndUpdate(
          { username: tx.user },
          { 'subscription.active': true, 'subscription.plan': tx.plan, 'subscription.expiresAt': expiresAt }
        );
        console.log(`✅ Subscription activated: ${tx.user}`);
      } else {
        console.log(`❌ Payment failed: ${tx.user} → ${reason}`);
      }
    }
    res.status(200).json({ status: 'received' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/payment/status/:reference', authMiddleware, async (req, res) => {
  const tx = await Transaction.findOne({ reference: req.params.reference, user: req.user });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  res.json({
    success: true, reference: tx.reference, status: tx.status,
    reason: tx.status === 'failed' ? tx.failureReason : null,
    plan: tx.plan, amount: tx.amount, createdAt: tx.createdAt
  });
});

app.get('/api/transactions', authMiddleware, async (req, res) => {
  const txs = await Transaction.find({ user: req.user }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ success: true, transactions: txs });
});

// ==================== Admin Panel ====================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 ArbiMine on port ${PORT}`);
  console.log(`🔍 Scan mode: MANUAL`);
});
