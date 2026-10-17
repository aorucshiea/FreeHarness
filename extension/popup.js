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
        appendLog("重置失败：当前页 FreeHarness 未运行（请刷新页面或点扩展图标重新注入）");
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
const PLATFORM_MAP = { windows: "win32", macos: "darwin", linux: "linux" };
let curPlatform = ""; // win32 / darwin / linux：决定注入哪一份平台提示词
const CATS = [
  ["cmd", "命令行"],
  ["files", "文件读写"],
  ["shot", "截图/看图"],
  ["app", "程序与窗口"],
  ["clip", "剪贴板"],
  ["input", "鼠标键盘"]
];

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
  if (j) {
    if (j.platform) curPlatform = PLATFORM_MAP[j.platform] || curPlatform;
    return j; // 已在跑，直接返回（无任何副作用）
  }
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
    if (j) {
      if (j.platform) curPlatform = PLATFORM_MAP[j.platform] || curPlatform;
      appendLog("本地服务已自动启动");
      return j;
    }
  }
  appendLog("自动启动超时：请手动运行 server/start_server.bat（或检查 native host 注册）");
  return null;
}

async function ping() {
  const j = await ensureService();
  if (j) {
    const tools = j.tools || [];
    $("dot").className = "dot on";
    // 状态行只显示数量（18 个工具名全列会把弹窗撑乱），完整列表进 title 提示
    $("statusText").textContent = "服务正常 · " + tools.length + " 个工具就绪";
    $("statusText").title = tools.join(", ");
  } else {
    $("dot").className = "dot off";
    $("statusText").textContent = "本地服务未启动";
    $("statusText").title = "";
  }
  refreshPreview(); // 平台确认后刷新提示词预览
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
    // 折叠状态下 summary 也带信息量
    const sum = $("logSummary");
    if (sum) sum.textContent = "执行日志" + (arr.length ? "（" + arr.length + " 条）" : "（空）");
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
bindCheck("selfDrive");
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
        appendLog("已向当前页注入 FreeHarness" + (r && r.ok ? "（无需刷新页面）" : "（失败，请刷新页面）"));
      });
    } else {
      appendLog("当前页 FreeHarness 运行中（适配: " + resp.adapter + "）");
      var ri = $("roundsInfo");
      if (ri) {
        if (typeof resp.rounds === "number") ri.textContent = "已执行 " + resp.rounds + " 轮";
        ri.title = "适配器: " + (resp.adapter || "?");
      }
      // 页面脚本版本落后于扩展（重载扩展后没刷新页面）→ 提前告知
      if (resp.ver && resp.ver !== MY_VER) {
        appendLog("⚠️ 页面脚本 v" + resp.ver + " ≠ 扩展 v" + MY_VER + "，建议刷新本页后再操作");
      }
    }
  });
});

// ---- 提示词注入（按平台定制 + 工具分类可选） ----
const MY_VER = chrome.runtime.getManifest().version; // 与页面 content script 做版本握手
const personaEl = $("persona");
const coreView = $("coreView");

function showReloadNeeded(msg) {
  $("injectHint").textContent = msg || "需刷新本页";
  const b = $("reloadTab");
  if (b) b.style.display = "";
}

$("reloadTab").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs.length) chrome.tabs.reload(tabs[0].id);
  });
});

// 服务还没起来时 /health 拿不到 platform，用浏览器平台兜底推断
function guessPlatform() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  if (/win/i.test(p)) return "win32";
  if (/mac/i.test(p)) return "darwin";
  return "linux";
}

function coreFor(platform) {
  const cores = (window.WH_PROMPTS && window.WH_PROMPTS.cores) || {};
  return cores[platform] || cores.win32 || "";
}

// 工具分类勾选状态（默认全选）
let catState = {};
let selfDriveOn = false; // AI 自我驱动开关（开启时才把 SELF_PROMPT 协议写进提示词）

function loadCats(cb) {
  chrome.storage.local.get({ h_toolcats: null, selfDrive: false }, (o) => {
    catState = (o.h_toolcats && typeof o.h_toolcats === "object") ? o.h_toolcats : {};
    CATS.forEach(([k]) => { if (typeof catState[k] !== "boolean") catState[k] = true; });
    selfDriveOn = !!o.selfDrive;
    cb && cb();
  });
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.selfDrive) {
    selfDriveOn = !!ch.selfDrive.newValue;
    refreshPreview();
  }
});

