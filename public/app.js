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
  let workbenchOnline = false;

  // ---- 系统信息卡定义（内置，非 buttons.json 按钮） ----
  const SYS_CARDS = {
    'sys-balance':   { id: 'sys-balance',   name: 'DeepSeek 余额', size: 'small', kind: 'stat' },
    'sys-status':    { id: 'sys-status',    name: '系统状态',      size: 'small', kind: 'status' },
    'sys-bookmarks': { id: 'sys-bookmarks', name: '书签',          size: 'small', kind: 'bookmarks' },
    'sys-dida-today':{ id: 'sys-dida-today', name: '滴答今日任务', size: 'large', kind: 'dida-today' },
    'sys-dida-focus':{ id: 'sys-dida-focus', name: '滴答专注',     size: 'small', kind: 'stat' },
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
    return [...func, 'sys-balance', 'sys-status', 'sys-bookmarks', 'sys-dida-today', 'sys-dida-focus'];
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

  // ---- 卡片尺寸 ----
  function spanClass(size) {
    if (size === 'large') return 'span-large';
    if (size === 'small') return 'span-small';
    return 'span-wide';
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
    el.innerHTML =
      '<div class="card-head"><h3><span class="card-icon"></span><span class="card-title"></span></h3><span class="badge"></span></div>' +
      '<span class="drag-hint" title="按住拖动换位">⠿</span>' +
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
    el.className = 'card stat-card ' + spanClass(def.size);
    el.dataset.id = id;
    const refs = { el };
    if (id === 'sys-balance') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>DeepSeek 余额</h3></div>' +
        '<span class="drag-hint" title="按住拖动换位">⠿</span>' +
        '<div class="stat-value">查询中...</div>';
      refs.value = el.querySelector('.stat-value');
      bindCardClick(el, () => openExternal('https://platform.deepseek.com/usage'));
    } else if (id === 'sys-status') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>系统状态</h3></div>' +
        '<span class="drag-hint" title="按住拖动换位">⠿</span>' +
        '<div class="status-list">' +
        '  <div class="status-row"><span class="row-dot"></span><span class="row-label">DeepSeek Harness</span><span class="row-value">查询中</span></div>' +
        '  <div class="status-row"><span class="row-dot"></span><span class="row-label">工作台服务</span><span class="row-value">查询中</span></div>' +
        '</div>';
      refs.rows = el.querySelectorAll('.status-row');
    } else if (id === 'sys-bookmarks') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>书签</h3>' +
        '<button class="add-btn" id="card-add-bookmark" title="添加书签">+</button></div>' +
        '<span class="drag-hint" title="按住拖动换位">⠿</span>' +
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
        '<span class="drag-hint" title="按住拖动换位">⠿</span>' +
        '<div class="dida-task-list"></div>';
      refs.list = el.querySelector('.dida-task-list');
    } else if (id === 'sys-dida-focus') {
      el.innerHTML =
        '<div class="card-head"><h3><span class="card-icon"></span>滴答专注</h3></div>' +
        '<span class="drag-hint" title="按住拖动换位">⠿</span>' +
        '<div class="stat-value">—</div>';
      refs.value = el.querySelector('.stat-value');
      // 点击卡片 → 跳转滴答清单应用（优先桌面客户端：未运行则启动、已运行则置顶；
      // 快捷方式按钮不存在时回退滴答网页）。与余额卡"点击跳转"交互一致。
      bindCardClick(el, () => {
        const app = buttons.find(x => x.id === 'app') || buttons.find(x => x.name === '滴答清单');
        if (app) runButton(app);
        else openExternal('https://www.dida365.com/webapp/');
      });
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
      if (!bookmarks.length) {
        const li = document.createElement('li');
        li.className = 'bm-card-empty';
        li.textContent = '暂无书签，点侧栏 + 添加';
        refs.list.appendChild(li);
        return;
      }
      bookmarks.slice(0, 6).forEach(bm => {
        const a = document.createElement('a');
        a.className = 'bm-item';
        a.dataset.bmId = bm.id;
        a.href = bm.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.draggable = false;
        const fav = faviconImg(bm.url);
        if (fav) a.appendChild(fav);
        a.appendChild(document.createTextNode(bm.name));
        a.title = bm.url + '（按住拖动排序）';
        refs.list.appendChild(a);
      });
    } else if (id === 'sys-dida-today') {
      // grid 布局：今日任务卡限高（每列少显示几条），避免大卡把同行的其他卡拉长
      const layout = document.body.dataset.layout || 'grid';
      // 展开 → 突破 max-height，显示全部任务（两列联动，瀑布流自动重新计算高度）
      rec.el.classList.toggle('expanded', didaTodayExpanded);
      renderDidaTodayList(refs.list, layout === 'grid' ? 5 : 8);
    } else if (id === 'sys-dida-focus') {
      renderDidaFocus(refs.value);
    }
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

  // ---- 全量渲染（keyed：复用节点，按序 append 实现排序） ----
  function renderGrid() {
    if (dragActive) return; // 拖拽中跳过，避免重排打断手势
    const order = getOrder();
    const layout = document.body.dataset.layout || 'grid';
    const sideCol = document.getElementById('side-col');
    for (const id of order) {
      if (SYS_CARDS[id]) {
        ensureSystemCard(id);
        renderSystemCard(id);
      } else {
        const b = buttons.find(x => x.id === id);
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
      // 隐藏不可见的 dida 卡片：从 DOM 移除（保留 cardCache 与顺序位，恢复可见时原地回来）
      const b = buttons.find(x => x.id === id);
      if (b && b.kind === 'dida' && b.visible === false) {
        rec.el.remove();
        continue;
      }
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
    bookmarkList.innerHTML = '';
    if (bookmarks.length === 0) {
      const li = document.createElement('li');
      li.className = 'bookmark-empty';
      li.textContent = '暂无书签，点 + 添加';
      bookmarkList.appendChild(li);
    } else {
      for (const bm of bookmarks) {
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

        const del = document.createElement('button');
        del.className = 'bm-del';
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

        bookmarkList.appendChild(li);
      }
    }
    renderGrid();
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

  function openModal() {
    bmName.value = '';
    bmUrl.value = '';
    modal.classList.remove('hidden');
    bmName.focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  async function saveBookmark() {
    const name = bmName.value.trim();
    let url = bmUrl.value.trim();
    if (!name || !url) {
      alert('名称和网址都不能为空');
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const data = await fetchJSON('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url }),
      });
      if (data.ok) {
        closeModal();
        refreshBookmarks();
      } else {
        alert('添加失败: ' + (data.error || '未知错误'));
      }
    } catch (e) {
      alert('添加失败: ' + e.message);
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

  // ---- 样式设置（主题 + 布局 + 六个偏好开关，localStorage 持久化） ----
  const THEME_KEY = 'workbench-theme';
  const LAYOUT_KEY = 'workbench-layout';
  const SIDEBAR_KEY = 'workbench-sidebar';
  const BIGNUM_KEY = 'workbench-bignum';
  const COUNTUP_KEY = 'workbench-countup';
  const ICONS_KEY = 'workbench-icons';
  const styleBtn = document.getElementById('style-btn');
  const stylePanel = document.getElementById('style-panel');

  const SWITCH_IDS = {
    'sidebar-switch': SIDEBAR_KEY,
    'bignum-switch': BIGNUM_KEY,
    'countup-switch': COUNTUP_KEY,
    'icons-switch': ICONS_KEY,
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
    document.querySelectorAll('.sp-opt[data-theme-opt]').forEach(el => {
      el.classList.toggle('active', el.dataset.themeOpt === theme);
    });
    document.querySelectorAll('.sp-opt[data-layout-opt]').forEach(el => {
      el.classList.toggle('active', el.dataset.layoutOpt === layout);
    });
    renderGrid(); // 布局/开关变化时重渲染（keyed 复用，开销极小）
  }

  function setStyle(kind, value) {
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
      const key = SWITCH_IDS[sw.id];
      const next = localStorage.getItem(key) === 'off' ? 'on' : 'off';
      localStorage.setItem(key, next);
      applyStyle();
    }
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
      // 第二行：颜色 + 尺寸（点击即改，无需重建）
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
      edit.appendChild(cols);
      edit.appendChild(sizes);
      li.appendChild(edit);
      ul.appendChild(li);
    }
  }

  // 通用添加入口（表单按钮 / 文件拖放共用），返回是否成功
  async function addShortcut(nameVal, rawPath, color, size) {
    let p = (rawPath || '').trim();
    // 与后端一致：自动剥掉首尾成对的双引号（地址栏/命令行复制的路径常自带）
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).trim();
    if (!p) { showToast('请填写程序路径', 'err'); return false; }
    try {
      const r = await fetch('/api/buttons/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameVal, path: p, color: color, size: size }),
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
    const addBtn = document.getElementById('sc-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const pathEl = document.getElementById('sc-path');
        const nameEl = document.getElementById('sc-name');
        const pathVal = ((pathEl && pathEl.value) || '').trim();
        const nameVal = ((nameEl && nameEl.value) || '').trim();
        addBtn.disabled = true;
        const ok = await addShortcut(nameVal, pathVal, scColor, scSize);
        if (ok) {
          if (nameEl) nameEl.value = '';
          if (pathEl) pathEl.value = '';
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

  // ---- 初始化 ----
  async function init() {
    applyStyle();
    initShortcutPanel();
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
    updateRateBadge();
    setInterval(refreshButtons, 3000);
    setInterval(refreshLogs, 2000);
    setInterval(refreshQueue, 5000);
    setInterval(refreshBookmarks, 10000);
    setInterval(refreshBalance, 60000);
    setInterval(refreshDidaToday, 300000);
    setInterval(refreshDidaFocus, 300000);
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
