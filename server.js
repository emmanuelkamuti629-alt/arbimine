// ==================== Trade Schema ====================
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
const Trade = mongoose.model('Trade', tradeSchema);

// ==================== Balance API (simulated) ====================
app.get('/api/balance/:exchange', async (req, res) => {
  const { exchange } = req.params;
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  // Simulate balances (in reality, fetch from CCXT if keys are set)
  const balances = {
    binance: { USDT: 1250, BTC: 0.02, ETH: 0.5 },
    kucoin: { USDT: 800, BTC: 0.015, ETH: 0.3 },
    htx: { USDT: 600, BTC: 0.01, ETH: 0.2 },
    gateio: { USDT: 900, BTC: 0.018, ETH: 0.35 },
    mexc: { USDT: 700, BTC: 0.012, ETH: 0.25 },
    bybit: { USDT: 1100, BTC: 0.022, ETH: 0.45 },
    okx: { USDT: 950, BTC: 0.019, ETH: 0.38 },
    bitget: { USDT: 550, BTC: 0.009, ETH: 0.15 },
    bitmart: { USDT: 400, BTC: 0.006, ETH: 0.1 },
    coinex: { USDT: 300, BTC: 0.005, ETH: 0.08 },
    lbank: { USDT: 250, BTC: 0.004, ETH: 0.06 },
    kraken: { USDT: 1300, BTC: 0.025, ETH: 0.55 },
    coinbase: { USDT: 1500, BTC: 0.03, ETH: 0.6 },
    whitebit: { USDT: 200, BTC: 0.003, ETH: 0.04 }
  };
  const exBal = balances[exchange.toLowerCase()] || { USDT: 0 };
  // Try to get real balance if exchange instance exists and has API keys
  const ex = exchangeInstances[exchange.toLowerCase()];
  if (ex && ex.apiKey && ex.secret) {
    try {
      const balance = await ex.fetchBalance();
      // Filter out zero balances
      const nonZero = {};
      for (const [currency, amount] of Object.entries(balance.free)) {
        if (amount > 0) nonZero[currency] = amount;
      }
      return res.json(nonZero);
    } catch (err) {
      console.log(`Balance fetch error for ${exchange}:`, err.message);
      // fallback to simulated
    }
  }
  res.json(exBal);
});

// ==================== Trade Execution ====================
app.post('/api/trade/execute', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const { symbol, buyExchange, sellExchange, buyPrice, sellPrice, amount, investment } = req.body;
  if (!symbol || !buyExchange || !sellExchange || !buyPrice || !sellPrice || !amount || !investment) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Simulate trade execution (in reality, place orders via CCXT)
  // Validate balances (simulated)
  const buyEx = buyExchange.toLowerCase();
  const sellEx = sellExchange.toLowerCase();
  // Simulate fees (using same logic as frontend)
  const tradeFeeRate = 0.001;
  const buyTradeFee = investment * tradeFeeRate;
  const sellTradeFee = (amount * sellPrice) * tradeFeeRate;
  const totalTradingFees = buyTradeFee + sellTradeFee;
  // Simulate network fees (fixed or random)
  const withdrawalFeeUSD = 0.5; // placeholder
  const depositFeeUSD = 0.2;
  const totalNetworkFees = withdrawalFeeUSD + depositFeeUSD;
  const slippage = investment * 0.002;
  const totalFees = totalTradingFees + totalNetworkFees + slippage;
  const grossProfit = (sellPrice - buyPrice) * amount;
  const netProfit = grossProfit - totalFees;
  const roi = (netProfit / investment) * 100;

  // Create trade record
  const trade = new Trade({
    user: session.username,
    symbol,
    buyExchange: buyExchange,
    sellExchange: sellExchange,
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

  // Return trade details
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
app.get('/api/trades', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = await Session.findOne({ token });
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const trades = await Trade.find({ user: session.username }).sort({ createdAt: -1 });
  res.json(trades);
});
