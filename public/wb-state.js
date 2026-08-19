// 工作台状态模块（v1.2 拆分第三步）
// 职责：
//   - 全局状态变量（buttons / busy / queueInfo / balanceData / bookmarks / didaToday /
//     didaFocus / minimaxData / rssData / feedsList / dshSessions / sysCardStates / searchQ /
//     workbenchOnline / loadedVersion / versionChecked）
//   - 轮询刷新函数（refreshButtons / refreshQueue / refreshBalance / refreshDidaToday /
//     refreshDidaFocus / refreshMiniMax / refreshLogs / refreshRss / refreshDshSessions /
//     refreshBookmarks / refreshFeedsData / refreshSysCards）
//   - 价格时段徽章（updateRateBadge / isPeakHour / nextPeakStart）
// 设计：
//   - 跨文件函数调用一律用 WB.xxx()（运行时查找）—— 避开循环加载问题
//   - 不缓存其他模块的函数引用（wb-render / wb-bookmarks / wb-settings / wb-action 可能
//     加载顺序不固定）
//   - 拆分前位于 app.js line 20-32（let 状态变量）+ line 130-167（价格时段）+
//     line 1500-1846（refreshXxx 等所有刷新函数）
//   - 与 wb-core.js / wb-mode.js 解耦：只依赖 fetchJSON / reportClientError

