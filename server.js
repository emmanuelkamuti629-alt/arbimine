require("dotenv").config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

// ==================== EXCHANGE INTEGRATIONS ====================

const kucoin = new ccxt.kucoin({ enableRateLimit: true });

async function fetchKuCoinTickers() {
    try {
        const tickers = await kucoin.fetchTickers();
        return Object.keys(tickers).map(symbol => ({
            exchange: "kucoin",
            symbol,
            price: tickers[symbol].last,
            bid: tickers[symbol].bid,
            ask: tickers[symbol].ask,
            timestamp: tickers[symbol].timestamp
        }));
    } catch (err) {
        console.error("KuCoin error:", err.message);
        return [];
    }
}



const htx = new ccxt.huobi({ enableRateLimit: true });

async function fetchHTXTickers() {
    try {
        const tickers = await htx.fetchTickers();
        return Object.keys(tickers).map(symbol => ({
            exchange: "htx",
            symbol,
            price: tickers[symbol].last,
            bid: tickers[symbol].bid,
            ask: tickers[symbol].ask,
            timestamp: tickers[symbol].timestamp
        }));
    } catch (err) {
        console.error("HTX error:", err.message);
        return [];
    }
}



const gateio = new ccxt.gateio({ enableRateLimit: true });

async function fetchGateIOTickers() {
    try {
        const tickers = await gateio.fetchTickers();
        return Object.keys(tickers).map(symbol => ({
            exchange: "gateio",
            symbol,
            price: tickers[symbol].last,
            bid: tickers[symbol].bid,
            ask: tickers[symbol].ask,
            timestamp: tickers[symbol].timestamp
        }));
    } catch (err) {
        console.error("Gate.io error:", err.message);
        return [];
    }
}



const nodemailer = require('nodemailer');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const app = express();

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", apiLimiter);
const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Email ====================
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

// Removed duplicate User model declaration
const Session = mongoose.model('Session', sessionSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Message = mongoose.model('Message', messageSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);

const hashPassword = p => crypto.createHash('sha256').update(p).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');

function formatPhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.slice(1);
  else if (cleaned.startsWith('254')) {}
  else if (cleaned.startsWith('+254')) cleaned = cleaned.slice(1);
  else cleaned = '254' + cleaned;
  return cleaned;
}

// ==================== Exchange API ====================
const SUPPORTED_EXCHANGES = ['mexc', 'kucoin', 'htx', 'gateio', 'bingx'];

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
  const config = { enableRateLimit: true };
  if (apiKey && secret) { config.apiKey = apiKey; config.secret = secret; }
  if (exchangeId === "kucoin" && process.env.KUCOIN_PASSPHRASE) {
    config.password = process.env.KUCOIN_PASSPHRASE;
  }
  return new ExchangeClass(config);
}

const EXCHANGE_CREDENTIALS = {
  kucoin: { apiKey: process.env.KUCOIN_API_KEY, secret: process.env.KUCOIN_SECRET, password: process.env.KUCOIN_PASSPHRASE },
  htx: { apiKey: process.env.HTX_API_KEY, secret: process.env.HTX_SECRET },
  gateio: { apiKey: process.env.GATEIO_API_KEY, secret: process.env.GATEIO_SECRET },
  mexc: { apiKey: process.env.MEXC_API_KEY, secret: process.env.MEXC_SECRET },
  bingx: { apiKey: process.env.BINGX_API_KEY, secret: process.env.BINGX_SECRET }
};
const exchangeInstances = {};
for (const [id, cred] of Object.entries(EXCHANGE_CREDENTIALS)) {
  const ex = buildExchange(id, cred);
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
  gateio: 'https://api.gateio.ws/api/v4/spot/tickers',
  htx: 'https://api.huobi.pro/market/tickers',
  bingx: 'https://open-api.bingx.com/openApi/spot/v1/ticker/24hr'
};

const MIN_PROFIT = 0.2;
const MAX_PROFIT = 100;

function extractSymbol(exchange, symbol, t) {
  try {
    if (!symbol) return null;

    symbol = String(symbol).trim();

    let sym = null;
    let price = 0;
    let volume = 0;

    switch (exchange) {

      case "mexc":
        if (!symbol.endsWith("USDT")) return null;
        sym = symbol.replace(/USDT$/, "");
        price = Number(t.lastPrice || t.last || t.price);
        volume = Number(t.quoteVolume || t.volume || 0);
        break;

      case "kucoin":
        if (!symbol.endsWith("-USDT")) return null;
        sym = symbol.replace(/-USDT$/, "");
        price = Number(t.last || t.price);
        volume = Number(t.volValue || t.vol || 0);
        break;

      case "gateio":
        if (!symbol.endsWith("_USDT")) return null;
        sym = symbol.replace(/_USDT$/, "");
        price = Number(t.last || t.last_price);
        volume = Number(t.quote_volume || t.base_volume || 0);
        break;

      case "htx":
        if (!symbol.toLowerCase().endsWith("usdt")) return null;
        sym = symbol.slice(0, -4).toUpperCase();
        price = Number(t.close || t.lastPrice || t.price);
        volume = Number(t.vol || t.amount || 0);
        break;

      case "bingx":
        if (
          symbol.endsWith("-USDT") ||
          symbol.endsWith("_USDT") ||
          symbol.endsWith("USDT")
        ) {
          sym = symbol
            .replace("-USDT", "")
            .replace("_USDT", "")
            .replace("USDT", "");
        } else {
          return null;
        }

        price = Number(t.lastPrice || t.last || t.close || t.price);
        volume = Number(t.quoteVolume || t.volume || 0);
        break;

      default:
        return null;
    }

    sym = sym.trim().toUpperCase();

    if (!sym) return null;
    if (!Number.isFinite(price) || price <= 0) return null;

    return {
      symbol: sym,
      price,
      volume: Number.isFinite(volume) ? volume : 0
    };

  } catch (err) {
    return null;
  }
}

let cachedOpportunities = [];
let detailedCache = new Map();
let lastFastScan = 0;
let lastDetailScan = 0;
const FAST_SCAN_INTERVAL = 120000; // 2 minutes
const DETAIL_SCAN_INTERVAL = 120000;
const DETAIL_OPP_LIMIT = 200;

