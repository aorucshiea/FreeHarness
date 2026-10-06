// WebHarness 主逻辑：监听 AI 消息 → 提取工具调用 → 本地执行 → 结果自动发回
(function () {
  if (window.__WH_ACTIVE) return; // 防止 popup 主动注入时重复初始化
  window.__WH_ACTIVE = true;

  var A = WHAdapters.getAdapter();
  // 主世界探针：DevTools Console 跑在页面主世界，查不到隔离世界的 __WH_ACTIVE（永远 false，
  // 属于误诊）。DOM 属性跨世界共享，把激活状态写到 <html> 的 dataset 上供用户核实。
  try { document.documentElement.dataset.wh = A.name; } catch (e) {}
  var extractCalls = WHProtocol.extractCalls;
  var formatResults = WHProtocol.formatResults;
  var fingerprint = WHProtocol.fingerprint;

  var STABLE_MS = 1500;       // DOM 停止变化多久视为"生成结束"
  var processed = new Set();  // 已处理消息指纹（防重复执行）
  var busy = false;           // 执行中锁
  var rounds = 0;             // 本次任务连续工具调用轮数
  var lastCallFp = "";        // 连续相同调用检测
  var repeatCount = 0;

  console.log("[WebHarness] 已激活，站点适配:", A.name);

  // 预热：忽略注入前已存在的最后一条 AI 消息（历史对话，避免"幽灵发送"）
  try {
    var t0 = A.lastAssistant();
    if (t0) processed.add("m" + fingerprint(t0.slice(0, 4000)));
  } catch (e) {}

  // 响应 popup 的存活探测（用于判断当前页是否已注入）
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "harness-ping") { sendResponse({ active: true, adapter: A.name }); return true; }
  });

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function log(msg) {
    console.log("[WebHarness]", msg);
    try {
      chrome.storage.local.get("log", function (o) {
        var arr = o.log || [];
        arr.push({ t: new Date().toLocaleTimeString(), msg: String(msg).slice(0, 300) });
        while (arr.length > 120) arr.shift();
        chrome.storage.local.set({ log: arr });
      });
    } catch (e) {}
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

  // 执行（15 秒超时自愈：MV3 service worker 休眠/重启时消息可能永久挂起，
  // 绝不能让它卡死执行锁；超时会构造错误结果发回 AI，保持对话可继续）
  function sendExec(calls) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ results: calls.map(function () { return { ok: false, error: "执行超时：扩展后台 15 秒无响应（后台可能已休眠），请点扩展图标或刷新页面后重试" }; }) });
      }, 15000);
      try {
        chrome.runtime.sendMessage({ type: "harness-exec", calls: calls }, function (res) {
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
  async function check() {
    if (busy) return;
    if (!(await setting("enabled", true))) return;
    if (A.isGenerating && A.isGenerating()) {
      if (!genSince) genSince = Date.now();
      if (Date.now() - genSince < 120000) return; // 2 分钟内信任"生成中"
      // 超过 2 分钟仍报生成中：大概率是常驻按钮误判，放行继续检查
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

    var calls = extractCalls(text);
    if (!calls.length) { rounds = 0; return; } // 该消息无调用：新任务，重置轮次

    // 安全边界：思考(reaasoning)里的 [TOOL_CALL] 是模型"内心戏"（推演/示例/假想），绝不能执行。
    // 思考流永远先于正文流，合规的调用必是消息里最后一个 [TOOL_CALL] 块——只执行它。
    if (calls.length > 1) {
      log("检测到 " + calls.length + " 个调用块，按协议一轮一个，只执行最后一个（其余视为思考中的推演）");
      calls = calls.slice(-1);
    }

    var fp = "m" + fingerprint(text.slice(0, 4000));
    if (processed.has(fp)) return;
    processed.add(fp);
    if (processed.size > 300) processed.clear();

    busy = true;
    var busyTimer = setTimeout(function () { busy = false; log("执行锁超时，已强制重置"); }, 90000); // 硬兜底
    try {
      log("检测到 " + calls.length + " 个工具调用 [" + A.name + "]");

      // 连续相同调用 → 判定死循环
      var cfp = fingerprint(JSON.stringify(calls));
      if (cfp === lastCallFp) { repeatCount++; } else { repeatCount = 0; lastCallFp = cfp; }
      if (repeatCount >= 2) {
        log("连续 3 轮完全相同的调用，判定卡死，已停止。请人工介入。");
        return;
      }

      var maxRounds = await setting("maxRounds", 20);
      if (rounds >= maxRounds) {
        log("已达最大轮次 " + maxRounds + "，已停止。如需继续请重新启用或调大上限。");
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

      var results = [];
      if (realCalls.length > 0) {
        var res = await sendExec(realCalls);
        results = (res && res.results) || realCalls.map(function () {
          return { ok: false, error: "扩展后台无响应" };
        });
      }
      results = localErrors.concat(results);
      if (!results.length) return;

      // 图片结果：base64 只走附件通道，文字消息里替换为简短说明（11MB 文本不能进输入框）
      var images = [];
      var displayResults = (results || []).map(function (r) {
        if (r && r.ok && typeof r.result === "string" && r.result.indexOf('{"__image__":') === 0) {
          try {
            var meta = JSON.parse(r.result);
            if (meta && meta.__image__ && meta.data) {
              images.push(meta);
              return { ok: true, result: "[图片已作为附件随消息上传，请直接查看附图]" };
            }
          } catch (e) {}
        }
        return r;
      });

      var payload = formatResults(displayResults);
      rounds++;

      var autoSend = await setting("autoSend", true);
      if (!autoSend) {
        log("自动发送已关闭。结果已写入剪贴板，请手动粘贴发送。");
        try { await navigator.clipboard.writeText(payload); } catch (e) {}
        return;
      }

      await sleep(400);
      var sent;
      if (images.length > 0) {
        var promptText = (calls[0] && calls[0].params && calls[0].params.prompt)
          ? calls[0].params.prompt
          : "请查看附图并描述你看到的内容。";
        sent = await typeAndSendWithImage(payload + "\n\n" + promptText, images[0]);
      } else {
        sent = await typeAndSend(payload);
      }
      log(sent ? "已自动发送工具结果（第 " + rounds + " 轮）" : "自动发送失败，请手动发送（结果见控制台/剪贴板）");
      if (!sent) {
        try { await navigator.clipboard.writeText(payload); } catch (e) {}
        console.log("[WebHarness] 完整结果:", payload);
      }
    } finally {
      clearTimeout(busyTimer);
      busy = false;
    }
  }

  // ---------- 输入与发送 ----------
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

  // 带图片附件发送：文字进输入框，图片经 DataTransfer 塞入 file input 触发站点上传
  async function typeAndSendWithImage(text, meta) {
    var textEl = null;
    try { textEl = A.input(); } catch (e) {}
    try {
      if (textEl) {
        textEl.focus();
        await sleep(120);
        await A.fill(textEl, text);
        await sleep(300);
      }
      // 关键：填文字会触发 Svelte/React 状态更新，输入区组件可能重渲染、
      // 之前查到的 file input 引用变成已脱离文档树的死节点。必须在填字之后重新查询。
      var fileInput = (A.fileInput && A.fileInput()) || genericFileInput();
      if (!fileInput) {
        log("页面找不到文件上传入口，降级为纯文本发送");
        return typeAndSend(text);
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
      await sleep(3000);
      log("探针 缓冲结束, 准备发送, fileInput.isConnected=" + fileInput.isConnected + " textEl.isConnected=" + (textEl ? textEl.isConnected : "?"));
      var sent = false;
      try { sent = A.send(); } catch (e) { log("探针 send异常: " + e); }
      log("探针 send()返回: " + sent);
      if (sent) return true;
      var target = textEl || fileInput;
      ["keydown", "keyup"].forEach(function (t) {
        target.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      });
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
      el.focus();
      await sleep(120);
      await A.fill(el, payload);
      await sleep(350);
      var sent = false;
      try { sent = A.send(); } catch (e) {}
      if (sent) return true;
      // 回退：模拟 Enter
      ["keydown", "keyup"].forEach(function (t) {
        el.dispatchEvent(new KeyboardEvent(t, {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      });
      return true;
    } catch (e) {
      log("输入/发送异常: " + e);
      return false;
    }
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
    // 心跳保活：MV3 service worker 约 30 秒无活动即休眠，定期唤醒防消息挂起
    setInterval(function () {
      try { chrome.runtime.sendMessage({ type: "harness-keepalive" }, function () {}); } catch (e) {}
    }, 20000);
  }

  if (document.body) {
    observe();
  } else {
    document.addEventListener("DOMContentLoaded", observe);
  }
})();
