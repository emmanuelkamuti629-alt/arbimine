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

// ==================== Middleware ====================
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Global Error Handlers ====================
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled Rejection:', reason));

// ==================== Health Check ====================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
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
const SUPPORTED_EXCHANGES = ['mexc', 'kucoin', 'binance', 'bingx', 'htx', 'gateio'];

function buildExchange(exchangeId, apiKey, secret) {
  const exchangeMap = {
    binance: ccxt.binance, kucoin: ccxt.kucoin, htx: ccxt.huobi, gateio: ccxt.gateio,
    mexc: ccxt.mexc, bingx: ccxt.bingx
  };
  const ExchangeClass = exchangeMap[exchangeId];
  if (!ExchangeClass) return null;
  const config = { enableRateLimit: true };
  if (apiKey && secret) { config.apiKey = apiKey; config.secret = secret; }
  return new ExchangeClass(config);
}

const EXCHANGE_CREDENTIALS = {
  binance: { apiKey: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_SECRET },
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
}

async function safeGet(url, name) {
  try {
    const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return res.data;
  } catch (e) {
    console.log(`${name} FAILED:`, e.message);
    return null;
  }
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

const MIN_PROFIT = 0.2;
const MAX_PROFIT = 100;

function extractSymbol(exchange, symbol, t) {
  let sym = null, price = null, volume = null;
  try {
    if (exchange === 'mexc' && symbol.endsWith('USDT')) { sym = symbol.replace('USDT', ''); price = +t.lastPrice; volume = +t.quoteVolume; }
    else if (exchange === 'kucoin' && symbol.includes('-USDT')) { sym = symbol.replace('-USDT', ''); price = +t.last; volume = +t.volValue; }
    else if (exchange === 'bitmart' && symbol.includes('_USDT')) { sym = symbol.replace('_USDT', ''); price = +t.last_price; volume = +t.quote_volume; }
    else if (exchange === 'bitget') { sym = t.symbol?.replace('USDT', ''); price = +t.close; volume = +t.usdtVol; }
    else if (exchange === 'gateio' && symbol.includes('_USDT')) { sym = symbol.replace('_USDT', ''); price = +t.last; volume = +t.quote_volume; }
    else if (exchange === 'okx' && symbol.includes('-USDT')) { sym = symbol.replace('-USDT', ''); price = +t.last; volume = +t.volCcy24h; }
    else if (exchange === 'bybit') { sym = t.symbol?.replace('USDT', ''); price = +t.lastPrice; volume = +t.turnover24h; }
    else if (exchange === 'htx') { sym = symbol.replace('usdt', '').toUpperCase(); price = +t.close; volume = +t.vol; }
    else if (exchange === 'bitfinex' && Array.isArray(t) && t[0]?.startsWith('t')) { sym = t[0].replace('t', '').replace('USD', ''); price = +t[7]; volume = +t[8]; }
    else if (exchange === 'cryptocom') { const inst = t.i; if (inst?.includes('_USDT')) { sym = inst.replace('_USDT', ''); price = +t.a; volume = +t.v; } }
    else if (exchange === 'upbit' && t.market?.startsWith('KRW-')) { sym = t.market.replace('KRW-', ''); price = +t.trade_price; volume = +t.acc_trade_price_24h; }
    if (!sym || !price) return null;
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
  let ex = exchangeInstances[key];
  if (!ex) {
    const ExchangeClass = ccxt[key];
    if (!ExchangeClass) return null;
    ex = new ExchangeClass({ enableRateLimit: true });
  }
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
  if (!ex) {
    const ExchangeClass = ccxt[key];
    if (!ExchangeClass) return null;
    ex = new ExchangeClass({ enableRateLimit: true });
  }
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
        allData[ex][d.symbol] = { price: d.price, volume: d.volume };
      }
    });
    const symbols = new Set();
    Object.values(allData).forEach(ex => Object.keys(ex).forEach(s => symbols.add(s)));
    const opportunities = [];
    for (const symbol of symbols) {
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
  const topOps = cachedOpportunities.slice(0, DETAIL_OPP_LIMIT);
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
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.log(`Detail scan failed for ${opp.id}:`, err.message);
    }
  }
  lastDetailScan = Date.now();
  console.log(`✅ Detail scan: updated ${updated} opportunities in ${Date.now() - start}ms`);
}

fastScan();
setInterval(fastScan, FAST_SCAN_INTERVAL);
setInterval(() => { if (cachedOpportunities.length > 0) detailScan(); }, DETAIL_SCAN_INTERVAL);
setTimeout(() => { if (cachedOpportunities.length > 0) detailScan(); }, 30000);

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
    console.log(`📌 Callback URL: ${callbackUrl}`);

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

// ==================== CALLBACK ====================
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
  const rawBody = req.body;
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
