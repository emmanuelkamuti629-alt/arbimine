require("dotenv").config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== WEBHOOK MIDDLEWARE ====================
// Must be defined BEFORE express.json() to capture raw buffer
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.sendStatus(400);

    const hash = crypto
        .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
        .update(req.body) // Use raw buffer
        .digest('hex');

    if (hash !== signature) {
        console.warn('❌ Webhook signature mismatch');
        return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());
    
    if (event.event === 'charge.success') {
        const { reference, metadata } = event.data;
        const { username, plan } = metadata;
        
        try {
            const days = plan === 'weekly' ? 7 : 30;
            const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            
            await Transaction.findOneAndUpdate({ reference }, { status: 'success', paystackResponse: event });
            await User.findOneAndUpdate({ username }, { 
                'subscription.active': true, 
                'subscription.plan': plan, 
                'subscription.expiresAt': expiresAt 
            });
            console.log(`✅ Webhook: Subscription updated for ${username}`);
        } catch (err) {
            console.error('Webhook processing error:', err);
        }
    }
    res.sendStatus(200);
});

// ==================== GLOBAL MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== DATABASE & SCHEMAS ====================
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/arbimine')
  .then(() => console.log('✅ MongoDB connected'));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    passwordHash: String,
    subscription: { active: Boolean, plan: String, expiresAt: Date },
    blocked: { type: Boolean, default: false }
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({
    reference: { type: String, unique: true },
    user: String,
    status: { type: String, default: 'pending' },
    paystackResponse: mongoose.Schema.Types.Mixed
}));

const Session = mongoose.model('Session', new mongoose.Schema({
    token: String,
    username: String,
    createdAt: { type: Date, default: Date.now, expires: '7d' }
}));

// ==================== ROUTES ====================
app.post('/api/paystack/pay', async (req, res) => {
    try {
        const { plan } = req.body;
        const token = req.headers.authorization;
        const session = await Session.findOne({ token });
        const user = await User.findOne({ username: session.username });

        const reference = `arbimine_${user.username}_${Date.now()}`;
        const amount = plan === 'weekly' ? 10000 : 35000; // In Kobo (100 KES = 10000)

        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: user.email,
            amount,
            reference,
            metadata: { plan, username: user.username }
        }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });

        await Transaction.create({ reference, user: user.username, status: 'pending' });
        res.json({ success: true, authorizationUrl: response.data.data.authorization_url });
    } catch (err) {
        res.status(500).json({ error: 'Payment initialization failed' });
    }
});

// Callback is for user redirection ONLY
app.get('/api/payment/callback', (req, res) => {
    const { reference } = req.query;
    res.redirect(`${process.env.APP_URL}/?payment_status=success&reference=${reference}`);
});

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));

