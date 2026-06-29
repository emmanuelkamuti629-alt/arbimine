
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = (val ?? "—");
  };

  document.getElementById("detailSymbol").innerText = opp.symbol || "—";
  document.getElementById("detailBuyExchange").innerText = opp.buyExchange || "—";
  document.getElementById("detailSellExchange").innerText = opp.sellExchange || "—";
  document.getElementById("detailSpread").innerText = (opp.spread || 0) + "%";

  const buy = parseFloat(opp.buyPrice) || 0;
  const sell = parseFloat(opp.sellPrice) || 0;

  document.getElementById("detailBuyPrice").innerText = "$" + buy.toFixed(8);
  document.getElementById("detailSellPrice").innerText = "$" + sell.toFixed(8);
  document.getElementById("detailPriceDiff").innerText = "$" + (sell - buy).toFixed(8);

  const profit = (sell - buy) * 100;
  document.getElementById("detailProfit").innerText = "$" + profit.toFixed(2);

  const depth = (buy + sell) / 2 * 1000 * (0.8 + 0.4 * Math.random());
  const liqScore = opp.liquidityScore || (60 + Math.random() * 30);

  document.getElementById("detailDepth").innerText = "$" + depth.toFixed(0);
  document.getElementById("detailLiquidityScore").innerText = liqScore.toFixed(0) + "%";

  set("detailQualityScore", opp.qualityScore);
  set("detailROI", opp.estimatedROI);
  set("detailSafety", opp.opportunitySafetyScore);
  set("detailBestNetwork", opp.bestNetwork?.name);
  set("detailRisk", opp.risk);
  set("detailConfidence", opp.confidence);

  const rec =
    `Buy on ${opp.buyExchange || "—"} and sell on ${opp.sellExchange || "—"}. ` +
    (opp.tradable
      ? "Transfer using available networks. "
      : "No common network found. ") +
    `Risk: ${opp.risk || "medium"}.`;

  document.getElementById("aiRecommendation").innerText = rec;
}

