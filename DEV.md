# Workbench 开发手册（DEV.md）

> 本文件是 **F:\AllWorkSpace\workbench**（本地工作台）项目的**唯一权威开发手册**，面向所有需要修改本项目的 AI 助手与开发者。
> 用户会不定期（可能在任何新的 DSH 对话中）要求为本项目添加新功能。**任何修改前先通读本文件**，修改后按第 7 节验证清单检查。
> 在 DSH 环境中，先加载技能 `workbench-dev`，再按本文件操作。

---

## 0. 血泪教训（每次改动前必读）

以下每条都是本项目真实踩过的坑，**违反任何一条都会让用户觉得"按钮坏了"**：

1. **bat 文件必须纯 ASCII（注释写英文）**。`cmd.exe` 按系统 OEM 代码页（GBK）解析 .bat，UTF-8 中文注释会被误读、吞掉换行符，导致命令错乱甚至让 `cmd` 挂起 40 秒以上。写完 bat 必须检查：文件中不能有任何非 ASCII 字节。参考 `launch-anki.bat`。
2. **改 `buttons.json` 刷新页面即生效，无需重启**（server.js 对配置做了 1 秒 TTL 自动重载）。只有**改 `server.js` 本身**才需要重启服务。别再以为"改配置必须重启"——那是旧行为。
3. **静态文件响应必须带 `Cache-Control: no-cache`**（server.js 已实现，勿移除）。否则浏览器缓存旧 JS，用户刷新也拿不到新代码，表现为"点了没反应"。
4. **桌面应用按钮必须处理"已运行"场景**。Anki 是单实例：已在运行时 `start "" xxx.lnk` 不会弹新窗口，用户以为按钮坏了。正确做法（见 `launch-anki.bat`）：先 `tasklist` 检测进程 → 已运行则 `AppActivate` 激活窗口到前台，未运行才启动。
5. **按钮点击必须有可见反馈**。普通按钮成功时前端不做任何提示 = 用户以为没反应。全局 toast（app.js `showToast` + style.css `#toast`）已实现，**新增任何按钮类型都必须保持 toast 反馈**。
6. **服务端有全量请求日志**。`server.js` 对每个请求打印 `[时间] METHOD /path` 到 `workbench.log`。排查"点了没反应"**先查日志**：有 POST 记录 = 请求到达了；没有 = 浏览器端问题（缓存/页面未刷新）。
7. **改完必须按第 7 节清单端到端验证**，不能只改不测。
8. **点击接线必须单一真源 `rec.current`**（app.js）。`ensureFuncCard` 的点击监听器与 `renderFuncCard` 的渲染赋值**必须共用一个对象属性**。曾因监听器读 `refs.current`、渲染写 `rec.current`（双属性不一致，`refs.current` 永不赋值）导致点击**静默失效**：零请求、零报错、无 toast，用户表现为"怎么点执行都没反应"。**改 app.js 卡片逻辑前先 grep `current` 确认读写一致**；改完跑 `node test-click.mjs`（回归测试，见第 2、7 节）。

---

## 1. 项目概览

- **是什么**：本地单机网页工作台——把常用操作做成按钮，点一下即执行（启动/停止服务、运行脚本、打开应用等），并附带信息卡（余额、队列、状态、书签）与主题/布局定制。
- **访问地址**：`http://127.0.0.1:3180`（仅本机，硬编码监听 127.0.0.1）。
- **技术栈**：Node.js 内置模块（http/https/fs/child_process/net），零第三方依赖；前端为原生 HTML/CSS/JS，无构建步骤。
- **Node 路径**：`C:\Users\11544\AppData\Local\hermes\node\node.exe`（启动脚本中指定）。

## 2. 目录结构

```
workbench/
├── server.js            # 服务端（端口 3180）：静态文件 + 全部 API + 执行命令 + 端口检测
├── buttons.json         # 按钮配置 —— 新增/修改普通按钮唯一需要编辑的文件
├── push-state.json      # 上次 push 时间（持久化；push 按钮 10 分钟锁定依据）
├── dida-state.json      # dida 卡片每日执行记录（持久化；"点过一次当天隐藏"依据）
├── bookmarks.json       # 书签数据（前端可增删，服务端持久化）
├── public/
│   ├── index.html       # 页面骨架 + 「样式」设置面板（外观/布局/偏好）
│   ├── style.css        # 全部样式：基础 + 9 套主题 body[data-theme="..."] + 3 套布局 body[data-layout="..."]
│   └── app.js           # 前端逻辑：卡片 keyed 渲染、轮询、拖拽排序、执行按钮、书签、设置
├── start-workbench.bat  # 一键重启：杀 3180 旧进程 → 隐藏启动 server.js → 等端口 → 打开浏览器
├── test-click.mjs       # 点击接线回归测试：无副作用（页面内 stub fetch），node test-click.mjs 运行
├── favicons/            # 书签小图标缓存（服务端自动生成，<domain>.ico）
└── workbench.log        # 服务运行日志（重定向自 server.js 的 stdout/stderr）
```

## 3. 运行与重启（重要）

- 正常启动：双击 `start-workbench.bat`（会清理 3180 旧进程、后台隐藏启动、打开浏览器）。
- **改动生效规则**：
  - `buttons.json`：**自动重载**（1 秒 TTL），改完**刷新页面**即生效，无需重启。
  - `public/` 静态文件（app.js/style.css/index.html）：每次请求重新读取，改完**刷新页面（Ctrl+F5）**即生效，无需重启。
  - `server.js`：**必须重启服务**才生效。
- 手动重启（不开浏览器，供脚本/Agent 使用）：
  1. 杀端口 3180 的监听进程：`Stop-Process -Id (Get-NetTCPConnection -LocalPort 3180 -State Listen).OwningProcess -Force`
  2. 用 VBS 隐藏启动（与 bat 一致，避免残留窗口）。**必须先设 `CurrentDirectory`**——`WshShell.Run` 启动的进程继承调用方工作目录，不设的话相对路径 `server.js` 找不到、服务起不来（真实踩过）：
     ```
     Set WshShell = CreateObject("WScript.Shell")
     WshShell.CurrentDirectory = "F:\AllWorkSpace\workbench"
     WshShell.Run "cmd /c ""C:\Users\11544\AppData\Local\hermes\node\node.exe"" server.js > workbench.log 2>&1", 0, False
     ```
  3. 轮询 `Get-NetTCPConnection -LocalPort 3180 -State Listen` 直到成功（约 1 秒内）。
- 重启**不影响** DSH 服务（端口 3080），二者独立。

## 4. 关键机制与易错点

### 4.1 命令执行（runCommand，server.js）
```js
const full = [command, ...args].join(' ');
spawn(full, { cwd, windowsHide: true, stdio: 'ignore', shell: true });
```
- **必须用「字符串拼接 + shell:true」**，不能用 `spawn(cmd, args)` 数组形式——数组形式会把含引号的参数二次转义，`cmd.exe` 无法解析，bat 不执行（退出码 1，按钮无反应）。server.js 内有详细注释。
- 含空格的路径必须自带引号，`buttons.json` 中写作 `\"C:\\path\\to\\x.bat\"`（JSON 转义：`\` → `\\`，`"` → `\"`）。
- **执行 .bat**：`cmd.exe /c call "C:\...\x.bat"`（`call` 保证在隐藏窗口下正常执行并返回）。
- **bat 文件必须纯 ASCII**（注释用英文）！`cmd.exe` 按系统 OEM 代码页（GBK）解析批处理文件，UTF-8 中文注释会被错误解码、吞掉换行符导致命令解析错乱，甚至让 `cmd` 挂起数分钟。这是真实踩过的坑（`launch-anki.bat` 曾因此挂起 44 秒）。
- **启动 .lnk 快捷方式**：`cmd.exe /c start "" "C:\...\x.lnk"`——`start` 会把**第一个带引号的参数当作窗口标题**，必须用空串 `""` 占位，不可省略。
- 窗口自动隐藏（windowsHide + stdio ignore），命令即时返回，按钮日志记录退出码。

