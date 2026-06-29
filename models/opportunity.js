const mongoose = require('mongoose');

const NetworkSchema = new mongoose.Schema({
  name: String,
  fee: Number,
  feeUnit: String,
  withdraw: Boolean,
  deposit: Boolean,
  minWithdraw: Number
});

const OpportunitySchema = new mongoose.Schema({
  symbol: String,
  buyExchange: String,
  sellExchange: String,
  buyPrice: Number,
  sellPrice: Number,
  spread: Number,
  tradable: Boolean,
  risk: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  buyNetworks: { type: Map, of: NetworkSchema },
  sellNetworks: { type: Map, of: NetworkSchema },
  updatedAt: { type: Date, default: Date.now }
});

OpportunitySchema.index({ symbol: 1, buyExchange: 1, sellExchange: 1 }, { unique: true });
module.exports = mongoose.model('Opportunity', OpportunitySchema);
