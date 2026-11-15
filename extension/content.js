// FreeHarness 主逻辑：监听 AI 消息 → 提取工具调用 → 本地执行 → 结果自动发回
(function () {
  if (window.__WH_ACTIVE) return; // 防止 popup 主动注入时重复初始化
  window.__WH_ACTIVE = true;

  // 本页标识：多开同一对话时用于跨页去重（同一条调用只执行/回传一次）
  var PAGE_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  var A = WHAdapters.getAdapter();
  // 主世界探针：DevTools Console 跑在页面主世界，查不到隔离世界的 __WH_ACTIVE（永远 false，
  // 属于误诊）。DOM 属性跨世界共享，把激活状态写到 <html> 的 dataset 上供用户核实。
  try { document.documentElement.dataset.wh = A.name; } catch (e) {}
  var extractCalls = WHProtocol.extractCalls;
  var formatResults = WHProtocol.formatResults;
  var fingerprint = WHProtocol.fingerprint;
  var extractSelfPrompt = WHProtocol.extractSelfPrompt;
  var resultChunk = WHProtocol.resultChunk;             // 结果消息特征段（送达确认用）
  var countOccurrences = WHProtocol.countOccurrences;   // 页面文本里的子串计数

  var STABLE_MS = 1500;       // DOM 停止变化多久视为"生成结束"
  var processed = new Set();  // 已处理消息指纹（防重复执行）
  var processedTs = {};       // 指纹 -> 入册时间（自愈判断：停滞超 5 分钟允许重跑一次）
  var healedOnce = {};        // 指纹 -> 已自愈重跑（每条消息最多一次）
  var busy = false;           // 执行中锁
  var rounds = 0;             // 本次任务连续工具调用轮数
  var lastExecAt = 0;         // 上次执行工具调用完成的时间戳（用于判断"新任务"并重置轮次）
  var lastCallFp = "";        // 连续相同调用检测
  var repeatCount = 0;
  var selfRounds = 0;         // 自我驱动已进行轮数（上限 10，防无限自循环烧额度）
  var skipNextUntil = 0;      // 注入提示词后的观察窗口（截止时间戳）
  var exampleFps = {};        // 注入时记录的"模板示例调用"指纹：窗口内只忽略复述示例，真实调用照常执行
  var lastSeenText = "";      // 诊断用：上一次抓到并记录过的消息文本
  var lastReasoningWarnTs = 0; // "调用被写进思考块"提示的节流

  console.log("[FreeHarness] 已激活，站点适配:", A.name);

  // 预热：忽略注入前已存在的最后一条 AI 消息（历史对话，避免"幽灵发送"）。
  // 例外：末条消息里含工具调用的不能忽略——那多半是中断的循环（保活标签接管/刷新后恢复），
  // 需要放行给检测流程；是否重复执行由 暂存队列 / 送达账本 / 跨页去重 三层把关。
  try {
    var t0 = A.lastAssistant();
    if (t0 && !extractCalls(t0).length) processed.add("m" + fingerprint(t0.slice(0, 4000)));
  } catch (e) {}

  // 响应 popup 的存活探测（用于判断当前页是否已注入）与控制台指令
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "harness-ping") { sendResponse({ active: true, adapter: A.name, rounds: rounds, ver: (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "") }); return true; }
    if (msg && msg.type === "harness-reset") {
      // 轮次计数存在页面内存中，由 popup 的"重置轮次计数"按钮远程清零
      rounds = 0; lastCallFp = ""; repeatCount = 0; genSince = 0; selfRounds = 0;
      // 重置去重指纹，但保留最后一条消息的指纹——否则它会立刻被再次执行
      var keep = null;
      try { var lt = A.lastAssistant(); if (lt) keep = "m" + fingerprint(lt.slice(0, 4000)); } catch (e) {}
      processed.clear(); processedTs = {}; healedOnce = {};
      if (keep) { processed.add(keep); processedTs[keep] = Date.now(); }
      log("已重置：轮次计数与去重状态已清空，可继续执行");
      sendResponse({ ok: true, adapter: A.name });
      return true;
    }
    if (msg && msg.type === "harness-inject-prompt") {
      // popup 的一键注入提示词：填入输入框并发送（人设+核心已由 popup 拼好）
      (async function () {
        var text = String(msg.text || "").trim();
        if (!text) { sendResponse({ ok: false, error: "提示词为空" }); return; }
        var ok = false;
        var reason = "";
        try {
          ok = await typeAndSend(text);
          if (!ok) reason = "找不到输入框（站点未就绪或 DOM 改版）";
        } catch (e) {
          reason = String(e);
        }
        if (ok) {
          skipNextUntil = Date.now() + 120000;
          // 提取模板里的示例调用做指纹（含示例的 list_dir/echo 等），真实调用不在其中
          exampleFps = {};
          try {
            extractCalls(text).forEach(function (c) {
              if (c.tool !== "__parse_error__") exampleFps[c.tool + "|" + stableFp(c.params)] = 1;
            });
          } catch (e) {}
          log("提示词已发送（120 秒内忽略对模板示例的复述；真实调用照常执行）");
        }
        sendResponse({ ok: !!ok, reason: reason });
      })();
      return true;
    }
    if (msg && msg.type === "harness-tick") {
      // 后台脉冲：唤醒被节流的等待；隐藏页同时借脉冲维持检测节奏（定时器被降频时的替代）
      flushSleepWaiters();
      if (document.hidden && Date.now() - lastTickCheck > 2500) {
        lastTickCheck = Date.now();
        try { check(); } catch (e) {}
      }
      return;
    }
    if (msg && msg.type === "harness-follow") {
      log("收到跟随信号（" + (document.visibilityState === "visible" ? "本页可见" : "本页在后台") + "）");
      maybeFollowRefresh(msg.conv);
      return;
    }
    if (msg && msg.type === "harness-keeper-init") {
      isKeeperTab = true;
      lastActivityTs = Date.now();
      log("本页注册为后台保活标签（原话题将在本页继续运行）");
      return;
    }
  });

  // 多页面跟随刷新：同一对话的其他标签页有新内容时，把本页刷新到最新。
  // 实测 DeepSeek 消息不跨会话实时同步，观察页需要刷新才能看到新内容——由扩展代劳。
  // 规则：用户正在输入框打字时不打扰；后台标签页等切回前台再刷；6 秒节流；
  //       跨浏览器（Edge+Chrome）两边的扩展无法互相通知，只能手动刷新。
  // ★ 重载扩展后，之前已打开的页面里跑的是旧脚本（扩展上下文已失效，收不到任何
  //   消息）——必须把每个页面都刷新一次，新的跟随逻辑才会生效。
  var lastFollowRefresh = 0;
  var pendingFollowRefresh = false;

  function normUrl(u) {
    return String(u || "").split("#")[0].split("?")[0].replace(/\/+$/, "");
  }

  async function maybeFollowRefresh(conv) {
    try {
      if (conv && normUrl(conv) !== normUrl(location.href)) {
        log("跟随跳过：对话地址不一致（信号 " + normUrl(conv) + " ≠ 本页 " + normUrl(location.href) + "）");
        return;
      }
      if (busy) { log("跟随跳过：本页正在忙"); return; }
      if (!(await setting("autoFollow", true))) { log("跟随跳过：开关已关闭"); return; }
      var el = null;
      try { el = A.input(); } catch (e) {}
      if (readInputText(el)) { log("跟随跳过：输入框有内容（你可能正在打字）"); return; }
      if (Date.now() - lastFollowRefresh < 6000) return; // 6 秒节流（不记录，避免刷屏）
      if (document.visibilityState === "visible") {
        lastFollowRefresh = Date.now();
        log("跟随刷新：另一页面有新内容，正在同步");
        location.reload();
      } else {
        pendingFollowRefresh = true;
        log("跟随：本页在后台，切回时再刷新");
      }
    } catch (e) {}
  }

  document.addEventListener("visibilitychange", function () {
    if (!pendingFollowRefresh || document.visibilityState !== "visible") return;
    pendingFollowRefresh = false;
    var el = null;
    try { el = A.input(); } catch (e) {}
    if (!busy && !readInputText(el)) {
      lastFollowRefresh = Date.now();
      log("跟随刷新：已切回前台，正在同步");
      location.reload();
    }
  });

  // ==== 后台脉冲（对抗隐藏标签页的定时器节流）====
  // 实测根因："切走后一切停摆、切回瞬间才开始发"——隐藏标签页里的定时器会被浏览器逐步
  // 降频（极限到每分钟 1 次），而全部自动化序列都靠 sleep 一步步走，于是后台走不动。
  // 修复：后台每 400ms 发"脉冲"消息，隐藏页的 sleep 由脉冲驱动唤醒（消息投递不受定时器节流）。
  var sleepWaiters = [];
  var lastTickCheck = 0;
  function sleep(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var done = false;
      var fin = function () { if (done) return; done = true; resolve(); };
      var tm = setTimeout(fin, ms);
      sleepWaiters.push({ fn: function () {
        if (done) return true;                                   // 已被 setTimeout 解决 → 移出列表
        if (document.hidden && Date.now() - t0 >= Math.min(ms, Math.max(250, Math.round(ms * 0.6)))) {
          clearTimeout(tm); fin(); return true;                  // 隐藏页：脉冲提前唤醒（至少等 60%，保持节奏）
        }
        return false;
      } });
    });
  }
  function flushSleepWaiters() {
    var keep = [];
    for (var i = 0; i < sleepWaiters.length; i++) {
      if (!sleepWaiters[i].fn()) keep.push(sleepWaiters[i]);
    }
    sleepWaiters = keep;
  }

  // 串行写入：快速连续的日志（如探针三连）并发读改写会互相覆盖、丢条目
  var _logChain = Promise.resolve();
  function log(msg) {
    console.log("[FreeHarness]", msg);
    _logChain = _logChain.then(function () {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.get("log", function (o) {
            var arr = o.log || [];
            arr.push({ t: new Date().toLocaleTimeString(), msg: String(msg).slice(0, 300) });
            while (arr.length > 120) arr.shift();
            chrome.storage.local.set({ log: arr }, function () { void chrome.runtime.lastError; resolve(); });
          });
        } catch (e) { resolve(); }
      });
    });
  }

  function setting(key, def) {
    return new Promise(function (resolve) {
      try {
        var obj = {};
        obj["h_" + key] = def;
        chrome.storage.local.get(obj, function (o) { resolve(o["h_" + key]); });
      } catch (e) { resolve(def); }
    });
  }

  // 稳定序列化（键排序）：用于比对"模板示例调用"的参数，避免键序不同导致漏判
  function stableFp(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stableFp).join(",") + "]";
    var ks = Object.keys(v).sort();
    return "{" + ks.map(function (k) { return JSON.stringify(k) + ":" + stableFp(v[k]); }).join(",") + "}";
  }

  // 图片上传失败时的占位文案：明确告诉模型没有附图，避免它编造画面
  var IMG_FAIL_TEXT = "[图片上传失败：站点附件通道不可用，本条消息没有附图。请勿编造画面，可告知用户或改用文字描述]";

  // 页面内浮层提示：工具链路失败时直接告诉用户怎么办（不用开 F12 看日志）
  var toastEl = null;
  var lastToast = { text: "", at: 0 };
  function showToast(text, ms) {
    try {
      var nowT = Date.now();
      if (text === lastToast.text && nowT - lastToast.at < 30000) return; // 30 秒内同类提示不重复刷屏
      lastToast = { text: text, at: nowT };
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;max-width:380px;" +
          "background:#7f1d1d;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.6 system-ui,sans-serif;" +
          "box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:0;transition:opacity .25s;white-space:pre-wrap;";
        (document.body || document.documentElement).appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.style.opacity = "1";
      clearTimeout(showToast._t);
      showToast._t = setTimeout(function () { if (toastEl) toastEl.style.opacity = "0"; }, ms || 6000);
    } catch (e) {}
  }

  // 执行（最长等待按调用里最大的 timeout 动态计算，与服务端单命令上限 300 秒对齐）。
  // 注意：早期版本只等 15 秒就放弃——任何超过 15 秒的命令（安装 / 扫描 / 等待类）
  // 真实结果都会被丢掉、改发"后台无响应"的假错误，用户看来就是"命令返回卡住"。
  function sendExec(calls) {
    return new Promise(function (resolve) {
      var done = false;
      // 等待时长按调用里最大的 timeout 动态计算（上限 300 秒）；扩展侧必须比服务端长，
      // 否则长命令被误判超时 → AI 重试 → 同一条命令双执行
      var maxCallSec = 60;
      (calls || []).forEach(function (c) {
        var t = c && c.params ? Number(c.params.timeout) : NaN;
        if (isFinite(t) && t > maxCallSec) maxCallSec = Math.min(t, 300);
      });
      var waitMs = Math.max(25000, (maxCallSec + 15) * 1000);
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ results: calls.map(function () { return { ok: false, error: "执行超时：扩展后台 " + Math.round(waitMs / 1000) + " 秒无响应。服务端命令可能仍在运行，请先用 list_windows/任务管理器确认，不要盲目重试" }; }) });
      }, waitMs);
      try {
        chrome.runtime.sendMessage({ type: "harness-exec", calls: calls, pageId: PAGE_ID, conv: location.href }, function (res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError || !res) {
            resolve({ results: calls.map(function () { return { ok: false, error: "扩展后台调用失败: " + (chrome.runtime.lastError ? String(chrome.runtime.lastError) : "空响应") }; }) });
          } else {
            resolve(res);
          }
        });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ results: calls.map(function () { return { ok: false, error: "扩展后台调用异常: " + e }; }) });
        }
      }
    });
  }

  // ---------- 核心检查 ----------
  var genSince = 0; // "生成中"起始时间：某些站点有常驻 stop 类按钮，会让 isGenerating 永远为真、检查永久静默

  // ===== 待补发结果 + 交付账本（chrome.storage 共享，多标签互通）=====
  // 场景：执行期间用户切走（防串门拦下）/ 发送没真正送达 → 结果入共享队列。
  // 任何显示该对话的页面（包括自动开的"后台保活标签"）都会在条件满足时补发它，
  // 不再依赖用户切回原标签；"重复执行/重复补发"由 wd_ 交付账本与 pd_ 队列共同防止。
  // 图片结果只保留在原始标签内存里（base64 太大不进 storage），由原标签负责补发。
  var pendingCache = {};         // callsFp -> 暂存对象（缓存自 storage）
  var pendingImagesLocal = {};   // callsFp -> [图片]（仅原始标签内存）
  var redelivering = false;
  var lastRedeliverTry = 0;
  var lastPresenceWarnTs = 0;
  var activeConv = null;         // {url, ts}："仍在干活"的对话（chrome.storage 共享，跨标签/跨刷新）

  try {
    chrome.storage.local.get(null, function (o) {
      for (var k in o) {
        if (k.indexOf("pd_") === 0) pendingCache[k.slice(3)] = o[k];
        if (k === "wh_active") activeConv = o[k];
      }
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local") return;
      for (var k in ch) {
        if (k.indexOf("pd_") === 0) {
          if (ch[k].newValue) pendingCache[k.slice(3)] = ch[k].newValue;
          else delete pendingCache[k.slice(3)];
        }
        if (k === "wh_active") activeConv = ch[k].newValue || null;
      }
    });
  } catch (e) {}

  function stashPending(callsFp, obj) {
    pendingCache[callsFp] = obj;
    if (obj.__images) pendingImagesLocal[callsFp] = obj.__images;
    var storeObj = {};
    for (var k in obj) if (k !== "__images") storeObj[k] = obj[k];
    try {
      var w = {};
      w["pd_" + callsFp] = storeObj;
      chrome.storage.local.set(w);
    } catch (e) {}
  }

  function clearPending(callsFp) {
    delete pendingCache[callsFp];
    delete pendingImagesLocal[callsFp];
    try { chrome.storage.local.remove("pd_" + callsFp); } catch (e) {}
  }

  // 交付账本：只有当"页面里真的出现了这条结果消息"才记账（wd3_ 命名空间），
  // 刷新后的脚本/其他标签据此跳过重复执行与重复补发。
  // 注意：旧版 wd_ / wd2_ 口径不可靠（曾把"假成功"或"发送失败的消息"误记为已送达），升级时自动作废。
  function markDelivered(callsFp) {
    try { var w = {}; w["wd3_" + callsFp] = Date.now(); chrome.storage.local.set(w); } catch (e) {}
  }

  // "仍在干活"标记：工具一有动静就记录 URL；任何页面看到"别的对话还在干活"，会确保它后台保活
  function markActive(url) {
    activeConv = { url: normUrl(url || location.href), ts: Date.now() };
    try { chrome.storage.local.set({ wh_active: activeConv }); } catch (e) {}
  }
  function clearActiveIfMine() {
    if (activeConv && activeConv.url === normUrl(location.href)) {
      activeConv = null;
      try { chrome.storage.local.remove("wh_active"); } catch (e) {}
    }
  }

  // ===== 后台保活：任何页面发现"另一个对话仍在干活"，就确保它在某个标签里继续跑 =====
  // 触发条件用 chrome.storage 共享的 wh_active 记录（而非本页地址变化）——
  // 无论用户是"同页切换对话 / 换标签页 / 刷新后离开 / 直接关掉标签"，信号都不丢：
  // 只要还有任何一个 AI 页面活着，它就会为这台"仍在干活的对话"请求开保活标签。
  var lastActivityTs = 0; // 本页最近一次工具活动（保活标签收尾用）
  var keepAliveThrottle = 0;
  var keepAliveFailLogged = 0;
  var isKeeperTab = false;
  var keeperEverFocused = false;
  var lastKeeperReload = 0;
  document.addEventListener("visibilitychange", function () {
    if (isKeeperTab && document.visibilityState === "visible") keeperEverFocused = true;
  });

  async function check() {
    if (busy) return;
    if (!(await setting("enabled", true))) return;

    // --- 后台保活：wh_active 指向别的对话、且 10 分钟内还有活动 → 确保它有标签在跑 ---
    if (activeConv && activeConv.url && activeConv.url !== normUrl(location.href)) {
      var acAge = Date.now() - (activeConv.ts || 0);
      if (acAge < 600000 && Date.now() - keepAliveThrottle > 60000) {
        keepAliveThrottle = Date.now();
        if (await setting("autoKeepalive", true)) {
          try { chrome.runtime.sendMessage({ type: "harness-keep-alive-tab", url: activeConv.url }); } catch (e) {}
          log("另一对话仍有未完成任务，已确保其后台保活");
        } else if (Date.now() - keepAliveFailLogged > 300000) {
          keepAliveFailLogged = Date.now();
          log("保活检查：autoKeepalive 开关已关闭，跳过");
        }
      } else if (acAge >= 600000 && Date.now() - keepAliveFailLogged > 300000) {
        keepAliveFailLogged = Date.now();
        log("保活检查跳过：另一对话记录已过期（" + Math.round(acAge / 1000) + " 秒无活动）");
      }
    }

    // --- 共享队列的自动补发：任何看到该对话的页面都会尝试 ---
    if (!redelivering && Date.now() - lastRedeliverTry > 5000) {
      var hasPending = false;
      for (var pk in pendingCache) { hasPending = true; break; }
      if (hasPending) {
        redelivering = true;
        lastRedeliverTry = Date.now();
        (async function () {
          try {
            for (var ck in pendingCache) {
              try {
                var pd = pendingCache[ck];
                if (!pd) continue;
                if (Date.now() - pd.ts > 1800000) {
                  clearPending(ck);
                  log("补发超时（超 30 分钟），已放弃；结果仍在剪贴板");
                  continue;
                }
                if (normUrl(location.href) !== pd.conv) continue;
                if (pd.hasImage && !(pendingImagesLocal[ck] && pendingImagesLocal[ck].length)) {
                  // 图片数据平时只在原始标签内存里；其他页面（如后台保活标签）用存档的源文件路径
                  // 向本地服务重新取图——这样"切走后由后台把图片消息发出去"也能成立
                  if (!pd.imgPath) continue;
                  var refRes = await sendExec([{ tool: "view_image", params: { path: pd.imgPath, prompt: pd.promptText || "" } }]);
                  var refMeta = null;
                  try {
                    var refOne = refRes && refRes.results && refRes.results[0];
                    if (refOne && refOne.ok && typeof refOne.result === "string" && refOne.result.indexOf('{"__image__":') === 0) {
                      refMeta = JSON.parse(refOne.result);
                    }
                  } catch (e) {}
                  if (!refMeta || !refMeta.data) {
                    pd._refail = (pd._refail || 0) + 1;
                    if (pd._refail >= 5) {
                      clearPending(ck);
                      log("补发放弃：源图片已不存在（" + pd.imgPath + "），已清出队列");
                    } else {
                      log("补发：图片重新取图失败（" + pd.imgPath + "），稍后自动重试");
                    }
                    continue;
                  }
                  pendingImagesLocal[ck] = [refMeta];
                }
                if (busy) return;
                var lastT = null;
                try { lastT = A.lastAssistant(); } catch (e) {}
                // 用"消息指纹"匹配（而非调用内容）：避免"同一命令的不同轮次"被误判成重复
                if (!lastT) continue; // 页面还没渲染出消息，等等再说
                if (("m" + fingerprint(lastT.slice(0, 4000))) !== ck) {
                  // 对话已推进/被重新生成：这条待补发的结果可能已无对应调用；连续多次不匹配才作废
                  pd._miss = (pd._miss || 0) + 1;
                  if (isKeeperTab && pd._miss === 1 && Date.now() - lastKeeperReload > 60000) {
                    // 保活标签怀疑自己的对话状态不是最新（长时间在后台）→ 刷新一次拿最新状态再试
                    lastKeeperReload = Date.now();
                    log("保活标签：对话状态可能过期，刷新后重试补发");
                    location.reload();
                    return;
                  }
                  if (pd._miss >= 6) {
                    clearPending(ck);
                    log("补发作废：对话已推进（找不到对应调用消息），结果仍在剪贴板");
                  }
                  continue;
                }
                var wd = await new Promise(function (res2) { chrome.storage.local.get("wd3_" + ck, function (o) { res2(o["wd3_" + ck]); }); });
                if (wd && Date.now() - wd < 90000) {
                  clearPending(ck);
                  log("补发跳过：该结果已由其他页面送达");
                  continue;
                }
                // 内容级去重：页面里已经出现这条结果（如"未确认但实际已送达"）→ 只补记送达，不重发。
                // 注意：发送失败的消息（旁边带重试标记）也含同样文本——那不算送达，保守等待不重发
                var chk = resultChunk(pd.payload);
                if (chk && chk.length >= 10
                    && countOccurrences(document.body ? (document.body.innerText || "") : "", chk) > 0) {
                  if (countSendFailures() === 0) {
                    markDelivered(ck);
                    clearPending(ck);
                    log("补发跳过：页面里已存在该结果（确认已送达）");
                  } else if (Date.now() - lastPresenceWarnTs > 60000) {
                    lastPresenceWarnTs = Date.now();
                    log("补发等待：页面里的该结果旁有发送失败标记，等重试/自愈，暂不重复发送");
                  }
                  continue;
                }
                var inEl = null;
                try { inEl = A.input(); } catch (e) {}
                if (!inEl) { log("补发跳过：找不到输入框，稍后重试"); continue; }
                var inTxt = readInputText(inEl);
                if (inTxt) {
                  if (inTxt.indexOf("TOOL_RESULT") !== -1) {
                    // 输入框里是"我们自己残留的结果草稿"（发送中途被切换留下的）→ 清掉继续补发
                    try { await A.fill(inEl, ""); } catch (e) {}
                    await sleep(300);
                    if (readInputText(inEl)) { log("补发跳过：输入框里的残留草稿清不掉，稍后重试"); continue; }
                    log("补发：已清掉上一次残留的结果草稿");
                  } else if (isOwnTypeText(inTxt)) {
                    // 输入框里是 AI 自己 type_text 打的字：交给 typeAndSend 与结果合并成一条消息发出
                    log("补发：输入框里有 type_text 打出的字，将与结果合并发送");
                  } else {
                    log("补发跳过：输入框有内容（可能是你的草稿），稍后重试");
                    continue;
                  }
                }
                log("补发：正在补发工具结果" + (isKeeperTab ? "（保活标签）" : ""));
                var okSent2;
                var imgs = pd.hasImage ? pendingImagesLocal[ck] : null;
                if (imgs && imgs.length) {
                  okSent2 = await typeAndSendWithImage(pd.payload + "\n\n" + (pd.promptText || ""), imgs[0]);
                } else {
                  okSent2 = await typeAndSend(pd.payload);
                }
                if (okSent2) {
                  markDelivered(ck);
                  clearPending(ck);
                  lastActivityTs = Date.now();
                  markActive(location.href);
                  log("补发成功");
                  try { chrome.runtime.sendMessage({ type: "harness-broadcast", conv: location.href }); } catch (e) {}
                } else {
                  log("补发未成功，稍后自动重试（结果仍在剪贴板）");
                }
              } catch (e) {}
            }
          } finally { redelivering = false; }
        })();
      }
    }

    // --- 保活标签自动收尾：从未被关注过 + 后台 + 空闲超 20 分钟 → 自关 ---
    if (isKeeperTab && !keeperEverFocused && document.hidden && Date.now() - lastActivityTs > 1200000) {
      log("保活标签：对话空闲超 20 分钟，自动关闭本标签");
      try { chrome.runtime.sendMessage({ type: "harness-close-keeper" }); } catch (e) {}
    }

    if (A.isGenerating && A.isGenerating()) {
      if (!genSince) { genSince = Date.now(); log("AI 正在生成，等待其完成（最多 15 秒）…"); }
      if (Date.now() - genSince < 15000) return; // 15 秒内信任"生成中"，之后强制检查（防残留按钮把检查永久卡死）
    } else {
      genSince = 0;
    }

    var text = null;
    try { text = A.lastAssistant(); } catch (e) {}
    // 主世界探针：最近抓到的消息头部写在 <html> 的 dataset 上，F12 查 whLast 即可
    // 核实适配器到底抓到了什么；文本变化才写，避免高频 DOM 写入
    try {
      var head = text ? String(text).slice(0, 80) : "(空)";
      if (document.documentElement.dataset.whLast !== head) document.documentElement.dataset.whLast = head;
    } catch (e) {}
    if (!text || text.length < 10) return;

    // 诊断：抓到的文本变化但没调用时记一条，排查"AI 明明输出了调用却没执行"
    if (text !== lastSeenText) {
      lastSeenText = text;
      if (text.indexOf("[TOOL_CALL") === -1) {
        log("抓到 AI 消息（无调用）: " + text.slice(0, 60).replace(/\s+/g, " "));
      }
    }

    // 注入提示词后的观察窗口：只拦截"复述模板示例"的调用；真实调用必须放行
    if (skipNextUntil) {
      if (Date.now() > skipNextUntil) {
        skipNextUntil = 0; // 窗口过期，恢复正常处理
      } else {
        var calls0 = extractCalls(text);
        var onlyExamples = calls0.length > 0 && calls0.every(function (c) {
          return c.tool === "__parse_error__" || exampleFps[c.tool + "|" + stableFp(c.params)];
        });
        if (onlyExamples) {
          var fp0 = "m" + fingerprint(text.slice(0, 4000));
          if (!processed.has(fp0)) { processed.add(fp0); skipNextUntil = 0; log("忽略 AI 对模板示例的复述（非真实调用）"); return; }
          return;
        }
        if (calls0.length > 0) skipNextUntil = 0;
      }
    }

    var calls = extractCalls(text);
    if (!calls.length) {
      rounds = 0; // 该消息无调用：任务结束，重置轮次
      // 没有待补发的结果时，撤下"仍在干活"标记（任务已完成，不再为它开保活标签）
      var mine = normUrl(location.href);
      var pendMine = false;
      for (var qk in pendingCache) {
        if (pendingCache[qk] && pendingCache[qk].conv === mine) { pendMine = true; break; }
      }
      if (!pendMine) clearActiveIfMine();

      // 诊断：模型把工具调用写进了"思考/推理"区块时，正文里看不到调用（适配器按安全策略剔除了
      // 思考内容，防止执行模型内心推演里的假调用）。给用户明确提示，别让对话看起来莫名卡住。
      if (A.reasoningText) {
        try {
          var rtxt = A.reasoningText();
          if (rtxt && extractCalls(rtxt).length && Date.now() - lastReasoningWarnTs > 60000) {
            lastReasoningWarnTs = Date.now();
            log("检测到工具调用写在「思考」区块里（正文没有），按安全策略不执行");
            showToast("⚠️ AI 把工具调用写进了「思考」区块，扩展不会执行（这是安全策略，防止执行模型内心推演里的假调用）。\n建议：关闭 DeepSeek 的「深度思考」后重试，或提示 AI 把 [TOOL_CALL] 写在正文里。", 12000);
          }
        } catch (e) {}
      }

      // 自我驱动：AI 用 [SELF_PROMPT]下一步[/SELF_PROMPT] 给自己下发下一轮输入，扩展自动发回
      var selfPrompt = extractSelfPrompt(text);
      if (selfPrompt) {
        if (!(await setting("selfDrive", true))) {
          log("AI 请求自我驱动，但开关已关闭（popup → 常用 → AI 自我驱动）");
          return;
        }
        if (selfRounds >= 10) {
          log("自我驱动已达 10 轮上限，已停止。请人工确认任务状态。");
          return;
        }
        var spfp = "s" + fingerprint(selfPrompt);
        if (processed.has(spfp)) return; // 同一句自我提示不重复发送
        processed.add(spfp);
        selfRounds++;
        log("AI 自我提示（" + selfRounds + "/10）: " + selfPrompt.slice(0, 70).replace(/\s+/g, " "));
        var sentSelf = false;
        try { sentSelf = await typeAndSend(selfPrompt); } catch (e) { log("自我提示发送异常: " + e); }
        if (!sentSelf) log("自我提示发送失败，自驱已停止");
      }
      return;
    }

    // 安全边界：思考(reaasoning)里的 [TOOL_CALL] 是模型"内心戏"（推演/示例/假想），绝不能执行。
    // 思考流永远先于正文流，合规的调用必是消息里最后一个 [TOOL_CALL] 块——只执行它。
    if (calls.length > 1) {
      log("检测到 " + calls.length + " 个调用块，按协议一轮一个，只执行最后一个（其余视为思考中的推演）");
      calls = calls.slice(-1);
    }

    var fp = "m" + fingerprint(text.slice(0, 4000));
    if (processed.has(fp)) {
      // 自愈：同一条消息 5 分钟没有任何推进（仍是最后一条 AI 消息、无暂存、无锁、输入框为空）
      // → 上次"送达"可疑（典型场景：发送中途切换对话导致结果丢失），允许重跑一次
      var pAge = Date.now() - (processedTs[fp] || 0);
      if (pAge > 120000 && (healedOnce[fp] || 0) < 3 && !busy && !redelivering && !pendingCache[fp]) {
        var inEl0 = null;
        try { inEl0 = A.input(); } catch (e) {}
        if (!inEl0 || !readInputText(inEl0)) {
          // 已确认送达（wd3_ 是新口径：只有页面里真的出现结果才记账）→ 不重跑，等 AI 响应即可。
          // 180 秒内视为"刚送达"；超过则可能是"重新生成出同文消息"等场景，允许自愈重跑
          var wdH = await new Promise(function (rh) { chrome.storage.local.get("wd3_" + fp, function (o) { rh(o["wd3_" + fp]); }); });
          if (wdH && Date.now() - wdH < 180000) return;
          healedOnce[fp] = (healedOnce[fp] || 0) + 1;
          clearPending(fp);
          try { chrome.storage.local.remove(["wd_" + fp, "wd2_" + fp, "wd3_" + fp]); } catch (e) {}
          log("自愈：该调用停滞超 2 分钟（疑似结果未送达），重新执行一次（第 " + healedOnce[fp] + " 次）");
          // 落入下方正常执行流程
        } else { return; }
      } else { return; }
    }
    processed.add(fp);
    processedTs[fp] = Date.now();
    if (processed.size > 300) { processed.clear(); processedTs = {}; healedOnce = {}; }

    busy = true;
    var busyTimer = setTimeout(function () { busy = false; log("执行锁超时，已强制重置"); }, 340000); // 硬兜底（须大于 sendExec 最长等待，约 315 秒）
    try {
      log("检测到 " + calls.length + " 个工具调用 [" + A.name + "]");
      lastActivityTs = Date.now(); // 本页活跃时间（保活标签收尾判断用）
      markActive(location.href);   // 向所有页面声明："这个对话在干活"（保活信号，跨刷新也有效）

      // 通知同一对话的其他标签页跟随刷新（会话出现新内容了）
      try { chrome.runtime.sendMessage({ type: "harness-broadcast", conv: location.href }); } catch (e) {}

      // 连续相同调用 → 判定死循环
      var cfp = fingerprint(JSON.stringify(calls));
      if (cfp === lastCallFp) { repeatCount++; } else { repeatCount = 0; lastCallFp = cfp; }
      if (repeatCount >= 2) {
        log("连续 3 轮完全相同的调用，判定卡死，已停止。请人工介入。");
        return;
      }

      var maxRounds = await setting("maxRounds", 0);
      // 距上次执行超过 90 秒 → 视为用户重新下达的新任务，轮次归零
      if (lastExecAt && Date.now() - lastExecAt > 90000) rounds = 0;
      // maxRounds = 0 表示不限制（默认）；只有用户自己设了上限才检查
      if (maxRounds > 0 && rounds >= maxRounds) {
        log("已达你设置的轮次上限 " + maxRounds + "，已停止。可调大上限或点「重置轮次」继续。");
        showToast("⚠️ 已达你设置的轮次上限（" + maxRounds + " 轮），执行已暂停。\n点扩展图标 → 高级设置：把「轮次上限」调大（0 = 不限制）或点「重置轮次」。", 9000);
        return;
      }

      // 已有暂存结果 / 已有送达记录 → 不重复执行（刷新、保活标签接管、重开对话时靠这两条去重；
      // 键用"消息指纹"而非调用内容，保证同一命令在不同轮次（如连续截图）不会被误伤）
      if (pendingCache[fp]) {
        log("该调用已有暂存结果，等待补发（不重复执行）");
        return;
      }
      var wdHit = await new Promise(function (res3) { chrome.storage.local.get("wd3_" + fp, function (o) { res3(o["wd3_" + fp]); }); });
      if (wdHit && Date.now() - wdHit < 90000) {
        log("该调用已有结果送达记录，跳过重复执行");
        return;
      }

      // 解析失败的占位调用不送服务端（避免误导性的"未知工具"），本地直接回错误给 AI
      var localErrors = [];
      var realCalls = [];
      calls.forEach(function (c) {
        if (c.tool === "__parse_error__") {
          localErrors.push({
            ok: false,
            error: "工具调用解析失败（" + c.error + "）。请检查 [TOOL_CALL] 内 JSON 格式：字符串内的真实换行要写成反斜杠加 n、双引号要写成反斜杠加引号、反斜杠要写成两个反斜杠。原始内容前 200 字: " + c.raw.slice(0, 200)
          });
        } else {
          realCalls.push(c);
        }
      });

      // 执行前记下当前对话页地址：执行期间若用户切到其他对话/页面，结果绝不能发错地方
      var pageKeyAtDispatch = location.href;
      var results = [];
      if (realCalls.length > 0) {
        noteTypeTextCalls(realCalls); // 记住 type_text 的输出：若它打进对话输入框，需识别为残留而不是用户草稿
        var res = await sendExec(realCalls);
        // 跨页去重：另一页面已执行并回传过这条调用 → 本页跳过，避免重复回帖
        if (res && res.deduped) {
          log("该调用已由另一页面执行并回传（跨页去重），本页跳过");
          return;
        }
        results = (res && res.results) || realCalls.map(function () {
          return { ok: false, error: "扩展后台无响应" };
        });
      }
      results = localErrors.concat(results);
      if (!results.length) return;

      // 通信类失败（扩展↔本地服务）→ 页面内直接提示用户该干什么，不只是把错误回给 AI
      var infraFail = results.some(function (r) {
        return r && !r.ok && /后台|超时|无响应|无法连接|通信/.test(String(r.error || ""));
      });
      if (infraFail) {
        showToast("⚠️ 工具执行失败：扩展与本地服务通信异常。\n建议：刷新本页（Ctrl+F5），或到 edge://extensions 重新加载扩展。", 9000);
      }

      // 图片结果：base64 只走附件通道，文字消息里替换为简短说明（11MB 文本不能进输入框）
      var images = [];
      var displayResults = (results || []).map(function (r) {
        if (r && r.ok && typeof r.result === "string" && r.result.indexOf('{"__image__":') === 0) {
          try {
            var meta = JSON.parse(r.result);
            if (meta && meta.__image__ && meta.data) {
              images.push(meta);
              // 占位文本带上文件名（含时间戳，逐条唯一）：既是给模型的提示，也是"送达确认"的特征段
              return { ok: true, result: "[图片已作为附件随消息上传（" + (meta.name || "image") + "），请直接查看附图]" };
            }
          } catch (e) {}
        }
        return r;
      });

      var payload = formatResults(displayResults);
      rounds++;
      lastExecAt = Date.now();

      // 对话防串门：执行期间用户切换到了其他对话/页面（SPA 路由或跳转）时，
      // 结果绝不能被打进"别人"的对话——放入共享暂存队列，任何看到该对话的页面都会补发
      if (location.href !== pageKeyAtDispatch) {
        stashPending(fp, {
          conv: normUrl(pageKeyAtDispatch),
          payload: payload,
          hasImage: images.length > 0,
          imgPath: (calls[0] && calls[0].params && calls[0].params.path) ? calls[0].params.path : "",
          __images: images,
          promptText: (calls[0] && calls[0].params && calls[0].params.prompt) ? calls[0].params.prompt : "请查看附图并描述你看到的内容。",
          ts: Date.now()
        });
        log("检测到已切换到其他对话，结果已入暂存队列（该对话的任何页面都会自动补发；也已复制到剪贴板兜底）");
        markActive(pageKeyAtDispatch);
        try { await navigator.clipboard.writeText(payload); } catch (e) {}
        console.log("[FreeHarness] 已切换对话，暂存待补发的结果:", payload);
        return;
      }

      var autoSend = await setting("autoSend", true);
      if (!autoSend) {
        log("自动发送已关闭。结果已写入剪贴板，请手动粘贴发送。");
        try { await navigator.clipboard.writeText(payload); } catch (e) {}
        return;
      }

      await sleep(300);
      var sent;
      if (images.length > 0) {
        var promptText = (calls[0] && calls[0].params && calls[0].params.prompt)
          ? calls[0].params.prompt
          : "请查看附图并描述你看到的内容。";
        sent = await typeAndSendWithImage(payload + "\n\n" + promptText, images[0]);
      } else {
        sent = await typeAndSend(payload);
      }
      if (sent) {
        // sent=true 表示已在页面里"确认看到"这条结果消息（内容级校验），不是"点了发送"
        markDelivered(fp);
        markActive(location.href);
        lastActivityTs = Date.now();
        log("已自动发送工具结果（第 " + rounds + " 轮）");
        // 会话又更新了：通知同一对话的其他标签页跟随刷新
        try { chrome.runtime.sendMessage({ type: "harness-broadcast", conv: location.href }); } catch (e) {}
      } else {
        log("自动发送未确认（结果已入待补发队列，任何页面会自动重试）");
        showToast("⚠️ 结果自动发送未确认：站点输入/发送接口可能已改版，已转入待补发队列。\n建议：刷新本页（Ctrl+F5）或重新加载扩展。结果也已复制到剪贴板，可手动粘贴。", 9000);
        try { await navigator.clipboard.writeText(payload); } catch (e) {}
        console.log("[FreeHarness] 完整结果:", payload);
        // 未确认送达的结果一律入共享队列：任何看到该对话的页面（含保活标签）会自动补发，
        // 避免"看着像成功、其实没送到"。归属对话取执行前的地址（执行期间可能已被切走）
        stashPending(fp, {
          conv: normUrl(pageKeyAtDispatch),
          payload: payload,
          hasImage: images.length > 0,
          imgPath: (calls[0] && calls[0].params && calls[0].params.path) ? calls[0].params.path : "",
          __images: images,
          promptText: (calls[0] && calls[0].params && calls[0].params.prompt) ? calls[0].params.prompt : "请查看附图并描述你看到的内容。",
          ts: Date.now()
        });
        markActive(pageKeyAtDispatch);
      }
    } finally {
      clearTimeout(busyTimer);
      busy = false;
    }
  }

  // ---------- 输入与发送 ----------

  // 用户草稿保护：自动填充前检查输入框，有用户未发送的内容时不覆盖
  // （等待其清空，最多 30 秒；仍不清空则交由上层转剪贴板，避免弄丢用户正在打的字）
  var lastFilledText = ""; // 上一次由扩展填入的内容（用于区分"本扩展的残留"与"用户的草稿"）

  // type_text 是 GUI 工具：若 AI 先把焦点点进对话输入框、再用 type_text，字会直接打进对话框，
  // 挡住结果回传（会被误判成"用户草稿"而一直等待）。记住我们刚打过的文本（持久化，刷新后仍在），
  // 输入框里出现它就是我们的工具残留，可以清掉/覆盖，不当用户草稿。
  var recentTypeTexts = [];
  try {
    chrome.storage.local.get("wh_typetext", function (o) {
      if (o && Array.isArray(o.wh_typetext)) {
        recentTypeTexts = o.wh_typetext.filter(function (x) { return x && x.text; }).slice(-10);
      }
    });
  } catch (e) {}
  function noteTypeTextCalls(calls) {
    var now = Date.now();
    (calls || []).forEach(function (c) {
      if (c && c.tool === "type_text" && c.params && c.params.text) {
        recentTypeTexts.push({ text: String(c.params.text), ts: now });
      }
    });
    recentTypeTexts = recentTypeTexts.filter(function (x) { return now - x.ts < 300000; }).slice(-10);
    try { chrome.storage.local.set({ wh_typetext: recentTypeTexts }); } catch (e) {}
  }
  function isOwnTypeText(t) {
    var s = String(t || "").replace(/\s+/g, "");
    if (!s) return false;
    var now = Date.now();
    for (var i = recentTypeTexts.length - 1; i >= 0; i--) {
      var x = recentTypeTexts[i];
      if (now - x.ts > 300000) continue;
      var o = String(x.text).replace(/\s+/g, "");
      if (!o) continue;
      if (o === s) return true;
      if (o.length >= 20 && (s.indexOf(o) !== -1 || o.indexOf(s) !== -1)) return true;
    }
    return false;
  }
  function readInputText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return (el.value || "").trim();
    return (el.innerText || el.textContent || "").trim();
  }
  async function waitInputUsable(el, timeoutMs) {
    var t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      var cur = readInputText(el);
      if (!cur || cur === lastFilledText.trim() || cur.indexOf("TOOL_RESULT") !== -1) return true;
      if (isOwnTypeText(cur)) return true; // AI 自己 type_text 打的字：交给 typeAndSend 与结果合并成一条消息发送
      await sleep(1500);
    }
    return false;
  }
  function genericFileInput() {
    var inputs = document.querySelectorAll('input[type="file"]');
    var fallback = null;
    for (var i = 0; i < inputs.length; i++) {
      var acc = (inputs[i].getAttribute("accept") || "").toLowerCase();
      if (acc === "") return inputs[i];                       // 不限制类型，直接可用
      if (acc.indexOf("image") !== -1) return inputs[i];      // mime 形式（image/*）
      // 扩展名形式（如 z.ai 的 .png,.jpg,...）：含图片扩展名也算图片入口
      if (!fallback && /\.(png|jpe?g|gif|bmp|webp)/.test(acc)) fallback = inputs[i];
    }
    return fallback;
  }

  // ---- 发送失败自愈（DeepSeek 等站点特有）----
  // 站点把消息标记为发送失败（如 "Server busy, please try again later." / "Check network and retry."）时，
  // 消息旁会显示一个圆形重试按钮；检测到"新增的失败标记"就自动点重试，不让消息默默烂在那。
  function countSendFailures() {
    try {
      var c = document.querySelectorAll('svg path[d^="M12 .5C18.351.5"]').length;
      var spans = document.querySelectorAll("span");
      for (var i = 0; i < spans.length; i++) {
        var tx = (spans[i].textContent || "").trim();
        if (tx === "Server busy, please try again later." || tx === "Check network and retry.") c++;
        else if (tx.length < 40 && (tx.indexOf("服务器繁忙") !== -1 || tx.indexOf("网络异常") !== -1 || tx.indexOf("发送失败") !== -1)) c++;
      }
      return c;
    } catch (e) { return -1; }
  }
  function clickSendRetry() {
    try {
      var paths = document.querySelectorAll('svg path[d^="M12 .5C18.351.5"]');
      // 从后往前：文档顺序最后出现的失败按钮，最可能是刚发送失败的那条
      for (var i = paths.length - 1; i >= 0; i--) {
        var btn = paths[i].closest(".ds-icon-button") || paths[i].closest('[role="button"]');
        if (btn) {
          var r = btn.getBoundingClientRect();
          if (r.width >= 4 && r.height >= 4) { btn.click(); return true; }
        }
      }
    } catch (e) {}
    return false;
  }

  // 几何智能点击"发送键"：站点的发送按钮可能没有 aria-label（实测 DeepSeek 是右下角无标签图标按钮，
  // 导致常规选择器永远点不到）。在"输入框顶线以下、横向位于输入框 55% 之后"的区域内，
  // 取最右侧的可见小按钮（发送键在最右下）点击；infoCb 回传候选信息用于写日志。
  function clickSendButtonSmart(infoCb) {
    try {
      var base = null;
      try { base = A.input(); } catch (e) {}
      if (!base) { if (infoCb) infoCb("找不到输入框"); return false; }
      var br = base.getBoundingClientRect();
      var nodes = document.querySelectorAll('button, [role="button"], div[class*="ds-button"], div[class*="icon-button"]');
      var best = null, bestX = -1e9, dump = [];
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        if (nd === base || (nd.contains && nd.contains(base))) continue;
        var r = nd.getBoundingClientRect();
        if (r.width < 12 || r.height < 12 || r.width > 72 || r.height > 72) continue;
        if (nd.disabled || nd.getAttribute("aria-disabled") === "true") continue;
        if (r.top < br.top - 6) continue;                    // 输入框上方（消息区按钮）不是
        if (r.left < br.left + br.width * 0.55) continue;    // 太靠左（附件/思考开关等）不是
        if (r.left > br.right + 80 || r.top > br.bottom + 120) continue;
        if (!nd.querySelector("svg")) continue;
        var cx = r.left + r.width / 2;
        dump.push(String(nd.className || "?").slice(0, 30) + "@" + Math.round(cx));
        if (cx > bestX) { bestX = cx; best = nd; }
      }
      if (infoCb) infoCb("候选 " + String(dump.slice(-4).join(" ~ ")).slice(0, 200));
      if (best) { best.click(); return true; }
    } catch (e) { if (infoCb) infoCb("异常: " + e); }
    return false;
  }

  // 图片上传是否出现预览（不同站点用 blob: / data:，统一识别）
  function anyUploadPreview() {
    return document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length;
  }
  // 发送键是否已恢复可用（上传期间通常禁用；用它判定上传完成，比死等缩略图可靠、更快）
  function hasEnabledSendButton() {
    try {
      var base = A.input();
      if (!base) return false;
      var br = base.getBoundingClientRect();
      var nodes = document.querySelectorAll('button, [role="button"], div[class*="ds-button"], div[class*="icon-button"]');
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        if (nd === base || (nd.contains && nd.contains(base))) continue;
        var r = nd.getBoundingClientRect();
        if (r.width < 12 || r.height < 12 || r.width > 72 || r.height > 72) continue;
        if (nd.disabled || nd.getAttribute("aria-disabled") === "true") continue;
        if (r.top < br.top - 6) continue;
        if (r.left < br.left + br.width * 0.55) continue;
        if (r.left > br.right + 80 || r.top > br.bottom + 120) continue;
        if (!nd.querySelector("svg")) continue;
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 带图片附件发送：文字进输入框，图片经 DataTransfer 塞入 file input 触发站点上传
  async function typeAndSendWithImage(text, meta) {
    var textEl = null;
    var urlAtStart = location.href;
    var resultText = text; // 原始结果文本（送达确认用；text 可能被合并进 AI 的话）
    try { textEl = A.input(); } catch (e) {}
    try {
      if (textEl) {
        // 草稿保护：用户正在输入框里打字时不覆盖（最多等 30 秒，仍未清空则转剪贴板）
        if (!(await waitInputUsable(textEl, 30000))) {
          log("输入框里有内容（你可能正在打字），图片结果未自动发送，已转剪贴板");
          return false;
        }
        // 输入框里是 AI 自己 type_text 打的字 → 和图片结果合并成一条消息一起发
        var own = readInputText(textEl);
        if (own && isOwnTypeText(own)) {
          text = own + "\n\n" + text;
          log("输入框里有 AI 用 type_text 打的字，已与图片结果合并成一条消息发送");
        }
        textEl.focus();
        await sleep(120);
        await A.fill(textEl, text);
        lastFilledText = text;
        await sleep(300);
        // 填充校验：文字必须真的进入输入框，否则后面的"发送"是空点
        var filledNow = readInputText(textEl);
        if (!filledNow || filledNow.indexOf("TOOL_RESULT") === -1) {
          await A.fill(textEl, text);
          await sleep(300);
          filledNow = readInputText(textEl);
          if (!filledNow || filledNow.indexOf("TOOL_RESULT") === -1) {
            log("发送前校验未通过：结果文字未能写入输入框");
            return false;
          }
        }
      }
      // 关键：填文字会触发 Svelte/React 状态更新，输入区组件可能重渲染、
      // 之前查到的 file input 引用变成已脱离文档树的死节点。必须在填字之后重新查询。
      var fileInput = (A.fileInput && A.fileInput()) || genericFileInput();
      if (!fileInput) {
        log("页面找不到文件上传入口，降级为纯文本发送");
        var failText = text.replace(/\[图片已作为附件随消息上传[^\]]*\]/, IMG_FAIL_TEXT);
        if (failText === text) failText = text + "\n" + IMG_FAIL_TEXT;
        return typeAndSend(failText);
      }
      log("探针 fileInput: isConnected=" + fileInput.isConnected + " accept=" + JSON.stringify(fileInput.getAttribute("accept")) + " 文件=" + (meta.name || "image.png") + " " + (meta.data.length * 3 / 4 / 1024 | 0) + "KB");
      var bin = atob(meta.data);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var file = new File([new Blob([arr], { type: meta.mime })], meta.name || "image.png", { type: meta.mime });
      var dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      log("探针 files已塞入: length=" + fileInput.files.length);
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      // 时序关键：站点读取文件后会清空 input.files；之后仍需等上传+预览渲染完成。
      var waited = 0;
      while (fileInput.files && fileInput.files.length > 0 && waited < 5000) {
        await sleep(250); waited += 250;
      }
      log("探针 站点接收: 耗时=" + waited + "ms 剩余files=" + (fileInput.files ? fileInput.files.length : "?") + " isConnected=" + fileInput.isConnected);
      // 等图片真正上传完再发送——上传没完就点发送会发出"半截"消息：
      // 站点把它标记为发送失败（Server busy / Check network and retry），AI 永远收不到（实测元凶）。
      // 就绪判定用两条信号（预览出现 / 发送键恢复可用），不再死等 blob 缩略图——不同站点预览机制不同，会白等 15 秒。
      log("等待图片上传完成（预览或发送键就绪，最多 10 秒）…");
      var pvWait = 0, readySamples = 0, previewsBefore = anyUploadPreview();
      while (pvWait < 10000) {
        await sleep(500); pvWait += 500;
        if (anyUploadPreview() > previewsBefore) break;
        if (pvWait >= 1500 && hasEnabledSendButton()) { readySamples++; if (readySamples >= 2) break; }
        else { readySamples = 0; }
      }
      log("上传等待结束: " + pvWait + "ms（预览 " + previewsBefore + "→" + anyUploadPreview() + "，发送键就绪=" + hasEnabledSendButton() + "）");
      await sleep(500);
      // 部分站点（如 DeepSeek）上传图片后需要点开"识图"开关，模型才能看到图片内容；
      // 不点它，图片只被当成普通文档 → 模型会回复"没法打开这张图看内容"
      if (A.enableImage) {
        await sleep(400);
        var visionMsg = "";
        try { visionMsg = A.enableImage() || ""; } catch (e) { visionMsg = "异常: " + e; }
        log("识图开关: " + visionMsg);
      }
      log("探针 缓冲结束, 准备发送, fileInput.isConnected=" + fileInput.isConnected + " textEl.isConnected=" + (textEl ? textEl.isConnected : "?"));
      if (location.href !== urlAtStart) {
        log("对话在发送前被切换，本次不发送（转待补发队列）");
        return false;
      }
      var chunk = resultChunk(resultText);
      var beforeCnt = (chunk && chunk.length >= 10 && document.body)
        ? countOccurrences(document.body.innerText || "", chunk) : -1;
      // 点发送（多级兜底）：
      // 1) 站内选择器点发送按钮（最多 5 秒——上传期间按钮可能禁用）
      // 2) 回车（重新查询输入框后派发；输入框被清空即视为已提交，交给内容级确认判定）
      // 3) 几何智能点击（DeepSeek 的发送键是无 aria 的图标按钮，选择器永远点不到——实测）
      var sent = false;
      var tSend = Date.now();
      // 原子位移校验：与随后的点击/回车在同一同步帧内执行——单线程下用户操作无法插队，
      // "切换页面时消息被顺手发到新页面"的窗口由此彻底关闭
      var urlLeft = function () { return location.href !== urlAtStart; };
      while (Date.now() - tSend < 3000) {
        if (urlLeft()) { log("对话在发送前被切换，本次不发送（转待补发队列）"); return false; }
        try { sent = A.send(); } catch (e) { log("探针 send异常: " + e); }
        if (sent) break;
        await sleep(800);
      }
      log("探针 send()返回: " + sent + "（等待 " + (Date.now() - tSend) + "ms）");
      var freshInput = function () {
        var fe = null;
        try { fe = A.input(); } catch (e) {}
        return fe || textEl;
      };
      // 2) 智能点击（真正的发送键）——实测站内按钮无 aria、选择器点不到，它是正确提交的关键，
      //    必须放在"回车兜底"之前（此前回车假成功导致这里从未被执行，图片消息因此总是发不出去）
      if (!sent) {
        if (urlLeft()) { log("对话在发送前被切换，本次不发送（转待补发队列）"); return false; }
        var smartInfo = "";
        var smartOk = clickSendButtonSmart(function (info) { smartInfo = info; });
        log("探针 智能点击发送键: " + (smartOk ? "已点击" : "未命中") + "（" + smartInfo + "）");
        if (smartOk) { sent = true; await sleep(800); }
      }
      // 3) 回车兜底（最后手段）：只记录输入框状态，不再宣告"已提交"——
      //    实测回车后输入框被清空也可能没真正送达，真伪一律由后面的内容级确认判定
      if (!sent) {
        if (urlLeft()) { log("对话在发送前被切换，本次不发送（转待补发队列）"); return false; }
        var fe1 = freshInput();
        ["keydown", "keypress", "keyup"].forEach(function (t) {
          fe1.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        });
        await sleep(1500);
        if (urlLeft()) { log("对话在发送过程中被切换，按未送达处理（转待补发队列）"); return false; }
        var leftTxt = readInputText(freshInput());
        log("探针 回车兜底：输入框" + ((!leftTxt || leftTxt.indexOf("TOOL_RESULT") === -1) ? "已清空（真伪由送达确认判定）" : "内容仍在"));
      }
      if (!sent) log("探针 发送首选路径（选择器/智能点击）未命中，已走回车兜底");
      if (location.href !== urlAtStart) {
        log("对话在发送过程中被切换，按未送达处理（转待补发队列）");
        return false;
      }
      // 送达确认：页面里必须真的出现这条结果（图片消息因上传等待，提交可能慢，窗口放宽到约 18 秒）；
      // 出现"新的发送失败标记"（Server busy / 重试按钮）时自动点重试
      if (beforeCnt >= 0) {
        var failBase = countSendFailures();
        var retried = 0;
        var lastRetryTs = 0;
        log("等待结果在页面中出现（确认送达，最多 12 秒）…");
        for (var i = 0; i < 20; i++) {
          await sleep(600);
          var failNow = countSendFailures();
          if (failBase >= 0 && failNow > failBase && retried < 2 && Date.now() - lastRetryTs > 4000) {
            lastRetryTs = Date.now();
            retried++;
            var okRetry = clickSendRetry();
            log("检测到发送失败标记，已自动点重试（第 " + retried + " 次，点击" + (okRetry ? "成功" : "未命中") + "）");
            failBase = countSendFailures(); // 重试后旧标记可能仍在，把它当作新基线
          }
          if (countOccurrences(document.body.innerText || "", chunk) > beforeCnt) {
            if (countSendFailures() <= failBase) return true; // 页面出现结果消息且无新增失败标记 → 送达
          }
        }
        log("图片消息发送后未在页面里确认到（可能未送达），转待补发队列");
        return false;
      }
      return true;
    } catch (e) {
      log("图片附件发送异常: " + e);
      return false;
    }
  }

  async function typeAndSend(payload) {
    var el = null;
    try { el = A.input(); } catch (e) {}
    if (!el) return false;
    try {
      // 草稿保护：用户正在输入框里打字时不覆盖（最多等 30 秒，仍未清空则转剪贴板）
      if (!(await waitInputUsable(el, 30000))) {
        log("输入框里有内容（你可能正在打字），结果未自动发送，已转剪贴板");
        return false;
      }
      var urlAtStart = location.href;
      // 输入框里是 AI 自己 type_text 打的字 → 和工具结果合并成一条消息一起发（不丢 AI 的话，也不拆成两条）
      var resultPayload = payload;
      var own = readInputText(el);
      if (own && isOwnTypeText(own)) {
        payload = own + "\n\n" + payload;
        log("输入框里有 AI 用 type_text 打的字，已与工具结果合并成一条消息发送");
      }
      el.focus();
      await sleep(120);
      await A.fill(el, payload);
      lastFilledText = payload;
      await sleep(250);
      // 填充校验：内容必须真的进入输入框（受控组件偶发未同步；填失败绝不能误判"已发送"）。
      // 按内容长度判定而非硬编码 TOOL_RESULT——自我驱动 / 提示词注入发的是纯文本
      var expectedLen = payload.replace(/\s+/g, "").length;
      var landed = function (t) { return !!t && t.replace(/\s+/g, "").length >= Math.min(expectedLen * 0.8, 20); };
      var filledNow = readInputText(el);
      if (!landed(filledNow)) {
        await A.fill(el, payload);
        await sleep(250);
        filledNow = readInputText(el);
        if (!landed(filledNow)) {
          log("发送前校验未通过：结果未能写入输入框");
          return false;
        }
      }
      if (location.href !== urlAtStart) {
        log("对话在发送前被切换，本次不发送（转待补发队列）");
        return false;
      }
      // 送达确认的基线：页面里现有几条"这条结果"（连续相同命令时旧消息会留在页面上）
      var chunk = resultChunk(resultPayload);
      var beforeCnt = (chunk && chunk.length >= 10 && document.body)
        ? countOccurrences(document.body.innerText || "", chunk) : -1;
      var sent = false;
      if (location.href !== urlAtStart) {
        log("对话在发送前被切换，本次不发送（转待补发队列）");
        return false;
      }
      try { sent = A.send(); } catch (e) {}
      var pressEnter = function () {
        var te = el;
        try { te = A.input() || el; } catch (e) {}   // 重新查询：组件重渲染后旧引用可能已脱离 DOM
        ["keydown", "keypress", "keyup"].forEach(function (t) {
          te.dispatchEvent(new KeyboardEvent(t, {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
          }));
        });
      };
      if (!sent) {
        if (location.href !== urlAtStart) { log("对话在发送前被切换，本次不发送（转待补发队列）"); return false; }
        pressEnter();
      }
      // 发送验证 1：内容若仍留在输入框 → 没送出去
      await sleep(900);
      if (location.href !== urlAtStart) { log("对话在发送过程中被切换，按未送达处理（转待补发队列）"); return false; }
      var remains = readInputText(el);
      if (landed(remains)) {
        if (location.href !== urlAtStart) { log("对话在发送过程中被切换，按未送达处理（转待补发队列）"); return false; }
        pressEnter();
        await sleep(1100);
        remains = readInputText(el);
        if (landed(remains)) {
          if (location.href !== urlAtStart) { log("对话在发送过程中被切换，按未送达处理（转待补发队列）"); return false; }
          var smartInfo2 = "";
          var smartOk2 = clickSendButtonSmart(function (info) { smartInfo2 = info; });
          log("探针 智能点击发送键（文本路径）: " + (smartOk2 ? "已点击" : "未命中") + "（" + smartInfo2 + "）");
          if (smartOk2) { await sleep(1200); remains = readInputText(el); }
          if (landed(remains)) {
            log("发送验证未通过：内容仍留在输入框");
            return false;
          }
        }
      }
      if (location.href !== urlAtStart) {
        log("对话在发送过程中被切换，按未送达处理（转待补发队列）");
        return false;
      }
      // 发送验证 2（关键）：页面里必须真的出现这条结果消息（去空白比对特征段，计数增加才算送达）。
      // "点了发送 + 输入框被清空"都不等于送达——实测：切换对话瞬间发送会假成功、结果丢失；
      // 出现"新的发送失败标记"（Server busy / 重试按钮）时自动点重试
      if (beforeCnt >= 0) {
        var failBase = countSendFailures();
        var retried = 0;
        var lastRetryTs = 0;
        for (var i = 0; i < 25; i++) {
          await sleep(600);
          var failNow = countSendFailures();
          if (failBase >= 0 && failNow > failBase && retried < 2 && Date.now() - lastRetryTs > 4000) {
            lastRetryTs = Date.now();
            retried++;
            var okRetry = clickSendRetry();
            log("检测到发送失败标记，已自动点重试（第 " + retried + " 次，点击" + (okRetry ? "成功" : "未命中") + "）");
            failBase = countSendFailures(); // 重试后旧标记可能仍在，把它当作新基线
          }
          if (countOccurrences(document.body.innerText || "", chunk) > beforeCnt) {
            if (countSendFailures() <= failBase) return true; // 页面出现结果消息且无新增失败标记 → 送达
          }
        }
        log("发送后页面里未出现结果消息（可能未送达），转待补发队列");
        return false;
      }
      return true; // 特征段太短（极端情况），只能按旧口径处理
    } catch (e) {
      log("输入/发送异常: " + e);
      return false;
    }
  }

  // ---------- 页面悬浮控制按钮：随时暂停/恢复自动执行 ----------
  var ctrlBtn = null;
  function updateCtrlBtn(on) {
    if (!ctrlBtn) return;
    ctrlBtn.textContent = on ? "⏸ 暂停 FreeHarness" : "▶ 恢复 FreeHarness";
    ctrlBtn.style.background = on ? "rgba(163,45,45,.92)" : "rgba(59,109,17,.92)";
    ctrlBtn.title = on ? "点击暂停：AI 的工具调用将不再执行，也不会回传结果" : "点击恢复自动执行";
  }
  function mountCtrlBtn() {
    try {
      if (ctrlBtn) return;
      if (!document.body) { setTimeout(mountCtrlBtn, 800); return; }
      ctrlBtn = document.createElement("button");
      ctrlBtn.id = "freeharness-ctrl";
      ctrlBtn.type = "button";
      ctrlBtn.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;" +
        "padding:7px 13px;border:none;border-radius:18px;color:#fff;font:12px/1.4 system-ui,sans-serif;" +
        "cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.28);opacity:.85;transition:opacity .2s,background .2s;";
      ctrlBtn.addEventListener("mouseenter", function () { ctrlBtn.style.opacity = "1"; });
      ctrlBtn.addEventListener("mouseleave", function () { ctrlBtn.style.opacity = ".85"; });
      ctrlBtn.addEventListener("click", function () {
        setting("enabled", true).then(function (now) {
          chrome.storage.local.set({ h_enabled: !now });
          updateCtrlBtn(!now);
          log(now ? "已暂停自动执行（页面按钮 / popup 开关可恢复）" : "已恢复自动执行");
        });
      });
      document.body.appendChild(ctrlBtn);
      setting("enabled", true).then(updateCtrlBtn);
      chrome.storage.onChanged.addListener(function (ch, area) {
        if (area === "local" && ch.h_enabled) updateCtrlBtn(!!ch.h_enabled.newValue);
      });
    } catch (e) {}
  }

  // ---------- 监听（防抖 + 稳定检测 + 轮询兜底） ----------
  // 其他扩展可能持续改动 DOM，把防抖计时器无限重置，只靠 MutationObserver 会永远不触发；
  // 轮询兜底每 2.5 秒强制检查一次（check 内部有 busy 锁与去重，重复执行无害）。
  function observe() {
    var timer = null;
    var mo = new MutationObserver(function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, STABLE_MS);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(check, 2500); // 首次检查
    setInterval(check, 2500); // 轮询兜底
    // 心跳保活：MV3 service worker 约 30 秒无活动即休眠，定期唤醒防消息挂起；
    // 同时向后台登记"本页活着 + 显示的是哪个对话"（保活标签判重/僵尸页面识别都靠它）
    function whHello() {
      try { chrome.runtime.sendMessage({ type: "harness-keepalive", url: location.href }, function () {}); } catch (e) {}
    }
    whHello(); // 脚本就绪即登记一次
    setInterval(whHello, 20000);

    // ===== 后台防节流（"切走就停、切回才动"的物理根因根治）=====
    // Chrome/Edge 对"隐藏且静音"的标签页：隐藏超 5 分钟后启动强化节流，定时器降到
    // 1 次/分钟——检测、心跳、sleep、脉冲全部瘫痪，后台任务卡死，切回前台才恢复。
    // 浏览器对"正在播放音频的页面"豁免强化节流（音频播放同时豁免标签页冻结）。
    // 因此挂一个听不见的静音 AudioContext 让页面保持"非静音"：定时器维持 1 秒粒度，
    // 后台才能真正跑。静音，不显示播放图标，对用户零感知。
    var whAudioCtx = null, whAudioResumeT = 0;
    function ensureWakeAudio() {
      try {
        if (!whAudioCtx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          whAudioCtx = new AC();
          var buf = whAudioCtx.createBuffer(1, whAudioCtx.sampleRate, whAudioCtx.sampleRate); // 全零=静音
          var src = whAudioCtx.createBufferSource();
          src.buffer = buf; src.loop = true;
          src.connect(whAudioCtx.destination);
          src.start();
        }
        if (whAudioCtx.state === "suspended" && Date.now() - whAudioResumeT > 5000) {
          whAudioResumeT = Date.now();
          whAudioCtx.resume();
        }
      } catch (e) {}
    }
    ensureWakeAudio(); // 页面可见时预创建（autoplay 政策此时最易放行）
    setInterval(ensureWakeAudio, 15000);
    ["click", "keydown", "pointerdown"].forEach(function (ev) {
      document.addEventListener(ev, ensureWakeAudio, true); // 用户手势兜底 resume
    });
  }

  if (document.body) {
    mountCtrlBtn();
    observe();
  } else {
    document.addEventListener("DOMContentLoaded", function () { mountCtrlBtn(); observe(); });
  }
})();
