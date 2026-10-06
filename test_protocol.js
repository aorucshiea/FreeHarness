// protocol.js 单元测试（node 直接跑，无浏览器依赖）
const P = require("./extension/protocol.js");

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + "\n    期望: " + e + "\n    实际: " + a); }
}

console.log("== extractCalls ==");

// 1. 标准单个调用
let r = P.extractCalls('好的，我来执行：\n[TOOL_CALL]\n{"tool":"run_command","params":{"command":"dir"}}\n[/TOOL_CALL]');
eq("标准单个", r, [{ tool: "run_command", params: { command: "dir" } }]);

// 2. AI 加了 markdown 围栏
r = P.extractCalls('[TOOL_CALL]\n```json\n{"tool":"list_dir","params":{"path":"C:\\\\Users"}}\n```\n[/TOOL_CALL]');
eq("markdown围栏容错", r, [{ tool: "list_dir", params: { path: "C:\\Users" } }]);

// 3. 无调用
r = P.extractCalls("任务完成，桌面共有 5 个文件。");
eq("无调用返回空数组", r, []);

// 4. JSON 语法错误 → parse_error 不抛异常
r = P.extractCalls('[TOOL_CALL]\n{"tool": "run_command", "params": {"command": "oops}}\n[/TOOL_CALL]');
eq("坏JSON容错", r.length === 1 && r[0].tool === "__parse_error__", true);

// 5. 多个调用块
r = P.extractCalls('[TOOL_CALL]{"tool":"read_file","params":{"path":"a.txt"}}[/TOOL_CALL]\n中间文字\n[TOOL_CALL]{"tool":"write_file","params":{"path":"b.txt","content":"x"}}[/TOOL_CALL]');
eq("多块提取", r.map(c => c.tool), ["read_file", "write_file"]);

// 6. 用户消息里引用了旧结果（不含 TOOL_CALL 标记）→ 不误提取
r = P.extractCalls('上次你调用了 {"tool":"run_command"} 工具');
eq("无标记不提取", r, []);

// 7. 空参数对象缺省
r = P.extractCalls('[TOOL_CALL]{"tool":"list_dir"}[/TOOL_CALL]');
eq("缺params默认空对象", r, [{ tool: "list_dir", params: {} }]);

// 8. 单反斜杠路径（AI 常见错误：JSON 非法转义）→ 容错修复
r = P.extractCalls('[TOOL_CALL]\n{"tool":"list_dir","params":{"path":"C:\\Users\\yt\\Desktop"}}\n[/TOOL_CALL]');
eq("单反斜杠路径容错", r, [{ tool: "list_dir", params: { path: "C:\\Users\\yt\\Desktop" } }]);

// 9. 小写 \users（\u 后非 hex）→ 容错修复
r = P.extractCalls('[TOOL_CALL]{"tool":"list_dir","params":{"path":"C:\\users\\test"}}[/TOOL_CALL]');
eq("小写users容错", r, [{ tool: "list_dir", params: { path: "C:\\users\\test" } }]);

// 10. 合法双反斜杠不受影响
r = P.extractCalls('[TOOL_CALL]{"tool":"run_command","params":{"command":"dir C:\\\\Users"}}[/TOOL_CALL]');
eq("双反斜杠正常", r, [{ tool: "run_command", params: { command: "dir C:\\Users" } }]);

// 11. 合法转义 \\n 不被破坏（修复不误伤）
r = P.extractCalls('[TOOL_CALL]{"tool":"write_file","params":{"path":"C:\\\\a.txt","content":"line1\\nline2"}}[/TOOL_CALL]');
eq("合法换行转义保留", r[0].params.content, "line1\nline2");

// 12. 宽松解析路径下：文件内容里的真换行必须保留（写脚本/多行文本场景）
r = P.extractCalls('[TOOL_CALL]\n{"tool": "write_file", "params": {"path": "C:\\a.ps1", "content": "AAA\\nBBB"}}\n[/TOOL_CALL]');
eq("宽松解析保留内容换行", r[0].params.content, "AAA\nBBB");

// 13. 宽松解析路径下：路径里的 \\t 仍还原为字面（C:\\test 场景）
r = P.extractCalls('[TOOL_CALL]{"tool":"list_dir","params":{"path":"C:\\test\\folder"}}[/TOOL_CALL]');
eq("宽松解析还原路径制表符", r[0].params.path.indexOf("\t") === -1, true);

// 14. 结束标记笔误 [/TOOL_CALL}（花括号）也能提取
r = P.extractCalls('[TOOL_CALL]\n{"tool":"open_app","params":{"target":"notepad"}}\n[/TOOL_CALL}');
eq("花括号结束标记容错", r, [{ tool: "open_app", params: { target: "notepad" } }]);

// 15. 无结束标记的残缺块不提取（避免把正文当 JSON）
r = P.extractCalls('[TOOL_CALL]\n{"tool":"run_command"}\n后面还有正文没有结束标记');
eq("残缺块不提取", r, []);

// 16. content 含真实换行（AI 写多行脚本常见）→ 修复 3 转义后解析成功（\" 为合法转义保留）
r = P.extractCalls('[TOOL_CALL]{"tool":"write_file","params":{"path":"C:\\a.ps1","content":"line1\nline2\n[DllImport(\\\"user32.dll\\\")]"}}[/TOOL_CALL]');
eq("裸换行容错", r.length === 1 && r[0].tool === "write_file" && r[0].params.content.indexOf("\n") !== -1 && r[0].params.content.indexOf("[DllImport(\"user32.dll\")]") !== -1, true);

// 17. 解析彻底失败时产出 __parse_error__ 占位（供本地回错误，不再误导为未知工具）
r = P.extractCalls('[TOOL_CALL]{这不是json}[/TOOL_CALL]');
eq("解析失败占位", r.length === 1 && r[0].tool === "__parse_error__", true);

// 18. 中文全角引号（中文模型常见病）→ 归一化后解析成功
r = P.extractCalls('[TOOL_CALL]{“tool”: “run_command”, “params”: {“command”: “hostname”}}[/TOOL_CALL]');
eq("全角引号容错", r.length === 1 && r[0].tool === "run_command" && r[0].params.command === "hostname", true);

console.log("== formatResults ==");
const out = P.formatResults([{ ok: true, result: "abc" }, { ok: false, error: "boom" }]);
eq("格式包含标记", out.startsWith("[TOOL_RESULT]\n") && out.endsWith("\n[/TOOL_RESULT]"), true);
const parsed = JSON.parse(out.replace("[TOOL_RESULT]\n", "").replace("\n[/TOOL_RESULT]", ""));
eq("结果可回解析", parsed.results.length, 2);
eq("结果顺序保留", parsed.results[1].error, "boom");

console.log("== fingerprint ==");
eq("稳定哈希", P.fingerprint("abc"), P.fingerprint("abc"));
eq("区分不同串", P.fingerprint("abc") !== P.fingerprint("abd"), true);

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
