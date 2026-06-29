let token = localStorage.getItem('token');
let currentUser = null;

if (token) initApp();

async function register() {
  const body = {
    email: email.value, password: password.value,
    username: username.value, mpesa: mpesa.value
  };
  const res = await fetch('/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.token) { localStorage.setItem('token', data.token); initApp(); }
  else alert(data.error);
}

async function login() {
  const res = await fetch('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.value, password: password.value })
  });
  const data = await res.json();
  if (data.token) { localStorage.setItem('token', data.token); initApp(); }
  else alert(data.error);
}

async function initApp() {
  token = localStorage.getItem('token');
  document.getElementById('authDiv').classList.add('hidden');
  document.getElementById('appDiv').classList.remove('hidden');
  await loadUser();
  await loadOpportunities();
  loadMessages();
  setInterval(loadMessages, 5000);
}

async function loadUser() {
  const res = await fetch('/auth/me', { headers: { Authorization: token } });
  currentUser = await res.json();
  document.getElementById('p-username').innerText = currentUser.username;
  document.getElementById('p-tier').innerText = currentUser.tier;
  document.getElementById('ref-link').value = `${window.location.origin}/?ref=${currentUser.referralCode}`;
}

async function loadOpportunities() {
  const res = await fetch('/api/opportunities');
  const data = await res.json();
  const container = document.getElementById('opportunities');
  if (!data.opportunities.length) {
    container.innerHTML = '<div class="text-slate-400">No opportunities yet. Scanner running...</div>';
    return;
  }
  container.innerHTML = data.opportunities.map(o => `
    <div class="opp-card glass">
      <div class="flex justify-between items-start">
        <div>
          <h3 class="text-lg font-bold">${o.symbol}</h3>
          <p class="text-sm text-slate-400">Buy: ${o.buyExchange} $${o.buyPrice} | Sell: ${o.sellExchange} $${o.sellPrice}</p>
        </div>
        <span class="text-green-400 font-bold text-xl">${o.spread}%</span>
      </div>
      <p class="text-sm mt-1">Networks: ${Object.keys(o.buyNetworks || {}).join(', ') || 'N/A'}</p>
      <p class="text-sm">Withdraw: ${o.tradable? 'Yes' : 'No'} | Deposit: ${o.tradable? 'Yes' : 'No'} | Risk: ${o.risk}</p>
      <div class="mt-2 flex gap-2 items-center flex-wrap">
        <input type="number" placeholder="Amount $" id="amt-${o._id}" class="p-2 rounded bg-slate-800 text-sm w-24">
        <button class="btn text-sm" onclick="calc('${o._id}', ${o.buyPrice}, ${o.sellPrice})">Calc Profit</button>
        <span id="res-${o._id}" class="text-sm text-green-400"></span>
      </div>
    </div>
  `).join('');
}

function calc(id, buy, sell) {
  const amt = document.getElementById(`amt-${id}`).value;
  if (!amt) return;
  const profit = ((sell - buy) / buy * amt).toFixed(2);
  document.getElementById(`res-${id}`).innerText = `Est: $${profit}`;
}

function showTab(tab) {
  document.querySelectorAll('[id$="-tab"]').forEach(el => el.classList.add('hidden'));
  document.getElementById(tab + '-tab').classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
}

async function subscribe(plan) {
  const res = await fetch('/payment/stk-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ plan })
  });
  const data = await res.json();
  if (data.authorization_url) window.location.href = data.authorization_url;
  else alert(data.message || 'Check your phone for STK push');
}

function copyRef() {
  navigator.clipboard.writeText(document.getElementById('ref-link').value);
  document.getElementById('copied').classList.remove('hidden');
  setTimeout(() => document.getElementById('copied').classList.add('hidden'), 2000);
}

async function loadMessages() {
  const res = await fetch('/api/messages', { headers: { Authorization: token } });
  const msgs = await res.json();
  document.getElementById('chat-box').innerHTML = msgs.map(m => `
    <div class="chat-msg ${m.isAdmin? 'chat-admin' : 'chat-user'}">
      <div>${m.content}</div>
      <div class="text-xs mt-1 flex justify-between">
        <span class="text-slate-400">${new Date(m.createdAt).toLocaleTimeString()}</span>
        <span>
          ${m.read? '<span class="text-green-400">✓✓</span>' : '<span class="text-white">✓</span>'}
          ${!m.isAdmin? `
            <button onclick="editMsg('${m._id}', '${m.content.replace(/'/g, "\\'")}')" class="ml-1">✏️</button>
            <button onclick="delMsg('${m._id}')" class="ml-1">🗑️</button>
          ` : ''}
        </span>
      </div>
    </div>
  `).join('');
  const box = document.getElementById('chat-box');
  box.scrollTop = box.scrollHeight;
}

async function sendMsg() {
  const content = document.getElementById('msg-input').value;
  if (!content) return;
  await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ content })
  });
  document.getElementById('msg-input').value = '';
  loadMessages();
}

async function delMsg(id) {
  if (!confirm('Delete message?')) return;
  await fetch(`/api/message/${id}`, { method: 'DELETE', headers: { Authorization: token } });
  loadMessages();
}

async function editMsg(id, oldContent) {
  const newContent = prompt('Edit message:', oldContent);
  if (!newContent) return;
  await fetch(`/api/message/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ content: newContent })
  });
  loadMessages();
}

function logout() {
  localStorage.removeItem('token');
  location.reload();
}
