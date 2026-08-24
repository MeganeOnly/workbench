// 拖拽顺序回归测试：验证卡片拖拽后顺序变化（splice 索引 bug 回归防线）
// 历史：app.js 卡片 mouseup 用 `splice(i,1)` 后直接用原 j 插入 → 索引失效，
// 拖拽后位置算错、"看起来回原位"。修复后用 `indexOf(targetId)` 重算插入位置。
// 用例：取首张功能卡 A，模拟拖拽到目标卡 B 上方释放，期望 localStorage order 中 A
// 出现在 B 之前；并验证 .drop-before/.drop-after 视觉指示在 mousemove 时正确出现。
//
// 用法：node tests/test-card-drag.mjs
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
const PROFILE = path.join(os.tmpdir(), 'workbench-card-drag-test-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 0) 前置：服务在线 + 至少 2 张可见功能卡
  let cfg;
  try {
    const r = await fetch(BASE + '/api/buttons');
    cfg = await r.json();
  } catch (e) {
    console.error('[FAIL] 无法连接工作台服务 ' + BASE);
    process.exit(2);
  }
  const funcCards = (cfg.buttons || []).filter((b) => b.id && !String(b.id).startsWith('sys-') && b.visible !== false);
  if (funcCards.length < 2) {
    console.error('[FAIL] 至少需要 2 张可见功能卡才能测试拖拽顺序');
    process.exit(2);
  }
  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edgePath) {
    console.error('[FAIL] 找不到 Edge/Chrome');
    process.exit(2);
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
  let failed = 0;
  const results = [];
  const log = (r) => {
    if (r.ok) console.log('[PASS] ' + r.id);
    else { console.log('[FAIL] ' + r.id + ' — ' + r.why); failed++; }
  };

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
      else if (m.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.parse(JSON.stringify(m.params.exceptionDetails)).toString().slice(0, 300));
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

    // 切到娱乐模式（默认 work 是 readonly，drag-hint 不渲染）。
    // 仅设 localStorage 不够——必须点 .mode-seg-opt 触发 setMode()，否则 WB.currentMode 仍是 'work'
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('workbench-mode', 'entertainment'); 'ok'`,
      returnByValue: true,
    });
    await send('Page.reload');
    await sleep(4000);
    await send('Runtime.evaluate', {
      expression: `(() => {
        const opt = document.querySelector('.mode-seg-opt[data-mode="entertainment"]');
        if (opt) opt.click();
        return !!opt;
      })()`,
      returnByValue: true,
    });
    await sleep(1500);

    // 取页面上前两张可见 .card 的 id + 位置
    const probe = await send('Runtime.evaluate', {
      expression: `(() => {
        const cards = [...document.querySelectorAll('.card')];
        const out = cards.slice(0, 4).map((c) => ({
          id: c.dataset.id,
          rect: { x: c.getBoundingClientRect().x, y: c.getBoundingClientRect().y, w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height },
        }));
        return out;
      })()`,
      returnByValue: true,
    });
    const cards = probe.result && probe.result.result.value;
    if (!cards || cards.length < 2) {
      console.error('[FAIL] 页面上可见卡片不足 2 张；cards=' + JSON.stringify(cards));
      process.exit(2);
    }
    const A = cards[0]; // 被拖
    const B = cards[1]; // 目标
    results.push({ id: '前置：可见卡片', ok: true, why: 'A=' + A.id + ' B=' + B.id + ' 共 ' + cards.length + ' 张' });

    // ---- 用例 1：拖 A 到 B 的上半部 → 期望 A 出现在 B 之前 ----
    // 模拟 mousedown（拖拽手柄）→ mousemove（位移 >6px 触发 active，并落到 B 上半部）→ mouseup
    const bRect = B.rect;
    // B 上半部中心：x = bRect.x + bRect.w/2, y = bRect.y + bRect.h * 0.25
    const dropX = bRect.x + bRect.w / 2;
    const dropY = bRect.y + bRect.h * 0.25;
    const aRect = A.rect;
    const aHint = await send('Runtime.evaluate', {
      expression: `(() => {
        const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(A.id)});
        const hint = card && card.querySelector('.drag-hint');
        if (!hint) return null;
        const r = hint.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      returnByValue: true,
    });
    const hintXY = aHint.result.result.value;
    if (!hintXY) { results.push({ id: 'A 卡片手柄', ok: false, why: '未渲染 drag-hint' }); }
    else {
      // 派发拖拽序列
      await send('Runtime.evaluate', {
        expression: `(() => {
          const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(A.id)});
          const hint = card.querySelector('.drag-hint');
          // mousedown 派发到 hint（e.target = hint，handler 才能 .closest('.drag-hint') 命中）；
          // 后续 mousemove/mouseup 派发到 document（handler 也监听 document）
          hint.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ${hintXY.x}, clientY: ${hintXY.y}, button: 0 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: ${dropX}, clientY: ${dropY}, button: 0 }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ${dropX}, clientY: ${dropY}, button: 0 }));
          return true;
        })()`,
        returnByValue: true,
      });
      await sleep(400);
      const orderAfter = await send('Runtime.evaluate', {
        expression: 'JSON.parse(localStorage.getItem("workbench-card-order") || "null")',
        returnByValue: true,
      });
      const order1 = orderAfter.result.result.value || [];
      const iA = order1.indexOf(A.id);
      const iB = order1.indexOf(B.id);
      const okPos = iA >= 0 && iB >= 0 && iA < iB;
      results.push({
        id: '拖 A 到 B 上半部（A 应在 B 之前）',
        ok: okPos,
        why: okPos ? `iA=${iA} iB=${iB}` : `iA=${iA} iB=${iB}；order=${JSON.stringify(order1)}`,
      });
    }

    // ---- 用例 2：拖 B 到 A 的下半部 → 期望 B 出现在 A 之后 ----
    // 现在 A 已在 B 之前。拖 B 到 A 下半部释放 → B 应被推到 A 之后
    const bHintR = await send('Runtime.evaluate', {
      expression: `(() => {
        const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(B.id)});
        const hint = card && card.querySelector('.drag-hint');
        if (!hint) return null;
        const r = hint.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      returnByValue: true,
    });
    const bHintXY = bHintR.result.result.value;
    // A 当前位置（renderGrid 已重排，需要重读）
    const aRect2 = await send('Runtime.evaluate', {
      expression: `(() => {
        const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(A.id)});
        if (!card) return null;
        const r = card.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`,
      returnByValue: true,
    });
    const A2 = aRect2.result.result.value;
    if (!bHintXY || !A2) {
      results.push({ id: '用例 2 前置', ok: false, why: 'B 手柄或 A 卡片不可读' });
    } else {
      const dropY2 = A2.y + A2.h * 0.75;
      const dropX2 = A2.x + A2.w / 2;
      await send('Runtime.evaluate', {
        expression: `(() => {
          const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(B.id)});
          const hint = card.querySelector('.drag-hint');
          hint.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ${bHintXY.x}, clientY: ${bHintXY.y}, button: 0 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: ${dropX2}, clientY: ${dropY2}, button: 0 }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ${dropX2}, clientY: ${dropY2}, button: 0 }));
          return true;
        })()`,
        returnByValue: true,
      });
      await sleep(400);
      const orderAfter2 = await send('Runtime.evaluate', {
        expression: 'JSON.parse(localStorage.getItem("workbench-card-order") || "null")',
        returnByValue: true,
      });
      const order2 = orderAfter2.result.result.value || [];
      const iA2 = order2.indexOf(A.id);
      const iB2 = order2.indexOf(B.id);
      const okPos2 = iA2 >= 0 && iB2 >= 0 && iA2 < iB2;
      results.push({
        id: '拖 B 到 A 下半部（A 仍应在 B 之前）',
        ok: okPos2,
        why: okPos2 ? `iA=${iA2} iB=${iB2}` : `iA=${iA2} iB=${iB2}；order=${JSON.stringify(order2)}`,
      });
    }

    // ---- 用例 3：mousemove 落点在上半部时 .drop-before 应出现在目标卡上 ----
    // 用 cards 重新读位置（顺序已在前两次用例中改变）
    const probe2 = await send('Runtime.evaluate', {
      expression: `(() => {
        const cs = [...document.querySelectorAll('.card')];
        return cs.slice(0, 4).map((c) => ({
          id: c.dataset.id,
          x: c.getBoundingClientRect().x,
          y: c.getBoundingClientRect().y,
          w: c.getBoundingClientRect().width,
          h: c.getBoundingClientRect().height,
        }));
      })()`,
      returnByValue: true,
    });
    const cards2 = probe2.result.result.value || [];
    if (cards2.length < 2) {
      results.push({ id: 'mousemove 指示线', ok: false, why: '无可用卡片' });
    } else {
      // 把 cards2[0] 拖到 cards2[1] 的上半部
      const dragId = cards2[0].id;
      const tgt = cards2[1];
      const hintR = await send('Runtime.evaluate', {
        expression: `(() => {
          const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(dragId)});
          const hint = card && card.querySelector('.drag-hint');
          if (!hint) return null;
          const r = hint.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
        returnByValue: true,
      });
      const hintXY = hintR.result.result.value;
      if (!hintXY) {
        results.push({ id: 'mousemove 指示线', ok: false, why: 'drag-hint 未渲染（可能 readonly 模式）' });
      } else {
        const dropX = tgt.x + tgt.w / 2;
        const dropY = tgt.y + tgt.h * 0.25;
        await send('Runtime.evaluate', {
          expression: `(() => {
            const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(dragId)});
            const hint = card.querySelector('.drag-hint');
            hint.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ${hintXY.x}, clientY: ${hintXY.y}, button: 0 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: ${dropX}, clientY: ${dropY}, button: 0 }));
            return true;
          })()`,
          returnByValue: true,
        });
        await sleep(150);
        const cls = await send('Runtime.evaluate', {
          expression: `(() => {
            const c = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(tgt.id)});
            return c ? c.className : '';
          })()`,
          returnByValue: true,
        });
        const className = cls.result.result.value || '';
        const okDrop = className.indexOf('drop-before') >= 0 || className.indexOf('drop-after') >= 0;
        results.push({
          id: 'mousemove 落点出现 drop 指示线',
          ok: okDrop,
          why: okDrop ? 'className 含 drop-before/after' : 'className=' + className,
        });
        // 清理
        await send('Runtime.evaluate', {
          expression: `document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ${dropX}, clientY: ${dropY}, button: 0 }));`,
          returnByValue: true,
        });
        await sleep(200);
      }
    }

    if (pageErrors.length) console.log('[WARN] 页面异常 ' + pageErrors.length + ' 条: ' + JSON.stringify(pageErrors).slice(0, 400));
    for (const r of results) log(r);
    console.log(failed === 0 ? '全部通过 (' + results.length + ' 项)' : '失败 ' + failed + ' 项');
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