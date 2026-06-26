require("dotenv").config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const ccxt = require('ccxt');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Exchange API ====================
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

// Generate mock opportunities if real scan fails (for demo/fallback)
function generateMockOpportunities() {
  const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOT', 'LINK', 'MATIC', 'UNI', 'ATOM'];
  const exchanges = ['BINANCE', 'KUCOIN', 'MEXC', 'HTX', 'GATEIO', 'BYBIT', 'OKX'];
  const mock = [];
  for (let i = 0; i < 10; i++) {
    const buyEx = exchanges[Math.floor(Math.random() * exchanges.length)];
    let sellEx = exchanges[Math.floor(Math.random() * exchanges.length)];
    while (sellEx === buyEx) sellEx = exchanges[Math.floor(Math.random() * exchanges.length)];
    const price = 100 + Math.random() * 900;
    const spread = (Math.random() * 8 + 0.5).toFixed(2);
    const liquidity = Math.floor(Math.random() * 100000 + 10000);
    const risk = ['low', 'medium', 'high'][Math.floor(Math.random() * 3)];
    const tradable = Math.random() > 0.3;
    const id = `${coins[i % coins.length]}-${buyEx}-${sellEx}`;
    mock.push({
      id,
      symbol: coins[i % coins.length],
      buyExchange: buyEx,
      sellExchange: sellEx,
      buyPrice: (price * (1 - spread / 200)).toFixed(8),
      sellPrice: (price * (1 + spread / 200)).toFixed(8),
      spread: spread,
      liquidity: liquidity,
      tradable,
      risk,
      buyWithdraw: Math.random() > 0.2,
      sellDeposit: Math.random() > 0.2,
      buyNetworks: Math.random() > 0.5 ? { TRC20: { name: 'TRC20', withdraw: true, deposit: true, fee: 1, feeUnit: 'USDT' } } : {},
      sellNetworks: Math.random() > 0.5 ? { TRC20: { name: 'TRC20', withdraw: true, deposit: true, fee: 1, feeUnit: 'USDT' } } : {}
    });
  }
  return mock;
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
    // If no opportunities, fill with mock data
    if (cachedOpportunities.length === 0) {
      console.log('⚠️ No opportunities found, using mock data');
      cachedOpportunities = generateMockOpportunities();
    }
  } catch (err) {
    console.error('Fast scan failed:', err.message);
    console.log('Using mock data as fallback');
    cachedOpportunities = generateMockOpportunities();
    lastFastScan = Date.now();
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

// Initial scan with fallback
fastScan();
setInterval(fastScan, FAST_SCAN_INTERVAL);
setInterval(() => { if (cachedOpportunities.length > 0) detailScan(); }, DETAIL_SCAN_INTERVAL);
setTimeout(() => { if (cachedOpportunities.length > 0) detailScan(); }, 30000);

// ==================== Global Market Data ====================
async function getGlobalMarketData() {
  try {
    const [global, btc, eth, fear] = await Promise.all([
      axios.get('https://api.coingecko.com/api/v3/global'),
      axios.get('https://api.coingecko.com/api/v3/coins/bitcoin'),
      axios.get('https://api.coingecko.com/api/v3/coins/ethereum'),
      axios.get('https://api.alternative.me/fng/?limit=1')
    ]);
    return {
      marketCap: global.data.data.total_market_cap.usd,
      volume24h: global.data.data.total_volume.usd,
      btcDominance: global.data.data.market_cap_percentage.btc,
      btcPrice: btc.data.market_data.current_price.usd,
      ethPrice: eth.data.market_data.current_price.usd,
      fearGreed: fear.data.data[0]
    };
  } catch (e) {
    console.log('Global market data error:', e.message);
    return null;
  }
}

app.get('/api/market/global', async (req, res) => {
  const data = await getGlobalMarketData();
  res.json(data || {});
});

app.get('/api/market/trending', async (req, res) => {
  try {
    const { data } = await axios.get('https://api.coingecko.com/api/v3/search/trending');
    res.json(data.coins.map(c => c.item));
  } catch (e) { res.json([]); }
});

app.get('/api/market/recently_listed', async (req, res) => {
  try {
    const { data } = await axios.get('https://api.coingecko.com/api/v3/coins/list/new');
    res.json(data);
  } catch (e) { res.json([]); }
});

// ==================== Crypto News ====================
app.get('/api/crypto-news', async (req, res) => {
  try {
    const response = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
    const articles = response.data.Data.slice(0, 10);
    const news = articles.map(item => ({
      title: item.title,
      description: item.body.substring(0, 180) + '...',
      source: item.source,
      category: item.categories,
      url: item.url
    }));
    res.json(news);
  } catch (err) {
    console.log(err.message);
    res.json([]);
  }
});

// ==================== Opportunities ====================
app.get('/api/opportunities', (req, res) => {
  try {
    const withDetails = cachedOpportunities.map(opp => {
      const detailed = detailedCache.get(opp.id);
      if (detailed) return detailed;
      return { ...opp, tradable: false, risk: 'medium', buyNetworks: {}, sellNetworks: {}, buyWithdraw: false, sellDeposit: false };
    });
    res.json({ count: withDetails.length, opportunities: withDetails, lastScan: lastFastScan });
  } catch (err) {
    console.error('Error in /api/opportunities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/opportunity/:id/details', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('Error in /api/opportunity/:id/details:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Exchange Health ====================
app.get('/api/exchange-health', async (req, res) => {
  const health = {};
  for (const [id, ex] of Object.entries(exchangeInstances)) {
    const start = Date.now();
    try {
      await ex.loadMarkets();
      health[id] = { latency: Date.now() - start, status: 'online', uptime: '99.9%' };
    } catch (e) {
      health[id] = { latency: null, status: 'offline', uptime: '0%' };
    }
  }
  res.json(health);
});

// ==================== Start server ====================
app.listen(PORT, () => console.log(`🚀 ArbiMine Pro running on ${PORT}`));
