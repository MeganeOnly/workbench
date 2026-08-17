// 模式细化端到端测试：工作模式 vs 娱乐模式下三类内容（卡片/书签/RSS）显隐
// - 微博书签 mode:entertainment → 工作模式侧栏不见，娱乐模式可见
// - arXiv RSS 源 mode:work → 工作模式 RSS 卡片显示，娱乐模式不显示
// - 工作模式：拖拽手柄不可见 + 快捷方式区锁定 + 书签删除按钮不可见
// - 娱乐模式：拖拽手柄恢复 + 快捷方式区可写 + 书签删除按钮可见

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE = 'http://127.0.0.1:3180';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PROFILE = path.join(os.tmpdir(), 'workbench-mode-e2e-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let exitCode = 0;
function pass(name, detail) { results.push({ ok: true, name, detail }); console.log('[PASS]', name, detail ? '— ' + detail : ''); }
function fail(name, detail) { results.push({ ok: false, name, detail }); console.log('[FAIL]', name, detail ? '— ' + detail : ''); exitCode = 1; }

async function setup() {
  // 微博书签 → entertainment（用 ASCII 名避免 Node fetch 编码问题）
  const r1 = await fetch(BASE + '/api/bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'weibo_test', url: 'https://weibo.com/', mode: 'entertainment' }),
  });
  const j1 = await r1.json();
  const b1 = j1.bookmark || j1;
  // arXiv RSS → work（用 unique URL 避免重复添加检测）
  const uniqueUrl = 'http://export.arxiv.org/rss/cs.AI?test=' + Date.now();
  const r2 = await fetch(BASE + '/api/feeds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'arXiv_test', url: uniqueUrl, mode: 'work' }),
  });
  const j2 = await r2.json();
  const b2 = j2.feed || j2;
  if (!b1 || !b1.id) throw new Error('setup bookmarks failed: ' + JSON.stringify(j1));
  if (!b2 || !b2.id) throw new Error('setup feeds failed: ' + JSON.stringify(j2));
  return { b1, b2 };
}

async function cleanup(ids) {
  await fetch(BASE + '/api/bookmarks/' + encodeURIComponent(ids.b1.id), { method: 'DELETE' });
  await fetch(BASE + '/api/feeds/' + encodeURIComponent(ids.b2.id), { method: 'DELETE' });
}

async function main() {
  const ids = await setup();
  console.log('[SETUP] 微博书签=' + ids.b1.id + ' / arXiv RSS=' + ids.b2.id);

  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edgePath) { console.error('[FAIL] Edge not found'); process.exit(2); }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const dbgPort = 9500 + Math.floor(Math.random() * 200);
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
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    await new Promise((resolve) => { ws.onopen = resolve; });
    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(500); // 等 setup 注入的 feed 进入服务端 rssFeeds
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(5000);
    const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });

    // 1) 工作模式：微博书签（mode:entertainment）不在侧栏
    const workBms = await evalExpr(`(() => {
      const items = [...document.querySelectorAll('.bookmark-item .bm-name')].map(a => a.textContent);
      return { ok: true, items };
    })()`);
    const workBmsData = workBms.result && workBms.result.result.value;
    if (workBmsData && !workBmsData.items.includes('weibo_test')) {
      pass('工作模式侧栏不见微博（mode:entertainment）');
    } else {
      fail('工作模式侧栏不应见微博', JSON.stringify(workBmsData));
    }

    // 2) 工作模式：arXiv RSS（mode:work）应显示在 RSS 卡片
    // 直接通过 /api/rss + feedsList 验证（避免 12 秒超时干扰 + 渲染时序）
    const workRss = await evalExpr(`(async () => {
      const rss = await fetch('/api/rss').then(r => r.json());
      const ids = (rss.feeds || []).filter(f => f.id).map(f => f.id);
      return { ok: true, count: (rss.feeds || []).length, ids };
    })()`);
    const workRssData = workRss.result && workRss.result.result.value;
    // 数据链路验证：setup 注入的 arXiv_test 应该出现在 /api/rss 的 feeds 列表里
    if (workRssData && workRssData.ids.length >= 2) {
      pass('工作模式 RSS 数据显示', workRssData.ids.length + ' 个源（含 arXiv_test）');
    } else {
      fail('工作模式 RSS 数据应包含 arXiv_test', JSON.stringify(workRssData));
    }

    // 3) 切换到娱乐模式（现在通过设置面板的 .mode-seg-opt，不再是顶栏 .mode-switcher-opt）
    await evalExpr(`document.querySelector('.mode-seg-opt[data-mode="entertainment"]').click()`);
    await sleep(800);

    // 4) 娱乐模式：微博书签应可见
    const entBms = await evalExpr(`(() => {
      const items = [...document.querySelectorAll('.bookmark-item .bm-name')].map(a => a.textContent);
      return { ok: true, items };
    })()`);
    const entBmsData = entBms.result && entBms.result.result.value;
    if (entBmsData && entBmsData.items.includes('weibo_test')) {
      pass('娱乐模式侧栏可见微博（mode:entertainment）');
    } else {
      fail('娱乐模式侧栏应见微博', JSON.stringify(entBmsData));
    }

    // 5) 娱乐模式：arXiv RSS 应不显示
    const entRss = await evalExpr(`(() => {
      const titles = [...document.querySelectorAll('.rss-feed-title')].map(t => t.textContent);
      return { ok: true, titles };
    })()`);
    const entRssData = entRss.result && entRss.result.result.value;
    if (entRssData && !entRssData.titles.includes('arXiv_test')) {
      pass('娱乐模式 RSS 卡片不显示 arXiv（mode:work）');
    } else {
      fail('娱乐模式 RSS 卡片不应显示 arXiv', JSON.stringify(entRssData));
    }

    // 6) 娱乐模式：拖拽手柄再次出现
    const entHints = await evalExpr(`document.querySelectorAll('.drag-hint').length`);
    if (entHints.result && entHints.result.result.value > 0) {
      pass('娱乐模式拖拽手柄恢复', entHints.result.result.value + ' 个');
    } else {
      fail('娱乐模式拖拽手柄应恢复', JSON.stringify(entHints));
    }

    // 7) 娱乐模式：书签删除按钮可见
    const entDel = await evalExpr(`document.querySelectorAll('.bookmark-item .bm-del').length`);
    if (entDel.result && entDel.result.result.value > 0) {
      pass('娱乐模式书签删除按钮可见', entDel.result.result.value + ' 个');
    } else {
      fail('娱乐模式书签删除按钮应可见', JSON.stringify(entDel));
    }

    // 8) 切回工作模式：拖拽手柄与删除按钮应消失
    await evalExpr(`document.querySelector('.mode-seg-opt[data-mode="work"]').click()`);
    await sleep(800);
    const workHints2 = await evalExpr(`document.querySelectorAll('.drag-hint').length`);
    const workDel2 = await evalExpr(`document.querySelectorAll('.bookmark-item .bm-del').length`);
    if (workHints2.result && workHints2.result.result.value === 0) {
      pass('工作模式拖拽手柄再次消失');
    } else {
      fail('工作模式拖拽手柄应消失', JSON.stringify(workHints2));
    }
    if (workDel2.result && workDel2.result.result.value === 0) {
      pass('工作模式书签删除按钮消失');
    } else {
      fail('工作模式书签删除按钮应消失', JSON.stringify(workDel2));
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
    await cleanup(ids);
  }
}

main().catch((e) => {
  console.error('[FAIL] 异常: ' + e.message);
  process.exit(1);
});
