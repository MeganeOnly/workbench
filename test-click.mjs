// 回归测试：验证每个功能卡按钮的点击都能触发正确的 POST 请求（前端接线完整性）
// 用法：node test-click.mjs   （需工作台服务已在 127.0.0.1:3180 运行）
// 原理：用无头 Edge + CDP 加载页面，在页面内把 window.fetch 的 POST 换成"记录 URL +
// 返回假成功响应"，GET 放行真实请求。因此点击按钮不会对 DSH/Anki 产生任何真实副作用，
// 只验证"点击 -> runButton -> fetch(POST /api/...) "这条链路是否通。
// 历史背景：曾因点击监听器读 refs.current、渲染写 rec.current（双属性不一致）导致
// 点击静默失效、零请求零报错。本脚本就是该 bug 的回归防线。
// 退出码：0 全部通过；1 有按钮失败；2 环境错误（服务未启动 / 找不到 Edge）。
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
const PROFILE = path.join(os.tmpdir(), 'workbench-click-test-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 0) 前置检查：服务必须在线
  let cfg;
  try {
    const r = await fetch(BASE + '/api/buttons');
    cfg = await r.json();
  } catch (e) {
    console.error('[FAIL] 无法连接工作台服务 ' + BASE + '（请先启动 start-workbench.bat）');
    process.exit(2);
  }
  const buttons = cfg.buttons || [];
  // visible !== false：dida 卡片可能因"未到点/今天已点过"被服务端标记为隐藏，此时页面上不渲染，无法点击测试
  const funcCards = buttons.filter((b) => b.id && !String(b.id).startsWith('sys-') && b.visible !== false);
  if (funcCards.length === 0) {
    console.error('[FAIL] /api/buttons 没有任何功能按钮，无法测试');
    process.exit(2);
  }
  const expectUrl = (b) =>
    b.kind === 'push' ? '/api/push' :
    b.kind === 'dida' ? '/api/dida/' + encodeURIComponent(b.id) :
    b.toggle ? '/api/toggle/' + encodeURIComponent(b.id) :
    '/api/run/' + encodeURIComponent(b.id);

  // 1) 启动无头浏览器
  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edgePath) {
    console.error('[FAIL] 找不到 Edge/Chrome，无法运行回归测试');
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
  try {
    // 2) 等 CDP 端点
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

    // 3) 打开工作台页面
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(4000);

    // 4) 页面内注入：POST 全部拦截记录并返回假成功；GET 放行；window.open 变空操作
    const inject = await send('Runtime.evaluate', {
      expression: `(() => {
        window.__posts = [];
        const origFetch = window.fetch.bind(window);
        window.fetch = function (url, options) {
          const method = (options && options.method) || 'GET';
          if (method !== 'GET') {
            window.__posts.push(String(url));
            return Promise.resolve(new Response(
              JSON.stringify({ ok: true, action: 'start', entry: { status: 'done', code: 0 } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            ));
          }
          return origFetch(url, options);
        };
        window.open = function () { return { fake: true }; };
        return true;
      })()`,
      returnByValue: true,
    });
    if (!inject.result || inject.result.result.value !== true) {
      throw new Error('fetch 桩注入失败');
    }

    // 5) 逐卡点击验证
    // 点击机制说明：用页面内 MouseEvent 派发（mousedown/mouseup/click，bubbles）而非
    // CDP Input.dispatchMouseEvent——实测后者在 headless + fetch 桩组合下不可靠
    // （真实点击落点未命中监听器），前者稳定触发同一套监听器链路。
    const results = [];
    for (const b of funcCards) {
      const expected = expectUrl(b);
      // 清空记录，等待上一次 busy 清除
      await send('Runtime.evaluate', { expression: 'window.__posts.length = 0', returnByValue: true });
      await sleep(400);

      const clickRes = await send('Runtime.evaluate', {
        expression: `(() => {
          const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(b.id)});
          if (!card) return { ok: false, why: '卡片未渲染' };
          const btn = card.querySelector('.run-btn');
          if (!btn) return { ok: false, why: '按钮未渲染' };
          const r = btn.getBoundingClientRect();
          const x = r.x + r.width / 2, y = r.y + r.height / 2;
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
          btn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
          btn.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
          return { ok: true };
        })()`,
        returnByValue: true,
      });
      const ck = clickRes.result && clickRes.result.result.value;
      if (!ck || !ck.ok) {
        results.push({ id: b.id, expected, ok: false, why: (ck && ck.why) || '点击派发失败' });
        continue;
      }

      // 等待 fetch 记录出现（最长 2.5s）
      let posts = [];
      for (let i = 0; i < 10; i++) {
        const r = await send('Runtime.evaluate', { expression: 'window.__posts.slice()', returnByValue: true });
        posts = r.result && r.result.result.value ? r.result.result.value : [];
        if (posts.length) break;
        await sleep(250);
      }
      const hit = posts.find((u) => u.includes(expected));
      results.push({ id: b.id, expected, ok: !!hit, why: hit ? '' : '未捕获到 POST ' + expected + '（实际记录: ' + posts.join(', ') + '）' });
    }

    // 6) 验证"点击卡片任意位置（非按钮）"不触发执行（用户要求：只有按到 run-btn 才启动）
    await send('Runtime.evaluate', { expression: 'window.__posts.length = 0', returnByValue: true });
    await sleep(400);
    const first = funcCards[0];
    const expectedBody = expectUrl(first);
    const bodyRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(first.id)});
        if (!card) return { ok: false };
        const h3 = card.querySelector('.card-head h3');
        const r = h3.getBoundingClientRect();
        const x = r.x + 5, y = r.y + r.height / 2;
        h3.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        h3.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        h3.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        return { ok: true };
      })()`,
      returnByValue: true,
    });
    if (bodyRes.result && bodyRes.result.result.value && bodyRes.result.result.value.ok) {
      let posts = [];
      for (let i = 0; i < 10; i++) {
        const r = await send('Runtime.evaluate', { expression: 'window.__posts.slice()', returnByValue: true });
        posts = r.result && r.result.result.value ? r.result.result.value : [];
        if (posts.length) break;
        await sleep(250);
      }
      const hit = posts.find((u) => u.includes(expectedBody));
      results.push({ id: first.id + '（卡片主体点击不执行）', expected: '无 POST', ok: !hit, why: hit ? '主体点击却触发了 POST ' + expectedBody : '' });
    }

    // 6.5) 拖拽/点击判定回归（堵住"拖拽吞点击"盲区）
    // 历史：曾实现"按住卡片任意位置拖动（位移 >6px 换位）"，6px 阈值把正常点击误判为
    // 拖拽、suppressClick 吞掉 click，真实鼠标点击"点了没反应"。已收敛为仅 ⠿ 手柄可拖。
    // 用例：A) 卡片主体（带位移）点击不执行——只有 run-btn 才执行，且位移不触发拖拽误执行
    //       B) ⠿ 手柄拖拽后的 click 不得触发执行（suppressClick 需吞掉拖拽自身的 click）
    //       C) 一次未派发 click 的拖拽后，紧接着干净点击按钮必须执行（suppressClick 不得残留）
    const waitPosts = async () => {
      let posts = [];
      for (let i = 0; i < 10; i++) {
        const r = await send('Runtime.evaluate', { expression: 'window.__posts.slice()', returnByValue: true });
        posts = r.result && r.result.result.value ? r.result.result.value : [];
        if (posts.length) break;
        await sleep(250);
      }
      return posts;
    };
    const dispatchSeq = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true });

    // A) 卡片主体（h3）带位移点击：mousedown → mousemove(+10,+2) → mouseup → click
    //    主体点击不触发执行（只有 run-btn 执行）；位移也不该触发拖拽误执行
    await send('Runtime.evaluate', { expression: 'window.__posts.length = 0', returnByValue: true });
    await sleep(400);
    await dispatchSeq(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(first.id)});
      if (!card) return { ok: false, why: '卡片未渲染' };
      const h3 = card.querySelector('.card-head h3');
      if (!h3) return { ok: false, why: '标题未渲染' };
      const r = h3.getBoundingClientRect();
      const x = r.x + 5, y = r.y + r.height / 2;
      h3.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x + 10, clientY: y + 2, button: 0 }));
      h3.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x + 10, clientY: y + 2, button: 0 }));
      h3.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x + 10, clientY: y + 2, button: 0 }));
      return { ok: true };
    })()`);
    const postsA = await waitPosts();
    results.push({
      id: first.id + '（主体带位移点击不执行）', expected: '无 POST',
      ok: postsA.length === 0,
      why: postsA.length ? '主体点击却触发了 POST: ' + postsA.join(',') : '',
    });

    // B) ⠿ 手柄拖拽（含拖拽后的 click）：不得触发执行
    await send('Runtime.evaluate', { expression: 'window.__posts.length = 0', returnByValue: true });
    await sleep(400);
    await dispatchSeq(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(first.id)});
      if (!card) return { ok: false, why: '卡片未渲染' };
      const hint = card.querySelector('.drag-hint');
      if (!hint) return { ok: false, why: '拖拽手柄未渲染' };
      const r = hint.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      hint.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y + 15, button: 0 }));
      hint.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y + 15, button: 0 }));
      hint.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y + 15, button: 0 }));
      return { ok: true };
    })()`);
    const postsB = await waitPosts();
    results.push({
      id: first.id + '（手柄拖拽）', expected: '无 POST',
      ok: postsB.length === 0,
      why: postsB.length ? '拖拽却触发了 POST: ' + postsB.join(',') : '',
    });

    // C) 一次未派发 click 的拖拽后，立即干净点击按钮：必须执行（suppressClick 不得残留）
    await send('Runtime.evaluate', { expression: 'window.__posts.length = 0', returnByValue: true });
    await sleep(400);
    await dispatchSeq(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(first.id)});
      if (!card) return { ok: false, why: '卡片未渲染' };
      const hint = card.querySelector('.drag-hint');
      if (!hint) return { ok: false, why: '拖拽手柄未渲染' };
      const r = hint.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      hint.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y + 15, button: 0 }));
      hint.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y + 15, button: 0 }));
      // 注意：不派发 click，模拟浏览器未合成 click（重排/移出窗口场景）
      return { ok: true };
    })()`);
    await sleep(300); // 等 setTimeout(0) 兜底清除 suppressClick
    await dispatchSeq(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.dataset.id === ${JSON.stringify(first.id)});
      if (!card) return { ok: false, why: '卡片未渲染' };
      const btn = card.querySelector('.run-btn');
      if (!btn) return { ok: false, why: '按钮未渲染' };
      const r = btn.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      return { ok: true };
    })()`);
    const postsC = await waitPosts();
    results.push({
      id: first.id + '（拖后点击按钮）', expected: expectedBody,
      ok: postsC.some((u) => u.includes(expectedBody)),
      why: postsC.length ? 'POST: ' + postsC.join(',') : '未产生 POST——suppressClick 残留吞掉了点击',
    });

    // 7) 汇总
    let failed = 0;
    for (const r of results) {
      if (r.ok) console.log('[PASS] ' + r.id + ' -> ' + r.expected);
      else { console.log('[FAIL] ' + r.id + ' -> 期望 ' + r.expected + '；' + r.why); failed++; }
    }
    if (pageErrors.length) {
      console.log('[WARN] 页面异常 ' + pageErrors.length + ' 条: ' + pageErrors[0]);
    }
    console.log(failed === 0 ? '全部通过 (' + results.length + ' 项)' : '失败 ' + failed + ' 项');
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    try { if (ws) ws.close(); } catch {}
    edge.kill();
    // 等 Edge 退出后再清理 profile（直接删可能 EBUSY）
    await sleep(1200);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('[FAIL] 测试脚本异常: ' + e.message);
  process.exit(1);
});
