const fs = require("fs");
const file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

const block = `
<!-- ================= OPPORTUNITY PANEL ================= -->
<div class="glass p-4 m-3 rounded-xl">
  <h2 class="text-lg font-bold">📈 Top Opportunity</h2>

  <div id="opportunityBox">Loading...</div>
</div>

<script>
async function loadOpportunity(){
  try{
    const res = await fetch('/api/opportunities');
    const data = await res.json();

    if(!data || !data.length){
      document.getElementById("opportunityBox").innerText="No opportunities";
      return;
    }

    const opp = data[0];

    document.getElementById("opportunityBox").innerHTML =
      "Pair: " + opp.symbol + "<br>" +
      "Spread: " + opp.spread + "%<br>" +
      "Score: " + (opp.score || 0) + "<br>" +
      "Risk: " + (opp.risk || "low");
  } catch(e){
    document.getElementById("opportunityBox").innerText="Error loading data";
  }
}

setInterval(loadOpportunity, 5000);
loadOpportunity();
</script>
`;

html = html.replace("</body>", block + "\n</body>");

fs.writeFileSync(file, html);
console.log("✅ Opportunity UI fixed");
