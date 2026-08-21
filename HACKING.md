# HACKING.md · 开发者 onboarding（5 分钟入口）

> **本文件是工作台项目的快速上手入口。** 改代码前 5 分钟读这份 → 直接动手；遇到细节 → 跳 [`DEV.md`](./DEV.md) 对应章节。
> 完整 API、机制详解、所有版本变更历史都在 DEV.md（53KB，本机专属）；本文件是入口与索引，不是替代。
>
> **上次更新**：2026-08-22（书签 modal 加删除按钮：编辑模式可见删除入口）

> **新概念**：mode 字段 4 态——`null` / `string` / `string[]` / `'__hidden__'`（v0.8 新增）；`__hidden__` 是 UI 上"隐藏"按钮对应的 sentinel，与具体模式互斥（content 在任何模式下都不显示）。
>
> **v1 新增**：系统信息卡（`SYS_CARDS` 内置 8 张）也支持 mode 选择——模式管理区第 5 组「系统卡」，默认全部模式可见；用户主动配置后服务端 `syscards-state.json` 持久化（详见 §4 行 + DEV §8 2026-08-18 v1）。

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

### 2.1 前端拆分（v1.2 起）

工作台前端从单文件 `app.js`（3110 行）拆为多文件 `wb-*.js`，按职责分工、通过 `index.html` 的 `<script>` 标签同步加载。详见 [`docs/maintainability.md`](./docs/maintainability.md)。

| 文件 | 职责 |
|---|---|
| `public/wb-core.js` | 共享 DOM 引用 / SYS_CARDS / CARD_ICONS / 动画 / fetchJSON / 错误上报（**最先加载**） |
| `public/wb-mode.js` | 模式系统（MODES / currentMode / modeMatches / renderModeTags） |
| `public/wb-state.js` | 全局状态变量 + 全部 refresh* 轮询函数 + 价格时段 |
| `public/wb-render.js` | keyed 渲染缓存 / ensure*Card / render*Card / applyMasonry |
| `public/wb-action.js` | runButton / showToast / openExternal（待拆） |
| `public/wb-bookmarks.js` | 书签功能（待拆） |
| `public/wb-drag.js` | 拖拽（待拆） |
| `public/wb-search.js` | 顶栏搜索（待拆） |
| `public/wb-settings.js` | 设置面板（待拆） |
| `public/app.js` | 入口（init 调度 + 跨模块桥接；无业务逻辑） |

### 2.2 改动定位（按想改的内容）

