// 布局按模式持久化回归测试（v1）：
// 用户原话（2026-08-22）："我投资选择了网格布局后，我进行刷新页面，又变成了其他布局形式，这个稳定复现"
//
// 根因：app.js applyStyle() 顺序错——getLayoutForMode(currentMode) 在 currentMode 从
// localStorage `workbench-mode` 读取+校验之前调用；init() 首次调 applyStyle 时 currentMode
// 还是 WB 默认 'work'，于是拿 work 的 layout 写到 body，再更新 currentMode 也晚了。
//
// 本测试复现：localStorage 预置 mode=invest + workbench-layout-by-mode.invest='grid'，
// 加载页面后断言 body[data-layout] === 'grid'（不是 work 的默认布局）。
//
// 用法：node tests/test-layout-persistence.mjs（要求 workbench 服务在 3180 端口运行）

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE = 'http://127.0.0.1:3180';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PROFILE = path.join(os.tmpdir(), 'workbench-layout-persist-test-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let exitCode = 0;
function pass(name, detail) { results.push({ ok: true, name, detail }); console.log('[PASS]', name, detail ? '— ' + detail : ''); }
function fail(name, detail) { results.push({ ok: false, name, detail }); console.log('[FAIL]', name, detail ? '— ' + detail : ''); exitCode = 1; }

async function main() {
  // 服务可用性预检
  try {
    const r = await fetch(BASE + '/api/modes');
    const cfg = await r.json();
    if (!cfg.modes || !cfg.modes.length) {
      console.error('[FAIL] /api/modes 不可用');
      process.exit(2);
    }
    const hasInvest = cfg.modes.some((m) => m.id === 'invest');
    if (!hasInvest) {
      console.error('[FAIL] modes.json 缺少 invest 模式（测试需要）');
      process.exit(2);
    }
  } catch (e) {
    console.error('[FAIL] 服务未启动: ' + e.message);
    process.exit(2);
  }

  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edgePath) { console.error('[FAIL] Edge not found'); process.exit(2); }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const dbgPort = 9550 + Math.floor(Math.random() * 200);
  const edge = spawn(edgePath, [
    '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    // 等 CDP 就绪
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

    // 复现步骤 1: 先访问一次页面（建立 origin，localStorage 才能写）
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(2000);

    // 复现步骤 2: 模拟用户操作——切到 invest 模式 + 选 grid 布局
    // （等价于用户实际场景：进 invest 模式 → 样式面板点 grid）
    // 注意：workbench-mode 是原始字符串（setMode 里直接 localStorage.setItem(MODE_KEY, v)），
    //       不是 JSON.stringify(v)；workbench-layout-by-mode 才是 JSON 对象。
    const setupExpr = `(() => {
      try {
        localStorage.setItem('workbench-mode', 'invest');
        localStorage.setItem('workbench-layout-by-mode', JSON.stringify({
          work: 'split-center',
          entertainment: 'grid',
          invest: 'grid',
        }));
        return 'ok';
      } catch (e) {
        return 'err: ' + e.message;
      }
    })()`;
    const setupRes = await send('Runtime.evaluate', { expression: setupExpr, returnByValue: true });
    const setupVal = setupRes.result && setupRes.result.result && setupRes.result.result.value;
    if (setupVal !== 'ok') fail('localStorage 预置失败', JSON.stringify(setupVal));
    else pass('localStorage 预置：mode=invest + layout[invest]=grid');

    // 复现步骤 3: 刷新页面——这是 bug 触发的关键
    await send('Page.reload');
    await sleep(3000); // 等 init() / applyStyle() / fetchJSON('/api/modes') 全部跑完

    // 断言 1: body[data-mode] 应该是 'invest'
    const modeCheck = await send('Runtime.evaluate', { expression: 'document.body.dataset.mode', returnByValue: true });
    const modeVal = modeCheck.result && modeCheck.result.result && modeCheck.result.result.value;
    if (modeVal === 'invest') pass('刷新后 body[data-mode] === invest');
    else fail('刷新后 mode 应为 invest', '实际: ' + JSON.stringify(modeVal));

    // 断言 2 (核心): body[data-layout] 应该是 'grid'（不是 work 的 split-center）
    const layoutCheck = await send('Runtime.evaluate', { expression: 'document.body.dataset.layout', returnByValue: true });
    const layoutVal = layoutCheck.result && layoutCheck.result.result && layoutCheck.result.result.value;
    if (layoutVal === 'grid') pass('刷新后 body[data-layout] === grid（bug 修复生效）');
    else fail('刷新后 layout 应为 grid（用户报告的 bug）', '实际: ' + JSON.stringify(layoutVal));

    // 断言 3: 样式面板中 grid 按钮应高亮（active class）
    const gridActive = await send('Runtime.evaluate', {
      expression: `document.querySelector('.sp-opt[data-layout-opt="grid"]')?.classList.contains('active')`,
      returnByValue: true,
    });
    const gridActiveVal = gridActive.result && gridActive.result.result && gridActive.result.result.value;
    if (gridActiveVal === true) pass('样式面板 grid 按钮 active 态');
    else fail('样式面板 grid 按钮应 active', '实际: ' + JSON.stringify(gridActiveVal));

    // 断言 4: 切到 work 模式 → 应恢复 work 的 split-center 布局
    await send('Runtime.evaluate', {
      expression: `(() => {
        const opt = document.querySelector('.mode-seg-opt[data-mode="work"]');
        if (opt) opt.click();
      })()`,
      returnByValue: true,
    });
    await sleep(800);
    const workLayoutCheck = await send('Runtime.evaluate', { expression: 'document.body.dataset.layout', returnByValue: true });
    const workLayoutVal = workLayoutCheck.result && workLayoutCheck.result.result && workLayoutCheck.result.result.value;
    if (workLayoutVal === 'split-center') pass('切到 work 模式 → layout 自动恢复 split-center');
    else fail('切到 work 模式应自动恢复 split-center', '实际: ' + JSON.stringify(workLayoutVal));

    // 断言 5: 再切回 invest → 应恢复 invest 的 grid 布局（双向独立持久化）
    await send('Runtime.evaluate', {
      expression: `(() => {
        const opt = document.querySelector('.mode-seg-opt[data-mode="invest"]');
        if (opt) opt.click();
      })()`,
      returnByValue: true,
    });
    await sleep(800);
    const reInvestCheck = await send('Runtime.evaluate', { expression: 'document.body.dataset.layout', returnByValue: true });
    const reInvestVal = reInvestCheck.result && reInvestCheck.result.result && reInvestCheck.result.result.value;
    if (reInvestVal === 'grid') pass('切回 invest 模式 → layout 仍为 grid（双向独立）');
    else fail('切回 invest 应保持 grid', '实际: ' + JSON.stringify(reInvestVal));

    // 页面 JS 异常检查
    if (pageErrors.length) {
      fail('页面 JS 异常', pageErrors.join(' | '));
    } else {
      pass('页面无 JS 异常');
    }
  } finally {
    if (ws) ws.close();
    try { edge.kill(); } catch {}
  }

  console.log(`\n--- ${results.filter((r) => r.ok).length} 通过 / ${results.length} 总计 ---`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(2);
});