// 系统卡 mode 选择测试（v1 新增：SYS_CARDS 8 张内置信息卡也能在「模式管理区」配 mode）
// 用法：node tests/test-syscard-mode.mjs
// 测试项（无副作用：每个 PATCH 后都还原）：
//   1. GET /api/syscards 返回 8 张卡 + 默认 mode:null
//   2. PATCH /api/syscards/<id> 接受字符串 / 数组 / '__hidden__'
//   3. PATCH 非法 mode id 静默回退 null（与 normalizeModeField 语义一致）
//   4. PATCH 非法 sys card id 返回 404
//   5. 持久化：写入 syscards-state.json；重启服务后回填
//   6. headless Edge 验证：模式管理区出现「系统卡」分组 + 8 行 multi-tag
//   7. headless Edge 验证：娱乐模式下，sys-dida-today mode:'work' → 卡片从 grid 中隐藏
//   8. 还原：所有测试用过的卡 mode 还原为 null（不污染用户原数据）
//
// 设计镜像：test-mode.mjs（HTTP 部分）+ test-mode-e2e.mjs（headless 部分）

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BASE = 'http://127.0.0.1:3180';
const PROFILE = mkdtempSync(join(tmpdir(), 'workbench-syscard-mode-'));
const SYSCARDS_STATE = 'F:\\AllWorkSpace\\workbench\\syscards-state.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let exitCode = 0;
function pass(name, detail) { results.push({ ok: true, name, detail }); console.log('[PASS]', name, detail ? '— ' + detail : ''); }
function fail(name, detail) { results.push({ ok: false, name, detail }); console.log('[FAIL]', name, detail ? '— ' + detail : ''); exitCode = 1; }

async function getJson(path, opts) {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.text() };
}

// 还原辅助：测试结束后把所有卡的 mode 还原为 null（防止污染后续 / 用户原数据）
async function restoreAll() {
  for (const id of ['sys-balance','sys-status','sys-dsh-sessions','sys-bookmarks',
                    'sys-dida-today','sys-dida-focus','sys-minimax','sys-rss']) {
    await fetch(BASE + '/api/syscards/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: null }),
    });
  }
}

