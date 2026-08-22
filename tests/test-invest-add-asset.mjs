// 投资计算器 v3.4 自加标的 端到端测试：
// 验证流程：切到 invest 模式 → 点 ⚙ 设置 → 编辑模式有"添加标的"输入 + 每行删除按钮 →
//          添加新标的（目标/持仓两列表同步出现）→ 重复添加被拒（行数不增）→
//          保存后 GET 返回新标的（targets + holdings）→ 重新进编辑删除新标的 →
//          保存后 GET 不再有该标的（targets 移除 + holdings 残留被修剪）。
//
// 用法：node tests/test-invest-add-asset.mjs（要求 workbench 在 3180 端口运行）

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = 'http://127.0.0.1:3180';
const NEW_ASSET = '测试标的A';
// 由本测试文件位置推导 workbench 根目录（避免在仓库里硬编码本机绝对路径）
const WORKBENCH_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PROFILE = path.join(os.tmpdir(), 'workbench-invest-add-asset-test-profile');
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

  // 捕获测试前配置 + 持仓，最后 finally 恢复——避免测试改坏用户数据
  let beforeConfig = { targets: { '红利低波50': 20, '沪港深成长红利低波动': 25, '中证全指': 15, '纳斯达克100': 40 }, dailyPerWorkday: 180 };
  let beforeHoldings = {};
  try {
    const beforeResp = await fetch(BASE + '/api/invest-calc').then((r) => r.json());
    if (beforeResp.ok && beforeResp.data) {
      beforeConfig = {
        targets: beforeResp.data.targets,
        dailyPerWorkday: beforeResp.data.dailyPerWorkday,
        showSellInRebalance: beforeResp.data.showSellInRebalance,
      };
      beforeHoldings = {};
      (beforeResp.data.rows || []).forEach((r) => { beforeHoldings[r.name] = r.amount; });
    }
  } catch (e) {
    console.error('[WARN] 读取测试前投资配置失败（恢复将使用默认值）: ' + e.message);
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

    // 1) 卡片渲染 + ⚙ 设置
    const calcExists = await send('Runtime.evaluate', {
      expression: `!!document.querySelector('.card[data-id="sys-invest-calc"]')`,
      returnByValue: true,
    });
    if (calcExists.result?.result?.value === true) pass('invest 模式下计算器卡渲染');
    else fail('投资计算器卡应渲染', JSON.stringify(calcExists.result?.result?.value));

    // 2) 进编辑模式
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-settings-btn')?.click()`,
      returnByValue: true,
    });
    await sleep(600);
    const editVisible = await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-edit').style.display !== 'none'`,
      returnByValue: true,
    });
    if (editVisible.result?.result?.value === true) pass('点 ⚙ 设置 → 进入编辑模式');
    else fail('点 ⚙ 设置应进编辑模式');

    // 3) 添加标的 UI 存在：输入框 + 按钮 + 每行删除按钮
    const editUIs = await send('Runtime.evaluate', {
      expression: `(function(){
        const edit = document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-edit');
        const targetCount = edit.querySelectorAll('.invest-calc-targets-list .invest-calc-target-row').length;
        const holdCount = edit.querySelectorAll('.invest-calc-holdings-list .invest-calc-target-row').length;
        return {
          hasAddInput: !!edit.querySelector('.invest-calc-add-asset-input'),
          hasAddBtn: !!edit.querySelector('.invest-calc-add-asset-btn'),
          targetRemoveBtns: edit.querySelectorAll('.invest-calc-targets-list .invest-calc-remove-btn').length,
          holdRemoveBtns: edit.querySelectorAll('.invest-calc-holdings-list .invest-calc-remove-btn').length,
          targetCount, holdCount,
        };
      })()`,
      returnByValue: true,
    });
    const ui = editUIs.result?.result?.value;
    if (ui && ui.hasAddInput && ui.hasAddBtn &&
        ui.targetRemoveBtns === ui.targetCount && ui.holdRemoveBtns === ui.holdCount &&
        ui.targetCount === ui.holdCount && ui.targetCount >= 1) {
      pass('编辑模式：添加标的输入+按钮渲染，且每行都有删除按钮（目标/持仓行数一致）',
        `目标 ${ui.targetCount} 行 / 持仓 ${ui.holdCount} 行`);
    } else {
      fail('添加标的 UI 缺失', JSON.stringify(ui));
    }

    // 4) 添加新标的 → 目标/持仓两列表同步出现新行 + 输入框清空
    await send('Runtime.evaluate', {
      expression: `(function(){
        const input = document.querySelector('.invest-calc-edit .invest-calc-add-asset-input');
        input.value = '${NEW_ASSET}';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.invest-calc-edit .invest-calc-add-asset-btn').click();
      })()`,
      returnByValue: true,
    });
    await sleep(300);
    const addedRows = await send('Runtime.evaluate', {
      expression: `(function(){
        const edit = document.querySelector('.invest-calc-edit');
        return {
          t: !!edit.querySelector('.invest-calc-targets-list [data-asset="${NEW_ASSET}"]'),
          h: !!edit.querySelector('.invest-calc-holdings-list [data-asset="${NEW_ASSET}"]'),
          inputVal: edit.querySelector('.invest-calc-add-asset-input').value,
        };
      })()`,
      returnByValue: true,
    });
    const ar = addedRows.result?.result?.value;
    if (ar && ar.t && ar.h && ar.inputVal === '') pass('添加标的：目标+持仓两列表同步出现，输入框已清空');
    else fail('添加标的后两列表未同步', JSON.stringify(ar));

    // 5) 重复添加被拒（行数不增加）——注意：每行有 3 个元素带 data-asset（行 div + 输入框 + 删除按钮），
    //    所以单行 = 3 个匹配；用 .invest-calc-target-row 限定只数行。
    await send('Runtime.evaluate', {
      expression: `(function(){
        const input = document.querySelector('.invest-calc-edit .invest-calc-add-asset-input');
        input.value = '${NEW_ASSET}';
        document.querySelector('.invest-calc-edit .invest-calc-add-asset-btn').click();
      })()`,
      returnByValue: true,
    });
    await sleep(300);
    const dupCheck = await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.invest-calc-edit .invest-calc-targets-list .invest-calc-target-row[data-asset="${NEW_ASSET}"]').length`,
      returnByValue: true,
    });
    if (dupCheck.result?.result?.value === 1) pass('重复添加被拒（行数仍为 1）');
    else fail('重复添加应被拒', JSON.stringify(dupCheck.result?.result?.value));

    // 6) 保存（新标的权重 0，原 4 标的之和仍 = 100）→ 持久化到 targets + holdings
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.invest-calc-edit .invest-calc-config-save')?.click()`,
      returnByValue: true,
    });
    await sleep(1500);
    const afterAdd = await fetch(BASE + '/api/invest-calc').then((r) => r.json());
    if (afterAdd.ok && afterAdd.data.targets[NEW_ASSET] === 0) {
      pass('保存后：新标的出现在 targets（权重 0）');
    } else {
      fail('保存后 targets 应含新标的', JSON.stringify(afterAdd.data && afterAdd.data.targets));
    }

    // 7) 重新进编辑 → 删除新标的 → 两列表行消失
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.card[data-id="sys-invest-calc"] .invest-calc-settings-btn')?.click()`,
      returnByValue: true,
    });
    await sleep(600);
    const rmCount = await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.invest-calc-edit .invest-calc-remove-btn[data-asset="${NEW_ASSET}"]').length`,
      returnByValue: true,
    });
    if (rmCount.result?.result?.value !== 2) {
      fail('删除前应存在目标+持仓两个删除按钮', JSON.stringify(rmCount.result?.result?.value));
    }
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.invest-calc-edit .invest-calc-remove-btn[data-asset="${NEW_ASSET}"]')?.click()`,
      returnByValue: true,
    });
    await sleep(300);
    const removedRows = await send('Runtime.evaluate', {
      expression: `(function(){
        const edit = document.querySelector('.invest-calc-edit');
        return {
          t: !!edit.querySelector('.invest-calc-targets-list [data-asset="${NEW_ASSET}"]'),
          h: !!edit.querySelector('.invest-calc-holdings-list [data-asset="${NEW_ASSET}"]'),
          sum: edit.querySelector('#invest-calc-target-sum')?.textContent || null,
        };
      })()`,
      returnByValue: true,
    });
    const rr = removedRows.result?.result?.value;
    if (rr && !rr.t && !rr.h) pass('删除标的：目标+持仓两列表行都已消失');
    else fail('删除标的后行仍存在', JSON.stringify(rr));

    // 8) 保存删除 → GET 不再有该标的 + holdings 残留被修剪
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.invest-calc-edit .invest-calc-config-save')?.click()`,
      returnByValue: true,
    });
    await sleep(1500);
    const afterRemove = await fetch(BASE + '/api/invest-calc').then((r) => r.json());
    const stillInTargets = afterRemove.ok && NEW_ASSET in afterRemove.data.targets;
    const stillInRows = afterRemove.ok && afterRemove.data.rows.some((r) => r.name === NEW_ASSET);
    if (afterRemove.ok && !stillInTargets && !stillInRows) {
      pass('保存删除后：GET 不再返回该标的（targets 移除）');
    } else {
      fail('删除后 targets 应移除该标的', JSON.stringify({ stillInTargets, stillInRows }));
    }
    // holdings 文件层面验证残留被修剪（直接读文件更可靠；读不到则降级为 API 层面验证）
    try {
      const holdingsRaw = fs.readFileSync(path.join(WORKBENCH_ROOT, 'invest-holdings.json'), 'utf8');
      const holdingsParsed = JSON.parse(holdingsRaw);
      if (!(NEW_ASSET in (holdingsParsed.holdings || {}))) {
        pass('删除保存后：holdings 文件已修剪该标的残留');
      } else {
        fail('holdings 文件应修剪残留标的', JSON.stringify(Object.keys(holdingsParsed.holdings || {})));
      }
    } catch (fileErr) {
      fail('读取 holdings 文件失败（无法验证修剪）: ' + fileErr.message);
    }

    // 9) 页面无 JS 异常
    if (pageErrors.length) {
      fail('页面 JS 异常', pageErrors.join(' | '));
    } else {
      pass('页面无 JS 异常');
    }
  } finally {
    if (ws) ws.close();
    try { edge.kill(); } catch {}
    // 清理：恢复测试前配置 + 持仓（避免覆盖用户数据）
    try {
      await fetch(BASE + '/api/invest-calc/holdings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: beforeHoldings }),
      });
      await fetch(BASE + '/api/invest-calc/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(beforeConfig),
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
