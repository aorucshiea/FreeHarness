// FreeHarness 后台：转发工具调用到本地服务
// fetch 由扩展 host_permissions 授权，不受页面 CORS 限制
const API = "http://127.0.0.1:8765";

// 扩展自注册：装好 / 浏览器启动 / 重载后，把自己的 ID 告诉本地服务，由服务写入 Native Messaging
// 允许列表。扩展自身无权写注册表，只能借已运行的服务完成；服务端有 X-WebHarness 来源校验，
// 网页脚本伪造不了这个自定义头，所以不会被恶意页面利用。
let _selfRegDone = false;
function selfRegisterExtension() {
  if (_selfRegDone) return;
  _selfRegDone = true;
  try {
    fetch(API + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WebHarness": "1" },
      body: JSON.stringify({ extId: chrome.runtime.id })
    }).catch(() => {});
  } catch (e) {}
}
selfRegisterExtension();

// 保活标签页簿记：convUrl -> 上次开保活的时间（节流用）
const keeperLast = {};
function bkNorm(u) { return String(u || "").split("#")[0].split("?")[0].replace(/\/+$/, ""); }
// 存活页面登记表：tabId -> {url, ts}。内容脚本每 20 秒心跳登记一次……
// 关键作用：判重只用"活着"的页面——扩展重载后未刷新的僵尸页面不会再挡住保活标签的创建
const liveTabs = new Map();

// 后台日志：写入 popup 控制台可见的存储日志（只记关键事件，不记高频脉冲）
function bkLog(msg) {
  try {
    chrome.storage.local.get("log", (o) => {
      const arr = o.log || [];
      arr.push({ t: new Date().toLocaleTimeString(), msg: "[bg] " + msg });
      while (arr.length > 120) arr.shift();
      chrome.storage.local.set({ log: arr });
    });
  } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "harness-keepalive") {
    // 心跳 + 存活登记：记录"本页活着、显示的是哪个对话"
    if (sender && sender.tab && sender.tab.id != null) {
      liveTabs.set(sender.tab.id, { url: bkNorm(msg.url || sender.tab.url || ""), ts: Date.now() });
    }
    sendResponse({ pong: true });
    return;
  }
  if (msg.type === "harness-broadcast") {
    // 同一对话的其他标签页跟随刷新：把通知转发给除来源页之外的所有标签
    chrome.tabs.query({}, (tabs) => {
      const from = sender && sender.tab ? sender.tab.id : -1;
      for (const t of tabs) {
        if (t.id === from) continue;
        try {
          chrome.tabs.sendMessage(t.id, { type: "harness-follow", conv: msg.conv }, () => { void chrome.runtime.lastError; });
        } catch (e) {}
      }
    });
    return;
  }
  if (msg.type === "harness-keep-alive-tab") {
    // 后台保活：为"刚离开、还在运行中的对话"开一个后台标签，让原话题继续跑。
    // 保障：同址已有标签就不开；同一对话 60 秒内最多开一次。
    const url = String(msg.url || "");
    if (!url) return;
    const nu = bkNorm(url);
    const now = Date.now();
    if (keeperLast[nu] && now - keeperLast[nu] < 60000) return;
    keeperLast[nu] = now;
    chrome.tabs.query({}, (tabs) => {
      const now2 = Date.now();
      // 判重只用"活着且刚心跳过"的页面：僵尸页面（重载后未刷新）不会挡住保活标签创建
      const dup = tabs.some((t) => {
        if (t.id == null) return false;
        const rec = liveTabs.get(t.id);
        return !!(rec && now2 - rec.ts < 90000 && rec.url === nu);
      });
      if (dup) { bkLog("保活请求：已有活页面开着该对话，无需开标签"); return; }
      bkLog("保活请求：无活页面，正在创建后台标签");
      chrome.tabs.create({ url: url, active: false }, (tab) => {
        if (!tab || tab.id == null) { bkLog("保活标签创建失败"); return; }
        bkLog("保活标签已创建 tab=" + tab.id);
        const initKeeper = () => {
          try { chrome.tabs.sendMessage(tab.id, { type: "harness-keeper-init" }, () => { void chrome.runtime.lastError; }); } catch (e) {}
        };
        const onUp = (tid, info) => {
          if (tid === tab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(onUp);
            bkLog("保活标签加载完成 tab=" + tab.id);
            initKeeper();
            setTimeout(initKeeper, 2500); // 内容脚本偶尔晚于 complete 就绪，补发一次（重复注册无副作用）
          }
        };
        chrome.tabs.onUpdated.addListener(onUp);
      });
    });
    return;
  }
  if (msg.type === "harness-close-keeper") {
    // 保活标签自请关闭（空闲超时）
    if (sender && sender.tab && sender.tab.id != null) {
      chrome.tabs.remove(sender.tab.id, () => { void chrome.runtime.lastError; });
    }
    return;
  }
  if (msg.type === "harness-exec") {
    (async () => {
      try {
        const r = await fetch(API + "/execute", {
          method: "POST",
          // X-WebHarness 是服务端的来源校验头：网页脚本无法携带自定义头（必过 CORS 预检，
          // 而本服务不返回 CORS 头），只有扩展能调用 —— 与 harness_server.check_request_source 对应
          headers: {
            "Content-Type": "application/json",
            "X-WebHarness": "1",
            // 页面标识 + 会话地址：服务端据此做"跨页去重"（同一对话同一条调用只执行一次）
            "X-WebHarness-Page": msg.pageId || "unknown",
            "X-WebHarness-Conv": msg.conv || ""
          },
          body: JSON.stringify({ calls: msg.calls || [] })
        });
        const data = await r.json();
        // 服务端拒绝（如来源校验失败）时透传原因，避免被上层误报为"后台无响应"
        if (data && !data.results && data.error) {
          sendResponse({
            ok: false,
            results: (msg.calls || []).map(() => ({ ok: false, error: "本地服务拒绝： " + data.error }))
          });
        } else {
          sendResponse(data);
        }
      } catch (e) {
        sendResponse({
          ok: false,
          results: (msg.calls || []).map(() => ({
            ok: false,
            error: "无法连接本地服务：请先运行 server/start_server.bat（" + e + "）"
          }))
        });
      }
    })();
    return true; // 异步响应
  }
  if (msg.type === "harness-inject") {
    // popup 请求主动注入当前页（免 F5）。安全策略：先探测页面里的初始化标志——
    // 全新页面（undefined）才注入；若标志已存在但 ping 无响应，说明是"扩展重载后
    // 没刷新的僵尸页面"（旧脚本残留在内存里、新脚本会被守卫挡住，且旧脚本会继续
    // 捣乱）→ 不注入，明确让用户 F5（一次即可，最干净）。
    chrome.scripting.executeScript(
      {
        target: { tabId: msg.tabId },
        func: () => { try { return String(window.__WH_ACTIVE); } catch (e) { return "probe-err"; } }
      },
      (results) => {
        const flag = results && results[0] ? String(results[0].result) : "probe-err";
        if (flag === "undefined") {
          // allFrames 必须显式开启：默认只注入顶层 frame，iframe 型聊天站点会漏注入
          chrome.scripting.executeScript(
            { target: { tabId: msg.tabId, allFrames: true }, files: ["protocol.js", "adapters.js", "content.js"] },
            () => sendResponse({ ok: true, err: chrome.runtime.lastError ? String(chrome.runtime.lastError) : null })
          );
        } else {
          sendResponse({ ok: false, needReload: true, err: "页面里还残留着扩展重载前的旧脚本，请按一次 F5 刷新本页让新脚本接管" });
        }
      }
    );
    return true;
  }
});

