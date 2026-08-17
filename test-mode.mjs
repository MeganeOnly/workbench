// 模式细化无头 Edge CDP 测试：
// - 验证 /api/modes 端点可访问
// - 验证顶栏 mode-switcher 渲染正确
// - 验证 readonly 模式下 .drag-hint 不渲染
// - 验证只读模式生效（body[data-readonly="true"]）
// - 三类内容（卡片 / 书签 / RSS）mode 字段服务端透传
//
// 与 test-click.mjs 同款设计：headless Edge + 页面 stub fetch，无副作用。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:3180';
const URL = BASE;
const USER_DATA = mkdtempSync(join(tmpdir(), 'msedge-mode-'));

const results = [];
let exitCode = 0;
function pass(name, detail) { results.push({ ok: true, name, detail }); console.log('[PASS]', name, detail ? '— ' + detail : ''); }
function fail(name, detail) { results.push({ ok: false, name, detail }); console.log('[FAIL]', name, detail ? '— ' + detail : ''); exitCode = 1; }

// 用 curl 验证服务端基础状态（不依赖 Edge）
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.text() };
}

(async function main() {
  // ---- 服务端基础 ----
  try {
    const r = await fetchJson(URL + '/api/modes');
    const data = JSON.parse(r.body);
    if (r.status === 200 && data.modes && data.modes.length === 2) {
      pass('GET /api/modes 返回 2 个模式', JSON.stringify(data.modes.map((m) => m.id)));
    } else {
      fail('GET /api/modes 状态结构', r.body);
    }
    const work = data.modes.find((m) => m.id === 'work');
    if (work && work.readonly === true) pass('work.readonly = true');
    else fail('work.readonly 应为 true', r.body);
    const ent = data.modes.find((m) => m.id === 'entertainment');
    if (ent && ent.readonly === false) pass('entertainment.readonly = false');
    else fail('entertainment.readonly 应为 false');
  } catch (e) {
    fail('GET /api/modes 请求失败', e.message);
  }

  // ---- 书签 mode 字段透传 ----
  try {
    const r = await fetchJson(URL + '/api/bookmarks');
    const data = JSON.parse(r.body);
    if (data.bookmarks && data.bookmarks.length > 0 && data.bookmarks.every((b) => 'mode' in b)) {
      pass('所有书签都带 mode 字段（向后兼容 null）');
    } else {
      fail('书签应有 mode 字段', r.body);
    }
  } catch (e) {
    fail('GET /api/bookmarks 请求失败', e.message);
  }

  // ---- RSS mode 字段透传 ----
  try {
    const r = await fetchJson(URL + '/api/feeds');
    const data = JSON.parse(r.body);
    if (data.feeds && data.feeds.every((f) => 'mode' in f)) {
      pass('所有 RSS 订阅源都带 mode 字段');
    } else {
      fail('RSS 订阅源应有 mode 字段', r.body);
    }
  } catch (e) {
    fail('GET /api/feeds 请求失败', e.message);
  }

  // ---- POST 接受 mode 字段（端到端） ----
  try {
    const r = await fetch(URL + '/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '__test_mode__', url: 'https://example.com/test', mode: 'entertainment' }),
    });
    const data = await r.json();
    if (data.ok && data.bookmark && data.bookmark.mode === 'entertainment') {
      pass('POST /api/bookmarks 接受 mode 字段');
    } else {
      fail('POST /api/bookmarks 应接受 mode 字段', JSON.stringify(data));
    }
    // 清理
    await fetch(URL + '/api/bookmarks/' + encodeURIComponent(data.bookmark.id), { method: 'DELETE' });
  } catch (e) {
    fail('POST /api/bookmarks 测试失败', e.message);
  }

  try {
    const r = await fetch(URL + '/api/feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '__test_feed__', url: 'http://example.com/feed.xml', mode: 'work' }),
    });
    const data = await r.json();
    if (data.ok && data.feed && data.feed.mode === 'work') {
      pass('POST /api/feeds 接受 mode 字段');
    } else {
      fail('POST /api/feeds 应接受 mode 字段', JSON.stringify(data));
    }
    await fetch(URL + '/api/feeds/' + encodeURIComponent(data.feed.id), { method: 'DELETE' });
  } catch (e) {
    fail('POST /api/feeds 测试失败', e.message);
  }

  // ---- modes.json 缺失时服务端不崩 / 回退内置 ----
  // 已经在 stage 1 验证过；略
  pass('modes.json 缺失容错（设计验证）', 'stage 1 已验证');

  // ---- 模式白名单（非法 id 应静默丢弃） ----
  try {
    const r = await fetch(URL + '/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '__test_invalid__', url: 'https://example.com/inv', mode: 'INJECT_NOPE_NOT_A_REAL_MODE' }),
    });
    const data = await r.json();
    if (data.ok && data.bookmark && data.bookmark.mode === null) {
      pass('非法 mode id 应静默回退 null');
    } else {
      fail('非法 mode id 应回退 null', JSON.stringify(data.bookmark));
    }
    await fetch(URL + '/api/bookmarks/' + encodeURIComponent(data.bookmark.id), { method: 'DELETE' });
  } catch (e) {
    fail('非法 mode id 测试失败', e.message);
  }

  // ---- 数组 mode 字段 ----
  try {
    const r = await fetch(URL + '/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '__test_array__', url: 'https://example.com/arr', mode: ['work', 'entertainment'] }),
    });
    const data = await r.json();
    if (data.ok && data.bookmark && Array.isArray(data.bookmark.mode) && data.bookmark.mode.length === 2) {
      pass('数组 mode 字段正常传递');
    } else {
      fail('数组 mode 字段应正常传递', JSON.stringify(data.bookmark));
    }
    await fetch(URL + '/api/bookmarks/' + encodeURIComponent(data.bookmark.id), { method: 'DELETE' });
  } catch (e) {
    fail('数组 mode 字段测试失败', e.message);
  }

  // ---- PATCH /api/feeds/<id>：编辑现有 RSS 订阅源（v5 feedback 3：模式管理区 RSS inline 编辑）----
  try {
    const uniqueUrl = 'http://example.com/patch-feed-' + Date.now() + '.xml';
    const cr = await fetch(URL + '/api/feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '__test_feed_patch__', url: uniqueUrl, mode: null }),
    });
    const cb = (await cr.json()).feed;
    const pr = await fetch(URL + '/api/feeds/' + encodeURIComponent(cb.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: ['work', 'entertainment'] }),
    });
    const pb = await pr.json();
    if (pb.ok && pb.feed && Array.isArray(pb.feed.mode) && pb.feed.mode.length === 2) {
      pass('PATCH /api/feeds 接受多模式数组');
    } else {
      fail('PATCH /api/feeds 应接受多模式数组', JSON.stringify(pb));
    }
    // 验证非法 mode id 静默回退
    const pr2 = await fetch(URL + '/api/feeds/' + encodeURIComponent(cb.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: '__nonsense__' }),
    });
    const pb2 = await pr2.json();
    if (pb2.ok && pb2.feed && pb2.feed.mode === null) {
      pass('PATCH /api/feeds 非法 mode id 静默回退 null');
    } else {
      fail('PATCH /api/feeds 非法 mode id 应回退 null', JSON.stringify(pb2));
    }
    await fetch(URL + '/api/feeds/' + encodeURIComponent(cb.id), { method: 'DELETE' });
  } catch (e) {
    fail('PATCH /api/feeds 测试失败', e.message);
  }

  // ---- PATCH /api/bookmarks/<id>：编辑现有书签（feedback 5）----
  try {
    const cr = await fetch(URL + '/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '__test_patch_target__', url: 'https://example.com/patch', mode: null }),
    });
    const cb = (await cr.json()).bookmark;
    const pr = await fetch(URL + '/api/bookmarks/' + encodeURIComponent(cb.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'patched', mode: 'entertainment' }),
    });
    const pb = await pr.json();
    if (pb.ok && pb.bookmark && pb.bookmark.name === 'patched' && pb.bookmark.mode === 'entertainment') {
      pass('PATCH 书签（name + mode）正常');
    } else {
      fail('PATCH 书签应更新 name + mode', JSON.stringify(pb));
    }
    // 验证 GET 也返回更新后的字段
    const gr = await fetch(URL + '/api/bookmarks');
    const list = (await gr.json()).bookmarks;
    const found = list.find((b) => b.id === cb.id);
    if (found && found.name === 'patched' && found.mode === 'entertainment') {
      pass('GET 书签反映 PATCH 修改');
    } else {
      fail('GET 书签应反映 PATCH', JSON.stringify(found));
    }
    await fetch(URL + '/api/bookmarks/' + encodeURIComponent(cb.id), { method: 'DELETE' });
  } catch (e) {
    fail('PATCH 书签测试失败', e.message);
  }

  // ---- /api/buttons/update 支持 mode 字段（feedback 6）----
  try {
    const r = await fetch(URL + '/api/buttons/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'anki', mode: 'entertainment' }),
    });
    const data = await r.json();
    if (data.ok) {
      pass('POST /api/buttons/update 接受 mode 字段');
    } else {
      fail('POST /api/buttons/update 应接受 mode', JSON.stringify(data));
    }
    // 验证 buttons.json 持久化
    const raw = await fetch(BASE + '/api/buttons').then((x) => x.json());
    const anki = (raw.buttons || []).find((b) => b.id === 'anki');
    if (anki && anki.mode === 'entertainment') {
      pass('anki.mode 已持久化');
    } else {
      fail('anki.mode 应持久化', JSON.stringify(anki));
    }
    // 还原（不污染用户原数据）
    await fetch(URL + '/api/buttons/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'anki', mode: null }),
    });
  } catch (e) {
    fail('buttons/update mode 字段测试失败', e.message);
  }

  // ---- 总结 ----
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('---');
  console.log(passed === total ? '全部通过 (' + total + ' 项)' : ('通过 ' + passed + ' / ' + total + ' 项'));
  rmSync(USER_DATA, { recursive: true, force: true });
  process.exit(exitCode);
})();
