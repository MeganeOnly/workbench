// 快捷方式支持 .bat/.cmd 脚本（服务端 /api/buttons/add 白名单扩展）测试：
// 用法：node tests/test-buttons-add-bat.mjs
// - 临时 .bat 文件 + POST /api/buttons/add 应成功（返回 id）
// - 添加的按钮字段断言：command=powershell.exe、无 process 徽章、auto=true、icon=null（批处理无图标）
// - .txt 扩展名应被 400 拒绝
// - 不存在的路径应被 400 拒绝
// - finally 清理：/api/buttons/remove 删除测试按钮 + 删除临时文件（跑完 buttons.json 无残留）
//
// 与 test-mode.mjs 同款设计：直接打真实 workbench 服务（3180），无 headless 浏览器依赖。

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3180';

const results = [];
let exitCode = 0;
function pass(name, detail) { results.push({ ok: true, name, detail }); console.log('[PASS]', name, detail ? '— ' + detail : ''); }
function fail(name, detail) { results.push({ ok: false, name, detail }); console.log('[FAIL]', name, detail ? '— ' + detail : ''); exitCode = 1; }

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* 非 JSON 响应 */ }
  return { status: r.status, data };
}

async function getJson(url) {
  const r = await fetch(url);
  return { status: r.status, data: await r.json().catch(() => null) };
}

let tempDir = null;
let batPath = null;
let txtPath = null;
let addedId = null;

async function main() {
  // ---- 准备临时文件（bat 必须纯 ASCII：铁律 2）----
  tempDir = mkdtempSync(join(tmpdir(), 'wb-bat-test-'));
  batPath = join(tempDir, 'workbench-test-dev.bat');
  writeFileSync(batPath, '@echo off\r\necho workbench buttons/add bat test\r\n', { encoding: 'utf8' });
  txtPath = join(tempDir, 'not-a-program.txt');
  writeFileSync(txtPath, 'hello', { encoding: 'utf8' });

  try {
    // ---- 1. .bat 添加成功 ----
    let r = await postJson(BASE + '/api/buttons/add', {
      name: 'workbench-bat-test',
      path: batPath,
      color: '#3b82f6',
      size: 'small',
      mode: null,
    });
    if (r.status === 200 && r.data && r.data.ok === true && r.data.id) {
      addedId = r.data.id;
      pass('POST /api/buttons/add 接受 .bat 路径', 'id=' + addedId + ', icon=' + JSON.stringify(r.data.icon));
    } else {
      fail('POST /api/buttons/add 应接受 .bat 路径', 'status=' + r.status + ' body=' + JSON.stringify(r.data));
    }

    // ---- 2. 添加的按钮字段断言 ----
    if (addedId) {
      const g = await getJson(BASE + '/api/buttons');
      const btn = (g.data && g.data.buttons || []).find((b) => b.id === addedId);
      if (!btn) {
        fail('添加的按钮应出现在 /api/buttons 列表', 'id=' + addedId);
      } else {
        let ok = true;
        const checks = [];
        if (btn.command === 'powershell.exe') checks.push('command=powershell.exe');
        else { ok = false; checks.push('command=' + JSON.stringify(btn.command)); }
        if (btn.auto === true) checks.push('auto=true');
        else { ok = false; checks.push('auto=' + JSON.stringify(btn.auto)); }
        if (btn.process === undefined) checks.push('无 process 徽章（.bat 无独立进程）');
        else { ok = false; checks.push('process=' + JSON.stringify(btn.process)); }
        if (btn.description && String(btn.description).indexOf(batPath) !== -1) checks.push('description 含目标路径');
        else { ok = false; checks.push('description=' + JSON.stringify(btn.description)); }
        if (ok) pass('添加的按钮字段正确', checks.join(' · '));
        else fail('添加的按钮字段不正确', checks.join(' · '));
      }
    }

    // ---- 3. .txt 拒绝 ----
    r = await postJson(BASE + '/api/buttons/add', { name: '', path: txtPath });
    if (r.status === 400 && r.data && r.data.ok === false && /仅支持/.test(r.data.error || '')) {
      pass('POST /api/buttons/add 拒绝 .txt', r.data.error);
    } else {
      fail('POST /api/buttons/add 应拒绝 .txt', 'status=' + r.status + ' body=' + JSON.stringify(r.data));
    }

    // ---- 4. 不存在的路径拒绝 ----
    r = await postJson(BASE + '/api/buttons/add', { name: '', path: join(tempDir, 'no-such-app.exe') });
    if (r.status === 400 && r.data && r.data.ok === false) {
      pass('POST /api/buttons/add 拒绝不存在的路径', r.data.error);
    } else {
      fail('POST /api/buttons/add 应拒绝不存在的路径', 'status=' + r.status + ' body=' + JSON.stringify(r.data));
    }
  } catch (e) {
    fail('测试执行异常', e.message);
  } finally {
    // ---- 清理：删除测试按钮（按 id，不影响用户其它按钮）+ 删除临时目录 ----
    if (addedId) {
      try {
        const r = await postJson(BASE + '/api/buttons/remove', { id: addedId });
        if (r.status === 200 && r.data && r.data.ok === true) {
          pass('清理：已删除测试按钮 ' + addedId);
          addedId = null;
        } else {
          fail('清理：删除测试按钮失败', 'status=' + r.status + ' body=' + JSON.stringify(r.data));
        }
      } catch (e) {
        fail('清理：删除测试按钮异常', e.message);
      }
    }
    try {
      if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    } catch (e) { /* 临时目录删除失败不致命 */ }
  }

  console.log('\n===== 结果: ' + results.filter((r) => r.ok).length + '/' + results.length + ' PASS =====');
  process.exit(exitCode);
}

main();
