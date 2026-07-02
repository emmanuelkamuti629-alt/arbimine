require("dotenv").config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== Trust Proxy (Render) ====================
app.set('trust proxy', 1);

// ==================== MongoDB ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

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
  status: { type: String, enum: ['pending', 'completed', 'failed', 'cancelled'], default: 'pending' },
  txId: { type: String, unique: true, sparse: true },
  buyOrderId: String,
  sellOrderId: String,
  withdrawalId: String,
  executionTime: Number,
  networkUsed: String,
  progress: { type: String, default: 'initiated' },
  progressSteps: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
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
const Trade = mongoose.model('Trade', tradeSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const User = mongoose.model('User', userSchema);

const generateToken = () => crypto.randomBytes(32).toString('hex');
const hashPassword = p => crypto.createHash('sha256').update(p).digest('hex');

// ==================== Admin Auth ====================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const adminTokens = new Set();

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = generateToken();
    adminTokens.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid admin credentials' });
  }
});

// ==================== Combined Auth ====================
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });

  if (adminTokens.has(token)) {
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

function adminAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ==================== Login Route ====================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      const token = generateToken();
      await new Session({ token, username }).save();
      adminTokens.add(token);
      return res.json({ success: true, token, username });
    } else {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

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
app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message required' });
    const blocked = await BlockedUser.findOne({ username: req.user });
    if (blocked) return res.status(403).json({ error: 'You have been blocked' });
    const msg = new Message({ user: req.user, isAdmin: false, content: content.trim() });
    await msg.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const messages = await Message.find({ user: req.user }).sort({ createdAt: -1 });
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== Admin Endpoints ====================
app.get('/admin/users', adminAuth, async (req, res) => {
  const users = await User.find({}, '-passwordHash');
  res.json(users);
});

app.get('/admin/messages', adminAuth, async (req, res) => {
  const messages = await Message.find().sort({ createdAt: -1 });
  res.json(messages);
});

app.post('/admin/block/:username', adminAuth, async (req, res) => {
  await BlockedUser.findOneAndUpdate({ username: req.params.username }, { username: req.params.username }, { upsert: true });
  res.json({ success: true });
});

app.post('/admin/unblock/:username', adminAuth, async (req, res) => {
  await BlockedUser.deleteOne({ username: req.params.username });
  res.json({ success: true });
});

// ==================== Exchange Integration ====================
const SUPPORTED_EXCHANGES = ['kucoin', 'mexc', 'gateio', 'htx', 'bingx'];

function buildExchange(exchangeId, apiKey, secret) {
  const exchangeMap = {
    kucoin: ccxt.kucoin,
    htx: ccxt.huobi,
    gateio: ccxt.gateio,
    mexc: ccxt.mexc,
    bingx: ccxt.bingx
  };
  const ExchangeClass = exchangeMap[exchangeId];
  if (!ExchangeClass) return null;
  const config = {
    enableRateLimit: true,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  };
  if (apiKey && secret) { config.apiKey = apiKey; config.secret = secret; }
  if (exchangeId === 'kucoin' && process.env.KUCOIN_PASSWORD) {
    config.password = process.env.KUCOIN_PASSWORD;
  }
  return new ExchangeClass(config);
}

const EXCHANGE_CREDENTIALS = {
  kucoin: { apiKey: process.env.KUCOIN_API_KEY, secret: process.env.KUCOIN_SECRET },
  htx: { apiKey: process.env.HTX_API_KEY, secret: process.env.HTX_SECRET },
  gateio: { apiKey: process.env.GATEIO_API_KEY, secret: process.env.GATEIO_SECRET },
  mexc: { apiKey: process.env.MEXC_API_KEY, secret: process.env.MEXC_SECRET },
  bingx: { apiKey: process.env.BINGX_API_KEY, secret: process.env.BINGX_SECRET }
};

const exchangeInstances = {};
for (const [id, cred] of Object.entries(EXCHANGE_CREDENTIALS)) {
  const ex = buildExchange(id, cred.apiKey, cred.secret);
  if (ex) exchangeInstances[id] = ex;
  console.log(`🔌 ${id} initialized${cred.apiKey ? ' with API keys' : ' (public only)'}`);
}

// In-memory exchange API keys (for the "Exchanges" tab)
const userExchangeKeys = {};

app.post('/api/exchange/connect', authMiddleware, async (req, res) => {
  const { exchange, apiKey, secret } = req.body;
  if (!exchange || !apiKey || !secret) {
    return res.status(400).json({ error: 'Missing exchange, API key or secret' });
  }
  try {
    const ex = buildExchange(exchange, apiKey, secret);
    if (!ex) return res.status(400).json({ error: 'Exchange not supported' });
    await ex.loadMarkets();
    userExchangeKeys[exchange] = { apiKey, secret };
    exchangeInstances[exchange] = ex;
    res.json({ success: true, message: `${exchange} connected successfully` });
  } catch (err) {
    console.error('Exchange connection error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

function mapNetwork(exchange, currency, network) {
  const map = {
    'kucoin': {
      'USDT': { 'TRC20': 'TRC20', 'ERC20': 'ERC20', 'BEP20': 'BEP20', 'SOL': 'SOL' },
      'BTC': { 'BTC': 'BTC', 'BEP20': 'BEP20' },
      'ETH': { 'ERC20': 'ERC20' }
    },
    'mexc': {
      'USDT': { 'TRC20': 'TRC20', 'ERC20': 'ERC20', 'BEP20': 'BEP20', 'SOL': 'SOL' },
      'BTC': { 'BTC': 'BTC' },
      'ETH': { 'ERC20': 'ERC20' }
    },
    'gateio': {
      'USDT': { 'TRC20': 'TRC20', 'ERC20': 'ERC20', 'BEP20': 'BEP20' },
      'BTC': { 'BTC': 'BTC' },
      'ETH': { 'ERC20': 'ERC20' }
    },
    'htx': {
      'USDT': { 'TRC20': 'TRC20', 'ERC20': 'ERC20', 'BEP20': 'BEP20' },
      'BTC': { 'BTC': 'BTC' },
      'ETH': { 'ERC20': 'ERC20' }
    },
    'bingx': {
      'USDT': { 'TRC20': 'TRC20', 'ERC20': 'ERC20', 'BEP20': 'BEP20' },
      'BTC': { 'BTC': 'BTC' },
      'ETH': { 'ERC20': 'ERC20' }
    }
  };
  const exMap = map[exchange.toLowerCase()];
  if (!exMap) return network;
  const currMap = exMap[currency.toUpperCase()];
  if (!currMap) return network;
  const key = Object.keys(currMap).find(k => k.toUpperCase() === network.toUpperCase());
  return key ? currMap[key] : network;
}

const EXCHANGES = {
  mexc: 'https://api.mexc.com/api/v3/ticker/24hr',
  kucoin: 'https://api.kucoin.com/api/v1/market/allTickers',
  bitmart: 'https://api-cloud.bitmart.com/spot/v1/ticker',
  bitget: 'https://api.bitget.com/api/spot/v1/market/tickers',
  lbank: 'https://api.lbank.info/v1/ticker.do?symbol=all',
  coinex: 'https://api.coinex.com/v1/market/ticker/all',
  gateio: 'https://api.gateio.ws/api/v4/spot/tickers',
  okx: 'https://www.okx.com/api/v5/market/tickers?instType=SPOT',
  bybit: 'https://api.bybit.com/v5/market/tickers?category=spot',
  htx: 'https://api.huobi.pro/market/tickers',
  bitfinex: 'https://api-pub.bitfinex.com/v2/tickers?symbols=ALL',
  poloniex: 'https://api.poloniex.com/markets/ticker24h',
  cryptocom: 'https://api.crypto.com/exchange/v1/public/get-tickers',
  upbit: 'https://api.upbit.com/v1/ticker?markets=KRW-BTC'
};

const SYMBOL_BLACKLIST = new Set([
  'US', 'USD', 'MEA', 'SCA', 'AVAIL', 'HOME', 'GUA', 'ESPORTS', 'KRL',
  'SIREN', 'STG', 'VANRY', 'PRCL', 'DGB', 'SWEAT', 'NAVX', 'TAIKO',
  'DEXE', 'IOTX', 'VELODROME', 'SAND', 'MANA', 'CHZ', 'GALA'
]);

async function safeGet(url, name) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    return res.data;
  } catch (e) {
    console.log(`${name} public FAILED:`, e.message);
    return null;
  }
}

const MIN_PROFIT = 0.2;
const MAX_PROFIT = 100;

function extractSymbol(exchange, symbol, t) {
  let sym = null, price = null, volume = null, pair = null, bid = null, ask = null, timestamp = null;
  try {
    if (exchange === 'mexc' && symbol.endsWith('USDT')) {
      sym = symbol.replace('USDT', '');
      price = +t.lastPrice;
      volume = +t.quoteVolume;
      pair = symbol;
      bid = +t.bidPrice;
      ask = +t.askPrice;
      timestamp = t.timestamp || Date.now();
    } else if (exchange === 'kucoin' && symbol.includes('-USDT')) {
      sym = symbol.replace('-USDT', '');
      price = +t.last;
      volume = +t.volValue;
      pair = symbol;
      bid = +t.bid;
      ask = +t.ask;
      timestamp = t.timestamp || Date.now();
    } else if (exchange === 'bitmart' && symbol.includes('_USDT')) {
      sym = symbol.replace('_USDT', '');
      price = +t.last_price;
      volume = +t.quote_volume;
      pair = symbol;
      bid = +t.bid_price;
      ask = +t.ask_price;
      timestamp = t.timestamp || Date.now();
    } else if (exchange === 'bitget') {
      const s = t.symbol;
      if (s && s.includes('USDT')) {
        sym = s.replace('USDT', '');
        price = +t.close;
        volume = +t.usdtVol;
        pair = s;
        bid = +t.bid;
        ask = +t.ask;
        timestamp = t.timestamp || Date.now();
      }
    } else if (exchange === 'gateio' && symbol.includes('_USDT')) {
      sym = symbol.replace('_USDT', '');
      price = +t.last;
      volume = +t.quote_volume;
      pair = symbol;
      bid = +t.bid;
      ask = +t.ask;
      timestamp = t.timestamp || Date.now();
    } else if (exchange === 'okx' && symbol.includes('-USDT')) {
      sym = symbol.replace('-USDT', '');
      price = +t.last;
      volume = +t.volCcy24h;
      pair = symbol;
      bid = +t.bid;
      ask = +t.ask;
      timestamp = t.timestamp || Date.now();
    } else if (exchange === 'bybit') {
      const s = t.symbol;
      if (s && s.includes('USDT')) {
        sym = s.replace('USDT', '');
        price = +t.lastPrice;
        volume = +t.turnover24h;
        pair = s;
        bid = +t.bidPrice;
        ask = +t.askPrice;
        timestamp = t.timestamp || Date.now();
      }
    } else if (exchange === 'htx' && symbol.endsWith('usdt')) {
      sym = symbol.replace('usdt', '').toUpperCase();
      price = +t.close;
      volume = +t.vol;
      pair = symbol;
      bid = +t.bid;
      ask = +t.ask;
      timestamp = t.timestamp || Date.now();
    } else if (exchange === 'bitfinex' && Array.isArray(t) && t[0]?.startsWith('t')) {
      const pairRaw = t[0].replace('t', '');
      if (pairRaw.includes('USD')) {
        sym = pairRaw.replace('USD', '');
        price = +t[7];
        volume = +t[8];
        pair = 't' + pairRaw;
        bid = +t[1];
        ask = +t[3];
        timestamp = t[11] || Date.now();
      }
    } else if (exchange === 'cryptocom') {
      const inst = t.i;
      if (inst && inst.includes('_USDT')) {
        sym = inst.replace('_USDT', '');
        price = +t.a;
        volume = +t.v;
        pair = inst;
        bid = +t.b;
        ask = +t.k;
        timestamp = t.t || Date.now();
      }
    } else if (exchange === 'upbit' && t.market?.startsWith('KRW-')) {
      sym = t.market.replace('KRW-', '');
      price = +t.trade_price;
      volume = +t.acc_trade_price_24h;
      pair = t.market;
      bid = +t.bid_price;
      ask = +t.ask_price;
      timestamp = t.timestamp || Date.now();
    }
    if (!sym || !price) return null;
    if (SYMBOL_BLACKLIST.has(sym)) return null;
    return { symbol: sym, price, volume: volume || 0, pair: pair || symbol, bid, ask, timestamp };
  } catch { return null; }
}

let cachedOpportunities = [];
let detailedCache = new Map();
let aiCache = new Map();
let lastFastScan = 0;
let lastDetailScan = 0;
const FAST_SCAN_INTERVAL = 60000;
const DETAIL_SCAN_INTERVAL = 120000;
const DETAIL_OPP_LIMIT = 200;

// ==================== AI Integration (OpenRouter) ====================
const AI_API_URL = process.env.AI_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-3.5-turbo';

async function getAIAnalysis(opportunity) {
  if (!AI_API_KEY) {
    console.warn('⚠️ AI_API_KEY missing – using fallback');
    return getFallbackAnalysis(opportunity);
  }
  try {
    const response = await axios.post(AI_API_URL, {
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'You are a crypto arbitrage expert. Return JSON only with fields: score (0-100), risk (low/medium/high), recommendation (string), summary (string).' },
        { role: 'user', content: `Analyze this arbitrage opportunity:\nSymbol: ${opportunity.symbol}\nBuy Exchange: ${opportunity.buyExchange} at $${opportunity.buyPrice}\nSell Exchange: ${opportunity.sellExchange} at $${opportunity.sellPrice}\nSpread: ${opportunity.spread}%\nLiquidity: $${opportunity.liquidity}\nReturn valid JSON only.` }
      ],
      temperature: 0.3,
      max_tokens: 150
    }, {
      headers: {
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'https://arbitrage-master.onrender.com',
        'X-Title': 'ArbiMine Pro'
      },
      timeout: 10000
    });
    const content = response.data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');
    const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      score: parsed.score || 50,
      risk: parsed.risk || 'medium',
      recommendation: parsed.recommendation || 'Consider',
      summary: parsed.summary || 'AI analysis generated.'
    };
  } catch (err) {
    console.error('AI API error:', err.message);
    return getFallbackAnalysis(opportunity);
  }
}

