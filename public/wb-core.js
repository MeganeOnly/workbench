// =============================================================
// wb-core.js · 工作台前端
// =============================================================
//
// 职责：
//   - 共享 DOM 引用（grid / logsList / dot / statusText / titleEl）
//   - 系统信息卡定义（WB.SYS_CARDS：与 server.js SYS_CARDS_WHITELIST 镜像）
//   - 卡片图标（WB.CARD_ICONS：Unicode 字符 + 软件自身图标）
//   - 数字滚动动画（WB.animateValue / WB.setNum）
//   - 数据获取（WB.fetchJSON，统一错误处理）
//   - 客户端错误上报（WB.reportClientError + window error/unhandledrejection 监听）
//
// 设计：
//   - 必须最先加载（其他所有 wb-*.js 都依赖这里的 WB.grid / WB.fetchJSON 等）
//   - 所有导出挂到 window.WB 命名空间，避免污染全局
//   - 不持有任何"业务状态"——纯工具 + 元数据
//   - WB.SYS_CARDS / WB.CARD_ICONS 是 UPPER_SNAKE 常量（配置）；其余 camelCase
// =============================================================

(function () {
  'use strict';

  // ===== 共享 DOM 引用 =====
  // 一次性取好（id 不变）；任何模块都能通过 window.WB.grid 等访问
  window.WB = window.WB || {};
  WB.grid = document.getElementById('buttons-grid');
  WB.logsList = document.getElementById('logs-list');
  WB.dot = document.getElementById('server-dot');
  WB.statusText = document.getElementById('server-status-text');
  WB.titleEl = document.getElementById('workbench-title');

  // ===== 系统信息卡定义 =====
  // 内置（不在 buttons.json），与 server.js SYS_CARDS_WHITELIST 硬约定
  WB.SYS_CARDS = {
    'sys-balance':   { id: 'sys-balance',   name: 'DeepSeek 余额', size: 'small', kind: 'stat' },
    'sys-status':    { id: 'sys-status',    name: '系统状态',      size: 'small', kind: 'status' },
    'sys-dsh-sessions': { id: 'sys-dsh-sessions', name: 'DSH 对话', size: 'small', kind: 'dsh-sessions' },
    'sys-bookmarks': { id: 'sys-bookmarks', name: '书签',          size: 'small', kind: 'bookmarks' },
    'sys-dida-today':{ id: 'sys-dida-today', name: '滴答今日任务', size: 'large', kind: 'dida-today' },
    'sys-dida-focus':{ id: 'sys-dida-focus', name: '滴答专注',     size: 'small', kind: 'stat' },
    'sys-minimax':   { id: 'sys-minimax',   name: 'MiniMax 套餐',  size: 'wide',  kind: 'minimax' },
    'sys-rss':       { id: 'sys-rss',       name: 'RSS 订阅',      size: 'wide',  kind: 'rss' },
    // 投资方案卡（v2：仅 1 张计算器；硬约束已删除，警告搬进设置面板）
    'sys-invest-calc':  { id: 'sys-invest-calc',  name: '投资计算器',   size: 'wide',  kind: 'invest-calc', mode: 'invest' },
  };

  // ===== 卡片图标 =====
  // Unicode 字符，随主题色显示；可用 ICONS_KEY 开关关闭
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
    // 投资方案卡（v2：仅计算器）
    'sys-invest-calc':  'Σ',   // 大写 Sigma（区别于其它字符）
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

  // ===== 数字滚动动画 =====
  // ease-out cubic，600ms；由 wb-render 用于余额卡数字滚动
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

  // ===== 数据获取 =====
  // 统一错误处理：HTTP 非 2xx 抛 Error；调用方用 try/catch 捕获
  WB.fetchJSON = async function (url, options) {
    const r = await fetch(url, options);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };

  // ===== 客户端错误上报 =====
  // 排查"点了没反应"：页面 JS 错误实时发到服务端日志（workbench.log 的 [client] 行）
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