(function () {
  'use strict';

  window.WB = window.WB || {};

  // ==================== 全局状态变量 ====================
  WB.buttons = [];
  WB.busy = {};
  WB.queueInfo = null;
  WB.balanceData = null;
  WB.bookmarks = [];
  WB.didaToday = null;
  WB.didaFocus = null;
  WB.minimaxData = null;  // MiniMax Token Plan 额度（/api/minimax-coding-plan）
  WB.rssData = null;      // RSS 信息卡数据（/api/rss）
  WB.feedsList = [];      // RSS 订阅源列表（设置面板管理，/api/feeds）
  WB.dshSessions = null;  // DSH 对话状态聚合（/api/dsh-sessions）：{ status: 'working'|'idle'|'offline'|'error', running, total, active }
  WB.sysCardStates = {};  // 系统卡 mode 状态（/api/syscards）：id -> mode（已规范化）。启动后写入 SYS_CARDS[id].mode
  WB.searchQ = '';        // 顶栏搜索关键字（已小写；空 = 不过滤）
  WB.workbenchOnline = false;
  WB.loadedVersion = null;        // 启动时记录的前端文件哈希；版本自检用
  WB.versionChecked = false;      // 是否已做首次版本自检

  // ==================== 价格时段（DeepSeek 峰谷定价） ====================
  // 高峰 9-12 / 14-18（北京时间），其余空闲半价。徽章状态写入 DOM #rate-badge。
  // 与 server.js 端价格计算无关——纯前端提示
  WB.isPeakHour = function (d) {
    const h = d.getHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  };

  WB.nextPeakStart = function (now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const at = (hh) => { const t = new Date(today); t.setHours(hh, 0, 0, 0); return t; };
    for (const s of [at(9), at(14)]) if (s > now) return s;
    const t = at(9);
    t.setDate(t.getDate() + 1);
    return t;
  };

  WB.updateRateBadge = function () {
    const el = document.getElementById('rate-badge');
    if (!el) return;
    const now = new Date();
    if (WB.isPeakHour(now)) {
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
      const next = WB.nextPeakStart(now);
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
  };

  // ==================== 刷新：按钮 / 队列 / 余额 / MiniMax / 日志 / RSS ====================
  WB.refreshButtons = async function () {
    try {
      const data = await WB.fetchJSON('/api/buttons');
      // mutate 而非 replace：保留引用，让 app.js 中的本地 let buttons 同步
      WB.buttons.length = 0;
      WB.buttons.push(...(data.buttons || []));
      WB.workbenchOnline = true;
      if (WB.dot) {
        WB.dot.className = 'dot on';
      }
      if (WB.statusText) WB.statusText.textContent = '工作台服务正常';

      // 版本自检：服务端返回前端文件哈希。本页加载后若发现版本变了，
      // 说明页面代码已更新（用户可能停在旧标签页），自动刷新拉取新 JS。
      // 这是"我改了代码但点了没反应"这类旧页面问题的自动防线。
      if (data.version && data.version !== 'unknown') {
        if (!WB.versionChecked) {
          WB.loadedVersion = data.version;
          WB.versionChecked = true;
        } else if (data.version !== WB.loadedVersion) {
          WB.showToast('检测到页面更新，正在自动刷新...', 'warn');
          setTimeout(() => location.reload(), 800);
          return;
        }
      }
    } catch (e) {
      WB.workbenchOnline = false;
      if (WB.dot) WB.dot.className = 'dot off';
      if (WB.statusText) WB.statusText.textContent = '无法连接工作台服务';
    }
    if (WB.renderGrid) WB.renderGrid();
    if (WB.renderShortcutList) WB.renderShortcutList(); // 快捷方式管理列表（设置面板）随按钮数据刷新
    if (WB.renderModeManager) WB.renderModeManager(); // v5 feedback 3：模式管理区跟随数据刷新
  };

  WB.refreshQueue = async function () {
    try {
      WB.queueInfo = await WB.fetchJSON('/api/queue');
    } catch (e) {
      WB.queueInfo = null;
    }
    if (WB.renderGrid) WB.renderGrid();
  };

  WB.refreshBalance = async function () {
    try {
      WB.balanceData = await WB.fetchJSON('/api/balance');
    } catch (e) {
      WB.balanceData = { ok: false, error: '无法获取' };
    }
    if (WB.renderGrid) WB.renderGrid();
  };

  // 刷新滴答今日任务
  // 历史：曾因 fetch 永不返回（浏览器扩展 / Service Worker / 网络层死锁）导致
  // didaToday 永远为 null、卡片无限显示"读取中..."。修复：10 秒 AbortController 超时兜底，
  // 失败时打 console.warn + 具体错误信息（不再干瘪显示"无法获取"）。
  WB.refreshDidaToday = async function () {
    console.log('[dida-today] fetch /api/dida-today');
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    try {
      WB.didaToday = await WB.fetchJSON('/api/dida-today', { signal: controller.signal });
      console.log('[dida-today] ok, count=' + (WB.didaToday && WB.didaToday.count));
    } catch (e) {
      console.warn('[dida-today] failed: ' + e.message);
      const reason = (e && e.name === 'AbortError') ? '请求超时（10s）' : (e.message || '网络异常');
      WB.didaToday = { ok: false, error: '获取失败: ' + reason, count: 0, tasks: [] };
    } finally {
      clearTimeout(tid);
    }
    if (WB.renderGrid) WB.renderGrid();
  };

  // 同款超时兜底（与 didaToday 共用滴答 MCP，任意一项挂死另一项大概率也挂）
  WB.refreshDidaFocus = async function () {
    console.log('[dida-focus] fetch /api/dida-focus');
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    try {
      WB.didaFocus = await WB.fetchJSON('/api/dida-focus', { signal: controller.signal });
      console.log('[dida-focus] ok, totalMs=' + (WB.didaFocus && WB.didaFocus.totalMs));
    } catch (e) {
      console.warn('[dida-focus] failed: ' + e.message);
      const reason = (e && e.name === 'AbortError') ? '请求超时（10s）' : (e.message || '网络异常');
      WB.didaFocus = { ok: false, error: '获取失败: ' + reason };
    } finally {
      clearTimeout(tid);
    }
    if (WB.renderGrid) WB.renderGrid();
  };

  WB.refreshMiniMax = async function () {
    try {
      WB.minimaxData = await WB.fetchJSON('/api/minimax-coding-plan');
    } catch (e) {
      WB.minimaxData = { ok: false, error: '无法获取' };
    }
    if (WB.renderGrid) WB.renderGrid();
  };

  WB.refreshLogs = async function () {
    try {
      const data = await WB.fetchJSON('/api/logs');
      const logs = data.logs || [];
      if (WB.logsList) WB.logsList.innerHTML = '';
      if (!WB.logsList) return;
      if (logs.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '暂无运行记录';
        WB.logsList.appendChild(li);
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

        WB.logsList.appendChild(li);
      }
    } catch (e) {
      // 忽略：下次轮询重试
    }
  };

  WB.refreshRss = async function () {
    if ((document.body.dataset.rss || 'on') === 'off') return;
    try {
      WB.rssData = await WB.fetchJSON('/api/rss');
    } catch (e) {
      WB.rssData = { ok: false, error: String((e && e.message) || e) };
    }
    if (WB.renderGrid) WB.renderGrid();
  };

  WB.refreshDshSessions = async function () {
    try {
      WB.dshSessions = await WB.fetchJSON('/api/dsh-sessions');
    } catch (e) {
      WB.dshSessions = { ok: false, status: 'error', error: String((e && e.message) || e), running: 0, total: 0, active: [] };
    }
    // 仅触发该卡片的重渲（不影响其它卡片）
    if (WB.renderSystemCard) WB.renderSystemCard('sys-dsh-sessions');
  };

  // ==================== 刷新：书签 / RSS 订阅源 / 系统卡 mode ====================
  WB.refreshBookmarks = async function () {
    try {
      const data = await WB.fetchJSON('/api/bookmarks');
      // mutate 而非 replace：保留引用
      WB.bookmarks.length = 0;
      WB.bookmarks.push(...(data.bookmarks || []));
      // 服务端启动加载失败告警（v1 防护：原 bookmarks.json 已备份为 .bak，禁止后续写入）
      if (WB.showBookmarkLoadFailedBanner) WB.showBookmarkLoadFailedBanner(data.loadFailed);
    } catch (e) {
      WB.bookmarks.length = 0;
      if (WB.showBookmarkLoadFailedBanner) WB.showBookmarkLoadFailedBanner(false);
    }
    if (WB.renderSidebarBookmarks) WB.renderSidebarBookmarks();
    if (WB.renderGrid) WB.renderGrid();
    if (WB.renderModeManager) WB.renderModeManager(); // v5 feedback 3：模式管理区跟随数据刷新
  };

  WB.refreshFeedsData = async function (force) {
    try {
      const data = await WB.fetchJSON('/api/feeds');
      // mutate 而非 replace：保留引用
      WB.feedsList.length = 0;
      WB.feedsList.push(...(data.feeds || []));
    } catch (e) {
      WB.feedsList.length = 0;
    }
    if (force && WB.feedsSig !== undefined) WB.feedsSig = '';  // 配合 wb-settings.js 的渲染签名
    if (WB.renderFeedsPanel) WB.renderFeedsPanel();
    if (WB.renderModeManager) WB.renderModeManager(); // v5 feedback 3：模式管理区跟随数据刷新
  };

  // 刷新系统卡 mode 状态：GET /api/syscards → 写入 SYS_CARDS[id].mode
  // 启动时 + 任何 patchSysCard 后调用；保证前端 modeMatches 用的字段是最新的
  WB.refreshSysCards = async function () {
    try {
      const data = await WB.fetchJSON('/api/syscards');
      const cards = (data && data.cards) || [];
      // 先清空再回填（防止服务端去掉了某张卡，前端还残留旧 mode）
      WB.sysCardStates = {};
      for (const c of cards) {
        WB.sysCardStates[c.id] = c.mode != null ? c.mode : null;
        if (WB.SYS_CARDS[c.id]) WB.SYS_CARDS[c.id].mode = WB.sysCardStates[c.id];
      }
      // 白名单内的卡但服务端没返回 → 视为 null（默认全部模式可见）
      for (const id of Object.keys(WB.SYS_CARDS)) {
        if (!(id in WB.sysCardStates)) {
          WB.sysCardStates[id] = null;
          WB.SYS_CARDS[id].mode = null;
        }
      }
    } catch (e) {
      // 服务端失败时全部回退 null（与缺 syscards-state.json 行为一致）
      for (const id of Object.keys(WB.SYS_CARDS)) {
        if (WB.SYS_CARDS[id]) WB.SYS_CARDS[id].mode = null;
      }
    }
    if (WB.renderGrid) WB.renderGrid();
    if (WB.renderModeManager) WB.renderModeManager();
  };
})();