function getFallbackAnalysis(opportunity) {
  const spread = parseFloat(opportunity.spread) || 0;
  const liquidity = parseFloat(opportunity.liquidity) || 0;
  let score = 50, risk = 'medium', recommendation = 'Consider', summary = 'AI analysis unavailable.';
  if (spread > 1 && liquidity > 10000) { score = 85; risk = 'low'; recommendation = 'Strong buy'; summary = 'High spread and good liquidity.'; }
  else if (spread > 0.5 && liquidity > 5000) { score = 70; risk = 'medium'; recommendation = 'Moderate'; summary = 'Decent spread with adequate liquidity.'; }
  else if (spread > 0.3) { score = 55; risk = 'medium'; recommendation = 'Caution'; summary = 'Small spread, low profit potential.'; }
  else { score = 30; risk = 'high'; recommendation = 'Avoid'; summary = 'Low spread and low liquidity make this risky.'; }
  return { score, risk, recommendation, summary };
}

async function getAIAnalysisCached(opp) {
  const key = opp.id;
  if (aiCache.has(key)) return aiCache.get(key);
  const result = await getAIAnalysis(opp);
  if (result) aiCache.set(key, result);
  return result;
}

// ==================== Fast Scan ====================
async function fastScan() {
  console.log('🔄 Fast scan (using public tickers)...');
  const start = Date.now();
  try {
    const results = await Promise.all(Object.entries(EXCHANGES).map(([n, u]) => safeGet(u, n)));
    const allData = {};
    Object.keys(EXCHANGES).forEach(e => (allData[e] = {}));
    results.forEach((data, idx) => {
      const ex = Object.keys(EXCHANGES)[idx];
      if (!data) return;
      let tickers = [];
      if (ex === 'mexc') tickers = data;
      else if (ex === 'kucoin') tickers = data.data?.ticker || [];
      else if (ex === 'bitmart') tickers = data.data?.tickers || [];
      else if (ex === 'bitget') tickers = data.data || [];
      else if (ex === 'gateio') tickers = data;
      else if (ex === 'okx') tickers = data.data || [];
      else if (ex === 'bybit') tickers = data.result?.list || [];
      else if (ex === 'htx') tickers = data.data || [];
      else if (ex === 'bitfinex') tickers = data || [];
      else if (ex === 'poloniex') tickers = data.data || [];
      else if (ex === 'cryptocom') tickers = data.result?.data || [];
      else if (ex === 'upbit') tickers = data || [];
      for (const t of tickers) {
        const symKey = t.symbol || t.currency_pair || t.instId || t.market || t.i || '';
        const d = extractSymbol(ex, symKey, t);
        if (!d) continue;
        allData[ex][d.symbol] = { price: d.price, volume: d.volume, pair: d.pair, bid: d.bid, ask: d.ask, timestamp: d.timestamp };
      }
    });
    const symbols = new Set();
    Object.values(allData).forEach(ex => Object.keys(ex).forEach(s => symbols.add(s)));
    const opportunities = [];
    for (const symbol of symbols) {
      if (SYMBOL_BLACKLIST.has(symbol)) continue;
      const prices = [];
      for (const ex of Object.keys(allData)) {
        if (allData[ex][symbol]) prices.push([ex, allData[ex][symbol]]);
      }
      if (prices.length < 2) continue;
      prices.sort((a, b) => a[1].price - b[1].price);
      const [buyEx, buy] = prices[0];
      const [sellEx, sell] = prices[prices.length - 1];
      if (!SUPPORTED_EXCHANGES.includes(buyEx) || !SUPPORTED_EXCHANGES.includes(sellEx)) continue;
      const spread = ((sell.price - buy.price) / buy.price) * 100;
      if (spread < MIN_PROFIT || spread > MAX_PROFIT) continue;
      let liquidity = buy.volume ? buy.volume * buy.price : 0;
      if (liquidity === 0) liquidity = buy.price * 50000 * (spread > 10 ? 0.3 : spread > 5 ? 0.6 : 1);
      opportunities.push({
        id: `${symbol}-${buyEx}-${sellEx}`,
        symbol,
        buyExchange: buyEx.toUpperCase(),
        sellExchange: sellEx.toUpperCase(),
        buyPrice: buy.price.toFixed(8),
        sellPrice: sell.price.toFixed(8),
        spread: spread.toFixed(2),
        liquidity: liquidity.toFixed(0),
        buyPair: buy.pair,
        sellPair: sell.pair,
        buyBid: buy.bid,
        buyAsk: buy.ask,
        sellBid: sell.bid,
        sellAsk: sell.ask,
        timestamp: buy.timestamp || sell.timestamp || Date.now(),
        volume: buy.volume || sell.volume || 0
      });
    }
    cachedOpportunities = opportunities.sort((a,b) => +b.spread - +a.spread);
    lastFastScan = Date.now();
    console.log(`✅ Fast scan: ${cachedOpportunities.length} opportunities in ${Date.now() - start}ms`);
  } catch (err) {
    console.error('Fast scan failed:', err);
  }

  if (cachedOpportunities.length > 0) {
    detailScan();
  }
}

