# 工作台前端拆分规范（v1.2 拆分）

> 适用：本工作台的前端 JS 模块拆分与编码风格。读者：维护者、AI agent、code review 工具。
>
> 精神来源：DSH 插件的 `E:\dsh-plugins\docs\maintainability.md`（共享"按职责拆分 + 文档化决策 + 禁止 AI 风格漂移"的核心思路），但**工作台与 DSH 插件技术栈差异大**——DSH 是 `client bundle` 单文件 IIFE 工厂（必须 ES5 / 必须拼回）；工作台是浏览器原生 `<script>` 加载多文件（可 ES2015+ / 无 build step）。本规范针对后者定制。

## 一、问题背景

工作台前端从 v0.1.x 演化到 v1.1 时，`public/app.js` 增长到 **3110 行 / 135 KB**，远超单文件合理可维护边界：

- **人类**：打开一次要扫 3000+ 行才能定位一个函数
- **AI agent**："读完整个文件再改一处"模式在长文件下反复出现漏改、误改（同一变量在多处同名，下游的引用被一刀切地全局替换）
- **diff 噪声**：单次改动看起来只动几行，但 reviewer 必须读完整个文件上下文才能判断影响范围
- **新写代码风格漂移**：AI 写新代码时缺少统一的"风格契约"，导致不同模块看起来不像同一个人写的

## 二、解决方案结构

工作台前端按职责拆分为多个 `public/wb-*.js` 文件，按依赖顺序通过 `index.html` 的 `<script>` 标签同步加载；最后由 `public/app.js` 作为入口调度 `init()`。

```
public/
├── wb-core.js          ← 核心工具 + 元数据（最先加载）
├── wb-mode.js          ← 模式系统（MODES / currentMode / modeMatches / renderModeTags）
├── wb-state.js         ← 状态变量 + 轮询刷新函数
├── wb-render.js        ← 所有渲染函数（keyed 渲染缓存 + 卡片 DOM）
├── wb-action.js        ← 用户操作（runButton / showToast / openExternal）
├── wb-bookmarks.js     ← 书签功能（侧栏渲染 + modal + CRUD + 拖拽）
├── wb-drag.js          ← 拖拽（卡片 + 书签）
├── wb-search.js        ← 顶栏快速搜索
├── wb-settings.js      ← 设置面板（样式 + 快捷方式 + RSS 源 + 模式管理）
└── app.js              ← 入口（init 调度 + 跨模块桥接）
```

加载顺序见 `index.html`：核心 → 模式 → 状态 → 渲染 → 操作 → 书签 → 拖拽 → 搜索 → 设置 → 入口。

每个文件的具体职责写在文件顶部 banner 注释中（§ 四）。

## 三、命名规则

| 文件                      | 角色                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| `wb-core.js`              | 共享 DOM 引用 + SYS_CARDS + CARD_ICONS + 动画 + fetchJSON + 错误上报            |
| `wb-mode.js`              | 模式系统（MODES / currentMode / modeMatches / modeLabel / renderModeTags）    |
| `wb-state.js`             | 全局状态变量 + 全部 refresh* 轮询函数 + 价格时段徽章                         |
| `wb-render.js`            | 卡片顺序 / 卡片尺寸 / keyed 渲染缓存 / ensure*Card / render*Card / applyMasonry |
| `wb-action.js`            | runButton / showToast / openExternal / completeTask                          |
| `wb-bookmarks.js`         | 侧栏书签渲染 / modal / CRUD / faviconImg / 书签拖拽                          |
| `wb-drag.js`              | 卡片拖拽（指针事件，仅 ⠿ 手柄）                                              |
| `wb-search.js`            | 顶栏搜索（bmMatches / cardMatchesSearch / runFirstSearchMatch）               |
| `wb-settings.js`          | 样式 / 模式切换 / 快捷方式管理 / RSS 源管理 / 模式管理区                       |

**命名约束**：
- 永远以 `wb-` 前缀开头（区别于第三方 `*.js`）
- 中间用 `-` 连接，**不**用下划线或驼峰
- 名称是**职责名词**，不是动词（`render.js` 而不是 `renderFunc.js`；`bookmarks.js` 而不是 `bookmark.js`）
- 新加 section 前**先看 § 五 拆分原则**，再决定是加文件还是加 section

## 四、文件顶部 banner 注释（硬约束）

**每个 `wb-*.js` 文件首行必须是统一的 banner 注释块**：

```javascript
// =============================================================
// <文件名> · 工作台前端
// =============================================================
//
// 职责：
//   - <要点 1>
//   - <要点 2>
//   - ...
//
// 设计：
//   - <设计约束 1>（加载顺序、依赖、与其他模块关系、暴露 API 等）
//   - <设计约束 2>
//   - ...
// =============================================================

(function () {
  'use strict';
  ...
})();
```

