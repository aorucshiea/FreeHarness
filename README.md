# FreeHarness — 让免费网页 AI 变成能操作你电脑的 Agent

网页版 AI（ DeepSeek / 通义 / 智谱 / 元宝 / 豆包 / Gemini/ChatGPT / Claude / Kimi ）免费但没有本地执行能力。
WebHarness 把 Agent 的 harness 搬到网页上：**扩展捕捉网页 AI 输出的工具调用 → 在你电脑上执行 → 结果自动发回网页**，形成完整的 Agent 循环。

仍处于早期开发阶段，满足了基本的功能，另外许多harness功能尚未完善。
预计未来一个月内将填补大多数功能。
觉得该项目“有点意思”？那么star一下，可能让它更加闪光！
```
网页 AI 回复 [TOOL_CALL]{...}
      │
      ▼  ① 浏览器扩展监听到新消息稳定
本地服务 127.0.0.1:8765
      │  ② 执行命令 / 读写文件 / 列目录
      ▼  ③ 结果 JSON 化
网页输入框自动填入 [TOOL_RESULT] 并发送 ──▶ AI 继续循环，直到任务完成
```

## 目录结构

```
webharness/
├── server/
│   ├── harness_server.py    本地执行服务（零依赖，Python 3.8+）
│   └── start_server.bat     双击启动
├── extension/               浏览器扩展（Edge / Chrome 通用）
│   ├── manifest.json
│   ├── protocol.js          工具调用解析（纯函数）
│   ├── adapters.js          各网站 DOM 适配器
│   ├── content.js           主循环：监听→执行→发回
│   ├── background.js        转发到本地服务
│   └── popup.html/js        控制台：开关 / 状态 / 日志
├── PROMPT_TEMPLATE.md        给网页 AI 的提示词模板（必读）
└── README.md                本文件
```

## 安装（一次性，约 2 分钟）

### 第 1 步：启动本地服务

双击 `server\start_server.bat`，看到：

```
====================================================
 WebHarness 本地执行服务  v0.1
 地址: http://127.0.0.1:8765
 工具: append_file, list_dir, read_file, run_command, write_file
====================================================
```

即成功。这个窗口需要保持开着（用完可关闭）。需要电脑装有 Python 3.8+（`python --version` 可查）。

**自动启动（推荐，配一次永久省事）**

配置后，**点扩展图标时若服务没在运行会自动拉起**，不用再找 bat 双击。在项目根目录执行：

```
python server\launcher\install_host.py
```

它会往注册表（HKCU，无需管理员权限）注册一个 Native Messaging Host 并绑定扩展 ID。
若以后移动了项目目录、或重新加载扩展导致 ID 变化，带上新 ID 重跑：`python server\launcher\install_host.py <扩展ID>`（ID 显示在 edge://extensions 扩展卡片上）。

### 第 2 步：安装浏览器扩展（Edge 或 Chrome）

1. 打开 `edge://extensions`（Chrome 则是 `chrome://extensions`）
2. 打开右上角/左侧的 **"开发人员模式 / Developer mode"** 开关
3. 点 **"加载解压缩扩展 / Load unpacked"**
4. 选择本项目的 `extension` 文件夹（不是 webharness 根目录！）
5. 工具栏出现 WebHarness 图标即成功

### 第 3 步：使用

1. 打开 `PROMPT_TEMPLATE.md`，复制分割线内的全部内容
2. 新开一个网页 AI 对话，把模板作为第一条消息发出，等 AI 回复"就绪"
3. 直接下达任务，例如：
   - "看看我桌面有什么文件"
   - "把 D:\notes 里所有 txt 文件合并成一个 notes_all.txt"
   - "截个图存到桌面，然后打开画图给它"
   - "查一下本机 IP 和磁盘剩余空间，写一份报告存到桌面"
   - "我复制了一段文字，读一下剪贴板并总结"
   - "列出当前打开的窗口，把记事本窗口切到前台"
4. AI 输出 [TOOL_CALL] → 本地执行 → 结果自动发回 → AI 继续，全自动循环
5. 点击扩展图标可打开控制台：总开关、自动发送开关、轮次上限、执行日志

## 工具一览（18 个）

