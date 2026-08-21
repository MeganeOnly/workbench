// 工作台前端逻辑：Bento 卡片墙渲染、轮询状态与日志、拖拽排序、执行按钮
// v1.2 拆分：核心工具 / 元数据已抽到 wb-core.js（本文件依赖 window.WB.grid / SYS_CARDS / fetchJSON 等）
(function () {
  'use strict';

  // 共享引用从 wb-core.js 注入的 WB 命名空间读取（详见 wb-core.js）
  const grid = WB.grid;
  const logsList = WB.logsList;
  const dot = WB.dot;
  const statusText = WB.statusText;
  const titleEl = WB.titleEl;
  const SYS_CARDS = WB.SYS_CARDS;
  const CARD_ICONS = WB.CARD_ICONS;
  const applyCardIcon = WB.applyCardIcon;
  const animateValue = WB.animateValue;
  const setNum = WB.setNum;
  const fetchJSON = WB.fetchJSON;
  const reportClientError = WB.reportClientError;
  // wb-mode.js 暴露的函数（isReadonlyMode / modeMatches / modeLabel / renderModeTags）由下面"模式系统"块声明 let 后再引入

  // 状态变量与轮询刷新函数已抽到 wb-state.js（let xxx = WB.xxx 引入本地视图；修改时双写）
  let buttons = WB.buttons;
  let busy = WB.busy;
  let queueInfo = WB.queueInfo;
  let balanceData = WB.balanceData;
  let bookmarks = WB.bookmarks;
  let didaToday = WB.didaToday;
  let didaFocus = WB.didaFocus;
  let minimaxData = WB.minimaxData;
  let rssData = WB.rssData;
  let feedsList = WB.feedsList;
  let dshSessions = WB.dshSessions;
  let sysCardStates = WB.sysCardStates;
  let searchQ = WB.searchQ;
  let workbenchOnline = WB.workbenchOnline;
  let loadedVersion = WB.loadedVersion;
  let versionChecked = WB.versionChecked;
  // 价格时段（从 wb-state.js 引入）
  const isPeakHour = WB.isPeakHour;
  const nextPeakStart = WB.nextPeakStart;
  const updateRateBadge = WB.updateRateBadge;
  // 刷新函数（从 wb-state.js 引入）
  const refreshButtons = WB.refreshButtons;
  const refreshQueue = WB.refreshQueue;
  const refreshBalance = WB.refreshBalance;
  const refreshDidaToday = WB.refreshDidaToday;
  const refreshDidaFocus = WB.refreshDidaFocus;
  const refreshMiniMax = WB.refreshMiniMax;
  const refreshLogs = WB.refreshLogs;
  const refreshRss = WB.refreshRss;
  const refreshDshSessions = WB.refreshDshSessions;
  const refreshBookmarks = WB.refreshBookmarks;
  const refreshFeedsData = WB.refreshFeedsData;
  const refreshSysCards = WB.refreshSysCards;

  // 模式系统已抽到 wb-mode.js（顶部 const isReadonlyMode / modeMatches / modeLabel / renderModeTags 引入）
  // 共享状态变量从 WB 初始化（首次加载 wb-mode.js 时已设默认）；每次修改同步写回 WB
  let MODES = WB.MODES;
  let MODES_LOADED = WB.MODES_LOADED;
  let currentMode = WB.currentMode;
  const isReadonlyMode = WB.isReadonlyMode;
  const modeMatches = WB.modeMatches;
  const modeLabel = WB.modeLabel;
  const renderModeTags = WB.renderModeTags;

  // ---- 系统信息卡定义 / 卡片图标 / 数字滚动动画 已抽到 wb-core.js（顶部 const SYS_CARDS = WB.SYS_CARDS 引入） ----

  // ---- 所有渲染函数已抽到 wb-render.js（顺序管理 / 卡片尺寸 / keyed 渲染 / ensure*Card / render*Card / applyMasonry 等） ----


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
    WB.dragActive = false;
    document.body.style.userSelect = '';
    WB.renderGrid(); // 按当前顺序恢复卡片到原位
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
      WB.dragActive = true;
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
      if (WB.renderGrid) WB.renderGrid(); // 若渲染抛错，finally 仍会清除 busy，按钮不会卡死在"执行中..."
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

  // ---- 刷新按钮 / 队列 / 余额 / didaToday / didaFocus / MiniMax / logs 已抽到 wb-state.js（顶部 const refreshXxx 引入） ----

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

  // ---- refreshBookmarks 已抽到 wb-state.js（顶部 const refreshBookmarks 引入） ----

  // 启动加载失败横幅（v1 防护：TDZ / 结构损坏时触发；指导用户从 .bak 恢复并重启）
  function showBookmarkLoadFailedBanner(loadFailed) {
    const id = 'bm-load-failed-banner';
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    if (!loadFailed) return;
    const div = document.createElement('div');
    div.id = id;
    div.className = 'bm-load-failed-banner';
    div.innerHTML = '<strong>书签加载失败</strong> · 服务端启动时无法读取 bookmarks.json（详见 workbench-err.log）。' +
      '原文件已备份为 <code>bookmarks.json.bak</code>，当前内存为空且已禁用写入。请从 .bak 恢复后重启服务。';
    document.body.prepend(div);
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

  // 模式 id → 中文标签（找不到回退 id 本身）已抽到 wb-mode.js（顶部 const modeLabel = WB.modeLabel 引入）

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
  const bmDeleteBtn = document.getElementById('bm-delete');
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
    // 删除按钮仅编辑模式可见（新增无意义）
    if (bmDeleteBtn) bmDeleteBtn.classList.toggle('hidden', !bmEditId);
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
    // 删除按钮隐藏兜底（防止下次打开残留）
    if (bmDeleteBtn) bmDeleteBtn.classList.add('hidden');
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

  // 删除当前编辑的书签（仅在编辑模式生效；按钮 hidden 类已在 openModal 中按 editId 切换）
  async function deleteBookmarkFromModal() {
    if (!bmEditId) return; // 兜底：新增模式不应触发
    const preset = bookmarks.find((b) => b.id === bmEditId);
    const name = preset ? preset.name : '';
    if (!confirm('删除书签「' + name + '」？此操作不可撤销。')) return;
    try {
      await fetchJSON('/api/bookmarks/' + encodeURIComponent(bmEditId), { method: 'DELETE' });
      closeModal();
      refreshBookmarks();
      if (WB.showToast) WB.showToast('已删除书签「' + name + '」', 'ok');
    } catch (e) {
      alert('删除失败: ' + e.message);
    }
  }

  addBtn.addEventListener('click', openModal);
  bmCancel.addEventListener('click', closeModal);
  bmSave.addEventListener('click', saveBookmark);
  if (bmDeleteBtn) bmDeleteBtn.addEventListener('click', deleteBookmarkFromModal);
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
    WB.renderSidebarBookmarks();
    WB.renderGrid();
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
  const LAYOUT_KEY = 'workbench-layout';   // 旧 key：全局 layout 存储；新机制下不再写入，读取保留兼容
  const LAYOUT_BY_MODE_KEY = 'workbench-layout-by-mode';   // 新 key：每 mode 独立 layout；切模式自动应用
  const DEFAULT_LAYOUT_BY_MODE = {
    work: 'split-center',   // 工作模式：任务居中布局（聚焦今日任务）
    entertainment: 'grid',  // 娱乐模式：网格布局（自由浏览）
    invest: 'grid',         // 投资模式：网格布局（投资方案卡片用 wide + small 自然排列）
  };
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

  function getLayoutForMode(mode) {
    // 优先读 mode 专属 layout；缺省回退硬编码默认值（保证首次切到新 mode 也有合理布局）
    try {
      const raw = localStorage.getItem(LAYOUT_BY_MODE_KEY);
      if (raw) {
        const map = JSON.parse(raw);
        if (map && typeof map[mode] === 'string') return map[mode];
      }
    } catch (e) { /* 损坏回退默认 */ }
    return DEFAULT_LAYOUT_BY_MODE[mode] || 'grid';
  }

  function setLayoutForMode(mode, layout) {
    let map = {};
    try {
      const raw = localStorage.getItem(LAYOUT_BY_MODE_KEY);
      if (raw) map = JSON.parse(raw) || {};
    } catch (e) { /* 损坏视为空 */ }
    map[mode] = layout;
    try {
      localStorage.setItem(LAYOUT_BY_MODE_KEY, JSON.stringify(map));
    } catch (e) { /* 写入失败不致命 */ }
  }

  function applyStyle() {
    const theme = localStorage.getItem(THEME_KEY) || 'emerald';
    // 模式：白名单校验（基于 MODES；启动早期 MODES_LOADED=false 时用内置默认 work）
    // 必须先于 layout 读取——否则 init() 首次调用时 currentMode 还是 WB 默认值 'work'，
    // 会拿 work 的 layout 写到 body，再更新 currentMode 也来不及（2026-08-22 真实 bug：
    // 用户在 invest 模式选 grid 后刷新，看到的是 work 的 split-center 布局）
    let m = localStorage.getItem(MODE_KEY);
    const knownIds = MODES_LOADED ? MODES.modes.map((x) => x.id) : ['work'];
    if (!knownIds.includes(m)) m = MODES_LOADED ? MODES.default : 'work';
    currentMode = m; WB.currentMode = m;  // 双写：本地 + WB（wb-mode.js 也读 WB.currentMode）
    // 布局按当前 mode 取——切模式时自动应用该 mode 独立的 layout
    const layout = getLayoutForMode(currentMode);
    document.body.dataset.theme = theme;
    document.body.dataset.layout = layout;
    for (const [id, key] of Object.entries(SWITCH_IDS)) {
      const on = localStorage.getItem(key) !== 'off';
      document.body.dataset[key.replace('workbench-', '')] = on ? 'on' : 'off';
      const el = document.getElementById(id);
      if (el) el.setAttribute('aria-checked', String(on));
    }
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
    WB.renderGrid(); // 布局/开关变化时重渲染（keyed 复用，开销极小）
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
    currentMode = v; WB.currentMode = v;  // 双写：本地 + WB
    localStorage.setItem(MODE_KEY, v);
    applyStyle();
    // 同步已有卡片的 drag-hint 显隐（keyed 缓存复用 DOM，初次渲染后不会自动重渲）
    syncDragHintsForReadonly();
    // 立即重渲侧栏 / 卡片墙 / RSS（按 mode 过滤），不等 10 秒轮询
    WB.renderSidebarBookmarks();
    WB.renderSystemCard('sys-bookmarks');
    renderRssForReRender();
    // 同步卡片墙书签 add 按钮显隐（keyed 缓存初渲决定，setMode 不破坏）
    refreshAllCardAddBtns();
    // RSS 卡片若已渲染，拉一次新数据（缓存内的 rssData 可能不含新加的源 / 切换后的源）
    const rssHit = WB.cardCache && WB.cardCache.get('sys-rss');
    if (rssHit && (document.body.dataset.rss || 'on') === 'on') {
      refreshRss();
    }
    const def = MODES.modes.find((x) => x.id === v);
    const label = def ? def.name : v;
    showToast('已切换到 ' + label + ' 模式' + (def && def.readonly ? '（只读）' : ''), 'ok');
  }

  // 切换模式后重新触发 RSS 卡片渲染（keyed 缓存复用 DOM，renderGrid 才会重渲染内层）
  function renderRssForReRender() {
    const hit = WB.cardCache && WB.cardCache.get('sys-rss');
    if (!hit) return;
    const listEl = hit.refs.list;
    if (listEl) WB.renderRssList(listEl);
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
    else setLayoutForMode(currentMode, value);   // 写当前 mode 的 layout（切回时自动恢复）
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
  // refreshFeedsData 已抽到 wb-state.js（顶部 const refreshFeedsData 引入）

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

  // ---- 模式管理区（v5 feedback 3）—— 统一查看 + inline 编辑所有内容 mode 字段 ----
  // 5 类（v1 新增第 5 组系统卡）：功能按钮（普通按钮） / 书签 / RSS 源 / 手动配置按钮（只读）/ 系统卡
  // 每行展示：图标 + 名称 + 当前模式标签 + multi-tag 编辑器（实时 PATCH/POST）
  // 持久化：刷新按钮/书签/RSS 后重新拉取并重渲染（refreshButtons/refreshBookmarks/refreshFeedsData + refreshSysCards 都在 init 末轮询）
  // 注：手动配置的普通按钮只能看到，不能在这里编辑（buttons.json 是配置文件，没 UI 入口）
  function initModeManager() {
    WB.renderModeManager();
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
    // 分组 4：手动配置按钮（inline 编辑走 /api/buttons/update）
    // 包含 push / dida 等特殊 kind 的卡——它们没有 command 但有 kind；UI 编辑 mode 一致
    const manualButtons = buttons.filter((b) => !b.auto && !b.toggle && (b.command || b.kind));
    if (manualButtons.length > 0) {
      root.appendChild(renderModeManagerGroup('manual', '功能按钮（手动）', manualButtons.map((b) => ({
        key: 'btn:' + b.id,
        icon: '⚙',
        name: b.name,
        title: b.description || '',
        mode: b.mode,
        onChange: (newMode) => patchButton(b.id, newMode),
      }))));
    }
    // 分组 5：系统卡（v1 新增：SYS_CARDS 内置 8 张信息卡也能选模式）
    // inline 编辑走 PATCH /api/syscards/<id>；SYS_CARDS_WHITELIST 与服务端硬约定
    const sysCardRows = Object.keys(SYS_CARDS).map((id) => ({
      key: 'syscard:' + id,
      icon: CARD_ICONS[id] || '◇',
      name: SYS_CARDS[id].name || id,
      title: id,
      mode: SYS_CARDS[id].mode,
      onChange: (newMode) => patchSysCard(id, newMode),
    }));
    root.appendChild(renderModeManagerGroup('syscard', '系统卡', sysCardRows));
  }

  // 单个分组：标题 + 行列表（v0.8：分组标题可点击折叠，状态持久化）
  // groupId 用于 localStorage key 稳定标识——5 个分组固定：bookmark / feed / shortcut / manual / syscard
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

  // 模式管理区行编辑：PATCH /api/syscards/<id>（系统卡 mode；同步 SYS_CARDS[id].mode + 重新渲染）
  // 字段语义与 patchBookmark/patchFeed 同款：null / 字符串 / 数组 / '__hidden__'
  async function patchSysCard(id, newMode) {
    try {
      const r = await fetch('/api/syscards/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      });
      const res = await r.json().catch(() => ({}));
      if (res.ok) {
        // 本地回填：SYS_CARDS[id].mode 是 modeMatches 的真源，刷新后卡片墙立即生效
        sysCardStates[id] = res.card ? res.card.mode : newMode;
        if (SYS_CARDS[id]) SYS_CARDS[id].mode = sysCardStates[id];
        showToast('已更新系统卡模式', 'ok');
        WB.renderGrid();       // 立即重新过滤（modeMatches(SYS_CARDS[id].mode)）
        WB.renderModeManager(); // 模式管理区本身也要刷新（其它行不变，仅本行 active 状态）
      } else {
        showToast('更新失败: ' + (res.error || ''), 'err');
      }
    } catch (e) {
      showToast('更新失败: ' + e.message, 'err');
    }
  }

  // ---- refreshSysCards 已抽到 wb-state.js（顶部 const refreshSysCards 引入） ----

  // ---- 跨模块桥接：把工具 / UI 函数挂到 WB（wb-state.js / wb-render.js 的 refresh* 与 render* 运行时调用） ----
  // app.js 中仍保留函数本体；这里只做"挂载到 WB"以让其他模块的 if (WB.xxx) 守护调用能命中
  // 待 wb-action.js / wb-bookmarks.js / wb-settings.js 拆出后，这些函数搬走，本块缩为最小集
  WB.showToast = showToast;
  WB.openExternal = openExternal;
  if (typeof runButton === 'function') WB.runButton = runButton;
  if (typeof completeTask === 'function') WB.completeTask = completeTask;
  if (typeof faviconImg === 'function') WB.faviconImg = faviconImg;
  WB.applyStyle = applyStyle;
  WB.setMode = setMode;
  WB.setStyle = setStyle;
  WB.renderModeSwitchers = renderModeSwitchers;
  WB.syncDragHintsForReadonly = syncDragHintsForReadonly;
  WB.refreshAllCardAddBtns = refreshAllCardAddBtns;
  WB.renderRssForReRender = renderRssForReRender;
  WB.showBookmarkLoadFailedBanner = showBookmarkLoadFailedBanner;
  WB.openModal = openModal;
  WB.renderShortcutList = renderShortcutList;
  WB.renderModeManager = renderModeManager;
  WB.renderSidebarBookmarks = renderSidebarBookmarks;
  WB.renderFeedsPanel = renderFeedsPanel;

  // ---- 初始化 ----
  async function init() {
    // 先加载模式定义（modes.json）：决定切换器 / 设置面板 / 只读态 / 模式白名单
    // 失败时沿用 MODES 内置默认（白名单回退 ['work']，保证工作模式正常）
    try {
      const m = await fetchJSON('/api/modes');
      if (m && Array.isArray(m.modes) && m.modes.length) {
        MODES = m; WB.MODES = m;  // 双写：本地 + WB
        MODES_LOADED = true; WB.MODES_LOADED = true;
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
      window.__setMmx = (d) => { minimaxData = d; WB.renderSystemCard('sys-minimax'); };
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
    await refreshSysCards();   // v1：系统卡 mode（启动时拉一次 → 写入 SYS_CARDS[id].mode）
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
    setInterval(() => { WB.renderSystemCard('sys-dida-today'); WB.applyMasonry(); }, 60000);
    setInterval(updateRateBadge, 60000);
    // 窗口尺寸变化时重算瀑布流 span（响应式断点改变列数 → 卡高变化）
    window.addEventListener('resize', () => {
      clearTimeout(window.__masonryResize);
      window.__masonryResize = setTimeout(() => WB.renderGrid(), 200);
    });
  }

  init();
})();
