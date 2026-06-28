const fs = require("fs");

let file = "server.js";
let text = fs.readFileSync(file, "utf8");

/* ---------------- BOT STATE ---------------- */
const block = `
// ================= BOT CONTROL =================
let BOT_RUNNING = false;

function startBot() {
  BOT_RUNNING = true;
  console.log("🟢 Bot Started");
}

function stopBot() {
  BOT_RUNNING = false;
  console.log("🔴 Bot Stopped");
}

function isTradingAllowed() {
  return BOT_RUNNING;
}

// API ENDPOINTS
app.get("/api/bot/start", (req, res) => {
  startBot();
  res.json({ status: "started" });
});

app.get("/api/bot/stop", (req, res) => {
  stopBot();
  res.json({ status: "stopped" });
});

app.get("/api/bot/status", (req, res) => {
  res.json({ running: BOT_RUNNING });
});
`;

/* insert before module.exports or end */
if (!text.includes("BOT CONTROL")) {
  text += "\n" + block;
}

fs.writeFileSync(file, text);
console.log("✅ Bot control added");
