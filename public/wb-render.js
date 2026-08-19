// =============================================================
// wb-render.js · 工作台前端
// =============================================================
//
// 职责：
//   - 卡片顺序管理（WB.getOrder / WB.setOrder / WB.defaultOrder，localStorage 持久化）
//   - 卡片尺寸（WB.spanClass：small/large/wide → span-small/large/wide）
//   - keyed 渲染缓存（WB.cardCache / WB.dragActive）—— 轮询刷新复用 DOM，不打断拖拽
//   - 卡片创建（WB.ensureFuncCard / WB.ensureSystemCard：首次创建 DOM + 引用缓存）
//   - 内容渲染（WB.renderFuncCard / WB.renderSystemCard：按数据重渲卡片内容）
//   - 系统卡专用渲染（WB.renderMiniMaxCard / WB.renderDidaTodayList / WB.renderDidaFocus /
//     WB.renderDshSessionsCard / WB.renderRssList）+ WB.completeTask
//   - 全量渲染入口（WB.renderGrid）
//   - Bento 瀑布流（WB.applyMasonry + MASONRY_ROW / MASONRY_GAP）
//   - 卡片整体点击（WB.bindCardClick）+ 书签小图标（WB.faviconImg）
//
// 设计：
//   - 加载顺序：先于 wb-action / wb-bookmarks / wb-drag / wb-search / wb-settings
//     （本文件是它们的"渲染入口"——它们内部调 WB.renderGrid / WB.applyMasonry 等）
//   - 所有共享状态从 WB.xxx 读取（无本地视图，无双写）
//   - 跨文件函数调用一律用 WB.xxx()（运行时查找）—— showToast / openExternal / openModal /
//     runButton / completeTask / faviconImg / reportClientError 等可能在 wb-action / wb-bookmarks
//   - WB.cardCache / WB.dragActive 暴露给 app.js（setMode / renderRssForReRender 需要）
//   - 内部 const 引用（顶部 const SYS_CARDS = WB.SYS_CARDS 等）仅为简短访问，不跨文件共享
// =============================================================

