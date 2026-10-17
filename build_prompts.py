# -*- coding: utf-8 -*-
"""从 PROMPT_TEMPLATE.md 生成 extension/prompts.js（按平台定制三份核心提示词）。

PROMPT_TEMPLATE.md 是唯一真相源：两个独立成行的 --- 之间是正文，其中：
  - {{PLACEHOLDER}} 会按平台替换（shell 说明、路径示例、转义规则、粘贴键）
  - <!--cat:xxx--> ... <!--/cat:xxx--> 标记工具分类，popup 注入时可勾选裁剪

用法：python build_prompts.py
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "PROMPT_TEMPLATE.md")
DST = os.path.join(ROOT, "extension", "prompts.js")

PLATFORMS = {
    "win32": {
        "{{OS_NAME}}": "（Windows）",
        "{{SHELL_NOTE}}": "Windows cmd",
        "{{HOME_PATH}}": "C:/Users/me",
        "{{PATH_RULE}}": "（Windows 如 `C:/Users/me/x.txt`）",
        "{{PASTE_KEY}}": "ctrl+v",
        "{{ESCAPE_RULE}}": (
            "**JSON 里的 Windows 路径反斜杠必须写成双反斜杠**："
            "`\"C:\\\\Users\\\\yt\\\\Desktop\"`（写成单反斜杠会导致解析失败；"
            "也可以直接用正斜杠 `C:/Users/yt/Desktop`，完全避免转义问题）。"
            "字符串里的换行必须写成 `\\n`（反斜杠+n），不能输出真实换行；多行脚本用 `\\n` 拼接。"
        ),
    },
    "darwin": {
        "{{OS_NAME}}": "（macOS）",
        "{{SHELL_NOTE}}": "sh",
        "{{HOME_PATH}}": "/Users/me",
        "{{PATH_RULE}}": "（如 `/Users/me/x.txt`）",
        "{{PASTE_KEY}}": "cmd+v",
        "{{ESCAPE_RULE}}": (
            "路径用 `/` 分隔，JSON 里无需转义。"
            "字符串里的换行必须写成 `\\n`（反斜杠+n），不能输出真实换行；多行脚本用 `\\n` 拼接。"
        ),
    },
    "linux": {
        "{{OS_NAME}}": "（Linux）",
        "{{SHELL_NOTE}}": "sh",
        "{{HOME_PATH}}": "/home/me",
        "{{PATH_RULE}}": "（如 `/home/me/x.txt`）",
        "{{PASTE_KEY}}": "ctrl+v",
        "{{ESCAPE_RULE}}": (
            "路径用 `/` 分隔，JSON 里无需转义。"
            "字符串里的换行必须写成 `\\n`（反斜杠+n），不能输出真实换行；多行脚本用 `\\n` 拼接。"
        ),
    },
}


def load_body():
    with open(SRC, encoding="utf-8") as f:
        md = f.read()
    # 只认「独立成行的 ---」（说明文字里出现的 `---` 不算）
    lines = md.splitlines(keepends=True)
    marks = [i for i, line in enumerate(lines) if line.strip() == "---"]
    if len(marks) < 2:
        raise SystemExit("PROMPT_TEMPLATE.md 结构异常：需要两行独立的 --- 分割线")
    return "".join(lines[marks[0] + 1:marks[1]]).strip()


def render(body, mapping):
    text = body
    for k, v in mapping.items():
        text = text.replace(k, v)
    leftover = re.findall(r"\{\{[A-Z_]+\}\}", text)
    if leftover:
        raise SystemExit("存在未替换的占位符: %s" % sorted(set(leftover)))
    if "[TOOL_CALL]" not in text:
        raise SystemExit("提示词缺少 [TOOL_CALL] 标记，疑似模板结构错误")
    if text.count("<!--cat:") != 6:
        raise SystemExit("工具分类标记数量异常：期望 6 个，实际 %d" % text.count("<!--cat:"))
    return text


def main():
    body = load_body()
    cores = {name: render(body, mapping) for name, mapping in PLATFORMS.items()}
    js = (
        "// 由 build_prompts.py 从 PROMPT_TEMPLATE.md 自动生成，请勿手改。\n"
        "// cores: 按平台定制的核心提示词（只含本平台的 shell/路径/转义说明）。\n"
        "// <!--cat:xxx--> ... <!--/cat:xxx--> 标记工具分类，popup 注入时按用户勾选裁剪。\n"
        "(function (root) {\n"
        "  var CORES = " + json.dumps(cores, ensure_ascii=False, indent=2) + ";\n"
        "  root.WH_PROMPTS = { cores: CORES };\n"
        "})(typeof window !== \"undefined\" ? window : globalThis);\n"
    )
    with open(DST, "w", encoding="utf-8", newline="\n") as f:
        f.write(js)
    for name, text in cores.items():
        print("%-7s %d 字" % (name, len(text)))
    print("generated:", DST)


if __name__ == "__main__":
    main()