// 定时脉冲：唤醒隐藏标签页里被节流的等待（"切走就停、切回才动"的根治手段）。
// 隐藏标签页的定时器会被浏览器逐步降频到 1 次/分钟；消息投递不受此限制，
// 内容脚本的 sleep 因此改为"定时器或脉冲，谁先到算谁"。
const whTabs = new Set();
function whRefreshTabs() {
  chrome.tabs.query({}, (ts) => {
    whTabs.clear();
    ts.forEach((t) => { if (t.id != null) whTabs.add(t.id); });
  });
}
whRefreshTabs();
chrome.tabs.onCreated.addListener((t) => { if (t.id != null) whTabs.add(t.id); });
chrome.tabs.onRemoved.addListener((id) => whTabs.delete(id));
setInterval(() => {
  for (const id of whTabs) {
    try {
      chrome.tabs.sendMessage(id, { type: "harness-tick" }, () => { void chrome.runtime.lastError; });
    } catch (e) {}
  }
}, 400);

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(null, (o) => {
    const arr = o.log || [];
    arr.push({ t: new Date().toLocaleTimeString(), msg: "FreeHarness 已安装。请先启动本地服务 start_server.bat" });
    chrome.storage.local.set({ log: arr });
    // 升级清理：旧版 wd_ / wd2_ 交付账本口径不可靠（曾把假成功/失败消息误记为已送达）→ 统一作废（新版用 wd3_）
    const kill = Object.keys(o).filter((k) => k.indexOf("wd_") === 0 || k.indexOf("wd2_") === 0);
    if (kill.length) chrome.storage.local.remove(kill);
  });
});