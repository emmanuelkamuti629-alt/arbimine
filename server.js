require("dotenv").config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ccxt = require('ccxt');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const nodemailer = require("nodemailer");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.set('trust proxy', 1);

// ==================== MongoDB ====================
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err.message));
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine';
// Create indexes for faster admin queries
User.createIndexes({ email: 1 });
User.createIndexes({ username: 1 });
Transaction.createIndexes({ user: 1, status: 1, createdAt: -1 });
Message.createIndexes({ user: 1, createdAt: -1 });
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ==================== Middleware ====================
app.post('/api/paystack/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-paystack-signature'];
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');
    if (hash !== signature) {
      console.log('Webhook signature mismatch');
      return res.status(401).send('Unauthorized');
    }
    const event = JSON.parse(req.body.toString());
    console.log('Paystack Webhook received:', event);
    res.sendStatus(200);
  }
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Rate Limiting ====================
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ==================== Schemas ====================
const sessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: '7d' }
});
const messageSchema = new mongoose.Schema({
  user: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  content: { type: String, required: true },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  edited: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const blockedUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  blockedAt: { type: Date, default: Date.now }
});
const transactionSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  user: { type: String, required: true },
  plan: { type: String, enum: ['weekly', 'monthly', 'threeDay'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  paymentData: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  mpesa: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  isBlocked: { type: Boolean, default: false },
  subscription: {
    active: { type: Boolean, default: false },
    plan: { type: String, enum: ['weekly', 'monthly', 'threeDay', null], default: null },
    expiresAt: { type: Date, default: null }
  },
  createdAt: { type: Date, default: Date.now }
});

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  totpSecret: { type: String, default: null },
  isTotpEnabled: { type: Boolean, default: false }
});

// Plan Settings Schema
const planSettingsSchema = new mongoose.Schema({
  weeklyAmount: { type: Number, default: 261 },
  weeklyDuration: { type: Number, default: 7 },
  monthlyAmount: { type: Number, default: 900 },
  monthlyDuration: { type: Number, default: 30 },
  threeDayAmount: { type: Number, default: 150 },
  threeDayDuration: { type: Number, default: 3 }
});

// Settings Schema for referral
const settingsSchema = new mongoose.Schema({
  referralBaseUrl: { type: String, default: "https://arbimine-miyc.onrender.com" },
  updatedAt: { type: Date, default: Date.now }
});
const Settings = mongoose.model("Settings", settingsSchema);

const Session = mongoose.model('Session', sessionSchema);
const Message = mongoose.model('Message', messageSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const User = mongoose.model('User', userSchema);
const Admin = mongoose.model('Admin', adminSchema);
const PlanSettings = mongoose.model('PlanSettings', planSettingsSchema);

const generateToken = () => crypto.randomBytes(32).toString('hex');

// ==================== Admin Auth & 2FA ====================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function generateAdminToken(username) {
  return jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
}

function verifyAdminToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.role === 'admin';
  } catch {
    return false;
  }
}

const tempAdminSessions = new Map();
const pendingTotpSecrets = new Map();

async function ensureAdmin() {
  const admin = await Admin.findOne({ username: ADMIN_USERNAME });
  if (!admin) {
    const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const newAdmin = new Admin({ username: ADMIN_USERNAME, passwordHash: hashed, isTotpEnabled: false });
    await newAdmin.save();
    console.log('🔐 Default admin created (2FA disabled)');
  }
}
ensureAdmin();

async function ensurePlanSettings() {
  const settings = await PlanSettings.findOne();
  if (!settings) {
    const defaultSettings = new PlanSettings({
      weeklyAmount: 261,
      weeklyDuration: 7,
      monthlyAmount: 900,
      monthlyDuration: 30,
      threeDayAmount: 150,
      threeDayDuration: 3
    });
    await defaultSettings.save();
    console.log('📊 Default plan settings created');
  }
}
ensurePlanSettings();

async function ensureSettings() {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = new Settings({ referralBaseUrl: "https://arbimine-miyc.onrender.com" });
    await settings.save();
    console.log("⚙️ Default referral settings created");
  }
}
ensureSettings();

// Step 1: Admin login
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const admin = await Admin.findOne({ username });
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, admin.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  if (admin.isTotpEnabled) {
    const tempToken = crypto.randomBytes(32).toString('hex');
    tempAdminSessions.set(tempToken, {
      username,
      expires: Date.now() + 5 * 60 * 1000
    });
    return res.json({ success: true, tempToken, requiresOtp: true });
  } else {
    const token = generateAdminToken(username);
    return res.json({ success: true, token });
  }
});