async function fetchRealNetworks(exchangeId, coin) {
  const key = exchangeId.toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(key)) return null;
  let ex = exchangeInstances[key];
  if (!ex) {
    const ExchangeClass = ccxt[key];
    if (!ExchangeClass) return null;
    ex = new ExchangeClass({
      enableRateLimit: true,
      apiKey: API_KEYS[key]?.apiKey,
      secret: API_KEYS[key]?.secret,
      password: API_KEYS[key]?.password
    });
  }
  try {
    await ex.loadMarkets();
    const currencies = await ex.fetchCurrencies();
    const coinData =
      currencies?.[coin] ||
      Object.values(currencies || {}).find(c =>
        c &&
        (
          c.code === coin ||
          c.id === coin ||
          c.symbol === coin
        )
      );

    if (!coinData) {
      console.log(`${exchangeId}: ${coin} not found`);
      return {
        networks: {},
        canWithdraw: false,
        canDeposit: false
      };
    }

    console.log(exchangeId, coin, coinData ? "FOUND" : "NOT FOUND");

    if (!coinData || !coinData.networks) {
      return {
        networks: {},
        canWithdraw: false,
        canDeposit: false
      };
    }
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
        // arrivalTime is not provided by exchanges, we map by network name
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
    ex = new ExchangeClass({
      enableRateLimit: true,
      apiKey: API_KEYS[key]?.apiKey,
      secret: API_KEYS[key]?.secret,
      password: API_KEYS[key]?.password
    });
  }
  try {
    const orderbook = await ex.fetchOrderBook(symbol, key === 'kucoin' ? 20 : 5);
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
      else if (ex === 'gateio') tickers = data;
      else if (ex === 'htx') tickers = data.data || [];
      else if (ex === 'bingx') tickers = data.data || [];
      for (const t of tickers) {
        const symKey = t.symbol || t.currency_pair || t.instId || t.market || t.i || '';
        const d = extractSymbol(ex, symKey, t);
        if (!d) continue;

        const s = d.symbol.toUpperCase();

        if (
          !allData[ex][s] ||
          d.volume > (allData[ex][s].volume || 0)
        ) {
          allData[ex][s] = {
            price: d.price,
            volume: d.volume
          };
        }
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

function getCommonNetworks(buyNetworks, sellNetworks) {
  if (!buyNetworks || !sellNetworks) return [];
  const common = [];
  for (const [netName, netInfo] of Object.entries(buyNetworks)) {
    if (sellNetworks[netName] && netInfo.withdraw === true && sellNetworks[netName].deposit === true) {
      common.push(netName);
    }
  }
  return common;
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
        fetchLiquidity(buyEx, `${opp.symbol}/USDT`),
        fetchLiquidity(sellEx, `${opp.symbol}/USDT`)
      ]);
      const tradable = computeTradable(buyNet?.networks, sellNet?.networks);
      const commonNetworks = getCommonNetworks(buyNet?.networks, sellNet?.networks);
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
        commonNetworks,
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

// ==================== Balance Route ====================
app.get('/api/balance/:exchange', async (req, res) => {
  const { exchange } = req.params;
  const key = exchange.toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(key)) {
    return res.status(400).json({ error: 'Unsupported exchange' });
  }
  let ex = exchangeInstances[key];
  if (!ex) {
    const ExchangeClass = ccxt[key];
    if (!ExchangeClass) return res.status(400).json({ error: 'Exchange not configured' });
    ex = new ExchangeClass({
      enableRateLimit: true,
      apiKey: API_KEYS[key]?.apiKey,
      secret: API_KEYS[key]?.secret,
      password: API_KEYS[key]?.password
    });
  }
  try {
    await ex.loadMarkets();
    const balance = await ex.fetchBalance();
    const usdt = balance.total.USDT || 0;
    res.json({ USDT: usdt, balance });
  } catch (err) {
    console.error(`Balance error for ${exchange}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch balance', message: err.message });
  }
});

// ==================== Deposit Address Route ====================
app.get('/api/deposit-address/:exchange/:coin/:network', async (req, res) => {
  const { exchange, coin, network } = req.params;
  const key = exchange.toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(key)) {
    return res.status(400).json({ error: 'Unsupported exchange' });
  }
  let ex = exchangeInstances[key];
  if (!ex) {
    const ExchangeClass = ccxt[key];
    if (!ExchangeClass) return res.status(400).json({ error: 'Exchange not configured' });
    ex = new ExchangeClass({
      enableRateLimit: true,
      apiKey: API_KEYS[key]?.apiKey,
      secret: API_KEYS[key]?.secret,
      password: API_KEYS[key]?.password
    });
  }
  try {
    await ex.loadMarkets();
    const depositAddress = await ex.fetchDepositAddress(coin, network);
    res.json({ address: depositAddress.address, tag: depositAddress.tag, network: depositAddress.network });
  } catch (err) {
    console.error(`Deposit address error for ${exchange} ${coin} ${network}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch deposit address', message: err.message });
  }
});

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

// ==================== Admin Messaging ====================
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

// ==================== Opportunities ====================
app.get('/api/opportunities', (req, res) => {
  const withDetails = cachedOpportunities.map(opp => {
    const detailed = detailedCache.get(opp.id);
    if (detailed) return detailed;
    return { ...opp, tradable: false, risk: 'medium', buyNetworks: {}, sellNetworks: {}, commonNetworks: [], buyWithdraw: false, sellDeposit: false };
  });
  withDetails.sort((a, b) => {
  const sa = a.qualityScore || 0;
  const sb = b.qualityScore || 0;
  if (sb !== sa) return sb - sa;

  const pa = parseFloat(a.spread) || 0;
  const pb = parseFloat(b.spread) || 0;
  if (pb !== pa) return pb - pa;

  const la = parseFloat(a.liquidity) || 0;
  const lb = parseFloat(b.liquidity) || 0;
  return lb - la;
});

res.json({
  count: withDetails.length,
  opportunities: withDetails,
  lastScan: lastFastScan
});
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
    fetchLiquidity(buyEx, `${opp.symbol}/USDT`),
    fetchLiquidity(sellEx, `${opp.symbol}/USDT`)
  ]);
  const tradable = computeTradable(buyNet?.networks, sellNet?.networks);
  const commonNetworks = getCommonNetworks(buyNet?.networks, sellNet?.networks);
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
    commonNetworks,
    buyWithdraw: buyNet?.canWithdraw || false,
    sellDeposit: sellNet?.canDeposit || false
  };
  
result.qualityScore = calculateOpportunityScore(result).score;
result.grade = calculateOpportunityScore(result).grade;
result.recommendation = calculateOpportunityScore(result).recommendation;
result.confidence = calculateOpportunityScore(result).confidence;


const networkNames = Object.keys(result.buyNetworks || {});
let estimatedCompletionTime = "Unknown";

if (networkNames.includes("TRC20")) estimatedCompletionTime = "2-5 min";
else if (networkNames.includes("BEP20")) estimatedCompletionTime = "3-8 min";
else if (networkNames.includes("POLYGON")) estimatedCompletionTime = "2-6 min";
else if (networkNames.includes("ARBITRUM")) estimatedCompletionTime = "2-5 min";
else if (networkNames.includes("OPTIMISM")) estimatedCompletionTime = "2-5 min";
else if (networkNames.includes("SOL")) estimatedCompletionTime = "1-3 min";
else if (networkNames.includes("BASE")) estimatedCompletionTime = "2-5 min";
else if (networkNames.includes("ERC20")) estimatedCompletionTime = "10-20 min";

result.estimatedCompletionTime = estimatedCompletionTime;


let bestNetwork = null;

if (result.commonNetworks && result.commonNetworks.length) {
    let lowestFee = Number.MAX_VALUE;

    for (const net of result.commonNetworks) {
        const info = result.buyNetworks?.[net];
        if (!info) continue;

        const fee = Number(info.fee || 0);

        if (fee < lowestFee) {
            lowestFee = fee;
            bestNetwork = {
                name: net,
                fee,
                feeUnit: info.feeUnit || "",
                arrivalTime: info.arrivalTime || "Unknown"
            };
        }
    }
}

result.bestNetwork = bestNetwork;


const exchangeScores = {
    binance: 100,
    kucoin: 94,
    gateio: 91,
    mexc: 89,
    htx: 87,
    bingx: 86
};

const buyReliability =
    exchangeScores[(result.buyExchange || "").toLowerCase()] || 75;

const sellReliability =
    exchangeScores[(result.sellExchange || "").toLowerCase()] || 75;

result.buyExchangeReliability = buyReliability;
result.sellExchangeReliability = sellReliability;
result.exchangeReliability = Math.round(
    (buyReliability + sellReliability) / 2
);


const investment = 100;

const buyPrice = parseFloat(result.buyPrice || 0);
const sellPrice = parseFloat(result.sellPrice || 0);

if (buyPrice > 0 && sellPrice > 0) {
    const coinAmount = investment / buyPrice;

    const grossProfit = (sellPrice - buyPrice) * coinAmount;

    const tradingFees = investment * 0.002;

    const withdrawFee =
        result.bestNetwork?.fee ||
        Object.values(result.buyNetworks || {})[0]?.fee ||
        0;

    const depositFee =
        Object.values(result.sellNetworks || {})[0]?.fee ||
        0;

    const slippage = investment * 0.002;

    const totalFees =
        tradingFees +
        withdrawFee +
        depositFee +
        slippage;

    result.estimatedGrossProfit = Number(grossProfit.toFixed(2));
    result.estimatedFees = Number(totalFees.toFixed(2));
    result.estimatedNetProfit = Number((grossProfit - totalFees).toFixed(2));
    result.estimatedROI = Number((((grossProfit - totalFees) / investment) * 100).toFixed(2));
}


