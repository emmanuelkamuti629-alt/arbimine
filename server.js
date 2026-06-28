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

// ==================== MongoDB ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Email (optional) ====================
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
const Transaction = mongoose.model('Transaction', transactionSchema);
const Message = mongoose.model('Message', messageSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);
const Trade = mongoose.model('Trade', tradeSchema);

const hashPassword = p => crypto.createHash('sha256').update(p).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');

// ==================== Admin Auth ====================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const adminTokens = new Set();

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

// ==================== Exchange Integration (6 Exchanges) ====================
const SUPPORTED_EXCHANGES = ['binance', 'kucoin', 'mexc', 'gateio', 'htx', 'bingx'];

// Instantiate exchanges with API keys from environment
const exchangeInstances = {};

// Binance
if (process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET) {
  exchangeInstances.binance = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
    enableRateLimit: true,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  console.log('✅ Binance API configured');
} else {
  console.log('⚠️ Binance API keys missing – using public endpoints only');
  exchangeInstances.binance = new ccxt.binance({ enableRateLimit: true });
}

// KuCoin (with password)
if (process.env.KUCOIN_API_KEY && process.env.KUCOIN_SECRET && process.env.KUCOIN_PASSWORD) {
  exchangeInstances.kucoin = new ccxt.kucoin({
    apiKey: process.env.KUCOIN_API_KEY,
    secret: process.env.KUCOIN_SECRET,
    password: process.env.KUCOIN_PASSWORD,
    enableRateLimit: true,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  console.log('✅ KuCoin API configured');
} else {
  console.log('⚠️ KuCoin API keys missing – using public endpoints only');
  exchangeInstances.kucoin = new ccxt.kucoin({ enableRateLimit: true });
}

// MEXC
if (process.env.MEXC_API_KEY && process.env.MEXC_SECRET) {
  exchangeInstances.mexc = new ccxt.mexc({
    apiKey: process.env.MEXC_API_KEY,
    secret: process.env.MEXC_SECRET,
    enableRateLimit: true,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  console.log('✅ MEXC API configured');
} else {
  console.log('⚠️ MEXC API keys missing – using public endpoints only');
  exchangeInstances.mexc = new ccxt.mexc({ enableRateLimit: true });
}

// Gate.io
if (process.env.GATEIO_API_KEY && process.env.GATEIO_SECRET) {
  exchangeInstances.gateio = new ccxt.gateio({
    apiKey: process.env.GATEIO_API_KEY,
    secret: process.env.GATEIO_SECRET,
    enableRateLimit: true,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  console.log('✅ Gate.io API configured');
} else {
  console.log('⚠️ Gate.io API keys missing – using public endpoints only');
  exchangeInstances.gateio = new ccxt.gateio({ enableRateLimit: true });
}

// HTX (Huobi)
if (process.env.HTX_API_KEY && process.env.HTX_SECRET) {
  exchangeInstances.htx = new ccxt.huobi({
    apiKey: process.env.HTX_API_KEY,
    secret: process.env.HTX_SECRET,
    enableRateLimit: true,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  console.log('✅ HTX API configured');
} else {
  console.log('⚠️ HTX API keys missing – using public endpoints only');
  exchangeInstances.htx = new ccxt.huobi({ enableRateLimit: true });
}

// BingX
if (process.env.BINGX_API_KEY && process.env.BINGX_SECRET) {
  exchangeInstances.bingx = new ccxt.bingx({
    apiKey: process.env.BINGX_API_KEY,
    secret: process.env.BINGX_SECRET,
    enableRateLimit: true,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  console.log('✅ BingX API configured');
} else {
  console.log('⚠️ BingX API keys missing – using public endpoints only');
  exchangeInstances.bingx = new ccxt.bingx({ enableRateLimit: true });
}

// ===== Network Name Mapping =====
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
    'binance': {
      'USDT': { 'TRC20': 'TRC20', 'ERC20': 'ERC20', 'BEP20': 'BEP20', 'SOL': 'SOL' },
      'BTC': { 'BTC': 'BTC', 'BEP20': 'BEP20' },
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

// Public ticker endpoints (only for the 6 exchanges)
const EXCHANGES = {
  binance: 'https://api.binance.com/api/v3/ticker/24hr',
  kucoin: 'https://api.kucoin.com/api/v1/market/allTickers',
  mexc: 'https://api.mexc.com/api/v3/ticker/24hr',
  gateio: 'https://api.gateio.ws/api/v4/spot/tickers',
  htx: 'https://api.huobi.pro/market/tickers',
  bingx: 'https://api.bingx.com/api/v1/market/ticker/24hr'
};

// Symbol blacklist
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
    console.log(`${name} FAILED:`, e.message);
    return null;
  }
}

const MIN_PROFIT = 0.2;
const MAX_PROFIT = 100;

function extractSymbol(exchange, symbol, t) {
  let sym = null, price = null, volume = null;
  try {
    if (exchange === 'binance' && symbol.endsWith('USDT')) {
      sym = symbol.replace('USDT', '');
      price = +t.lastPrice;
      volume = +t.quoteVolume;
    } else if (exchange === 'kucoin' && symbol.includes('-USDT')) {
      sym = symbol.replace('-USDT', '');
      price = +t.last;
      volume = +t.volValue;
    } else if (exchange === 'mexc' && symbol.endsWith('USDT')) {
      sym = symbol.replace('USDT', '');
      price = +t.lastPrice;
      volume = +t.quoteVolume;
    } else if (exchange === 'gateio' && symbol.includes('_USDT')) {
      sym = symbol.replace('_USDT', '');
      price = +t.last;
      volume = +t.quote_volume;
    } else if (exchange === 'htx' && symbol.endsWith('usdt')) {
      sym = symbol.replace('usdt', '').toUpperCase();
      price = +t.close;
      volume = +t.vol;
    } else if (exchange === 'bingx' && symbol.includes('-USDT')) {
      sym = symbol.split('-USDT')[0];
      price = +t.lastPrice;
      volume = +t.quoteVolume;
    }
    if (!sym || !price) return null;
    if (SYMBOL_BLACKLIST.has(sym)) return null;
    return { symbol: sym, price, volume: volume || 0 };
  } catch { return null; }
}

let cachedOpportunities = [];
let detailedCache = new Map();
let lastFastScan = 0;
let lastDetailScan = 0;
const FAST_SCAN_INTERVAL = 60000;
const DETAIL_SCAN_INTERVAL = 120000;
const DETAIL_OPP_LIMIT = 200;

async function fetchRealNetworks(exchangeId, coin) {
  const key = exchangeId.toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(key)) return null;
  const ex = exchangeInstances[key];
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
  const ex = exchangeInstances[key];
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

async function fastScan() {
  console.log('🔄 Fast scan (prices)...');
  const start = Date.now();
  try {
    const results = await Promise.all(Object.entries(EXCHANGES).map(([n, u]) => safeGet(u, n)));
    const allData = {};
    Object.keys(EXCHANGES).forEach(e => (allData[e] = {}));
    results.forEach((data, idx) => {
      const ex = Object.keys(EXCHANGES)[idx];
      if (!data) return;
      let tickers = [];
      if (ex === 'binance') tickers = data;
      else if (ex === 'kucoin') tickers = data.data?.ticker || [];
      else if (ex === 'mexc') tickers = data;
      else if (ex === 'gateio') tickers = data;
      else if (ex === 'htx') tickers = data.data || [];
      else if (ex === 'bingx') tickers = data.data || [];
      for (const t of tickers) {
        const symKey = t.symbol || t.currency_pair || t.instId || t.market || t.i || '';
        const d = extractSymbol(ex, symKey, t);
        if (!d) continue;
        allData[ex][d.symbol] = { price: d.price, volume: d.volume };
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
        liquidity: liquidity.toFixed(0)
      });
    }
    cachedOpportunities = opportunities.sort((a,b) => +b.spread - +a.spread);
    lastFastScan = Date.now();
    console.log(`✅ Fast scan: ${cachedOpportunities.length} opportunities in ${Date.now() - start}ms`);
  } catch (err) {
    console.error('Fast scan failed:', err);
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
        const buyMarket = buyEx.market(o.symbol);
        const sellMarket = sellEx.market(o.symbol);
        return buyMarket && sellMarket;
      } catch {
        return false;
      }
    })
    .slice(0, DETAIL_OPP_LIMIT);

  let updated = 0;
  for (const opp of validOpps) {
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
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.log(`Detail scan failed for ${opp.id}:`, err.message);
    }
  }
  lastDetailScan = Date.now();
  console.log(`✅ Detail scan: updated ${updated} opportunities in ${Date.now() - start}ms`);
}

// Start scanning
fastScan();
setInterval(fastScan, FAST_SCAN_INTERVAL);
setInterval(() => { if (cachedOpportunities.length > 0) detailScan(); }, DETAIL_SCAN_INTERVAL);
setTimeout(() => { if (cachedOpportunities.length > 0) detailScan(); }, 30000);

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
    sendEmailAsync(email, 'Welcome to ArbiMine!', `<h2>Welcome ${username}!</h2><p>You can now start scanning.</p>`);
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
    sendEmailAsync(email, '🔐 New login', `<p>Login at ${new Date().toLocaleString()}</p>`);
    res.json({ success: true, token, username: user.username });
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

app.post('/admin/block/:username', adminAuth, async (req, res) => {
  await BlockedUser.findOneAndUpdate({ username: req.params.username }, { username: req.params.username }, { upsert: true });
  res.json({ success: true });
});

app.post('/admin/unblock/:username', adminAuth, async (req, res) => {
  await BlockedUser.deleteOne({ username: req.params.username });
  res.json({ success: true });
});

// ==================== Opportunities ====================
app.get('/api/opportunities', authMiddleware, (req, res) => {
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
app.get('/api/balance/:exchange', authMiddleware, async (req, res) => {
  const { exchange } = req.params;
  const ex = exchangeInstances[exchange.toLowerCase()];
  if (!ex || !ex.apiKey || !ex.secret) {
    // Fallback simulated balances
    const balances = {
      binance: { USDT: 1250, BTC: 0.02, ETH: 0.5 },
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
  console.log(`🔍 Fetching deposit address for ${exchange} ${currency} ${network} -> ${mappedNetwork}`);

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

// ==================== Execute Trade ====================
app.post('/api/trade/execute', authMiddleware, async (req, res) => {
  const { symbol, buyExchange, sellExchange, buyPrice, sellPrice, amount, investment } = req.body;
  if (!symbol || !buyExchange || !sellExchange || !buyPrice || !sellPrice || !amount || !investment) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Simulate trade execution (replace with real CCXT orders later)
  const tradeFeeRate = 0.001;
  const buyTradeFee = investment * tradeFeeRate;
  const sellTradeFee = (amount * sellPrice) * tradeFeeRate;
  const totalTradingFees = buyTradeFee + sellTradeFee;
  const withdrawalFeeUSD = 0.5;
  const depositFeeUSD = 0.2;
  const totalNetworkFees = withdrawalFeeUSD + depositFeeUSD;
  const slippage = investment * 0.002;
  const totalFees = totalTradingFees + totalNetworkFees + slippage;
  const grossProfit = (sellPrice - buyPrice) * amount;
  const netProfit = grossProfit - totalFees;
  const roi = (netProfit / investment) * 100;

  const trade = new Trade({
    user: req.user,
    symbol,
    buyExchange,
    sellExchange,
    buyPrice,
    sellPrice,
    amount,
    investment,
    grossProfit,
    tradingFees: totalTradingFees,
    withdrawalFees: withdrawalFeeUSD,
    depositFees: depositFeeUSD,
    totalFees,
    netProfit,
    roi,
    status: 'completed',
    txId: '0x' + crypto.randomBytes(16).toString('hex')
  });
  await trade.save();

  res.json({
    success: true,
    trade: {
      id: trade._id,
      txId: trade.txId,
      netProfit,
      roi,
      status: trade.status,
      createdAt: trade.createdAt
    }
  });
});

// ==================== Trade History ====================
app.get('/api/trades', authMiddleware, async (req, res) => {
  const trades = await Trade.find({ user: req.user }).sort({ createdAt: -1 });
  res.json(trades);
});

// ==================== Payment (Paystack) – keep your existing routes ====================
// ... (your payment routes go here – they should use authMiddleware as well) ...

// ==================== Admin page ====================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 ArbiMine running on ${PORT}`));