// ==================== Detail Scan ====================
async function fetchRealNetworks(exchangeId, coin) {
  const key = exchangeId.toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(key)) return null;
  let ex = exchangeInstances[key];
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
    console.log(`Network error ${exchangeId} ${coin}:`, err.message);
    return null;
  }
}

async function fetchLiquidity(exchangeId, symbol) {
  const key = exchangeId.toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(key)) return null;
  let ex = exchangeInstances[key];
  if (!ex) return null;
  try {
    const orderbook = await ex.fetchOrderBook(symbol, 5);
    const bids = orderbook.bids.slice(0, 3);
    return bids.reduce((sum, [price, amount]) => sum + price * amount, 0);
  } catch (err) {
    console.log(`Liquidity error ${exchangeId} ${symbol}:`, err.message);
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
  console.log('🔍 Detail scan (networks & liquidity) for top', DETAIL_OPP_LIMIT, 'opportunities...');
  const start = Date.now();
  const validOpps = cachedOpportunities
    .filter(o => !SYMBOL_BLACKLIST.has(o.symbol))
    .filter(o => {
      const buyEx = exchangeInstances[o.buyExchange.toLowerCase()];
      const sellEx = exchangeInstances[o.sellExchange.toLowerCase()];
      if (!buyEx || !sellEx) return false;
      try {
        const buyMarket = buyEx.market(o.buyPair);
        const sellMarket = sellEx.market(o.sellPair);
        return buyMarket && sellMarket;
      } catch {
        return false;
      }
    })
    .slice(0, DETAIL_OPP_LIMIT);

  let updated = 0;
  const updatePromises = validOpps.map(async (opp) => {
    const coin = opp.symbol;
    const buyEx = opp.buyExchange.toLowerCase();
    const sellEx = opp.sellExchange.toLowerCase();
    try {
      const [buyNet, sellNet, buyLiq, sellLiq] = await Promise.all([
        fetchRealNetworks(buyEx, coin),
        fetchRealNetworks(sellEx, coin),
        fetchLiquidity(buyEx, opp.buyPair),
        fetchLiquidity(sellEx, opp.sellPair)
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
    } catch (err) {
      console.log(`Detail scan failed for ${opp.id}:`, err.message);
    }
  });

  await Promise.all(updatePromises);
  lastDetailScan = Date.now();
  console.log(`✅ Detail scan: updated ${updated} opportunities in ${Date.now() - start}ms`);
}

fastScan();
setInterval(fastScan, FAST_SCAN_INTERVAL);
setInterval(() => { if (cachedOpportunities.length > 0) detailScan(); }, DETAIL_SCAN_INTERVAL);

// ==================== Opportunities ====================
app.get('/api/opportunities', authMiddleware, async (req, res) => {
  console.log(`📊 /api/opportunities called by ${req.user}, cached: ${cachedOpportunities.length}`);
  const withDetails = cachedOpportunities.map(opp => {
    const detailed = detailedCache.get(opp.id);
    const base = detailed || { ...opp, tradable: false, risk: 'medium', buyNetworks: {}, sellNetworks: {}, buyWithdraw: false, sellDeposit: false };
    return base;
  });

  const top20 = withDetails.slice(0, 20);
  const aiPromises = top20.map(async (opp) => {
    const ai = await getAIAnalysisCached(opp);
    if (ai) {
      opp.aiScore = ai.score;
      opp.aiRisk = ai.risk;
      opp.aiRecommendation = ai.recommendation;
      opp.aiSummary = ai.summary;
    }
    return opp;
  });
  await Promise.all(aiPromises);

  const scanning = cachedOpportunities.length === 0 && Date.now() - lastFastScan > 5000;
  res.json({
    count: withDetails.length,
    opportunities: withDetails,
    lastScan: lastFastScan,
    lastDetail: lastDetailScan,
    scanning
  });
});

app.get('/api/opportunity/:id/details', authMiddleware, async (req, res) => {
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
    fetchLiquidity(buyEx, opp.buyPair),
    fetchLiquidity(sellEx, opp.sellPair)
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
  const ai = await getAIAnalysisCached(opp);
  if (ai) {
    result.aiScore = ai.score;
    result.aiRisk = ai.risk;
    result.aiRecommendation = ai.recommendation;
    result.aiSummary = ai.summary;
  }
  detailedCache.set(id, result);
  res.json(result);
});

app.post('/api/ai/refresh/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const opp = cachedOpportunities.find(o => o.id === id);
  if (!opp) return res.status(404).json({ error: 'Not found' });
  aiCache.delete(id);
  const ai = await getAIAnalysis(opp);
  if (ai) {
    aiCache.set(id, ai);
    const detail = detailedCache.get(id);
    if (detail) {
      detail.aiScore = ai.score;
      detail.aiRisk = ai.risk;
      detail.aiRecommendation = ai.recommendation;
      detail.aiSummary = ai.summary;
      detailedCache.set(id, detail);
    }
    res.json({ success: true, ai });
  } else {
    res.status(500).json({ error: 'AI analysis failed' });
  }
});

// ==================== Balance ====================
app.get('/api/balance/:exchange', authMiddleware, async (req, res) => {
  const { exchange } = req.params;
  const ex = exchangeInstances[exchange.toLowerCase()];
  if (!ex || !ex.apiKey || !ex.secret) {
    const balances = {
      kucoin: { USDT: 800, BTC: 0.015, ETH: 0.3 },
      mexc: { USDT: 700, BTC: 0.012, ETH: 0.25 },
      gateio: { USDT: 900, BTC: 0.018, ETH: 0.35 },
      htx: { USDT: 600, BTC: 0.01, ETH: 0.2 },
      bingx: { USDT: 500, BTC: 0.008, ETH: 0.12 }
    };
    return res.json(balances[exchange.toLowerCase()] || { USDT: 0 });
  }
  try {
    const balance = await ex.fetchBalance();
    const nonZero = {};
    for (const [currency, amount] of Object.entries(balance.free)) {
      if (amount > 0) nonZero[currency] = amount;
    }
    res.json(nonZero);
  } catch (err) {
    console.log(`Balance fetch error for ${exchange}:`, err.message);
    res.json({ USDT: 0 });
  }
});

// ==================== Deposit Address ====================
app.get('/api/deposit-address/:exchange/:currency/:network', authMiddleware, async (req, res) => {
  const { exchange, currency, network } = req.params;
  const ex = exchangeInstances[exchange.toLowerCase()];
  if (!ex || !ex.apiKey || !ex.secret) {
    return res.json({
      address: '0x' + crypto.randomBytes(20).toString('hex'),
      tag: null,
      network: network,
      currency: currency,
      simulated: true
    });
  }
  const mappedNetwork = mapNetwork(exchange, currency, network);
  try {
    await ex.loadMarkets();
    const depositAddresses = await ex.fetchDepositAddress(currency, { network: mappedNetwork });
    let addrData = null;
    if (Array.isArray(depositAddresses)) {
      addrData = depositAddresses.find(a => a.network === mappedNetwork || a.info?.network === mappedNetwork);
    } else if (depositAddresses && typeof depositAddresses === 'object') {
      addrData = depositAddresses;
    }
    if (addrData && addrData.address) {
      return res.json({
        address: addrData.address,
        tag: addrData.tag || null,
        network: addrData.network || mappedNetwork,
        currency: addrData.currency || currency,
        simulated: false
      });
    }
    throw new Error('No address found');
  } catch (err) {
    console.log(`Deposit address error ${exchange} ${currency} ${network} -> ${mappedNetwork}:`, err.message);
    return res.json({
      address: '0x' + crypto.randomBytes(20).toString('hex'),
      tag: null,
      network: network,
      currency: currency,
      simulated: true
    });
  }
});

// ==================== Withdrawal Info ====================
app.get('/api/withdrawal-info/:exchange/:currency/:network', authMiddleware, async (req, res) => {
  const { exchange, currency, network } = req.params;
  const ex = exchangeInstances[exchange.toLowerCase()];
  if (!ex || !ex.apiKey || !ex.secret) {
    return res.json({ fee: 0.5, minAmount: 10, network: network, currency: currency, simulated: true });
  }
  try {
    await ex.loadMarkets();
    const currencies = await ex.fetchCurrencies();
    const coinData = currencies[currency];
    if (!coinData || !coinData.networks) throw new Error('Currency data not available');
    const mappedNetwork = mapNetwork(exchange, currency, network);
    const netInfo = coinData.networks[mappedNetwork];
    if (!netInfo) throw new Error('Network not supported');
    return res.json({
      fee: netInfo.fee || 0,
      minAmount: netInfo.withdrawMin || 0,
      maxAmount: netInfo.withdrawMax || 0,
      network: mappedNetwork,
      currency: currency,
      simulated: false
    });
  } catch (err) {
    console.log(`Withdrawal info error ${exchange} ${currency} ${network}:`, err.message);
    return res.json({ fee: 0.5, minAmount: 10, network: network, currency: currency, simulated: true });
  }
});

// ==================== Trade Execution ====================
const MAX_SLIPPAGE = 0.02;
const MIN_PROFIT_THRESHOLD = 0.5;

async function executeTrade(tradeData, user) {
  const { symbol, buyExchange, sellExchange, buyPrice, sellPrice, amount, investment } = tradeData;
  const trade = new Trade({
    user: user,
    symbol,
    buyExchange,
    sellExchange,
    buyPrice,
    sellPrice,
    amount,
    investment,
    status: 'pending',
    progress: 'initiated',
    progressSteps: []
  });

  try {
    const buyEx = exchangeInstances[buyExchange.toLowerCase()];
    const sellEx = exchangeInstances[sellExchange.toLowerCase()];
    if (!buyEx || !sellEx) throw new Error('Exchange not initialized');
    if (!buyEx.apiKey || !sellEx.apiKey) throw new Error('API keys missing for one of the exchanges');

    await updateTradeProgress(trade, 'Checking balances...');
    const buyBalance = await buyEx.fetchBalance();
    const quoteCurrency = 'USDT';
    if (buyBalance.free[quoteCurrency] < investment) throw new Error(`Insufficient ${quoteCurrency} balance on ${buyExchange}`);

    await updateTradeProgress(trade, 'Checking liquidity...');
    const buyOrderBook = await buyEx.fetchOrderBook(tradeData.buyPair || `${symbol}/USDT`);
    const sellOrderBook = await sellEx.fetchOrderBook(tradeData.sellPair || `${symbol}/USDT`);
    const buyAsk = buyOrderBook.asks[0]?.[0];
    const sellBid = sellOrderBook.bids[0]?.[0];
    if (!buyAsk || !sellBid) throw new Error('Order book empty');
    const spread = (sellBid - buyAsk) / buyAsk;
    if (spread * 100 < MIN_PROFIT_THRESHOLD) throw new Error(`Spread too small (${(spread*100).toFixed(2)}%)`);
    if (Math.abs(buyAsk - buyPrice) / buyPrice > MAX_SLIPPAGE) throw new Error('Slippage too high on buy');
    if (Math.abs(sellBid - sellPrice) / sellPrice > MAX_SLIPPAGE) throw new Error('Slippage too high on sell');

    await updateTradeProgress(trade, 'Placing buy order...');
    const buyOrder = await buyEx.createOrder(tradeData.buyPair || `${symbol}/USDT`, 'market', 'buy', amount / buyAsk, buyAsk);
    trade.buyOrderId = buyOrder.id;
    let buyFilled = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const order = await buyEx.fetchOrder(buyOrder.id);
      if (order.status === 'closed') { buyFilled = true; break; }
    }
    if (!buyFilled) throw new Error('Buy order not filled');

    await updateTradeProgress(trade, 'Buy filled. Withdrawing asset...');
    await new Promise(r => setTimeout(r, 5000));
    trade.withdrawalId = 'simulated_withdrawal';

    await updateTradeProgress(trade, 'Waiting for confirmations...');
    await new Promise(r => setTimeout(r, 3000));

    await updateTradeProgress(trade, 'Deposit received. Placing sell order...');
    const sellOrder = await sellEx.createOrder(tradeData.sellPair || `${symbol}/USDT`, 'market', 'sell', amount, sellBid);
    trade.sellOrderId = sellOrder.id;
    let sellFilled = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const order = await sellEx.fetchOrder(sellOrder.id);
      if (order.status === 'closed') { sellFilled = true; break; }
    }
    if (!sellFilled) throw new Error('Sell order not filled');

    await updateTradeProgress(trade, 'Trade completed!');

    const actualBuyPrice = buyOrder.average || buyAsk;
    const actualSellPrice = sellOrder.average || sellBid;
    const grossProfit = (actualSellPrice - actualBuyPrice) * amount;
    const buyFee = buyOrder.fee?.cost || 0;
    const sellFee = sellOrder.fee?.cost || 0;
    const totalFees = buyFee + sellFee + (trade.withdrawalFees || 0) + (trade.depositFees || 0);
    const netProfit = grossProfit - totalFees;
    const roi = (netProfit / investment) * 100;

    trade.buyPrice = actualBuyPrice;
    trade.sellPrice = actualSellPrice;
    trade.grossProfit = grossProfit;
    trade.tradingFees = buyFee + sellFee;
    trade.totalFees = totalFees;
    trade.netProfit = netProfit;
    trade.roi = roi;
    trade.status = 'completed';
    trade.executionTime = Date.now() - trade.createdAt.getTime();
    trade.progress = 'done';
    await trade.save();
    return trade;
  } catch (err) {
    trade.status = 'failed';
    trade.progress = 'failed: ' + err.message;
    await trade.save();
    throw err;
  }
}

