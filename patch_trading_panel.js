const fs = require("fs");

const file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

const panel = `
<!-- ================= TRADING CONTROL PANEL ================= -->
<div class="glass p-4 m-3 rounded-xl">
  <h2 class="text-xl font-bold mb-2">⚙️ Trading Control Panel</h2>

  <div class="flex gap-2 mb-3">
    <button class="btn px-4 py-2 rounded" onclick="startBot()">🟢 Start Bot</button>
    <button class="btn-danger px-4 py-2 rounded" onclick="stopBot()">🔴 Stop Bot</button>
    <button class="btn-secondary px-4 py-2 rounded" onclick="checkStatus()">📊 Status</button>
  </div>

  <div class="text-sm">
    Bot Status:
    <span id="botStatus" class="font-bold text-yellow-400">UNKNOWN</span>
  </div>
</div>

<script>
async function startBot() {
  await fetch('/api/bot/start');
  checkStatus();
}

async function stopBot() {
  await fetch('/api/bot/stop');
  checkStatus();
}

async function checkStatus() {
  const res = await fetch('/api/bot/status');
  const data = await res.json();

  const el = document.getElementById("botStatus");
  if (data.running) {
    el.innerText = "RUNNING 🟢";
    el.className = "text-green-400 font-bold";
  } else {
    el.innerText = "STOPPED 🔴";
    el.className = "text-red-400 font-bold";
  }
}
</script>
`;

if (!html.includes("TRADING CONTROL PANEL")) {
  html = html.replace("<body>", "<body>\n" + panel);
}

fs.writeFileSync(file, html);
console.log("✅ Trading panel added");
