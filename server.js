require("dotenv").config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CORS (optional, but safe) ====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==================== MongoDB ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Admin Auth ====================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const adminTokens = new Set();

// Health check (to confirm server is alive)
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/admin/login', (req, res) => {
  console.log('🔐 Login attempt:', req.body.username);
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    console.log('✅ Login successful for', username);
    res.json({ success: true, token });
  } else {
    console.log('❌ Login failed for', username);
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

// ==================== Exchange Integration (same as before) ====================
const SUPPORTED_EXCHANGES = [
  'binance', 'kucoin', 'mexc', 'gateio', 'htx', 'bingx',
  'okx', 'bybit', 'bitget', 'bitmart', 'coinex', 'lbank',
  'kraken', 'coinbase', 'whitebit'
];

function buildExchange(exchangeId, apiKey, secret) {
  const exchangeMap = {
    binance: ccxt.binance, kucoin: ccxt.kucoin, htx: ccxt.huobi,
    gateio: ccxt.gateio, mexc: ccxt.mexc, bingx: ccxt.bingx,
    okx: ccxt.okx, bybit: ccxt.bybit, bitget: ccxt.bitget,
    bitmart: ccxt.bitmart, coinex: ccxt.coinex, lbank: ccxt.lbank,
    kraken: ccxt.kraken, coinbase: ccxt.coinbase, whitebit: ccxt.whitebit
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
  bingx: { apiKey: process.env.BINGX_API_KEY, secret: process.env.BINGX_SECRET },
  okx: { apiKey: process.env.OKX_API_KEY, secret: process.env.OKX_SECRET },
  bybit: { apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_SECRET },
  bitget: { apiKey: process.env.BITGET_API_KEY, secret: process.env.BITGET_SECRET },
  bitmart: { apiKey: process.env.BITMART_API_KEY, secret: process.env.BITMART_SECRET },
  coinex: { apiKey: process.env.COINEX_API_KEY, secret: process.env.COINEX_SECRET },
  lbank: { apiKey: process.env.LBANK_API_KEY, secret: process.env.LBANK_SECRET },
  kraken: { apiKey: process.env.KRAKEN_API_KEY, secret: process.env.KRAKEN_SECRET },
  coinbase: { apiKey: process.env.COINBASE_API_KEY, secret: process.env.COINBASE_SECRET },
  whitebit: { apiKey: process.env.WHITEBIT_API_KEY, secret: process.env.WHITEBIT_SECRET }
};

const exchangeInstances = {};
for (const [id, cred] of Object.entries(EXCHANGE_CREDENTIALS)) {
  const ex = buildExchange(id, cred.apiKey, cred.secret);
  if (ex) exchangeInstances[id] = ex;
}

// Public ticker endpoints
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
  kraken: 'https://api.kraken.com/0/public/Ticker?pair=all',
  coinbase: 'https://api.coinbase.com/v2/prices/USD-USD/spot',
  whitebit: 'https://api.whitebit.com/api/v1/public/ticker'
};

async function safeGet(url, name) {
  try {
    const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
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
    if (exchange === 'mexc' && symbol.endsWith('USDT')) { sym = symbol.replace('USDT', ''); price = +t.lastPrice; volume = +t.quoteVolume; }
    else if (exchange === 'kucoin' && symbol.includes('-USDT')) { sym = symbol.replace('-USDT', ''); price = +t.last; volume = +t.volValue; }
    else if (exchange === 'bitmart' && symbol.includes('_USDT')) { sym = symbol.replace('_USDT', ''); price = +t.last_price; volume = +t.quote_volume; }
    else if (exchange === 'bitget') { sym = t.symbol?.replace('USDT', ''); price = +t.close; volume = +t.usdtVol; }
    else if (exchange === 'gateio' && symbol.includes('_USDT')) { sym = symbol.replace('_USDT', ''); price = +t.last; volume = +t.quote_volume; }
    else if (exchange === 'okx' && symbol.includes('-USDT')) { sym = symbol.replace('-USDT', ''); price = +t.last; volume = +t.volCcy24h; }
    else if (exchange === 'bybit') { sym = t.symbol?.replace('USDT', ''); price = +t.lastPrice; volume = +t.turnover24h; }
    else if (exchange === 'htx') { sym = symbol.replace('usdt', '').toUpperCase(); price = +t.close; volume = +t.vol; }
    else if (exchange === 'kraken' && symbol) { sym = symbol.replace('USD', '').replace('USDT', ''); price = +t.c[0]; volume = +t.v[1]; }
    else if (exchange === 'whitebit' && symbol) { sym = symbol.replace('_USDT', ''); price = +t.last; volume = +t.volume; }
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
      else if (ex === 'kraken') {
        if (data.result) {
          for (const [pair, info] of Object.entries(data.result)) {
            tickers.push({ symbol: pair, ...info });
          }
        }
      }
      else if (ex === 'whitebit') {
        if (data.result) {
          for (const [pair, info] of Object.entries(data.result)) {
            tickers.push({ symbol: pair, ...info });
          }
        }
      }
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

// ==================== Admin API Routes ====================
app.get('/api/opportunities', adminAuth, (req, res) => {
  const withDetails = cachedOpportunities.map(opp => {
    const detailed = detailedCache.get(opp.id);
    if (detailed) return detailed;
    return { ...opp, tradable: false, risk: 'medium', buyNetworks: {}, sellNetworks: {}, buyWithdraw: false, sellDeposit: false };
  });
  res.json({ count: withDetails.length, opportunities: withDetails, lastScan: lastFastScan, lastDetail: lastDetailScan });
});

app.get('/api/opportunity/:id/details', adminAuth, async (req, res) => {
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

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Arbitrage Master running on ${PORT}`));
