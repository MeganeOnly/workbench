// 一次性诊断脚本：检查 sys-dida-today 卡片渲染状态
// 用法：node tests/test-dida-today.mjs
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
const PROFILE = path.join(os.tmpdir(), 'workbench-dida-test-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) 服务可用性
  try {
    const r = await fetch(BASE + '/api/buttons');
    if (!r.ok) throw new Error('status ' + r.status);
  } catch (e) {
    console.error('[FAIL] 工作台服务不可达：' + e.message);
    process.exit(2);
  }

  // 2) 启动 Edge headless
  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edgePath) {
    console.error('[FAIL] 找不到 Edge/Chrome');
    process.exit(2);
  }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const dbgPort = 9400 + Math.floor(Math.random() * 300);
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
        pageErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 500));
      }
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        pageErrors.push('[console.error] ' + m.params.args.map((a) => a.value || a.description).join(' '));
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

    // 3) 打开工作台，等 5 秒让 init 跑完
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(5000);

    // 4) 拦截 fetch 记录所有 /api/* 请求
    await send('Runtime.evaluate', {
      expression: `(() => {
        window.__apiCalls = [];
        const origFetch = window.fetch.bind(window);
        window.fetch = function (url, options) {
          const u = String(url);
          if (u.includes('/api/')) {
            window.__apiCalls.push({ url: u, method: (options && options.method) || 'GET' });
          }
          return origFetch(url, options);
        };
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(100);

    // 5) 触发一次手动刷新 + 等响应
    await send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const r = await fetch('/api/dida-today');
          window.__manualResp = { ok: r.ok, status: r.status, body: await r.text() };
        } catch (e) {
          window.__manualResp = { error: e.message };
        }
      })()`,
      returnByValue: true,
    });
    await sleep(3000);

    // 6) 收集状态
    const cardRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const card = document.querySelector('.card[data-id="sys-dida-today"]');
        if (!card) return { exists: false };
        const list = card.querySelector('.dida-task-list');
        return {
          exists: true,
          htmlLen: list ? list.innerHTML.length : -1,
          sample: list ? list.innerHTML.slice(0, 500) : null,
          items: card.querySelectorAll('.dida-task-item').length,
          empty: card.querySelector('.bm-card-empty') ? card.querySelector('.bm-card-empty').textContent : null,
        };
      })()`,
      returnByValue: true,
    });
    const cardState = (cardRes.result && cardRes.result.result.value) || {};

    const callsRes = await send('Runtime.evaluate', { expression: 'window.__apiCalls.slice()', returnByValue: true });
    const apiCalls = (callsRes.result && callsRes.result.result.value) || [];

    const manualRes = await send('Runtime.evaluate', { expression: 'window.__manualResp', returnByValue: true });
    const manual = (manualRes.result && manualRes.result.result.value) || null;

    // 7) 输出诊断
    console.log('=== sys-dida-today 卡片状态 ===');
    console.log('卡片存在:        ', cardState.exists);
    console.log('任务项数:        ', cardState.items);
    console.log('占位文本:        ', cardState.empty);
    console.log('HTML 长度:       ', cardState.htmlLen);
    console.log('HTML 前 500:    ', cardState.sample);
    console.log('');
    console.log('=== /api/* 调用记录 ===');
    const didaCalls = apiCalls.filter((c) => c.url.includes('dida'));
    console.log('总调用数:        ', apiCalls.length);
    console.log('dida 相关调用:   ', JSON.stringify(didaCalls, null, 2));
    console.log('');
    console.log('=== 手动 fetch /api/dida-today 结果 ===');
    if (manual && manual.error) {
      console.log('错误:           ', manual.error);
    } else if (manual) {
      console.log('status:         ', manual.status);
      console.log('body 前 300:    ', manual.body ? manual.body.slice(0, 300) : '(empty)');
    } else {
      console.log('(未触发)');
    }
    console.log('');
    console.log('=== 页面错误 ===');
    if (pageErrors.length === 0) console.log('(无)');
    else pageErrors.forEach((e, i) => console.log(`#${i + 1}: ${e}`));
  } finally {
    try { if (ws) ws.close(); } catch {}
    edge.kill();
    await sleep(1200);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error('[FAIL] 脚本异常: ' + e.message); process.exit(1); });