function renderOpportunity(opps) {
  const container = document.getElementById("opportunitiesList");
  if (!container) return;

  container.innerHTML = "";

  opps.forEach(opp => {
    const div = document.createElement("div");

    div.className = "opportunity-card";

    div.innerHTML = `
      <h3>${opp.symbol}</h3>
      <p>Spread: ${(opp.spread || 0).toFixed(2)}%</p>
      <p>Buy: ${opp.buyExchange}</p>
      <p>Sell: ${opp.sellExchange}</p>
      <button onclick='displayDetails(${JSON.stringify(opp)})'>
        View Details
      </button>
    `;

    container.appendChild(div);
  });
}