const spread = parseFloat(result.spread || 0);

if (spread >= 10) {
    result.opportunityExpiresIn = "30-60 sec";
} else if (spread >= 5) {
    result.opportunityExpiresIn = "1-2 min";
} else if (spread >= 2) {
    result.opportunityExpiresIn = "2-5 min";
} else if (spread >= 1) {
    result.opportunityExpiresIn = "5-10 min";
} else {
    result.opportunityExpiresIn = "10+ min";
}

result.scanTimestamp = Date.now();


const liq = Number(result.liquidity || 0);
const spreadPct = Number(result.spread || 0);

let minimumCapital = 50;

if (liq >= 100000) minimumCapital = 1000;
else if (liq >= 50000) minimumCapital = 500;
else if (liq >= 20000) minimumCapital = 250;
else if (liq >= 10000) minimumCapital = 100;
else minimumCapital = 50;

if (spreadPct < 1) minimumCapital *= 2;

result.minimumRecommendedCapital = minimumCapital;
result.maximumRecommendedCapital = Math.max(
    minimumCapital,
    Math.round(liq * 0.05)
);


const liquidity = Number(result.liquidity || 0);

let slippageRisk = "HIGH";
let estimatedSlippagePercent = 1.0;

if (liquidity >= 100000) {
    slippageRisk = "LOW";
    estimatedSlippagePercent = 0.10;
} else if (liquidity >= 50000) {
    slippageRisk = "LOW";
    estimatedSlippagePercent = 0.20;
} else if (liquidity >= 20000) {
    slippageRisk = "MEDIUM";
    estimatedSlippagePercent = 0.40;
} else if (liquidity >= 10000) {
    slippageRisk = "MEDIUM";
    estimatedSlippagePercent = 0.60;
}

result.slippageRisk = slippageRisk;
result.estimatedSlippagePercent = estimatedSlippagePercent;


const spreadPercent = Number(result.spread || 0);

let marketVolatility = "LOW";
let volatilityScore = 20;

if (spreadPercent >= 10) {
    marketVolatility = "EXTREME";
    volatilityScore = 100;
} else if (spreadPercent >= 5) {
    marketVolatility = "HIGH";
    volatilityScore = 80;
} else if (spreadPercent >= 2) {
    marketVolatility = "MEDIUM";
    volatilityScore = 50;
}

result.marketVolatility = marketVolatility;
result.volatilityScore = volatilityScore;


const buyHealthy =
    result.buyWithdraw &&
    Object.keys(result.buyNetworks || {}).length > 0 &&
    Number(result.liquidity || 0) > 0;

const sellHealthy =
    result.sellDeposit &&
    Object.keys(result.sellNetworks || {}).length > 0 &&
    Number(result.sellLiquidity || 0) > 0;

result.buyExchangeHealth = buyHealthy ? "HEALTHY" : "LIMITED";
result.sellExchangeHealth = sellHealthy ? "HEALTHY" : "LIMITED";

result.exchangeHealth =
    buyHealthy && sellHealthy
        ? "GOOD"
        : (buyHealthy || sellHealthy)
            ? "PARTIAL"
            : "POOR";


let opportunitySafetyScore = 100;

if ((result.risk || "").toLowerCase() === "high")
    opportunitySafetyScore -= 30;
else if ((result.risk || "").toLowerCase() === "medium")
    opportunitySafetyScore -= 15;

if ((result.slippageRisk || "") === "HIGH")
    opportunitySafetyScore -= 20;
else if ((result.slippageRisk || "") === "MEDIUM")
    opportunitySafetyScore -= 10;

if ((result.exchangeHealth || "") === "PARTIAL")
    opportunitySafetyScore -= 10;
else if ((result.exchangeHealth || "") === "POOR")
    opportunitySafetyScore -= 25;

if (!result.tradable)
    opportunitySafetyScore -= 25;

opportunitySafetyScore = Math.max(0, Math.min(100, opportunitySafetyScore));

result.opportunitySafetyScore = opportunitySafetyScore;

if (opportunitySafetyScore >= 90)
    result.safetyRating = "EXCELLENT";
else if (opportunitySafetyScore >= 75)
    result.safetyRating = "GOOD";
else if (opportunitySafetyScore >= 60)
    result.safetyRating = "FAIR";
else
    result.safetyRating = "RISKY";

detailedCache.set(id, result);
  res.json(result);
});



// ==================== OPPORTUNITY SCORE ENGINE ====================
function calculateOpportunityScore(opp) {
  const spread = parseFloat(opp.spread) || 0;
  const buyLiq = parseFloat(opp.liquidity) || 0;
  const sellLiq = parseFloat(opp.sellLiquidity || opp.liquidity) || 0;
  const common = (opp.commonNetworks || []).length;

  let score = 0;

  // Spread (30)
  score += Math.min(spread * 6, 30);

  // Buy Liquidity (20)
  score += Math.min(buyLiq / 5000, 20);

  // Sell Liquidity (20)
  score += Math.min(sellLiq / 5000, 20);

  // Networks (10)
  score += Math.min(common * 2.5, 10);

  // Tradable (10)
  if (opp.tradable) score += 10;

  // Risk (10)
  switch ((opp.risk || "medium").toLowerCase()) {
    case "low":
      score += 10;
      break;
    case "medium":
      score += 6;
      break;
    default:
      score += 2;
  }

  score = Math.min(100, Math.round(score));

  let grade = "D";
  let recommendation = "AVOID";

  if (score >= 90) {
    grade = "A+";
    recommendation = "STRONG BUY";
  } else if (score >= 80) {
    grade = "A";
    recommendation = "BUY";
  } else if (score >= 70) {
    grade = "B";
    recommendation = "WATCH";
  } else if (score >= 60) {
    grade = "C";
    recommendation = "CAUTION";
  }

  return {
    score,
    grade,
    recommendation,
    confidence: score + "%"
  };
}




// ==================== OPPORTUNITY HISTORY ====================
const opportunityHistory = [];

function saveOpportunityHistory(opportunity) {
  opportunityHistory.unshift({
    ...opportunity,
    timestamp: new Date().toISOString()
  });

  if (opportunityHistory.length > 500) {
    opportunityHistory.pop();
  }
}

app.get("/api/history", (req, res) => {
  res.json(opportunityHistory);
});
// =============================================================




// ==================== EXPORT HISTORY CSV ====================
app.get("/api/history/export", (req, res) => {

  const rows = opportunityHistory.map(o => ({
    time: o.timestamp,
    symbol: o.symbol,
    exchangeBuy: o.buyExchange,
    exchangeSell: o.sellExchange,
    spread: o.spread,
    liquidity: o.liquidity,
    profit: o.profit,
    score: o.score,
    risk: o.risk
  }));

  if (!rows.length) {
    return res.send("No history available.");
  }

  const headers = Object.keys(rows[0]).join(",");
  const csv = [
    headers,
    ...rows.map(r => Object.values(r).join(","))
  ].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=opportunity-history.csv"
  );

  res.send(csv);

});
// ============================================================




// ==================== SCANNER STATISTICS ====================
const scannerStats = {
  startedAt: Date.now(),
  totalScans: 0,
  totalOpportunities: 0,
  totalScanTime: 0,
  lastScanTime: 0
};

function recordScan(scanTime, opportunitiesFound) {
  scannerStats.totalScans++;
  scannerStats.totalScanTime += scanTime;
  scannerStats.lastScanTime = scanTime;
  scannerStats.totalOpportunities += opportunitiesFound;
}

app.get("/api/stats", (req, res) => {

  const uptime = Math.floor((Date.now() - scannerStats.startedAt) / 1000);

  res.json({
    uptimeSeconds: uptime,
    totalScans: scannerStats.totalScans,
    totalOpportunities: scannerStats.totalOpportunities,
    averageScanTime:
      scannerStats.totalScans
        ? (
            scannerStats.totalScanTime /
            scannerStats.totalScans
          ).toFixed(2)
        : 0,
    lastScanTime: scannerStats.lastScanTime,
    scansPerMinute:
      uptime > 0
        ? (
            scannerStats.totalScans /
            (uptime / 60)
          ).toFixed(2)
        : 0
  });

});
// ============================================================




