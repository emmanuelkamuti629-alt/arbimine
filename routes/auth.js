
const auth = require('../middleware/auth');

router.get('/me', auth, async (req, res) => {
  res.json({ 
    username: req.user.username, 
    email: req.user.email, 
    tier: req.user.subscription.active ? req.user.subscription.plan : 'free',
    referralCode: req.user.referralCode,
    mpesa: req.user.mpesa,
    expiresAt: req.user.subscription.expiresAt
  });
});
