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

// ---- 服务自动拉起（Native Messaging）：点扩展图标时若服务没跑，自动启动 ----
const HOST_NAME = "com.webharness.launcher";

function healthOnce(timeoutMs) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 1500);
    fetch(API + "/health", { method: "GET", signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => { clearTimeout(t); resolve(j && j.ok ? j : null); })
      .catch(() => { clearTimeout(t); resolve(null); });
  });
}

async function ensureService() {
  let j = await healthOnce(1500);
  if (j) return j; // 已在跑，直接返回（无任何副作用）
  // 未启动：经 native host 拉起 start_server.bat（浏览器扩展不能直接执行本地程序，这是唯一正规通道）
  appendLog("本地服务未启动，正在自动拉起…");
  try {
    chrome.runtime.sendNativeMessage(HOST_NAME, { cmd: "start" }, () => {
      void chrome.runtime.lastError; // host 未注册时会有 lastError，忽略（下面靠轮询判定结果）
    });
  } catch (e) {
    appendLog("自动拉起失败: " + e);
  }
  for (let i = 0; i < 16; i++) { // 最多等 8 秒（Python 冷启动约 1-3 秒）
    await new Promise((r) => setTimeout(r, 500));
    j = await healthOnce(1200);
    if (j) { appendLog("本地服务已自动启动"); return j; }
  }
  appendLog("自动启动超时：请手动运行 server/start_server.bat（或检查 native host 注册）");
  return null;
}

async function ping() {
  const j = await ensureService();
  if (j) {
    $("dot").className = "dot on";
    $("statusText").textContent = "本地服务正常 · 工具: " + (j.tools || []).join(", ");
  } else {
    $("dot").className = "dot off";
    $("statusText").textContent = "本地服务未启动";
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
