// 工作台模式模块（v1.2 拆分第二步）
// 职责：
//   - 模式配置（MODES）：默认内置 + 启动时从 /api/modes 拉取 modes.json 覆盖
//   - 当前模式（currentMode）：localStorage 持久化；用户态
//   - 只读模式判断（isReadonlyMode）：用于禁用拖拽 / 编辑控件 / 主题切换
//   - 模式匹配（modeMatches）：判定 mode 字段是否在当前模式下可见
//   - multi-tag 组件（renderModeTags）：inline 编辑 mode 字段
//   - mode id → 中文标签（modeLabel）
// 设计：
//   - 依赖 wb-core.js（仅用 WB 命名空间，不读其他模块）
//   - 被多数模块依赖（render / settings / bookmarks / drag 等）—— 必须在 wb-state.js / wb-render.js / wb-bookmarks.js / wb-drag.js / wb-settings.js 之前加载
//   - 状态用 WB.xxx = ... 暴露（let 变量挂到对象属性即可模拟）
//   - 拆分前位于 app.js line 33-41 + 212-232 + 1102-1170 + 1879-1882

(function () {
  'use strict';

  window.WB = window.WB || {};

  // ==================== 模式配置 ====================
  // 启动时 fetch /api/modes 拿 modes.json；失败回退内置默认（与 server.js DEFAULT_MODES 镜像）。
  // modes 配置是 {default, modes:[{id,name,icon,readonly,description}]}：
  //   - readonly = true  → 进入该模式时挂全局只读态（拖拽 / 改色 / 改尺寸 / 书签 / RSS 增删拖拽 全部拦截）
  //   - 加新模式 = 改 modes.json 一条，零代码改动（白名单校验 + 切换器动态渲染）
  WB.MODES = {
    default: 'work',
    modes: [
      { id: 'work', name: '工作', icon: '▣', readonly: true, description: '工作模式' },
      { id: 'entertainment', name: '娱乐', icon: '▶', readonly: false, description: '娱乐模式' },
    ],
  };
  WB.MODES_LOADED = false;             // 是否已从 /api/modes 拉取（防止首次渲染未拿到的竞态）
  WB.currentMode = 'work';             // 当前模式：用户态，从 localStorage `workbench-mode` 读；不影响服务端

  // ==================== 当前模式是否只读 ====================
  // 派生自 currentMode 对应的 mode 定义；每次切换模式时重算
  WB.isReadonlyMode = function () {
    const m = WB.MODES.modes.find((x) => x.id === WB.currentMode);
    return !!(m && m.readonly === true);
  };

  // ==================== 模式匹配 ====================
  // mode 字段语义（与 server.js normalizeModeField 保持一致）：
  //   undefined / null                → 全部模式可见（默认；与 buttons.json 旧字段缺失行为一致）
  //   'work' / 'entertainment' / 自定义模式 id（modes.json 定义） → 仅该模式可见
  //   ['work','entertainment']        → 与不写等价（少见，显式声明）
  //   '__hidden__'                     → 所有模式都不可见（v0.8 新增；用户在 UI 上点"隐藏"按钮）
  // 校验：未知模式 id 在白名单外视为 null（防止 modes.json 改名后旧数据卡死）
  WB.modeMatches = function (m) {
    if (m === '__hidden__') return false;  // v0.8：hidden sentinel 永远不匹配（任何模式都不显示）
    if (m == null) return true;
    // 启动早期 / 网络失败 MODES_LOADED=false 时仍能匹配内置两个白名单（向后兼容）
    const knownIds = WB.MODES_LOADED ? WB.MODES.modes.map((x) => x.id) : ['work', 'entertainment'];
    if (Array.isArray(m)) {
      // 数组中任一已知模式 === 当前模式即匹配（与 modes.json 同步白名单）
      const valid = m.filter((x) => knownIds.includes(x));
      return valid.includes(WB.currentMode);
    }
    if (typeof m === 'string' && knownIds.includes(m)) return m === WB.currentMode;
    // 未知模式 id 视为 null（兜底：modes.json 改名后旧数据不卡死）
    return true;
  };

  // ==================== 模式 id → 中文标签 ====================
  // 找不到回退 id 本身
  WB.modeLabel = function (id) {
    const m = WB.MODES.modes.find((x) => x.id === id);
    return m ? m.name : id;
  };

  // ==================== 模式 multi-tag 组件 ====================
  // currentMode 接受四态：null / undefined / []    → "全部模式可见"（无勾选，默认）
  //                        字符串（非 __hidden__） → 仅该模式可见
  //                        字符串数组              → 这些模式都可见
  //                        '__hidden__'             → 所有模式都不显示（用户点"隐藏"按钮）
  // onChange(newMode) 回调：null（全部）/ 字符串数组（被选模式）/ '__hidden__'（隐藏）
  // 互斥：勾选"隐藏" = 清空所有具体模式；勾选任意具体模式 = 取消"隐藏"
  // v0.8 视觉调整：checkbox input 完全隐藏（CSS），label 点击触发切换；.mode-tag.active 亮起即状态
  // readonly 模式：整体 disable（不触发 onChange；调用方仍可批量改 metadata）
  WB.renderModeTags = function (currentMode, onChange) {
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
    for (const m of WB.MODES.modes) {
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
    if (WB.isReadonlyMode()) {
      wrap.classList.add('locked');
      wrap.querySelectorAll('input').forEach((cb) => { cb.disabled = true; });
    }
    return wrap;
  };
})();