(function () {
  'use strict';

  window.WB = window.WB || {};

  // ===== 共享引用（从 wb-core / wb-mode 读） =====
  const SYS_CARDS = WB.SYS_CARDS;
  const CARD_ICONS = WB.CARD_ICONS;
  const applyCardIcon = WB.applyCardIcon;
  const setNum = WB.setNum;
  const grid = WB.grid;
  const fetchJSON = WB.fetchJSON;
  const reportClientError = WB.reportClientError;
  // 模式（从 wb-mode 读）
  const isReadonlyMode = WB.isReadonlyMode;
  const modeMatches = WB.modeMatches;

  // ===== 顺序管理 =====
  // 卡片顺序持久化（localStorage，仅本机浏览器）
  const ORDER_KEY = 'workbench-card-order';

  function defaultOrder() {
    const func = (WB.buttons || []).map((b) => b.id);
    return [...func, 'sys-balance', 'sys-status', 'sys-dsh-sessions', 'sys-bookmarks', 'sys-dida-today', 'sys-dida-focus', 'sys-minimax', 'sys-rss'];
  }

  function getOrder() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(ORDER_KEY)); } catch (e) { saved = null; }
    const base = defaultOrder();
    if (!Array.isArray(saved)) return base;
    const known = new Set(base);
    const merged = saved.filter((id) => known.has(id));
    for (const id of base) if (!merged.includes(id)) merged.push(id);
    return merged;
  }

  function setOrder(order) {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch (e) { /* 忽略 */ }
  }

  WB.getOrder = getOrder;
  WB.setOrder = setOrder;
  WB.defaultOrder = defaultOrder;

  // ===== 卡片尺寸 =====
  function spanClass(size) {
    if (size === 'large') return 'span-large';
    if (size === 'small') return 'span-small';
    return 'span-wide';
  }
  WB.spanClass = spanClass;

  // ===== keyed 渲染：卡片缓存 =====
  // 轮询刷新复用 DOM，不打断拖拽
  const cardCache = new Map(); // id -> { el, refs, current }
  let dragActive = false;
  WB.cardCache = cardCache;
  WB.dragActive = false; // 通过 setter / getter 同步——见 WB.cardCache 段
  // 实际让 wb-render.js 内部维护 dragActive 状态，外部通过 WB.getDragActive()/setDragActive 访问
  // 简单起见：直接暴露引用
  Object.defineProperty(WB, 'dragActive', {
    get: () => dragActive,
    set: (v) => { dragActive = v; },
  });

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
      if (rec.current && WB.runButton) WB.runButton(rec.current);
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
      bindCardClick(el, () => WB.openExternal && WB.openExternal('https://platform.deepseek.com/usage'));
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
        if (!WB.dshSessions || WB.dshSessions.status === 'offline' || WB.dshSessions.status === 'error') {
          if (WB.showToast) WB.showToast('DSH 当前离线，无法跳转', 'warn');
        } else {
          if (WB.openExternal) WB.openExternal('http://127.0.0.1:3080/');
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
        if (WB.openModal) WB.openModal();
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
        const buttons = WB.buttons || [];
        const app = buttons.find((x) => x.id === 'app') || buttons.find((x) => x.name === '滴答清单');
        if (app && WB.runButton) WB.runButton(app);
        else if (WB.openExternal) WB.openExternal('https://www.dida365.com/webapp/');
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
            '<div class="mmx-bar"><div class="mmx-bar-fill"></div><div class="mmx-bar-marker"><svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M 5 0 Q 10 5, 5 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg></div></div>' +
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
          marker: el.querySelector('.mmx-row[data-window="week"] .mmx-bar-marker'),
          pct: el.querySelector('.mmx-row[data-window="week"] .mmx-pct'),
          sub: el.querySelector('.mmx-row[data-window="week"] .mmx-sub'),
        },
      };
      refs.meta = el.querySelector('.mmx-meta');
      refs.alert = el.querySelector('.mmx-alert');
      refs.value = el.querySelector('.stat-value'); // 错误态用
      bindCardClick(el, () => WB.openExternal && WB.openExternal('https://platform.minimaxi.com/console/personal-info'));
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

  WB.ensureFuncCard = ensureFuncCard;
  WB.ensureSystemCard = ensureSystemCard;

  // ===== 渲染功能卡内容 =====
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
      const queueInfo = WB.queueInfo;
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
      if (WB.isPeakHour(new Date())) {
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
    let disabled = !!(WB.busy && WB.busy[b.id]);
    if (b.toggle) {
      label = b.action.label;
    } else if (b.kind === 'push') {
      if (WB.busy && WB.busy[b.id]) {
        label = '执行中...';
      } else if (b.locked) {
        label = '锁定中 · 剩余 ' + b.lockedMinutes + ' 分钟';
        disabled = true;
      } else {
        label = 'Push';
      }
    } else if (WB.busy && WB.busy[b.id]) {
      label = '执行中...';
    }
    refs.btn.textContent = label;
    refs.btn.style.background = b.toggle
      ? (b.action.color || 'var(--accent-deep)')
      : (b.color || 'var(--accent-deep)');
    refs.btn.disabled = disabled;
    // 执行中给按钮加 busy 类，触发 CSS 脉冲动画（"按下后动起来"的执行反馈）
    refs.btn.classList.toggle('busy', !!(WB.busy && WB.busy[b.id]));
  }

  WB.renderFuncCard = renderFuncCard;

  // ===== 渲染系统卡内容 =====
  function renderSystemCard(id) {
    const rec = ensureSystemCard(id);
    const { refs } = rec;
    const countupOn = (document.body.dataset.countup || 'on') === 'on';
    if (id === 'sys-balance') {
      if (!WB.balanceData) return;
      if (!WB.balanceData.ok) {
        refs.value.className = 'stat-value err';
        refs.value.textContent = '获取失败';
        refs.value.title = WB.balanceData.error || '';
        return;
      }
      refs.value.title = '';
      const total = WB.balanceData.total;
      if (total < 1) {
        refs.value.className = 'stat-value err';
        refs.value.textContent = '余额不足';
      } else {
        refs.value.className = 'stat-value';
        setNum(refs.value, total, countupOn, (v) => '¥' + v.toFixed(2));
      }
    } else if (id === 'sys-status') {
      const buttons = WB.buttons || [];
      const dsh = buttons.find((b) => b.port === 3080);
      const rows = [
        {
          dotCls: dsh ? (dsh.running ? 'ok' : 'off') : 'off',
          label: 'DeepSeek Harness',
          value: dsh ? (dsh.running ? '运行中' : '已停止') : '未知',
        },
        {
          dotCls: WB.workbenchOnline ? 'ok' : 'off',
          label: '工作台服务',
          value: WB.workbenchOnline ? '在线' : '离线',
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
      const bookmarks = WB.bookmarks || [];
      const modeFiltered = bookmarks.filter((bm) => modeMatches(bm.mode));
      const shown = WB.searchQ ? modeFiltered.filter(WB.bmMatches) : modeFiltered;
      if (!shown.length) {
        const li = document.createElement('li');
        li.className = 'bm-card-empty';
        li.textContent = WB.searchQ ? '没有匹配的书签' : (modeFiltered.length === 0 && bookmarks.length > 0 ? '当前模式下没有书签' : '暂无书签，点侧栏 + 添加');
        refs.list.appendChild(li);
        return;
      }
      shown.slice(0, 6).forEach((bm) => {
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
        const fav = WB.faviconImg && WB.faviconImg(bm.url);
        if (fav) a.appendChild(fav);
        a.appendChild(document.createTextNode(bm.name));
        a.title = bm.url;
        item.appendChild(a);
        // 编辑按钮：娱乐模式才渲染，复用 WB.openModal(bm.id)
        if (!isReadonlyMode()) {
          const edit = document.createElement('button');
          edit.type = 'button';
          edit.className = 'bm-edit-inline bm-remove';
          edit.textContent = '✎';
          edit.title = '编辑（修改名称 / 网址 / 显示模式）';
          edit.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (WB.openModal) WB.openModal(bm.id);
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

  WB.renderSystemCard = renderSystemCard;

  // ===== MiniMax 套餐渲染 =====
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
    const minimaxData = WB.minimaxData;
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
    let expectedRemainingPct = null;
    if (pctW != null && wweek && wweek.resetAt) {
      const ms = wweek.resetAt * 1000 - now;
      daysToReset = Math.max(0.1, ms / 86400000);
      const weeklyRemainingInHours = (pctW / 100) * ratio;
      dailyPace = weeklyRemainingInHours / daysToReset;
      // 「按节奏应剩」标记线（2026-08-18 新增）：用 API 返回的 windowMinutes（动态周期）作分母，
      // 应剩余 = 剩余时间 / 总周期。fill 长度 < marker 位置 = 实际剩余比应剩多 = 用得太少。
      if (wweek.windowMinutes && wweek.windowMinutes > 0) {
        expectedRemainingPct = Math.max(0, Math.min(100, (ms / (wweek.windowMinutes * 60 * 1000)) * 100));
      }
    }
    // 写 marker 位置（null → 隐藏，e.g. windowMinutes 缺失 / resetAt 已过）
    const marker = refs.rows.week.marker;
    if (marker) {
      if (expectedRemainingPct != null) {
        marker.style.left = expectedRemainingPct.toFixed(2) + '%';
        marker.style.display = '';
        marker.title = '按节奏应剩 ' + expectedRemainingPct.toFixed(1) + '%（窗口总 ' + (wweek && wweek.windowMinutes ? Math.round(wweek.windowMinutes / 60) + 'h' : '?') + '）';
      } else {
        marker.style.display = 'none';
        marker.title = '';
      }
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

  WB.renderMiniMaxCard = renderMiniMaxCard;

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

  WB.formatResetIn = formatResetIn;

  // ===== 滴答今日任务列表渲染 =====
  // maxShow：每列最多显示条数（grid 布局传 5 限高，split/list 传 8 显示更多）
  // didaTodayExpanded：整体展开状态（点击任一列「还有 N 项」两列联动展开/收起；页面刷新恢复折叠）
  let didaTodayExpanded = false;

  function renderDidaTodayList(listEl, maxShow) {
    listEl.innerHTML = '';
    const didaToday = WB.didaToday;
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
    const allDayTasks = didaToday.tasks.filter((t) => t.allDay);
    const timedTasks = didaToday.tasks.filter((t) => !t.allDay);
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
        const past = tasks.filter((t) => t.time && t.time <= nowStr);
        const future = tasks.filter((t) => !t.time || t.time > nowStr);
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
        (didaTodayExpanded ? seg.tasks : seg.tasks.slice(0, MAX_SHOW)).forEach((t) => ul.appendChild(taskItem(t)));
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
          WB.renderGrid && WB.renderGrid();
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
        WB.renderGrid && WB.renderGrid();
      });
      listEl.appendChild(bar);
    }
  }

  WB.renderDidaTodayList = renderDidaTodayList;

  // ===== 点击完成任务 =====
  // 调服务端 MCP complete_task，成功后本地移除并重新渲染
  async function completeTask(t) {
    if (!t || !t.projectId || !t.id) {
      if (WB.showToast) WB.showToast('该任务缺少项目信息，无法完成', 'err');
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
      if (WB.didaToday && Array.isArray(WB.didaToday.tasks)) {
        WB.didaToday.tasks = WB.didaToday.tasks.filter((x) => x.id !== t.id);
        WB.didaToday.count = WB.didaToday.tasks.length;
      }
      if (WB.showToast) WB.showToast('已完成: ' + t.title);
      WB.renderGrid && WB.renderGrid();
    } catch (e) {
      if (WB.showToast) WB.showToast('完成失败: ' + e.message, 'err');
      reportClientError('completeTask: ' + e.message);
    }
  }

  WB.completeTask = completeTask;

  // ===== 今日专注时长渲染 =====
  function renderDidaFocus(valueEl) {
    const didaFocus = WB.didaFocus;
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

  WB.renderDidaFocus = renderDidaFocus;

  // ===== DSH 对话状态卡渲染 =====
  // v0.6.2 二态可见：working / pending；移除 unread
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
    const dshSessions = WB.dshSessions;
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

  WB.renderDshSessionsCard = renderDshSessionsCard;

  // ===== RSS 信息卡渲染 =====
  function fmtRssDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0');
  }

  function renderRssList(listEl) {
    listEl.innerHTML = '';
    if (!WB.rssData) {
      const p = document.createElement('div');
      p.className = 'rss-item rss-empty';
      p.textContent = '读取中...';
      listEl.appendChild(p);
      return;
    }
    // 按 mode 过滤（feedsList 含 mode 字段，rssData.feeds 含抓取后的内容）——
    // 服务端 /api/rss 不感知 mode（currentMode 是客户端态），前端按 feedsList 列表过滤
    const modeMap = new Map(((WB.feedsList) || []).map((f) => [f.id, f.mode]));
    const visibleFeeds = (WB.rssData.feeds || []).filter((f) => modeMatches(modeMap.get(f.id)));
    if (!visibleFeeds.length) {
      const p = document.createElement('div');
      p.className = 'rss-item rss-empty';
      p.textContent = (WB.rssData.feeds || []).length > 0 ? '当前模式下没有订阅源' : '暂无订阅源：样式 → RSS 订阅 中添加';
      listEl.appendChild(p);
      return;
    }
    for (const f of visibleFeeds) {
      const h = document.createElement('div');
      h.className = 'rss-feed-title' + (f.ok === false ? ' err' : '') + (f.stale ? ' stale' : '');
      h.textContent = f.name || f.feedTitle || f.url;
      h.title = f.url + (f.ok === false ? '\n获取失败: ' + (f.error || '') : (f.stale ? '\n本次抓取失败，显示上次缓存内容' : ''));
      if (f.url) {
        h.addEventListener('click', () => WB.openExternal && WB.openExternal(f.url));
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

  WB.renderRssList = renderRssList;

  // ===== 全量渲染 =====
  // keyed：复用节点，按序 append 实现排序
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
        const buttons = WB.buttons || [];
        const b = buttons.find((x) => x.id === id);
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
      const buttons = WB.buttons || [];
      const b = buttons.find((x) => x.id === id);
      if (b && !modeMatches(b.mode)) {
        rec.el.remove();
        continue;
      }
      // 隐藏不可见的 dida 卡片：从 DOM 移除（保留 cardCache 与顺序位，恢复可见时原地回来）
      const b2 = buttons.find((x) => x.id === id);
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
      rec.el.style.display = (!WB.searchQ || (WB.cardMatchesSearch && WB.cardMatchesSearch(id))) ? '' : 'none';
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

  WB.renderGrid = renderGrid;

  // ===== Bento 网格瀑布流 =====
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
    const heights = cards.map((c) => c.getBoundingClientRect().height);
    grid.style.gridAutoRows = MASONRY_ROW + 'px';
    cards.forEach((c, i) => {
      const span = Math.max(1, Math.ceil((heights[i] + MASONRY_GAP) / (MASONRY_ROW + MASONRY_GAP)));
      c.style.gridRowEnd = 'span ' + span;
    });
  }

  WB.applyMasonry = applyMasonry;

  // ===== 卡片整体点击（信息卡用） =====
  // 拖拽只从 ⠿ 手柄触发（document mousedown），
  // 手柄拖拽产生的 click 已被 suppressClick 吞掉，能走到这里的都是真实点击
  function bindCardClick(el, fn) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.drag-hint')) return; // 拖拽手柄不触发卡片动作
      fn(e);
    });
  }

  WB.bindCardClick = bindCardClick;
})();
