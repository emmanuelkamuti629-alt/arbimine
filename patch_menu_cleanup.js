const fs = require("fs");

const file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

/* Replace menu with cleaner version */
const menu = `
<!-- ================= MENU ================= -->
<div id="menuBtn" onclick="toggleMenu()">☰</div>

<div id="menuBox">
  <button onclick="checkStatus()">📊 Bot Status</button>
  <button onclick="alert('Logs coming soon')">📄 Logs</button>
  <button onclick="alert('Settings coming soon')">⚙️ Settings</button>
</div>

<style>
#menuBtn {
  position: fixed;
  top: 10px;
  left: 10px;
  font-size: 28px;
  z-index: 9999;
  cursor: pointer;
  color: white;
}

#menuBox {
  display: none;
  position: fixed;
  top: 50px;
  left: 10px;
  background: #111827;
  padding: 10px;
  border-radius: 10px;
  z-index: 9999;
}

#menuBox button {
  display: block;
  margin: 5px 0;
  padding: 8px;
  width: 130px;
  background: #1f2937;
  color: white;
  border: none;
  border-radius: 6px;
}
</style>

<script>
function toggleMenu() {
  const box = document.getElementById("menuBox");
  box.style.display = box.style.display === "block" ? "none" : "block";
}
</script>
`;

html = html.replace(/<div id="menuBtn"[\s\S]*?<\/script>/, menu);

fs.writeFileSync(file, html);
console.log("✅ Menu cleaned and optimized");
