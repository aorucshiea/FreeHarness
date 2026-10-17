// WebHarness 后台：转发工具调用到本地服务
// fetch 由扩展 host_permissions 授权，不受页面 CORS 限制
const API = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "harness-keepalive") {
    sendResponse({ pong: true }); // content script 心跳保活
    return;
  }
  if (msg.type === "harness-exec") {
    (async () => {
      try {
        const r = await fetch(API + "/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calls: msg.calls || [] })
        });
        sendResponse(await r.json());
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
    // popup 请求主动注入当前页（免去用户手动 F5 刷新）
    // allFrames 必须显式开启：默认只注入顶层 frame，iframe 型聊天站点会漏注入
    chrome.scripting.executeScript(
      { target: { tabId: msg.tabId, allFrames: true }, files: ["protocol.js", "adapters.js", "content.js"] },
      () => sendResponse({ ok: true, err: chrome.runtime.lastError ? String(chrome.runtime.lastError) : null })
    );
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("log", (o) => {
    const arr = o.log || [];
    arr.push({ t: new Date().toLocaleTimeString(), msg: "WebHarness 已安装。请先启动本地服务 start_server.bat" });
    chrome.storage.local.set({ log: arr });
  });
});