**硬性要求**：
- 标题行：`// ====` + 60 字符 + `// ====`（固定宽度，对齐美观）
- 两段注释：**职责** / **设计**（顺序固定，便于 review 与 AI 维护时快速理解）
- "设计"段涵盖：加载顺序、依赖、与其他模块关系、暴露 API、性能约束等"为什么这么做"
- 顶部 banner 后必须有空行，再开始 IIFE
- IIFE 必须 `'use strict'`

**反例**（禁止）：
- 没有 banner 直接进入 IIFE
- banner 中只有"职责"没有"设计"
- 注释中只有 `// v1.2 第三步` 而不说明这个文件做什么

## 五、Section marker 约定（硬约束）

**每个 `wb-*.js` 文件内部按职责划分 section，每个 section 顶部必须有 marker**：

```javascript
  // ===== <section 名> =====
  // <section 内可选的简短说明>
  ...
```

**硬性要求**：
- 缩进：2 空格（与 IIFE 内部缩进一致；区别于 DSH 的 4 空格——DSH 是拼进多一层嵌套的工厂体）
- 格式：`// ===== <X> =====`（前后各 5 个 `=`）
- section 名：简短、能说明职责，**优先与文件 `<role>` 部分对应**
- section 之间空一行
- 文件末不留空 section

**示例**：

```javascript
  // ===== 共享 DOM 引用 =====
  // 一次性取好（id 不变）；任何模块都能通过 window.WB.grid 等访问
  WB.grid = document.getElementById('buttons-grid');

  // ===== 模式匹配 =====
  // 判定 mode 字段是否在当前模式下可见
  WB.modeMatches = function (m) { ... };
```

## 六、拆分原则（避免过度拆分 / 拆分不足）

- **拆分阈值**：单个文件超过 **700 行 / 30 KB** 时优先评估是否要拆
- **拆分目标**：50–500 行的文件便于人类阅读、AI 不需要一次性理解 1000+ 行上下文
- **不要拆分过细**：10 行的工具函数不必拆成单文件——会增加多文件门槛、commit 复杂度、加载顺序心智负担
- **按职责拆，不按行数拆**：职责清晰的小文件优先；为了凑行数拆反而模糊边界
- **新写代码也遵守**：新加代码时先判断属于哪个职责域，对应文件；如果都不属于，再判断是否需要新文件

## 七、跨文件共享与命名空间

所有 `wb-*.js` 共享单一命名空间 `window.WB = window.WB || {}`：

```javascript
// 任何文件首句
window.WB = window.WB || {};
WB.<key> = <value>;
```

**命名约定**：
- **配置 / 数据**（不可变、引用类型）：UPPER_SNAKE（如 `SYS_CARDS` / `CARD_ICONS` / `MODES`）
- **状态 / 函数**：camelCase（如 `buttons` / `refreshButtons` / `applyCardIcon` / `modeMatches`）
- **私有 helper**（不挂到 WB）：本文件 IIFE 内部的局部函数（小写驼峰）

**跨文件函数调用约定**：

```javascript
// 推荐：运行时查找（避免循环加载问题）
if (WB.renderGrid) WB.renderGrid();

// 禁止：在文件顶部缓存跨文件函数引用
// 错误示例：
//   const renderGrid = WB.renderGrid;   // 加载顺序不对时为 undefined
//   const fetchJSON = WB.fetchJSON;     // 同样
```

理由：wb-*.js 是同步 `<script>` 加载，**加载顺序固定但跨文件函数可能依赖未加载完的模块**。运行时查找（`if (WB.xxx)`）让函数延迟到被调用时才解析，自然兼容任何加载顺序。

## 八、客户端编码风格（workbench 适配版）

DSH 插件因为是 IIFE bundle + 老浏览器兼容，强制 ES5。本工作台是浏览器原生 `<script>` 加载，所有现代浏览器都支持 ES2015+，故保留现代语法：

| 允许                                                | 不允许                                  |
| --------------------------------------------------- | --------------------------------------- |
| `const X = ...` / `let X = ...`                     | `var X = ...`（除非 DSH 兼容场景）       |
| 箭头函数 `(a) => a + 1`                            | 仅 ES5 限制场景（参考 DSH § 三三）       |
| `async function` / `await`                          | 仅 ES5 限制场景                         |
| 模板字符串 `` `hello ${name}` ``                    | 仅 ES5 限制场景                         |
| `for...of` / `.forEach((x) => ...)`                | 仅 ES5 限制场景                         |
| `class Foo { method() {} }`                         | 仅 ES5 限制场景（本仓库不强约束）       |
| IIFE 包装 `(function () { 'use strict'; ... })();` | 必须（保持模块隔离，避免污染全局）      |
| `===` / `!==`                                       | `==` / `!=`                             |

**注释规范**：
- JSDoc：`/** 单行描述函数/方法做什么 */`，用在**文档化过的 public 函数**上
- 行内注释：`// <why>`（解释为什么，不解释 what；单字段后置 OK）

```javascript
/** 提交卡片推送（push）：调服务端 MCP 接口，成功后打开 DSH 页面。 */
async function runPush() { ... }

this.dirty = false;  // 单字段后置注释 OK
```

