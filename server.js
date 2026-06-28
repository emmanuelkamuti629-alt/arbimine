
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
// ... (keep email config unchanged) ...

// ==================== Schemas ====================
// ... (keep schemas unchanged) ...

// ==================== Admin & Auth ====================
// ... (keep admin and auth middleware unchanged) ...

// ==================== Exchange Integration (5 Exchanges – Binance removed) ====================
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

// ==================== Public Ticker Endpoints ====================
// Binance is removed from public endpoints to avoid 451 errors
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

// ==================== Symbol Blacklist ====================
// ... (keep blacklist unchanged) ...

// ==================== Scanner ====================
// ... (keep fastScan, detailScan, extractSymbol etc. – they will now filter out Binance because it's not in SUPPORTED_EXCHANGES) ...

// ==================== Routes ====================
// ... (keep all routes unchanged) ...

// ==================== Admin page ====================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 ArbiMine running on ${PORT}`));
