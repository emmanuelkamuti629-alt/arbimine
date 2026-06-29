function displayDetails(opp) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = (val ?? "—");
  };

  const buy = Number(opp.buyPrice);
  const sell = Number(opp.sellPrice);

  if (!buy || !sell) return;

  const symbol = opp.symbol || "UNKNOWN";

  const priceDiff = sell - buy;
  const profitPercent = (priceDiff / buy) * 100;

  const tradeSize = opp.tradeSize || 100;

  const profitUSD = (priceDiff / buy) * tradeSize;

  set("detailSymbol", symbol);
  set("detailBuyExchange", opp.buyExchange);
  set("detailSellExchange", opp.sellExchange);

  set("detailSpread", profitPercent.toFixed(2) + "%");

  set("detailBuyPrice", "$" + buy.toFixed(8));
  set("detailSellPrice", "$" + sell.toFixed(8));

  set("detailPriceDiff", "$" + priceDiff.toFixed(8));
  set("detailProfit", "$" + profitUSD.toFixed(2));

  let riskScore = 0;

  if (profitPercent < 0.5) riskScore += 3;
  else if (profitPercent < 1) riskScore += 2;
  else riskScore += 1;

  if ((opp.liquidityScore || 0) < 70) riskScore += 2;

  const risk =
    riskScore >= 4 ? "HIGH" :
    riskScore >= 2 ? "MEDIUM" :
    "LOW";

  set("detailRisk", risk);

  const confidence = Math.max(0, Math.min(100,
    100 - (riskScore * 15) + profitPercent * 5
  ));

  set("detailConfidence", confidence.toFixed(0) + "%");

  const liqScore = opp.liquidityScore || 75;
  set("detailLiquidityScore", liqScore + "%");

  const rec =
    `Buy on ${opp.buyExchange || "—"} and sell on ${opp.sellExchange || "—"}. ` +
    `Profit: $${profitUSD.toFixed(2)} (${profitPercent.toFixed(2)}%). ` +
    `Risk: ${risk}. Confidence: ${confidence.toFixed(0)}%.`;

  const recEl = document.getElementById("aiRecommendation");
  if (recEl) recEl.innerText = rec;
}
