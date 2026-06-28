const fs = require("fs");
const file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

/* remove old duplicate menus if any */
html = html.replace(/<!--.*MENU.*-->/gs, "");

/* clean unified menu */
const menu = `
<!-- ================= CLEAN BOT MENU ================= -->
<div id="menuBtn" onclick="toggleMenu()">☰</div>

<div id="menuBox">
  <button onclick="startBot()">🟢 Start Bot</button>
  <button onclick="stopBot()">🔴 Stop Bot</button>
  <button onclick="checkStatus()">📊 Status</button>
  <button onclick="loadOpportunity()">📈 Refresh</button>
</div>

<style>
#menuBtn{
  position:fixed;top:10px;left:10px;
  font-size:28px;cursor:pointer;z-index:9999;
}
#menuBox{
  display:none;position:fixed;top:50px;left:10px;
  background:#111827;padding:10px;border-radius:10px;
  z-index:9999;
}
#menuBox button{
  display:block;margin:6px 0;padding:8px;
  width:140px;background:#1f2937;color:white;
  border:none;border-radius:6px;
}
</style>

<script>
function toggleMenu(){
  const box=document.getElementById("menuBox");
  box.style.display = box.style.display==="block"?"none":"block";
}

async function startBot(){ await fetch('/api/bot/start'); }
async function stopBot(){ await fetch('/api/bot/stop'); }

async function checkStatus(){
  const r=await fetch('/api/bot/status');
  const d=await r.json();
  alert("BOT RUNNING: " + d.running);
}
</script>
`;

html = html.replace("</body>", menu + "\n</body>");

fs.writeFileSync(file, html);
console.log("✅ UI menu fixed");
