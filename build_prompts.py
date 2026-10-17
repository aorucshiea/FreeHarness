# -*- coding: utf-8 -*-
"""从 PROMPT_TEMPLATE.md 生成 extension/prompts.js（核心提示词常量）。

PROMPT_TEMPLATE.md 是唯一真相源：第一个 --- 之前是说明、两个 --- 之间是核心提示词正文、
第二个 --- 之后是使用提示。改完模板跑一次本脚本即可同步扩展内置版本。

用法：python build_prompts.py
"""
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "PROMPT_TEMPLATE.md")
DST = os.path.join(ROOT, "extension", "prompts.js")

with open(SRC, encoding="utf-8") as f:
    md = f.read()

# 只认「独立成行的 ---」作分割线（说明文字里出现的 `---` 不算，比如反引号内的示例）
lines = md.splitlines(keepends=True)
marks = [i for i, line in enumerate(lines) if line.strip() == "---"]
if len(marks) < 2:
    raise SystemExit("PROMPT_TEMPLATE.md 结构异常：需要两行独立的 --- 分割线")
core = "".join(lines[marks[0] + 1:marks[1]]).strip()
if "[TOOL_CALL]" not in core:
    raise SystemExit("提取到的核心提示词不含 [TOOL_CALL] 标记，疑似分割线结构错误")

js = (
    "// 由 build_prompts.py 从 PROMPT_TEMPLATE.md 自动生成，请勿手改。\n"
    "// 核心提示词：包含工具协议与格式要求，锁定不可修改——改坏任何一条 AI 就可能不再输出 [TOOL_CALL]。\n"
    "(function (root) {\n"
    "  var CORE = " + json.dumps(core, ensure_ascii=False) + ";\n"
    "  root.WH_PROMPTS = { core: CORE };\n"
    "})(typeof window !== \"undefined\" ? window : globalThis);\n"
)

with open(DST, "w", encoding="utf-8", newline="\n") as f:
    f.write(js)

print("generated:", DST)
print("core chars:", len(core))
