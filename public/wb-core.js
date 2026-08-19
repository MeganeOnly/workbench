// 工作台核心模块（v1.2 拆分第一步）
// 职责：
//   - 共享 DOM 引用（grid / logsList / dot / statusText / titleEl）
//   - 系统信息卡定义 + 卡片图标（Unicode + 软件自身图标）
//   - 数字滚动动画（animateValue / setNum）
//   - 数据获取（fetchJSON，统一错误处理）
//   - 客户端错误上报（window error / unhandledrejection → /api/log-client-error）
// 设计：
//   - 本文件必须先于 app.js 加载（app.js 内部代码依赖这里挂到 window 的变量）
//   - 所有导出挂到 window.WB 命名空间，避免污染全局
//   - 不持有任何"业务状态"——纯工具 + 元数据
//   - 拆分前位于 app.js line 5-189（共享 DOM 引用 + SYS_CARDS + CARD_ICONS + applyCardIcon + 动画 + fetchJSON + 错误上报）

(function () {
  'use strict';

  // ==================== 共享 DOM 引用 ====================
  // 这些元素在页面加载时一次性取好（id 不变）；任何模块都能通过 window.WB.grid 等访问
  window.WB = window.WB || {};
  WB.grid = document.getElementById('buttons-grid');
  WB.logsList = document.getElementById('logs-list');
  WB.dot = document.getElementById('server-dot');
  WB.statusText = document.getElementById('server-status-text');
  WB.titleEl = document.getElementById('workbench-title');

  // ==================== 系统信息卡定义（内置，非 buttons.json 按钮） ====================
  // 与 server.js SYS_CARDS_WHITELIST 硬约定（改这里要同步）
  WB.SYS_CARDS = {
    'sys-balance':   { id: 'sys-balance',   name: 'DeepSeek 余额', size: 'small', kind: 'stat' },
    'sys-status':    { id: 'sys-status',    name: '系统状态',      size: 'small', kind: 'status' },
    'sys-dsh-sessions': { id: 'sys-dsh-sessions', name: 'DSH 对话', size: 'small', kind: 'dsh-sessions' },
    'sys-bookmarks': { id: 'sys-bookmarks', name: '书签',          size: 'small', kind: 'bookmarks' },
    'sys-dida-today':{ id: 'sys-dida-today', name: '滴答今日任务', size: 'large', kind: 'dida-today' },
    'sys-dida-focus':{ id: 'sys-dida-focus', name: '滴答专注',     size: 'small', kind: 'stat' },
    'sys-minimax':   { id: 'sys-minimax',   name: 'MiniMax 套餐',  size: 'wide',  kind: 'minimax' },
    'sys-rss':       { id: 'sys-rss',       name: 'RSS 订阅',      size: 'wide',  kind: 'rss' },
  };

  // ==================== 卡片图标（Unicode 字符，随主题色显示，可用开关关闭） ====================
  WB.CARD_ICONS = {
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
  WB.applyCardIcon = function (iconEl, def) {
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
      iconEl.textContent = (def && WB.CARD_ICONS[def.id]) || '';
    }
  };

  // ==================== 数字滚动动画（ease-out cubic，600ms） ====================
  WB.animateValue = function (el, from, to, fmt, duration) {
    duration = duration || 600;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  WB.setNum = function (el, to, animate, fmt) {
    const prev = el._last;
    el._last = to;
    if (animate && typeof prev === 'number' && prev !== to) {
      WB.animateValue(el, prev, to, fmt);
    } else {
      el.textContent = fmt(to);
    }
  };

  // ==================== 数据获取（统一错误处理：HTTP 非 2xx 抛 Error） ====================
  WB.fetchJSON = async function (url, options) {
    const r = await fetch(url, options);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };

  // ==================== 客户端错误上报 ====================
  // 排查"点了没反应"：页面 JS 错误实时发到服务端日志（workbench.log 的 [client] 行）
  WB.reportClientError = function (msg) {
    try {
      fetch('/api/log-client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: String(msg).slice(0, 500) }),
      }).catch(() => {});
    } catch (e) { /* 忽略 */ }
  };

  window.addEventListener('error', (e) => {
    WB.reportClientError((e.message || '未知错误') + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    WB.reportClientError('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });
})();
