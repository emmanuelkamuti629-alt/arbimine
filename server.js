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
// ... (keep all schemas unchanged) ...

// ==================== Admin & Auth ====================
// ... (keep admin and auth middleware unchanged) ...

// ==================== Exchange Integration (5 Exchanges) ====================
const SUPPORTED_EXCHANGES = ['binance', 'kucoin', 'mexc', 'gateio', 'htx'];

function buildExchange(exchangeId, apiKey, secret) {
  const exchangeMap = {
    binance: ccxt.binance,
    kucoin: ccxt.kucoin,
    htx: ccxt.huobi,
    gateio: ccxt.gateio,
    mexc: ccxt.mexc
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
  binance: { apiKey: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_SECRET },
  kucoin: { apiKey: process.env.KUCOIN_API_KEY, secret: process.env.KUCOIN_SECRET },
  htx: { apiKey: process.env.HTX_API_KEY, secret: process.env.HTX_SECRET },
  gateio: { apiKey: process.env.GATEIO_API_KEY, secret: process.env.GATEIO_SECRET },
  mexc: { apiKey: process.env.MEXC_API_KEY, secret: process.env.MEXC_SECRET }
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
    }
  };
  const exMap = map[exchange.toLowerCase()];
  if (!exMap) return network;
  const currMap = exMap[currency.toUpperCase()];
  if (!currMap) return network;
  const key = Object.keys(currMap).find(k => k.toUpperCase() === network.toUpperCase());
  return key ? currMap[key] : network;
}

// ==================== Public Ticker Endpoints (FAST) ====================
const EXCHANGES_PUBLIC = {
  binance: 'https://api.binance.com/api/v3/ticker/24hr',
  kucoin: 'https://api.kucoin.com/api/v1/market/allTickers',
  mexc: 'https://api.mexc.com/api/v3/ticker/24hr',
  gateio: 'https://api.gateio.ws/api/v4/spot/tickers',
  htx: 'https://api.huobi.pro/market/tickers'
};

// ==================== Symbol Blacklist ====================
const SYMBOL_BLACKLIST = new Set([
  'US', 'USD', 'MEA', 'SCA', 'AVAIL', 'HOME', 'GUA', 'ESPORTS', 'KRL',
  'SIREN', 'STG', 'VANRY', 'PRCL', 'DGB', 'SWEAT', 'NAVX', 'TAIKO',
  'DEXE', 'IOTX', 'VELODROME', 'SAND', 'MANA', 'CHZ', 'GALA'
]);

async function safeGet(url, name) {
  try {
    const res = await axios.get(url, {
      timeout: 8000, // short timeout for speed
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
    } else {
      return null; // skip unknown formats for speed
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

// ==================== FAST SCAN (USING PUBLIC ENDPOINTS) ====================
async function fastScan() {
  console.log('🔄 Fast scan (using public tickers)...');
  const start = Date.now();
  try {
    // Fetch all public tickers in parallel
    const results = await Promise.all(Object.entries(EXCHANGES_PUBLIC).map(([ex, url]) => safeGet(url, ex)));
    const allData = {};
    Object.keys(EXCHANGES_PUBLIC).forEach(e => (allData[e] = {}));

    results.forEach((data, idx) => {
      const ex = Object.keys(EXCHANGES_PUBLIC)[idx];
      if (!data) return;
      let tickers = [];
      if (ex === 'binance') tickers = data;
      else if (ex === 'kucoin') tickers = data.data?.ticker || [];
      else if (ex === 'mexc') tickers = data;
      else if (ex === 'gateio') tickers = data;
      else if (ex === 'htx') tickers = data.data || [];
      for (const t of tickers) {
        const symKey = t.symbol || t.currency_pair || t.instId || t.market || t.i || '';
        const d = extractSymbol(ex, symKey, t);
        if (d) {
          allData[ex][d.symbol] = { price: d.price, volume: d.volume };
        }
      }
    });

    // Compute opportunities
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

  // After fast scan, start detail scan in background (but don't block)
  if (cachedOpportunities.length > 0) {
    detailScan(); // run immediately after fast scan
  }
}

// ==================== DETAIL SCAN (USES REAL API KEYS) ====================
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
        const buyMarket = buyEx.market(o.symbol);
        const sellMarket = sellEx.market(o.symbol);
        return buyMarket && sellMarket;
      } catch {
        return false;
      }
    })
    .slice(0, DETAIL_OPP_LIMIT);

  let updated = 0;
  // Process in parallel for speed
  const updatePromises = validOpps.map(async (opp) => {
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
    } catch (err) {
      console.log(`Detail scan failed for ${opp.id}:`, err.message);
    }
  });

  await Promise.all(updatePromises);
  lastDetailScan = Date.now();
  console.log(`✅ Detail scan: updated ${updated} opportunities in ${Date.now() - start}ms`);
}

// Start fast scan immediately (and repeat every 60s)
fastScan();
setInterval(fastScan, FAST_SCAN_INTERVAL);

// Also run detail scan periodically (and after each fast scan)
setInterval(() => { if (cachedOpportunities.length > 0) detailScan(); }, DETAIL_SCAN_INTERVAL);

// ==================== REST OF THE SERVER (Routes) ====================
// ... (keep all your existing routes: auth, messaging, admin, opportunities, balance, deposit address, withdrawal info, trade execute, trade history, payment) ...
// They are unchanged from the previous version.

// ==================== Admin page ====================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 ArbiMine running on ${PORT}`));
