// 模式细化前端无头 Edge CDP 测试（v2）：
// 用法：node tests/test-mode-frontend.mjs
// - 模式区在样式菜单顶部（sp-section[data-collapsible="mode"] 是第一个）
// - 顶栏 mode-switcher 已移除（用户反馈"在外解锁太容易"）
// - 工作模式：外观/布局/偏好/快捷方式/RSS 区域全部 pointer-events:none
// - 卡片/书签 mode 标签不展示（.bm-mode-tag 不挂 DOM）
// - bookmark-modal 支持编辑态（PATCH 路径）
// - 快捷方式列表项加 mode select（sc-mode-opt）
// - readonly 模式 body[data-readonly="true"]

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE = 'http://127.0.0.1:3180';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PROFILE = path.join(os.tmpdir(), 'workbench-mode-test-v2-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let exitCode = 0;
function pass(name, detail) { results.push({ ok: true, name, detail }); console.log('[PASS]', name, detail ? '— ' + detail : ''); }
function fail(name, detail) { results.push({ ok: false, name, detail }); console.log('[FAIL]', name, detail ? '— ' + detail : ''); exitCode = 1; }

async function main() {
  try {
    const r = await fetch(BASE + '/api/modes');
    const cfg = await r.json();
    if (!cfg.modes || !cfg.modes.length) {
      console.error('[FAIL] /api/modes 不可用');
      process.exit(2);
    }
  } catch (e) {
    console.error('[FAIL] 服务未启动: ' + e.message);
    process.exit(2);
  }

  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edgePath) { console.error('[FAIL] Edge not found'); process.exit(2); }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const dbgPort = 9450 + Math.floor(Math.random() * 200);
  const edge = spawn(edgePath, [
    '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json(); break; }
      catch { await sleep(250); }
    }
    if (!targets) throw new Error('CDP 未就绪');
    const page = targets.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    await new Promise((resolve) => { ws.onopen = resolve; });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(4000);
    const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });

    // 1) 顶栏 mode-switcher 已移除（feedback 3）
    const topSwitcher = await evalExpr(`document.getElementById('mode-switcher')`);
    if (topSwitcher.result && topSwitcher.result.result.value === null) {
      pass('反馈 3：顶栏 mode-switcher 已移除');
    } else {
      fail('反馈 3：顶栏 mode-switcher 应移除', JSON.stringify(topSwitcher));
    }

    // 2) 模式区在样式菜单顶部（feedback 2）
    const modeFirst = await evalExpr(`(() => {
      const sections = [...document.querySelectorAll('#style-panel .sp-section[data-collapsible]')];
      return sections.length > 0 ? sections[0].dataset.collapsible : '';
    })()`);
    if (modeFirst.result && modeFirst.result.result.value === 'mode') {
      pass('反馈 2：模式区在样式菜单顶部');
    } else {
      fail('反馈 2：模式区应在样式菜单顶部', JSON.stringify(modeFirst.result));
    }

    // 3) 默认模式 = work + readonly
    const initialMode = await evalExpr(`document.body.dataset.mode`);
    if (initialMode.result && initialMode.result.result.value === 'work') {
      pass('默认 body[data-mode] = work');
    } else {
      fail('默认 body[data-mode] 应为 work');
    }
    const initialReadonly = await evalExpr(`document.body.dataset.readonly`);
    if (initialReadonly.result && initialReadonly.result.result.value === 'true') {
      pass('work 模式下 body[data-readonly=true]');
    } else {
      fail('work 模式下应只读');
    }

    // 4) bookmark-modal 标题与编辑按钮存在（feedback 5 元素存在）
    const modalTitle = await evalExpr(`document.getElementById('bm-modal-title')?.textContent`);
    if (modalTitle && modalTitle.result && modalTitle.result.result.value === '添加书签') {
      pass('反馈 5：bookmark-modal 标题已声明');
    } else {
      fail('反馈 5：bookmark-modal 标题应存在', JSON.stringify(modalTitle));
    }

    // 5) sc-mode-select 存在（feedback 6 元素存在）
    const scMode = await evalExpr(`document.getElementById('sc-mode') ? 'ok' : 'missing'`);
    if (scMode.result && scMode.result.result.value === 'ok') {
      pass('反馈 6：sc-mode-select 存在');
    } else {
      fail('反馈 6：sc-mode-select 应存在');
    }

    // 6) 工作模式：外观/布局/偏好 三个分区的 sp-content pointer-events:none
    const lockedSections = await evalExpr(`(() => {
      const result = {};
      for (const k of ['appearance', 'layout', 'prefs', 'shortcut', 'rss']) {
        const sec = document.querySelector('.sp-section[data-collapsible="' + k + '"]');
        if (!sec) { result[k] = 'missing'; continue; }
        const content = sec.querySelector('.sp-content');
        if (!content) { result[k] = 'no-content'; continue; }
        const style = window.getComputedStyle(content);
        result[k] = style.pointerEvents;
      }
      return result;
    })()`);
    const lockedData = lockedSections.result && lockedSections.result.result.value;
    if (lockedData && lockedData.appearance === 'none' && lockedData.layout === 'none' && lockedData.prefs === 'none' && lockedData.shortcut === 'none' && lockedData.rss === 'none') {
      pass('反馈 1：5 个分区均 pointer-events:none');
    } else {
      fail('反馈 1：分区应全部锁定', JSON.stringify(lockedData));
    }

    // 7) 模式区本身 NOT 锁定（用户要在哪里都能切模式）
    const modeUnlocked = await evalExpr(`(() => {
      const sec = document.querySelector('.sp-section[data-collapsible="mode"]');
      if (!sec) return 'missing';
      const content = sec.querySelector('.sp-content');
      const style = window.getComputedStyle(content);
      return style.pointerEvents;
    })()`);
    if (modeUnlocked.result && modeUnlocked.result.result.value !== 'none') {
      pass('模式区本身保持可点（不解锁方式被锁）');
    } else {
      fail('模式区本身应可点', JSON.stringify(modeUnlocked));
    }

    // 8) 切换模式：点击设置面板里的模式 segmented control 的 entertainment 选项
    await evalExpr(`(() => {
      const opt = document.querySelector('.mode-seg-opt[data-mode="entertainment"]');
      if (opt) opt.click();
    })()`);
    await sleep(800);

    const entMode = await evalExpr(`document.body.dataset.mode`);
    if (entMode.result && entMode.result.result.value === 'entertainment') {
      pass('点击设置面板切换到 entertainment 模式');
    } else {
      fail('点击切换应生效', JSON.stringify(entMode));
    }

    // 9) 娱乐模式：5 个分区解开（pointer-events 应不是 none）
    const unlockedSections = await evalExpr(`(() => {
      const result = {};
      for (const k of ['appearance', 'layout', 'prefs', 'shortcut', 'rss']) {
        const sec = document.querySelector('.sp-section[data-collapsible="' + k + '"]');
        const content = sec ? sec.querySelector('.sp-content') : null;
        const style = content ? window.getComputedStyle(content) : null;
        result[k] = style ? style.pointerEvents : 'missing';
      }
      return result;
    })()`);
    const unlockedData = unlockedSections.result && unlockedSections.result.result.value;
    const allUnlocked = unlockedData && Object.values(unlockedData).every((v) => v !== 'none');
    if (allUnlocked) {
      pass('娱乐模式：5 个分区全部解锁');
    } else {
      fail('娱乐模式：5 个分区应全部解锁', JSON.stringify(unlockedData));
    }

    // 10) 娱乐模式：拖拽手柄 + 书签编辑按钮出现
    const dragHints = await evalExpr(`document.querySelectorAll('.drag-hint').length`);
    if (dragHints.result && dragHints.result.result.value > 0) {
      pass('娱乐模式拖拽手柄恢复', dragHints.result.result.value + ' 个');
    } else {
      fail('娱乐模式拖拽手柄应恢复');
    }

    // 11) 娱乐模式：侧栏书签的 ✎ 编辑按钮可见
    const editBtns = await evalExpr(`document.querySelectorAll('.bookmark-item .bm-edit').length`);
    if (editBtns.result && editBtns.result.result.value > 0) {
      pass('侧栏书签编辑按钮可见', editBtns.result.result.value + ' 个');
    } else {
      fail('侧栏书签编辑按钮应可见');
    }

    // 12) 切回 work 模式
    await evalExpr(`(() => {
      const opt = document.querySelector('.mode-seg-opt[data-mode="work"]');
      if (opt) opt.click();
    })()`);
    await sleep(800);

    const backMode = await evalExpr(`document.body.dataset.mode`);
    if (backMode.result && backMode.result.result.value === 'work') {
      pass('切回 work 模式生效');
    } else {
      fail('切回 work 模式应生效');
    }

    // 13) localStorage 持久化
    const ls = await evalExpr(`localStorage.getItem('workbench-mode')`);
    if (ls.result && ls.result.result.value === 'work') {
      pass('localStorage workbench-mode 持久化');
    } else {
      fail('localStorage 持久化');
    }

    // 14) 页面无 JS 异常
    if (pageErrors.length === 0) {
      pass('页面无 JS 异常');
    } else {
      fail('页面存在 JS 异常', pageErrors[0]);
    }

    // 总结
    const passed = results.filter((r) => r.ok).length;
    const total = results.length;
    console.log('---');
    console.log(passed === total ? '全部通过 (' + total + ' 项)' : ('通过 ' + passed + ' / ' + total + ' 项'));
    process.exitCode = exitCode;
  } finally {
    try { if (ws) ws.close(); } catch {}
    edge.kill();
    await sleep(1200);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('[FAIL] 测试脚本异常: ' + e.message);
  process.exit(1);
});