// ==================== SCANNER LOGGING ====================
const fs = require("fs");

function writeScannerLog(message) {
  const line =
    "[" + new Date().toISOString() + "] " +
    message + "\n";

  fs.appendFile(
    "scanner.log",
    line,
    err => {
      if (err) console.error(err);
    }
  );
}

app.get("/api/logs", (req, res) => {

  if (!fs.existsSync("scanner.log"))
    return res.send("");

  res.sendFile(
    require("path").join(
      __dirname,
      "scanner.log"
    )
  );

});
// =========================================================




// ==================== REGISTER USER ====================
app.post("/api/register", async (req, res) => {

  try {

    const {
      username,
      email,
      phone,
      password
    } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        success:false,
        message:"Missing required fields."
      });
    }

    const exists = await User.findOne({
      $or:[
        {email},
        {username}
      ]
    });

    if (exists) {
      return res.status(400).json({
        success:false,
        message:"User already exists."
      });
    }

    const hash = await bcrypt.hash(password,12);

    const user = await User.create({
      username,
      email,
      phone,
      password:hash
    });

    res.json({
      success:true,
      message:"Registration successful.",
      userId:user._id
    });

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"Registration failed."
    });

  }

});
// =======================================================




// ==================== LOGIN ====================
app.post("/api/login", async (req, res) => {

  try {

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success:false,
        message:"Email and password are required."
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({
        success:false,
        message:"Invalid credentials."
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.password
    );

    if (!valid) {
      return res.status(401).json({
        success:false,
        message:"Invalid credentials."
      });
    }

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role
      },
      process.env.JWT_SECRET || "arbimine-secret",
      {
        expiresIn: "7d"
      }
    );

    res.json({
      success:true,
      token,
      user:{
        id:user._id,
        username:user.username,
        email:user.email,
        role:user.role,
        subscription:user.subscription
      }
    });

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"Login failed."
    });

  }

});
// =================================================




// ==================== JWT AUTH MIDDLEWARE ====================
function authenticateToken(req, res, next) {

  const authHeader = req.headers.authorization;

  if (!authHeader)
    return res.status(401).json({
      success:false,
      message:"Missing authorization header."
    });

  const token = authHeader.split(" ")[1];

  if (!token)
    return res.status(401).json({
      success:false,
      message:"Missing token."
    });

  jwt.verify(
    token,
    process.env.JWT_SECRET || "arbimine-secret",
    (err, decoded) => {

      if (err)
        return res.status(403).json({
          success:false,
          message:"Invalid or expired token."
        });

      req.user = decoded;
      next();

    }
  );

}
// =============================================================




// ==================== ACTIVITY LOGS ====================
// Removed duplicate fs require

const activityLogs = [];

function logActivity(type, message, data = {}) {

  const log = {
    type,
    message,
    data,
    time: new Date().toISOString()
  };

  activityLogs.unshift(log);

  if (activityLogs.length > 1000) {
    activityLogs.pop();
  }

  fs.appendFileSync(
    "activity.log",
    JSON.stringify(log) + "\n"
  );

}

app.get("/api/logs", (req, res) => {
  res.json(activityLogs);
});
// ======================================================




// ==================== API SECURITY LAYER ====================

// Basic request validator (prevents empty / malformed inputs)
function validateRequest(fields = []) {

  return (req, res, next) => {

    try {

      for (let field of fields) {
        if (!req.body || req.body[field] === undefined || req.body[field] === null) {
          return res.status(400).json({
            success:false,
            message:`Missing field: ${field}`
          });
        }
      }

      next();

    } catch (err) {

      return res.status(500).json({
        success:false,
        message:"Request validation failed"
      });

    }

  };

}

// Prevent oversized payload abuse
app.use(express.json({ limit: "1mb" }));

// Basic global safety middleware
app.use((req, res, next) => {

  try {

    // Block extremely large query strings (basic abuse protection)
    if (JSON.stringify(req.query).length > 5000) {
      return res.status(413).json({
        success:false,
        message:"Query too large"
      });
    }

    next();

  } catch (err) {

    return res.status(500).json({
      success:false,
      message:"Request blocked by security layer"
    });

  }

});

// ===========================================================




// ==================== CORE EXCHANGE LAYER ====================

const exchanges = {
  binance: { name: "Binance" },
  kucoin:  { name: "KuCoin" },
  gateio:  { name: "Gate.io" },
  bingx:   { name: "BingX" },
  mexc:    { name: "MEXC" },
  htx:     { name: "HTX" }
};

// Standardized response format
function formatTicker(exchange, symbol, price, volume = 0) {
  return {
    exchange,
    symbol,
    price: parseFloat(price),
    volume: parseFloat(volume),
    time: Date.now()
  };
}

// Normalize symbols across exchanges (important for arbitrage matching)
function normalizeSymbol(symbol) {
  return symbol.replace(/[-_/]/g, "").toUpperCase();
}

// Unified error-safe fetch wrapper
async function safeFetch(fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    console.error("Exchange error:", err.message);
    return fallback;
  }
}

// =============================================================


