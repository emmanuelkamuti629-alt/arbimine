require("dotenv").config();
const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// -------------------- MongoDB --------------------
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crypto_scanner';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// -------------------- Middleware --------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------- Schemas --------------------

// User (extended)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email:    { type: String, required: true, unique: true },
  mpesa:    { type: String, required: true },
  passwordHash: { type: String, required: true },
  subscription: {
    plan: { type: String, enum: ['free', 'weekly', 'monthly'], default: 'free' },
    expiresAt: { type: Date, default: null }
  },
  isActive: { type: Boolean, default: true },
  isBlocked: { type: Boolean, default: false }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// Admin
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true }
});
const Admin = mongoose.model('Admin', adminSchema);

// Message
const messageSchema = new mongoose.Schema({
  from: { type: String, required: true },    // "admin" or userId (string)
  to: { type: String, required: true },      // "admin" or userId
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['sent','delivered','read'], default: 'sent' },
  edited: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false }
});
const Message = mongoose.model('Message', messageSchema);

// -------------------- Password Helpers --------------------
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}
function generateSalt() { return crypto.randomBytes(16).toString('hex'); }

// -------------------- Exchange Helper (public only) --------------------
function getExchange(exchangeId) {
  const ExchangeClass = ccxt[exchangeId];
  if (!ExchangeClass) throw new Error(`Exchange "${exchangeId}" not supported.`);
  return new ExchangeClass({ enableRateLimit: true });
}

