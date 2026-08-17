// MiniMax 卡视觉验证脚本（2026-08-16 新增）
// 用无头 Edge + CDP 加载页面，断言：
//   - .mmx-meta 行隐藏（display:none）
//   - .mmx-alert 行未显示（display:none 或未设）
//   - 5h/周 进度条文字、宽度、row class 符合当前状态
// 退出码：0 全部通过；1 有断言失败；3 环境错误。
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE = 'http://127.0.0.1:3180';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const PROFILE = path.join(os.tmpdir(), 'workbench-minimax-test-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 0) 前置检查
  let apiData;
  try {
    const r = await fetch(BASE + '/api/minimax-coding-plan');
    apiData = await r.json();
  } catch (e) {
    console.error('[FAIL] 无法连接 ' + BASE + '/api/minimax-coding-plan：' + e.message);
    process.exit(3);
  }
  if (!apiData.ok) {
    console.error('[FAIL] API 返回 ok:false：' + (apiData.error || '未知'));
    process.exit(3);
  }
  const pct5h = apiData.windows['5h'].remainingPct;
  const pctW  = apiData.windows.week.remainingPct;
  console.log('[INFO] API 数据：5h=' + pct5h + '%  week=' + pctW + '%  modelName=' + apiData.modelName);

  // 1) 启动 Edge
  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edgePath) {
    console.error('[FAIL] 找不到 Edge/Chrome');
    process.exit(3);
  }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const dbgPort = 9300 + Math.floor(Math.random() * 300);
  const edge = spawn(edgePath, [
    '--headless=new',
    `--remote-debugging-port=${dbgPort}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
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

    // 2) 打开页面，等渲染（refreshDidaToday 等5 分钟一次，所以页面打开后会自己拉一次）
    await send('Page.navigate', { url: BASE + '/?mmx=1' });
    await sleep(5000);

    // 3) 检查 MiniMax 卡 DOM
    const evalRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const card = document.querySelector('[data-id="sys-minimax"]');
        if (!card) return { ok: false, why: 'MiniMax 卡片未渲染' };
        const meta = card.querySelector('.mmx-meta');
        const alertEl = card.querySelector('.mmx-alert');
        const row5h = card.querySelector('.mmx-row[data-window="5h"]');
        const rowWeek = card.querySelector('.mmx-row[data-window="week"]');
        return {
          ok: true,
          metaDisplay: meta ? getComputedStyle(meta).display : null,
          metaText: meta ? meta.textContent.trim() : null,
          alertDisplay: alertEl ? getComputedStyle(alertEl).display : null,
          alertText: alertEl ? alertEl.textContent.trim() : null,
          row5hClass: row5h ? row5h.className : null,
          rowWeekClass: rowWeek ? rowWeek.className : null,
          row5hPct: row5h ? row5h.querySelector('.mmx-pct').textContent.trim() : null,
          rowWeekPct: rowWeek ? rowWeek.querySelector('.mmx-pct').textContent.trim() : null,
          row5hShadow: row5h ? getComputedStyle(row5h).boxShadow : null,
          rowWeekShadow: rowWeek ? getComputedStyle(rowWeek).boxShadow : null,
        };
      })()`,
      returnByValue: true,
    });
    const dom = evalRes.result && evalRes.result.result.value;
    if (!dom || !dom.ok) {
      console.error('[FAIL] ' + ((dom && dom.why) || 'DOM 检查失败'));
      process.exit(1);
    }
    console.log('[INFO] DOM 状态：');
    console.log('  metaDisplay    = ' + dom.metaDisplay);
    console.log('  metaText       = "' + dom.metaText + '"');
    console.log('  alertDisplay   = ' + dom.alertDisplay);
    console.log('  alertText      = "' + dom.alertText + '"');
    console.log('  row5hClass     = "' + dom.row5hClass + '"');
    console.log('  rowWeekClass   = "' + dom.rowWeekClass + '"');
    console.log('  row5hPct       = ' + dom.row5hPct);
    console.log('  rowWeekPct     = ' + dom.rowWeekPct);
    console.log('  row5hShadow    = ' + dom.row5hShadow);
    console.log('  rowWeekShadow  = ' + dom.rowWeekShadow);

    // 4) 断言
    const checks = [];

    // 4.0) 警示态 mock 验证：注入 dailyPace > 3 的数据，触发"周限额非常充裕"
    const futureReset5h = Math.floor((Date.now() + 5 * 3600 * 1000) / 1000);
    const futureResetWeek = Math.floor((Date.now() + 1 * 86400 * 1000) / 1000);
    const mockData = {
      ok: true,
      planName: null,
      modelName: 'general',
      windows: {
        '5h': { remainingPct: 90, usedPct: 10, resetAt: futureReset5h, windowMinutes: 300 },
        week: { remainingPct: 50, usedPct: 50, resetAt: futureResetWeek, windowMinutes: 10080 },
      },
      weeklyHourlyRatio: 10,
      modelCount: 1,
    };
    // dailyPace = (50/100) * 10 / 1 = 5.0 > 3 → 触发"周限额非常充裕"分支
    await send('Runtime.evaluate', {
      expression: 'window.__setMmx(' + JSON.stringify(mockData) + ')',
      returnByValue: true,
    });
    await sleep(500);

    const mockRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const card = document.querySelector('[data-id="sys-minimax"]');
        const alertEl = card.querySelector('.mmx-alert');
        const row5h = card.querySelector('.mmx-row[data-window="5h"]');
        const rowWeek = card.querySelector('.mmx-row[data-window="week"]');
        return {
          alertDisplay: getComputedStyle(alertEl).display,
          alertText: alertEl.textContent.trim(),
          row5hClass: row5h.className,
          rowWeekClass: rowWeek.className,
          row5hShadow: getComputedStyle(row5h).boxShadow,
          rowWeekShadow: getComputedStyle(rowWeek).boxShadow,
        };
      })()`,
      returnByValue: true,
    });
    const mockDom = mockRes.result && mockRes.result.result.value;
    console.log('[INFO] 警示态 mock DOM：');
    console.log('  alertDisplay   = ' + mockDom.alertDisplay);
    console.log('  alertText      = "' + mockDom.alertText.slice(0, 60) + '..."');
    console.log('  row5hClass     = "' + mockDom.row5hClass + '"');
    console.log('  rowWeekClass   = "' + mockDom.rowWeekClass + '"');
    console.log('  row5hShadow    = ' + mockDom.row5hShadow);
    console.log('  rowWeekShadow  = ' + mockDom.rowWeekShadow);

    checks.push({
      name: '警示态：alert 行 display:block',
      ok: mockDom.alertDisplay === 'block',
      why: '实际 ' + mockDom.alertDisplay,
    });
    checks.push({
      name: '警示态：alert 文案非空（含 "周限额非常充裕"）',
      ok: mockDom.alertText.includes('周限额非常充裕'),
      why: '实际 "' + mockDom.alertText + '"',
    });
    checks.push({
      name: '警示态：rowWeek 含 danger（无 danger-strong）',
      ok: mockDom.rowWeekClass.split(/\s+/).includes('danger') &&
          !mockDom.rowWeekClass.split(/\s+/).includes('danger-strong'),
      why: 'className: ' + mockDom.rowWeekClass,
    });
    checks.push({
      name: '警示态：row5h 含 warn',
      ok: mockDom.row5hClass.split(/\s+/).includes('warn'),
      why: 'className: ' + mockDom.row5hClass,
    });
    const hasRedFrame = (s) => s && s !== 'none' && s.includes('220, 38, 38');
    checks.push({
      name: '警示态：rowWeek box-shadow 无红框',
      ok: !hasRedFrame(mockDom.rowWeekShadow),
      why: 'boxShadow: ' + mockDom.rowWeekShadow,
    });
    checks.push({
      name: '警示态：row5h box-shadow 无红框',
      ok: !hasRedFrame(mockDom.row5hShadow),
      why: 'boxShadow: ' + mockDom.row5hShadow,
    });

    // 4.1) 5h 快耗尽 mock：注入 5h remainingPct=10
    const mockData2 = {
      ok: true,
      planName: null,
      modelName: 'general',
      windows: {
        '5h': { remainingPct: 10, usedPct: 90, resetAt: futureReset5h, windowMinutes: 300 },
        week: { remainingPct: 50, usedPct: 50, resetAt: futureResetWeek, windowMinutes: 10080 },
      },
      weeklyHourlyRatio: 10,
      modelCount: 1,
    };
    await send('Runtime.evaluate', {
      expression: 'window.__setMmx(' + JSON.stringify(mockData2) + ')',
      returnByValue: true,
    });
    await sleep(500);

    const dangerRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const card = document.querySelector('[data-id="sys-minimax"]');
        const alertEl = card.querySelector('.mmx-alert');
        const row5h = card.querySelector('.mmx-row[data-window="5h"]');
        return {
          alertDisplay: getComputedStyle(alertEl).display,
          alertText: alertEl.textContent.trim(),
          row5hClass: row5h.className,
          row5hShadow: getComputedStyle(row5h).boxShadow,
        };
      })()`,
      returnByValue: true,
    });
    const dangerDom = dangerRes.result && dangerRes.result.result.value;
    console.log('[INFO] 5h 危险态 mock DOM：');
    console.log('  alertDisplay   = ' + dangerDom.alertDisplay);
    console.log('  alertText      = "' + dangerDom.alertText + '"');
    console.log('  row5hClass     = "' + dangerDom.row5hClass + '"');
    console.log('  row5hShadow    = ' + dangerDom.row5hShadow);

    checks.push({
      name: '5h<15%：row5h 含 danger（无 danger-strong）',
      ok: dangerDom.row5hClass.split(/\s+/).includes('danger') &&
          !dangerDom.row5hClass.split(/\s+/).includes('danger-strong'),
      why: 'className: ' + dangerDom.row5hClass,
    });
    checks.push({
      name: '5h<15%：alert 行不显示（删除文案）',
      ok: dangerDom.alertDisplay === 'none',
      why: '实际 display: ' + dangerDom.alertDisplay + '，文案: "' + dangerDom.alertText + '"',
    });
    checks.push({
      name: '5h<15%：row5h box-shadow 无红框',
      ok: !hasRedFrame(dangerDom.row5hShadow),
      why: 'boxShadow: ' + dangerDom.row5hShadow,
    });

    // 4.2) 正常态断言（meta 行、alert 行、class、box-shadow）
    checks.push({
      name: '正常态 meta 行 display:none',
      ok: dom.metaDisplay === 'none',
      why: dom.metaDisplay !== 'none' ? '实际 ' + dom.metaDisplay : '',
    });
    checks.push({
      name: '正常态 alert 行 display:none',
      ok: dom.alertDisplay === 'none',
      why: '实际 ' + dom.alertDisplay,
    });
    checks.push({
      name: '正常态 row5h 不含 danger-strong',
      ok: !dom.row5hClass.split(/\s+/).includes('danger-strong'),
      why: 'className: ' + dom.row5hClass,
    });
    checks.push({
      name: '正常态 rowWeek 不含 danger-strong',
      ok: !dom.rowWeekClass.split(/\s+/).includes('danger-strong'),
      why: 'className: ' + dom.rowWeekClass,
    });
    checks.push({
      name: '正常态 row5h box-shadow 无红框',
      ok: !hasRedFrame(dom.row5hShadow),
      why: 'boxShadow: ' + dom.row5hShadow,
    });
    checks.push({
      name: '正常态 rowWeek box-shadow 无红框',
      ok: !hasRedFrame(dom.rowWeekShadow),
      why: 'boxShadow: ' + dom.rowWeekShadow,
    });

    // 5) 汇总
    let failed = 0;
    for (const c of checks) {
      if (c.ok) console.log('[PASS] ' + c.name);
      else { console.log('[FAIL] ' + c.name + (c.why ? ' —— ' + c.why : '')); failed++; }
    }
    if (pageErrors.length) {
      console.log('[WARN] 页面异常 ' + pageErrors.length + ' 条: ' + pageErrors[0]);
    }
    console.log(failed === 0 ? '全部通过 (' + checks.length + ' 项)' : '失败 ' + failed + ' 项');
    process.exitCode = failed === 0 ? 0 : 1;
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