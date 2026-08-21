// 投资计算器端到端测试（v1.x）：
// 验证流程：切到 invest 模式 → 计算器卡渲染 → 输入持仓 → 保存 → 偏差色码 → 状态判断 → 标记再平衡
//
// 用法：node tests/test-invest-calc.mjs（要求 workbench 在 3180 端口运行）

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE = 'http://127.0.0.1:3180';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PROFILE = path.join(os.tmpdir(), 'workbench-invest-calc-test-profile');
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
    const hasInvest = cfg.modes.some((m) => m.id === 'invest');
    if (!hasInvest) { console.error('[FAIL] modes.json 缺少 invest 模式'); process.exit(2); }
  } catch (e) {
    console.error('[FAIL] 服务未启动: ' + e.message);
    process.exit(2);
  }

  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edgePath) { console.error('[FAIL] Edge not found'); process.exit(2); }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const dbgPort = 9650 + Math.floor(Math.random() * 200);
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
    await sleep(3000);

    // 1) 切到 invest 模式
    await send('Runtime.evaluate', {
      expression: `(() => {
        const opt = document.querySelector('.mode-seg-opt[data-mode="invest"]');
        if (opt) opt.click();
      })()`,
      returnByValue: true,
    });
    await sleep(1500);

    // 2) 断言：sys-invest-calc 卡片渲染 + 标题 + body
    const calcExists = await send('Runtime.evaluate', {
      expression: `!!document.querySelector('.card[data-id="sys-invest-calc"]')`,
      returnByValue: true,
    });
    const calcExistsVal = calcExists.result && calcExists.result.result && calcExists.result.result.value;
    if (calcExistsVal === true) pass('invest 模式下计算器卡渲染');
    else fail('投资计算器卡应渲染', '实际: ' + JSON.stringify(calcExistsVal));

    const calcTitle = await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .card-title-text')?.textContent`,
      returnByValue: true,
    });
    const calcTitleVal = calcTitle.result && calcTitle.result.result && calcTitle.result.result.value;
    if (calcTitleVal === '投资计算器') pass('计算器卡标题 = 投资计算器');
    else fail('标题应=投资计算器', '实际: ' + JSON.stringify(calcTitleVal));

    // 3) 断言：旧的 5 张卡片都不在 DOM（验证清理成功）
    const oldCards = ['sys-invest-summary', 'sys-invest-portfolio', 'sys-invest-cadence', 'sys-invest-personal'];
    let oldGoneOk = true;
    for (const id of oldCards) {
      const e = await send('Runtime.evaluate', {
        expression: `!!document.querySelector('.card[data-id="${id}"]')`,
        returnByValue: true,
      });
      const ev = e.result && e.result.result && e.result.result.value;
      if (ev === true) { fail(`旧卡 ${id} 应已被清理`, '仍存在'); oldGoneOk = false; }
    }
    if (oldGoneOk) pass('旧 4 张投资卡已清理（summary/portfolio/cadence/personal）');

    // 4) sys-invest-rules 仍然存在
    const rulesExists = await send('Runtime.evaluate', {
      expression: `!!document.querySelector('.card[data-id="sys-invest-rules"]')`,
      returnByValue: true,
    });
    const rulesVal = rulesExists.result && rulesExists.result.result && rulesExists.result.result.value;
    if (rulesVal === true) pass('硬约束卡仍存在（保留）');
    else fail('硬约束卡应保留', '实际: ' + JSON.stringify(rulesVal));

    // 5) 4 个 input + 目标权重表
    const inputCount = await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.invest-calc-input').length`,
      returnByValue: true,
    });
    const inputCountVal = inputCount.result && inputCount.result.result && inputCount.result.result.value;
    if (inputCountVal === 4) pass('4 个持仓金额 input 已渲染');
    else fail('应 4 个 input', '实际: ' + JSON.stringify(inputCountVal));

    // 6) 输入测试数据（制造明显 ±25% 偏差，确保 strict > 10% 触发 emergency）
    const inputSetExpr = `(() => {
      const inputs = document.querySelectorAll('.invest-calc-input');
      // 总额 100000：纳指 65000（65% / 40% → +25%）触发 emergency；红利低波50 10000（10% / 20% → -10%）warn
      inputs[0].value = 10000;
      inputs[1].value = 15000;
      inputs[2].value = 10000;
      inputs[3].value = 65000;
      return 'set';
    })()`;
    await send('Runtime.evaluate', { expression: inputSetExpr, returnByValue: true });
    await sleep(300);

    // 7) 点击"保存"
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.invest-calc-save')?.click()`,
      returnByValue: true,
    });
    await sleep(1500); // 等保存 + 重渲染

    // 8) 验证保存：服务器状态
    const apiCheck = await fetch(BASE + '/api/invest-calc');
    const apiData = await apiCheck.json();
    if (apiData.ok && apiData.data.total === 100000) {
      pass(`保存生效：total = ¥${apiData.data.total.toLocaleString()}`);
    } else {
      fail('保存应生效', JSON.stringify(apiData.data));
    }

    // 9) 验证状态判断：emergency（纳指 65% vs 40% = +25%）
    if (apiData.data.status === 'emergency') pass('状态判断 = emergency（纳指偏差 +25%）');
    else fail('应=emergency', '实际: ' + apiData.data.status + ' actions=' + JSON.stringify(apiData.data.actions));

    // 10) 验证操作步骤：应有 sell 纳指 10000 + buy 其它
    const actions = apiData.data.actions || [];
    const hasSellNasdaq = actions.some((a) => a.type === 'sell' && a.asset === '纳斯达克100');
    if (hasSellNasdaq) pass('操作步骤含卖出纳指');
    else fail('应卖出纳指', JSON.stringify(actions));

    // 11) 验证 UI 显示 emergency 状态条
    const statusClass = await send('Runtime.evaluate', {
      expression: `document.querySelector('.invest-calc-status')?.className`,
      returnByValue: true,
    });
    const statusClassVal = statusClass.result && statusClass.result.result && statusClass.result.result.value;
    if (statusClassVal && statusClassVal.includes('invest-calc-status-danger')) {
      pass('UI 显示 emergency 状态条（红色）');
    } else {
      fail('UI 应显示 danger 状态', '实际: ' + JSON.stringify(statusClassVal));
    }

    // 12) 验证偏差色码：纳指应红色（>10%）
    const devDebug = await send('Runtime.evaluate', {
      expression: `(() => {
        const rows = document.querySelectorAll('.invest-calc-table tbody tr');
        const info = { rowCount: rows.length, cellsPerRow: [], nasdaqCells: null };
        for (const r of rows) {
          info.cellsPerRow.push(r.cells.length);
          if (r.cells[0]?.textContent === '纳斯达克100') {
            info.nasdaqCells = {
              c0: r.cells[0]?.outerHTML?.slice(0, 80),
              c1: r.cells[1]?.outerHTML?.slice(0, 80),
              c2: r.cells[2]?.outerHTML?.slice(0, 80),
              c3: r.cells[3]?.outerHTML?.slice(0, 80),
              c3class: r.cells[3]?.className,
            };
          }
        }
        return info;
      })()`,
      returnByValue: true,
    });
    const devDebugVal = devDebug.result && devDebug.result.result && devDebug.result.result.value;
    if (devDebugVal && devDebugVal.nasdaqCells && devDebugVal.nasdaqCells.c3class && devDebugVal.nasdaqCells.c3class.includes('invest-calc-dev-danger')) {
      pass('纳指偏差色码 = danger（红色）');
    } else {
      fail('纳指应红色', JSON.stringify(devDebugVal));
    }

    // 13) 点击"标记已再平衡"
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.invest-calc-rebalanced')?.click()`,
      returnByValue: true,
    });
    await sleep(1000);
    const afterReb = await fetch(BASE + '/api/invest-calc');
    const afterRebData = await afterReb.json();
    if (afterRebData.ok && afterRebData.data.lastRebalance) {
      pass(`lastRebalance 已更新 = ${afterRebData.data.lastRebalance}`);
    } else {
      fail('lastRebalance 应更新', JSON.stringify(afterRebData.data));
    }

    // 14) 页面无 JS 异常
    if (pageErrors.length) {
      fail('页面 JS 异常', pageErrors.join(' | '));
    } else {
      pass('页面无 JS 异常');
    }
  } finally {
    if (ws) ws.close();
    try { edge.kill(); } catch {}
    // 清理测试数据：恢复 holdings 为空
    try {
      await fetch(BASE + '/api/invest-calc/holdings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: {} }),
      });
    } catch {}
  }

  console.log(`\n--- ${results.filter((r) => r.ok).length} 通过 / ${results.length} 总计 ---`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(2);
});