const express = require('express');
const Opportunity = require('../../models/Opportunity');
const Message = require('../../models/Message');
const auth = require('../../middleware/auth');
const router = express.Router();

// GET all opportunities for Home tab
router.get('/opportunities', async (req, res) => {
  const opportunities = await Opportunity.find().sort('-spread').limit(100);
  const lastScan = await Opportunity.findOne().sort('-updatedAt');
  res.json({ 
    opportunities, 
    lastScan: lastScan?.updatedAt 
  });
});

// GET single opportunity details for calculator modal
router.get('/opportunity/:id/details', async (req, res) => {
  const opp = await Opportunity.findById(req.params.id);
  if (!opp) return res.status(404).json({ error: 'Not found' });
  res.json(opp);
});

// GET user messages for Help tab
router.get('/messages', auth, async (req, res) => {
  const msgs = await Message.find({ user: req.user.username }).sort('createdAt');
  res.json(msgs);
});

// POST new message from user -> white tick
router.post('/messages', auth, async (req, res) => {
  if (req.user.blocked) return res.status(403).json({ error: 'Blocked' });
  const msg = await Message.create({ 
    user: req.user.username, 
    userId: req.user._id,
    content: req.body.content, 
    isAdmin: false,
    read: false 
  });
  res.json(msg);
});

// DELETE message - user can delete own
router.delete('/message/:id', auth, async (req, res) => {
  const msg = await Message.findById(req.params.id);
  if (!msg || msg.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  await Message.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// EDIT message - user can edit own
router.put('/message/:id', auth, async (req, res) => {
  const msg = await Message.findById(req.params.id);
  if (!msg || msg.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  msg.content = req.body.content;
  await msg.save();
  res.json({ success: true });
});

module.exports = router;