// ==================== Payment ====================
function sanitizeReference(str) {
  return str.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/\s/g, '_');
}

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
    const callbackUrl = `${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}/api/payment/callback`;
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
  if (!reference) return res.redirect(`${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}?payment_status=failed`);
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
      return res.redirect(`${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}?payment_status=success&reference=${reference}`);
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
      return res.redirect(`${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}?payment_status=failed`);
    }
  } catch (err) {
    console.error('Verification error:', err);
    return res.redirect(`${process.env.APP_URL || 'https://arbitrage-master.onrender.com'}?payment_status=failed`);
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

// ==================== Admin ====================
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

app.listen(PORT, () => console.log(`🚀 ArbiMine running on ${PORT}`));


// ==================== ARBITRAGE ENGINE ====================

// ==================== ARBITRAGE ENGINE ====================

// Normalize symbol format
function normalizeSymbol(symbol) {
    return symbol.replace("-", "/").toUpperCase();
}

// Cross exchange arbitrage detector
function findArbitrageOpportunities(allData) {
    const map = {};

    // Group by symbol
    for (const item of allData) {
        const symbol = normalizeSymbol(item.symbol);
        if (!map[symbol]) map[symbol] = [];
        map[symbol].push(item);
    }

    const opportunities = [];

    for (const symbol in map) {
        const markets = map[symbol];

        let bestBuy = null;   // lowest ask
        let bestSell = null;  // highest bid

        for (const m of markets) {
            if (!m.ask || !m.bid) continue;

            if (!bestBuy || m.ask < bestBuy.ask) bestBuy = m;
            if (!bestSell || m.bid > bestSell.bid) bestSell = m;
        }

        if (!bestBuy || !bestSell || bestBuy.exchange === bestSell.exchange) continue;

        const profit = bestSell.bid - bestBuy.ask;
        const profitPercent = (profit / bestBuy.ask) * 100;

        if (profit > 0) {
            opportunities.push({
                symbol,
                buyExchange: bestBuy.exchange,
                sellExchange: bestSell.exchange,
                buyPrice: bestBuy.ask,
                sellPrice: bestSell.bid,
                profit,
                profitPercent: profitPercent.toFixed(3)
            });
        }
    }

    return opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
}




// ==================== DATA COLLECTOR ====================

// Collect all exchange data into one stream
async function collectAllMarkets() {
    try {
        const [
            binanceData,
            kucoinData,
            gateioData,
            htxData
        ] = await Promise.all([
            typeof fetchBinanceTickers === "function" ? fetchBinanceTickers() : [],
            typeof fetchKuCoinTickers === "function" ? fetchKuCoinTickers() : [],
            typeof fetchGateIOTickers === "function" ? fetchGateIOTickers() : [],
            typeof fetchHTXTickers === "function" ? fetchHTXTickers() : []
        ]);

        return [
            ...binanceData,
            ...kucoinData,
            ...gateioData,
            ...htxData
        ];
    } catch (err) {
        console.error("Data collector error:", err.message);
        return [];
    }
}




// ==================== EXECUTION ENGINE ====================

async function executeArbitrage(opportunity, exchanges) {
  try {
    const {
      buyExchange,
      sellExchange,
      symbol,
      amount
    } = opportunity;

    console.log("🚀 EXECUTION STARTED:", symbol);

    const buyEx = exchanges[buyExchange];
    const sellEx = exchanges[sellExchange];

    if (!buyEx || !sellEx) {
      throw new Error("Exchange not initialized");
    }

    // 1. CHECK BALANCES
    const balance = await buyEx.fetchBalance();
    const base = symbol.split('/')[0];

    if ((balance.free[base] || 0) < amount) {
      throw new Error("Insufficient balance for BUY");
    }

    // 2. PLACE BUY ORDER
    console.log("🟢 Buying on", buyExchange);
    const buyOrder = await buyEx.createMarketOrder(symbol, "buy", amount);

    // 3. CONFIRM BUY FILL (simple delay fallback)
    await new Promise(r => setTimeout(r, 1500));

    // 4. PLACE SELL ORDER
    console.log("🔴 Selling on", sellExchange);
    const sellOrder = await sellEx.createMarketOrder(symbol, "sell", amount);

    // 5. RETURN RESULT
    return {
      success: true,
      buyOrder,
      sellOrder,
      symbol,
      profitEstimate: opportunity.spread || 0
    };

  } catch (err) {
    console.error("❌ EXECUTION ERROR:", err.message);
    return {
      success: false,
      error: err.message
    };
  }
}


// ==================== EXECUTION ENGINE ====================

const AUTO_TRADE = false; // ⚠️ safety switch (DO NOT ENABLE YET)

// Simple fee buffer (adjust per exchange later)
const MIN_PROFIT_PERCENT = 0.6;

// Execute cross-exchange trade
async function executeArbitrage(opportunity) {
    try {
        if (!AUTO_TRADE) {
            console.log("🟡 AUTO_TRADE is OFF. Simulation only:");
            console.log(opportunity);
            return;
        }

        if (parseFloat(opportunity.profitPercent) < MIN_PROFIT_PERCENT) {
            console.log("❌ Profit too low, skipping:", opportunity);
            return;
        }

        console.log("🚀 Executing arbitrage:", opportunity);

        // BUY side
        const buyExchange = opportunity.buyExchange;
        const sellExchange = opportunity.sellExchange;
        const symbol = opportunity.symbol;

        // NOTE: You must map exchange instances globally
        const exchanges = {
            binance,
            kucoin,
            gateio,
            htx
        };

        const buyEx = exchanges[buyExchange];
        const sellEx = exchanges[sellExchange];

        if (!buyEx || !sellEx) {
            console.log("❌ Exchange not available for execution");
            return;
        }

        const amount = 0.001; // ⚠️ placeholder size (BTC example)

        // Execute BUY
        const buyOrder = await buyEx.createMarketBuyOrder(symbol, amount);

        // Execute SELL
        const sellOrder = await sellEx.createMarketSellOrder(symbol, amount);

        console.log("✅ Trade executed:");
        console.log({ buyOrder, sellOrder });

    } catch (err) {
        console.error("❌ Execution error:", err.message);
    }
}



// ==================== TRADE ORCHESTRATOR ====================

// Prevent double execution on same symbol
const activeTrades = new Set();

// Safety thresholds
const MIN_LIQUIDITY = 1000;

// Main decision engine
async function processArbitrageOpportunities() {
    try {
        const markets = await collectAllMarkets();
        const opportunities = findArbitrageOpportunities(markets);

        if (!opportunities.length) {
            console.log("No arbitrage opportunities found.");
            return;
        }

        for (const opp of opportunities) {

            const key = `${opp.symbol}-${opp.buyExchange}-${opp.sellExchange}`;

            // ❌ Prevent duplicate trade
            if (activeTrades.has(key)) {
                continue;
            }

            // ❌ Profit filter
            if (parseFloat(opp.profitPercent) < MIN_PROFIT_PERCENT) {
                continue;
            }

            // ❌ Liquidity filter (basic placeholder logic)
            if ((opp.buyPrice * 10) < MIN_LIQUIDITY) {
                continue;
            }

            // Lock trade
            activeTrades.add(key);

            try {
                console.log("🧠 Valid trade found:", opp);

                // Execute trade
                await executeArbitrage(opp);

            } catch (err) {
                console.error("Trade failed:", err.message);
            }

            // Unlock after execution delay
            setTimeout(() => {
                activeTrades.delete(key);
            }, 15000);

            break; // only execute 1 trade per cycle (SAFETY)
        }

    } catch (err) {
        console.error("Orchestrator error:", err.message);
    }
}




// ==================== LIVE SCANNER LOOP ====================

let isScanning = false;

// Scan interval (adjust 5–15 seconds depending on API limits)
const SCAN_INTERVAL = 8000;

async function startScanner() {
    console.log("🚀 Arbitrage Scanner Started...");

    setInterval(async () => {
        if (isScanning) {
            return; // prevent overlap
        }

        isScanning = true;

        try {
            console.log("🔍 Scanning markets...");

            await processArbitrageOpportunities();

        } catch (err) {
            console.error("Scanner error:", err.message);
        }

        isScanning = false;

    }, SCAN_INTERVAL);
}


startScanner();




// ==================== RISK ENGINE ====================

// Estimated trading fees per exchange (adjust later if needed)
const FEES = {
    binance: 0.001,   // 0.1%
    kucoin: 0.001,
    gateio: 0.002,
    htx: 0.002
};

// Slippage buffer (market volatility protection)
const SLIPPAGE_BUFFER = 0.003; // 0.3%

// Calculate REAL profit after costs
function calculateNetProfit(opportunity) {

    const buyFee = FEES[opportunity.buyExchange] || 0.002;
    const sellFee = FEES[opportunity.sellExchange] || 0.002;

    const buyPrice = parseFloat(opportunity.buyPrice);
    const sellPrice = parseFloat(opportunity.sellPrice);

    if (!buyPrice || !sellPrice) {
        return null;
    }

    const grossProfit = sellPrice - buyPrice;

    // fees
    const feeCost = (buyPrice * buyFee) + (sellPrice * sellFee);

    // slippage cost estimate
    const slippageCost = buyPrice * SLIPPAGE_BUFFER;

    const netProfit = grossProfit - feeCost - slippageCost;

    const netProfitPercent = (netProfit / buyPrice) * 100;

    let risk = "LOW";

    if (netProfitPercent < 0.3) {
        risk = "HIGH";
    } else if (netProfitPercent < 0.8) {
        risk = "MEDIUM";
    }

    return {
        netProfit,
        netProfitPercent: netProfitPercent.toFixed(3),
        risk
    };
}

// Validate trade safety
function isTradeSafe(opportunity) {

    const result = calculateNetProfit(opportunity);

    if (!result) return false;

    opportunity.netProfit = result.netProfit;
    opportunity.netProfitPercent = result.netProfitPercent;
    opportunity.risk = result.risk;

    // reject unprofitable trades
    if (result.netProfit <= 0) return false;

    // reject high risk trades
    if (result.risk === "HIGH") return false;

    return true;
}




// ==================== BALANCE CHECKER ====================

// Cache balances to reduce API calls
let balanceCache = {};
let lastBalanceFetch = 0;
const BALANCE_CACHE_TIME = 15000; // 15 seconds

// Fetch balance from exchange safely
async function getBalance(exchangeName, asset = "USDT") {
    try {
        const now = Date.now();

        // use cache
        if (balanceCache[exchangeName] &&
            (now - lastBalanceFetch) < BALANCE_CACHE_TIME) {

            return balanceCache[exchangeName][asset] || 0;
        }

        const exchanges = {
            binance,
            kucoin,
            gateio,
            htx
        };

        const ex = exchanges[exchangeName];
        if (!ex) return 0;

        const balance = await ex.fetchBalance();

        balanceCache[exchangeName] = balance.total || {};
        lastBalanceFetch = now;

        return balance.total?.[asset] || 0;

    } catch (err) {
        console.error(`Balance error (${exchangeName}):`, err.message);
        return 0;
    }
}

// Check if trade is possible with balances
async function validateBalances(opportunity, tradeAmount = 10) {

    const buyBalance = await getBalance(opportunity.buyExchange, "USDT");

    const sellBaseAsset = opportunity.symbol.split("/")[0];
    const sellBalance = await getBalance(opportunity.sellExchange, sellBaseAsset);

    const buyCost = opportunity.buyPrice * tradeAmount;

    if (buyBalance < buyCost) {
        console.log(`❌ Insufficient USDT on ${opportunity.buyExchange}`);
        return false;
    }

    if (sellBalance < tradeAmount) {
        console.log(`❌ Insufficient ${sellBaseAsset} on ${opportunity.sellExchange}`);
        return false;
    }

    return true;
}



// ==================== SAFE EXECUTION LAYER ====================


// ==================== AUTOMATED EXECUTION PIPELINE ====================


// ==================== TRADE HISTORY DASHBOARD ====================

// ==================== TRADE HISTORY DASHBOARD ====================

// In-memory trade storage (can later move to MongoDB)
const tradeHistory = [];

// Dashboard state
const dashboard = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  totalProfit: 0,
  lastTrade: null
};