| 想改什么 | 改这个文件 | 生效方式 | 链向 |
|---|---|---|---|
| 加按钮 / 改按钮配置 | `buttons.json` | 刷新页面（1 秒 TTL 自动重载） | [DEV §6.1](#61-新增普通按钮) |
| 加新模式 / 改模式定义 | `modes.json` | 刷新页面（前端 fetch `/api/modes`） | DEV §8 2026-08-17 v2（modes.json 配置化） |
| 改 mode 字段（书签 / RSS 源） | 设置面板「模式管理」区（v0.7） | 实时 PATCH（验证过即见） | DEV §8 2026-08-17 v7（multi-tag + 模式管理区） |
| 加 toggle 按钮（启停同服务） | `buttons.json` 同上 | 同上 | [DEV §6.2](#62-新增-toggle-按钮) |
| 加新主题 / 新布局 | `public/style.css` + `public/index.html`（wb-state 的 applyStyle 读 `data-theme-opt`） | Ctrl+F5 | [DEV §6.4](#64-新增主题--布局) |
| 加新信息卡（如"股票卡"） | `server.js`（API）+ `public/wb-core.js`（SYS_CARDS_WHITELIST 镜像）+ `public/wb-render.js`（ensureSystemCard / renderSystemCard）+ `public/index.html`（如需面板） | **重启服务** | [DEV §6.3](#63-新增信息卡--新按钮类型需改代码) |
| 改 push / dida 流程 | `server.js`（runPush / runDida） | 重启服务 | [DEV §4.4](#44-push-卡片流程依赖-dsh-服务-3080-勿破坏) |
| 改 multi-tag 组件（按钮 / 视觉 / 状态机） | `public/wb-mode.js` 的 `renderModeTags` + `public/style.css` `.mode-tag*` + 服务端 `normalizeModeField` | Ctrl+F5 | v0.8 设计原则见 §3.5；mode 字段 4 态（null/string/array/`__hidden__`）；改完跑 `tests/test-mode-tags.mjs` + `tests/test-mode.mjs` + `tests/test-click.mjs` |
| 改 MiniMax 渲染（警示 / marker / edge case） | `public/wb-render.js` 的 `renderMiniMaxCard` + `formatResetIn` + `public/style.css` `.mmx-*` + `tests/test-minimax.mjs` | Ctrl+F5 | v0.9 算法 + v0.9.4 视觉（marker 周期用 `wweek.windowMinutes` 动态） |
| 修按钮"点了没反应" | 见 [§5 排障](#5-排障按钮点了没反应) | — | — |
| 加新配置字段（如 mode） | `buttons.json` 加字段 + 对应 wb-*.js 处理 + DEV §8 记录 | 视字段 | — |

---

## 3. 铁律（10 条，违反即坏）

> 每条 = 一句话 + 为什么 + 改哪查证。完整版见 [DEV §0](./DEV.md) + `F:\.dsh\skills\workbench-dev\SKILL.md`。

1. **点击接线单一真源 `rec.current`**：`ensureFuncCard` 监听器（在 `wb-render.js`）与 `renderFuncCard` 渲染必须共用同一对象属性。曾因读写两个属性导致点击静默失效（零请求零报错）——改卡片逻辑前先 grep `current` 确认读写一致，改完跑 `node test-click.mjs`。
2. **bat 文件必须纯 ASCII**（注释写英文）：`cmd.exe` 按 OEM 代码页（GBK）解析，UTF-8 中文注释会吞换行、挂起 cmd。写完 `grep -P '[^\x00-\x7F]' xxx.bat` 校验。
3. **改 `buttons.json` 免重启**（1 秒 TTL 自动重载）；改 `public/` **Ctrl+F5** 即可；**只有改 `server.js` 才需重启服务**。
4. **静态响应必带 `Cache-Control: no-cache`**（server.js 已实现，**勿移除**），否则浏览器缓存旧 JS。
5. **执行命令用「字符串拼接 + `spawn(shell: true)`」**，不能用 `spawn(cmd, args)` 数组（引号二次转义导致 bat 不执行、退出码 1）。
6. **桌面应用按钮处理"已运行"场景**：参考 `launch-anki.bat` / `launch-app.ps1`——`tasklist` 检测 → 已运行 `AppActivate` 激活前台；未运行才 `start`。
7. **按钮点击必须有可见反馈**（全局 toast 已实现）。任何新增类型保持 toast（成功/失败/锁定/警告四态）。
8. **打开外部链接用 `openExternal(url)`**（现位于 `app.js` 的"跨模块桥接"块，挂到 `WB.openExternal`）：被弹窗拦截回退 `location.href`。**禁止直接 `window.open`**——曾因弹窗拦截"点了没反应"。
9. **前端版本自检已内置**：`/api/buttons` 返回静态文件 MD5，页面发现版本变化自动 reload。**改前端文件后旧标签页 ≤4 秒自愈**，开发中频繁改文件会触发刷新属预期。
10. **改动必测试**：`node tests/test-click.mjs`（无副作用）→ DEV §7 清单 → 浏览器 Ctrl+F5 实测。
11. **数据加载失败必须显式告警 + 拒绝覆盖**（v1.1 教训）：`bookmarks.json` 等用户数据加载 try/catch 失败时，**绝不能**让内存空数组经 saveBookmarks 覆盖原文件。规范：①加载失败 → 复制原文件为 `.bak`（保留数据）+ 设置 `xxxLoadFailed = true`；②saveXxx 检查标志，true 时**拒绝写入并 console.error FATAL**；③API 响应里暴露 `loadFailed` 字段供前端显示横幅。**严禁**"加载失败就静默用默认值"——会引发"内存空 → 后续操作覆盖原文件"的连锁数据丢失事故（2026-08-19 真实案例）。改任何用户数据加载段前先 grep `LoadFailed` / `backupCorruptedData` 确认模式一致。

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
| 加一种新主题或布局 | [DEV §6.4](./DEV.md) | 三处同步：`style.css` + `index.html`（wb-state 的 applyStyle 自动读） |
| 加一种新信息卡 | [DEV §6.3](./DEV.md) | 改 server.js + wb-core.js（SYS_CARDS_WHITELIST 镜像）+ wb-render.js（ensureSystemCard / renderSystemCard）+ index.html；按钮加 `kind` 字段要扩展 `serializeButton` 分支 |
| 加 dida 按钮（"整理 Inbox"风格） | buttons.json + `dida-state.json` 机制 | 见 [DEV §4.4.1](#441-dida-卡片流程) |
| 加 RSS 源 | 样式面板「RSS 订阅」区直接加 | **不**改代码（[DEV §6.5](#65-自动添加快捷方式无需改配置不消耗-ai-token)） |
| 加 DSH 对话状态可视化 | 不需要 | `sys-dsh-sessions` 卡已内置（v0.4 → v0.5 → v0.5.2 → v0.6 → **v0.6.2 二态可见**）；服务端 `/api/dsh-sessions` 代理 DSH 3080；**v0.6.2 圆点语义** working=N 个旋转琥珀扇形 / pending=单琥珀静态点（聚合）/ truly idle / offline / blank 隐藏 |
| 调整卡片顺序 / 主题 / 偏好 | **不**改代码——`localStorage` 持久化 | 浏览器本地，换浏览器或清缓存会重置 |
| 想加"模式"维度（工作/娱乐） | `buttons.json` 加 `"mode": "entertainment"` | 已有实现，见 DEV §8 2026-08-17 条目；模式状态 localStorage `workbench-mode` |
| 想加新模式（学习/通勤/专注） | `modes.json` 追加一条 `{id, name, icon, readonly}` | 已有实现，见 DEV §8 2026-08-17 v2 条目 + D031；前端切换器自动渲染，零代码改动 |
| 书签卡“+”无反应 | `app.js` 将 `openModal` 桥接到 `WB.openModal`；`wb-render.js` 保留按钮并按 readonly 显隐 | 卡片渲染与 modal 实现跨文件，按钮监听必须走 `WB.xxx` 运行时桥接；切回可编辑模式后仍可打开添加弹窗 |
| 想让书签 / RSS 源只出现在某模式 | 书签 modal / RSS 源添加表单选 mode；或直接改 `bookmarks.json` / `feeds.json` 加 `mode` 字段 | 已有实现；服务端 `normalizeModeField` 校验非法 mode id；旧数据自动补 `mode:null` |
| 想让工作模式"只读" | `modes.json` 设 `readonly:true` | 已有实现：拖拽手柄不渲染、外观/布局/偏好/快捷方式/RSS 区 pointer-events:none、按钮执行不被锁 |
| 编辑书签的 mode（创建后） | 侧栏 ✎ / 卡片墙 ✎ → modal 改 name/url/mode | v0.7 改为 multi-tag（v0.5 之前是 select 单选）；PATCH `/api/bookmarks/<id>` |
| 编辑快捷方式（卡片）的 mode（创建后） | 设置面板「快捷方式」列表项的 multi-tag | v0.7 改为 multi-tag；POST `/api/buttons/update` 接受 mode 字段 |
| 一处编辑所有内容 mode | 设置面板「模式管理」区（v0.7 新增） | **5 类内容分组**（v1 新增系统卡）：书签 / RSS 源 / 快捷方式 / 手动配置按钮 / **系统卡**；每行 inline multi-tag 实时 PATCH；手动配置按钮只读（需改 buttons.json） |
| 调整 multi-tag 组件（按钮 / 视觉 / 状态机） | `public/wb-mode.js` 的 `renderModeTags` + `public/style.css` `.mode-tag*` + 服务端 `normalizeModeField` | v0.8 设计原则见 §3.5；mode 字段 4 态（null/string/array/`__hidden__`）；改完跑 `tests/test-mode-tags.mjs` + `tests/test-mode.mjs` + `tests/test-click.mjs` |
| 想让系统信息卡（滴答 / 余额 / RSS 等）也只在某模式显示 | 样式 → 模式管理 → 「系统卡」分组（v1 新增） | 默认全部模式可见（向后兼容）；勾具体模式 / 「隐藏」→ PATCH `/api/syscards/<id>` 持久化到 `syscards-state.json`；服务端白名单（`SYS_CARDS_WHITELIST` 8 个 id）+ `normalizeModeField` 兜底非法 mode id；前端 `SYS_CARDS[id].mode` 是 `modeMatches` 真源；改完跑 `tests/test-syscard-mode.mjs` |
| 系统卡（如滴答今日/专注）卡在"读取中..." | 浏览器侧 fetch 永不返回（扩展 / SW / 网络层死锁）→ `didaToday` 永远 null | v0.8.1 修复：wb-state.js 的 `refreshDidaToday` / `refreshDidaFocus` 加 10s `AbortController` 超时 + console 日志；Ctrl+F5 后看 DevTools Console 是否出现 `[dida-today] failed: AbortError` 定位原因。详见 [DEV §8 2026-08-18](#) |
| 让内容"隐藏"（不在任何模式显示） | multi-tag 勾"隐藏"按钮 → mode = `'__hidden__'` | v0.8 新增 sentinel；服务端 `normalizeModeField` 白名单识别；前端 `modeMatches` 永远 false |
| 模式管理区按分类收起 | 设置面板「模式管理」5 个分组的标题行（v0.8 可点击 button；v1 新增系统卡组） | localStorage `workbench-fold-mmgr-{groupId}` 持久化；**5 个** groupId 固定：`bookmark` / `feed` / `shortcut` / `manual` / `syscard` |
| 晚间统一推送 GitHub | 本机开发者约定，按各自 skill / 脚本走 | 自动 fetch + 分歧检测 + 敏感内容审计 + 列文件 + 默认确认 |
| 调整 MiniMax 周限额 marker 样式 / 算法 / edge case | `public/wb-render.js` 的 `renderMiniMaxCard` + `formatResetIn` + `public/style.css` 的 `.mmx-bar-marker` 段 + `tests/test-minimax.mjs`（5 个 marker 断言 A/B/C/D/E + 2 个形状 A.5） | Ctrl+F5 | v0.9 算法（marker 周期用 `wweek.windowMinutes` 动态）+ v0.9.4 视觉（SVG 右括号 `)`，10×10 viewBox，path `M 5 0 Q 10 5, 5 10`）；位置/title/edge case 逻辑不变 |
| 加静态信息卡（数据存 JSON 文件；如投资方案类） | 新建 `invest-xxx.json` + `server.js`（INVEST_FILES + `/api/invest/:id`）+ `public/wb-core.js`（SYS_CARDS 镜像 + CARD_ICONS）+ `public/wb-render.js`（`sys-invest-*` 通用分支 + renderInvestInfoCard helper）+ `public/style.css`（`.invest-info-*` 段） + `.gitignore`（个人专属 JSON） | 重启服务（仅 server.js 改时） | v1.x：5 张共用 `kind:'invest-info'` 通用渲染；JSON 文件可热改（Ctrl+F5 强刷内存缓存）；个人专属数据按 D050 隔离 |

---

## 5. 排障（按钮"点了没反应"决策树）

```
点了没反应
├─ 查 workbench.log（服务端每次请求都有 [时间] METHOD /path）
│   ├─ 有 POST 记录 → 命令失败，看 entry.code（非 0 → 查 bat / 启动脚本）
│   └─ 无 POST 记录 → 浏览器端
│       ├─ 页面是否已 Ctrl+F5 刷新？（旧标签页 ≤4s 自愈，等一下再试）
│       ├─ 浏览器缓存旧 JS？（强制刷新一次）
│       └─ 前端接线断？跑 node tests/test-click.mjs → 失败行 = 问题点
└─ 看 workbench.log 有 [client] 行？→ window.onerror / unhandledrejection / runButton 失败
```

详细：[DEV §4.5](./DEV.md) 前端卡片系统 + `workbench-dev` skill 排障段（在你 DSH skills 目录里）。

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