// -------------------- Routes: Public Exchange Data --------------------
app.get('/api/exchanges', (req, res) => res.json({ exchanges: ccxt.exchanges }));
app.get('/api/markets/:exchange', async (req, res) => {
  try {
    const exchange = getExchange(req.params.exchange);
    const markets = await exchange.fetchMarkets();
    res.json(markets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/ticker/:exchange/:symbol', async (req, res) => {
  try {
    const ex = getExchange(req.params.exchange);
    const ticker = await ex.fetchTicker(req.params.symbol);
    res.json(ticker);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/orderbook/:exchange/:symbol', async (req, res) => {
  try {
    const ex = getExchange(req.params.exchange);
    const limit = parseInt(req.query.limit) || 10;
    const orderbook = await ex.fetchOrderBook(req.params.symbol, limit);
    res.json(orderbook);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/ohlcv/:exchange/:symbol', async (req, res) => {
  try {
    const ex = getExchange(req.params.exchange);
    const timeframe = req.query.timeframe || '1m';
    const limit = parseInt(req.query.limit) || 100;
    const ohlcv = await ex.fetchOHLCV(req.params.symbol, timeframe, undefined, limit);
    res.json(ohlcv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/balance', (req, res) => {
  res.status(403).json({ error: 'Private endpoints not supported.' });
});

// -------------------- Routes: User Management --------------------
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, mpesa, password } = req.body;
    if (!username || !email || !mpesa || !password)
      return res.status(400).json({ error: 'All fields required.' });
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) return res.status(409).json({ error: 'Username or email taken.' });
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);
    const user = new User({ username, email, mpesa, passwordHash: `${salt}:${passwordHash}` });
    await user.save();
    res.status(201).json({ message: 'User created.', userId: user._id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    const [salt, storedHash] = user.passwordHash.split(':');
    const incomingHash = await hashPassword(password, salt);
    if (incomingHash !== storedHash) return res.status(401).json({ error: 'Invalid credentials.' });
    res.json({ message: 'Login successful.', userId: user._id, subscription: user.subscription });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- Get User Profile (for frontend) --------------------
app.get('/api/user/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id, '-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- Paystack Subscription --------------------
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PLANS = { weekly: { amount: 100, duration: 7 }, monthly: { amount: 350, duration: 30 } };
function getExpiryDate(plan) {
  const days = PLANS[plan]?.duration || 0;
  if (!days) return null;
  const now = new Date(); now.setDate(now.getDate() + days); return now;
}

app.post('/api/subscribe', async (req, res) => {
  try {
    const { userId, plan, email } = req.body;
    if (!userId || !plan || !email) return res.status(400).json({ error: 'userId, plan, email required.' });
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan.' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const amountInKobo = PLANS[plan].amount * 100;
    const reference = `sub_${user._id}_${Date.now()}`;
    const response = await axios.post('https://api.paystack.co/transaction/initialize',
      { email, amount: amountInKobo, reference, metadata: { userId: user._id.toString(), plan },
        callback_url: `${req.protocol}://${req.get('host')}/api/verify-payment` },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } }
    );
    if (response.data.status) {
      res.json({ authorization_url: response.data.data.authorization_url, reference: response.data.data.reference });
    } else throw new Error(response.data.message || 'Paystack init failed');
  } catch (error) {
    res.status(500).json({ error: error.response?.data?.message || error.message });
  }
});

app.get('/api/verify-payment', async (req, res) => {
  try {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ error: 'Reference required.' });
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    const data = response.data;
    if (!data.status || data.data.status !== 'success')
      return res.status(400).json({ error: 'Payment not successful.' });
    const metadata = data.data.metadata || {};
    const userId = metadata.userId, plan = metadata.plan;
    if (!userId || !plan) return res.status(400).json({ error: 'Missing metadata.' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    user.subscription.plan = plan;
    user.subscription.expiresAt = getExpiryDate(plan);
    await user.save();
    res.json({ message: `Subscription updated to ${plan} plan.` });
  } catch (error) {
    res.status(500).json({ error: error.response?.data?.message || error.message });
  }
});

app.post('/api/paystack-webhook', async (req, res) => {
  const paystackSignature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(JSON.stringify(req.body)).digest('hex');
  if (hash !== paystackSignature) return res.status(401).send('Unauthorized');
  const event = req.body;
  if (event.event === 'charge.success') {
    const data = event.data, metadata = data.metadata || {};
    const userId = metadata.userId, plan = metadata.plan;
    if (userId && plan && PLANS[plan]) {
      try {
        const user = await User.findById(userId);
        if (user) {
          user.subscription.plan = plan;
          user.subscription.expiresAt = getExpiryDate(plan);
          await user.save();
          console.log(`✅ Webhook: User ${userId} upgraded to ${plan}`);
        }
      } catch (err) { console.error('Webhook error:', err); }
    }
  }
  res.sendStatus(200);
});

// -------------------- Admin Authentication --------------------
const adminTokens = new Map();

async function ensureAdmin() {
  const adminExists = await Admin.findOne({ username: 'admin' });
  if (!adminExists) {
    const salt = generateSalt();
    const hash = await hashPassword('admin123', salt);
    const admin = new Admin({ username: 'admin', passwordHash: `${salt}:${hash}` });
    await admin.save();
    console.log('🔐 Default admin created: username=admin, password=admin123');
  }
}
ensureAdmin();

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    const admin = await Admin.findOne({ username });
    if (!admin) return res.status(401).json({ error: 'Invalid credentials.' });
    const [salt, storedHash] = admin.passwordHash.split(':');
    const incomingHash = await hashPassword(password, salt);
    if (incomingHash !== storedHash) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.set(token, { adminId: admin._id, username: admin.username });
    res.json({ message: 'Admin login successful.', token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function verifyAdmin(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  req.admin = adminTokens.get(token);
  next();
}

// -------------------- Admin Routes --------------------
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const users = await User.find({}, '-passwordHash');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/user/:id/activate', verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    user.isActive = !user.isActive;
    await user.save();
    res.json({ message: `User active status toggled to ${user.isActive}.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/user/:id/block', verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    user.isBlocked = !user.isBlocked;
    await user.save();
    res.json({ message: `User blocked status toggled to ${user.isBlocked}.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- Chat Routes (REST) --------------------
app.get('/api/messages/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const messages = await Message.find({
      $or: [
        { from: userId, to: 'admin' },
        { from: 'admin', to: userId }
      ],
      deleted: false
    }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { from, to, content } = req.body;
    if (!from || !to || !content) return res.status(400).json({ error: 'Missing fields.' });
    const message = new Message({ from, to, content, status: 'sent' });
    await message.save();
    io.to(to).emit('new_message', message);
    io.to(from).emit('new_message', message);
    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, userId } = req.body;
    if (!content || !userId) return res.status(400).json({ error: 'Missing content or userId.' });
    const message = await Message.findById(id);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    if (message.from !== userId && userId !== 'admin') {
      return res.status(403).json({ error: 'Not allowed to edit this message.' });
    }
    message.content = content;
    message.edited = true;
    await message.save();
    io.to(message.to).emit('message_edited', message);
    io.to(message.from).emit('message_edited', message);
    res.json(message);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId.' });
    const message = await Message.findById(id);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    if (message.from !== userId && userId !== 'admin') {
      return res.status(403).json({ error: 'Not allowed to delete this message.' });
    }
    message.deleted = true;
    await message.save();
    io.to(message.to).emit('message_deleted', { id: message._id });
    io.to(message.from).emit('message_deleted', { id: message._id });
    res.json({ message: 'Message deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- Socket.IO --------------------
io.on('connection', (socket) => {
  console.log('🟢 New client connected:', socket.id);
  socket.on('join', (userId) => {
    if (userId) {
      socket.join(userId);
      console.log(`Socket ${socket.id} joined room ${userId}`);
    }
  });
  socket.on('send_message', async (data) => {
    try {
      const { from, to, content } = data;
      if (!from || !to || !content) return;
      const message = new Message({ from, to, content, status: 'sent' });
      await message.save();
      io.to(to).emit('new_message', message);
      io.to(from).emit('new_message', message);
      setTimeout(async () => {
        message.status = 'delivered';
        await message.save();
        io.to(to).emit('message_status', { id: message._id, status: 'delivered' });
        io.to(from).emit('message_status', { id: message._id, status: 'delivered' });
      }, 1000);
    } catch (error) {
      console.error('Socket send error:', error);
    }
  });
  socket.on('mark_read', async (messageId) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;
      message.status = 'read';
      await message.save();
      io.to(message.from).emit('message_status', { id: message._id, status: 'read' });
      io.to(message.to).emit('message_status', { id: message._id, status: 'read' });
    } catch (error) {
      console.error('Read receipt error:', error);
    }
  });
  socket.on('disconnect', () => {
    console.log('🔴 Client disconnected:', socket.id);
  });
});

// -------------------- Serve Admin Page --------------------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// -------------------- Start Server --------------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
});
