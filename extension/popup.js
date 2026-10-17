const API = "http://127.0.0.1:8765";
const $ = (id) => document.getElementById(id);

const KEY_MAP = { enabled: "h_enabled", autoSend: "h_autoSend", maxRounds: "h_maxRounds" };
const DEFAULTS = { h_enabled: true, h_autoSend: true, h_maxRounds: 20 };

function loadSettings() {
  chrome.storage.local.get(DEFAULTS, (o) => {
    $("enabled").checked = o.h_enabled;
    $("autoSend").checked = o.h_autoSend;
    $("maxRounds").value = o.h_maxRounds;
  });
}

function bindCheck(id) {
  $(id).addEventListener("change", () => {
    chrome.storage.local.set({ [KEY_MAP[id]]: $(id).checked });
  });
}

$("maxRounds").addEventListener("change", () => {
  let v = parseInt($("maxRounds").value, 10);
  if (!v || v < 1) v = 20;
  if (v > 100) v = 100;
  $("maxRounds").value = v;
  chrome.storage.local.set({ h_maxRounds: v });
});

$("resetRounds").addEventListener("click", () => {
  // 真正把重置命令下发到当前页的 content script（轮次计数存在页面内存）
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs.length) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: "harness-reset" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        appendLog("重置失败：当前页 WebHarness 未运行（请刷新页面或点扩展图标重新注入）");
      } else {
        appendLog("已重置轮次计数与去重状态（适配: " + (resp.adapter || "?") + "）");
      }
    });
  });
});

$("clear").addEventListener("click", () => {
  chrome.storage.local.set({ log: [] }, renderLog);
});

async function ping() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000); // 服务半死时不能无限转圈
  try {
    const r = await fetch(API + "/health", { method: "GET", signal: ctrl.signal });
    const j = await r.json();
    $("dot").className = "dot on";
    $("statusText").textContent = "本地服务正常 · 工具: " + (j.tools || []).join(", ");
  } catch (e) {
    $("dot").className = "dot off";
    $("statusText").textContent = "本地服务未启动";
  } finally {
    clearTimeout(timer);
  }
}

function renderLog() {
  chrome.storage.local.get({ log: [] }, (o) => {
    const el = $("log");
    el.innerHTML = "";
    const arr = (o.log || []).slice().reverse();
    for (const e of arr) {
      const div = document.createElement("div");
      div.className = "e";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = e.t;
      div.appendChild(t);
      div.appendChild(document.createTextNode(e.msg));
      el.appendChild(div);
    }
  });
}

function appendLog(msg) {
  chrome.storage.local.get({ log: [] }, (o) => {
    const arr = o.log || [];
    arr.push({ t: new Date().toLocaleTimeString(), msg });
    while (arr.length > 120) arr.shift();
    chrome.storage.local.set({ log: arr }, renderLog);
  });
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.log) renderLog();
});

bindCheck("enabled");
bindCheck("autoSend");
loadSettings();
renderLog();
ping();

// 打开弹窗时检查当前页是否已注入 content script，未注入则主动注入（免 F5）
chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  if (!tabs || !tabs.length) return;
  var tabId = tabs[0].id;
  chrome.tabs.sendMessage(tabId, { type: "harness-ping" }, function (resp) {
    if (chrome.runtime.lastError || !resp) {
      chrome.runtime.sendMessage({ type: "harness-inject", tabId: tabId }, function (r) {
        appendLog("已向当前页注入 WebHarness" + (r && r.ok ? "（无需刷新页面）" : "（失败，请刷新页面）"));
      });
    } else {
      appendLog("当前页 WebHarness 运行中（适配: " + resp.adapter + "）");
    }
  });
});
