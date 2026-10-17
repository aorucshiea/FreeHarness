// FreeHarness 协议模块 — 纯函数，无 chrome/DOM 依赖，可被 node 单测
// 协议：AI 在回复中输出
//   [TOOL_CALL]{"tool":"run_command","params":{"command":"dir"}}[/TOOL_CALL]
// 系统执行后把结果作为用户消息发回：
//   [TOOL_RESULT]<json>[/TOOL_RESULT]
(function (root) {
  // 宽松 JSON 解析：AI 常输出 "C:\Users" 这类含非法转义的“类 JSON”，逐级修复
  function restoreControls(s) {
    // 仅对 Windows 路径类字符串还原（如 C:\test 的 \t 是解析产物，本意是字面）；
    // 普通文本（文件内容等）里的真换行/制表符是合法的，绝不能动。
    // 判定：以盘符开头（解析后盘符后可能紧跟控制字符，故不能要求冒号后必是反斜杠）
    if (!/^[A-Za-z]:/.test(s) && !s.startsWith("\\\\")) return s;
    return s.replace(/[\x00-\x1f]/g, function (c) {
      var map = { "\t": "\\t", "\n": "\\n", "\r": "\\r", "\b": "\\b", "\f": "\\f" };
      return map[c] || c;
    });
  }
  function reviveStrings(v) {
    if (typeof v === "string") return restoreControls(v);
    if (Array.isArray(v)) return v.map(reviveStrings);
    if (v && typeof v === "object") {
      var o = {};
      for (var k in v) o[k] = reviveStrings(v[k]);
      return o;
    }
    return v;
  }

  // 修复字符串内部的裸双引号：AI 常直接写 dir "C:\path\工作文档"，
  // 内层引号未转义会提前结束 JSON 字符串。启发式：字符串内遇到的 "，
  // 若其后第一个非空白字符不是 , } ] : 或已是结尾，则视为内容引号并补转义。
  function fixBareQuotes(s) {
    var out = "";
    var inStr = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === "\\") {
        out += c + (s[i + 1] || "");
        i++;
        continue;
      }
      if (c === "\"") {
        if (!inStr) {
          inStr = true;
          out += c;
          continue;
        }
        var j = i + 1;
        while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
        var nx = s[j];
        if (j >= s.length || nx === "," || nx === "}" || nx === "]" || nx === ":") {
          inStr = false;
          out += c;
        } else {
          out += "\\\"";
        }
        continue;
      }
      out += c;
    }
    return out;
  }

  function lenientParse(raw) {
    // 严格解析也能出"合法转义但语义错误"（C:\test 的 \t）——reviveStrings 内部
    // 只对盘符开头/UNC 字符串还原控制字符，普通文本（文件内容等）绝不受影响
    try { return reviveStrings(JSON.parse(raw)); } catch (e) {}
    // 全角引号归一化（中文模型常见病：“”→""）：仅在严格解析失败后启用，
    // 正常解析的内容绝不会被动
    var norm = raw.replace(/“/g, '"').replace(/”/g, '"').replace(/‘/g, "'").replace(/’/g, "'");
    if (norm !== raw) { try { return reviveStrings(JSON.parse(norm)); } catch (e) {} }
    // AI 真实输出常多种错误并存（路径单反斜杠 + content 裸换行），各级修复必须组合叠加：
    // A: 非法反斜杠转义（\U \y \a 等）→ 双反斜杠
    var fixedA = norm.replace(/\\(?![\\/"bfnrtu])/g, "\\\\");
    try { return reviveStrings(JSON.parse(fixedA)); } catch (e) {}
    // B: A + 裸控制字符（真实换行/制表符）→ 转义序列
    var fixedB = fixedA.replace(/[\x00-\x1f]/g, function (c) { return JSON.stringify(c).slice(1, -1); });
    try { return reviveStrings(JSON.parse(fixedB)); } catch (e) {}
    // C: 更强的反斜杠修复（\u 后非 4 位 hex 也算非法）+ 裸控制字符
    var fixedC = norm
      .replace(/\\(?![\\/"bfnrt]|u[0-9a-fA-F]{4})/g, "\\\\")
      .replace(/[\x00-\x1f]/g, function (c) { return JSON.stringify(c).slice(1, -1); });
    try { return reviveStrings(JSON.parse(fixedC)); } catch (e) {}
    // D: 反斜杠修复 + 字符串内部的裸双引号（如 command 里直接写 "C:\path\文件"）+ 裸控制字符
    var fixedD = fixBareQuotes(fixedA)
      .replace(/[\x00-\x1f]/g, function (c) { return JSON.stringify(c).slice(1, -1); });
    try { return reviveStrings(JSON.parse(fixedD)); } catch (e) {}
    return null;
  }

  function extractCalls(text) {
    // 结束标记容忍 AI 笔误：[/TOOL_CALL}（花括号）也能识别
    var re = /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL[\]\}]/g;
    var calls = [];
    var m;
    while ((m = re.exec(text)) !== null) {
      var raw = m[0]
        .replace(/^\[TOOL_CALL\]/, "")
        .replace(/\[\/TOOL_CALL[\]\}]$/, "")
        .trim();
      // 容错：剥掉 AI 可能加的 markdown 围栏
      raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      if (!raw) continue;
      var obj = lenientParse(raw);
      if (obj && typeof obj.tool === "string") {
        calls.push({ tool: obj.tool, params: (obj.params && typeof obj.params === "object") ? obj.params : {} });
      } else {
        calls.push({ tool: "__parse_error__", raw: raw.slice(0, 500), error: obj === null ? "JSON 解析失败" : "缺少 tool 字段" });
      }
    }
    return calls;
  }

  function formatResults(results) {
    var payload;
    try {
      payload = JSON.stringify({ results: results });
    } catch (e) {
      payload = JSON.stringify({ results: [{ ok: false, error: "结果序列化失败: " + e }] });
    }
    return "[TOOL_RESULT]\n" + payload + "\n[/TOOL_RESULT]";
  }

  function fingerprint(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  var api = { extractCalls: extractCalls, formatResults: formatResults, fingerprint: fingerprint };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // node 测试用
  }
  root.WHProtocol = api;
})(typeof window !== "undefined" ? window : globalThis);
