# HACKING.md · 开发者 onboarding（5 分钟入口）

> **本文件是工作台项目的**快速上手入口**。**
> 改代码前 5 分钟读这份 → 直接动手；遇到细节 → 跳 [`DEV.md`](./DEV.md) 对应章节。
> 完整 API、变更历史、机制详解都在 DEV.md（71KB）；本文件是入口与索引，不是替代。
>
> **上次更新**：2026-08-17（v0.8：multi-tag 全部→隐藏 + checkbox 视觉隐藏 + 模式管理区分组折叠）
> - v0.5：22px 等宽大字 + 琥珀脉冲动画 → 「多个 8px 小圆点 + 极小 meta」（圆点对齐 DSH 会话栏）
> - v0.5.1：working meta 仅留「N 个工作」；非 working 移除静态文字
> - v0.5.2：非 working 状态（idle/offline/error/loading）连圆点也不显示——卡片塌缩到只剩标题
> - v0.6：拆 v0.5.2 的二态判断为三态可见（working / unread / pending）
> - v0.6.2：移除 unread 状态——只剩 working（旋转琥珀，每会话一个）+ pending（琥珀静态，plan 待确认）；truly idle / blank / offline / error 仍隐藏
> - **v0.7**：①4 处 select option 内的 `🔒 ` 前缀已清理；②所有 `<select>` 改为 multi-checkbox 标签（虚拟"全部"项 + 每个模式一个 checkbox）；③新增设置面板「模式管理」区（`sp-section[data-collapsible="mode-manager"]`）——统一列出 4 类内容
> - **v0.8（用户反馈 4 项）**：①multi-tag 组件 v0.7 虚拟"全部"按钮移除 → 新增"隐藏"按钮（与具体模式互斥；mode 字段新增第四态 sentinel `'__hidden__'`——服务端 `normalizeModeField` 白名单识别；前端 `modeMatches` 永远 false）；②checkbox 视觉完全隐藏（`position:absolute; opacity:0; pointer-events:none`），点击 `<label>` 触发，`.mode-tag.active` 增加发光 box-shadow + 按下 scale(0.96) 强化"点了亮起"反馈；③模式管理区 4 个分组（书签 / RSS 源 / 快捷方式 / 手动配置）按分类收起展开——分组标题改为可点击 `<button>`，toggle `.collapsed` + `localStorage.workbench-fold-mmgr-{groupId}` 持久化；④用户设计偏好沉淀到 §3.5 与 DECISIONS.md D039
> - **新概念**：mode 字段 4 态——`null` / `string` / `string[]` / `'__hidden__'`（v0.8 新增）；`__hidden__` 是 UI 上"隐藏"按钮对应的 sentinel，与具体模式互斥（content 在任何模式下都不显示）

---

## 0. 必须先读（30 秒）

1. **违反铁律 = 按钮坏**（不响应、错乱、丢数据、点击静默失效零报错）。
2. 这是单人项目，但本文档面向**未来任何接手者**（含另一个 agent / 半年后的自己）。
3. **文档必须随代码改动同步更新**（见末尾 §6 维护规则）。

---

## 1. 项目 30 秒定位