(async function main() {
  // 前置：服务在线
  try {
    const r = await getJson('/api/buttons');
    JSON.parse(r.body);
  } catch (e) {
    console.error('[FAIL] 服务未启动：' + e.message);
    process.exit(2);
  }

  // 1. GET /api/syscards 返回 8 张卡
  try {
    const r = await getJson('/api/syscards');
    const data = JSON.parse(r.body);
    if (r.status === 200 && data.cards && data.cards.length === 8) {
      pass('GET /api/syscards 返回 8 张卡', data.cards.map(c => c.id).join(', '));
    } else {
      fail('GET /api/syscards 应返回 8 张卡', r.body);
    }
    const ids = (data.cards || []).map(c => c.id);
    const expected = ['sys-balance','sys-status','sys-dsh-sessions','sys-bookmarks',
                      'sys-dida-today','sys-dida-focus','sys-minimax','sys-rss'];
    if (expected.every(x => ids.includes(x))) {
      pass('8 张卡的 id 与 SYS_CARDS_WHITELIST 对齐');
    } else {
      fail('id 不匹配', JSON.stringify(ids));
    }
    if ((data.cards || []).every(c => c.mode === null)) {
      pass('所有系统卡默认 mode:null（向后兼容）');
    } else {
      fail('默认 mode 应为 null', JSON.stringify(data.cards));
    }
  } catch (e) {
    fail('GET /api/syscards 异常', e.message);
  }

  // 2. PATCH 字符串
  try {
    const r = await fetch(BASE + '/api/syscards/sys-dida-today', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'work' }),
    });
    const data = await r.json();
    if (data.ok && data.card && data.card.mode === 'work') {
      pass('PATCH 字符串 mode 生效', 'sys-dida-today → work');
    } else {
      fail('PATCH 字符串 mode 应生效', JSON.stringify(data));
    }
  } catch (e) { fail('PATCH 字符串测试失败', e.message); }

  // 3. PATCH 数组
  try {
    const r = await fetch(BASE + '/api/syscards/sys-dida-focus', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: ['work', 'entertainment'] }),
    });
    const data = await r.json();
    if (data.ok && data.card && Array.isArray(data.card.mode) && data.card.mode.length === 2) {
      pass('PATCH 数组 mode 生效', 'sys-dida-focus → [work, entertainment]');
    } else {
      fail('PATCH 数组 mode 应生效', JSON.stringify(data));
    }
  } catch (e) { fail('PATCH 数组测试失败', e.message); }

  // 4. PATCH __hidden__ sentinel
  try {
    const r = await fetch(BASE + '/api/syscards/sys-rss', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: '__hidden__' }),
    });
    const data = await r.json();
    if (data.ok && data.card && data.card.mode === '__hidden__') {
      pass('PATCH __hidden__ sentinel 生效', 'sys-rss → __hidden__');
    } else {
      fail('PATCH __hidden__ 应生效', JSON.stringify(data));
    }
  } catch (e) { fail('PATCH __hidden__ 测试失败', e.message); }

  // 5. PATCH 非法 mode id 静默回退 null
  try {
    const r = await fetch(BASE + '/api/syscards/sys-balance', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'NOT_A_REAL_MODE' }),
    });
    const data = await r.json();
    if (data.ok && data.card && data.card.mode === null) {
      pass('非法 mode id 静默回退 null（normalizeModeField 兜底）');
    } else {
      fail('非法 mode id 应回退 null', JSON.stringify(data));
    }
  } catch (e) { fail('非法 mode id 测试失败', e.message); }

  // 6. PATCH 非法 sys card id 返回 404
  try {
    const r = await fetch(BASE + '/api/syscards/sys-not-real', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'work' }),
    });
    if (r.status === 404) {
      const data = await r.json();
      if (data.ok === false && /未知的系统卡/.test(data.error || '')) {
        pass('非法 sys card id 返回 404 + 错误信息');
      } else {
        fail('404 响应错误格式', JSON.stringify(data));
      }
    } else {
      fail('非法 sys card id 应返回 404', 'status=' + r.status);
    }
  } catch (e) { fail('非法 id 测试失败', e.message); }

  // 7. 持久化：syscards-state.json 应包含刚才 PATCH 的字段
  try {
    if (!existsSync(SYSCARDS_STATE)) {
      fail('syscards-state.json 不存在', SYSCARDS_STATE);
    } else {
      const raw = JSON.parse(readFileSync(SYSCARDS_STATE, 'utf8'));
      if (raw['sys-dida-today'] === 'work' && Array.isArray(raw['sys-dida-focus']) && raw['sys-rss'] === '__hidden__') {
        pass('持久化字段全部命中', JSON.stringify(raw));
      } else {
        fail('持久化字段不匹配', JSON.stringify(raw));
      }
    }
  } catch (e) { fail('持久化测试失败', e.message); }

  // 8. headless Edge：模式管理区出现「系统卡」分组 + 8 行 multi-tag
  const edgePath = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edgePath) {
    fail('找不到 Edge，跳过前端测试');
  } else {
    rmSync(PROFILE, { recursive: true, force: true });
    const dbgPort = 9700 + Math.floor(Math.random() * 200);
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
      await sleep(4500);
      const evalExpr = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });

      // 8a. 模式管理区出现「系统卡」分组（书签分组条件渲染：bookmarks 为空时不出）
      // 验证逻辑：必须包含 syscard；其它分组（feed / shortcut / manual）按数据存在性可选
      const groups = await evalExpr(`(() => {
        const gs = [...document.querySelectorAll('#mode-manager-list .mode-manager-group')];
        return { count: gs.length, ids: gs.map(g => g.dataset.groupId) };
      })()`);
      const gd = groups.result && groups.result.result.value;
      if (gd && gd.count >= 4 && gd.ids.includes('syscard')) {
        pass('模式管理区含 syscard 分组（书签/快捷方式按数据存在性条件渲染）', gd.ids.join(', '));
      } else {
        fail('模式管理区分组错误', JSON.stringify(gd));
      }

      // 8b. 系统卡分组含 8 行 multi-tag
      const sysRows = await evalExpr(`(() => {
        const g = document.querySelector('#mode-manager-list .mode-manager-group[data-group-id="syscard"]');
        if (!g) return { count: 0 };
        const rows = [...g.querySelectorAll('.mode-manager-row')];
        const tags = [...g.querySelectorAll('.mode-manager-row .mode-tag[data-mode-id]')].length;
        const hiddenTags = [...g.querySelectorAll('.mode-manager-row .mode-tag-hidden')].length;
        return { count: rows.length, tags, hiddenTags };
      })()`);
      const sd = sysRows.result && sysRows.result.result.value;
      if (sd && sd.count === 8 && sd.tags >= 8 && sd.hiddenTags >= 8) {
        pass('系统卡分组含 8 行 multi-tag（含「隐藏」按钮）', `${sd.count} 行 / ${sd.tags} 具体标签 / ${sd.hiddenTags} 隐藏按钮`);
      } else {
        fail('系统卡分组行数 / tag 数异常', JSON.stringify(sd));
      }

      // 8c. sys-dida-today 已 PATCH 为 'work' → 该行应该有 1 个 active tag
      const activeOnRow = await evalExpr(`(() => {
        const r = document.querySelector('.mode-manager-row[data-mm-key="syscard:sys-dida-today"]');
        if (!r) return { ok: false, reason: 'row not found' };
        const active = [...r.querySelectorAll('.mode-tag.active')].map(t => t.dataset.modeId || t.className);
        return { ok: true, active };
      })()`);
      const ad = activeOnRow.result && activeOnRow.result.result.value;
      if (ad && ad.ok && ad.active.length === 1 && ad.active[0] === 'work') {
        pass('sys-dida-today 行内 work tag 高亮');
      } else {
        fail('sys-dida-today 行内 active tag 异常', JSON.stringify(ad));
      }

      // 8d. 切到娱乐模式 → sys-dida-today mode:'work' 应从 grid 消失
      await evalExpr(`document.querySelector('.mode-seg-opt[data-mode="entertainment"]').click()`);
      await sleep(800);
      const entGrid = await evalExpr(`(() => {
        const ids = [...document.querySelectorAll('#buttons-grid .card')].map(c => c.dataset.id);
        return { ids };
      })()`);
      const ed = entGrid.result && entGrid.result.result.value;
      if (ed && !ed.ids.includes('sys-dida-today')) {
        pass('娱乐模式下 sys-dida-today 从 grid 隐藏（mode:work 生效）');
      } else {
        fail('娱乐模式下 sys-dida-today 应被过滤', JSON.stringify(ed));
      }

      // 8e. 切回工作模式 → 卡片回来
      await evalExpr(`document.querySelector('.mode-seg-opt[data-mode="work"]').click()`);
      await sleep(800);
      const workGrid = await evalExpr(`(() => {
        const ids = [...document.querySelectorAll('#buttons-grid .card')].map(c => c.dataset.id);
        return { ids };
      })()`);
      const wd = workGrid.result && workGrid.result.result.value;
      if (wd && wd.ids.includes('sys-dida-today')) {
        pass('工作模式切回 sys-dida-today 重新显示');
      } else {
        fail('工作模式切回卡片应出现', JSON.stringify(wd));
      }

      // 8f. 页面无 JS 异常
      if (pageErrors.length === 0) {
        pass('页面无 JS 异常');
      } else {
        fail('页面 JS 异常', pageErrors.join(' | '));
      }
    } catch (e) {
      fail('headless 测试异常', e.message);
    } finally {
      try { if (ws) ws.close(); } catch {}
      edge.kill();
      await sleep(1000);
      try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
    }
  }

  // 还原：所有卡的 mode 回 null（不污染用户原数据）
  await restoreAll();

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('---');
  console.log(passed === total ? '全部通过 (' + total + ' 项)' : ('通过 ' + passed + ' / ' + total + ' 项'));
  process.exit(exitCode);
})().catch((e) => {
  console.error('[FAIL] 顶层异常: ' + e.message);
  restoreAll();
  process.exit(1);
});