function renderCatList() {
  const box = $("catList");
  box.innerHTML = "";
  CATS.forEach(([key, label]) => {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = catState[key] !== false;
    cb.addEventListener("change", () => {
      catState[key] = cb.checked;
      chrome.storage.local.set({ h_toolcats: catState });
      refreshPreview();
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(label));
    box.appendChild(lab);
  });
}

// 生成最终提示词：取当前平台 core → 删掉未勾选的分类块 → 清理标记 → 重排序号
function buildPrompt() {
  let text = coreFor(curPlatform || guessPlatform());
  if (!text) return "";
  CATS.forEach(([key]) => {
    if (catState[key] === false) {
      text = text.replace(new RegExp("<!--cat:" + key + "-->[\\s\\S]*?<!--/cat:" + key + "-->\\n*", "g"), "");
    }
  });
  text = text.replace(/<!--\/?cat:[a-z]+-->\n?/g, ""); // 清理剩余标记
  text = text.replace(/\n{3,}/g, "\n\n");
  // 只对「可用工具」清单重排序号（删分类后编号会断）；规则列表的 1-9 绝不能动
  const block = text.match(/(## 可用工具[\s\S]*?)(?=\n## 工具调用格式)/);
  if (block) {
    let n = 0;
    const renum = block[1].replace(/^(\d+)\. /gm, () => { n += 1; return n + ". "; });
    text = text.replace(block[1], () => renum);
  }
  // 自我驱动开启时追加协议说明（关闭时不出现，避免 AI 无谓地自问自答）
  if (selfDriveOn) {
    text += "\n\n## 自我驱动（已开启）\n"
      + "任务需要多步、且你希望不被打断地继续时，在回复末尾输出：\n"
      + "[SELF_PROMPT]下一步要做的具体指令[/SELF_PROMPT]\n"
      + "系统会把它当作新的用户消息发给你，你继续执行即可。"
      + "任务已完成、需要用户确认、或需要用户提供信息时，不要使用。";
  }
  return text.trim();
}

function refreshPreview() {
  if (!coreView) return;
  const plat = curPlatform || guessPlatform();
  coreView.textContent = buildPrompt() || "(prompts.js 未加载，请重新加载扩展)";
  const info = $("platInfo");
  if (info) {
    const names = { win32: "Windows", darwin: "macOS", linux: "Linux" };
    const picked = CATS.filter(([k]) => catState[k] !== false).length;
    info.textContent = "当前平台：" + (names[plat] || "未知")
      + " · 工具说明只含本平台 · 已选 " + picked + "/6 类";
  }
}

$("promptCfgBtn").addEventListener("click", () => {
  const box = $("promptCfg");
  const opening = box.style.display === "none";
  box.style.display = opening ? "" : "none";
  $("promptCfgBtn").textContent = opening ? "收起" : "设置";
  if (opening) refreshPreview();
});

chrome.storage.local.get({ h_persona: "" }, (o) => { personaEl.value = o.h_persona; });
personaEl.addEventListener("input", () => {
  chrome.storage.local.set({ h_persona: personaEl.value });
});

$("injectPrompt").addEventListener("click", () => {
  const hint = $("injectHint");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs.length) return;
    const tabId = tabs[0].id;
    chrome.tabs.sendMessage(tabId, { type: "harness-ping" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        appendLog("注入失败：当前页 FreeHarness 未运行（请在 AI 站点页面使用）");
        showReloadNeeded("需刷新本页");
        return;
      }
      // 版本握手：页面里的 content script 是扩展重载前注入的旧版时，它不认识新指令
      if (resp.ver && resp.ver !== MY_VER) {
        appendLog("注入失败：页面脚本 v" + resp.ver + " ≠ 扩展 v" + MY_VER + "，请先刷新页面");
        showReloadNeeded("扩展已更新");
        return;
      }
      const persona = personaEl.value.trim();
      const core = buildPrompt();
      if (!core) {
        hint.textContent = "提示词缺失";
        appendLog("注入失败：prompts.js 未加载，请重新加载扩展");
        return;
      }
      const text = (persona ? persona + "\n\n" : "") + core;
      hint.textContent = "注入中…";
      chrome.tabs.sendMessage(tabId, { type: "harness-inject-prompt", text }, (r) => {
        if (chrome.runtime.lastError || !r) {
          // 旧版页面脚本没有这个指令，回调收不到有效响应
          appendLog("注入失败：页面脚本无响应（版本过旧），请刷新页面后重试");
          showReloadNeeded("需刷新本页");
          return;
        }
        if (!r.ok) {
          appendLog("注入失败：" + (r.reason || "填字或发送未成功") + "。建议刷新页面后重试");
          showReloadNeeded("发送失败");
          return;
        }
        hint.textContent = "已发送";
        const picked = CATS.filter(([k]) => catState[k] !== false).length;
        appendLog("已注入提示词（" + (resp.adapter || "?") + "，"
          + (persona ? "含人设" : "仅核心") + "，工具 " + picked + "/6 类，共 " + text.length + " 字）");
      });
    });
  });
});

// 初始化：分类勾选 + 预览
loadCats(() => {
  renderCatList();
  refreshPreview();
});