// Step 2: Verify OTP for admin login
app.post('/admin/verify-otp', async (req, res) => {
  const { tempToken, otp } = req.body;
  if (!tempToken || !otp) return res.status(400).json({ error: 'Missing temporary token or OTP' });

  const session = tempAdminSessions.get(tempToken);
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: 'Temporary session expired or invalid' });
  }

  const admin = await Admin.findOne({ username: session.username });
  if (!admin || !admin.totpSecret) {
    return res.status(401).json({ error: '2FA not configured' });
  }

  const isValid = authenticator.verify({ token: otp, secret: admin.totpSecret });
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid OTP' });
  }

  tempAdminSessions.delete(tempToken);
  const token = generateAdminToken(session.username);
  res.json({ success: true, token });
});

// Admin 2FA settings
app.get('/admin/settings/totp/status', adminAuth, async (req, res) => {
  try {
    const admin = await Admin.findOne({ username: ADMIN_USERNAME });
    res.json({ enabled: admin?.isTotpEnabled || false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/settings/totp/generate', adminAuth, async (req, res) => {
  try {
    const admin = await Admin.findOne({ username: ADMIN_USERNAME });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const secret = authenticator.generateSecret();
    pendingTotpSecrets.set(admin._id.toString(), { secret, expires: Date.now() + 10 * 60 * 1000 });

    const otpauth = authenticator.keyuri(admin.username, 'ArbiMine', secret);
    const qrImage = await QRCode.toDataURL(otpauth);

    res.json({ secret, qrImage, otpauth });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/settings/totp/verify', adminAuth, async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: 'OTP required' });

    const admin = await Admin.findOne({ username: ADMIN_USERNAME });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const pending = pendingTotpSecrets.get(admin._id.toString());
    if (!pending || pending.expires < Date.now()) {
      return res.status(400).json({ error: 'No pending 2FA setup or session expired' });
    }

    const isValid = authenticator.verify({ token: otp, secret: pending.secret });
    if (!isValid) return res.status(400).json({ error: 'Invalid OTP' });

    admin.totpSecret = pending.secret;
    admin.isTotpEnabled = true;
    await admin.save();

    pendingTotpSecrets.delete(admin._id.toString());
    res.json({ success: true, message: '2FA enabled successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/settings/totp/disable', adminAuth, async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: 'OTP required' });

    const admin = await Admin.findOne({ username: ADMIN_USERNAME });
    if (!admin || !admin.isTotpEnabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    const isValid = authenticator.verify({ token: otp, secret: admin.totpSecret });
    if (!isValid) return res.status(400).json({ error: 'Invalid OTP' });

    admin.totpSecret = null;
    admin.isTotpEnabled = false;
    await admin.save();

    res.json({ success: true, message: '2FA disabled successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function adminAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token || !verifyAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ==================== Plan Settings Admin Endpoints ====================
app.get('/admin/settings/plans', adminAuth, async (req, res) => {
  try {
    const settings = await PlanSettings.findOne();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/admin/settings/plans', adminAuth, async (req, res) => {
  try {
    const { weeklyAmount, weeklyDuration, monthlyAmount, monthlyDuration, threeDayAmount, threeDayDuration } = req.body;
    if (weeklyAmount === undefined || weeklyDuration === undefined || monthlyAmount === undefined || monthlyDuration === undefined ||
        threeDayAmount === undefined || threeDayDuration === undefined) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (weeklyAmount <= 0 || monthlyAmount <= 0 || weeklyDuration <= 0 || monthlyDuration <= 0 ||
        threeDayAmount <= 0 || threeDayDuration <= 0) {
      return res.status(400).json({ error: 'All values must be positive' });
    }
    let settings = await PlanSettings.findOne();
    if (!settings) {
      settings = new PlanSettings();
    }
    settings.weeklyAmount = weeklyAmount;
    settings.weeklyDuration = weeklyDuration;
    settings.monthlyAmount = monthlyAmount;
    settings.monthlyDuration = monthlyDuration;
    settings.threeDayAmount = threeDayAmount;
    settings.threeDayDuration = threeDayDuration;
    await settings.save();
    res.json({ success: true, settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== Referral Settings ====================
app.get('/admin/settings', adminAuth, async (req, res) => {
  try {
    const settings = await Settings.findOne();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/admin/settings', adminAuth, async (req, res) => {
  try {
    const { referralBaseUrl } = req.body;
    if (!referralBaseUrl) return res.status(400).json({ error: "Referral URL required" });
    let settings = await Settings.findOne();
    if (!settings) settings = new Settings();
    settings.referralBaseUrl = referralBaseUrl;
    settings.updatedAt = new Date();
    await settings.save();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Broadcast Endpoint ====================
app.post('/admin/broadcast', adminAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const users = await User.find({}, "email mpesa");
    if (!users.length) {
      return res.status(404).json({ error: "No users found" });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    const fromPhone = process.env.TWILIO_PHONE_NUMBER;

    const results = { emails: 0, sms: 0, errors: [] };

    for (const user of users) {
      if (user.email) {
        try {
          await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: user.email,
            subject: "ArbiMine Pro – Admin Announcement",
            text: message,
            html: `<p>${message.replace(/\n/g, "<br>")}</p>`
          });
          results.emails++;
        } catch (err) {
          results.errors.push({ email: user.email, error: err.message });
        }
      }

      if (user.mpesa) {
        try {
          await client.messages.create({
            body: message,
            from: fromPhone,
            to: user.mpesa
          });
          results.sms++;
        } catch (err) {
          results.errors.push({ phone: user.mpesa, error: err.message });
        }
      }
    }

    res.json({
      success: true,
      sent: { emails: results.emails, sms: results.sms },
      errors: results.errors
    });
  } catch (err) {
    console.error("Broadcast error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Subscription Toggle ====================
app.post('/admin/user/:id/toggle-subscription', adminAuth, async (req, res) => {
  try {
    const { active, plan } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const settings = await PlanSettings.findOne();
    let expiresAt = null;
    if (active && plan) {
      let days;
      if (plan === "weekly") days = settings.weeklyDuration;
      else if (plan === "monthly") days = settings.monthlyDuration;
      else if (plan === "threeDay") days = settings.threeDayDuration;
      else days = 7;
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }
    user.subscription.active = active;
    user.subscription.plan = active ? plan : null;
    user.subscription.expiresAt = expiresAt;
    await user.save();
    res.json({ success: true, user: { username: user.username, subscription: user.subscription } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Public Plan Settings ====================
app.get('/api/plans', async (req, res) => {
  try {
    const settings = await PlanSettings.findOne();
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      threeDay: { amount: settings.threeDayAmount, duration: settings.threeDayDuration },
      weekly: { amount: settings.weeklyAmount, duration: settings.weeklyDuration },
      monthly: { amount: settings.monthlyAmount, duration: settings.monthlyDuration }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Referral Public Endpoint ====================
app.get('/api/referral', async (req, res) => {
  try {
    const settings = await Settings.findOne();
    res.set("Cache-Control", "public, max-age=60");
    res.json({ url: settings?.referralBaseUrl || "https://arbimine-miyc.onrender.com" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Routes (Users, Messages, etc.) ====================
app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}, '-passwordHash').limit(100).lean();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/transactions', adminAuth, async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/messages', adminAuth, async (req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/messages', adminAuth, async (req, res) => {
  const { userId, content } = req.body;
  if (!userId || !content) return res.status(400).json({ error: 'User and content required' });
  const msg = new Message({ user: userId, isAdmin: true, content: content.trim(), status: 'sent' });
  await msg.save();
  setTimeout(async () => {
    msg.status = 'delivered';
    await msg.save();
  }, 500);
  res.json({ success: true, message: msg });
});

app.delete('/admin/message/:id', adminAuth, async (req, res) => {
  try {
    await Message.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/admin/message/:id', adminAuth, async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });
  try {
    const msg = await Message.findByIdAndUpdate(req.params.id, { content: content.trim(), edited: true }, { new: true });
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/block/:username', adminAuth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.isBlocked = true;
    await user.save();
    res.json({ success: true, message: `User ${req.params.username} blocked` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/unblock/:username', adminAuth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.isBlocked = false;
    await user.save();
    res.json({ success: true, message: `User ${req.params.username} unblocked` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/user/:id/update-subscription', adminAuth, async (req, res) => {
  try {
    const { active, plan, expiresAt } = req.body;
    const updates = { 'subscription.active': active };
    if (plan) updates['subscription.plan'] = plan;
    if (active && !expiresAt) {
      const settings = await PlanSettings.findOne();
      let days;
      if (plan === 'weekly') days = settings.weeklyDuration;
      else if (plan === 'monthly') days = settings.monthlyDuration;
      else if (plan === 'threeDay') days = settings.threeDayDuration;
      else days = 7;
      updates['subscription.expiresAt'] = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    } else if (expiresAt) {
      updates['subscription.expiresAt'] = new Date(expiresAt);
    }
    await User.findByIdAndUpdate(req.params.id, updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/user/:id', adminAuth, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== User Auth ====================
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  if (verifyAdminToken(token)) {
    req.user = 'admin';
    return next();
  }
  try {
    const session = await Session.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    req.user = session.username;

    const user = await User.findOne({ username: req.user });
    if (user && user.subscription && user.subscription.expiresAt) {
      const now = new Date();
      if (user.subscription.expiresAt < now) {
        user.subscription.active = false;
        user.subscription.plan = null;
        await user.save();
      }
    }
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Auth error' });
  }
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, mpesa, password } = req.body;
    if (!username || !email || !mpesa || !password) return res.status(400).json({ error: 'All fields required' });

    const existing = await User.findOne({ $or: [{ username }, { email }, { mpesa }] });
    if (existing) {
      let error = 'Username, email, or M-Pesa already exists.';
      if (existing.username === username) error = 'Username already taken.';
      else if (existing.email === email) error = 'Email already registered.';
      else if (existing.mpesa === mpesa) error = 'M-Pesa number already in use.';
      return res.status(409).json({ error });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, email, mpesa, passwordHash: hashedPassword });
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
    const { username, email, password, mpesa } = req.body;
    const identifier = username || email || mpesa;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Identifier (username/email/mpesa) and password required' });
    }

    let user = await User.findOne({
      $or: [
        { username: identifier },
        { email: identifier },
        { mpesa: identifier }
      ]
    });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.isBlocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Contact support.' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken();
    await new Session({ token, username: user.username }).save();
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', authMiddleware, async (req, res) => {
  try {
    await Session.deleteOne({ token: req.headers.authorization });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ username: user.username, email: user.email, mpesa: user.mpesa });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/subscription', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const now = new Date();
    const isActive = user.subscription.active && user.subscription.expiresAt && user.subscription.expiresAt > now;
    const settings = await PlanSettings.findOne();
    res.json({
      active: isActive,
      plan: user.subscription.plan,
      expiresAt: user.subscription.expiresAt,
      plans: {
        threeDay: { amount: settings.threeDayAmount, duration: settings.threeDayDuration },
        weekly: { amount: settings.weeklyAmount, duration: settings.weeklyDuration },
        monthly: { amount: settings.monthlyAmount, duration: settings.monthlyDuration }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== User Settings ====================
app.post('/api/user/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Current password incorrect' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/change-mpesa', authMiddleware, async (req, res) => {
  try {
    const { newMpesa, password } = req.body;
    if (!newMpesa || !password) {
      return res.status(400).json({ error: 'New M-Pesa number and password required' });
    }
    if (!/^[0-9]+$/.test(newMpesa) || newMpesa.length < 10) {
      return res.status(400).json({ error: 'Invalid M-Pesa number (digits only, 10+)' });
    }

    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });

    const existing = await User.findOne({ mpesa: newMpesa });
    if (existing && existing.username !== req.user) {
      return res.status(409).json({ error: 'M-Pesa number already in use by another account' });
    }

    user.mpesa = newMpesa;
    await user.save();
    res.json({ success: true, message: 'M-Pesa number updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== Messaging ====================
app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBlocked) {
      return res.status(403).json({ error: 'Your account is blocked. You cannot send messages.' });
    }

    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message required' });

    const msg = new Message({ user: req.user, isAdmin: false, content: content.trim(), status: 'sent' });
    await msg.save();
    setTimeout(async () => {
      msg.status = 'delivered';
      await msg.save();
    }, 1000);
    res.json({ success: true, message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const messages = await Message.find({ user: req.user, deleted: false }).sort({ createdAt: -1 });
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.user !== req.user) return res.status(403).json({ error: 'Not your message' });
    if (msg.isAdmin) return res.status(403).json({ error: 'Cannot edit admin message' });
    msg.content = content.trim();
    msg.edited = true;
    await msg.save();
    res.json({ success: true, message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.user !== req.user) return res.status(403).json({ error: 'Not your message' });
    if (msg.isAdmin) return res.status(403).json({ error: 'Cannot delete admin message' });
    msg.deleted = true;
    await msg.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/messages/:id/read', authMiddleware, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.user !== req.user) return res.status(403).json({ error: 'Not your message' });
    if (!msg.isAdmin) return res.status(403).json({ error: 'Only admin messages can be marked read' });
    msg.status = 'read';
    await msg.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== Exchange Integration ====================
const EXCHANGE_IDS = [
  'kucoin', 'mexc', 'kraken', 'huobi', 'gateio', 'coinex', 'crypto', 'xt',
  'poloniex', 'bitfinex', 'upbit', 'whitebit', 'indodax'
];
const EXCHANGE_NAMES = {
  kucoin: 'KuCoin', mexc: 'MEXC', kraken: 'Kraken', huobi: 'HTX',
  gateio: 'Gate.io', coinex: 'CoinEx', crypto: 'Crypto.com', xt: 'XT.COM',
  poloniex: 'Poloniex', bitfinex: 'Bitfinex', upbit: 'Upbit',
  whitebit: 'WhiteBIT', indodax: 'Indodax'
};

const exchangeInstances = {};
for (const id of EXCHANGE_IDS) {
  try {
    const ExchangeClass = ccxt[id];
    if (!ExchangeClass) {
      console.warn(`⚠️ Exchange ${id} not supported – skipping`);
      continue;
    }
    const ex = new ExchangeClass({
      enableRateLimit: true,
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    exchangeInstances[id] = ex;
    console.log(`🔌 ${id} initialized (public)`);
  } catch (err) {
    console.error(`❌ Failed to init ${id}:`, err.message);
  }
}

async function loadAllMarkets() {
  for (const id of EXCHANGE_IDS) {
    const ex = exchangeInstances[id];
    if (!ex) continue;
    try {
      await ex.loadMarkets();
      console.log(`📊 Markets loaded for ${id}`);
    } catch (err) {
      console.log(`❌ Failed to load markets for ${id}:`, err.message);
    }
  }
}
loadAllMarkets();

// ==================== Scanning ====================
let cachedOpportunities = [];
let detailedCache = new Map();
let aiCache = new Map();
let lastFastScan = 0;
let lastDetailScan = 0;
const FAST_SCAN_INTERVAL = 60000;
const DETAIL_SCAN_INTERVAL = 120000;
const DETAIL_OPP_LIMIT = 200;
const MIN_PROFIT = 0.2;
const MAX_PROFIT = 100;
const FREE_TIER_MAX_SPREAD = 2.0;

const SYMBOL_BLACKLIST = new Set([
  'US', 'USD', 'MEA', 'SCA', 'AVAIL', 'HOME', 'GUA', 'ESPORTS', 'KRL',
  'SIREN', 'STG', 'VANRY', 'PRCL', 'DGB', 'SWEAT', 'NAVX', 'TAIKO',
  'DEXE', 'IOTX', 'VELODROME', 'SAND', 'MANA', 'CHZ', 'GALA'
]);

const AI_CACHE_TTL = 60 * 60 * 1000;
setInterval(() => {
  aiCache.clear();
  console.log('🧹 AI cache cleared');
}, AI_CACHE_TTL);

async function fastScan() {
  console.log('🔄 Fast scan using tickers only...');
  const start = Date.now();
  const allTickers = {};

  for (const id of EXCHANGE_IDS) {
    const ex = exchangeInstances[id];
    if (!ex) continue;
    try {
      const tickers = await ex.fetchTickers();
      allTickers[id] = tickers;
      console.log(`✅ ${id} tickers fetched (${Object.keys(tickers).length})`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`❌ ${id} ticker fetch failed:`, err.message);
    }
  }

  const pairMap = {};
  for (const [exId, tickers] of Object.entries(allTickers)) {
    if (!tickers) continue;
    for (const [pair, ticker] of Object.entries(tickers)) {
      const isUSDT = pair.endsWith('/USDT');
      const isIDR = pair.endsWith('/IDR') && exId === 'indodax';
      if (!isUSDT && !isIDR) continue;
      let symbol = pair.replace('/USDT', '').replace('/IDR', '');
      if (SYMBOL_BLACKLIST.has(symbol)) continue;
      const price = ticker.last || ticker.ask || ticker.bid || 0;
      if (!price || price <= 0) continue;
      const volume = ticker.quoteVolume || ticker.volume || 0;
      if (!pairMap[symbol]) pairMap[symbol] = {};
      pairMap[symbol][exId] = {
        price: price,
        volume: volume,
        pair: pair,
        bid: ticker.bid || 0,
        ask: ticker.ask || 0,
        timestamp: ticker.timestamp || Date.now(),
        currency: isUSDT ? 'USDT' : 'IDR'
      };
    }
  }

  const opportunities = [];
  for (const [symbol, exchanges] of Object.entries(pairMap)) {
    const entries = Object.entries(exchanges);
    if (entries.length < 2) continue;
    const usdtEntries = entries.filter(([_, data]) => data.currency === 'USDT');
    if (usdtEntries.length < 2) continue;
    usdtEntries.sort((a, b) => a[1].price - b[1].price);
    const [buyEx, buy] = usdtEntries[0];
    const [sellEx, sell] = usdtEntries[usdtEntries.length - 1];
    const spread = ((sell.price - buy.price) / buy.price) * 100;
    if (spread < MIN_PROFIT || spread > MAX_PROFIT) continue;
    let liquidity = buy.volume ? buy.volume * buy.price : 0;
    if (liquidity === 0) liquidity = buy.price * 50000 * (spread > 10 ? 0.3 : spread > 5 ? 0.6 : 1);
    opportunities.push({
      id: `${symbol}-${buyEx}-${sellEx}`,
      symbol,
      buyExchange: EXCHANGE_NAMES[buyEx] || buyEx.toUpperCase(),
      sellExchange: EXCHANGE_NAMES[sellEx] || sellEx.toUpperCase(),
      buyPrice: buy.price.toFixed(8),
      sellPrice: sell.price.toFixed(8),
      spread: spread.toFixed(2),
      liquidity: liquidity.toFixed(0),
      buyPair: buy.pair,
      sellPair: sell.pair,
      buyBid: buy.bid,
      buyAsk: buy.ask,
      sellBid: sell.bid,
      sellAsk: sell.ask,
      timestamp: buy.timestamp || sell.timestamp || Date.now(),
      volume: buy.volume || sell.volume || 0,
      tradable: true,
      risk: 'medium',
      buyNetworks: {},
      sellNetworks: {},
      buyWithdraw: false,
      sellDeposit: false
    });
  }

  cachedOpportunities = opportunities.sort((a, b) => +b.spread - +a.spread);
  lastFastScan = Date.now();
  console.log(`✅ Fast scan: ${cachedOpportunities.length} opportunities in ${Date.now() - start}ms`);

  if (cachedOpportunities.length > 0) {
    detailScan();
  }
}

async function fetchRealNetworks(exchangeId, coin) {
  const ex = exchangeInstances[exchangeId.toLowerCase()];
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
  const ex = exchangeInstances[exchangeId.toLowerCase()];
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
    .slice(0, DETAIL_OPP_LIMIT);

  let updated = 0;
  for (const opp of validOpps) {
    const coin = opp.symbol;
    const buyEx = opp.buyExchange.toLowerCase();
    const sellEx = opp.sellExchange.toLowerCase();
    try {
      const [buyNet, sellNet, buyLiq, sellLiq] = await Promise.all([
        fetchRealNetworks(buyEx, coin),
        fetchRealNetworks(sellEx, coin),
        fetchLiquidity(buyEx, opp.buyPair),
        fetchLiquidity(sellEx, opp.sellPair)
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
        sellDeposit: sellNet?.canDeposit || false,
        volume: opp.volume || 0
      });
      updated++;
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.log(`Detail scan failed for ${opp.id}:`, err.message);
    }
  }

  lastDetailScan = Date.now();
  console.log(`✅ Detail scan: updated ${updated} opportunities in ${Date.now() - start}ms`);
}

setTimeout(fastScan, 5000);
setInterval(fastScan, FAST_SCAN_INTERVAL);
setInterval(() => { if (cachedOpportunities.length > 0) detailScan(); }, DETAIL_SCAN_INTERVAL);

// ==================== AI Integration ====================
const AI_API_URL = process.env.AI_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-3.5-turbo';

async function getAIAnalysis(opportunity) {
  if (!AI_API_KEY) {
    return getFallbackAnalysis(opportunity);
  }
  try {
    const response = await axios.post(AI_API_URL, {
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'You are a crypto arbitrage expert. Return JSON only with fields: score (0-100), risk (low/medium/high), recommendation (string), summary (string).' },
        { role: 'user', content: `Analyze this arbitrage opportunity:\nSymbol: ${opportunity.symbol}\nBuy Exchange: ${opportunity.buyExchange} at $${opportunity.buyPrice}\nSell Exchange: ${opportunity.sellExchange} at $${opportunity.sellPrice}\nSpread: ${opportunity.spread}%\nLiquidity: $${opportunity.liquidity}\nReturn valid JSON only.` }
      ],
      temperature: 0.3,
      max_tokens: 150
    }, {
      headers: {
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'https://arbimine-miyc.onrender.com',
        'X-Title': 'ArbiMine Pro'
      },
      timeout: 10000
    });
    const content = response.data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');
    const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      score: parsed.score || 50,
      risk: parsed.risk || 'medium',
      recommendation: parsed.recommendation || 'Consider',
      summary: parsed.summary || 'AI analysis generated.'
    };
  } catch (err) {
    console.error('AI API error:', err.message);
    return getFallbackAnalysis(opportunity);
  }
}

function getFallbackAnalysis(opportunity) {
  const spread = parseFloat(opportunity.spread) || 0;
  const liquidity = parseFloat(opportunity.liquidity) || 0;
  let score = 50, risk = 'medium', recommendation = 'Consider', summary = 'AI analysis unavailable.';
  if (spread > 1 && liquidity > 10000) { score = 85; risk = 'low'; recommendation = 'Strong buy'; summary = 'High spread and good liquidity.'; }
  else if (spread > 0.5 && liquidity > 5000) { score = 70; risk = 'medium'; recommendation = 'Moderate'; summary = 'Decent spread with adequate liquidity.'; }
  else if (spread > 0.3) { score = 55; risk = 'medium'; recommendation = 'Caution'; summary = 'Small spread, low profit potential.'; }
  else { score = 30; risk = 'high'; recommendation = 'Avoid'; summary = 'Low spread and low liquidity make this risky.'; }
  return { score, risk, recommendation, summary };
}

async function getAIAnalysisCached(opp) {
  const key = opp.id;
  if (aiCache.has(key)) return aiCache.get(key);
  const result = await getAIAnalysis(opp);
  if (result) aiCache.set(key, result);
  return result;
}

// ==================== Opportunities API ====================
app.get('/api/opportunities', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(401).json({ error: 'User not found' });

    const isPro = user.subscription && user.subscription.active && user.subscription.expiresAt && user.subscription.expiresAt > new Date();

    let filteredOpps = cachedOpportunities.map(opp => {
      const detailed = detailedCache.get(opp.id);
      return detailed || { ...opp, tradable: false, risk: 'medium', buyNetworks: {}, sellNetworks: {}, buyWithdraw: false, sellDeposit: false };
    });

    if (!isPro) {
      filteredOpps = filteredOpps.filter(opp => {
        const spread = parseFloat(opp.spread) || 0;
        return spread <= FREE_TIER_MAX_SPREAD;
      });
    }

    const top20 = filteredOpps.slice(0, 20);
    const aiPromises = top20.map(async (opp) => {
      const ai = await getAIAnalysisCached(opp);
      if (ai) {
        opp.aiScore = ai.score;
        opp.aiRisk = ai.risk;
        opp.aiRecommendation = ai.recommendation;
        opp.aiSummary = ai.summary;
      }
      return opp;
    });
    await Promise.all(aiPromises);

    const scanning = cachedOpportunities.length === 0 && Date.now() - lastFastScan > 5000;
    const totalAvailable = cachedOpportunities.length;
    const shownCount = filteredOpps.length;

    res.json({
      count: filteredOpps.length,
      opportunities: filteredOpps,
      totalAvailable,
      shownCount,
      isPro,
      freeTierLimit: FREE_TIER_MAX_SPREAD,
      lastScan: lastFastScan,
      lastDetail: lastDetailScan,
      scanning
    });
  } catch (err) {
    console.error('Opportunities error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/opportunity/:id/details', authMiddleware, async (req, res) => {
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
    fetchLiquidity(buyEx, opp.buyPair),
    fetchLiquidity(sellEx, opp.sellPair)
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
  const ai = await getAIAnalysisCached(opp);
  if (ai) {
    result.aiScore = ai.score;
    result.aiRisk = ai.risk;
    result.aiRecommendation = ai.recommendation;
    result.aiSummary = ai.summary;
  }
  detailedCache.set(id, result);
  res.json(result);
});

app.post('/api/ai/refresh/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const opp = cachedOpportunities.find(o => o.id === id);
  if (!opp) return res.status(404).json({ error: 'Not found' });
  aiCache.delete(id);
  const ai = await getAIAnalysis(opp);
  if (ai) {
    aiCache.set(id, ai);
    const detail = detailedCache.get(id);
    if (detail) {
      detail.aiScore = ai.score;
      detail.aiRisk = ai.risk;
      detail.aiRecommendation = ai.recommendation;
      detail.aiSummary = ai.summary;
      detailedCache.set(id, detail);
    }
    res.json({ success: true, ai });
  } else {
    res.status(500).json({ error: 'AI analysis failed' });
  }
});

// ==================== Balance endpoint ====================
app.get('/api/balance/:exchange', authMiddleware, async (req, res) => {
  res.json({ USDT: 1000, BTC: 0.01, ETH: 0.1 });
});

// ==================== Paystack ====================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const APP_URL = process.env.APP_URL || 'https://arbimine-miyc.onrender.com';

function getExpiryDate(plan, settings) {
  let days;
  if (plan === 'weekly') days = settings.weeklyDuration;
  else if (plan === 'monthly') days = settings.monthlyDuration;
  else if (plan === 'threeDay') days = settings.threeDayDuration;
  if (!days) return null;
  const now = new Date(); now.setDate(now.getDate() + days); return now;
}

function sanitizeReference(str) {
  return str.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/\s/g, '_');
}

app.post('/api/paystack/initialize', authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !['weekly', 'monthly', 'threeDay'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const user = await User.findOne({ username: req.user });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const settings = await PlanSettings.findOne();
    let amount;
    if (plan === 'weekly') amount = settings.weeklyAmount;
    else if (plan === 'monthly') amount = settings.monthlyAmount;
    else if (plan === 'threeDay') amount = settings.threeDayAmount;
    else amount = 0;
    const amountInKobo = amount * 100;
    const reference = `arbimine_${sanitizeReference(user.username)}_${Date.now()}`;

    const payload = {
      email: user.email,
      amount: amountInKobo,
      currency: 'KES',
      reference: reference,
      callback_url: `${APP_URL}/api/paystack/callback`,
      metadata: {
        plan: plan,
        username: user.username,
        user_id: user._id.toString()
      }
    };

    console.log('📤 Initializing Paystack payment:', payload);

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      payload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.status) {
      await Transaction.create({
        reference,
        user: user.username,
        plan,
        amount: amount,
        status: 'pending',
        paymentData: response.data
      });

      res.json({
        success: true,
        authorization_url: response.data.data.authorization_url,
        reference: response.data.data.reference
      });
    } else {
      throw new Error(response.data.message || 'Initialization failed');
    }
  } catch (err) {
    console.error('Paystack init error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.get('/api/paystack/callback', async (req, res) => {
  const { reference, status } = req.query;
  console.log('Paystack callback:', { reference, status });

  if (!reference) {
    return res.redirect('/#pro?payment=failed');
  }

  try {
    const verification = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
      }
    );

    const data = verification.data;
    if (data.status && data.data.status === 'success') {
      const metadata = data.data.metadata || {};
      const plan = metadata.plan;
      const username = metadata.username;

      await Transaction.findOneAndUpdate(
        { reference },
        { status: 'success', paymentData: data.data }
      );

      if (username && plan) {
        const settings = await PlanSettings.findOne();
        const expiresAt = getExpiryDate(plan, settings);
        await User.findOneAndUpdate(
          { username },
          { 'subscription.active': true, 'subscription.plan': plan, 'subscription.expiresAt': expiresAt }
        );
        console.log(`✅ Subscription activated for ${username} (${plan})`);
      }

      return res.redirect('/#pro?payment=success');
    } else {
      await Transaction.findOneAndUpdate(
        { reference },
        { status: 'failed', paymentData: data.data }
      );
      return res.redirect('/#pro?payment=failed');
    }
  } catch (err) {
    console.error('Verification error:', err.message);
    return res.redirect('/#pro?payment=failed');
  }
});

// ==================== Admin Panel ====================
// IMPORTANT: This route must come BEFORE app.use(express.static)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 ArbiMine running on ${PORT}`);
  console.log(`📊 Admin panel: ${PORT === 3000 ? 'http://localhost:3000/admin' : 'https://arbimine-miyc.onrender.com/admin'}`);
});