### 4.2 端口 / 进程状态
- 按钮带 `port` 字段时，前端每 3 秒轮询 `/api/buttons`，服务端用 `net.connect(port, '127.0.0.1')` 检测，决定徽章「运行中/已停止」。
- 桌面应用按钮（无端口）可带 `process` 字段（如 `"process": "anki.exe"`），服务端用 `tasklist /FI "IMAGENAME eq xxx"` 检测进程，同样驱动徽章「运行中/已停止」。
- toggle 按钮根据端口状态自动决定执行 `start` 还是 `stop`（基于 `port`，进程型按钮不支持 toggle）。

### 4.3 按钮类型（buttons.json 顶层字段区分）
| 类型 | 判定 | 点击行为 | API |
|---|---|---|---|
| 普通按钮 | 有 `command`/`args` | 执行命令 | `POST /api/run/<id>` |
| toggle 按钮 | 有 `toggle` 对象 + `port` | 按端口状态执行 start/stop | `POST /api/toggle/<id>` |
| push 按钮 | `kind: "push"` | 走 dsh 流程（见 4.4） | `POST /api/push` |
| dida 按钮 | `kind: "dida"` + `prompt` | 新建 DSH 对话发送 prompt；每天点过一次隐藏（见 4.4.1） | `POST /api/dida/<id>` |

### 4.4 Push 卡片流程（依赖 DSH 服务 3080，勿破坏）
1. `POST http://127.0.0.1:3080/api/session.create`，payload `{cwd: "F:\\Anki - DeepSeek -Harness"}`，创建新对话。
2. `POST http://127.0.0.1:3080/api/session.prompt`，payload `{sessionId, mode:"queue", content:[{type:"text", text:"push"}]}`。
3. 协议体：`{type:"client-request", rpcId:"workbench-<ts>-<rand>", method, payload}`。
4. 成功后在 `push-state.json` 记录时间；**10 分钟内重复点击被锁定**（业务性拒绝，HTTP 200 + `locked:true`）。
5. 前端成功后自动打开 `http://127.0.0.1:3080`。

### 4.4.1 dida 卡片流程（整理 Inbox / 安排今日任务 / 周报，依赖 DSH 服务 3080）
与 Push 同构，但面向滴答清单场景，且**按周期一次**：
1. 按钮配置：`kind: "dida"` + `prompt`（要发送的文字）+ 可选 `showAfter`（`"HH:MM"`，到点才出现）。**每周模式**：再加 `"weekly": true` + 可选 `"weekday"`（0=周日..6=周六，默认 0，即周日）+ `showAfter`（如 `"22:30"`）——仅在指定星期到点后出现（周报按钮 `dida-weekly`：每周日 22:30 后）。
2. 点击 → `POST /api/dida/<id>` → `session.create`（cwd 默认 `F:\AllWorkSpace`，按钮可配 `cwd` 覆盖）→ `session.prompt`（`mode:"queue"`，text = `prompt`）→ 前端打开 3080。
3. **可见性（服务端计算，`/api/buttons` 返回 `visible` 字段）**：`dida-state.json` 记录每个按钮**最近成功执行的周期标识**——每日按钮为本地日期（`YYYY-MM-DD`），weekly 按钮为**本周锚点日期**（`weekAnchorStr`，默认本周日日期）；今天/本周已执行过 → `visible:false`；配了 `showAfter` 且当前时刻未到 → `visible:false`；weekly 按钮非指定星期 → `visible:false`。前端 `renderGrid` 对 `visible:false` 的 dida 卡**不渲染并从 DOM 移除**（保留 cardCache 与顺序位，恢复可见时原地回来）——实现"到点出现、点过一次周期内隐藏、下周期自动恢复"。
4. **只有成功发送才算"执行过"**：`session.create` + `session.prompt` 全部成功后才写 `dida-state.json`；失败（如 DSH 未运行）不记录，可重试。点击时服务端会再次校验可见性（拒绝绕过）。
5. 前端 dida 卡徽章：每日按钮显示「今日待办」，weekly 按钮显示「本周待办」；按钮文案为「执行」。

### 4.5 前端卡片系统（app.js）
- 功能卡来自 `/api/buttons`（即 buttons.json）；内置信息卡在 `SYS_CARDS`（`sys-balance` 余额 / `sys-status` 状态 / `sys-bookmarks` 书签 / `sys-dida-today` 今日任务 / `sys-dida-focus` 专注；**Anki 队列数量已并入 push 卡**显示，不再有独立队列卡）。
- keyed 渲染：`cardCache` 按 id 复用 DOM；卡片顺序、主题、布局、偏好开关都存在**浏览器 localStorage**（键：`workbench-card-order` / `workbench-theme` / `workbench-layout` / `workbench-sidebar` / `workbench-bignum` / `workbench-countup` / `workbench-icons` / `workbench-fold-*`），换浏览器或清缓存会重置。
- 卡片尺寸：`large` 半行 4 列 / `wide`、`small` 四分之一行 2 列（2026-08-14 起收紧：wide/默认档原为半行 4 列、large 原为整行 8 列，去掉卡片描述后内容精简不再需要宽卡，见第 8 节）；小屏自动降列。
- **点击接线（铁律，勿破坏）**：`ensureFuncCard` 内 `rec` 先于监听器声明，**唯一执行入口是 run-btn 按钮监听器**（读 `rec.current`；卡片主体/标题点击不执行——用户要求"只有按到按钮才启动"，整卡可点已移除）；`renderFuncCard` 只写 `rec.current`——**单一真源，禁止再引入 `refs.current` 之类的第二属性**。曾因读写属性不一致导致点击静默失效（零请求零报错）。改完此逻辑必须跑 `node test-click.mjs`。
- **拖拽实现（以代码为准）**：指针事件自实现（`mousedown/mousemove/mouseup` + 幽灵跟随 + 落点高亮），**仅 ⠿ 手柄（`.drag-hint`）可拖**；卡片其余区域不进入拖拽判定。**执行入口只有 run-btn 按钮**（卡片主体/标题点击不执行；曾实现"整卡可点"，用户反馈范围太宽已移除，2026-08-14）。历史教训：曾因"整卡可拖 + 6px 位移阈值"把正常点击误判为拖拽、`suppressClick` 吞掉 click，导致按钮"点了没反应"，已收敛回手柄区。若再改拖拽，同步更新本节。
- 点击与拖拽（历史结论）：HTML5 `draggable=true` 会吞掉 click；指针事件方案须防"拖拽误吞点击"——拖拽后的 click 用 `suppressClick` 吞掉，且必须加 `setTimeout(0)` 兜底防标志残留误吞下一次点击。**禁止用 HTML5 draggable 做卡片/书签排序**。
- 卡片图标：`CARD_ICONS` 对象（id → 单字符），新增按钮时建议同步加一行，保持视觉一致（受「卡片图标」开关控制）。

### 4.6 主题 / 布局
- 9 套外观 `data-theme`：`emerald`（默认）、`night`、`glass`、`terminal`、`brutal`、`editorial`、`vintage`、`pixel`、`corporate`。
- 3 套布局 `data-layout`：`grid`（默认）、`list`、`split`。
- 新增主题/布局需要**三处同步登记**：① `style.css` 追加 `body[data-theme="xxx"]` / `body[data-layout="xxx"]` 规则；② `index.html` 设置面板加选项按钮；③ `app.js` 无硬编码列表（读取 `data-theme-opt`），但需确认 `applyStyle` 逻辑兼容。