function logTrade(result, opportunity) {
  const trade = {
    time: new Date().toISOString(),
    symbol: result.symbol || opportunity.symbol,
    buyExchange: opportunity.buyExchange,
    sellExchange: opportunity.sellExchange,
    success: result.success,
    profit: parseFloat(result.profitEstimate || 0),
    error: result.error || null
  };

  tradeHistory.push(trade);

  dashboard.totalTrades++;

  if (result.success && trade.profit > 0) {
    dashboard.wins++;
    dashboard.totalProfit += trade.profit;
  } else {
    dashboard.losses++;
  }

  dashboard.lastTrade = trade;

  console.log("📊 TRADE LOGGED:", trade);

  return trade;
}

// Analytics helper
function getDashboardStats() {
  const winRate = dashboard.totalTrades
    ? (dashboard.wins / dashboard.totalTrades) * 100
    : 0;

  return {
    ...dashboard,
    winRate: winRate.toFixed(2) + "%",
    averageProfit: dashboard.totalTrades
      ? (dashboard.totalProfit / dashboard.totalTrades).toFixed(4)
      : "0"
  };
}

// Get recent trades
function getRecentTrades(limit = 10) {
  return tradeHistory.slice(-limit).reverse();
}


// ==================== ALERT SYSTEM ====================

// ==================== ALERT SYSTEM ====================

// Telegram config (store in env later)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Send Telegram message
async function sendAlert(message) {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log("⚠️ Telegram not configured:", message);
      return;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      })
    });

  } catch (err) {
    console.error("❌ Alert failed:", err.message);
  }
}

// Alert types
function alertTradeSuccess(trade) {
  sendAlert(
    `✅ <b>TRADE SUCCESS</b>\n` +
    `Symbol: ${trade.symbol}\n` +
    `Profit: ${trade.profit || 0}\n` +
    `Buy: ${trade.buyExchange}\n` +
    `Sell: ${trade.sellExchange}`
  );
}

function alertTradeFail(trade) {
  sendAlert(
    `❌ <b>TRADE FAILED</b>\n` +
    `Symbol: ${trade.symbol}\n` +
    `Error: ${trade.error || "Unknown"}`
  );
}

function alertOpportunity(op) {
  if (op.score && op.score > 85) {
    sendAlert(
      `🚀 <b>HIGH OPPORTUNITY</b>\n` +
      `Symbol: ${op.symbol}\n` +
      `Score: ${op.score}\n` +
      `Spread: ${op.spread}`
    );
  }
}


// ==================== RISK GUARD SYSTEM ====================

// ==================== RISK GUARD SYSTEM ====================

const riskState = {
  lossStreak: 0,
  dailyProfit: 0,
  dailyLoss: 0,
  tradingHalted: false,
  lastReset: Date.now()
};

// CONFIG (adjust later)
const RISK_LIMITS = {
  maxLossStreak: 3,
  maxDailyLoss: 50,      // adjust to your capital
  maxDailyProfit: 200
};

// Reset daily stats (simple 24h reset)
function resetRiskIfNeeded() {
  const now = Date.now();
  const hours = (now - riskState.lastReset) / (1000 * 60 * 60);

  if (hours >= 24) {
    riskState.lossStreak = 0;
    riskState.dailyProfit = 0;
    riskState.dailyLoss = 0;
    riskState.tradingHalted = false;
    riskState.lastReset = now;

    console.log("🔄 Risk system reset (24h cycle)");
  }
}

// Update risk after trade
function updateRisk(result) {
  resetRiskIfNeeded();

  if (!result.success) {
    riskState.lossStreak++;
    riskState.dailyLoss += 1;

    if (riskState.lossStreak >= RISK_LIMITS.maxLossStreak) {
      riskState.tradingHalted = true;
      console.log("🛑 Trading halted: loss streak limit reached");
    }

  } else {
    riskState.lossStreak = 0;
    riskState.dailyProfit += parseFloat(result.profitEstimate || 0);

    if (riskState.dailyProfit >= RISK_LIMITS.maxDailyProfit) {
      riskState.tradingHalted = true;
      console.log("🎯 Profit target reached - trading stopped for today");
    }
  }
}

// Global safety check
function isTradingAllowed() {
  resetRiskIfNeeded();

  if (riskState.tradingHalted) {
    console.log("⛔ Trading blocked by risk system");
    return false;
  }

  if (riskState.dailyLoss >= RISK_LIMITS.maxDailyLoss) {
    console.log("⛔ Max daily loss reached");
    riskState.tradingHalted = true;
    return false;
  }

  return true;
}

// Emergency kill switch
function emergencyStop() {
  riskState.tradingHalted = true;
  console.log("🚨 EMERGENCY STOP ACTIVATED");
}


// ===== AUTO SAFETY PATCH (fallback) =====
function _riskGuardWrapper(fn) {
  return async (...args) => {
    if (typeof isTradingAllowed === "function" && !isTradingAllowed()) {
      console.log("⛔ Blocked by risk guard");
      return null;
    }
    const result = await fn(...args);
    if (typeof updateRisk === "function") {
      updateRisk(result);
    }
    return result;
  };
}



// ==================== SMART POSITION SIZING ====================

function calculatePositionSize(opportunity) {
  try {

    const baseCapital = 100;

    const score = opportunity.score || 50;
    const liquidity = parseFloat(opportunity.liquidity || 0);
    const risk = (opportunity.risk || "medium").toLowerCase();

    let scoreFactor = score / 100;
    let liquidityFactor = Math.min(liquidity / 10000, 1);

    let riskFactor = 1;
    if (risk === "low") riskFactor = 1.2;
    else if (risk === "medium") riskFactor = 1;
    else riskFactor = 0.6;

    let size = baseCapital * scoreFactor * liquidityFactor * riskFactor;

    size = Math.max(5, Math.min(size, 500));

    return { size: Math.round(size * 100) / 100 };

  } catch (e) {
    return { size: 10 };
  }
}



// ==================== AUTO EXECUTION ENGINE ====================

async function isTradingAllowed(opportunity) {
  if (!opportunity) return false;
  if (opportunity.risk === "high") return false;
  if ((opportunity.score || 0) < 70) return false;
  if (!opportunity.tradable) return false;
  return true;
}