| 工具 | 说明 |
|---|---|
| run_command | 执行 Windows 命令（超时杀整进程树，返回部分输出） |
| read_file / write_file / append_file | 文件读写（自动建目录） |
| list_dir | 列目录（类型/大小/修改时间） |
| screenshot | 全屏截图存 PNG（需 Pillow；默认存系统临时目录，只保留最近 20 张） |
| view_image | **让 AI 直接"看到"图片**——图片作为附件自动上传到对话（多模态识图） |
| open_app | 打开程序/文件/网址（系统关联） |
| clipboard_read / clipboard_write | 剪贴板文本读写 |
| list_windows / activate_window | 枚举可见窗口 / 按标题关键词激活窗口 |
| mouse_move / mouse_click | 移动光标 / 点击（支持双击，内部连发避系统阈值） |
| mouse_scroll / mouse_drag | 滚轮滚动 / 按住左键拖拽（分步插值，真拖拽不是点击） |
| key_press / type_text | 按键组合 / 整段文字输入（中文友好，内部经剪贴板粘贴） |

**view_image 用法**（AI 视角）：先 `screenshot` 存图 → 再 `view_image` 带 `prompt` 参数（看图后要做什么）→ 图片自动作为附件发出，AI 用视觉能力直接查看截图内容。

## 安全设计

- 本地服务**只监听 127.0.0.1**，外网无法访问
- 服务响应不带 CORS 头 + **强制 `Content-Type: application/json`**：浏览器"简单请求"（text/plain 等，不触发预检）会被 403 拒绝，堵住恶意网页绕过 CORS 直达本地服务的通道
- 高危命令黑名单：`format`、`diskpart`、`rm -rf /`、`rd /s /q 盘根`、`shutdown` 等会被拒绝
- 命令超时上限 300 秒，输出截断，防失控
- 防死循环：默认最多连续 20 轮工具调用（弹窗可调）；连续 3 轮完全相同的调用自动停止
- **扩展弹窗里的总开关随时可关**，关掉后扩展只旁观不执行

⚠️ 仍需注意：AI 能在你电脑上执行任意命令（黑名单之外）。重要数据请自行备份；不确定的任务先在弹窗里关掉"自动发送"，看清楚每一步结果再手动放行。

## 常见问题

**Q: AI 没有输出 [TOOL_CALL] 格式？**
AI 没吃透模板。回复："请严格按 [TOOL_CALL]...[/TOOL_CALL] 格式重新输出你的工具调用"。protocol.js 已容错剥掉 ```json 围栏，但 `[TOOL_CALL]` 标记本身必须有。

**Q: 扩展没反应？**
1. 控制台（点扩展图标）看本地服务是否绿灯
2. `F12` 控制台搜 `[WebHarness]` 看日志
3. 确认网站在扩展 manifest 的 matches 列表里
4. AI 生成中（有停止按钮）时扩展故意不动作，等生成完

**Q: 执行了但没自动发回？**
该站输入框 DOM 改版。控制台日志里会有"自动发送失败，请手动发送"，结果已进剪贴板，粘贴发送即可。然后照下节修复适配器。

**Q: 换了新网站 / DOM 改版怎么适配？**
编辑 `extension/adapters.js`：
- 给已有适配器的选择器候选列表里加新选择器（在 edge://extensions 里点扩展的"重新加载"，再刷新网页）
- 新网站：在 `ADAPTERS` 数组里加一项，参照现有写法提供 `lastAssistant / input / fill / send` 四个函数；同时把域名加进 `manifest.json` 的 matches
- 按 F12 用元素检查器找：AI 消息容器的稳定 class、输入框、发送按钮

**Q: 通用模式抓错消息？**
未适配的网站走启发式（`通用(启发式)` 适配器），可能把你的消息当 AI 消息。控制台日志会显示站点适配名——出现"通用"且行为异常时，请为该站写专用适配器。

**Q: 能执行 Python 脚本吗？**
可以，`run_command` 本来就是跑 cmd 的：`{"tool":"run_command","params":{"command":"python D:\\work\\script.py"}}`。

## 局限

- 网页 AI 免费版一般有消息条数/频率限制，长任务可能撞限额
- DOM 适配依赖各网站前端结构，改版需更新 adapters.js（这正是选浏览器扩展而非固定爬虫的原因：改一个选择器就能修）
- 鼠标/键盘为物理操作，执行期间会接管光标与焦点，别和它抢键鼠