### 4.7 服务端其他
- 余额查询：读 `F:\.dsh\.credentials.yaml` 中的 `DEEPSEEK_API_KEY`，GET `https://api.deepseek.com/user/balance`，60 秒缓存。
- Anki 队列：读 `E:\HERMES SKILLS\anki_to_hermes.json`（数组，`processed` 字段区分待推送）。
- 运行日志：内存数组，最多 100 条，服务重启清空。
- **前端版本自检（app.js refreshButtons + server.js `appVersion`）**：`/api/buttons` 返回 `version`（app.js/style.css/index.html 的 MD5）。页面加载时记下首次拿到的版本，之后轮询发现版本变化 → toast「检测到页面更新，正在自动刷新...」→ 自动 `location.reload()`。**作用：消灭"改了代码但用户停留在旧标签页、点了没反应"这类问题**——旧页面在下一个轮询周期（≤4 秒）内自愈。注意：开发中频繁改前端文件会触发页面自动刷新，属预期行为。
- **打开外部链接用 `openExternal(url)`（app.js）**：优先 `window.open(url, '_blank')` 新标签页；被浏览器弹窗拦截（返回 null）则回退 `window.location.href = url` 当前页跳转。**保证"点击必跳转"**（余额卡、push 完成后跳 DSH 都走它）。禁止直接 `window.open`——会被弹窗拦截导致"点了没反应"。

## 5. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/buttons` | 按钮列表（含端口状态 / toggle 当前动作 / push 锁定信息） |
| POST | `/api/run/<id>` | 执行普通按钮 |
| POST | `/api/toggle/<id>` | 执行 toggle 按钮（按端口自动选 start/stop） |
| POST | `/api/push` | push 卡片流程 |
| GET | `/api/queue` | Anki 队列统计 `{total, pending, exists, error}` |
| GET | `/api/balance` | DeepSeek 余额（60s 缓存） |
| GET | `/api/bookmarks` | 书签列表 |
| POST | `/api/bookmarks` | 新增书签 `{name, url}` |
| POST | `/api/bookmarks/reorder` | 书签排序 `{ids:[...]}`（侧栏拖拽后提交完整顺序，持久化到 bookmarks.json） |
| DELETE | `/api/bookmarks/<id>` | 删除书签 |
| GET | `/api/favicon?domain=..&url=..` | 书签小图标（本地缓存 → 站点 `/favicon.ico` → Bing 兜底；产物存 `favicons/`） |
| GET | `/api/logs` | 运行记录 |
| GET | 其他 | `public/` 静态文件 |

## 6. 添加功能的流程

### 6.1 新增普通按钮（最常用，纯配置）
1. 编辑 `buttons.json`，在 `buttons` 数组末尾追加一项：
   ```json
   {
     "id": "my-tool",
     "name": "我的工具",
     "description": "按钮说明",
     "size": "small",
     "color": "#10b981",
     "command": "cmd.exe",
     "args": ["/c", "call \"C:\\path\\to\\script.bat\""]
   }
   ```
   - 启动快捷方式示例（.lnk，注意空标题占位）：
     ```json
     "command": "cmd.exe",
     "args": ["/c", "start", "\"\"", "\"C:\\Users\\11544\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Anki.lnk\""]
     ```
   - 字段：`id` 唯一（URL 用）；`name`/`description` 界面显示；`size` large/wide/small（默认 wide）；`color` 十六进制；`command`/`args` 要执行的命令；`port` 可选（端口状态徽章）；`process` 可选（进程状态徽章，桌面应用用，如 `"process": "anki.exe"`）。
2. （可选，保持一致）`public/app.js` 的 `CARD_ICONS` 加一行：`my-tool: '图'`。
3. （可选）`README.md` 的「当前按钮」表加一行；重要功能在 `DEV.md` 第 8 节追加变更记录。
4. **刷新页面（Ctrl+F5）即可生效**（buttons.json 自动重载；只有改了 server.js 才需重启）。
5. **验证**（第 7 节）。

### 6.2 新增 toggle 按钮（启动/停止同一服务）
`buttons.json` 加：
```json
{
  "id": "my-service",
  "name": "我的服务",
  "port": 3000,
  "toggle": {
    "start": { "label": "启动服务", "color": "#047857", "command": "cmd.exe", "args": ["/c", "call \"C:\\path\\to\\start.bat\""] },
    "stop":  { "label": "停止服务", "color": "#dc2626", "command": "cmd.exe", "args": ["/c", "call \"C:\\path\\to\\stop.bat\""] }
  }
}
```

### 6.3 新增信息卡 / 新按钮类型（需改代码）
涉及：`server.js`（新 API 路由 + `serializeButton` 分支 + 业务逻辑）、`app.js`（`SYS_CARDS` 定义 + `renderSystemCard` 渲染 + 必要时 `runButton` 分支）、`index.html`（如需要新面板）。改动前先通读对应函数。

### 6.4 新增主题 / 布局
见 4.6：`style.css` + `index.html` 两处（app.js 自动读取 `data-theme-opt`）。

### 6.5 自动添加快捷方式（无需改配置、不消耗 AI token）
设置面板「快捷方式」区：填 .exe/.lnk 路径（可自定义名称/颜色/尺寸）→ 自动完成：写 buttons.json（`auto:true` 标记）→ 提取软件图标到 `public/icons/<id>.ico` → 配通用启动 `launch-app.ps1`（未运行则启动、已运行则激活前台）。列表项「删除」可移除（仅 auto 按钮可删，防误删手写配置）。服务端端点：`POST /api/buttons/add` / `POST /api/buttons/remove`。对应前端逻辑：`initShortcutPanel` / `renderShortcutList`（app.js）、`.sp-section[data-collapsible="shortcut"]`（index.html）。

## 7. 验证清单（每次改动后执行）

1. `GET /api/buttons`：新按钮出现在列表，字段正确。
2. `POST /api/run/<id>`（或 toggle/push 对应端点）：返回 `{ok:true, entry:{status:"done", code:0}}`。
3. `GET /api/logs`：运行记录显示「完成」。
4. **`node test-click.mjs`：全部 PASS**（点击接线回归测试，无副作用——页面内 stub fetch，不会真的执行按钮命令；能抓住"点击静默失效"这类前端接线 bug）。
5. 按需检查实际效果（如目标进程是否启动：`Get-Process -Name <name>`）。
6. 浏览器刷新 `http://127.0.0.1:3180`：卡片渲染正常、图标/颜色正确、可拖拽、徽章正确。
7. 注意：push 按钮测试会触发 10 分钟锁定，谨慎重复。

## 8. 变更记录（追加制）

