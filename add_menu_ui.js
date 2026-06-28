const fs = require("fs");

let file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

const menu = `
<!-- ================= HAMBURGER MENU ================= -->
<style>
#menuBtn {
  position: fixed;
  top: 10px;
  left: 10px;
  font-size: 28px;
  cursor: pointer;
  z-index: 9999;
}

#menuBox {
  display: none;
  position: fixed;
  top: 50px;
  left: 10px;
  background: #111;
  padding: 10px;
  border-radius: 10px;
  z-index: 9999;
}

#menuBox button {
  display: block;
  margin: 5px 0;
  padding: 8px;
  width: 120px;
}
</style>

<div id="menuBtn" onclick="toggleMenu()">☰</div>

<div id="menuBox">
  <button onclick="fetch('/api/bot/start')">🟢 Start Bot</button>
  <button onclick="fetch('/api/bot/stop')">🔴 Stop Bot</button>
  <button onclick="fetch('/api/bot/status').then(r=>r.json()).then(d=>alert(d.running))">📊 Status</button>
</div>

<script>
function toggleMenu() {
  const box = document.getElementById("menuBox");
  box.style.display = box.style.display === "block" ? "none" : "block";
}
</script>
`;

if (!html.includes("HAMBURGER MENU")) {
  html = html.replace("</body>", menu + "\n</body>");
}

fs.writeFileSync(file, html);
console.log("✅ Menu added");