| 维度 | 说明 |
|---|---|
| 是什么 | 本机网页工作台，把常用操作做成按钮点一下即执行（启动服务 / 跑脚本 / 打开应用） |
| 端口 | 3180，监听 127.0.0.1（**不**对外开放） |
| 技术栈 | Node 内置模块 + 原生 HTML/CSS/JS，**零第三方依赖**，无构建步骤 |
| 数据流 | 浏览器 → `server.js`（/api/*）→ `child_process.spawn` 或 DSH 3080 |
| 持久化 | 服务端 `buttons.json` / `modes.json` / `bookmarks.json` / `feeds.json` / `push-state.json` / `dida-state.json`；前端偏好全 `localStorage` |

详见 [`DEV.md §1`](./DEV.md) 项目概览。

---

## 2. 文件地图（哪个改动在哪改）

| 想改什么 | 改这个文件 | 生效方式 | 链向 |
|---|---|---|---|
| 加按钮 / 改按钮配置 | `buttons.json` | 刷新页面（1 秒 TTL 自动重载） | [DEV §6.1](#61-新增普通按钮) |
| 加新模式 / 改模式定义 | `modes.json` | 刷新页面（前端 fetch `/api/modes`） | DEV §8 2026-08-17 v2（modes.json 配置化） |
| 改 mode 字段（书签 / RSS 源） | 设置面板「模式管理」区（v0.7） | 实时 PATCH（验证过即见） | DEV §8 2026-08-17 v7（multi-tag + 模式管理区） |
| 加 toggle 按钮（启停同服务） | `buttons.json` 同上 | 同上 | [DEV §6.2](#62-新增-toggle-按钮) |
| 加新主题 / 新布局 | `public/style.css` + `public/index.html`（app.js 自动读 data-theme-opt） | Ctrl+F5 | [DEV §6.4](#64-新增主题--布局) |
| 加新信息卡（如"股票卡"） | `server.js`（API）+ `public/app.js`（SYS_CARDS + renderSystemCard）+ `public/index.html`（如需面板） | **重启服务** | [DEV §6.3](#63-新增信息卡--新按钮类型需改代码) |
| 改 push / dida 流程 | `server.js`（runPush / runDida） | 重启服务 | [DEV §4.4](#44-push-卡片流程依赖-dsh-服务-3080-勿破坏) |
| 修按钮"点了没反应" | 见 [§5 排障](#5-排障按钮点了没反应) | — | — |
| 加新配置字段（如 mode） | `buttons.json` 加字段 + `app.js` 处理 + DEV §8 记录 | 视字段 | — |

---

## 3. 铁律（10 条，违反即坏）

> 每条 = 一句话 + 为什么 + 改哪查证。完整版见 [DEV §0](./DEV.md) + `F:\.dsh\skills\workbench-dev\SKILL.md`。

1. **点击接线单一真源 `rec.current`**：`ensureFuncCard` 监听器与 `renderFuncCard` 渲染必须共用同一对象属性。曾因读写两个属性导致点击静默失效（零请求零报错）——改 `app.js` 卡片逻辑前先 grep `current` 确认读写一致，改完跑 `node test-click.mjs`。
2. **bat 文件必须纯 ASCII**（注释写英文）：`cmd.exe` 按 OEM 代码页（GBK）解析，UTF-8 中文注释会吞换行、挂起 cmd。写完 `grep -P '[^\x00-\x7F]' xxx.bat` 校验。
3. **改 `buttons.json` 免重启**（1 秒 TTL 自动重载）；改 `public/` **Ctrl+F5** 即可；**只有改 `server.js` 才需重启服务**。
4. **静态响应必带 `Cache-Control: no-cache`**（server.js 已实现，**勿移除**），否则浏览器缓存旧 JS。
5. **执行命令用「字符串拼接 + `spawn(shell: true)`」**，不能用 `spawn(cmd, args)` 数组（引号二次转义导致 bat 不执行、退出码 1）。
6. **桌面应用按钮处理"已运行"场景**：参考 `launch-anki.bat` / `launch-app.ps1`——`tasklist` 检测 → 已运行 `AppActivate` 激活前台；未运行才 `start`。
7. **按钮点击必须有可见反馈**（全局 toast 已实现）。任何新增类型保持 toast（成功/失败/锁定/警告四态）。
8. **打开外部链接用 `openExternal(url)`**（app.js）：被弹窗拦截回退 `location.href`。**禁止直接 `window.open`**——曾因弹窗拦截"点了没反应"。
9. **前端版本自检已内置**：`/api/buttons` 返回静态文件 MD5，页面发现版本变化自动 reload。**改前端文件后旧标签页 ≤4 秒自愈**，开发中频繁改文件会触发刷新属预期。
10. **改动必测试**：`node test-click.mjs`（无副作用）→ DEV §7 清单 → 浏览器 Ctrl+F5 实测。

---

## 3.5. 用户设计偏好（来自 v0.8 反馈）

> 用户偏好 = "做得好看 + 不该出现的元素就不出现"。不是强制铁律，但是日常 UI 决策的优先级参考。

1. **multi-tag 设计**："全部"按钮冗余——既然"不勾选任何" = 默认 = 全部模式可见，"全部"按钮功能被覆盖；该功能不必重复显式表达。"隐藏"按钮有价值——内容可以主动从所有模式中隐藏。**因此**：当前 `renderModeTags` 无"全部"按钮，有"隐藏"按钮（与具体模式互斥；`mode === '__hidden__'`）。改 multi-tag UI 时**保留这个不对称**：去掉"全部"、保留"隐藏"。
2. **checkbox 视觉隐藏**：用户原话"点了然后亮起来的那种……把勾选框藏起来 美观很多"——`<input type="checkbox">` 视觉完全隐藏（保留 DOM 做可访问性），点击 `<label>` 触发；`.mode-tag.active` 用 box-shadow 发光 + 按下 scale(0.96) 强化"亮起"反馈。**不要**在用户面前显示原生 checkbox 框。
3. **列表型 UI 默认支持按分类收起展开**：用户原话"按照分类收起展开基本是我的基本要求了 要去做的"。**因此**：任何新增的"分组列表型" UI（模式管理区分组 / sc-list / rss-list 等）默认就要带分组标题可点击 + toggle 折叠 + localStorage 持久化（与现有 sp-section 同款机制）。**别等到用户反馈再加**——这是默认行为。
4. **"破坏性"操作视觉降级**："隐藏"按钮用中性灰（`var(--text-3)` + dashed border）而非强调色（accent），推到右侧（`margin-left: auto`）——与"勾选可见模式"按钮刻意拉开视觉距离，避免误触。**原则**：非主流状态（隐藏 / 收起 / 禁用）视觉上要"安静"，不要用强调色抢注意力。

---

## 4. 常见改动场景（直查表）

| 场景 | 看哪里 | 备注 |
|---|---|---|
| 加一个启动程序的按钮 | [DEV §6.1](./DEV.md) | 或用样式面板「快捷方式」自动添加（**不消耗 AI token**） |
| 加一个 toggle（启停服务） | [DEV §6.2](./DEV.md) | 必须填 `port`，按端口状态自动选 start/stop |
| 加一种新主题或布局 | [DEV §6.4](./DEV.md) | 三处同步：`style.css` + `index.html`（app.js 自动读） |
| 加一种新信息卡 | [DEV §6.3](./DEV.md) | 改 server.js + app.js + index.html；按钮加 `kind` 字段要扩展 `serializeButton` 分支 |
| 加 dida 按钮（"整理 Inbox"风格） | buttons.json + `dida-state.json` 机制 | 见 [DEV §4.4.1](#441-dida-卡片流程) |
| 加 RSS 源 | 样式面板「RSS 订阅」区直接加 | **不**改代码（[DEV §6.5](#65-自动添加快捷方式无需改配置不消耗-ai-token)） |
| 加 DSH 对话状态可视化 | 不需要 | `sys-dsh-sessions` 卡已内置（v0.4 → v0.5 → v0.5.2 → v0.6 → **v0.6.2 二态可见**）；服务端 `/api/dsh-sessions` 代理 DSH 3080；**v0.6.2 圆点语义** working=N 个旋转琥珀扇形 / pending=单琥珀静态点（聚合）/ truly idle / offline / blank 隐藏 |
| 调整卡片顺序 / 主题 / 偏好 | **不**改代码——`localStorage` 持久化 | 浏览器本地，换浏览器或清缓存会重置 |
| 想加"模式"维度（工作/娱乐） | `buttons.json` 加 `"mode": "entertainment"` | 已有实现，见 DEV §8 2026-08-17 条目；模式状态 localStorage `workbench-mode` |
| 想加新模式（学习/通勤/专注） | `modes.json` 追加一条 `{id, name, icon, readonly}` | 已有实现，见 DEV §8 2026-08-17 v2 条目 + D031；前端切换器自动渲染，零代码改动 |
| 想让书签 / RSS 源只出现在某模式 | 书签 modal / RSS 源添加表单选 mode；或直接改 `bookmarks.json` / `feeds.json` 加 `mode` 字段 | 已有实现；服务端 `normalizeModeField` 校验非法 mode id；旧数据自动补 `mode:null` |
| 想让工作模式"只读" | `modes.json` 设 `readonly:true` | 已有实现：拖拽手柄不渲染、外观/布局/偏好/快捷方式/RSS 区 pointer-events:none、按钮执行不被锁 |
| 编辑书签的 mode（创建后） | 侧栏 ✎ / 卡片墙 ✎ → modal 改 name/url/mode | v0.7 改为 multi-tag（v0.5 之前是 select 单选）；PATCH `/api/bookmarks/<id>` |
| 编辑快捷方式（卡片）的 mode（创建后） | 设置面板「快捷方式」列表项的 multi-tag | v0.7 改为 multi-tag；POST `/api/buttons/update` 接受 mode 字段 |
| 一处编辑所有内容 mode | 设置面板「模式管理」区（v0.7 新增） | 4 类内容分组：书签 / RSS 源 / 快捷方式 / 手动配置按钮；每行 inline multi-tag 实时 PATCH；手动配置按钮只读（需改 buttons.json） |
| 调整 multi-tag 组件（按钮 / 视觉 / 状态机） | `public/app.js` 的 `renderModeTags`（line ~1078）+ `public/style.css` `.mode-tag*` + 服务端 `normalizeModeField` | v0.8 设计原则见 §3.5；mode 字段 4 态（null/string/array/`__hidden__`）；改完跑 `test-mode-tags.mjs` + `test-mode.mjs` + `test-click.mjs` |
| 让内容"隐藏"（不在任何模式显示） | multi-tag 勾"隐藏"按钮 → mode = `'__hidden__'` | v0.8 新增 sentinel；服务端 `normalizeModeField` 白名单识别；前端 `modeMatches` 永远 false |
| 模式管理区按分类收起 | 设置面板「模式管理」4 个分组的标题行（v0.8 可点击 button） | localStorage `workbench-fold-mmgr-{groupId}` 持久化；4 个 groupId 固定：`bookmark` / `feed` / `shortcut` / `manual` |

---

## 5. 排障（按钮"点了没反应"决策树）

```
点了没反应
├─ 查 workbench.log（服务端每次请求都有 [时间] METHOD /path）
│   ├─ 有 POST 记录 → 命令失败，看 entry.code（非 0 → 查 bat / 启动脚本）
│   └─ 无 POST 记录 → 浏览器端
│       ├─ 页面是否已 Ctrl+F5 刷新？（旧标签页 ≤4s 自愈，等一下再试）
│       ├─ 浏览器缓存旧 JS？（强制刷新一次）
│       └─ 前端接线断？跑 node test-click.mjs → 失败行 = 问题点
└─ 看 workbench.log 有 [client] 行？→ window.onerror / unhandledrejection / runButton 失败
```

详细：[DEV §4.5](./DEV.md) 前端卡片系统 + `F:\.dsh\skills\workbench-dev\SKILL.md` 排障段。

---

## 6. 维护规则（每次改动后必做，文档不能漂移）

> **核心原则**：代码与文档同步——改一处就要问"这份 onboarding 是否还准？"

### 1. 改完代码后（必做）

1. **DEV.md §8 追加变更记录**：一行总结（什么 + 为什么 + 影响面），按日期追加。
2. **本文件检查清单**（按需修改）：
   - 改了 §2 文件地图？→ 改这里
   - 改了 §3 铁律？→ 同步 DEV §0 + skill workbench-dev 的铁律段
   - 改了 §4 常见场景？→ 同步 DEV §6
   - 改了 §5 排障？→ 同步 DEV §4.5
   - **新增了一个常见改动场景**？→ 在 §4 加一行
3. **更新本文"上次更新"日期**（顶部）+ 简述变更。

### 2. 发现了新坑（新铁律诞生）

- 在 DEV §0 + 本文件 §3 + skill workbench-dev 三处同步加——三处是同一份铁律的三个镜像，必须保持一致。
- 至少给出一条"真实踩坑的场景 + 为什么违反即坏"作为教训来源。

### 3. 文档漂移检测

- **以代码为准**（DEV §0 明示）。发现 DEV §X 描述与代码不符：
  - 小漂移（语句过时、引用行号偏移）→ 直接修 DEV + 必要时修本文件
  - 大漂移（架构改变）→ 同步改三处 + DEV §8 加更正条目
- 不要让文档"看起来还在但其实错"——半年后读会害死人。

---

## 7. 一句话总结

**改前读 §3 铁律 → 改时按 §2 文件地图定位 → 改完按 §6 维护规则更新文档 → 改后跑 test-click.mjs + DEV §7 清单。**

详细永远是 DEV.md；本文件是入口与契约（**契约**意味着违反必须付出代价，所以铁律是 §3 而不是附录）。