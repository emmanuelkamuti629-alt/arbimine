require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Opportunity = require('./models/Opportunity');

mongoose.connect(process.env.MONGODB_URI);

async function scanBinance() {
  const res = await axios.get('https://api.binance.com/api/v3/ticker/bookTicker');
  return res.data.filter(t => t.symbol.endsWith('USDT')).map(t => ({
    ex: 'Binance', symbol: t.symbol, buy: parseFloat(t.askPrice), sell: parseFloat(t.bidPrice)
  }));
}

async function scanKucoin() {
  const res = await axios.get('https://api.kucoin.com/api/v1/market/allTickers');
  return res.data.data.ticker.filter(t => t.symbol.endsWith('-USDT')).map(t => ({
    ex: 'KuCoin', symbol: t.symbol.replace('-', ''), buy: parseFloat(t.buy), sell: parseFloat(t.sell)
  }));
}

async function runScan() {
  try {
    const [bin, ku] = await Promise.all([scanBinance(), scanKucoin()]);
    const all = [...bin,...ku];
    const bulk = [];

    for (let i = 0; i < all.length; i++) {
      for (let j = 0; j < all.length; j++) {
        if (i === j || all[i].symbol!== all[j].symbol) continue;
        const buy = all[i], sell = all[j];
        const spread = ((sell.sell - buy.buy) / buy.buy * 100);
        if (spread > 0.3) {
          bulk.push({
            updateOne: {
              filter: { symbol: buy.symbol, buyExchange: buy.ex, sellExchange: sell.ex },
              update: {
                $set: {
                  symbol: buy.symbol, buyExchange: buy.ex, sellExchange: sell.ex,
                  buyPrice: buy.buy, sellPrice: sell.sell, spread: spread.toFixed(3),
                  tradable: true, risk: spread > 2? 'high' : spread > 0.8? 'medium' : 'low',
                  updatedAt: new Date(),
                  buyNetworks: { TRC20: { name: 'TRC20', fee: 1, withdraw: true, deposit: true } },
                  sellNetworks: { TRC20: { name: 'TRC20', fee: 1, withdraw: true, deposit: true } }
                }
              },
              upsert: true
            }
          });
        }
      }
    }
    if (bulk.length) await Opportunity.bulkWrite(bulk);
    console.log(`[${new Date().toLocaleTimeString()}] Updated ${bulk.length} opps`);
  } catch (e) { console.log('Scan error:', e.message); }
}

setInterval(runScan, 30000);
runScan();
