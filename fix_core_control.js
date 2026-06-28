const fs = require("fs");
const file = "server.js";
let text = fs.readFileSync(file, "utf8");

/* ================= CLEAN SINGLE CONTROL FLOW ================= */

// 1. Ensure single BOT state
if (!text.includes("GLOBAL_BOT_STATE")) {
  text = `
let BOT_RUNNING = false;

function startBot(){
  BOT_RUNNING = true;
  console.log("🟢 BOT STARTED");
}

function stopBot(){
  BOT_RUNNING = false;
  console.log("🔴 BOT STOPPED");
}

function isTradingAllowed(){
  return BOT_RUNNING;
}

` + text;
}

/* 2. Force ONE execution gate */
text = text.replace(
  /async function executeCrossArbitrage/g,
  `async function executeCrossArbitrage`
);

/* 3. Inject universal gate wrapper */
if (!text.includes("GLOBAL_EXEC_GATE")) {
  text += `

// ================= GLOBAL EXECUTION GATE =================
async function executeSafe(opportunity){
  if (!isTradingAllowed()) return null;
  if (!opportunity) return null;

  return await executeCrossArbitrage(opportunity);
}
`;
}

fs.writeFileSync(file, text);
console.log("✅ Core control fixed (single execution flow)");