async function executeTrade(opportunity) {
  try {
    if (!await isTradingAllowed(opportunity)) {
      console.log("❌ Trade blocked by risk engine");
      return null;
    }

    console.log("🚀 Executing cross-exchange arbitrage...");

    // PLACEHOLDER EXECUTION FLOW (SAFE MODE)
    // Step 1: Buy on exchange A
    // Step 2: Transfer asset (if needed)
    // Step 3: Sell on exchange B

    const result = {
      success: true,
      symbol: opportunity.symbol,
      buyExchange: opportunity.buyExchange,
      sellExchange: opportunity.sellExchange,
      profit: opportunity.spread,
      timestamp: Date.now()
    };

    console.log("✅ Trade executed (SIMULATED SAFE MODE)");
    return result;

  } catch (err) {
    console.error("❌ Execution error:", err.message);
    return null;
  }
}



// ==================== RISK GATE HOOK ====================

function riskGate(opportunity) {
  if (!opportunity) return false;

  const blocked =
    opportunity.risk === "high" ||
    (opportunity.spread || 0) < 0.5 ||
    (opportunity.liquidity || 0) < 1000;

  return !blocked;
}



// ==================== PROCESS OPPORTUNITY FIX ====================

async function processOpportunity(opportunity) {
  try {
    if (!opportunity) {
      console.log("❌ No opportunity provided");
      return null;
    }

    if (!riskGate(opportunity)) {
      console.log("⛔ Opportunity blocked by risk gate");
      return null;
    }

    // scoring fallback safety
    opportunity.score = opportunity.score || 0;

    console.log("📊 Processing opportunity:", opportunity.symbol);

    const tradeResult = await executeTrade(opportunity);

    return {
      opportunity,
      tradeResult
    };

  } catch (e) {
    console.error("❌ processOpportunity error:", e.message);
    return null;
  }
}




function getExchange(name) {
  return exchanges[name] || null;
}



// ==================== CCXT CROSS EXCHANGE ENGINE ====================

// DRY RUN MODE (VERY IMPORTANT)
const DRY_RUN = true;

// Unified exchange manager
const exchangeClients = {
  binance: new ccxt.binance({ enableRateLimit: true }),
  kucoin: new ccxt.kucoin({ enableRateLimit: true }),
  gateio: new ccxt.gateio({ enableRateLimit: true }),
  mexc: new ccxt.mexc({ enableRateLimit: true }),
  bingx: new ccxt.bingx({ enableRateLimit: true }),
  htx: new ccxt.htx({ enableRateLimit: true })
};

// Load markets once
async function initExchanges() {
  for (const name in exchangeClients) {
    try {
      await exchangeClients[name].loadMarkets();
      console.log(`✅ ${name} markets loaded`);
    } catch (e) {
      console.log(`❌ ${name} failed:`, e.message);
    }
  }
}



// ==================== ORDER EXECUTOR ====================

async function placeOrder(exchangeName, symbol, side, amount, price = null) {
  const ex = exchangeClients[exchangeName];

  if (!ex) {
    console.log("❌ Exchange not found:", exchangeName);
    return null;
  }

  try {
    if (DRY_RUN) {
      console.log(`🧪 DRY RUN ORDER:
        ${exchangeName} ${side} ${symbol} ${amount} @ ${price || "market"}`);
      return {
        dryRun: true,
        exchange: exchangeName,
        symbol,
        side,
        amount,
        price
      };
    }

    let order;

    if (price) {
      order = await ex.createLimitOrder(symbol, side, amount, price);
    } else {
      order = await ex.createMarketOrder(symbol, side, amount);
    }

    console.log("✅ ORDER PLACED:", order.id);
    return order;

  } catch (err) {
    console.error("❌ Order failed:", err.message);
    return null;
  }
}



// ==================== CROSS ARBITRAGE EXECUTION FLOW ====================

async function executeCrossArbitrage(opportunity) {
  try {
    if (!opportunity) return null;

    const {
      symbol,
      buyExchange,
      sellExchange,
      amount,
      buyPrice,
      sellPrice
    } = opportunity;

    console.log("🚀 Cross arbitrage starting:", symbol);

    // STEP 1: BUY
    const buyOrder = await placeOrder(
      buyExchange,
      symbol,
      "buy",
      amount,
      buyPrice
    );

    if (!buyOrder) return null;

    // STEP 2: SELL
    const sellOrder = await placeOrder(
      sellExchange,
      symbol,
      "sell",
      amount,
      sellPrice
    );

    return {
      success: true,
      buyOrder,
      sellOrder,
      profit: (sellPrice - buyPrice) * amount
    };

  } catch (e) {
    console.error("❌ Cross arb failed:", e.message);
    return null;
  }
}



// Auto-init hook (call once on server start)
initExchanges();



// ==================== BALANCE SYNC LAYER ====================

const balances = {};

// Fetch balance from exchange
async function fetchBalance(exchangeName) {
  const ex = exchangeClients[exchangeName];
  if (!ex) return null;

  try {
    const balance = await ex.fetchBalance();
    balances[exchangeName] = balance;
    return balance;
  } catch (err) {
    console.error(`❌ Balance fetch failed (${exchangeName}):`, err.message);
    return null;
  }
}

// Get available asset amount
function getAvailable(exchangeName, asset) {
  const bal = balances[exchangeName];
  if (!bal || !bal.free) return 0;

  return bal.free[asset] || 0;
}



// ==================== TRADE VALIDATION ENGINE ====================

function parseSymbol(symbol) {
  // e.g BTC/USDT -> BTC
  return symbol.split('/')[0];
}

async function canExecuteTrade(opportunity) {
  try {
    const baseAsset = parseSymbol(opportunity.symbol);

    const buyBal = getAvailable(opportunity.buyExchange, "USDT");
    const sellBal = getAvailable(opportunity.sellExchange, baseAsset);

    const requiredUSDT = (opportunity.buyPrice || 0) * (opportunity.amount || 0);
    const requiredAsset = opportunity.amount || 0;

    if (buyBal < requiredUSDT) {
      console.log("❌ Insufficient USDT on BUY exchange");
      return false;
    }

    if (sellBal < requiredAsset) {
      console.log("❌ Insufficient asset on SELL exchange");
      return false;
    }

    return true;

  } catch (e) {
    console.error("❌ canExecuteTrade error:", e.message);
    return false;
  }
}



// ==================== BALANCE AUTO REFRESH ====================

async function refreshAllBalances() {
  for (const name in exchangeClients) {
    await fetchBalance(name);
  }

  console.log("🔄 Balances refreshed");
}

// refresh every 60 seconds
setInterval(refreshAllBalances, 60000);



// ==================== EXECUTION GUARD PATCH ====================

// override safe execution check
async function safeExecute(opportunity) {
  if (!opportunity) return null;

  if (!riskGate(opportunity)) {
    console.log("⛔ Risk blocked");
    return null;
  }

  if (!(await canExecuteTrade(opportunity))) {
    console.log("⛔ Balance blocked");
    return null;
  }

  return await executeCrossArbitrage(opportunity);
}



// ==================== ORDER BOOK ARBITRAGE ENGINE ====================

// stores best prices per exchange
const marketData = {};

// fetch order book top levels
async function fetchOrderBook(exchangeName, symbol) {
  try {
    const ex = exchangeClients[exchangeName];
    if (!ex) return null;

    const book = await ex.fetchOrderBook(symbol);
    return {
      bid: book.bids?.[0]?.[0] || 0,
      ask: book.asks?.[0]?.[0] || 0
    };

  } catch (err) {
    console.error(`❌ Orderbook error ${exchangeName}:`, err.message);
    return null;
  }
}



// ==================== SPREAD CALCULATOR ====================

function calculateSpread(buyPrice, sellPrice) {
  if (!buyPrice || !sellPrice) return 0;
  return ((sellPrice - buyPrice) / buyPrice) * 100;
}



// ==================== OPPORTUNITY DETECTOR ====================

const monitoredPairs = ["BTC/USDT", "ETH/USDT"];

