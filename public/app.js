// 工作台前端逻辑：Bento 卡片墙渲染、轮询状态与日志、拖拽排序、执行按钮
(function () {
  'use strict';

  const grid = document.getElementById('buttons-grid');
  const logsList = document.getElementById('logs-list');
  const dot = document.getElementById('server-dot');
  const statusText = document.getElementById('server-status-text');
  const titleEl = document.getElementById('workbench-title');

  let buttons = [];
  let busy = {};
  let queueInfo = null;
  let balanceData = null;
  let bookmarks = [];
  let didaToday = null;
  let didaFocus = null;
  let minimaxData = null;  // MiniMax Token Plan 额度（/api/minimax-coding-plan）
  let rssData = null;      // RSS 信息卡数据（/api/rss）
  let feedsList = [];      // RSS 订阅源列表（设置面板管理，/api/feeds）
  let dshSessions = null;  // DSH 对话状态聚合（/api/dsh-sessions）：{ status: 'working'|'idle'|'offline'|'error', running, total, active }
  let searchQ = '';        // 顶栏搜索关键字（已小写；空 = 不过滤）
  // 模式配置：启动时 fetch /api/modes 拿 modes.json；失败回退内置默认（与 server.js DEFAULT_MODES 镜像）。
  // modes 配置是 {default, modes:[{id,name,icon,readonly,description}]}：
  //   - readonly = true  → 进入该模式时挂全局只读态（拖拽 / 改色 / 改尺寸 / 书签 / RSS 增删拖拽 全部拦截）
  //   - 加新模式 = 改 modes.json 一条，零代码改动（白名单校验 + 切换器动态渲染）
  let MODES = {
    default: 'work',
    modes: [
      { id: 'work', name: '工作', icon: '▣', readonly: true, description: '工作模式' },
      { id: 'entertainment', name: '娱乐', icon: '▶', readonly: false, description: '娱乐模式' },
    ],
  };
  let MODES_LOADED = false;             // 是否已从 /api/modes 拉取（防止首次渲染未拿到的竞态）
  let currentMode = 'work';             // 当前模式：用户态，从 localStorage `workbench-mode` 读；不影响服务端
  // 当前模式是否只读（派生自 currentMode 对应的 mode 定义）；每次切换模式时重算
  function isReadonlyMode() {
    const m = MODES.modes.find((x) => x.id === currentMode);
    return !!(m && m.readonly === true);
  }
  let workbenchOnline = false;

  // ---- 系统信息卡定义（内置，非 buttons.json 按钮） ----
  const SYS_CARDS = {
    'sys-balance':   { id: 'sys-balance',   name: 'DeepSeek 余额', size: 'small', kind: 'stat' },
    'sys-status':    { id: 'sys-status',    name: '系统状态',      size: 'small', kind: 'status' },
    'sys-dsh-sessions': { id: 'sys-dsh-sessions', name: 'DSH 对话', size: 'small', kind: 'dsh-sessions' },
    'sys-bookmarks': { id: 'sys-bookmarks', name: '书签',          size: 'small', kind: 'bookmarks' },
    'sys-dida-today':{ id: 'sys-dida-today', name: '滴答今日任务', size: 'large', kind: 'dida-today' },
    'sys-dida-focus':{ id: 'sys-dida-focus', name: '滴答专注',     size: 'small', kind: 'stat' },
    'sys-minimax':   { id: 'sys-minimax',   name: 'MiniMax 套餐',  size: 'wide',  kind: 'minimax' },
    'sys-rss':       { id: 'sys-rss',       name: 'RSS 订阅',      size: 'wide',  kind: 'rss' },
  };

  // 卡片顺序持久化（localStorage，仅本机浏览器）
  const ORDER_KEY = 'workbench-card-order';

  // ---- 卡片图标（Unicode 字符，随主题色显示，可用开关关闭） ----
  const CARD_ICONS = {
    dsh: '⚙',
    push: '▣',
    anki: 'A',
    sm18: 'S',
    'dida-inbox': '⇩',
    'dida-plan': '▦',
    'dida-weekly': '周',
    'sys-balance': '¥',
    'sys-status': '∿',
    'sys-bookmarks': '★',
    'sys-dida-today': '今',
    'sys-dida-focus': '⏱',
    'sys-dsh-sessions': '◉',
    'sys-minimax': 'Ⓜ',
    'sys-rss': '≡',
  };

  // ---- 卡片图标：按钮带 icon 字段（服务端检测 public/icons/<id>.ico 是否存在后返回）
  // 则显示软件自身图标 <img>，否则回退 CARD_ICONS 字符。 ----
  function applyCardIcon(iconEl, def) {
    if (!iconEl) return;
    const src = def && def.icon;
    if (src) {
      iconEl.textContent = '';
      let img = iconEl.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        iconEl.appendChild(img);
      }
      img.src = src;
    } else {
      iconEl.textContent = (def && CARD_ICONS[def.id]) || '';
    }
  }

  // ---- 数字滚动动画（ease-out cubic，600ms） ----
  function animateValue(el, from, to, fmt, duration = 600) {
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setNum(el, to, animate, fmt) {
    const prev = el._last;
    el._last = to;
    if (animate && typeof prev === 'number' && prev !== to) {
      animateValue(el, prev, to, fmt);
    } else {
      el.textContent = fmt(to);
    }
  }

  // ---- DeepSeek 峰谷定价：高峰 9-12 / 14-18（北京时间），其余空闲半价 ----
  function isPeakHour(d) {
    const h = d.getHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  }

  // 下一个高峰开始时间（今天 9:00 / 14:00；都过了则明天 9:00）
  function nextPeakStart(now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const at = (hh) => { const t = new Date(today); t.setHours(hh, 0, 0, 0); return t; };
    for (const s of [at(9), at(14)]) if (s > now) return s;
    const t = at(9);
    t.setDate(t.getDate() + 1);
    return t;
  }

  function updateRateBadge() {
    const el = document.getElementById('rate-badge');
    if (!el) return;
    const now = new Date();
    if (isPeakHour(now)) {
      const endH = now.getHours() < 12 ? 12 : 18;
      const end = new Date(now);
      end.setHours(endH, 0, 0, 0);
      const remMin = Math.max(0, Math.round((end - now) / 60000));
      const rh = Math.floor(remMin / 60);
      const rm = remMin % 60;
      el.textContent = '高峰价 · 剩余 ' + (rh > 0 ? rh + ' 小时 ' : '') + rm + ' 分';
      el.className = 'rate-badge peak';
      el.title = '高峰时段 9-12 / 14-18（北京时间），费用为半价时段 2 倍';
    } else {
      const next = nextPeakStart(now);
      const remMin = Math.ceil((next - now) / 60000);
      if (remMin <= 10) {
        // 高峰前 10 分钟提醒
        const hh = next.getHours();
        const atStr = (hh < 12 ? '上午 ' + hh : '下午 ' + (hh - 12)) + ' 点';
        el.textContent = '即将高峰 · ' + remMin + ' 分钟后';
        el.className = 'rate-badge soon';
        el.title = '高峰将于 ' + atStr + ' 开始（9-12 / 14-18 北京时间），费用翻倍';
      } else {
        el.textContent = '空闲价 · 半价';
        el.className = 'rate-badge idle';
        el.title = '空闲时段半价；高峰 9-12 / 14-18（北京时间）';
      }
    }
  }

  // ---- 数据获取 ----
  async function fetchJSON(url, options) {
    const r = await fetch(url, options);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ---- 客户端错误上报（排查"点了没反应"：页面 JS 错误实时发到服务端日志） ----
  function reportClientError(msg) {
    try {
      fetch('/api/log-client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: String(msg).slice(0, 500) }),
      }).catch(() => {});
    } catch (e) { /* 忽略 */ }
  }
  window.addEventListener('error', (e) => {
    reportClientError((e.message || '未知错误') + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportClientError('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });

  // ---- 顺序管理 ----
  function defaultOrder() {
    const func = buttons.map(b => b.id);
    return [...func, 'sys-balance', 'sys-status', 'sys-dsh-sessions', 'sys-bookmarks', 'sys-dida-today', 'sys-dida-focus', 'sys-minimax', 'sys-rss'];
  }

  function getOrder() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(ORDER_KEY)); } catch (e) { saved = null; }
    const base = defaultOrder();
    if (!Array.isArray(saved)) return base;
    const known = new Set(base);
    const merged = saved.filter(id => known.has(id));
    for (const id of base) if (!merged.includes(id)) merged.push(id);
    return merged;
  }

  function setOrder(order) {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch (e) { /* 忽略 */ }
  }

  // ---- 模式匹配：按钮 / 系统卡 / 书签 / RSS 订阅源 的 mode 字段判定是否在当前模式下可见 ----
  // mode 字段语义（与 server.js normalizeModeField 保持一致）：
  //   undefined / null                → 全部模式可见（默认；与 buttons.json 旧字段缺失行为一致）
  //   'work' / 'entertainment' / 自定义模式 id（modes.json 定义） → 仅该模式可见
  //   ['work','entertainment']        → 与不写等价（少见，显式声明）
  //   '__hidden__'                     → 所有模式都不可见（v0.8 新增；用户在 UI 上点"隐藏"按钮）
  // 校验：未知模式 id 在白名单外视为 null（防止 modes.json 改名后旧数据卡死）
  function modeMatches(m) {
    if (m === '__hidden__') return false;  // v0.8：hidden sentinel 永远不匹配（任何模式都不显示）
    if (m == null) return true;
    // 启动早期 / 网络失败 MODES_LOADED=false 时仍能匹配内置两个白名单（向后兼容）
    const knownIds = MODES_LOADED ? MODES.modes.map((x) => x.id) : ['work', 'entertainment'];
    if (Array.isArray(m)) {
      // 数组中任一已知模式 === 当前模式即匹配（与 modes.json 同步白名单）
      const valid = m.filter((x) => knownIds.includes(x));
      return valid.includes(currentMode);
    }
    if (typeof m === 'string' && knownIds.includes(m)) return m === currentMode;
    // 未知模式 id 视为 null（兜底：modes.json 改名后旧数据不卡死）
    return true;
  }

  // ---- 卡片尺寸 ----
  function spanClass(size) {
    if (size === 'large') return 'span-large';
    if (size === 'small') return 'span-small';
    return 'span-wide';
  }

  // ---- 顶栏快速搜索 + 模式过滤：书签同时受搜索词与当前模式约束 ----
  // mode 字段语义与按钮一致：null/缺失 = 全部模式可见；modeMatches(bm.mode) 判定当前模式可见性
  function bmMatches(bm) {
    if (!modeMatches(bm.mode)) return false;   // 模式不匹配则直接出局
    if (!searchQ) return true;
    return (bm.name || '').toLowerCase().includes(searchQ) || (bm.url || '').toLowerCase().includes(searchQ);
  }

  function cardMatchesSearch(id) {
    if (SYS_CARDS[id]) {
      // 模式过滤：当前模式下的卡才参与搜索
      if (!modeMatches(SYS_CARDS[id].mode)) return false;
      if ((SYS_CARDS[id].name || '').toLowerCase().includes(searchQ)) return true;
      // 书签卡：任一书签名/网址命中即保留（卡内只显示命中的书签）
      if (id === 'sys-bookmarks') return bookmarks.some(bmMatches);
      return false;
    }
    const b = buttons.find(x => x.id === id);
    if (!b) return false;
    // 模式过滤：当前模式下的按钮才参与搜索
    if (!modeMatches(b.mode)) return false;
    return (b.name || '').toLowerCase().includes(searchQ)
      || (b.description || '').toLowerCase().includes(searchQ)
      || (b.id || '').toLowerCase().includes(searchQ);
  }

  // 回车：执行顺序中第一个匹配（功能卡 = 点击执行；书签卡 = 打开第一本命中的书签）
  function runFirstSearchMatch() {
    if (!searchQ) return;
    for (const id of getOrder()) {
      if (!cardMatchesSearch(id)) continue;
      if (SYS_CARDS[id]) {
        if (id === 'sys-bookmarks') {
          const bm = bookmarks.find(bmMatches);
          if (bm) openExternal(bm.url);
        }
        continue; // 其余信息卡没有"执行"语义
      }
      const b = buttons.find(x => x.id === id);
      if (b && b.visible !== false) { runButton(b); return; }
    }
  }

  // ---- keyed 渲染：卡片缓存（轮询刷新复用 DOM，不打断拖拽） ----
  const cardCache = new Map(); // id -> { el, refs, current }
  let dragActive = false;

  function ensureFuncCard(id, size) {
    const hit = cardCache.get(id);
    if (hit) return hit;
    const el = document.createElement('div');
    el.className = 'card ' + spanClass(size);
    el.dataset.id = id;
    // readonly 模式（modes.json 中该模式 readonly=true）不渲染拖拽手柄——卡片不可拖动换位
    const dragHint = isReadonlyMode() ? '' : '<span class="drag-hint" title="按住拖动换位">⠿</span>';
    el.innerHTML =
      '<div class="card-head"><h3><span class="card-icon"></span><span class="card-title"></span></h3><span class="badge"></span></div>' +
      dragHint +
      '<button type="button" class="run-btn"></button>';
    const refs = {
      el,
      h3: el.querySelector('h3'),
      icon: el.querySelector('.card-icon'),
      title: el.querySelector('.card-title'),
      badge: el.querySelector('.badge'),
      btn: el.querySelector('.run-btn'),
      queue: null, // Push 卡：队列数量行（队列信息已并入 push 卡）
      last: null,
    };
    // 铁律：rec 必须先于监听器声明——点击回调只认 rec.current（与 renderFuncCard 的赋值
    // 共用同一属性，单一真源）。曾因监听器读 refs.current、渲染写 rec.current 导致
    // 属性永不赋值、点击静默失效（"点了没反应"），严禁再引入第二个 current 属性。
    const rec = { el, refs, current: null };
    refs.btn.addEventListener('click', () => {
      if (rec.current) runButton(rec.current);
    });
    // 执行入口只有 run-btn 按钮：卡片标题/空白处点击不触发执行（用户明确要求
    // "只有按到按钮才启动"，整卡可点范围太宽已移除）。拖拽仍只从 ⠿ 手柄触发。
    cardCache.set(id, rec);
    return rec;
  }

  function ensureSystemCard(id) {
    const hit = cardCache.get(id);
    if (hit) return hit;
    const def = SYS_CARDS[id];
    const el = document.createElement('div');
    // readonly 模式不渲染拖拽手柄（与 ensureFuncCard 同款）
    const dragHint = isReadonlyMode() ? '' : '<span class="drag-hint" title="按住拖动换位">⠿</span>';
    el.className = 'card stat-card ' + spanClass(def.size);
    el.dataset.id = id;
    const refs = { el };
    if (id === 'sys-balance') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>DeepSeek 余额</h3></div>' +
        dragHint +
        '<div class="stat-value">查询中...</div>';
      refs.value = el.querySelector('.stat-value');
      bindCardClick(el, () => openExternal('https://platform.deepseek.com/usage'));
    } else if (id === 'sys-status') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>系统状态</h3></div>' +
        dragHint +
        '<div class="status-list">' +
        '  <div class="status-row"><span class="row-dot"></span><span class="row-label">DeepSeek Harness</span><span class="row-value">查询中</span></div>' +
        '  <div class="status-row"><span class="row-dot"></span><span class="row-label">工作台服务</span><span class="row-value">查询中</span></div>' +
        '</div>';
      refs.rows = el.querySelectorAll('.status-row');
    } else if (id === 'sys-dsh-sessions') {
      // DSH 对话状态卡（v0.5.2 极简收口：仅 working 渲染圆点 + meta，其它状态整段 .dsh-status 隐藏）
      // 仅 working 圆点+文字可见；idle / offline / error / loading 时卡片塌缩到只剩标题"DSH 对话"作为静态标识符
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>DSH 对话</h3></div>' +
        dragHint +
        '<div class="dsh-status">' +
          '<div class="dsh-dots"></div>' +
          '<div class="dsh-meta">—</div>' +
        '</div>';
      refs.status = el.querySelector('.dsh-status');
      refs.dots = el.querySelector('.dsh-dots');
      refs.meta = el.querySelector('.dsh-meta');
      // 点击卡片 → 跳 DSH 3080（如果 DSH 在线；离线态 toast 警示）
      bindCardClick(el, () => {
        if (!dshSessions || dshSessions.status === 'offline' || dshSessions.status === 'error') {
          showToast('DSH 当前离线，无法跳转', 'warn');
        } else {
          openExternal('http://127.0.0.1:3080/');
        }
      });
    } else if (id === 'sys-bookmarks') {
      // readonly 模式不渲染卡片内的 + 添加按钮（add bookmark 由 CSS 兜底隐藏）
      const addBtn = isReadonlyMode() ? '' : '<button class="add-btn" id="card-add-bookmark" title="添加书签">+</button>';
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>书签</h3>' +
        addBtn + '</div>' +
        dragHint +
        '<ul class="bm-card-list"></ul>';
      refs.list = el.querySelector('.bm-card-list');
      const cardAdd = el.querySelector('#card-add-bookmark');
      if (cardAdd) cardAdd.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal();
      });
    } else if (id === 'sys-dida-today') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>滴答今日任务</h3></div>' +
        dragHint +
        '<div class="dida-task-list"></div>';
      refs.list = el.querySelector('.dida-task-list');
    } else if (id === 'sys-dida-focus') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>滴答专注</h3></div>' +
        dragHint +
        '<div class="stat-value">—</div>';
      refs.value = el.querySelector('.stat-value');
      // 点击卡片 → 跳转滴答清单应用（优先桌面客户端：未运行则启动、已运行则置顶；
      // 快捷方式按钮不存在时回退滴答网页）。与余额卡"点击跳转"交互一致。
      bindCardClick(el, () => {
        const app = buttons.find(x => x.id === 'app') || buttons.find(x => x.name === '滴答清单');
        if (app) runButton(app);
        else openExternal('https://www.dida365.com/webapp/');
      });
    } else if (id === 'sys-minimax') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>MiniMax 套餐</h3></div>' +
        dragHint +
        '<div class="mmx-body">' +
          '<div class="mmx-row" data-window="5h">' +
            '<div class="mmx-label">5 小时</div>' +
            '<div class="mmx-bar"><div class="mmx-bar-fill"></div></div>' +
            '<div class="mmx-pct">—</div>' +
            '<div class="mmx-sub">—</div>' +
          '</div>' +
          '<div class="mmx-row" data-window="week">' +
            '<div class="mmx-label">周限额</div>' +
            '<div class="mmx-bar"><div class="mmx-bar-fill"></div></div>' +
            '<div class="mmx-pct">—</div>' +
            '<div class="mmx-sub">—</div>' +
          '</div>' +
          '<div class="mmx-meta"></div>' +
          '<div class="mmx-alert" style="display:none"></div>' +
        '</div>';
      refs.rows = {
        '5h':  {
          row: el.querySelector('.mmx-row[data-window="5h"]'),
          fill: el.querySelector('.mmx-row[data-window="5h"]   .mmx-bar-fill'),
          pct: el.querySelector('.mmx-row[data-window="5h"]   .mmx-pct'),
          sub: el.querySelector('.mmx-row[data-window="5h"]   .mmx-sub'),
        },
        week: {
          row: el.querySelector('.mmx-row[data-window="week"]'),
          fill: el.querySelector('.mmx-row[data-window="week"] .mmx-bar-fill'),
          pct: el.querySelector('.mmx-row[data-window="week"] .mmx-pct'),
          sub: el.querySelector('.mmx-row[data-window="week"] .mmx-sub'),
        },
      };
      refs.meta = el.querySelector('.mmx-meta');
      refs.alert = el.querySelector('.mmx-alert');
      refs.value = el.querySelector('.stat-value'); // 错误态用
      bindCardClick(el, () => openExternal('https://platform.minimaxi.com/console/personal-info'));
    } else if (id === 'sys-rss') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>RSS 订阅</h3></div>' +
        dragHint +
        '<div class="rss-list"></div>';
      refs.list = el.querySelector('.rss-list');
    }
    applyCardIcon(el.querySelector('.card-icon'), { id });
    const rec = { el, refs, current: null };
    cardCache.set(id, rec);
    return rec;
  }

  // ---- 渲染功能卡内容 ----
  function renderFuncCard(b) {
    const rec = ensureFuncCard(b.id, b.size);
    const { el, refs } = rec;
    // 尺寸可能被修改（设置面板改宽/窄）：keyed 缓存复用 DOM，必须每次重设 span 类，
    // 否则改尺寸后卡片宽度不变（曾因此"宽窄没用"）。
    // 快捷方式启动卡（带 command 的普通按钮）标记 shortcut-card：方形紧凑布局
    const isShortcut = !!(b.command && !b.toggle && !b.kind);
    el.className = 'card ' + spanClass(b.size) + (isShortcut ? ' shortcut-card' : '');
    // 唯一真源：点击监听器（ensureFuncCard）与这里都只认 rec.current，
    // 不要另设 refs.current——曾因读写属性不一致导致点击静默失效。
    rec.current = b;
    applyCardIcon(refs.icon, b);

    refs.title.textContent = b.name;

    let badgeText = '无状态';
    let badgeCls = '';
    if (b.kind === 'push') {
      if (b.lastPush) {
        badgeText = b.lastPush.active ? '活跃 · ' + b.lastPush.text : b.lastPush.text;
        if (b.lastPush.active) badgeCls = 'on';
      } else {
        badgeText = '从未 push';
      }
    } else if (b.kind === 'dida') {
      // 可见 = 已到显示时间且（每天/本周）还没点过；weekly 按钮徽章按周期显示
      badgeText = b.weekly ? '本周待办' : '今日待办';
      badgeCls = 'on';
    } else if (b.running === true) {
      badgeText = '运行中';
      badgeCls = 'on';
    } else if (b.running === false) {
      badgeText = '已停止';
      badgeCls = 'off';
    }
    refs.badge.textContent = badgeText;
    refs.badge.className = 'badge' + (badgeCls ? ' ' + badgeCls : '');

    // push 卡片：队列数量（原独立「Anki 队列」卡已并入）+「上次 push」行 + 高峰提醒
    if (b.kind === 'push') {
      // 队列数量行：待推送 / 共 N 条（有待推送时高亮 .hot，文件缺失/读取失败置灰 .off）
      if (!refs.queue) {
        refs.queue = document.createElement('p');
        refs.queue.className = 'queue-line';
        el.insertBefore(refs.queue, refs.btn);
      }
      if (!queueInfo) {
        refs.queue.textContent = '队列读取中...';
        refs.queue.className = 'queue-line';
      } else if (!queueInfo.exists) {
        refs.queue.textContent = '队列文件不存在';
        refs.queue.className = 'queue-line off';
      } else if (queueInfo.error) {
        refs.queue.textContent = queueInfo.error;
        refs.queue.className = 'queue-line off';
      } else {
        const pending = queueInfo.pending;
        refs.queue.textContent = '队列: 待推送 ' + pending + ' / 共 ' + queueInfo.total + ' 条';
        refs.queue.className = 'queue-line' + (pending > 0 ? ' hot' : '');
      }
      if (!refs.last) {
        refs.last = document.createElement('p');
        refs.last.className = 'last-push-line';
        refs.last.id = 'last-push-line';
        el.insertBefore(refs.last, refs.btn);
      }
      refs.last.textContent = b.lastPush ? '上次 push: ' + b.lastPush.text : '';
      // 高峰时段提醒（费用翻倍）
      if (isPeakHour(new Date())) {
        if (!refs.note) {
          refs.note = document.createElement('p');
          refs.note.className = 'rate-note';
          refs.note.textContent = '当前高峰价时段（9-12 / 14-18），费用为半价时段 2 倍';
          el.insertBefore(refs.note, refs.btn);
        }
      } else if (refs.note) {
        refs.note.remove();
        refs.note = null;
      }
    } else {
      if (refs.queue) { refs.queue.remove(); refs.queue = null; }
      if (refs.last) { refs.last.remove(); refs.last = null; }
      if (refs.note) { refs.note.remove(); refs.note = null; }
    }

    // 按钮
    let label = '执行';
    let disabled = !!busy[b.id];
    if (b.toggle) {
      label = b.action.label;
    } else if (b.kind === 'push') {
      if (busy[b.id]) {
        label = '执行中...';
      } else if (b.locked) {
        label = '锁定中 · 剩余 ' + b.lockedMinutes + ' 分钟';
        disabled = true;
      } else {
        label = 'Push';
      }
    } else if (busy[b.id]) {
      label = '执行中...';
    }
    refs.btn.textContent = label;
    refs.btn.style.background = b.toggle
      ? (b.action.color || 'var(--accent-deep)')
      : (b.color || 'var(--accent-deep)');
    refs.btn.disabled = disabled;
    // 执行中给按钮加 busy 类，触发 CSS 脉冲动画（"按下后动起来"的执行反馈）
    refs.btn.classList.toggle('busy', !!busy[b.id]);
  }

  // ---- 渲染系统卡内容 ----
  function renderSystemCard(id) {
    const rec = ensureSystemCard(id);
    const { refs } = rec;
    const countupOn = (document.body.dataset.countup || 'on') === 'on';
    if (id === 'sys-balance') {
      if (!balanceData) return;
      if (!balanceData.ok) {
        refs.value.className = 'stat-value err';
        refs.value.textContent = '获取失败';
        refs.value.title = balanceData.error || '';
        return;
      }
      refs.value.title = '';
      const total = balanceData.total;
      if (total < 1) {
        refs.value.className = 'stat-value err';
        refs.value.textContent = '余额不足';
      } else {
        refs.value.className = 'stat-value';
        setNum(refs.value, total, countupOn, v => '¥' + v.toFixed(2));
      }
    } else if (id === 'sys-status') {
      const dsh = buttons.find(b => b.port === 3080);
      const rows = [
        {
          dotCls: dsh ? (dsh.running ? 'ok' : 'off') : 'off',
          label: 'DeepSeek Harness',
          value: dsh ? (dsh.running ? '运行中' : '已停止') : '未知',
        },
        {
          dotCls: workbenchOnline ? 'ok' : 'off',
          label: '工作台服务',
          value: workbenchOnline ? '在线' : '离线',
        },
      ];
      refs.rows.forEach((row, i) => {
        const r = rows[i];
        if (!r) return;
        row.querySelector('.row-dot').className = 'row-dot ' + r.dotCls;
        row.querySelector('.row-value').textContent = r.value;
      });
    } else if (id === 'sys-bookmarks') {
      refs.list.innerHTML = '';
      // 卡片墙：mode 优先过滤，搜索词叠加（与侧栏同款语义；6 条上限）
      const modeFiltered = bookmarks.filter((bm) => modeMatches(bm.mode));
      const shown = searchQ ? modeFiltered.filter(bmMatches) : modeFiltered;
      if (!shown.length) {
        const li = document.createElement('li');
        li.className = 'bm-card-empty';
        li.textContent = searchQ ? '没有匹配的书签' : (modeFiltered.length === 0 && bookmarks.length > 0 ? '当前模式下没有书签' : '暂无书签，点侧栏 + 添加');
        refs.list.appendChild(li);
        return;
      }
      shown.slice(0, 6).forEach(bm => {
        // 卡片墙版本：<a> 链接 + ✎ 编辑按钮（hover 显示；工作模式编辑按钮隐藏）
        const item = document.createElement('span');
        item.className = 'bm-item';
        item.dataset.bmId = bm.id;
        const a = document.createElement('a');
        a.className = 'bm-name';
        a.href = bm.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.draggable = false;
        const fav = faviconImg(bm.url);
        if (fav) a.appendChild(fav);
        a.appendChild(document.createTextNode(bm.name));
        a.title = bm.url;
        item.appendChild(a);
        // 编辑按钮：娱乐模式才渲染，复用 openModal(bm.id)
        if (!isReadonlyMode()) {
          const edit = document.createElement('button');
          edit.type = 'button';
          edit.className = 'bm-edit-inline bm-remove';
          edit.textContent = '✎';
          edit.title = '编辑（修改名称 / 网址 / 显示模式）';
          edit.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            openModal(bm.id);
          });
          item.appendChild(edit);
        }
        refs.list.appendChild(item);
      });
    } else if (id === 'sys-dida-today') {
      // grid 布局：今日任务卡限高（每列少显示几条），避免大卡把同行的其他卡拉长
      const layout = document.body.dataset.layout || 'grid';
      // 展开 → 突破 max-height，显示全部任务（两列联动，瀑布流自动重新计算高度）
      rec.el.classList.toggle('expanded', didaTodayExpanded);
      renderDidaTodayList(refs.list, layout === 'grid' ? 5 : 8);
    } else if (id === 'sys-dida-focus') {
      renderDidaFocus(refs.value);
    } else if (id === 'sys-dsh-sessions') {
      renderDshSessionsCard(refs);
    } else if (id === 'sys-minimax') {
      renderMiniMaxCard(refs);
    } else if (id === 'sys-rss') {
      renderRssList(refs.list);
    }
  }

  // ---- MiniMax 套餐渲染：5h / 周窗口进度条 + 警示 ----
  // 警示规则（D009 + 2026-08-16 修订）：
  //   - 5h 剩余 < 15%：行加 .danger（标签/百分比/进度条变红）。无 alert、无红框
  //     —— 进度条本身变红已足够表达"快耗尽"，红框与额外文字过于抢眼
  //   - dailyPace > 3：周 row 加 .danger（无红框）+ 5h row 加 .warn + alert 文案
  //     "周限额非常充裕..."（保留信息密度，视觉强度与 5h 统一）
  //   - dailyPace > 2：周 row 加 .warn, .warn-strong（琥珀脉冲）+ alert 文案
  //   - dailyPace > 1.5：周 row 加 .warn（弱高亮）
  //   - 其他：正常
  //   - meta 行整行隐藏：modelName 永远是 "general"（MiniMax API 固定返回，无区分度），
  //     pace 节奏"需 X 个 5h/d 才不浪费周"孤立无上下文、用户反馈没说清楚。保留 DOM 节点
  function formatResetAt(epochSec) {
    if (!epochSec) return '';
    const d = new Date(epochSec * 1000);
    const today = new Date();
    const isSameDay = d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth()
      && d.getDate() === today.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (isSameDay) return '重置 ' + hh + ':' + mm;
    const dayDelta = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (dayDelta === 1) return '明日 ' + hh + ':' + mm + ' 重置';
    if (dayDelta > 1) return dayDelta + ' 天后重置';
    return '已重置';
  }
  function renderMiniMaxCard(refs) {
    if (!minimaxData) {
      refs.rows['5h'].pct.textContent = '读取中...';
      refs.rows.week.pct.textContent = '';
      refs.meta.textContent = '';
      return;
    }
    if (!minimaxData.ok) {
      refs.rows['5h'].pct.textContent = '—';
      refs.rows.week.pct.textContent = '—';
      refs.alert.style.display = 'block';
      refs.alert.className = 'mmx-alert err';
      refs.alert.textContent = '获取失败：' + (minimaxData.error || '未知');
      refs.alert.title = minimaxData.error || '';
      refs.meta.textContent = '';
      return;
    }
    const windows = minimaxData.windows || {};
    const w5h = windows['5h'];
    const wweek = windows.week;
    const now = Date.now();

    // 5h 窗口
    if (w5h && w5h.remainingPct != null) {
      const pct5 = w5h.remainingPct;
      refs.rows['5h'].fill.style.width = pct5.toFixed(1) + '%';
      refs.rows['5h'].pct.textContent = pct5.toFixed(0) + '% 剩';
      const resetText5h = formatResetIn(w5h.resetAt, now);
      refs.rows['5h'].sub.textContent = resetText5h;
      refs.rows['5h'].row.title = '5 小时窗口 · 剩余 ' + pct5.toFixed(1) + '% · ' + resetText5h;
    } else {
      refs.rows['5h'].fill.style.width = '0%';
      refs.rows['5h'].pct.textContent = '—';
      refs.rows['5h'].sub.textContent = '';
      refs.rows['5h'].row.title = '';
    }
    // 周窗口
    if (wweek && wweek.remainingPct != null) {
      const pctW = wweek.remainingPct;
      refs.rows.week.fill.style.width = pctW.toFixed(1) + '%';
      refs.rows.week.pct.textContent = pctW.toFixed(0) + '% 剩';
      const resetTextWeek = formatResetIn(wweek.resetAt, now);
      refs.rows.week.sub.textContent = resetTextWeek;
      refs.rows.week.row.title = '周限额 · 剩余 ' + pctW.toFixed(1) + '% · ' + resetTextWeek;
    } else {
      refs.rows.week.fill.style.width = '0%';
      refs.rows.week.pct.textContent = '—';
      refs.rows.week.sub.textContent = '';
      refs.rows.week.row.title = '';
    }

    // 警示判断（核心逻辑：D009）
    //   ratio = 周限额相当于多少个 5h 限额（默认 10，按用户描述；可在 config.json 的
    //   minimaxWeeklyHourlyRatio 覆盖）。weeklyRemainingInHours = pW × ratio 即"周剩余相当于
    //   多少个 5h 限额"；daysToReset = 距周重置的天数；dailyPaceNeeded = weeklyRemainingInHours /
    //   daysToReset —— 即"按当前周剩余量，平均每天需要用几个 5h 限额才不会浪费周限额"。
    //   - dailyPaceNeeded > 3：高级警示 .danger（红）："每天 3 个 5h 都不够消耗周限额"
    //   - dailyPaceNeeded > 2：中级警示 .warn（琥珀）："每天需用 2 个 5h 才能不浪费周"
    //   - 否则正常（仍显示 dailyPaceNeeded，让用户掌握节奏）
    const ratio = (minimaxData && minimaxData.weeklyHourlyRatio) || 10;
    const pct5h = w5h ? w5h.remainingPct : null;
    const pctW  = wweek ? wweek.remainingPct : null;
    refs.rows['5h'].row.classList.remove('warn', 'danger', 'warn-strong');
    refs.rows.week.row.classList.remove('warn', 'danger', 'warn-strong');
    refs.alert.style.display = 'none';
    refs.alert.className = 'mmx-alert';
    refs.alert.textContent = '';
    refs.alert.title = '';

    let dailyPace = null;
    let daysToReset = null;
    if (pctW != null && wweek && wweek.resetAt) {
      const ms = wweek.resetAt * 1000 - now;
      daysToReset = Math.max(0.1, ms / 86400000);
      const weeklyRemainingInHours = (pctW / 100) * ratio;
      dailyPace = weeklyRemainingInHours / daysToReset;
    }

    // meta 行整行隐藏（2026-08-16）：DOM 保留便于未来恢复
    refs.meta.style.display = 'none';

    let alertKind = null;
    let alertMsg = '';
    // 优先级 1：5h 限额快耗尽——仅行高亮，无 alert、无红框（2026-08-16）
    if (pct5h != null && pct5h < 15) {
      refs.rows['5h'].row.classList.add('danger');
    } else if (dailyPace != null && dailyPace > 3) {
      // 优先级 2：周限额非常充裕（高级警示·红）—— 保留 alert，去掉红框（2026-08-16）
      alertKind = 'danger';
      alertMsg = '周限额非常充裕：按当前剩余，每天需用 ' + dailyPace.toFixed(1) + ' 个 5h 限额（3 个都不够）。现在应高强度使用 5h 窗口，否则周限额必浪费';
      refs.rows.week.row.classList.add('danger');
      refs.rows['5h'].row.classList.add('warn');
    } else if (dailyPace != null && dailyPace > 2) {
      // 优先级 3：周限额在浪费（中级警示·琥珀）
      alertKind = 'warn';
      alertMsg = '周限额在浪费：按当前剩余，每天需用 ' + dailyPace.toFixed(1) + ' 个 5h 限额才不浪费。建议接下来 5h 窗口都用满';
      refs.rows.week.row.classList.add('warn', 'warn-strong');
    } else if (dailyPace != null && dailyPace > 1.5) {
      // 接近 2 倍但未到，提供参考但不强警告
      refs.rows.week.row.classList.add('warn');
    }
    if (alertMsg) {
      refs.alert.style.display = 'block';
      refs.alert.classList.add(alertKind === 'danger' ? 'err' : 'warn');
      refs.alert.textContent = alertMsg;
      refs.alert.title = alertMsg;
    }
    // 正常态不再写入 pace 节奏（meta 行整体 display:none；2026-08-16）
  }

  // 重置时间显示：「3h2m」「2天 5h」
  function formatResetIn(epochSec, now) {
    if (!epochSec) return '';
    const ms = epochSec * 1000 - now;
    if (ms <= 0) return '已重置';
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const rh = Math.floor((mins % 1440) / 60);
    const rm = mins % 60;
    if (days >= 1) {
      return days + '天' + (rh > 0 ? rh + 'h' : '') + '后';
    }
    if (mins >= 60) {
      return Math.floor(mins / 60) + 'h' + (rm > 0 ? rm + 'm' : '') + '后';
    }
    return mins + 'm 后';
  }

  // ---- 滴答今日任务列表渲染（小组件样式：全天 / 定时 两列，各带时间 + 优先级色点 + 标签） ----
  // maxShow：每列最多显示条数（grid 布局传 5 限高，split/list 传 8 显示更多）
  // didaTodayExpanded：整体展开状态（点击任一列「还有 N 项」两列联动展开/收起；页面刷新恢复折叠）
  let didaTodayExpanded = false;
  function renderDidaTodayList(listEl, maxShow) {
    listEl.innerHTML = '';
    if (!didaToday) {
      const li = document.createElement('li');
      li.className = 'bm-card-empty';
      li.textContent = '读取中...';
      listEl.appendChild(li);
      return;
    }
    if (!didaToday.ok) {
      const li = document.createElement('li');
      li.className = 'bm-card-empty';
      li.textContent = '获取失败: ' + (didaToday.error || '未知错误');
      listEl.appendChild(li);
      return;
    }
    if (!didaToday.count) {
      const li = document.createElement('li');
      li.className = 'bm-card-empty';
      li.textContent = '今日没有任务';
      listEl.appendChild(li);
      return;
    }
    const allDayTasks = didaToday.tasks.filter(t => t.allDay);
    const timedTasks = didaToday.tasks.filter(t => !t.allDay);
    const MAX_SHOW = maxShow || 8; // 每列默认显示条数

    const taskItem = (t) => {
      const li = document.createElement('li');
      li.className = 'dida-task-item';
      li.title = (t.tags && t.tags.length ? t.tags.join(' · ') + ' · ' : '') + '点击标记为已完成';
      // 优先级色点：5 高 / 3 中 / 1 低 / 0 无
      const dot = document.createElement('span');
      dot.className = 'dida-task-pri' + (t.priority ? ' p' + t.priority : ' p0');
      li.appendChild(dot);
      if (t.time) {
        const tm = document.createElement('span');
        tm.className = 'dida-task-time';
        tm.textContent = t.time;
        li.appendChild(tm);
      }
      const tx = document.createElement('span');
      tx.className = 'dida-task-title';
      tx.textContent = t.title;
      li.appendChild(tx);
      // 点击任务项 → 标记为已完成（仅当有 projectId 可完成；请求中防重复点击）
      li.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (li.classList.contains('completing')) return;
        li.classList.add('completing');
        completeTask(t);
      });
      return li;
    };
    // 单列：组标题 + 任务列表 + 超出提示（折叠时每列各自显示「还有 N 项 ▼」，点击展开全部）
    // opts.nowLine：定时列专用——按当前时刻把任务切成「已过（线上）」/「未到（线下）」两段，
    // 中间插一条细线表示"现在"（线以上 = 本应在当前时刻之前完成的任务，线以下 = 还没到）
    const renderColumn = (tasks, title, opts) => {
      if (!tasks.length) return;
      const withLine = !!(opts && opts.nowLine);
      const col = document.createElement('div');
      col.className = 'dida-task-col';
      const h = document.createElement('div');
      h.className = 'dida-group-title';
      h.textContent = title;
      col.appendChild(h);

      // 分段：定时列 = [已过任务][现在线][未到任务]，其余列整体一段
      let hidden = 0;
      let segments;
      if (withLine) {
        const now = new Date();
        const nowStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        const past = tasks.filter(t => t.time && t.time <= nowStr);
        const future = tasks.filter(t => !t.time || t.time > nowStr);
        segments = [{ tasks: past }, { now: nowStr }, { tasks: future }];
        if (!didaTodayExpanded) {
          hidden = Math.max(0, past.length - MAX_SHOW) + Math.max(0, future.length - MAX_SHOW);
        }
      } else {
        segments = [{ tasks }];
        if (!didaTodayExpanded && tasks.length > MAX_SHOW) hidden = tasks.length - MAX_SHOW;
      }

      for (const seg of segments) {
        if (seg.now !== undefined) {
          const line = document.createElement('div');
          line.className = 'dida-now-line';
          line.textContent = '现在 ' + seg.now;
          col.appendChild(line);
          continue;
        }
        const ul = document.createElement('ul');
        ul.className = 'dida-task-sublist';
        (didaTodayExpanded ? seg.tasks : seg.tasks.slice(0, MAX_SHOW)).forEach(t => ul.appendChild(taskItem(t)));
        col.appendChild(ul);
      }

      // 折叠时才显示各列的「还有 N 项」；展开时由卡片底部统一的「收起」负责
      if (!didaTodayExpanded && hidden > 0) {
        const more = document.createElement('div');
        more.className = 'dida-more';
        more.title = '点击展开全部';
        more.textContent = '还有 ' + hidden + ' 项 ▼';
        more.addEventListener('click', (ev) => {
          ev.stopPropagation();
          didaTodayExpanded = true;
          renderGrid();
        });
        col.appendChild(more);
      }
      listEl.appendChild(col);
    };

    renderColumn(allDayTasks, '全天');
    renderColumn(timedTasks, '定时', { nowLine: true });
    // 展开后：卡片中央（两列下方横跨）显示唯一的「收起 ▲」
    if (didaTodayExpanded) {
      const bar = document.createElement('div');
      bar.className = 'dida-collapse';
      bar.title = '点击收起';
      bar.textContent = '收起 ▲';
      bar.addEventListener('click', (ev) => {
        ev.stopPropagation();
        didaTodayExpanded = false;
        renderGrid();
      });
      listEl.appendChild(bar);
    }
  }

  // ---- 点击完成任务：调服务端 MCP complete_task，成功后本地移除并重新渲染 ----
  async function completeTask(t) {
    if (!t || !t.projectId || !t.id) {
      showToast('该任务缺少项目信息，无法完成', 'err');
      return;
    }
    try {
      const res = await fetchJSON('/api/dida-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: t.projectId, taskId: t.id }),
      });
      if (!res.ok) throw new Error(res.error || '完成失败');
      // 本地移除（不等 5 分钟轮询），立即反映
      if (didaToday && Array.isArray(didaToday.tasks)) {
        didaToday.tasks = didaToday.tasks.filter(x => x.id !== t.id);
        didaToday.count = didaToday.tasks.length;
      }
      showToast('已完成: ' + t.title);
      renderGrid();
    } catch (e) {
      showToast('完成失败: ' + e.message, 'err');
      reportClientError('completeTask: ' + e.message);
    }
  }

  // ---- 今日专注时长渲染（独立卡：总时长大字，精确到秒） ----
  function renderDidaFocus(valueEl) {
    if (!didaFocus) { valueEl.textContent = '—'; return; }
    if (!didaFocus.ok) { valueEl.className = 'stat-value err'; valueEl.textContent = '获取失败'; return; }
    valueEl.className = 'stat-value';
    const totalSec = Math.round(didaFocus.totalMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const parts = [];
    if (h) parts.push(h + 'h');
    if (m) parts.push(m + 'm');
    if (s || !parts.length) parts.push(s + 's');
    valueEl.textContent = parts.join(' ');
  }

  // ---- DSH 对话状态卡渲染（v0.6.2 二态可见：working / pending；移除 unread） ----
  // 状态语义（与 server.js fetchDshSessions 对齐；DSH 3080 session.list 只暴露这些字段）：
  //   working  → 旋转琥珀圆点，每会话一个（最多 DSH_DOTS_MAX，超出 +N）
  //   pending  → 1 个琥珀静态圆点（不旋转）：plan.pending=true + !running（极少见）
  //   其它（truly idle / offline / blank / error） → 整段 .dsh-status 隐藏，卡片只剩标题
  // 历史：v0.6 三态（working/unread/pending）→ v0.6.2 移除 unread（用户反馈"agent 之前有产出但你没看的"不实用，移除）
  // 设计：v0.5 模仿 DSH 会话栏圆点语言 → v0.5.1/2 收紧 meta / 隐藏 idle → v0.6 → v0.6.2 砍掉 unread
  // 技术限制：session.list 不暴露 ask_user_question / session.error → 这两类不可见
  const DSH_DOTS_MAX = 6;  // working 圆点上限
  function sessionLabel(a) {
    return (a && (a.title || a.cwd || (a.sessionId ? a.sessionId.slice(0, 8) : ''))) || '';
  }
  function appendDot(dotsEl, className, title) {
    const dot = document.createElement('span');
    dot.className = className;
    if (title) dot.title = title;
    dotsEl.appendChild(dot);
  }
  function renderDshSessionsCard(refs) {
    if (!refs || !refs.status || !refs.dots || !refs.meta) return;
    const statusEl = refs.status;
    const dotsEl = refs.dots;
    const metaEl = refs.meta;
    // 清空旧圆点（keyed 渲染复用 DOM，必须清；否则多次轮询后圆点累加）
    while (dotsEl.firstChild) dotsEl.removeChild(dotsEl.firstChild);
    metaEl.textContent = '';
    metaEl.title = '';
    if (!dshSessions) {
      statusEl.style.display = 'none';  // 首轮未到：与 truly idle 同处理
      return;
    }
    const running = dshSessions.running || 0;
    const pendingCount = dshSessions.pendingCount || 0;
    const hasSignal = running > 0 || pendingCount > 0;
    if (!hasSignal) {
      // truly idle / offline / blank / error：无任何活动态信号 → 整段隐藏
      statusEl.style.display = 'none';
      return;
    }
    // 有信号：整段显示
    statusEl.style.display = '';
    // 1) working 圆点（旋转琥珀，每会话一个，上限 DSH_DOTS_MAX）
    const active = dshSessions.active || [];
    const visibleWorking = Math.min(active.length, DSH_DOTS_MAX);
    for (let i = 0; i < visibleWorking; i++) {
      appendDot(dotsEl, 'dsh-dot working', sessionLabel(active[i]) || null);
    }
    if (active.length > DSH_DOTS_MAX) {
      const more = document.createElement('span');
      more.className = 'dsh-dot-count';
      more.textContent = '+' + (active.length - DSH_DOTS_MAX);
      more.title = active.slice(DSH_DOTS_MAX).map(sessionLabel).filter(Boolean).join('、');
      dotsEl.appendChild(more);
    }
    // 2) pending 单圆点（琥珀静态，不旋转；与 working 区分）
    if (pendingCount > 0) {
      const pendingList = dshSessions.pending || [];
      const titleParts = pendingList.map(sessionLabel).filter(Boolean);
      const title = (titleParts.length ? titleParts.slice(0, 5).join('、') + (titleParts.length > 5 ? '…' : '') : pendingCount + ' 个待确认');
      appendDot(dotsEl, 'dsh-dot pending', title);
    }
    // 3) meta：聚合各状态计数（"N 个工作 · P 个待确认"）
    const parts = [];
    if (running > 0) parts.push(running + ' 个工作');
    if (pendingCount > 0) parts.push(pendingCount + ' 个待确认');
    metaEl.textContent = parts.join(' · ');
    // meta hover 聚合 active + pending 标题
    const allTitles = []
      .concat(active.map(sessionLabel))
      .concat((dshSessions.pending || []).map(sessionLabel))
      .filter(Boolean);
    metaEl.title = allTitles.slice(0, 10).join('、') + (allTitles.length > 10 ? '…' : '');
  }

  // ---- 模式 multi-tag 组件（v5 feedback 2：UI 从单选 select 改为多选 checkbox；v0.8：全部→隐藏） ----
  // currentMode 接受四态：null / undefined / []    → "全部模式可见"（无勾选，默认）
  //                        字符串（非 __hidden__） → 仅该模式可见
  //                        字符串数组              → 这些模式都可见
  //                        '__hidden__'             → 所有模式都不显示（用户点"隐藏"按钮）
  // onChange(newMode) 回调：null（全部）/ 字符串数组（被选模式）/ '__hidden__'（隐藏）
  // 互斥：勾选"隐藏" = 清空所有具体模式；勾选任意具体模式 = 取消"隐藏"
  // v0.8 视觉调整：checkbox input 完全隐藏（CSS），label 点击触发切换；.mode-tag.active 亮起即状态
  // readonly 模式：整体 disable（不触发 onChange；调用方仍可批量改 metadata）
  function renderModeTags(currentMode, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'mode-tags';
    // v0.8：'__hidden__' 是与"具体模式"互斥的第四态
    const isHidden = currentMode === '__hidden__';
    const selected = new Set();
    if (!isHidden && Array.isArray(currentMode)) {
      currentMode.forEach((m) => { if (typeof m === 'string' && m !== '__hidden__') selected.add(m); });
    } else if (!isHidden && typeof currentMode === 'string' && currentMode) {
      selected.add(currentMode);
    }
    // null/空/缺省 → selected 为空 = 默认（全部模式可见）

    // "隐藏"按钮：与具体模式互斥（v0.8 替代 v0.7 的"全部"按钮——用户原话"全部感觉就没用了，但是来一个隐藏还是有价值"）
    const hiddenTag = document.createElement('label');
    hiddenTag.className = 'mode-tag mode-tag-hidden' + (isHidden ? ' active' : '');
    hiddenTag.innerHTML = '<input type="checkbox"' + (isHidden ? ' checked' : '') + '> <span>隐藏</span>';
    hiddenTag.title = '勾上后此内容在所有模式下都不显示';
    const hiddenCb = hiddenTag.querySelector('input');
    hiddenCb.addEventListener('change', () => {
      if (hiddenCb.checked) {
        // 勾上"隐藏" → 清空所有具体模式勾选 + 设为 __hidden__
        wrap.querySelectorAll('.mode-tag[data-mode-id]').forEach((el) => {
          el.classList.remove('active');
          const cb = el.querySelector('input');
          if (cb) cb.checked = false;
        });
        onChange('__hidden__');
      } else {
        // 取消"隐藏" → 回到默认（全部模式可见）
        onChange(null);
      }
    });
    wrap.appendChild(hiddenTag);

    // 具体模式按钮（保持不变）
    for (const m of MODES.modes) {
      const tag = document.createElement('label');
      tag.className = 'mode-tag' + (selected.has(m.id) ? ' active' : '');
      tag.dataset.modeId = m.id;
      tag.title = (m.description || m.name) + (m.readonly ? '（只读模式）' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(m.id);
      const label = document.createElement('span');
      label.textContent = m.name;
      tag.appendChild(cb);
      tag.appendChild(label);
      cb.addEventListener('change', () => {
        // 勾选任意具体模式 → 取消"隐藏"勾选（互斥）
        if (cb.checked) {
          hiddenTag.classList.remove('active');
          hiddenCb.checked = false;
        }
        tag.classList.toggle('active', cb.checked);
        // 收敛：当前所有勾选 → 字符串数组
        const checked = [...wrap.querySelectorAll('.mode-tag[data-mode-id] input:checked')]
          .map((c) => c.parentElement.dataset.modeId);
        onChange(checked.length ? checked : null);
      });
      wrap.appendChild(tag);
    }
    // readonly 模式：禁用所有勾选（CSS 视觉降级 + JS 拦截）
    if (isReadonlyMode()) {
      wrap.classList.add('locked');
      wrap.querySelectorAll('input').forEach((cb) => { cb.disabled = true; });
    }
    return wrap;
  }

  // ---- RSS 信息卡渲染（每个源一个小标题 + 最新条目链接列表） ----
  function fmtRssDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0');
  }

  function renderRssList(listEl) {
    listEl.innerHTML = '';
    if (!rssData) {
      const p = document.createElement('div');
      p.className = 'rss-item rss-empty';
      p.textContent = '读取中...';
      listEl.appendChild(p);
      return;
    }
    // 按 mode 过滤（feedsList 含 mode 字段，rssData.feeds 含抓取后的内容）——
    // 服务端 /api/rss 不感知 mode（currentMode 是客户端态），前端按 feedsList 列表过滤
    const modeMap = new Map((feedsList || []).map((f) => [f.id, f.mode]));
    const visibleFeeds = (rssData.feeds || []).filter((f) => modeMatches(modeMap.get(f.id)));
    if (!visibleFeeds.length) {
      const p = document.createElement('div');
      p.className = 'rss-item rss-empty';
      p.textContent = (rssData.feeds || []).length > 0 ? '当前模式下没有订阅源' : '暂无订阅源：样式 → RSS 订阅 中添加';
      listEl.appendChild(p);
      return;
    }
    for (const f of visibleFeeds) {
      const h = document.createElement('div');
      h.className = 'rss-feed-title' + (f.ok === false ? ' err' : '') + (f.stale ? ' stale' : '');
      h.textContent = f.name || f.feedTitle || f.url;
      h.title = f.url + (f.ok === false ? '\n获取失败: ' + (f.error || '') : (f.stale ? '\n本次抓取失败，显示上次缓存内容' : ''));
      if (f.url) {
        h.addEventListener('click', () => openExternal(f.url));
        h.style.cursor = 'pointer';
      }
      listEl.appendChild(h);
      if (f.ok === false) {
        const p = document.createElement('div');
        p.className = 'rss-item rss-empty';
        p.textContent = '获取失败: ' + (f.error || '未知错误');
        p.title = f.error || '';
        listEl.appendChild(p);
        continue;
      }
      for (const it of (f.items || [])) {
        const a = document.createElement('a');
        a.className = 'rss-item';
        a.href = it.link || '#';
        a.target = '_blank';
        a.rel = 'noopener';
        a.draggable = false;
        const t = document.createElement('span');
        t.className = 'rss-item-title';
        t.textContent = it.title;
        a.appendChild(t);
        const d = document.createElement('span');
        d.className = 'rss-item-date';
        d.textContent = fmtRssDate(it.ts);
        a.appendChild(d);
        a.title = it.title + (it.link ? '\n' + it.link : '');
        listEl.appendChild(a);
      }
    }
  }

  // ---- 刷新 RSS 数据（偏好关闭时不抓取；服务端 15 分钟缓存兜底） ----
  async function refreshRss() {
    if ((document.body.dataset.rss || 'on') === 'off') return;
    try {
      rssData = await fetchJSON('/api/rss');
    } catch (e) {
      rssData = { ok: false, error: String(e && e.message || e) };
    }
    renderGrid();
  }

  // ---- DSH 对话状态轮询（feedback 2：state 变化在卡片里"亮"） ----
  // 5 秒一次（与 push 卡片同款节奏，状态有变化即可见）。
  // 失败时不 renderGrid（避免抖动），只更新全局状态 + 重渲当前卡片（如果已渲染）。
  async function refreshDshSessions() {
    try {
      dshSessions = await fetchJSON('/api/dsh-sessions');
    } catch (e) {
      dshSessions = { ok: false, status: 'error', error: String(e && e.message || e), running: 0, total: 0, active: [] };
    }
    // 仅触发该卡片的重渲（不影响其它卡片）
    renderSystemCard('sys-dsh-sessions');
  }

  // ---- 全量渲染（keyed：复用节点，按序 append 实现排序） ----
  function renderGrid() {
    if (dragActive) return; // 拖拽中跳过，避免重排打断手势
    const order = getOrder();
    const layout = document.body.dataset.layout || 'grid';
    const sideCol = document.getElementById('side-col');
    for (const id of order) {
      if (SYS_CARDS[id]) {
        // 模式过滤：当前模式下的卡才渲染（mode 是用户态，与 dida visible 正交）
        if (!modeMatches(SYS_CARDS[id].mode)) continue;
        // RSS 卡按偏好开关显隐（off 时不渲染不占位，等同未安装）
        if (id === 'sys-rss' && (document.body.dataset.rss || 'on') === 'off') continue;
        ensureSystemCard(id);
        renderSystemCard(id);
      } else {
        const b = buttons.find(x => x.id === id);
        // 模式过滤：当前模式下的按钮才渲染（mode 是用户态）
        if (b && !modeMatches(b.mode)) continue;
        // dida 卡片按 visible 显隐：未到点 / 今天已点过 → 不渲染（卡片隐藏，次日或到点自动恢复）
        if (b && b.visible !== false) renderFuncCard(b);
      }
    }
    // split-center 布局：中栏（dida-col）底部放快捷方式启动卡（今日任务固定顶部，CSS order 控制）
    let shortcutsWrap = null;
    if (layout === 'split-center') {
      const dc = document.getElementById('dida-col');
      if (dc) {
        shortcutsWrap = dc.querySelector('.dida-shortcuts');
        if (!shortcutsWrap) {
          shortcutsWrap = document.createElement('div');
          shortcutsWrap.className = 'dida-shortcuts';
          dc.appendChild(shortcutsWrap);
        }
      }
    }
    for (const id of order) {
      const rec = cardCache.get(id);
      if (!rec) continue;
      // 模式过滤：从 DOM 移除（保留 cardCache 与顺序位，切换模式时原地回来）
      if (SYS_CARDS[id] && !modeMatches(SYS_CARDS[id].mode)) {
        rec.el.remove();
        continue;
      }
      const b = buttons.find(x => x.id === id);
      if (b && !modeMatches(b.mode)) {
        rec.el.remove();
        continue;
      }
      // 隐藏不可见的 dida 卡片：从 DOM 移除（保留 cardCache 与顺序位，恢复可见时原地回来）
      const b2 = buttons.find(x => x.id === id);
      if (b2 && b2.kind === 'dida' && b2.visible === false) {
        rec.el.remove();
        continue;
      }
      // RSS 卡偏好关闭：从 DOM 移除（保留缓存与顺序位，重新打开原地回来）
      if (id === 'sys-rss' && (document.body.dataset.rss || 'on') === 'off') {
        rec.el.remove();
        continue;
      }
      // 顶栏搜索过滤：有搜索词时隐藏不匹配卡片（仅 display 隐藏不卸载，清空即恢复；
      // 不可见卡（上两行 continue）不参与过滤）
      rec.el.style.display = (!searchQ || cardMatchesSearch(id)) ? '' : 'none';
      // 双栏仪表盘（split）三栏分配：
      //   dida-col（左）= 滴答今日任务卡；side-col（右）= 其余信息卡；buttons-grid（中）= 功能卡
      //   split-center：dida-col（中）= 今日任务（顶）+ 快捷方式启动卡（底）；buttons-grid（左）= 其余功能卡
      let target = grid;
      if (layout === 'split' || layout === 'split-center') {
        const didaCol = document.getElementById('dida-col');
        if (id === 'sys-dida-today' && didaCol) target = didaCol;
        else if (SYS_CARDS[id] && sideCol) target = sideCol;
        else if (layout === 'split-center' && b && b.command && !b.toggle && !b.kind && shortcutsWrap) target = shortcutsWrap;
      }
      target.appendChild(rec.el);
    }
    // 清理失效卡片（按钮被移除等）
    for (const [id, rec] of cardCache) {
      if (!order.includes(id)) {
        rec.el.remove();
        cardCache.delete(id);
      }
    }
    // Bento 网格瀑布流：按卡片实际高度设置 span 行，dense 自动填充矮卡下方空隙
    applyMasonry();
  }

  // ---- Bento 网格瀑布流 ----
  // CSS 已设 body[data-layout="grid"] .buttons-grid { grid-auto-rows: 10px }。
  // 行高单位 10px + gap 16px：卡片 span N 行 = N*10 + (N-1)*16 ≥ 卡高 ⟺ N ≥ (卡高+16)/26。
  // 同一同步块内：先量 auto 行高下的自然高度，再设固定行高 + span，浏览器只渲染最终结果。
  const MASONRY_ROW = 10;
  const MASONRY_GAP = 16;
  function applyMasonry() {
    const layout = document.body.dataset.layout || 'grid';
    if (layout !== 'grid') return;
    const cards = [...grid.querySelectorAll(':scope > .card')];
    if (!cards.length) return;
    grid.style.gridAutoRows = 'auto';
    const heights = cards.map(c => c.getBoundingClientRect().height);
    grid.style.gridAutoRows = MASONRY_ROW + 'px';
    cards.forEach((c, i) => {
      const span = Math.max(1, Math.ceil((heights[i] + MASONRY_GAP) / (MASONRY_ROW + MASONRY_GAP)));
      c.style.gridRowEnd = 'span ' + span;
    });
  }

  // ---- 拖拽排序（指针事件实现：仅按住 ⠿ 手柄拖动换位；卡片其他位置点击即执行） ----
  // 不用 HTML5 draggable：它会吞掉 click 事件，导致"点了没反应"。
  // 曾实现"按住卡片任意位置拖动（位移 >6px 换位，轻点点击）"，但 6px 阈值把正常点击
  // 误判为拖拽、suppressClick 吞掉 click，按钮"点了没反应"——已收敛回手柄区（见第 8 节变更记录）。
  let pDrag = null;      // { id, el, startX, startY, offsetX, offsetY, width, active }
  let suppressClick = false;

  function cleanupDrag() {
    if (pDrag && pDrag.el) {
      const el = pDrag.el;
      el.style.position = '';
      el.style.width = '';
      el.style.left = '';
      el.style.top = '';
      el.style.margin = '';
      el.style.zIndex = '';
      el.style.pointerEvents = '';
      el.style.transition = '';
      el.classList.remove('dragging');
    }
    document.querySelectorAll('.card.dragging, .card.drag-over').forEach(c => {
      c.classList.remove('dragging', 'drag-over');
    });
    pDrag = null;
    dragActive = false;
    document.body.style.userSelect = '';
    renderGrid(); // 按当前顺序恢复卡片到原位
  }

  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('.bm-item')) return; // 书签项（含书签卡内）不触发卡片拖拽
    // readonly 模式（modes.json 该模式 readonly=true）禁止拖拽卡片换位，
    // 即便 .drag-hint 由于 CSS 残留也可见也直接 return（CSS 兜底 + JS 双保险）
    if (isReadonlyMode()) return;
    // 仅 ⠿ 手柄（.drag-hint）进入卡片拖拽；卡片其余区域（含 run-btn、标题、描述）
    // 不再经过拖拽判定，click 必达——曾因"整卡可拖 + 6px 阈值"把正常点击误判为拖拽、
    // suppressClick 吞掉 click，导致按钮"点了没反应"
    const handle = e.target.closest('.drag-hint');
    if (!handle || e.button !== 0) return;
    const card = handle.closest('.card');
    if (!card) return;
    pDrag = { id: card.dataset.id, el: card, startX: e.clientX, startY: e.clientY, active: false };
  });

  document.addEventListener('mousemove', (e) => {
    if (!pDrag) return;
    const dx = e.clientX - pDrag.startX;
    const dy = e.clientY - pDrag.startY;
    if (!pDrag.active) {
      if (dx * dx + dy * dy <= 36) return; // 6px 阈值内视为点击
      pDrag.active = true;
      dragActive = true;
      // 幽灵跟随：卡片脱离网格，fixed 跟随光标（pointer-events:none 保证落点检测正常）
      const el = pDrag.el;
      const rect = el.getBoundingClientRect();
      pDrag.offsetX = e.clientX - rect.left;
      pDrag.offsetY = e.clientY - rect.top;
      pDrag.width = rect.width;
      el.style.position = 'fixed';
      el.style.width = pDrag.width + 'px';
      el.style.left = (e.clientX - pDrag.offsetX) + 'px';
      el.style.top = (e.clientY - pDrag.offsetY) + 'px';
      el.style.margin = '0';
      el.style.zIndex = '1000';
      el.style.pointerEvents = 'none';
      el.style.transition = 'none';
      document.body.style.userSelect = 'none';
      el.classList.add('dragging');
    } else {
      const el = pDrag.el;
      el.style.left = (e.clientX - pDrag.offsetX) + 'px';
      el.style.top = (e.clientY - pDrag.offsetY) + 'px';
    }
    e.preventDefault();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under ? under.closest('.card') : null;
    document.querySelectorAll('.card.drag-over').forEach(c => c.classList.remove('drag-over'));
    if (target && target !== pDrag.el) target.classList.add('drag-over');
  });

  document.addEventListener('mouseup', (e) => {
    if (!pDrag) return;
    const wasActive = pDrag.active;
    if (wasActive) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under ? under.closest('.card') : null;
      if (target && target.dataset.id && target.dataset.id !== pDrag.id) {
        const order = getOrder();
        const i = order.indexOf(pDrag.id);
        const j = order.indexOf(target.dataset.id);
        if (i >= 0 && j >= 0) {
          order.splice(i, 1);
          order.splice(j, 0, pDrag.id);
          setOrder(order);
        }
      }
      suppressClick = true; // 拖拽后的 click 不触发按钮执行
      // 兜底：若本次拖拽后浏览器没有派发 click（元素被重排/鼠标移出窗口等），
      // 下一个宏任务清除标志，避免残留误吞下一次真实点击（曾导致"点了没反应"）
      setTimeout(() => { suppressClick = false; }, 0);
      cleanupDrag();
    } else {
      // 纯点击（未进入拖拽）：没有样式/状态需要清理，直接结束，不触发整页重排
      pDrag = null;
    }
  });

  // 拖拽后吞掉紧随的 click（捕获阶段拦截，按钮/整卡点击都不会误触发）
  document.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // 鼠标拖出窗口等异常情况：取消拖拽状态，避免卡死
  window.addEventListener('blur', cleanupDrag);

  // 禁止卡片/书签内的原生拖拽（链接、图片），统一走上面的指针拖拽
  document.addEventListener('dragstart', (e) => {
    if (e.target.closest('.card') || e.target.closest('.bm-item')) e.preventDefault();
  });

  // 卡片整体点击（信息卡用）。拖拽只从 ⠿ 手柄触发（document mousedown），
  // 手柄拖拽产生的 click 已被 suppressClick 吞掉，能走到这里的都是真实点击
  function bindCardClick(el, fn) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.drag-hint')) return; // 拖拽手柄不触发卡片动作
      fn(e);
    });
  }

  // ---- 打开外部链接：优先新标签页；被浏览器弹窗拦截时回退为当前页跳转 ----
  // 保证"点击必跳转"。曾因 window.open 被弹窗拦截导致余额卡点了没反应。
  function openExternal(url) {
    let w = null;
    try { w = window.open(url, '_blank'); } catch (e) { /* 拦截等异常走回退 */ }
    if (!w) window.location.href = url;
  }

  // ---- 轻提示 toast（所有按钮点击的即时反馈，避免"点了没反应"） ----
  let toastTimer = null;
  function showToast(msg, type) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show ' + (type || 'info');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2600);
  }

  // ---- 执行按钮 ----
  async function runButton(b) {
    if (busy[b.id]) return;
    busy[b.id] = true;
    try {
      renderGrid(); // 若渲染抛错，finally 仍会清除 busy，按钮不会卡死在"执行中..."
      if (b.kind === 'push') {
        const result = await fetchJSON('/api/push', { method: 'POST' });
        if (result.ok) {
          showToast('Push 已发送，正在打开 DSH 页面', 'ok');
          openExternal('http://127.0.0.1:3080');
        } else if (result.locked) {
          showToast('按钮已锁定: ' + (result.error || '10 分钟内只能 push 一次'), 'warn');
        } else {
          showToast('Push 失败: ' + (result.error || '未知错误'), 'err');
        }
      } else if (b.kind === 'dida') {
        const result = await fetchJSON('/api/dida/' + encodeURIComponent(b.id), { method: 'POST' });
        if (result.ok) {
          showToast(b.name + '：已发送，正在打开 DSH 页面', 'ok');
          openExternal('http://127.0.0.1:3080');
        } else {
          showToast(b.name + '：发送失败: ' + (result.error || '未知错误'), 'err');
        }
      } else {
        const url = b.toggle ? '/api/toggle/' : '/api/run/';
        const res = await fetchJSON(url + encodeURIComponent(b.id), { method: 'POST' });
        if (res && res.ok === false) {
          showToast('执行失败: ' + (res.error || '未知错误'), 'err');
        } else {
          const code = res && res.entry ? res.entry.code : 0;
          if (b.toggle) {
            showToast(b.name + '：' + (res.action === 'stop' ? '已停止' : '已启动'), 'ok');
          } else if (code === 0) {
            showToast(b.name + '：已执行（退出码 0）', 'ok');
          } else {
            showToast(b.name + '：已执行，退出码 ' + code, 'warn');
          }
        }
      }
    } catch (e) {
      console.error(e);
      // 上报服务端日志（workbench.log 的 [client] 行），失败不再静默
      reportClientError('runButton(' + (b && b.id) + '): ' + e.message);
      showToast('执行失败: ' + e.message, 'err');
    } finally {
      delete busy[b.id];
      refreshButtons();
      refreshLogs();
    }
  }

  // ---- 刷新按钮状态 ----
  let loadedVersion = null;
  let versionChecked = false;

  async function refreshButtons() {
    try {
      const data = await fetchJSON('/api/buttons');
      buttons = data.buttons || [];
      workbenchOnline = true;
      dot.className = 'dot on';
      statusText.textContent = '工作台服务正常';

      // 版本自检：服务端返回前端文件哈希。本页加载后若发现版本变了，
      // 说明页面代码已更新（用户可能停在旧标签页），自动刷新拉取新 JS。
      // 这是"我改了代码但点了没反应"这类旧页面问题的自动防线。
      if (data.version && data.version !== 'unknown') {
        if (!versionChecked) {
          loadedVersion = data.version;
          versionChecked = true;
        } else if (data.version !== loadedVersion) {
          showToast('检测到页面更新，正在自动刷新...', 'warn');
          setTimeout(() => location.reload(), 800);
          return;
        }
      }
    } catch (e) {
      workbenchOnline = false;
      dot.className = 'dot off';
      statusText.textContent = '无法连接工作台服务';
    }
    renderGrid();
    renderShortcutList(); // 快捷方式管理列表（设置面板）随按钮数据刷新
    renderModeManager(); // v5 feedback 3：模式管理区跟随数据刷新
  }

  // ---- 刷新队列条数 ----
  async function refreshQueue() {
    try {
      queueInfo = await fetchJSON('/api/queue');
    } catch (e) {
      queueInfo = null;
    }
    renderGrid();
  }

  // ---- 刷新余额 ----
  async function refreshBalance() {
    try {
      balanceData = await fetchJSON('/api/balance');
    } catch (e) {
      balanceData = { ok: false, error: '无法获取' };
    }
    renderGrid();
  }

  // ---- 刷新滴答今日任务 ----
  async function refreshDidaToday() {
    try {
      didaToday = await fetchJSON('/api/dida-today');
    } catch (e) {
      didaToday = { ok: false, error: '无法获取' };
    }
    renderGrid();
  }

  // ---- 刷新滴答今日专注时长 ----
  async function refreshDidaFocus() {
    try {
      didaFocus = await fetchJSON('/api/dida-focus');
    } catch (e) {
      didaFocus = { ok: false, error: '无法获取' };
    }
    renderGrid();
  }

  // ---- 刷新 MiniMax Token Plan 额度（5 分钟轮询，限额变动较慢） ----
  async function refreshMiniMax() {
    try {
      minimaxData = await fetchJSON('/api/minimax-coding-plan');
    } catch (e) {
      minimaxData = { ok: false, error: '无法获取' };
    }
    renderGrid();
  }

  // ---- 刷新日志 ----
  async function refreshLogs() {
    try {
      const data = await fetchJSON('/api/logs');
      const logs = data.logs || [];
      logsList.innerHTML = '';
      if (logs.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '暂无运行记录';
        logsList.appendChild(li);
        return;
      }
      for (const log of logs) {
        const li = document.createElement('li');

        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = log.time;
        li.appendChild(time);

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = log.name;
        name.title = log.name; // 名称过长被省略号截断时，悬浮显示完整
        li.appendChild(name);

        const status = document.createElement('span');
        status.className = 'status';
        let statusText = '';
        if (log.status === 'running') {
          statusText = '执行中';
          status.classList.add('running');
        } else if (log.status === 'done') {
          statusText = log.code === 0 ? '完成' : '失败(退出码 ' + log.code + ')';
          status.classList.add(log.code === 0 ? 'done-0' : 'done-other');
        } else {
          statusText = '出错: ' + (log.error || '');
          status.classList.add('error');
        }
        status.textContent = statusText;
        status.title = statusText; // 错误信息过长被省略号截断时，悬浮显示完整
        li.appendChild(status);

        logsList.appendChild(li);
      }
    } catch (e) {
      // 忽略：下次轮询重试
    }
  }

  // ---- 书签栏折叠/展开 ----
  const collapseBtn = document.getElementById('collapse-btn');
  const expandBtn = document.getElementById('expand-sidebar');

  collapseBtn.addEventListener('click', () => {
    document.body.classList.add('sidebar-collapsed');
  });

  expandBtn.addEventListener('click', () => {
    document.body.classList.remove('sidebar-collapsed');
  });

  // ---- 书签小图标（经服务端 /api/favicon 抓取+缓存；失败自动隐藏） ----
  function faviconImg(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return null; }
    const img = document.createElement('img');
    img.className = 'bm-fav';
    img.alt = '';
    img.loading = 'lazy';
    img.src = '/api/favicon?domain=' + encodeURIComponent(host) + '&url=' + encodeURIComponent(url);
    img.addEventListener('error', () => img.remove());
    return img;
  }

  // ---- 书签功能（侧栏管理 + 卡片展示） ----
  const bookmarkList = document.getElementById('bookmark-list');
  const addBtn = document.getElementById('add-bookmark-btn');
  const modal = document.getElementById('bookmark-modal');
  const bmName = document.getElementById('bm-name');
  const bmUrl = document.getElementById('bm-url');
  const bmCancel = document.getElementById('bm-cancel');
  const bmSave = document.getElementById('bm-save');

  async function refreshBookmarks() {
    try {
      const data = await fetchJSON('/api/bookmarks');
      bookmarks = data.bookmarks || [];
    } catch (e) {
      bookmarks = [];
    }
    renderSidebarBookmarks();
    renderGrid();
    renderModeManager(); // v5 feedback 3：模式管理区跟随数据刷新
  }

  // 侧栏书签渲染（独立出来供搜索过滤 + 模式过滤复用）
  // 过滤顺序：mode 优先（先把当前模式不命中的全部剔掉）→ 再看搜索词
  function renderSidebarBookmarks() {
    bookmarkList.innerHTML = '';
    const modeFiltered = bookmarks.filter((bm) => modeMatches(bm.mode));
    const shown = searchQ ? modeFiltered.filter(bmMatches) : modeFiltered;
    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'bookmark-empty';
      li.textContent = searchQ ? '没有匹配的书签' : (modeFiltered.length === 0 && bookmarks.length > 0 ? '当前模式下没有书签' : '暂无书签，点 + 添加');
      bookmarkList.appendChild(li);
      return;
    }
    for (const bm of shown) {
        const li = document.createElement('li');
        li.className = 'bookmark-item bm-item';
        li.dataset.bmId = bm.id;

        const drag = document.createElement('span');
        drag.className = 'bm-drag';
        drag.title = '按住拖动排序';
        drag.textContent = '⠿';
        li.appendChild(drag);

        const a = document.createElement('a');
        a.className = 'bm-name';
        a.title = bm.url;
        const fav = faviconImg(bm.url);
        if (fav) a.appendChild(fav);
        a.appendChild(document.createTextNode(bm.name));
        a.href = bm.url;
        a.target = '_blank';
        a.rel = 'noopener';
        li.appendChild(a);

        // 工作模式只读：删除 + 编辑按钮仅在娱乐模式渲染（CSS body[data-readonly="true"] 兜底）
        if (!isReadonlyMode()) {
          // 编辑按钮（✎）：调 openModal(bm.id) 复用 modal（预填字段）
          const edit = document.createElement('button');
          edit.className = 'bm-edit bm-remove';
          edit.textContent = '✎';
          edit.title = '编辑书签（修改名称 / 网址 / 显示模式）';
          edit.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            openModal(bm.id);
          });
          li.appendChild(edit);
          const del = document.createElement('button');
          del.className = 'bm-del bm-remove';
          del.textContent = 'x';
          del.title = '删除';
          del.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (!confirm('删除书签「' + bm.name + '」？')) return;
            try {
              await fetchJSON('/api/bookmarks/' + encodeURIComponent(bm.id), { method: 'DELETE' });
              refreshBookmarks();
            } catch (err) {
              alert('删除失败: ' + err.message);
            }
          });
          li.appendChild(del);
        }

        // 模式标签不展示（用户反馈"既然切换到娱乐是娱乐也很正常"，不需要被提醒）
        // 服务端依然返回 mode 字段，仅作过滤依据；编辑入口在书签 modal（feedback 5）

        bookmarkList.appendChild(li);
    }
  }

  // 模式 id → 中文标签（找不到回退 id 本身）
  function modeLabel(id) {
    const m = MODES.modes.find((x) => x.id === id);
    return m ? m.name : id;
  }

  // ---- 书签拖拽排序（指针事件实现：按住书签项任意位置拖动，位移 >6px 进入拖拽；轻点 = 打开/删除）
  //      侧栏与书签卡（.bm-item）通用；排序基于完整书签数组计算 ----
  let bmDrag = null; // { el, startX, startY, active }

  function cleanupBmDrag() {
    document.querySelectorAll('.bm-item.bm-dragging, .bm-item.bm-drop-before, .bm-item.bm-drop-after').forEach((x) => {
      x.classList.remove('bm-dragging', 'bm-drop-before', 'bm-drop-after');
    });
    bmDrag = null;
    document.body.style.userSelect = '';
  }

  document.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.bm-item');
    if (!item || e.button !== 0) return;
    // readonly 模式禁止书签拖拽换位（cs 已在 .bm-drag 隐藏；这里 JS 双保险）
    if (isReadonlyMode()) return;
    bmDrag = { el: item, startX: e.clientX, startY: e.clientY, active: false };
  });

  document.addEventListener('mousemove', (e) => {
    if (!bmDrag) return;
    const dx = e.clientX - bmDrag.startX;
    const dy = e.clientY - bmDrag.startY;
    if (!bmDrag.active) {
      if (dx * dx + dy * dy <= 36) return; // 6px 阈值内视为点击
      bmDrag.active = true;
      document.body.style.userSelect = 'none';
      bmDrag.el.classList.add('bm-dragging');
    }
    e.preventDefault();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under ? under.closest('.bm-item') : null;
    document.querySelectorAll('.bm-item.bm-drop-before, .bm-item.bm-drop-after').forEach((x) => {
      x.classList.remove('bm-drop-before', 'bm-drop-after');
    });
    if (target && target !== bmDrag.el) {
      const rect = target.getBoundingClientRect();
      target.classList.add(e.clientY < rect.top + rect.height / 2 ? 'bm-drop-before' : 'bm-drop-after');
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (!bmDrag) return;
    if (bmDrag.active) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under ? under.closest('.bm-item') : null;
      if (target && target !== bmDrag.el) {
        const rect = target.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        // 基于完整书签数组计算新顺序（侧栏/书签卡都只显示部分书签）
        const draggedId = bmDrag.el.dataset.bmId;
        const targetId = target.dataset.bmId;
        if (draggedId && targetId) {
          const order = bookmarks.map((b) => b.id);
          const i = order.indexOf(draggedId);
          const j = order.indexOf(targetId);
          if (i >= 0 && j >= 0) {
            order.splice(i, 1);
            let insertAt = order.indexOf(targetId);
            if (!before) insertAt += 1;
            order.splice(insertAt, 0, draggedId);
            persistBookmarkOrder(order);
          }
        }
      }
      suppressClick = true; // 拖拽后的 click 不触发打开链接/删除
    }
    cleanupBmDrag();
  });

  window.addEventListener('blur', cleanupBmDrag);

  async function persistBookmarkOrder(ids) {
    try {
      await fetchJSON('/api/bookmarks/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    } catch (e) {
      showToast('保存书签顺序失败: ' + e.message, 'err');
    }
    refreshBookmarks();
  }

  // 书签 modal 的 mode multi-tag 容器（v5 feedback 2：从 select 改为 checkbox 多选）
  const bmModeSelect = document.getElementById('bm-mode');
  const bmModalTitle = document.getElementById('bm-modal-title');
  const bmSaveBtn = document.getElementById('bm-save');
  // 当前 modal 操作类型：null = 新增；否则 = 编辑的书签 id
  let bmEditId = null;
  // 当前 modal 选中的模式（null = 全部模式；字符串数组 = 这些模式可见）
  let bmModalMode = null;

  // 打开书签 modal：editId=null 走"新增"；editId=书签 id 走"编辑"（预填字段）
  function openModal(editId) {
    // 工作模式（只读）禁止编辑书签——CSS pointer-events:none + bm-edit 隐藏兜底
    if (editId && isReadonlyMode()) {
      showToast('当前模式只读，请先切换到娱乐模式再编辑书签', 'warn');
      return;
    }
    bmEditId = editId || null;
    modal.dataset.editId = bmEditId || '';
    if (bmModalTitle) bmModalTitle.textContent = bmEditId ? '编辑书签' : '添加书签';
    if (bmSaveBtn) bmSaveBtn.textContent = bmEditId ? '保存修改' : '保存';
    // 预填字段（编辑模式从 bookmarks 缓存读）
    let preset = null;
    if (bmEditId) {
      preset = bookmarks.find((b) => b.id === bmEditId) || null;
    }
    bmName.value = preset ? preset.name : '';
    bmUrl.value = preset ? preset.url : '';
    // 预填 mode（编辑模式读取现有值；新增模式默认 null = 全部模式可见）
    bmModalMode = (preset && preset.mode != null) ? preset.mode : null;
    // 动态渲染 multi-tag 组件（每次打开 modal 都重建——标记语义清晰、避免上一次打开残留）
    if (bmModeSelect) {
      bmModeSelect.innerHTML = '';
      bmModeSelect.appendChild(renderModeTags(bmModalMode, (newMode) => {
        bmModalMode = newMode;
      }));
    }
    modal.classList.remove('hidden');
    bmName.focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
    bmEditId = null;
    modal.dataset.editId = '';
  }

  async function saveBookmark() {
    const name = bmName.value.trim();
    let url = bmUrl.value.trim();
    if (!name || !url) {
      alert('名称和网址都不能为空');
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    // mode：multi-tag 实时回调更新 bmModalMode（null = 全部模式；数组 = 这些模式可见）
    const mode = bmModalMode;
    try {
      let data;
      if (bmEditId) {
        // 编辑：PATCH /api/bookmarks/<id>（仅传变化的字段，name/url/mode 全传为简单）
        data = await fetchJSON('/api/bookmarks/' + encodeURIComponent(bmEditId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, url, mode }),
        });
      } else {
        // 新增：POST /api/bookmarks
        data = await fetchJSON('/api/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, url, mode }),
        });
      }
      if (data.ok) {
        closeModal();
        refreshBookmarks();
      } else {
        alert((bmEditId ? '修改' : '添加') + '失败: ' + (data.error || '未知错误'));
      }
    } catch (e) {
      alert((bmEditId ? '修改' : '添加') + '失败: ' + e.message);
    }
  }

  addBtn.addEventListener('click', openModal);
  bmCancel.addEventListener('click', closeModal);
  bmSave.addEventListener('click', saveBookmark);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  bmUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBookmark();
  });
  bmName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') bmUrl.focus();
  });

  // ---- 顶栏快速搜索：输入即过滤卡片墙与侧栏书签；回车执行第一个匹配；Esc 清空 ----
  const searchInput = document.getElementById('quick-search');

  function applySearch(value) {
    searchQ = (value || '').trim().toLowerCase();
    renderSidebarBookmarks();
    renderGrid();
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => applySearch(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runFirstSearchMatch();
      } else if (e.key === 'Escape') {
        searchInput.value = '';
        applySearch('');
        searchInput.blur();
      }
    });
  }

  // 「/」聚焦搜索框（不在输入框里时；偏好关闭搜索框时忽略）
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!searchInput || document.body.dataset.search === 'off') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  });

  // ---- 样式设置（主题 + 布局 + 偏好开关，localStorage 持久化） ----
  const THEME_KEY = 'workbench-theme';
  const LAYOUT_KEY = 'workbench-layout';
  const SIDEBAR_KEY = 'workbench-sidebar';
  const BIGNUM_KEY = 'workbench-bignum';
  const COUNTUP_KEY = 'workbench-countup';
  const ICONS_KEY = 'workbench-icons';
  const SEARCH_KEY = 'workbench-search';
  const RSS_KEY = 'workbench-rss';
  const MODE_KEY = 'workbench-mode';
  const styleBtn = document.getElementById('style-btn');
  const stylePanel = document.getElementById('style-panel');

  const SWITCH_IDS = {
    'sidebar-switch': SIDEBAR_KEY,
    'bignum-switch': BIGNUM_KEY,
    'countup-switch': COUNTUP_KEY,
    'icons-switch': ICONS_KEY,
    'search-switch': SEARCH_KEY,
    'rss-switch': RSS_KEY,
  };

  function applyStyle() {
    const theme = localStorage.getItem(THEME_KEY) || 'emerald';
    const layout = localStorage.getItem(LAYOUT_KEY) || 'grid';
    document.body.dataset.theme = theme;
    document.body.dataset.layout = layout;
    for (const [id, key] of Object.entries(SWITCH_IDS)) {
      const on = localStorage.getItem(key) !== 'off';
      document.body.dataset[key.replace('workbench-', '')] = on ? 'on' : 'off';
      const el = document.getElementById(id);
      if (el) el.setAttribute('aria-checked', String(on));
    }
    // 模式：白名单校验（基于 MODES；启动早期 MODES_LOADED=false 时用内置默认 work）
    let m = localStorage.getItem(MODE_KEY);
    const knownIds = MODES_LOADED ? MODES.modes.map((x) => x.id) : ['work'];
    if (!knownIds.includes(m)) m = MODES_LOADED ? MODES.default : 'work';
    currentMode = m;
    document.body.dataset.mode = currentMode;
    // 只读态：mode.readonly = true 时挂到 body[data-readonly]，CSS 据此降级所有编辑控件
    document.body.dataset.readonly = isReadonlyMode() ? 'true' : 'false';
    // 同步设置面板切换器的激活态（顶栏切换器已移除）
    document.querySelectorAll('.mode-seg-opt[data-mode]').forEach(el => {
      el.classList.toggle('active', el.dataset.mode === currentMode);
    });
    document.querySelectorAll('.sp-opt[data-theme-opt]').forEach(el => {
      el.classList.toggle('active', el.dataset.themeOpt === theme);
    });
    document.querySelectorAll('.sp-opt[data-layout-opt]').forEach(el => {
      el.classList.toggle('active', el.dataset.layoutOpt === layout);
    });
    renderGrid(); // 布局/开关变化时重渲染（keyed 复用，开销极小）
    // RSS 卡从关到开且尚无数据时立即拉取（开关切换即时出内容）
    if ((document.body.dataset.rss || 'on') === 'on' && !rssData) refreshRss();
  }

  // ---- 模式切换（设置面板 segmented control + 顶栏 mode-switcher 共用）----
  // mode 是用户态，localStorage 持久化；切换即时重渲染（renderGrid 按 mode 过滤）。
  // 接受任意合法模式 id（白名单校验，未知 id 静默忽略），未来 modes.json 加新模式无需改这里。
  function setMode(v) {
    const knownIds = MODES_LOADED ? MODES.modes.map((x) => x.id) : ['work'];
    if (!knownIds.includes(v)) return;
    if (v === currentMode) return;
    currentMode = v;
    localStorage.setItem(MODE_KEY, v);
    applyStyle();
    // 同步已有卡片的 drag-hint 显隐（keyed 缓存复用 DOM，初次渲染后不会自动重渲）
    syncDragHintsForReadonly();
    // 立即重渲侧栏 / 卡片墙 / RSS（按 mode 过滤），不等 10 秒轮询
    renderSidebarBookmarks();
    renderSystemCard('sys-bookmarks');
    renderRssForReRender();
    // 同步卡片墙书签 add 按钮显隐（keyed 缓存初渲决定，setMode 不破坏）
    refreshAllCardAddBtns();
    // RSS 卡片若已渲染，拉一次新数据（缓存内的 rssData 可能不含新加的源 / 切换后的源）
    const rssHit = cardCache.get('sys-rss');
    if (rssHit && (document.body.dataset.rss || 'on') === 'on') {
      refreshRss();
    }
    const def = MODES.modes.find((x) => x.id === v);
    const label = def ? def.name : v;
    showToast('已切换到 ' + label + ' 模式' + (def && def.readonly ? '（只读）' : ''), 'ok');
  }

  // 切换模式后重新触发 RSS 卡片渲染（keyed 缓存复用 DOM，renderGrid 才会重渲染内层）
  function renderRssForReRender() {
    const hit = cardCache.get('sys-rss');
    if (!hit) return;
    const listEl = hit.refs.list;
    if (listEl) renderRssList(listEl);
  }

  // 同步卡片墙书签 / RSS 卡的 add 按钮显隐（已渲染的按钮不会被 readonly 状态回流影响）
  function refreshAllCardAddBtns() {
    const readonly = isReadonlyMode();
    document.querySelectorAll('#card-add-bookmark').forEach((el) => {
      el.style.display = readonly ? 'none' : '';
    });
  }

  // 同步所有 .card 的 drag-hint：readonly 模式删除（DOM 移除而非 CSS 隐藏，
  // 避免无意义节点残留；renderGrid 重建时按 isReadonlyMode() 重新决定）。
  // 已渲染卡片（keyed 缓存复用）需要这里显式同步——setMode 切换 readonly 状态时调用。
  function syncDragHintsForReadonly() {
    const readonly = isReadonlyMode();
    document.querySelectorAll('.card').forEach((card) => {
      const has = !!card.querySelector('.drag-hint');
      if (readonly && has) {
        const hint = card.querySelector('.drag-hint');
        hint.parentNode.removeChild(hint);
      } else if (!readonly && !has) {
        const hint = document.createElement('span');
        hint.className = 'drag-hint';
        hint.title = '按住拖动换位';
        hint.textContent = '⠿';
        // 插入到 card-head 之后（与 ensureFuncCard 渲染顺序一致）
        const head = card.querySelector('.card-head');
        if (head && head.nextSibling) head.parentNode.insertBefore(hint, head.nextSibling);
        else card.appendChild(hint);
      }
    });
  }

  // 动态渲染模式切换器（仅设置面板 segmented control）：
  // 根据 MODES.modes 列表生成按钮；modes.json 加新模式后自动出现。
  // 顶栏切换器已移除（用户反馈"在外解锁太容易"——只有设置面板能切）。
  // 设置面板的两个静态按钮（工作/娱乐）由 index.html 写死——这里清空 + 重建，保证单一真源。
  function renderModeSwitchers() {
    const seg = document.getElementById('mode-seg');
    if (seg) {
      seg.innerHTML = '';
      for (const m of MODES.modes) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mode-seg-opt';
        btn.dataset.mode = m.id;
        btn.title = (m.description || m.name) + (m.readonly ? '（只读）' : '');
        const ic = document.createElement('span');
        ic.className = 'mode-icon';
        ic.innerHTML = m.icon || '';
        const nm = document.createElement('span');
        nm.className = 'mode-name';
        nm.textContent = m.name;
        btn.appendChild(ic);
        btn.appendChild(nm);
        if (m.id === currentMode) btn.classList.add('active');
        seg.appendChild(btn);
      }
    }
  }

  function setStyle(kind, value) {
    // 只读模式（work）禁止切换主题/布局——CSS pointer-events:none 是兜底，
    // JS 这里再做一层拦截（防止 console / 自动化绕过）
    if (isReadonlyMode()) {
      showToast('当前模式只读，请先切换到娱乐模式再调整外观/布局', 'warn');
      return;
    }
    if (kind === 'theme') localStorage.setItem(THEME_KEY, value);
    else localStorage.setItem(LAYOUT_KEY, value);
    applyStyle();
  }

  styleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    stylePanel.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!stylePanel.classList.contains('hidden') && !e.target.closest('#style-wrap')) {
      stylePanel.classList.add('hidden');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !stylePanel.classList.contains('hidden')) {
      stylePanel.classList.add('hidden');
    }
  });

  stylePanel.addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme-opt]');
    if (t) { setStyle('theme', t.dataset.themeOpt); return; }
    const l = e.target.closest('[data-layout-opt]');
    if (l) { setStyle('layout', l.dataset.layoutOpt); return; }
    const sw = e.target.closest('.switch');
    if (sw && sw.id && SWITCH_IDS[sw.id]) {
      // 只读模式禁止切换偏好（sidebar / bignum / countup / icons / search / rss）
      if (isReadonlyMode()) {
        showToast('当前模式只读，请先切换到娱乐模式再调整偏好', 'warn');
        return;
      }
      const key = SWITCH_IDS[sw.id];
      const next = localStorage.getItem(key) === 'off' ? 'on' : 'off';
      localStorage.setItem(key, next);
      applyStyle();
    }
    const mo = e.target.closest('.mode-seg-opt[data-mode]');
    if (mo) { setMode(mo.dataset.mode); return; }
  });

  // ---- 面板可折叠分区（外观/布局，收起状态持久化） ----
  document.querySelectorAll('.sp-section[data-collapsible]').forEach(section => {
    const row = section.querySelector('.sp-title-row');
    if (!row) return;
    const key = 'workbench-fold-' + section.dataset.collapsible;
    if (localStorage.getItem(key) === '1') {
      section.classList.add('collapsed');
      row.setAttribute('aria-expanded', 'false');
    }
    row.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      row.setAttribute('aria-expanded', String(!collapsed));
      localStorage.setItem(key, collapsed ? '1' : '0');
    });
  });

  // ---- 设置面板：快捷方式管理（自动添加/删除，不消耗 AI token） ----
  const SHORTCUT_COLORS = ['#3b82f6', '#047857', '#0d9488', '#7c3aed', '#ea580c', '#db2777', '#64748b', '#dc2626'];
  let scColor = SHORTCUT_COLORS[0];
  let scSize = 'small';
  let scMode = null; // 快捷方式添加表单的 mode 选择（null = 全部模式，与 bm-mode 同语义）
  let scListSig = '';

  function renderShortcutList() {
    const ul = document.getElementById('sc-list');
    if (!ul) return;
    // 普通按钮（有 command 且非 toggle/push/dida）都可管理颜色/尺寸；删除仅限 auto
    const auto = buttons.filter((b) => b.command && !b.toggle && !b.kind);
    const sig = auto.map((b) => [b.id, b.icon, b.name, b.description, b.color, b.size].join('|')).join('\n');
    if (sig === scListSig && ul.childElementCount) return;
    scListSig = sig;
    ul.innerHTML = '';
    if (!auto.length) {
      const li = document.createElement('li');
      li.className = 'sc-empty';
      li.textContent = '还没有快捷方式，填写上方路径后点「添加按钮」，或直接把 .exe / .lnk 拖进页面';
      ul.appendChild(li);
      return;
    }
    for (const b of auto) {
      const li = document.createElement('li');
      li.className = 'sc-item';
      // 第一行：图标 + 名称 + 路径 + 删除
      const row = document.createElement('div');
      row.className = 'sc-item-row';
      const icon = document.createElement('span');
      icon.className = 'sc-item-icon';
      if (b.icon) {
        const img = document.createElement('img');
        img.src = b.icon;
        img.alt = '';
        icon.appendChild(img);
      } else {
        icon.textContent = CARD_ICONS[b.id] || '';
      }
      const nm = document.createElement('span');
      nm.className = 'sc-item-name';
      nm.textContent = b.name;
      const pt = document.createElement('span');
      pt.className = 'sc-item-path';
      pt.textContent = b.description || '';
      pt.title = b.description || '';
      let del = null;
      if (b.auto) {
        del = document.createElement('button');
        del.type = 'button';
        del.className = 'sc-del';
        del.textContent = '删除';
        del.title = '删除按钮 ' + b.name;
        del.addEventListener('click', async () => {
          del.disabled = true;
          try {
            const r = await fetch('/api/buttons/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: b.id }),
            });
            const res = await r.json().catch(() => ({}));
            if (res.ok) {
              showToast('已删除: ' + b.name, 'ok');
              await refreshButtons();
            } else {
              showToast('删除失败: ' + (res.error || '未知错误'), 'err');
              del.disabled = false;
            }
          } catch (e) {
            showToast('删除失败: ' + e.message, 'err');
            del.disabled = false;
          }
        });
      }
      row.appendChild(icon);
      row.appendChild(nm);
      row.appendChild(pt);
      if (del) row.appendChild(del);
      li.appendChild(row);
      // 第二行：颜色选择（点击即改卡片颜色，无需重建）
      const cols = document.createElement('div');
      cols.className = 'sc-item-colors';
      cols.title = '点击修改卡片颜色';
      SHORTCUT_COLORS.forEach((c) => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'sc-color sc-color-sm' + (c.toLowerCase() === (b.color || '').toLowerCase() ? ' active' : '');
        sw.style.background = c;
        sw.title = '改为 ' + c;
        sw.addEventListener('click', async () => {
          if (c.toLowerCase() === (b.color || '').toLowerCase()) return;
          sw.disabled = true;
          try {
            const r = await fetch('/api/buttons/update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: b.id, color: c }),
            });
            const res = await r.json().catch(() => ({}));
            if (res.ok) {
              await refreshButtons();
            } else {
              showToast('改色失败: ' + (res.error || '未知错误'), 'err');
              sw.disabled = false;
            }
          } catch (e) {
            showToast('改色失败: ' + e.message, 'err');
            sw.disabled = false;
          }
        });
        cols.appendChild(sw);
      });
      // 第二行：颜色 + 尺寸 + 模式（点击即改，无需重建）
      const edit = document.createElement('div');
      edit.className = 'sc-item-edit';
      const sizes = document.createElement('div');
      sizes.className = 'sc-item-sizes';
      const curSize = b.size || 'small';
      const targetSize = curSize === 'small' ? 'wide' : 'small';
      const sb = document.createElement('button');
      sb.type = 'button';
      sb.className = 'sc-size-opt';
      sb.textContent = '⇄ ' + (targetSize === 'wide' ? '宽卡' : '小卡');
      sb.title = '当前' + (curSize === 'small' ? '小卡' : '宽卡') + '，点击改为' + (targetSize === 'wide' ? '宽卡' : '小卡');
      sb.addEventListener('click', async () => {
        sb.disabled = true;
        try {
          const r = await fetch('/api/buttons/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: b.id, size: targetSize }),
          });
          const res = await r.json().catch(() => ({}));
          if (res.ok) {
            await refreshButtons();
          } else {
            showToast('改尺寸失败: ' + (res.error || '未知错误'), 'err');
            sb.disabled = false;
          }
        } catch (e) {
          showToast('改尺寸失败: ' + e.message, 'err');
          sb.disabled = false;
        }
      });
      sizes.appendChild(sb);
      // 模式选择：multi-checkbox 标签（v5 feedback 2：支持多模式同时可见）
      // 变更即 PATCH /api/buttons/update —— 写整个新模式数组（其它字段不在 PATCH）
      const modeBox = document.createElement('div');
      modeBox.className = 'sc-item-modes';
      modeBox.title = '勾选要包含的模式；不勾 = 全部模式可见';
      const tagsWrap = renderModeTags(b.mode, async (newMode) => {
        try {
          const r = await fetch('/api/buttons/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: b.id, mode: newMode }),
          });
          const res = await r.json().catch(() => ({}));
          if (res.ok) {
            const label = newMode === '__hidden__'
              ? '隐藏'
              : (newMode
                  ? (Array.isArray(newMode) ? newMode.map(modeLabel).join('+') : modeLabel(newMode))
                  : '全部模式');
            showToast('已更新模式: ' + label, 'ok');
            await refreshButtons();
          } else {
            showToast('改模式失败: ' + (res.error || '未知错误'), 'err');
          }
        } catch (e) {
          showToast('改模式失败: ' + e.message, 'err');
        }
      });
      modeBox.appendChild(tagsWrap);
      edit.appendChild(cols);
      edit.appendChild(sizes);
      edit.appendChild(modeBox);
      li.appendChild(edit);
      ul.appendChild(li);
    }
  }

  // 通用添加入口（表单按钮 / 文件拖放共用），返回是否成功
  async function addShortcut(nameVal, rawPath, color, size, mode) {
    let p = (rawPath || '').trim();
    // 与后端一致：自动剥掉首尾成对的双引号（地址栏/命令行复制的路径常自带）
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).trim();
    if (!p) { showToast('请填写程序路径', 'err'); return false; }
    try {
      const r = await fetch('/api/buttons/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameVal, path: p, color: color, size: size, mode: mode != null ? mode : null }),
      });
      const res = await r.json().catch(() => ({}));
      if (res.ok) {
        showToast('已添加: ' + (nameVal || p), 'ok');
        await refreshButtons();
        return true;
      }
      showToast('添加失败: ' + (res.error || '未知错误'), 'err');
    } catch (e) {
      showToast('添加失败: ' + e.message, 'err');
    }
    return false;
  }

  function initShortcutPanel() {
    const colorsWrap = document.getElementById('sc-colors');
    if (colorsWrap) {
      SHORTCUT_COLORS.forEach((c) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sc-color' + (c === scColor ? ' active' : '');
        btn.dataset.color = c;
        btn.style.background = c;
        btn.title = c;
        btn.addEventListener('click', () => {
          scColor = c;
          colorsWrap.querySelectorAll('.sc-color').forEach((b) => b.classList.toggle('active', b.dataset.color === c));
        });
        colorsWrap.appendChild(btn);
      });
    }
    const sizeWrap = document.getElementById('sc-size');
    if (sizeWrap) {
      sizeWrap.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          scSize = btn.dataset.size;
          sizeWrap.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.size === scSize));
        });
      });
    }
    // 动态填充 sc-mode multi-tag（v5 feedback 2：checkbox 多选）
    const scModeSelect = document.getElementById('sc-mode');
    if (scModeSelect) {
      scModeSelect.innerHTML = '';
      scModeSelect.appendChild(renderModeTags(scMode, (newMode) => {
        scMode = newMode;
      }));
    }
    const addBtn = document.getElementById('sc-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const pathEl = document.getElementById('sc-path');
        const nameEl = document.getElementById('sc-name');
        const pathVal = ((pathEl && pathEl.value) || '').trim();
        const nameVal = ((nameEl && nameEl.value) || '').trim();
        addBtn.disabled = true;
        const ok = await addShortcut(nameVal, pathVal, scColor, scSize, scMode);
        if (ok) {
          if (nameEl) nameEl.value = '';
          if (pathEl) pathEl.value = '';
          // 重置 sc-mode 多选标签：清空 + 重新渲染全部（保留"全部"勾选）
          if (scModeSelect) {
            scMode = null;
            scModeSelect.innerHTML = '';
            scModeSelect.appendChild(renderModeTags(null, (newMode) => {
              scMode = newMode;
            }));
          }
        }
        addBtn.disabled = false;
      });
    }

    // 文件拖放添加：把 .exe / .lnk 拖进页面即自动添加（Chromium 提供 file.path）
    const overlay = document.getElementById('drop-overlay');
    const hasFiles = (e) => {
      const types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
    };
    let dragDepth = 0;
    const showOverlay = (on) => { if (overlay) overlay.classList.toggle('show', on); };
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      showOverlay(true);
    });
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) showOverlay(false);
    });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      showOverlay(false);
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []);
      if (!files.length) return;
      (async () => {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const item = items[i];
          const name = f.name || '';
          // 优先 file.path（Chromium 对部分来源不填充）；回退 webkitGetAsEntry().fullPath（.lnk 拖入也有效）
          let p = f.path || '';
          if (!p && item && item.webkitGetAsEntry) {
            try {
              const entry = item.webkitGetAsEntry();
              if (entry && entry.fullPath) {
                p = entry.fullPath.replace(/^\//, '');
                if (/^[a-zA-Z]:\//.test(p)) p = p.replace('/', '\\');
              }
            } catch (err) { /* 忽略 */ }
          }
          if (!p) { showToast('无法读取文件路径（' + name + '），请改用粘贴方式', 'err'); continue; }
          const ext = p.split('.').pop().toLowerCase();
          if (ext !== 'exe' && ext !== 'lnk') { showToast('已忽略非程序文件: ' + name, 'warn'); continue; }
          await addShortcut('', p, scColor, scSize);
        }
      })();
    });

    // 已添加列表：标题展开/收起（持久化）
    const listToggle = document.getElementById('sc-list-toggle');
    if (listToggle) {
      const scUl = document.getElementById('sc-list');
      if (localStorage.getItem('workbench-fold-shortcutlist') === '1') {
        listToggle.setAttribute('aria-expanded', 'false');
        if (scUl) scUl.classList.add('collapsed');
      }
      listToggle.addEventListener('click', () => {
        const collapsed = scUl ? scUl.classList.toggle('collapsed') : false;
        listToggle.setAttribute('aria-expanded', String(!collapsed));
        localStorage.setItem('workbench-fold-shortcutlist', collapsed ? '1' : '0');
      });
    }
  }

  // ---- 设置面板：RSS 订阅源管理（增删；数据同样驱动 sys-rss 信息卡） ----
  let feedsSig = '';

  function renderFeedsPanel() {
    const ul = document.getElementById('rss-list');
    if (!ul) return;
    const sig = feedsList.map((f) => [f.id, f.name, f.url, f.mode != null ? (Array.isArray(f.mode) ? f.mode.join(',') : f.mode) : ''].join('|')).join('\n');
    if (sig === feedsSig && ul.childElementCount) return;
    feedsSig = sig;
    ul.innerHTML = '';
    if (!feedsList.length) {
      const li = document.createElement('li');
      li.className = 'sc-empty';
      li.textContent = '还没有订阅源，填写地址后点「添加订阅源」';
      ul.appendChild(li);
      return;
    }
    for (const f of feedsList) {
      const li = document.createElement('li');
      li.className = 'sc-item';
      const row = document.createElement('div');
      row.className = 'sc-item-row';
      const icon = document.createElement('span');
      icon.className = 'sc-item-icon';
      icon.textContent = '≡';
      const nm = document.createElement('span');
      nm.className = 'sc-item-name';
      nm.textContent = f.name;
      const pt = document.createElement('span');
      pt.className = 'sc-item-path';
      pt.textContent = f.url;
      pt.title = f.url;
      row.appendChild(icon);
      row.appendChild(nm);
      row.appendChild(pt);
      // 模式标签不展示（用户反馈"娱乐标签没必要展示"——管理面板也省去视觉噪声）
      // 工作模式只读：不渲染删除按钮（CSS body[data-readonly="true"] .sc-del 兜底隐藏）
      if (!isReadonlyMode()) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'sc-del';
        del.textContent = '删除';
        del.title = '删除订阅源 ' + f.name;
        del.addEventListener('click', async () => {
          del.disabled = true;
          try {
            const r = await fetch('/api/feeds/' + encodeURIComponent(f.id), { method: 'DELETE' });
            const res = await r.json().catch(() => ({}));
            if (res.ok) {
              showToast('已删除: ' + f.name, 'ok');
              await refreshFeedsData(true);
            } else {
              showToast('删除失败: ' + (res.error || '未知错误'), 'err');
              del.disabled = false;
            }
          } catch (e) {
            showToast('删除失败: ' + e.message, 'err');
            del.disabled = false;
          }
        });
        row.appendChild(del);
      }
      li.appendChild(row);
      ul.appendChild(li);
    }
  }

  // force 为 true 时强制重渲（删源后条目数量可能不变，但内容变了）
  async function refreshFeedsData(force) {
    try {
      const data = await fetchJSON('/api/feeds');
      feedsList = data.feeds || [];
    } catch (e) {
      feedsList = [];
    }
    if (force) feedsSig = '';
    renderFeedsPanel();
    renderModeManager(); // v5 feedback 3：模式管理区跟随数据刷新
  }

  function initRssPanel() {
    // 动态填充 RSS 订阅源添加表单的 mode multi-tag（v5 feedback 2：checkbox 多选）
    const rssModeSelect = document.getElementById('rss-mode');
    let rssPanelMode = null; // 当前表单选中的模式（null = 全部模式）
    if (rssModeSelect) {
      rssModeSelect.innerHTML = '';
      rssModeSelect.appendChild(renderModeTags(rssPanelMode, (newMode) => {
        rssPanelMode = newMode;
      }));
    }
    const addBtn2 = document.getElementById('rss-add-btn');
    if (addBtn2) {
      addBtn2.addEventListener('click', async () => {
        const nameEl = document.getElementById('rss-name');
        const urlEl = document.getElementById('rss-url');
        const name = ((nameEl && nameEl.value) || '').trim();
        const url = ((urlEl && urlEl.value) || '').trim();
        const mode = rssPanelMode; // null=全部模式 或 字符串数组
        if (!name || !url) { showToast('名称和地址都不能为空', 'err'); return; }
        addBtn2.disabled = true;
        try {
          const r = await fetch('/api/feeds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, url, mode }),
          });
          const res = await r.json().catch(() => ({}));
          if (res.ok) {
            showToast('已添加订阅源: ' + name, 'ok');
            if (nameEl) nameEl.value = '';
            if (urlEl) urlEl.value = '';
            if (modeEl) modeEl.value = '';
            await refreshFeedsData(true);
            await refreshRss(); // 立即抓一次，卡片马上有内容
          } else {
            showToast('添加失败: ' + (res.error || '未知错误'), 'err');
          }
        } catch (e) {
          showToast('添加失败: ' + e.message, 'err');
        }
        addBtn2.disabled = false;
      });
    }
    // 已添加列表：标题展开/收起（持久化，与快捷方式列表同款交互）
    const listToggle = document.getElementById('rss-list-toggle');
    if (listToggle) {
      const rssUl = document.getElementById('rss-list');
      if (localStorage.getItem('workbench-fold-rsslist') === '1') {
        listToggle.setAttribute('aria-expanded', 'false');
        if (rssUl) rssUl.classList.add('collapsed');
      }
      listToggle.addEventListener('click', () => {
        const collapsed = rssUl ? rssUl.classList.toggle('collapsed') : false;
        listToggle.setAttribute('aria-expanded', String(!collapsed));
        localStorage.setItem('workbench-fold-rsslist', collapsed ? '1' : '0');
      });
    }
    refreshFeedsData();
  }

  // ---- 模式管理区（v5 feedback 3）—— 统一查看 + inline 编辑所有内容mode 字段 ----
  // 3 类：功能按钮（普通按钮，排除 dida/push/toggle/系统卡） / 书签 / RSS 源
  // 每行展示：图标 + 名称 + 当前模式标签 + multi-tag 编辑器（实时 PATCH/POST）
  // 持久化：刷新按钮/书签/RSS 后重新拉取并重渲染（refreshButtons/refreshBookmarks/refreshFeedsData 都在 init 末轮询）
  // 注：手动配置的普通按钮只能看到，不能在这里编辑（buttons.json 是配置文件，没 UI 入口）
  function initModeManager() {
    renderModeManager();
  }

  function renderModeManager() {
    const root = document.getElementById('mode-manager-list');
    if (!root) return;
    root.innerHTML = '';
    // 分组 1：书签（inline 编辑）
    if (bookmarks.length > 0) {
      root.appendChild(renderModeManagerGroup('bookmark', '书签', bookmarks.map((b) => ({
        key: 'bookmark:' + b.id,
        icon: b.url ? '🔖' : '★',
        name: b.name,
        title: b.url,
        mode: b.mode,
        onChange: (newMode) => patchBookmark(b.id, newMode),
      }))));
    }
    // 分组 2：RSS 源（inline 编辑）
    if (feedsList.length > 0) {
      root.appendChild(renderModeManagerGroup('feed', 'RSS 订阅源', feedsList.map((f) => ({
        key: 'feed:' + f.id,
        icon: '≡',
        name: f.name,
        title: f.url,
        mode: f.mode,
        onChange: (newMode) => patchFeed(f.id, newMode),
      }))));
    }
    // 分组 3：auto 按钮（快捷方式；inline 编辑走 /api/buttons/update）
    const shortcuts = buttons.filter((b) => b.auto && b.command && !b.toggle && !b.kind);
    if (shortcuts.length > 0) {
      root.appendChild(renderModeManagerGroup('shortcut', '快捷方式', shortcuts.map((b) => ({
        key: 'btn:' + b.id,
        icon: b.icon ? '' : '⚙',
        name: b.name,
        title: b.description || '',
        mode: b.mode,
        onChange: (newMode) => patchButton(b.id, newMode),
      }))));
    }
    // 分组 4：手动配置按钮（不可编辑——按钮无 UI 模式编辑入口，提示用户改 buttons.json）
    const manualButtons = buttons.filter((b) => !b.auto && b.command && !b.toggle && !b.kind);
    if (manualButtons.length > 0) {
      root.appendChild(renderModeManagerGroup('manual', '手动配置按钮（mode 字段需改 buttons.json）', manualButtons.map((b) => ({
        key: 'btn:' + b.id,
        icon: '⚙',
        name: b.name,
        title: b.description || '',
        mode: b.mode,
        onChange: null, // 标记为只读
      }))));
    }
  }

  // 单个分组：标题 + 行列表（v0.8：分组标题可点击折叠，状态持久化）
  // groupId 用于 localStorage key 稳定标识——4 个分组固定：bookmark / feed / shortcut / manual
  function renderModeManagerGroup(groupId, title, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'mode-manager-group';
    wrap.dataset.groupId = groupId;
    // v0.8：折叠状态从 localStorage 恢复（默认展开；与现有 sp-section 行为一致）
    const foldKey = 'workbench-fold-mmgr-' + groupId;
    const collapsed = localStorage.getItem(foldKey) === '1';
    if (collapsed) wrap.classList.add('collapsed');
    // 标题行改为可点击 button（与 sp-title-row 视觉一致：箭头 + 文字）
    const h = document.createElement('button');
    h.type = 'button';
    h.className = 'mode-manager-group-title';
    h.setAttribute('aria-expanded', String(!collapsed));
    const icon = document.createElement('span');
    icon.className = 'sp-title-icon';
    icon.innerHTML = '&#9656;';   // 三角形，CSS rotate(90deg) = 朝下 = 展开
    const text = document.createElement('span');
    text.textContent = title + ' (' + rows.length + ')';
    h.appendChild(icon);
    h.appendChild(text);
    h.title = '点击收起 / 展开此分组';
    h.addEventListener('click', () => {
      const isCollapsed = wrap.classList.toggle('collapsed');
      h.setAttribute('aria-expanded', String(!isCollapsed));
      localStorage.setItem(foldKey, isCollapsed ? '1' : '0');
    });
    wrap.appendChild(h);
    const list = document.createElement('div');
    list.className = 'mode-manager-rows';
    for (const r of rows) {
      list.appendChild(renderModeManagerRow(r));
    }
    wrap.appendChild(list);
    return wrap;
  }

  // 单行：图标 + 名称 + multi-tag 编辑器
  function renderModeManagerRow(r) {
    const row = document.createElement('div');
    row.className = 'mode-manager-row';
    row.dataset.mmKey = r.key;
    const icon = document.createElement('span');
    icon.className = 'mode-manager-icon';
    if (r.icon && r.icon.startsWith('icons/')) {
      // 真实图标（auto 按钮 → public/icons/<id>.ico）
      const img = document.createElement('img');
      img.src = r.icon;
      img.alt = '';
      icon.appendChild(img);
    } else {
      icon.textContent = r.icon || '⚙';
    }
    const name = document.createElement('span');
    name.className = 'mode-manager-name';
    name.textContent = r.name;
    name.title = r.title || r.name;
    const tags = document.createElement('div');
    tags.className = 'mode-manager-tags';
    if (r.onChange) {
      tags.appendChild(renderModeTags(r.mode, r.onChange));
    } else {
      // 手动按钮：只读，并提示改 buttons.json
      tags.classList.add('readonly');
      tags.textContent = r.mode === '__hidden__'
        ? '隐藏'
        : (r.mode
            ? (Array.isArray(r.mode) ? r.mode.map(modeLabel).join('+') : modeLabel(r.mode))
            : '全部模式');
    }
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(tags);
    return row;
  }

  // 模式管理区行编辑：PATCH /api/bookmarks/<id>（仅 mode 字段）
  async function patchBookmark(id, newMode) {
    try {
      const r = await fetch('/api/bookmarks/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      });
      const res = await r.json().catch(() => ({}));
      if (res.ok) {
        showToast('已更新书签模式', 'ok');
        await refreshBookmarks();
      } else {
        showToast('更新失败: ' + (res.error || ''), 'err');
      }
    } catch (e) {
      showToast('更新失败: ' + e.message, 'err');
    }
  }

  // 模式管理区行编辑：PATCH /api/feeds/<id>（仅 mode 字段）
  async function patchFeed(id, newMode) {
    try {
      const r = await fetch('/api/feeds/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      });
      const res = await r.json().catch(() => ({}));
      if (res.ok) {
        showToast('已更新订阅源模式', 'ok');
        await refreshFeedsData(true);
      } else {
        showToast('更新失败: ' + (res.error || ''), 'err');
      }
    } catch (e) {
      showToast('更新失败: ' + e.message, 'err');
    }
  }

  // 模式管理区行编辑：POST /api/buttons/update（仅 mode 字段；走常规按钮更新端点）
  async function patchButton(id, newMode) {
    try {
      const r = await fetch('/api/buttons/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, mode: newMode }),
      });
      const res = await r.json().catch(() => ({}));
      if (res.ok) {
        showToast('已更新快捷方式模式', 'ok');
        await refreshButtons();
      } else {
        showToast('更新失败: ' + (res.error || ''), 'err');
      }
    } catch (e) {
      showToast('更新失败: ' + e.message, 'err');
    }
  }

  // ---- 初始化 ----
  async function init() {
    // 先加载模式定义（modes.json）：决定切换器 / 设置面板 / 只读态 / 模式白名单
    // 失败时沿用 MODES 内置默认（白名单回退 ['work']，保证工作模式正常）
    try {
      const m = await fetchJSON('/api/modes');
      if (m && Array.isArray(m.modes) && m.modes.length) {
        MODES = m;
        MODES_LOADED = true;
      }
    } catch (e) { /* ignore：沿用 MODES 默认 */ }
    applyStyle();
    initShortcutPanel();
    initRssPanel();
    initModeManager(); // v5 feedback 3：模式管理区
    // 动态渲染两处模式切换器（设置面板 + 顶栏），让 modes.json 加新模式零代码改动
    renderModeSwitchers();
    // 测试钩子：URL 含 ?mmx=1 时暴露 minimaxData setter，供 headless 浏览器模拟警示场景
    // （生产环境无副作用；测试时用 ?mmx=1# 或 ?mmx=1 启动）
    if (location.search.indexOf('mmx=1') >= 0) {
      window.__setMmx = (d) => { minimaxData = d; renderSystemCard('sys-minimax'); };
    }
    try {
      const cfg = await fetchJSON('/api/buttons');
      if (cfg && cfg.title) titleEl.textContent = cfg.title;
    } catch (e) { /* ignore */ }
    await refreshButtons();
    await refreshLogs();
    await refreshQueue();
    await refreshBookmarks();
    await refreshBalance();
    await refreshDidaToday();
    await refreshDidaFocus();
    await refreshMiniMax();
    await refreshRss();
    await refreshDshSessions(); // DSH 对话状态（feedback 2）—— 启动即拉一次
    updateRateBadge();
    setInterval(refreshButtons, 3000);
    setInterval(refreshLogs, 2000);
    setInterval(refreshQueue, 5000);
    setInterval(refreshBookmarks, 10000);
    setInterval(refreshBalance, 60000);
    setInterval(refreshDidaToday, 300000);
    setInterval(refreshDidaFocus, 300000);
    setInterval(refreshMiniMax, 300000); // MiniMax 套餐：5 分钟一次（服务端另有 60 秒缓存）
    setInterval(refreshRss, 600000); // RSS 源 10 分钟（服务端另有 15 分钟缓存兜底）
    setInterval(refreshDshSessions, 5000); // DSH 对话状态：5 秒一次（状态变化即时可见）
    // 现在时刻线每分钟刷新：任务随当前时间在「已过/未到」间滑动，线的位置与文案要跟着走
    setInterval(() => { renderSystemCard('sys-dida-today'); applyMasonry(); }, 60000);
    setInterval(updateRateBadge, 60000);
    // 窗口尺寸变化时重算瀑布流 span（响应式断点改变列数 → 卡高变化）
    window.addEventListener('resize', () => {
      clearTimeout(window.__masonryResize);
      window.__masonryResize = setTimeout(() => renderGrid(), 200);
    });
  }

  init();
})();