**DOM / 异步约定**（workbench 一致）：
- 仅用 vanilla DOM API：`document.createElement` / `appendChild` / `addEventListener` / `querySelector` / `dataset.xxx`
- 不引任何库（无 React / jQuery / shadcn）
- 异步统一用 `async function` + `await fetchJSON(...)`，**不用** Promise 链式（workbench 浏览器原生支持 async/await）
- 错误捕获：fetchJSON 已抛 Error；调用方用 try/catch + `reportClientError(msg)` 上报服务端

## 九、模块边界硬约束

- **不嵌套 require / import**：wb-*.js 之间**不**互相 import。所有共享通过 `window.WB.xxx`
- **不引入打包工具**：浏览器原生加载，无 webpack / vite / rollup / esbuild
- **不引第三方库**：保持 workbench 的零依赖原则（仅 Node 内置 + 原生 HTML/CSS/JS）
- **IIFE 必须 'use strict'**：避免 sloppy mode 陷阱

## 十、Commit message 规范（从 v1.2 起遵守）

采用 Conventional Commits 风格：

```
<type>(<scope>): <subject>

<body 可选>
```

| type     | 含义                              |
| -------- | --------------------------------- |
| feat     | 新功能                            |
| fix      | 修复                              |
| refactor | 重构（不改行为）                  |
| perf     | 性能                              |
| docs     | 文档                              |
| chore    | 杂项（构建 / 依赖 / 配置）       |
| style    | 纯样式调整（不影响逻辑）         |
| test     | 测试                              |

| scope                  | 含义                          |
| ---------------------- | ----------------------------- |
| workbench              | 项目级（多数 commit）         |
| wb-core / wb-mode / wb-state / wb-render / wb-action / wb-bookmarks / wb-drag / wb-search / wb-settings | 文件级 |
| HACKING.md / DEV.md / docs/ | 文档级 |
| server.js / buttons.json / tests/ | 模块级 |

subject 写法：
- 中文
- 简短（一般 ≤ 60 字符）
- 说明**什么 + 为什么 + 影响**
- 不以句号结尾

示例：
```
refactor(workbench): 拆分 app.js — 第四步 wb-render.js（所有渲染函数）
docs(workbench): 创建 maintainability.md（拆分规范与编码风格统一）
fix(workbench): bookmarks.json TDZ 修复 + 加载失败保护
feat(workbench): v1 系统卡 mode 选择（让滴答/余额/RSS 等 8 张 SYS_CARDS 也能配置模式）
chore(workbench): 加 .gitattributes 统一换行符为 LF
docs(workbench): HACKING.md §2 + DEV.md §8 记录前端拆分
```

## 十一、编辑流程

1. **改一个或多个 `public/wb-*.js`**（按职责选择目标文件；新代码见 § 六）
2. **改完后必测**（按 HACKING.md 末尾"维护流程"）：
   - `node tests/test-click.mjs`（无副作用回归测试）
   - 必要时跑 `tests/test-mode-tags.mjs` / `tests/test-mode.mjs` / `tests/test-syscard-mode.mjs`
3. **改 `server.js` 才需重启服务**；改 `public/*` Ctrl+F5 即可（旧标签页 ≤4 秒自愈）
4. **同步 onboarding 文档**：
   - 改了 § 三 文件地图？→ 同步 `HACKING.md §2`
   - 改了 § 五 拆分原则？→ 同步 `HACKING.md §2` + 本规范 § 六
   - 改了 § 七 命名约定？→ 同步本规范 § 三
5. **按 § 十 commit 规范写 message**

## 十二、新加 section / 新建文件

### 新加 section 到现有文件

1. 在目标 `wb-*.js` 中找合适位置（按职责相邻原则）
2. 加 section marker（§ 五）
3. 跑测试
4. commit（按 § 十）

### 新建 wb-*.js 文件

**仅当出现以下情况才新建**：
- 现有所有文件职责都不匹配（参见 § 三 命名表）
- 该职责代码量预计 > 100 行（强约束，避免过细拆分）

**新建流程**：
1. 决定文件名 `<role>`（参考 § 三 命名约定；新加前先确认不与现有职责重叠）
2. 创建 `public/wb-<role>.js`，顶部 banner 按 § 四模板，section 按 § 五模板
3. 在 `index.html` 的 `<script>` 加载顺序中**插入合适位置**（按依赖顺序：被依赖的在前）
4. 在 HACKING.md §2 文件地图加一行
5. 跑测试 + commit

## 十三、相关

- `F:\AllWorkSpace\workbench\HACKING.md` —— 工作台开发者 onboarding 入口（必读）
- `F:\AllWorkSpace\workbench\DEV.md` —— 完整参考手册（71KB）
- `E:\dsh-plugins\docs\maintainability.md` —— DSH 插件拆分规范（精神来源，但技术栈差异大）
- `F:\AllWorkSpace\AGENTS.md` —— 工作区元规则
- `F:\AllWorkSpace\DECISIONS.md` —— "代码里看不出的决策"日志
