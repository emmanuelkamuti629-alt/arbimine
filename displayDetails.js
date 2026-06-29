function displayDetails(opp) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = val ?? "—";
  };

  const buy = Number(opp.buyPrice);
  const sell = Number(opp.sellPrice);

  if (!buy || !sell) return;

  const profitPercent = ((sell - buy) / buy) * 100;

  set("detailSymbol", opp.symbol);
  set("detailBuyExchange", opp.buyExchange);
  set("detailSellExchange", opp.sellExchange);

  set("detailBuyPrice", "$" + buy.toFixed(8));
  set("detailSellPrice", "$" + sell.toFixed(8));

  set("detailSpread", profitPercent.toFixed(2) + "%");

  const risk =
    profitPercent >= 1.5 ? "LOW" :
    profitPercent >= 0.8 ? "MEDIUM" :
    "HIGH";

  set("detailRisk", risk);

  const confidence = Math.max(0, Math.min(100,
    100 - (risk === "HIGH" ? 40 : risk === "MEDIUM" ? 20 : 5)
  ));

  set("detailConfidence", confidence.toFixed(0) + "%");

  const rec =
    `Buy ${opp.symbol} on ${opp.buyExchange} and sell on ${opp.sellExchange}. Spread: ${profitPercent.toFixed(2)}%.`;

  const recEl = document.getElementById("aiRecommendation");
  if (recEl) recEl.innerText = rec;
}
