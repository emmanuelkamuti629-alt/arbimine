function calculateScore(opportunity) {
  const spread = Number(opportunity.spread || 0);
  const liquidity = Number(opportunity.liquidityScore || 50);
  const risk = opportunity.risk || "medium";

  let riskFactor = 1;

  if (risk === "low") riskFactor = 1.2;
  if (risk === "medium") riskFactor = 1;
  if (risk === "high") riskFactor = 0.7;

  const score = (spread * 0.6 + liquidity * 0.4) * riskFactor;

  return Math.min(100, Math.max(0, score.toFixed(2)));
}

module.exports = { calculateScore };