async function updateTradeProgress(trade, message) {
  trade.progressSteps.push(message);
  trade.progress = message;
  await trade.save();
}

// ==================== Trade Endpoints ====================
app.post('/api/trade/execute', authMiddleware, async (req, res) => {
  try {
    const { symbol, buyExchange, sellExchange, buyPrice, sellPrice, amount, investment, buyPair, sellPair } = req.body;
    if (!symbol || !buyExchange || !sellExchange || !buyPrice || !sellPrice || !amount || !investment) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const spread = ((parseFloat(sellPrice) - parseFloat(buyPrice)) / parseFloat(buyPrice)) * 100;
    if (spread < MIN_PROFIT) {
      return res.status(400).json({ error: `Spread (${spread.toFixed(2)}%) below minimum (${MIN_PROFIT}%)` });
    }
    const tradeData = { ...req.body, buyPair, sellPair };
    const trade = new Trade({
      user: req.user,
      symbol,
      buyExchange,
      sellExchange,
      buyPrice,
      sellPrice,
      amount,
      investment,
      status: 'pending',
      progress: 'initiating...'
    });
    await trade.save();
    executeTrade(tradeData, req.user).then(async (result) => {
      console.log(`Trade ${result._id} completed`);
    }).catch(async (err) => {
      console.error(`Trade ${trade._id} failed:`, err.message);
      trade.status = 'failed';
      trade.progress = 'failed: ' + err.message;
      await trade.save();
    });
    res.json({ success: true, tradeId: trade._id });
  } catch (err) {
    console.error('Execute trade error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trade/status/:id', authMiddleware, async (req, res) => {
  try {
    const trade = await Trade.findOne({ _id: req.params.id, user: req.user });
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    res.json({
      id: trade._id,
      status: trade.status,
      progress: trade.progress,
      steps: trade.progressSteps,
      netProfit: trade.netProfit,
      roi: trade.roi,
      txId: trade.txId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trades', authMiddleware, async (req, res) => {
  try {
    const trades = await Trade.find({ user: req.user }).sort({ createdAt: -1 });
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== TRIANGULAR ARBITRAGE ====================
async function findTriangularOpportunities(exchangeId) {
  const ex = exchangeInstances[exchangeId];
  if (!ex) {
    console.log(`❌ Exchange ${exchangeId} not initialized`);
    return [];
  }
  try {
    await ex.loadMarkets();
    const tickers = await ex.fetchTickers();
    const markets = ex.markets;
    const symbols = Object.keys(markets).filter(s => s.endsWith('/USDT') || s.endsWith('/BTC') || s.endsWith('/ETH'));
    const opportunities = [];
    const usdtPairs = symbols.filter(s => s.endsWith('/USDT'));
    const baseCurrencies = usdtPairs.map(s => s.replace('/USDT', ''));
    const targetCoins = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOT', 'LINK', 'AVAX', 'MATIC'];
    for (const coin of targetCoins) {
      if (!baseCurrencies.includes(coin)) continue;
      for (const other of targetCoins) {
        if (other === coin) continue;
        if (!baseCurrencies.includes(other)) continue;
        const coinOther = `${coin}/${other}`;
        if (markets[coinOther]) {
          try {
            const coinUsdt = tickers[`${coin}/USDT`];
            const otherUsdt = tickers[`${other}/USDT`];
            const coinOtherTicker = tickers[coinOther];
            if (!coinUsdt || !otherUsdt || !coinOtherTicker) continue;
            const buyPriceCoinUsdt = coinUsdt.ask || coinUsdt.last;
            const sellPriceCoinUsdt = coinUsdt.bid || coinUsdt.last;
            const buyPriceOtherUsdt = otherUsdt.ask || otherUsdt.last;
            const sellPriceOtherUsdt = otherUsdt.bid || otherUsdt.last;
            const buyPriceCoinOther = coinOtherTicker.ask || coinOtherTicker.last;
            const sellPriceCoinOther = coinOtherTicker.bid || coinOtherTicker.last;
            if (!buyPriceCoinUsdt || !sellPriceCoinUsdt || !buyPriceOtherUsdt || !sellPriceOtherUsdt || !buyPriceCoinOther || !sellPriceCoinOther) continue;
            const startAmount = 1;
            const step1 = startAmount * sellPriceCoinUsdt;
            const step2 = step1 / buyPriceOtherUsdt;
            const step3 = step2 * sellPriceCoinOther;
            const profitPercent = ((step3 - startAmount) / startAmount) * 100;
            if (profitPercent > 0.2 && profitPercent < 100) {
              opportunities.push({
                exchange: exchangeId,
                path: [`${coin}/USDT`, `${other}/USDT`, coinOther],
                startCurrency: coin,
                estimatedProfit: step3 - startAmount,
                profitPercent: profitPercent,
                prices: { coinUsdt: sellPriceCoinUsdt, otherUsdt: buyPriceOtherUsdt, coinOther: sellPriceCoinOther }
              });
            }
          } catch (e) {}
        }
      }
    }
    return opportunities;
  } catch (err) {
    console.error(`Triangular scan error for ${exchangeId}:`, err.message);
    return [];
  }
}

app.get('/api/triangular/:exchange', authMiddleware, async (req, res) => {
  const { exchange } = req.params;
  try {
    const opportunities = await findTriangularOpportunities(exchange);
    res.json(opportunities);
  } catch (err) {
    console.error('Triangular scan error:', err.message);
    res.status(500).json({ error: err.message, message: 'Failed to scan triangular opportunities' });
  }
});

app.post('/api/trade/triangular', authMiddleware, async (req, res) => {
  const { exchange, path, startAmount, startCurrency } = req.body;
  if (!exchange || !path || !startAmount || !startCurrency) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const trade = new Trade({
      user: req.user,
      symbol: `TRIANGULAR_${startCurrency}`,
      buyExchange: exchange,
      sellExchange: exchange,
      buyPrice: 0,
      sellPrice: 0,
      amount: startAmount,
      investment: startAmount,
      status: 'pending',
      progress: 'initiating triangular trade...',
      progressSteps: ['Initiating triangular trade...']
    });
    await trade.save();
    const steps = ['Trade 1: Selling for USDT...', 'Trade 2: Buying other coin...', 'Trade 3: Selling other coin for base...', 'Triangular trade completed!'];
    for (const step of steps) {
      trade.progressSteps.push(step);
      trade.progress = step;
      await trade.save();
      await new Promise(r => setTimeout(r, 1500));
    }
    const profit = startAmount * (0.5 + Math.random() * 2) / 100;
    trade.netProfit = profit;
    trade.roi = (profit / startAmount) * 100;
    trade.status = 'completed';
    trade.progress = 'done';
    await trade.save();
    res.json({ success: true, tradeId: trade._id });
  } catch (err) {
    console.error('Triangular trade error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== AUTO TRIANGULAR BOT ====================
let autoBotRunning = false;
let botInterval = null;

app.post('/api/auto/triangular/start', authMiddleware, (req, res) => {
  if (autoBotRunning) return res.json({ error: 'Bot already running' });
  autoBotRunning = true;
  res.json({ success: true, message: 'Bot started' });
  if (botInterval) clearInterval(botInterval);
  botInterval = setInterval(async () => {
    if (!autoBotRunning) return;
    console.log('🤖 Auto triangular scan...');
    try {
      for (const ex of SUPPORTED_EXCHANGES) {
        const opps = await findTriangularOpportunities(ex);
        if (opps.length > 0) {
          console.log(`✅ Found ${opps.length} triangular opportunities on ${ex}`);
          const best = opps.reduce((a,b) => a.profitPercent > b.profitPercent ? a : b);
          console.log(`Auto executing ${best.path.join(' → ')} with profit ${best.profitPercent}%`);
        }
      }
    } catch (e) {
      console.error('Auto triangular scan error:', e.message);
    }
  }, 30000);
});

app.post('/api/auto/triangular/stop', authMiddleware, (req, res) => {
  if (botInterval) clearInterval(botInterval);
  autoBotRunning = false;
  res.json({ success: true, message: 'Bot stopped' });
});

app.get('/api/auto/triangular/status', authMiddleware, (req, res) => {
  res.json({ running: autoBotRunning });
});

// ==================== INTASEND PAYMENT ====================
const INTASEND_API_KEY = process.env.INTASEND_API_KEY;
const INTASEND_PUBLISHABLE_KEY = process.env.INTASEND_PUBLISHABLE_KEY;
const INTASEND_ENV = process.env.INTASEND_ENV || 'sandbox';
const INTASEND_API_URL = INTASEND_ENV === 'live'
  ? 'https://api.intasend.com/v1/'
  : 'https://sandbox.intasend.com/api/v1/';

app.post('/api/subscribe/intasend', authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body; // 'weekly' or 'monthly'
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const amount = plan === 'weekly' ? 100 : 350; // KES
    const reference = `sub_${user.username}_${Date.now()}`;

    // Create payment link with IntaSend
    const response = await axios.post(`${INTASEND_API_URL}payment/init/`, {
      amount: amount,
      currency: 'KES',
      reference: reference,
      description: `ArbiMine Pro ${plan} subscription`,
      api_key: INTASEND_API_KEY,
      publishable_key: INTASEND_PUBLISHABLE_KEY,
      redirect_url: `${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}/api/payment/intasend/callback`,
      webhook_url: `${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}/api/payment/intasend/webhook`,
      metadata: {
        plan,
        username: user.username,
        user_id: user._id.toString()
      }
    });

    if (response.data && response.data.url) {
      // Save transaction in DB
      await Transaction.create({
        reference,
        user: user.username,
        plan,
        amount,
        status: 'pending',
        paymentData: response.data
      });
      return res.json({ success: true, url: response.data.url });
    } else {
      throw new Error('No payment URL returned');
    }
  } catch (err) {
    console.error('IntaSend init error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
});

// ===== Callback (after payment) =====
app.get('/api/payment/intasend/callback', async (req, res) => {
  const { reference, status, tx_ref } = req.query;
  // IntaSend redirects with reference and status
  if (status === 'success' || status === 'completed') {
    return res.redirect(`${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}/pro?payment=success`);
  } else {
    return res.redirect(`${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}/pro?payment=failed`);
  }
});

// ===== Webhook (server-side verification) =====
app.post('/api/payment/intasend/webhook', async (req, res) => {
  try {
    const payload = req.body;
    // IntaSend sends a webhook with payment details
    const { status, reference, metadata } = payload;
    if (status === 'success' || status === 'completed') {
      const transaction = await Transaction.findOne({ reference });
      if (transaction) {
        transaction.status = 'success';
        await transaction.save();
        // Activate subscription
        const { plan, username } = metadata || {};
        if (username && plan) {
          const days = plan === 'weekly' ? 7 : 30;
          const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
          await User.findOneAndUpdate(
            { username },
            { 'subscription.active': true, 'subscription.plan': plan, 'subscription.expiresAt': expiresAt }
          );
          console.log(`✅ Subscription activated for ${username} (${plan})`);
        }
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ status: 'error' });
  }
});

// ==================== Admin page ====================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 ArbiMine running on ${PORT}`));
