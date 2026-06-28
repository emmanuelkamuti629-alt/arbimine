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
// ... (keep all schemas as before – User, Session, Transaction, Message, BlockedUser, Trade) ...
// For brevity, I'll omit the full schema definitions here, but you must keep them.
// They are exactly as in your previous working version.

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

// ==================== Exchange Integration (Robust) ====================
// We'll try to instantiate each exchange; if unsupported, we skip it.
const exchangeInstances = {};
const SUPPORTED_EXCHANGES = [];

// Helper to initialize an exchange
function initExchange(id, config) {
  try {
    const ExchangeClass = ccxt[id];
    if (typeof ExchangeClass === 'function') {
      const ex = new ExchangeClass(config);
      exchangeInstances[id] = ex;
      SUPPORTED_EXCHANGES.push(id);
      console.log(`✅ ${id} API configured`);
    } else {
      console.log(`⚠️ ${id} not supported in this ccxt version – skipping`);
    }
  } catch (err) {
    console.log(`⚠️ Failed to initialize ${id}:`, err.message);
  }
}

// Binance
initExchange('binance', {
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET,
  enableRateLimit: true,
  timeout: 30000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});

// KuCoin (with password)
initExchange('kucoin', {
  apiKey: process.env.KUCOIN_API_KEY,
  secret: process.env.KUCOIN_SECRET,
  password: process.env.KUCOIN_PASSWORD,
  enableRateLimit: true,
  timeout: 30000,
  headers: { 'User-Agent': 'Mozilla/5.0' }
});

// MEXC
initExchange('mexc', {
  apiKey: process.env.MEXC_API_KEY,
  secret: process.env.MEXC_SECRET,
  enableRateLimit: true,
  timeout: 30000,
  headers: { 'User-Agent': 'Mozilla/5.0' }
});

// Gate.io
initExchange('gateio', {
  apiKey: process.env.GATEIO_API_KEY,
  secret: process.env.GATEIO_SECRET,
  enableRateLimit: true,
  timeout: 30000,
  headers: { 'User-Agent': 'Mozilla/5.0' }
});

// HTX (Huobi)
initExchange('htx', {
  apiKey: process.env.HTX_API_KEY,
  secret: process.env.HTX_SECRET,
  enableRateLimit: true,
  timeout: 30000,
  headers: { 'User-Agent': 'Mozilla/5.0' }
});

// BingX (check if available)
initExchange('bingx', {
  apiKey: process.env.BINGX_API_KEY,
  secret: process.env.BINGX_SECRET,
  enableRateLimit: true,
  timeout: 30000,
  headers: { 'User-Agent': 'Mozilla/5.0' }
});

console.log(`🔌 Supported exchanges: ${SUPPORTED_EXCHANGES.join(', ')}`);

// If no exchanges were initialized, fallback to a minimal set
if (SUPPORTED_EXCHANGES.length === 0) {
  console.warn('⚠️ No exchanges initialized – using public endpoints only');
  // We'll still have the public ticker endpoints; we just won't have authenticated instances.
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

// Public ticker endpoints – only for exchanges that are actually supported
// We'll keep the full list, but if an exchange isn't in SUPPORTED_EXCHANGES, it won't be used in fastScan.
const EXCHANGES = {
  binance: 'https://api.binance.com/api/v3/ticker/24hr',
  kucoin: 'https://api.kucoin.com/api/v1/market/allTickers',
  mexc: 'https://api.mexc.com/api/v3/ticker/24hr',
  gateio: 'https://api.gateio.ws/api/v4/spot/tickers',
  htx: 'https://api.huobi.pro/market/tickers',
  bingx: 'https://api.bingx.com/api/v1/market/ticker/24hr'
};

// Symbol blacklist (unchanged)
const SYMBOL_BLACKLIST = new Set([
  'US', 'USD', 'MEA', 'SCA', 'AVAIL', 'HOME', 'GUA', 'ESPORTS', 'KRL',
  'SIREN', 'STG', 'VANRY', 'PRCL', 'DGB', 'SWEAT', 'NAVX', 'TAIKO',
  'DEXE', 'IOTX', 'VELODROME', 'SAND', 'MANA', 'CHZ', 'GALA'
]);

// ==================== Scanner Functions ====================
// ... (keep all scanner functions – safeGet, extractSymbol, fastScan, detailScan, etc.) ...
// These are unchanged from your previous working version.

// ==================== Auth Routes ====================
// ... (keep all auth routes – register, login, me, subscription, messages, etc.) ...

// ==================== Admin Endpoints ====================
// ... (keep all admin routes) ...

// ==================== Opportunities ====================
// ... (keep opportunities endpoints – they now use the dynamic SUPPORTED_EXCHANGES) ...

// ==================== Balance ====================
// ... (keep balance endpoint – it uses exchangeInstances which may be empty) ...

// ==================== Deposit Address ====================
// ... (keep deposit address endpoint – it uses exchangeInstances) ...

// ==================== Withdrawal Info ====================
// ... (keep withdrawal info endpoint) ...

// ==================== Execute Trade ====================
// ... (keep trade execution) ...

// ==================== Trade History ====================
// ... (keep trade history) ...

// ==================== Payment ====================
// ... (keep your payment routes) ...

// ==================== Admin page ====================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 ArbiMine running on ${PORT}`));
