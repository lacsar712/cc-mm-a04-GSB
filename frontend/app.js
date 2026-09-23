const tokenKey = "methane_token";
let token = localStorage.getItem(tokenKey) || "";
let role = localStorage.getItem("methane_role") || "";

const loginBox = document.querySelector("#login");
const appBox = document.querySelector("#app");
const rows = document.querySelector("#rows");
const peakRows = document.querySelector("#peaks");
const live = document.querySelector("#live");
const form = document.querySelector("#form");
const viewReadings = document.querySelector("#view-readings");
const viewPeaks = document.querySelector("#view-peaks");
const tabReadings = document.querySelector("#tab-readings");
const tabPeaks = document.querySelector("#tab-peaks");

function paint(list) {
  const canFix = role === "writer";
  rows.innerHTML = list
    .map(
      (r) =>
        `<tr><td>${r.site}</td><td>${r.ch4_pct}</td><td class="${r.level === "报警" ? "alarm" : "ok"}">${r.level}</td><td>${r.note}</td>` +
        (canFix ? `<td><button class="fix" data-id="${r.id}" data-site="${r.site}" data-ch4="${r.ch4_pct}">改正</button></td>` : "") +
        `</tr>`,
    )
    .join("");
}

function paintPeaks(list) {
  peakRows.innerHTML = list
    .map((p) => `<tr><td>${p.site}</td><td>${p.peak_ch4}</td><td>${p.reading_id}</td></tr>`)
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

async function loadPeaks() {
  paintPeaks(await api("/api/peaks"));
}

async function load() {
  paint(await api("/api/readings"));
  await loadPeaks();
}

function showTab(name) {
  const isPeaks = name === "peaks";
  viewReadings.hidden = isPeaks;
  viewPeaks.hidden = !isPeaks;
  tabReadings.classList.toggle("active", !isPeaks);
  tabPeaks.classList.toggle("active", isPeaks);
}

function showApp() {
  loginBox.hidden = true;
  appBox.hidden = false;
  document.querySelector("#who").textContent = role === "writer" ? "检查员" : "查看";
  document.querySelector("#out").hidden = false;
  form.hidden = role !== "writer";
  showTab("readings");
  connect();
  load();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/alerts`);
  ws.onmessage = (ev) => {
    const row = JSON.parse(ev.data);
    live.textContent = `刚推送：${row.site} ${row.level}`;
    load();
  };
}

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
    document.querySelector("#ch4").value = "";
  } catch (err) {
    live.textContent = err.message;
  }
};

// 峰值册只由后端按现存记录重算，页面上没有任何手改峰值的入口；
// 这里只能改正某条班测历史浓度。
rows.onclick = async (e) => {
  const btn = e.target.closest(".fix");
  if (!btn) return;
  const input = prompt(`改正 ${btn.dataset.site} 这条班测（原浓度 ${btn.dataset.ch4}）的甲烷浓度 %：`);
  if (input === null || input.trim() === "") return;
  try {
    await api(`/api/readings/${btn.dataset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ch4_pct: Number(input) }),
    });
    await load();
  } catch (err) {
    live.textContent = err.message;
  }
};

tabReadings.onclick = () => showTab("readings");
tabPeaks.onclick = () => {
  showTab("peaks");
  loadPeaks();
};

document.querySelector("#out").onclick = () => {
  localStorage.clear();
  location.reload();
};

if (token) showApp();
