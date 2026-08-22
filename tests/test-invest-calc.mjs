// 投资计算器 v2 端到端测试：
// 验证流程：切到 invest 模式 → 计算器卡渲染（视图模式，外面无 input）→
//          点 ⚙ 设置 → 编辑模式（输入面板 + 实时警告）→
//          改目标权重触发警告（不阻止保存）→ 保存持仓 → 标记再平衡
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
const PROFILE = path.join(os.tmpdir(), 'workbench-invest-calc-v2-test-profile');
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

    // 0) 切到 invest 模式
    await send('Runtime.evaluate', {
      expression: `(() => {
        const opt = document.querySelector('.mode-seg-opt[data-mode="invest"]');
        if (opt) opt.click();
      })()`,
      returnByValue: true,
    });
    await sleep(1500);

    // 1) sys-invest-calc 卡片渲染 + 标题
    const calcExists = await send('Runtime.evaluate', {
      expression: `!!document.querySelector('.card[data-id="sys-invest-calc"]')`,
      returnByValue: true,
    });
    if (calcExists.result?.result?.value === true) pass('invest 模式下计算器卡渲染');
    else fail('投资计算器卡应渲染', '实际: ' + JSON.stringify(calcExists.result?.result?.value));

    const calcTitle = await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .card-title-text')?.textContent`,
      returnByValue: true,
    });
    if (calcTitle.result?.result?.value === '投资计算器') pass('计算器卡标题 = 投资计算器');
    else fail('标题应=投资计算器', '实际: ' + JSON.stringify(calcTitle.result?.result?.value));

    // 2) ⚙ 设置 按钮渲染
    const settingsBtn = await send('Runtime.evaluate', {
      expression: `!!document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-settings-btn')`,
      returnByValue: true,
    });
    if (settingsBtn.result?.result?.value === true) pass('⚙ 设置 按钮渲染');
    else fail('⚙ 设置 按钮应渲染');

    // 3) 视图模式（默认）：外面没有任何 input
    const viewInputCount = await send('Runtime.evaluate', {
      expression: `(function(){
        const card = document.querySelector('.card[data-id="sys-invest-calc"]');
        if (!card) return -1;
        const view = card.querySelector('.invest-calc-view');
        if (!view || view.style.display === 'none') return -2;
        return view.querySelectorAll('input').length;
      })()`,
      returnByValue: true,
    });
    if (viewInputCount.result?.result?.value === 0) pass('视图模式：外面无 input（外面只看结果）');
    else fail('视图模式应无 input', '实际: ' + JSON.stringify(viewInputCount.result?.result?.value));

    // 4) 旧 5 张卡片 + sys-invest-rules 全部清理
    const oldCards = ['sys-invest-rules', 'sys-invest-summary', 'sys-invest-portfolio', 'sys-invest-cadence', 'sys-invest-personal'];
    let oldGoneOk = true;
    for (const id of oldCards) {
      const e = await send('Runtime.evaluate', {
        expression: `!!document.querySelector('.card[data-id="${id}"]')`,
        returnByValue: true,
      });
      const ev = e.result?.result?.value;
      if (ev === true) { fail(`旧卡 ${id} 应已被清理`, '仍存在'); oldGoneOk = false; }
    }
    if (oldGoneOk) pass('旧 5 张投资卡已清理（含 sys-invest-rules）');

    // 5) 视图模式渲染内容：总市值/今日推荐/rebalance 按钮
    const viewSummary = await send('Runtime.evaluate', {
      expression: `(function(){
        const view = document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-view');
        if (!view) return { hasView: false };
        return {
          hasView: true,
          hasHeader: !!view.querySelector('.invest-calc-header'),
          hasTodayRec: !!view.querySelector('.invest-calc-today-rec'),
          hasTable: !!view.querySelector('.invest-calc-table'),
          hasRebBtn: !!view.querySelector('.invest-calc-rebalanced'),
        };
      })()`,
      returnByValue: true,
    });
    const vs = viewSummary.result?.result?.value;
    if (vs && vs.hasView && vs.hasHeader && vs.hasTodayRec && vs.hasTable) pass('视图模式含头部/今日推荐/对比表');
    else fail('视图模式组件不全', JSON.stringify(vs));

    // 6) 输入持仓 + 保存：制造 emergency 状态（纳指 65% vs 目标 40% → +25%）
    // 通过 API 直接保存（避免依赖编辑模式 UI 验证）
    await fetch(BASE + '/api/invest-calc/holdings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdings: {
          '红利低波50': 10000,
          '沪港深成长红利低波动': 15000,
          '中证全指': 10000,
          '纳斯达克100': 65000,
        },
      }),
    });
    await sleep(500);
    // 强制重渲
    await send('Runtime.evaluate', {
      expression: `WB.renderSystemCard('sys-invest-calc')`,
      returnByValue: true,
    });
    await sleep(800);

    // 7) 验证 emergency 状态条（红色）
    const statusClass = await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-status')?.className`,
      returnByValue: true,
    });
    if (statusClass.result?.result?.value?.includes('invest-calc-status-danger')) {
      pass('视图模式显示 emergency 状态条（红色）');
    } else {
      fail('应显示 danger 状态', '实际: ' + JSON.stringify(statusClass.result?.result?.value));
    }

    // 8) 验证今日推荐定投
    const todayRec = await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-today-rec')?.textContent`,
      returnByValue: true,
    });
    if (todayRec.result?.result?.value && todayRec.result.result.value.includes('今日推荐定投')) {
      pass('今日推荐定投已渲染');
    } else {
      fail('今日推荐定投应渲染', JSON.stringify(todayRec.result?.result?.value));
    }

    // 9) 点击 ⚙ 设置按钮 → 进入编辑模式
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-settings-btn')?.click()`,
      returnByValue: true,
    });
    await sleep(600);

    const editVisible = await send('Runtime.evaluate', {
      expression: `(function(){
        const card = document.querySelector('.card[data-id="sys-invest-calc"]');
        return card.querySelector('.invest-calc-edit').style.display !== 'none';
      })()`,
      returnByValue: true,
    });
    if (editVisible.result?.result?.value === true) pass('点 ⚙ 设置 → 进入编辑模式');
    else fail('点 ⚙ 设置应进编辑模式');

    // 10) 编辑模式：4 个目标 input + 4 个持仓 input + 1 个每日定投 input + 7 个工作日 toggle
    const editInputs = await send('Runtime.evaluate', {
      expression: `(function(){
        const edit = document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-edit');
        return {
          targetInputs: edit.querySelectorAll('.invest-calc-target-input').length,
          holdingInputs: edit.querySelectorAll('.invest-calc-holding-input').length,
          dailyInput: !!edit.querySelector('.invest-calc-daily-input'),
          workdayOpts: edit.querySelectorAll('.invest-calc-workday-opt').length,
          saveConfigBtn: !!edit.querySelector('.invest-calc-config-save'),
          cancelBtn: !!edit.querySelector('.invest-calc-config-cancel'),
        };
      })()`,
      returnByValue: true,
    });
    const ei = editInputs.result?.result?.value;
    if (ei && ei.targetInputs === 4 && ei.holdingInputs === 4 && ei.dailyInput && ei.workdayOpts === 7 && ei.saveConfigBtn && ei.cancelBtn) {
      pass('编辑模式：4 目标+4 持仓+1 每日定投+7 工作日+保存/取消按钮');
    } else {
      fail('编辑模式组件不全', JSON.stringify(ei));
    }

    // 11) 软约束警告实时计算：把纳指改成 50（超 40 上限）→ 应出现红字警告
    await send('Runtime.evaluate', {
      expression: `(function(){
        const inputs = document.querySelectorAll('.invest-calc-edit .invest-calc-target-input');
        // 调整到总和仍 = 100：纳指 50，其它等比例缩小
        inputs[0].value = 15;   // 红利低波50 (原 20)
        inputs[1].value = 20;   // 沪港深成长 (原 25)
        inputs[2].value = 15;   // 中证全指 (原 15)
        inputs[3].value = 50;   // 纳斯达克 (原 40 → 50)
        inputs[3].dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
      returnByValue: true,
    });
    await sleep(300);
    const warningCount = await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.card[data-id="sys-invest-calc"] .invest-calc-warning').length`,
      returnByValue: true,
    });
    if (warningCount.result?.result?.value >= 1) pass('纳指 > 40% 触发警告');
    else fail('纳指 > 40% 应触发警告', '实际: ' + JSON.stringify(warningCount.result?.result?.value));

    // 12) 双红利低波合计 > 45% 警告
    await send('Runtime.evaluate', {
      expression: `(function(){
        const inputs = document.querySelectorAll('.invest-calc-edit .invest-calc-target-input');
        // 红利低波50 = 30, 沪港深成长 = 25 → 合计 55 > 45
        inputs[0].value = 30;
        inputs[1].value = 25;
        inputs[2].value = 15;
        inputs[3].value = 30;
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
      returnByValue: true,
    });
    await sleep(300);
    const duoWarn = await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.card[data-id="sys-invest-calc"] .invest-calc-warning').length`,
      returnByValue: true,
    });
    if (duoWarn.result?.result?.value >= 2) pass('双红利低波合计 > 45% 触发警告（+ 纳指 30% 不超 → 1 条）');
    else fail('双红利低波合计 > 45% 应触发警告', '实际: ' + JSON.stringify(duoWarn.result?.result?.value));

    // 13) 警告不阻止保存：调 POST /api/invest-calc/config（总市值仍合理）
    const configSaveResp = await fetch(BASE + '/api/invest-calc/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets: { '红利低波50': 30, '沪港深成长红利低波动': 25, '中证全指': 15, '纳斯达克100': 30 },
        dailyPerWorkday: 150,
        workdays: [1, 2, 3, 4, 5],
      }),
    });
    const configSaveData = await configSaveResp.json();
    if (configSaveData.ok) pass('警告状态下保存配置仍成功（不阻止）');
    else fail('警告状态下应允许保存', JSON.stringify(configSaveData));

    // 14) 验证 dailyPerWorkday 已持久化
    const apiCheck = await fetch(BASE + '/api/invest-calc');
    const apiData = await apiCheck.json();
    if (apiData.ok && apiData.data.dailyPerWorkday === 150 && apiData.data.workdays.length === 5) {
      pass('dailyPerWorkday + workdays 已持久化');
    } else {
      fail('配置未持久化', JSON.stringify(apiData.data));
    }

    // 15) 标记已再平衡
    await send('Runtime.evaluate', {
      expression: `WB.renderSystemCard('sys-invest-calc')`,
      returnByValue: true,
    });
    await sleep(500);
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-rebalanced')?.click()`,
      returnByValue: true,
    });
    await sleep(800);
    const afterReb = await fetch(BASE + '/api/invest-calc');
    const afterRebData = await afterReb.json();
    if (afterRebData.ok && afterRebData.data.lastRebalance) {
      pass(`lastRebalance 已更新 = ${afterRebData.data.lastRebalance}`);
    } else {
      fail('lastRebalance 应更新', JSON.stringify(afterRebData.data));
    }

    // 16) 页面无 JS 异常
    if (pageErrors.length) {
      fail('页面 JS 异常', pageErrors.join(' | '));
    } else {
      pass('页面无 JS 异常');
    }
  } finally {
    if (ws) ws.close();
    try { edge.kill(); } catch {}
    // 清理：恢复 holdings 为空 + targets 回默认（避免污染用户数据）
    try {
      await fetch(BASE + '/api/invest-calc/holdings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: {} }),
      });
      await fetch(BASE + '/api/invest-calc/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targets: { '红利低波50': 20, '沪港深成长红利低波动': 25, '中证全指': 15, '纳斯达克100': 40 },
          dailyPerWorkday: 100,
          workdays: [1, 2, 3, 4, 5],
        }),
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