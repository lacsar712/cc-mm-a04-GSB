const tokenKey = "methane_token";
let token = localStorage.getItem(tokenKey) || "";
let role = localStorage.getItem("methane_role") || "";

const loginBox = document.querySelector("#login");
const appBox = document.querySelector("#app");
const rows = document.querySelector("#rows");
const peakRows = document.querySelector("#peaks");
const live = document.querySelector("#live");
const form = document.querySelector("#form");
const nav = document.querySelector("#nav");
const viewReadings = document.querySelector("#view-readings");
const viewPeaks = document.querySelector("#view-peaks");
const tabReadings = document.querySelector("#tab-readings");
const tabPeaks = document.querySelector("#tab-peaks");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function paintReadings(list) {
  rows.innerHTML = list
    .map((r) => {
      const correctCell =
        role === "writer"
          ? `<td><input class="fix" data-id="${r.id}" type="number" step="0.01" value="${r.ch4_pct}" style="width:80px" /><button class="fix-btn" data-id="${r.id}">改正</button></td>`
          : `<td hidden></td>`;
      return `<tr><td>${r.id}</td><td>${esc(r.site)}</td><td>${r.ch4_pct}</td><td class="${r.level === "报警" ? "alarm" : "ok"}">${esc(r.level)}</td><td>${esc(r.note)}</td>${correctCell}</tr>`;
    })
    .join("");
  if (role !== "writer") document.querySelector("#th-correct").hidden = true;
}

function paintPeaks(list) {
  peakRows.innerHTML = list
    .map((p) => `<tr><td>${esc(p.site)}</td><td class="pk">${p.ch4_pct}</td><td>${p.reading_id}</td></tr>`)
    .join("");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "请求失败");
  return data;
}

async function loadReadings() {
  paintReadings(await api("/api/readings"));
}

async function loadPeaks() {
  paintPeaks(await api("/api/peaks"));
}

function showTab(which) {
  const isPeaks = which === "peaks";
  viewPeaks.hidden = !isPeaks;
  viewReadings.hidden = isPeaks;
  form.hidden = role !== "writer" || isPeaks;
  tabPeaks.classList.toggle("active", isPeaks);
  tabReadings.classList.toggle("active", !isPeaks);
}

function showApp() {
  loginBox.hidden = true;
  appBox.hidden = false;
  nav.hidden = false;
  document.querySelector("#who").textContent = role === "writer" ? "检查员" : "查看（旁观只读）";
  document.querySelector("#out").hidden = false;
  form.hidden = role !== "writer";
  showTab("readings");
  connect();
  loadReadings();
  loadPeaks();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/alerts`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.kind === "peak") {
      live.textContent = `峰值册已按现存班测重算：${msg.site} 峰值 ${msg.ch4_pct}（班测 #${msg.reading_id}）`;
      loadPeaks();
    } else {
      live.textContent = `刚推送：${msg.site} ${msg.level}`;
      loadReadings();
    }
  };
}

tabReadings.onclick = () => showTab("readings");
tabPeaks.onclick = () => showTab("peaks");

document.querySelector("#go").onclick = async () => {
  const data = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: document.querySelector("#user").value,
      password: document.querySelector("#pass").value,
    }),
  });
  token = data.access_token;
  role = data.role;
  localStorage.setItem(tokenKey, token);
  localStorage.setItem("methane_role", role);
  showApp();
};

form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/readings", {
      method: "POST",
      body: JSON.stringify({
        site: document.querySelector("#site").value,
        ch4_pct: Number(document.querySelector("#ch4").value),
      }),
    });
  } catch (err) {
    live.textContent = err.message;
  }
};

rows.addEventListener("click", async (e) => {
  const btn = e.target.closest(".fix-btn");
  if (!btn) return;
  const id = btn.dataset.id;
  const input = rows.querySelector(`input.fix[data-id="${id}"]`);
  try {
    // 只改班测浓度；峰值册由服务端按该测点现存全部行重算，无手工改峰值入口。
    await api(`/api/readings/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ ch4_pct: Number(input.value) }),
    });
  } catch (err) {
    live.textContent = err.message;
  }
});

document.querySelector("#out").onclick = () => {
  localStorage.clear();
  location.reload();
};

if (token) showApp();