| 日期 | 改动 |
|---|---|
| 2026-08-16 | **新增周报 dida 按钮（`dida-weekly`）+ dida 卡片 weekly 每周模式**：①buttons.json 新增「周报」（wide，teal）：`kind:"dida"` + `prompt:"该周报了"`（触发 dida-ai 场景六 GTD 周回顾）+ `weekly:true` + `weekday:0`（周日）+ `showAfter:"22:30"`——**每周日 22:30 后出现，点过一次本周隐藏，下周日自动恢复**（与每日按钮"每天一次"同构，周期改为每周）；②server.js：`didaVisible` 增加 weekly 分支（非指定星期隐藏 / `weekAnchorStr` 本周锚点=本周日日期作"本周已点过"判定 / showAfter 拦截），`runDida` 成功后 weekly 按钮记录本周锚点日期（每日按钮仍记当天日期），抽公共 `fmtDate(d)`；③app.js：`CARD_ICONS` 加 `dida-weekly:'周'`，dida 卡徽章 weekly 按钮显示「本周待办」（每日仍「今日待办」）。验证：模拟测试 16 项全 PASS（周一/周六隐藏、周日 22:29 隐藏 22:30 可见 23:59 可见、点过后隐藏、下周日恢复、锚点同周稳定跨周变化、每日模式回归）；真实 API 拒绝路径（未到点返回 500 + "未到显示时间（周日 22:30 后出现）"且不写 dida-state）；`test-click.mjs` 11 项全 PASS（三个 dida 卡当前不可见被脚本按设计跳过） |
| 2026-08-15 | **快捷方式"已运行即置顶"统一增强 + 图标加大 + 运行记录长文本截断 + 滴答专注卡可点击跳转**：①`launch-app.ps1` 激活分支升级——已运行应用不再只 `AppActivate`（最小化窗口不恢复、前台锁可能静默失败），改为优先取有主窗口的进程 → `Add-Type` P/Invoke `ShowWindowAsync(SW_RESTORE)` 恢复最小化 + `SetForegroundWindow` 置顶，再 `SendKeys('%')`（Alt 键解除前台锁）后 `AppActivate($p.Id)` 兜底（无主窗口的托盘应用仍可激活）；`launch-anki.bat` 激活分支改为委托 `launch-app.ps1` 传 Anki.lnk（与全部快捷方式统一行为）；②快捷方式卡应用图标 20px→**28px**（`.card.shortcut-card .card-icon img`，字符回退 16→24px）——只放大图标不改变卡片尺寸；③运行记录样式：`.name`/`.status` 加 `flex:1/min-width:0/ellipsis` 截断、`.status` 限宽 55%、`.time` 防收缩——修掉"出错: 无法连接 dsh web (3080): connect ECONNREFUSED…"这类长错误把整行撑爆的丑样式（仅样式，不解决 dida 报错本身），app.js 给 name/status 加 `title` 悬浮显示完整文本；④`sys-dida-focus`（滴答专注）卡点击跳转：优先复用「滴答清单」快捷方式按钮（`runButton`，未运行启动/已运行置顶 + toast），按钮不存在时回退 `openExternal('https://www.dida365.com/webapp/')`。`launch-app.ps1`/`launch-anki.bat` 保持纯 ASCII（实测 0 非 ASCII 字节）；`test-click.mjs` 全 PASS |
| 2026-08-15 | **快捷方式图标改为完整彩色大图标（修复"缺颜色/变灰"）**：旧方案 `Icon.ExtractAssociatedIcon` 只取 32×32（很多应用该尺寸是简化/单色版）。重写 `extract-app-icon.ps1`：**直接读 exe 的 PE 图标资源**（`LoadLibraryEx(AS_DATAFILE)` + `EnumResourceNames`/`FindResource` 枚举 RT_GROUP_ICON → 各 RT_ICON），把全部尺寸（含 256×256 彩色 PNG/BMP）按尺寸降序写成多尺寸 ICO（Chrome 自动选 256 渲染）；**目标被占用（应用正在运行）时复制临时副本再提取**（实测 Anki 运行中直接读失败、副本成功）；仍失败才兜底 `ExtractAssociatedIcon`。注意点：GRPICONDIRENTRY 是 **14 字节**（wID 在 +12，非 16 字节布局）；`SHGetImageList`/`PrivateExtractIcons` 在本机不可用（E_NOINTERFACE/无导出）。已重提取 5 个图标：anki 103KB/256、reasonix 42KB/256、zotero 44KB/256、obsidian 52KB/256、sm18 32KB/64（SuperMemo 18 老软件资源最大 64，无法再大）。无头实测 5 卡图标 naturalWidth 256/64 全部加载；`test-click.mjs` 11 项全 PASS。**注意：icons 不在版本自检范围，需手动 Ctrl+F5 刷新才看到新图标** |
| 2026-08-15 | **DeepSeek 余额卡只显示金额**：移除 `stat-sub` 元素与「充值 ¥X / 赠送 ¥X」行（`renderSystemCard` sys-balance 分支只保留 `stat-value` 大字；错误态 value 显示"获取失败"并 title 带原因；点击跳用量页保留）。无头实测卡片仅「¥5.78」无 sub；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | **高峰徽章（rate-badge）增加"高峰前 10 分钟"提醒**：`updateRateBadge` 新增 `nextPeakStart`（今天 9:00/14:00，都过则明天 9:00）；空闲时段距下个高峰 ≤10 分钟（`ceil` 分钟）时显示「即将高峰 · X 分钟后」+ `.rate-badge.soon`（琥珀色虚线边框，区别于高峰的实线脉冲），tooltip 注明高峰开始时刻；高峰/空闲分支行为不变（含 title）。模拟 8 个时间点验证：08:49:30→idle、08:50:00→soon:10（边界）、09:00→peak、11:59:30→peak、12:00→idle、13:55→soon:5、14:00→peak、18:00→idle，全部符合预期；真实渲染高峰分支正常；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | **滴答专注卡总时长精确到秒**：`renderDidaFocus` 由分钟四舍五入（69.6→70→"1h 10m"，高估 24s）改为 `Math.round(totalMs/1000)` 秒级分解 `h/m/s`（4176s → "1h 9m 36s"，零值段省略、全零显示 "0s"）。无头实测卡片 "1h 9m 36s" 无溢出；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | **滴答专注卡去掉番茄/计时分解行**（用户不需要，且总时长存疑）：`sys-dida-focus` 卡仅保留总时长大字——移除 `stat-sub` 元素与 `renderDidaFocus` 的 subEl 逻辑（`pomodoroMs/timingMs` 服务端仍统计但不展示）。**总时长核实结论**（直连 MCP 拉原始记录）：今天 3 条番茄记录 26:00+26:00+17:36=69.6 分钟（显示 1h 10m），`duration` 字段与 startTime/endTime 完全吻合（无单位 bug）；跨 3 天核对完整番茄均为 1560s（**番茄钟设置应为 26 分钟**），每日末条偏短为提前停止；计时 0 条。聚合忠实于 TickTick 数据；若与用户预期不符，差异源于番茄钟长度设置或提前停止的 09:41-09:59 那条（17:36）。`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | **`split-center` 快捷方式卡移到中栏今日任务下方**：renderGrid 分配新增——`layout==='split-center'` 时带 `command` 的普通按钮（快捷方式启动卡）target 改为 **dida-col 内动态创建的 `.dida-shortcuts` 容器**（`dida-col.querySelector` 复用）；今日任务卡 CSS `order:-1` 固定中栏**顶部**，`.dida-shortcuts` 为 4 列网格（order 0）放快捷方式卡；中栏网格内覆盖 `span-wide/span-small` 统一 `span 1`（132×132 方形，防 zotero 宽卡占整行）并强制 `aspect-ratio:1`；左栏 `.buttons-grid` 保留 2 列 + `:not(.shortcut-card)` 整行规则（现只剩 dsh/push/dida）。无头 Edge 1400px 实测：中栏今日任务 top=94、快捷方式区 top=491（下方）、4 卡 132×132 方形、左栏仅 dsh/push；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | **修复 `split-center` 左栏 push 卡过窄难看**：左栏 `.buttons-grid` 由 4 列改 **2 列**——`card.shortcut-card` 半行（span 1，125×125 方形），`card:not(.shortcut-card)` 整行（span 2，265px）；push/dsh 卡由 125px 变 265px 整行，队列行由 4 行换行恢复为基本一行、无横向溢出，卡高 178px 正常。无头 Edge 1400px 实测：push 265px/队列行≤2 行/dsh 265px/shortcut 125 方形；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | **`split-center` 今日任务中栏加宽至约占一半**：`main` 网格由 `minmax(0,1fr) 300px 280px` 改为 `minmax(0,1fr) 50% minmax(0,1fr)`——中栏今日任务 562px（实测占 main 47.6%，约一半）、左右各 265px；左栏较窄（约 1/4）时**方形快捷卡强制 `span 2`**（`body[data-layout="split-center"] .buttons-grid .card.shortcut-card`，125×125 方形，避免 1/4 行过窄；此布局下 shortcut 宽窄切换退化为恒 span 2，grid 布局不受影响）。无头 Edge 1400px 实测：中栏 562px/两列任务、左栏 shortcut 卡 125×125 无标题溢出、push 队列行 4 行换行无横向溢出；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | 新增第 4 套布局 **`split-center`「任务居中仪表盘」**（今日任务放中间的三栏）：`main` 网格 `minmax(0,1fr) 300px 280px`——**左栏 `.buttons-grid`**（4 列功能卡，弹性最宽 512px）、**中栏 `.dida-col`**（今日任务卡 300px 固定，`grid-column:2`）、右栏 `.side-col` 信息面板 280px + `.logs-panel`（同 split 的 row1/row2 放置）；`renderGrid` 的三栏分配条件由 `layout==='split'` 扩展为 `'split' || 'split-center'`（JS 分配逻辑不变，仅 CSS 换列序）；`justify-content:space-between` 功能卡规则与 ≤900px 响应式（叠单栏）同步登记；设置面板「布局」区新增第 4 个选项（图标 ◎）。无头 Edge 1400px 实测：三栏位置 buttons(248,512)/dida(776,300)/side(1092,280)、今日任务卡位于中栏、布局选项 4 个；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | **快捷方式启动卡改为正方形紧凑卡**：带 `command` 的普通按钮（Anki/SM18/Reasonix/zotero 等，判断 `b.command && !b.toggle && !b.kind`）加 `shortcut-card` 类——grid/split 下小卡 `grid-column: span 1`（234px→109px）+ `aspect-ratio:1` 严格正方形（实测 109×109）；内容改**垂直居中**（app 图标式：图标 20px 上 / 名称居中可省略 / 状态徽章小字 / 全宽按钮，`flex-direction:column`）；宽窄切换仍有效——`span-wide.shortcut-card` 还原半行 484px 且 `aspect-ratio:auto`（宽横幅 484×106，不强制方形）；list 布局恢复横排；≤900px 媒体查询追加 `.span-wide.shortcut-card{span 2}` 防宽卡占整行。dsh/push/dida 卡不受影响（无顶层 command）。无头 Edge 1400px 实测：shortcut 卡 109×109、无内容溢出、图标 32px 加载；宽卡 484×106；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | **今日任务卡「定时」列增加"现在"时刻线（大逃杀式分界）**：`renderColumn` 增加 `opts.nowLine`（app.js）——定时列按当前时刻把任务切成「已过（线以上，本应在现在之前完成）」/「未到（线以下）」两段，中间插一条 **1px 细线** `.dida-now-line`（label「现在 HH:MM」+ 横线，`--err` 色 40% 透明度，各主题自适应）；折叠态两段各按 MAX_SHOW 截断（「还有 N 项」合并计数两段隐藏数），展开态显示全部；新增 60 秒 `setInterval` 重渲今日任务卡 + `applyMasonry`（任务随当前时间在「已过/未到」间滑动，线的位置与文案跟着走）。验证：`test-click.mjs` 全 PASS；无头 Edge CDP 实测定时列 10 项（6 已过 + 4 未到）中间渲染 `现在 HH:MM` 线、全天列无线、无 JS 报错 |
| 2026-08-15 | **DSH、Push 队列两张卡改为小卡**（`buttons.json` `size: "wide"→"small"`，用户觉得宽卡太宽；dida-inbox/plan 保持 wide）。无头 Edge 1400px 实测：dsh/push/anki/sm18 均 span-small 234px 等宽；push 卡队列行「队列: 待推送 2 / 共 2 条」及按钮文字无横向溢出；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | 修复「宽窄没用」+ 尺寸切换合成单按钮：①**宽窄真实生效的两处根因**——a) CSS `.card.span-wide` 由 `span 2` 恢复为 **`span 4`**（半行，2026-08-14 收紧时与 small 同为 span 2 导致无差异；small 仍 span 2、large 仍 span 4）；b) `renderFuncCard` 每次渲染重设 `el.className = 'card ' + spanClass(b.size)`（keyed 缓存复用 DOM 时 span 类此前永不更新，改尺寸后卡片宽度不变）；②**宽窄改为单个切换按钮**——列表项尺寸控件由「小卡/宽卡」双按钮改为单按钮 `⇄ 宽卡`/`⇄ 小卡`（文案显示**目标**尺寸，tooltip 注明「当前 X，点击改为 Y」，点击切换并 POST update）。验证：1400px 视口无头 Edge 实测 zotero 宽卡 484px / 小卡 234px（span-wide/span-small 类正确）、单按钮文案与点击 POST 正确；`test-click.mjs` 10 项全 PASS。注：≤900px 响应式下所有卡仍统一 span 2（设计如此，窄屏不区分宽窄） |
| 2026-08-15 | 快捷方式管理第二轮：①**拖放路径回退 webkitGetAsEntry**——drop 时优先 `file.path`，为空则回退 `dataTransfer.items[i].webkitGetAsEntry().fullPath`（去掉前导 `/`、`C:/x` 转 `C:\x`），解决部分来源（含 .lnk）拿不到 path 报「无法读取路径」；②**已添加列表可改尺寸**——`POST /api/buttons/update` 扩展支持 `size`（small/wide，校验枚举）且**放开 auto 限制**（普通按钮均可改颜色/尺寸，删除仍仅限 auto 防误删手写配置）；列表过滤从 `b.auto` 改为"普通按钮"（`b.command && !b.toggle && !b.kind`），**anki/sm18 等手写按钮也进入列表**可改色/改尺寸（非 auto 不显示删除按钮）；每项第二行 = 8 色块 + 小卡/宽卡切换（`.sc-item-edit`/`.sc-item-sizes`/`.sc-size-opt`，sig 加 `size`）；③**列表标题改为可收起展开**——`sc-list-title` 改为按钮 `.sc-list-toggle`（去掉「（可删除）」字样，每项自带删除按钮无需说明），点击折叠/展开、`localStorage workbench-fold-shortcutlist` 持久化。无头 Edge 实测：列表 4 项（Anki/SM18/Reasonix/zotero）各有 8 色 + 2 尺寸，Anki/SM18 无删除按钮、auto 项有；尺寸点击记录 POST update；折叠/展开 + 持久化正常；拖放回归正常；真实 API 验证 anki 改尺寸/颜色持久化并还原；`test-click.mjs` 10 项全 PASS。注：webkitGetAsEntry 分支无法在无头环境模拟（FileSystemEntry 需真实拖放），由用户实测确认 |
| 2026-08-15 | 快捷方式三增强：①**拖入 .lnk 图标与 exe 一致（无右下角箭头）**——`extract-app-icon.ps1` 对 .lnk 先用 `WScript.Shell` 解析 `TargetPath`，对**目标 exe** 提取图标（实测 Anki.lnk 提取结果与 anki.exe 直接提取 SHA256 一致）；②**已添加列表内嵌颜色选择器**——新增 `POST /api/buttons/update`（仅 `auto` 按钮、校验 `#rrggbb` 格式），`renderShortcutList` 每项第二行渲染 8 色块（当前色高亮，点击即改卡片颜色并刷新，sig 加 `color` 字段防重渲染丢失）；③**页面级文件拖放添加**——把 .exe/.lnk 拖进页面任意处：`dragenter/dragover/drop` 全局监听（仅 `dataTransfer.types` 含 `Files` 时生效，不干扰书签 HTML5 拖拽），显示全屏虚线遮罩（`.drop-overlay`，`pointer-events:none`，拖入即提示「松开鼠标，添加为快捷方式」）；drop 时读 Chromium 的 `file.path`，非 .exe/.lnk 忽略、无 path（浏览器安全限制）提示改用粘贴；添加逻辑抽离为 `addShortcut(name, path, color, size)` 供表单按钮与拖放共用（颜色/尺寸取表单当前选中值）。无头 Edge 实测：拖入遮罩显示→带 path 的 drop 记录 POST /api/buttons/add + toast「已添加」→遮罩隐藏；无 path drop 提示改用粘贴；色块点击记录 POST /api/buttons/update；真实 API 验证 update 持久化改色/还原、.lnk 图标==exe 图标；`test-click.mjs` 10 项全 PASS |
| 2026-08-15 | 「快捷方式」粘贴路径**自动剥掉首尾成对双引号**（如 `"C:\Program Files\Zotero\zotero.exe"`，地址栏/命令行复制的路径常自带）：server.js `add` 路由与 app.js 提交前均对 `"..."` 做 strip（`trim` 后若首尾均为 `"` 则剥一层再 trim），再走存在性/特殊字符校验。验证：带引号 notepad 路径添加成功、落盘描述/参数无多余引号、中文名保留；`test-click.mjs` 全 PASS |
| 2026-08-15 | **Push 卡与队列卡合并为一张「Push 队列」卡**：删除独立信息卡 `sys-queue`（SYS_CARDS/CARD_ICONS/defaultOrder/ensureSystemCard/renderSystemCard 五处移除），队列数量改为渲染在 push 功能卡内（`renderFuncCard` push 分支新增 `refs.queue` 行，复用既有 `.queue-line` 样式 + 新增 `.hot` 琥珀高亮 / `.off` 置灰变体）：有待推送显示「队列: 待推送 X / 共 Y 条」并高亮，文件缺失/读取失败显示原因并置灰；按钮名称改为「Push 队列」（buttons.json，仍 `kind:"push"`）。`refreshQueue` 5 秒轮询保持不变（现在驱动 push 卡上的队列行）。`test-click.mjs` 全 PASS；无头 Edge 实测卡片渲染无 JS 报错 |
| 2026-08-15 | **设置面板「快捷方式」自动添加/删除按钮（不消耗 AI token）**：`POST /api/buttons/add`（校验路径存在、仅 .exe/.lnk、拒绝 `" % & \| < > ^` 特殊字符；id 由文件名 slug 化、冲突自动加序号；写 buttons.json 全量重写为 JSON.stringify 标准格式并保留 title、立即失效 1 秒缓存；.exe 自动配 `process` 徽章）+ `POST /api/buttons/remove`（仅删 `auto:true` 标记按钮防误删手写配置，同时删图标文件）；新按钮统一走 **`launch-app.ps1`（替代 `launch-sm18.ps1`）**：通用智能启动——.exe/.lnk 通吃，.lnk 用 `WScript.Shell` 解析 TargetPath 做进程检测，未运行 `Start-Process` / 已运行 `AppActivate` 激活前台；图标自动提取（`extract-app-icon.ps1`）到 `public/icons/<id>.ico`，`serializeButton` 检测存在即返回 `icon` 字段；前端 `applyCardIcon(iconEl, def)` 改由按钮 `icon` 字段驱动（删除硬编码 `CARD_ICON_SRC`，sm18/anki 走同一机制），`renderFuncCard` 每次渲染图标；设置面板新增「快捷方式」可折叠区（名称/路径输入、8 色块、尺寸、添加按钮、已添加列表带图标与删除，`renderShortcutList` 随 refreshButtons 同步）；CSS 新增 sc-* 系列（全走主题变量）。端到端实测：notepad.exe 添加→图标 32×32→卡片渲染→点击启动→二次点击激活不重复→删除恢复 6 按钮；.lnk 添加（Anki.lnk→anki-2 冲突分支）无进程徽章；`test-click.mjs` 8 项全 PASS。注意：中文名经浏览器 fetch 为 UTF-8 无问题（PowerShell Invoke-RestMethod 需传 UTF-8 字节体，字符串体会被 ASCII 化） |
| 2026-08-15 | 卡片标题旁显示**软件自身图标**（Anki/SM18）：`System.Drawing.Icon.ExtractAssociatedIcon` 提取 exe 图标为 ICO（`extract-app-icon.ps1`，纯 ASCII，exe 路径作参数），静态放入 `public/icons/{anki,sm18}.ico`；server.js MIME 表补 `.ico: 'image/x-icon'`；app.js 新增 `CARD_ICON_SRC` + `applyCardIcon`（有真实图标渲染 `<img>`，无则回退 CARD_ICONS 字符；ensureFuncCard/ensureSystemCard 两处图标赋值统一走该函数）；CSS 补 `.card-icon img`（16px、圆角）。重装/更新软件后图标陈旧时，重跑 extract-app-icon.ps1 刷新即可。验证：GET /icons/*.ico → 200 + image/x-icon；无头 Edge 实测 sm18/anki 卡 `.card-icon img` naturalWidth>0；`test-click.mjs` 全 PASS |
| 2026-08-15 | 新增 SM18 按钮（id=`sm18`，small，蓝 #3b82f6）：打开 `F:\SM学习分享, 有能力请支持正版\sm18.exe`（路径含中文/逗号/空格）。**bat 纯 ASCII 铁律下的新做法**：不用 bat，改用纯 ASCII 的 `launch-sm18.ps1`（exe 路径由按钮参数传入，脚本内无任何非 ASCII 字节）——未运行则 `Start-Process` 启动，已运行则 `WScript.Shell.AppActivate(进程 ID)` 激活前台（对应 Anki 按钮的"已运行"场景）；`process:"sm18.exe"` 进程徽章；`CARD_ICONS` 加 `sm18:'S'`。端到端实测：POST /api/run/sm18 → code 0 → 进程启动；二次点击走激活分支不重复启动；`test-click.mjs` 全 PASS |
| 2026-08-15 | **今日任务卡交互打磨**：①展开态收起按钮**唯一且居中**——展开时两列各自的「还有 N 项」消失，卡片底部新增横跨两列的 `.dida-collapse`「收起 ▲」（`grid-column:1/-1` + `justify-self:center`，胶囊样式 hover 高亮）；②**移除「全天」徽章**——左列本就全是全天任务，每个任务再标「全天」冗余，删除 taskItem 的 allDay 徽章渲染及 `.dida-task-allday` 样式。无头 Edge 实测：展开态 collapseCount=1 且水平居中、两列 alldayBadges=0，展开（8+12）/收起（5+5）正常，无 JS 报错；`test-click.mjs` 8 项全 PASS |
| 2026-08-15 | **今日任务卡「还有 N 项」可展开全部（两列联动）**：`didaTodayExpanded` 单一整体开关（替代原按列 `didaExpand`）——点击任一列「还有 N 项 ▼」两列**同时展开全部**任务，文案变「收起 ▲」，再点任一列两列同时折叠；展开时卡片加 `expanded` 类突破 grid 限高（`max-height:320px` 及列表内部滚动取消，列容器 overflow 放行），瀑布流 `applyMasonry` 自动重算高度（实测 238→434px）；`.dida-more` 改为可点击样式（hover 高亮、open 强调）。无头 Edge 实测：展开 全天 8/定时 12 项全显示、收起恢复 5+5，无 JS 报错；`test-click.mjs` 8 项全 PASS |
| 2026-08-15 | **Bento 网格改瀑布流（消除高卡旁边矮卡下方空白）**：CSS Grid 行高由行内最高卡决定，`align-items:start` 只防拉伸、消不掉行底空隙（高卡同行矮卡下方留白）。改为瀑布流：`body[data-layout="grid"] .buttons-grid` 设 `grid-auto-rows:10px`，app.js 新增 `applyMasonry()`（renderGrid 末尾调用）——同步块内先量 auto 行高下的自然高度，再按 `span = ceil((h+16)/26)` 设每卡 `grid-row-end: span N`（10px 行 + 16px gap，span 行总高 ≥ 卡高，不重叠不拉伸），配合原有 `grid-auto-flow: dense` 自动把后续小卡填入矮卡下方空隙；窗口 resize 防抖 200ms 重算（响应式断点列数变化 → 卡高变化）。实测：同列卡片纵向间隙 16-29px（原为高卡行底大片空白），today 卡(238px)右侧 push 卡(192px)下方被 dense 填充，无 JS 报错；`test-click.mjs` 7 项全 PASS |
| 2026-08-15 | **布局优化（split 中栏过窄 + grid 今日任务卡过高）**：①split 三栏比例调整 `300px minmax(0,1fr) 280px`（左栏 340→300、右栏 300→280，中间更宽，今日任务卡随之左移）；中栏 `.buttons-grid` 由 8 列改 **4 列**（功能卡实测 126px→330px 宽，文字不再脱离框内）；②grid 布局 `.buttons-grid` 加 `align-items: start`（卡片顶部对齐，不再被行内最高卡 stretch 拉长）；今日任务卡 grid 下 `max-height:320px` + 列表内部滚动兜底，且 `renderDidaTodayList` 支持 `maxShow` 参数（grid 传 5、split/list 传 8），卡高实测 322→238px。无头 Edge 1400px 实测：split 中栏 676px/功能卡 330px、grid 今日任务卡 238px/普通卡 108px、无文字溢出；`test-click.mjs` 7 项全 PASS |
| 2026-08-15 | **双栏仪表盘（split）改三栏：今日任务成为左侧新栏位**：`main` 网格由两列（操作区+信息面板）改为三列 `340px minmax(0,1fr) 300px`——左栏 `.dida-col`（新增容器，`index.html`）固定放「滴答今日任务」卡，中栏 `.buttons-grid` 放功能卡，右栏 `.side-col` 放其余信息卡（余额/队列/状态/书签/专注）+ 运行记录。`renderGrid` 的 split 分支按 id 分配目标栏（`sys-dida-today`→dida-col，其他 SYS_CARDS→side-col）；`.dida-col` 默认 `display:none`（grid/list 布局不受影响），≤900px 响应式下三栏叠为单栏。无头 Edge CDP 实测（1400px，localStorage 设 split）：左栏仅今日任务卡（16 项、全天/定时两列）、中栏功能卡、右栏信息面板，无 JS 报错；`test-click.mjs` 7 项全 PASS |
| 2026-08-15 | **今日专注时长拆为独立卡片 + 今日任务可点击完成**：①新增 `sys-dida-focus` 信息卡（图标「⏱」，small，stat 样式）：大数字显示今日总专注时长（h/m 格式）+ 副行「番茄 X 分 · 计时 X 分」分解；`ensureSystemCard`/`renderSystemCard` 新增分支，`renderDidaFocus(value, sub)` 改造为 stat 卡渲染，今日任务卡移除 `.dida-focus-line`；②今日任务列表项**点击即完成**：任务数据新增 `projectId`（来自 MCP `project_id`），服务端新增 `completeDidaTask`（调 MCP `complete_task`，成功后清今日任务缓存）+ `POST /api/dida-complete`，前端 `completeTask`（POST → 本地移除该任务 → toast「已完成: 标题」→ 重渲染，请求中 `.completing` 防重复点击）；③**修复 didaMcpCall 工具级错误漏检**：MCP 工具失败时 `isError:true` 且错误在 `content[].text`（如 "Error executing tool ..."），原实现只查 JSON-RPC `error` 字段导致误判成功——现在检查 `result.isError` 并 reject 错误文本。验证：假 taskId 调用返回 500 + 明确错误、任务列表无副作用；无头 Edge stub fetch 实测点击 → POST body 正确（projectId/taskId）→ 任务从列表移除 → toast 正常；`test-click.mjs` 7 项全 PASS |
| 2026-08-15 | **降低滴答 MCP 调用频率（防封号/限流）**：用户顾虑高频调用被封号。评估：mcp.dida365.com 是滴答官方开放的 MCP 服务（非逆向接口），改前频率每 60 秒 3 次（任务 1 + 专注 2，24h 约 4300 次/天），属正常个人使用级别。仍主动降频：`DIDA_TODAY_CACHE_MS` 30s→5min、`DIDA_FOCUS_CACHE_MS` 60s→10min（服务端缓存兜住穿透，实际 MCP 请求降为任务每 5 分钟 1 次、专注每 10 分钟 2 次，24h 约 600 次/天）；前端 `refreshDidaToday`/`refreshDidaFocus` 轮询 60s→300s。任务数据变化不频繁，5 分钟刷新足够 |
| 2026-08-15 | **「滴答今日任务」卡改为两列布局 + 新增今日专注时长**：①任务按 `allDay` 分为左右两列（全天 \| 定时），`renderDidaTodayList` 重构为 `taskItem`/`renderColumn`（每列独立标题 + 子列表 + 各自「还有 N 项」提示），CSS `.dida-task-list` 改 `grid-template-columns: 1fr 1fr`，新增 `.dida-task-col`/`.dida-task-sublist`/`.dida-more`；②卡片顶部新增 `.dida-focus-line` 显示「今日专注 X 小时 X 分」：服务端新增 `queryDidaFocusToday`（调 MCP `get_focuses_by_time` 拉今日 type=0 番茄 + type=1 计时，汇总 `duration`，60 秒缓存）+ `GET /api/dida-focus`，前端 `refreshDidaFocus` 60 秒轮询 + `renderDidaFocus`。无头 Edge CDP 实测：两列各 8 条 + 超出提示、专注行「今日专注 0 分」（当日无记录）、无 JS 报错；`test-click.mjs` 7 项全 PASS |
| 2026-08-15 | **「滴答今日任务」卡改为分组列表**：按 `allDay` 分为「全天」「定时」两组（组标题带分隔线），每组最多显示 8 条（超出合计提示「还有 N 项未显示」）；`renderDidaTodayList` 重构为 `groupTitle`/`taskItem`/`renderGroup` 三个内部函数。无头 Edge CDP 实测分组正确（全天 8 / 定时 8）、无 JS 报错、`test-click.mjs` 7 项全 PASS。**番茄计时需求评估后不做**：滴答 MCP `create_focus` 实测返回 `endTime must not be in the future`——只能补录过去时段记录，无"开启未来实时计时"接口（滴答番茄钟必须在客户端内启动），工作台右键开始番茄计时不可行 |
| 2026-08-15 | **新增「滴答今日任务」信息卡**（`sys-dida-today`，图标「今」，large 半行）：工作台直接以 MCP 客户端身份调用滴答远程 MCP 服务器（`https://mcp.dida365.com`，Bearer token 从 `F:\.dsh\profiles\web\cordis.patch.yml` 正则提取，不硬编码），拉取今日未完成任务并渲染为小组件样式列表（时间 + 标题 + 优先级色点 + 全天徽章 + 标签悬浮提示）。服务端：`didaMcpCall`（JSON-RPC tools/call，实测无需 session，直接可调）+ `queryDidaToday`（30 秒缓存，按时间排序、无时间/全天置顶）+ `GET /api/dida-today`；前端：`SYS_CARDS`/`CARD_ICONS`/`defaultOrder` 增加该卡，`refreshDidaToday` 60 秒轮询（init 首拉），`ensureSystemCard`/`renderSystemCard`/`renderDidaTodayList` 渲染，最多显示 12 项（超出提示「还有 N 项未显示」）。验证：API 返回 18 条今日任务、无头 Edge CDP 实测卡片渲染内容正确、`test-click.mjs` 7 项全 PASS |
| 2026-08-14 | 新增两张 dida 卡片：`dida-inbox`「整理 Inbox」（`showAfter:"21:00"`，每晚 21:00 后出现）与 `dida-plan`「安排今日任务」（全天可见）。新按钮类型 `kind:"dida"` + `prompt` + 可选 `showAfter`：点击后在 `F:\AllWorkSpace` 新建 DSH 对话并自动发送 prompt，再打开 3080 页面（与 Push 流程同构）。**每天点过一次即隐藏**：服务端 `dida-state.json` 记录每个按钮最近成功执行的本地日期，`/api/buttons` 返回 `visible` 字段，前端 `renderGrid` 隐藏不可见卡（保留顺序位，次日/到点自动恢复）；只有 `session.create`+`session.prompt` 都成功才写记录（失败可重试）；点击时服务端二次校验可见性。新增 `POST /api/dida/<id>` 端点；`test-click.mjs` 的 `expectUrl` 支持 dida 端点并跳过不可见按钮；`CARD_ICONS` 加 `dida-inbox:'⇩'`、`dida-plan:'▦'`。端到端实测：拒绝路径（21:00 前返回"未到显示时间"且不写状态）与成功路径（真实点击 → 写记录 → 卡片隐藏）均通过，`node test-click.mjs` 7 项全 PASS |
| 2026-08-14 | 新增 Anki 按钮（id=`anki`，`cmd /c start "" "…\Anki.lnk"`，small，蓝 #3b82f6）；`CARD_ICONS` 加 `anki:'A'` |
| 2026-08-14 | 修复"按钮点了没反馈"：新增全局 toast 提示（app.js `showToast` + style.css `#toast`），所有按钮点击必有结果提示；普通按钮执行中显示「执行中...」；`server.js` 静态响应加 `Cache-Control: no-cache`（改代码后刷新必拿到新文件） |
| 2026-08-14 | Anki 按钮改用智能启动脚本 `launch-anki.bat`：Anki 未运行则启动（.lnk），已运行则 `AppActivate` 激活窗口到前台（修复"已运行时点了没反应"）；`server.js` 增加全量请求日志（每次请求写入 workbench.log，用于排查"点击未到达服务端"）。**教训**：bat 首次以 UTF-8 中文注释编写导致 cmd 挂起，已改为纯 ASCII 并验证（启动分支 1s 内拉起 Anki，激活分支 1.8s 完成） |
| 2026-08-14 | Anki 按钮徽章改为真实进程状态：`buttons.json` 加 `process: "anki.exe"`，`server.js` 新增 `isProcessRunning`（tasklist 检测），徽章实时显示「运行中/已停止」（不再显示"无状态"） |
| 2026-08-14 | 书签显示站点小图标：`server.js` 新增 `/api/favicon`（本地缓存 `favicons/` → 站点 `/favicon.ico` → Bing 兜底，国内网络可用）；`app.js` 新增 `faviconImg`（侧栏+卡片墙书签均渲染，失败自动隐藏）；新增 `public/favicon.svg` 作为工作台标签页图标（index.html 已链接） |
| 2026-08-14 | 修复"点了按钮没反应"（用户点击未产生任何 POST）：①功能卡改为**整卡可点**（点击卡片任意位置执行，拖动换位不受影响）；②新增**客户端错误上报**（window.onerror/unhandledrejection → `/api/log-client-error` → workbench.log `[client]` 行）；③`buttons.json` 改为 **1 秒 TTL 自动重载**（改配置刷新页面即生效，无需重启，仅改 server.js 才需重启） |
| 2026-08-14 | **真正根因修复（拖拽吞点击）**：HTML5 `draggable` 下按住卡片任意处会启动拖拽并吞掉 click（`dragstart` 未拦截）。修复：`dragstart` 非 ⠿ 手柄区域一律 `preventDefault()`；`.drag-hint` 改为 `pointer-events:auto` + 常显；点击手柄不触发执行。现在**点击卡片任意位置执行、按住右上角 ⠿ 拖动换位** |
| 2026-08-14 | 书签支持拖拽排序：侧栏书签项加 ⠿ 手柄（`bm-drag`），拖拽排序后 `POST /api/bookmarks/reorder` 持久化到 bookmarks.json（卡片墙书签同步反映顺序）；点击链接/删除按钮不受拖拽影响（非手柄区域 dragstart 一律 preventDefault） |
| 2026-08-14 | **拖拽交互重构（指针事件）**：弃用 HTML5 draggable（吞点击）与"只认 ⠿ 手柄"（太小难找），改为 `mousedown/mousemove/mouseup` 自实现——**按住卡片/书签任意位置拖动（位移 >6px）换位，轻点即点击**；拖拽后 `suppressClick` 吞掉误触 click，`blur` 清理防卡死。文档同步更新 |
| 2026-08-14 | 拖拽增强：①卡片拖拽时**幽灵跟随光标**（fixed + pointer-events:none），落点高亮，能看清拖到哪；②**书签卡内书签也可拖拽排序**（侧栏与卡内统一 `.bm-item`，排序基于完整书签数组，避免部分列表提交不完整） |
| 2026-08-14 | **根因修复（点击静默失效）**：点击监听器读 `refs.current`、渲染只写 `rec.current`——`refs.current` 恒为 undefined，所有功能卡点击都不进 `runButton`（零请求零报错），Anki 按钮"怎么点执行都不启动"。修复：**单一真源重构**——`ensureFuncCard` 内 `rec` 先于监听器声明，两个监听器统一读 `rec.current`，`renderFuncCard` 只写 `rec.current`；`runButton` 的 `renderGrid()` 移入 try（渲染抛错不再卡死 busy）；失败路径上报 `[client]` 日志。**用无头 Edge 实测**：点击 → POST /api/run/anki → toast「Anki：已执行（退出码 0）」 |
| 2026-08-14 | **新增回归测试 `test-click.mjs`**：无头 Edge + CDP 加载页面，页面内 stub fetch（POST 拦截记录+假成功，GET 放行），逐个点击功能卡按钮与整卡点击，断言 POST 到达正确端点；无真实副作用。**负向验证**：模拟双属性 bug 时测试准确报 FAIL（exit 1），恢复后全 PASS。该 bug 的永久防线 |
| 2026-08-14 | **补齐缺失技能 `workbench-dev`**（`F:\.dsh\skills\workbench-dev\SKILL.md`）：DEV.md 早已声明"先加载 workbench-dev"但技能从未创建。技能收录点击接线单一真源、bat 纯 ASCII、配置免重启、排查流程等铁律，涉及工作台的任务会自动加载。另在 DEV.md 4.5 标注**文档漂移**（指针事件拖拽描述超前于实际 HTML5 draggable 代码，以代码为准） |
| 2026-08-14 | **余额卡跳转被弹窗拦截修复**：`window.open` 被浏览器弹窗拦截时静默失败（书签是原生 `<a>` 不受影响，故用户"书签能跳、余额卡不能跳"）。新增 `openExternal(url)`：新标签页优先，被拦截回退 `location.href` 当前页跳转，**保证点击必跳转**；余额卡与 push 完成后跳 DSH 均改用之 |
| 2026-08-14 | **前端版本自检自动刷新**：`/api/buttons` 新增 `version` 字段（静态文件 MD5，server.js `appVersion`）；app.js 首次加载记录版本，轮询发现版本变化自动 `location.reload()`。**消灭"改了代码但用户标签页是旧的、点了没反应"问题**——旧页面 ≤4 秒自愈，无需用户手动刷新。另修复手动重启陷阱：VBS 启动必须先 `WshShell.CurrentDirectory = "F:\AllWorkSpace\workbench"`（相对路径 server.js 找不到的坑） |
| 2026-08-14 | **修复"中间按钮点了没反应"（点击被拖拽判定吞掉）**：拖拽收敛回 ⠿ 手柄区——`document` mousedown 仅 `.drag-hint` 才初始化 `pDrag`，卡片其余区域（含 run-btn/标题/描述）不再经过拖拽判定，click 必达；移除卡片 click 与 `bindCardClick` 的 6px 位移阈值（拖拽不再从主体触发，阈值不再需要）；mouseup 非拖拽分支不再整页 `renderGrid()`（避免点击手势中重排 DOM）；`suppressClick` 加 `setTimeout(0)` 兜底，防"拖拽后无 click"时标志残留误吞下一次点击。`.card` 光标 `grab`→`pointer`（仅手柄 `grab`），手柄加 `title="按住拖动换位"`。`test-click.mjs` 新增 3 条拖拽判定回归用例（主体带位移点击必执行 / 手柄拖拽不执行 / 拖后点击不残留） |
| 2026-08-14 | **按钮"按下/执行"反馈增强**：`.card .run-btn:active` 由 `scale(.98)`（几乎不可见）改为明显按下效果（`translateY(2px) scale(.97)` + 内阴影 + 变暗；brutal/pixel/vintage 主题保留各自的 `:active`）；执行中（busy）按钮加 `busy` 类并播放脉冲动画 `run-btn-pulse`（app.js `renderFuncCard` 按 `busy[b.id]` toggle 类；push 等耗时操作按下后按钮持续"动起来"，`opacity` 保持 1 不降） |
| 2026-08-14 | **点击范围收紧 + 去除卡片描述**：功能卡执行入口仅剩 run-btn 按钮——移除 `ensureFuncCard` 整卡 click 监听器（卡片主体/标题点击不再触发执行，用户反馈"整卡可点范围太宽"；余额信息卡 `bindCardClick` 保留，其点击是跳转用量页）；功能卡不再渲染 `.desc` 描述文字（`buttons.json` 的 `description` 字段保留、前端不显示）；CSS 删除 `.card .desc` 与 list 布局对应规则，功能卡在 grid/split 布局下 `justify-content: space-between`（标题顶、按钮贴底）。`test-click.mjs`：「整卡点击」「主体带位移点击」两条用例改为断言**无 POST**（防回归：未来若恢复整卡可点会 FAIL） |
| 2026-08-14 | **卡片宽度整体收窄**：去掉卡片描述后内容精简，网格尺寸档位收紧——`.span-wide` 与默认档由半行（span 4）改为四分之一行（span 2），`.span-large` 由整行（span 8）改为半行（span 4），`.span-small` 保持 span 2；桌面 8 列网格一行 4 张卡（原先 wide 卡半行只有标题+按钮，显得空旷） |