async function scanArbitrage() {
  try {
    const exchanges = Object.keys(exchangeClients);

    for (const symbol of monitoredPairs) {

      let bestBuy = null;
      let bestSell = null;

      // find cheapest buy + highest sell
      for (const exName of exchanges) {
        const ob = await fetchOrderBook(exName, symbol);
        if (!ob) continue;

        marketData[exName] = marketData[exName] || {};
        marketData[exName][symbol] = ob;

        if (!bestBuy || ob.ask < bestBuy.price) {
          bestBuy = {
            exchange: exName,
            price: ob.ask
          };
        }

        if (!bestSell || ob.bid > bestSell.price) {
          bestSell = {
            exchange: exName,
            price: ob.bid
          };
        }
      }

      if (!bestBuy || !bestSell) continue;

      const spread = calculateSpread(bestBuy.price, bestSell.price);

      const opportunity = {
        symbol,
        buyExchange: bestBuy.exchange,
        sellExchange: bestSell.exchange,
        buyPrice: bestBuy.price,
        sellPrice: bestSell.price,
        spread,
        amount: 0.01, // default micro size
        risk: spread > 1 ? "medium" : "low",
        tradable: spread > 0.5
      };

      if (spread > 0.5) {
        console.log("🚨 ARB FOUND:", opportunity);

        await safeExecute(opportunity);
      }
    }

  } catch (e) {
    console.error("❌ scanArbitrage error:", e.message);
  }
}



// ==================== LIVE SCANNER LOOP ====================

// scan every 5 seconds (adjust later for speed optimization)
setInterval(scanArbitrage, 5000);



// ==================== WEBSOCKET PRICE ENGINE ====================

const WebSocket = require('ws');

// live tick storage
const livePrices = {};

// Binance WebSocket (fastest reliable source)
function startBinanceWS(symbol = "btcusdt") {
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@bookTicker`);

  ws.on('message', (data) => {
    const tick = JSON.parse(data);

    livePrices["binance"] = livePrices["binance"] || {};
    livePrices["binance"][symbol.toUpperCase()] = {
      bid: parseFloat(tick.b),
      ask: parseFloat(tick.a),
      time: Date.now()
    };
  });

  ws.on('open', () => console.log("✅ Binance WS connected:", symbol));
  ws.on('close', () => console.log("⚠️ Binance WS closed"));
  ws.on('error', (e) => console.log("❌ Binance WS error:", e.message));
}



// ==================== WS INIT ====================

const wsSymbols = ["btcusdt", "ethusdt"];

function startAllWebSockets() {
  for (const sym of wsSymbols) {
    startBinanceWS(sym);
  }
}

startAllWebSockets();



// ==================== LIVE PRICE GETTER ====================

function getLivePrice(exchange, symbol) {
  const exData = livePrices[exchange];
  if (!exData) return null;

  return exData[symbol];
}



// ==================== WS-POWERED ARB SCAN ====================

async function scanArbitrageWS() {
  try {
    const symbol = "BTCUSDT";

    const binance = getLivePrice("binance", symbol);

    if (!binance) return;

    // fallback for others via REST snapshot
    const exchanges = Object.keys(exchangeClients);

    let bestSell = { exchange: "binance", price: binance.bid };
    let bestBuy = { exchange: "binance", price: binance.ask };

    for (const exName of exchanges) {
      if (exName === "binance") continue;

      const ob = await fetchOrderBook(exName, "BTC/USDT");
      if (!ob) continue;

      if (ob.bid > bestSell.price) {
        bestSell = { exchange: exName, price: ob.bid };
      }

      if (ob.ask < bestBuy.price) {
        bestBuy = { exchange: exName, price: ob.ask };
      }
    }

    const spread = calculateSpread(bestBuy.price, bestSell.price);

    if (spread > 0.5) {
      const opportunity = {
        symbol: "BTC/USDT",
        buyExchange: bestBuy.exchange,
        sellExchange: bestSell.exchange,
        buyPrice: bestBuy.price,
        sellPrice: bestSell.price,
        spread,
        amount: 0.01,
        risk: spread > 1 ? "medium" : "low",
        tradable: true
      };

      console.log("⚡ WS ARB DETECTED:", opportunity);

      await safeExecute(opportunity);
    }

  } catch (e) {
    console.error("❌ WS scan error:", e.message);
  }
}



// ==================== WS LOOP ====================

// faster loop because WS already feeds prices
setInterval(scanArbitrageWS, 1500);



// ==================== SMART ROUTING ENGINE ====================

// estimated fees per exchange (tune later with real API data)
const exchangeFees = {
  binance: 0.001,
  kucoin: 0.0012,
  gateio: 0.0015,
  mexc: 0.001,
  bingx: 0.0012,
  htx: 0.0015
};

// estimated transfer times (minutes penalty)
const transferPenalty = {
  binance: 2,
  kucoin: 3,
  gateio: 4,
  mexc: 3,
  bingx: 4,
  htx: 5
};



// ==================== NET PROFIT ENGINE ====================

function calculateNetProfit(opportunity) {
  const {
    buyPrice,
    sellPrice,
    amount,
    buyExchange,
    sellExchange
  } = opportunity;

  const buyFee = exchangeFees[buyExchange] || 0.001;
  const sellFee = exchangeFees[sellExchange] || 0.001;

  const transferPenaltyScore =
    (transferPenalty[buyExchange] || 3) +
    (transferPenalty[sellExchange] || 3);

  const grossProfit = (sellPrice - buyPrice) * amount;

  const feeCost =
    (buyPrice * amount * buyFee) +
    (sellPrice * amount * sellFee);

  const timeDecayPenalty = transferPenaltyScore * 0.01 * amount;

  const netProfit = grossProfit - feeCost - timeDecayPenalty;

  return {
    grossProfit,
    feeCost,
    timeDecayPenalty,
    netProfit
  };
}



// ==================== ROUTE SCORER ====================

function scoreRoute(opportunity) {
  const net = calculateNetProfit(opportunity);

  const liquidityScore =
    Math.min((opportunity.liquidity || 0) / 10000, 1);

  const spreadScore =
    Math.min(opportunity.spread / 2, 1);

  const profitScore =
    Math.max(0, net.netProfit);

  const score =
    (profitScore * 0.6) +
    (liquidityScore * 30) +
    (spreadScore * 20);

  return {
    ...net,
    score
  };
}



// ==================== ROUTE SELECTOR ====================

async function selectBestRoute(opportunities) {
  if (!opportunities || !opportunities.length) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const opp of opportunities) {
    const evaluated = scoreRoute(opp);

    if (evaluated.score > bestScore) {
      bestScore = evaluated.score;
      best = {
        ...opp,
        evaluation: evaluated
      };
    }
  }

  if (best) {
    console.log("🎯 BEST ROUTE SELECTED:", best);
  }

  return best;
}



// ==================== SMART ROUTE INTEGRATION ====================

// wrapper to upgrade your scanner output
async function processSmartOpportunity(opps) {
  const best = await selectBestRoute(opps);

  if (!best) return null;

  // pass into your safe execution system
  return await safeExecute(best);
}


// ================= BOT CONTROL =================
let BOT_RUNNING = false;

function startBot() {
  BOT_RUNNING = true;
  console.log("🟢 Bot Started");
}

function stopBot() {
  BOT_RUNNING = false;
  console.log("🔴 Bot Stopped");
}

function isTradingAllowed() {
  return BOT_RUNNING;
}

// API ENDPOINTS
app.get("/api/bot/start", (req, res) => {
  startBot();
  res.json({ status: "started" });
});

app.get("/api/bot/stop", (req, res) => {
  stopBot();
  res.json({ status: "stopped" });
});

app.get("/api/bot/status", (req, res) => {
  res.json({ running: BOT_RUNNING });
});


// ================= GLOBAL EXECUTION GATE =================
async function executeSafe(opportunity){
  if (!isTradingAllowed()) return null;
  if (!opportunity) return null;

  return await executeCrossArbitrage(opportunity);
}
