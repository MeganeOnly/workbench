// 本地工作台服务：静态页面 + 按钮执行 + 端口状态检查
// 仅监听 127.0.0.1，端口 3180
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const net = require('net');

// ---- HTTPS GET 辅助（用于 DeepSeek 余额查询） ----
function httpsRequest(host, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      path: pathname,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      timeout: opts.timeoutMs || 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('余额响应解析失败: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', (err) => reject(new Error('请求余额失败: ' + err.message)));
    req.on('timeout', () => { req.destroy(new Error('余额请求超时')); });
    req.end();
  });
}

const PORT = 3180;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'buttons.json');

// ---- dsh web API 配置 ----
const DSH_WEB_URL = 'http://127.0.0.1:3080';

// ---- Anki 队列配置（权威路径，与 batch_push.py 一致） ----
const ANKI_QUEUE_PATH = 'E:\\HERMES SKILLS\\anki_to_hermes.json';
const PUSH_STATE_PATH = path.join(ROOT, 'push-state.json');
const BOOKMARKS_PATH = path.join(ROOT, 'bookmarks.json');
const CREDENTIALS_PATH = 'F:\\\\.dsh\\\\.credentials.yaml';

// ---- dida 卡片配置 ----
const DIDA_STATE_PATH = path.join(ROOT, 'dida-state.json'); // 每日执行记录（卡片"点过一次当天隐藏"依据）
const DIDA_DEFAULT_CWD = 'F:\\AllWorkSpace'; // 新建 DSH 对话的工作目录（按钮可配 cwd 覆盖）

// ---- DeepSeek 余额查询（60 秒缓存，避免频繁请求） ----
let balanceCache = { data: null, at: 0 };
const BALANCE_CACHE_MS = 60 * 1000;

function getDeepSeekKey() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    const m = raw.match(/DEEPSEEK_API_KEY:\s*["']?(sk-[^\s"']+)/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function queryDeepSeekBalance() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (balanceCache.data && now - balanceCache.at < BALANCE_CACHE_MS) {
      resolve(balanceCache.data);
      return;
    }
    const key = getDeepSeekKey();
    if (!key) {
      resolve({ ok: false, error: '未找到 DEEPSEEK_API_KEY' });
      return;
    }
    const req = httpsRequest('api.deepseek.com', '/user/balance', {
      headers: { Authorization: 'Bearer ' + key },
      timeoutMs: 15000,
    });
    req.then((parsed) => {
      const info = (parsed.balance_infos || [])[0] || null;
      const data = {
        ok: true,
        available: !!parsed.is_available,
        currency: info ? info.currency : 'CNY',
        total: info ? parseFloat(info.total_balance) : 0,
        granted: info ? parseFloat(info.granted_balance) : 0,
        toppedUp: info ? parseFloat(info.topped_up_balance) : 0,
      };
      balanceCache = { data, at: now };
      resolve(data);
    }).catch((err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

// ---- 书签持久化 ----
let bookmarks = [];
try {
  if (fs.existsSync(BOOKMARKS_PATH)) {
    const raw = fs.readFileSync(BOOKMARKS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) bookmarks = parsed;
  }
} catch (e) {
  console.error('读取 bookmarks.json 失败:', e.message);
}

function saveBookmarks() {
  try {
    fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2), 'utf8');
  } catch (e) {
    console.error('写入 bookmarks.json 失败:', e.message);
  }
}

// ---- RSS 订阅源（信息卡：用户自配 RSS/Atom 源，持久化到 feeds.json）----
const FEEDS_PATH = path.join(ROOT, 'feeds.json');
const RSS_CACHE_MS = 15 * 60 * 1000; // 单源缓存 15 分钟（源不会变得更快，避免频繁抓取）
const RSS_MAX_ITEMS = 8;             // 每源最多条数（卡片展示用，多了没意义）
const RSS_MAX_FEEDS = 12;            // 最多订阅源数（防止配置爆炸）

let rssFeeds = [];
try {
  if (fs.existsSync(FEEDS_PATH)) {
    const raw = fs.readFileSync(FEEDS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) rssFeeds = parsed;
  }
} catch (e) {
  console.error('读取 feeds.json 失败:', e.message);
}

function saveFeeds() {
  try {
    fs.writeFileSync(FEEDS_PATH, JSON.stringify(rssFeeds, null, 2), 'utf8');
  } catch (e) {
    console.error('写入 feeds.json 失败:', e.message);
  }
}

// 每源缓存：feedId -> { data, at }（抓取失败时兜底沿用上次成功数据，标记 stale）
const rssFeedCache = new Map();

// XML 实体解码（含数字字符引用）
function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 取 <tag>...</tag> 文本：优先 CDATA 内容，再解码实体、剥 HTML 标签（部分源标题内嵌 <b> 等）
function xmlText(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = re.exec(block);
  if (!m) return '';
  let v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/i.exec(v);
  if (cdata) v = cdata[1];
  v = decodeXmlEntities(v);
  v = v.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return v;
}

// 极简 RSS 2.0 / Atom 解析（零依赖，覆盖绝大多数源；RSS 0.9x/RDF 的 <item> 结构同 RSS2 一并兼容）
function parseFeedXml(xml) {
  const items = [];
  const push = (title, link, date) => {
    const ts = date ? Date.parse(date) : NaN;
    items.push({
      title: (title || '(无标题)').slice(0, 160),
      link: link || '',
      ts: isFinite(ts) ? ts : null,
      dateText: date || '',
    });
  };
  if (/<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml)) {
    // Atom：feed 标题取首个 <entry> 之前；link 优先 href 属性，回退文本形式
    const headEnd = xml.search(/<entry[\s>]/i);
    const feedTitle = xmlText(headEnd < 0 ? xml : xml.slice(0, headEnd), 'title');
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const e of entries) {
      let link = /<link[^>]*href=["']([^"']+)["'][^>]*>/i.exec(e);
      if (!link) link = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(e);
      push(xmlText(e, 'title'), link ? decodeXmlEntities(link[1]) : '', xmlText(e, 'updated') || xmlText(e, 'published'));
    }
    return { feedTitle, items: items.slice(0, RSS_MAX_ITEMS) };
  }
  // RSS 2.0 / RDF：<channel> 内、首个 <item> 之前是 feed 标题；item 的 link 为纯文本
  const headEnd = xml.search(/<item[\s>]/i);
  const feedTitle = xmlText(headEnd < 0 ? xml : xml.slice(0, headEnd), 'title');
  const els = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const it of els) {
    let link = xmlText(it, 'link');
    if (!link) link = xmlText(it, 'guid'); // 少数源只有 guid 是链接
    push(xmlText(it, 'title'), link, xmlText(it, 'pubDate') || xmlText(it, 'updated') || xmlText(it, 'date'));
  }
  return { feedTitle, items: items.slice(0, RSS_MAX_ITEMS) };
}

// 抓取单个源（缓存 → downloadUrl 抓取 → 解析；失败时沿用旧缓存标 stale，从未成功过才返回错误）
async function fetchFeed(feed) {
  const now = Date.now();
  const hit = rssFeedCache.get(feed.id);
  if (hit && now - hit.at < RSS_CACHE_MS) return hit.data;
  let data;
  try {
    const buf = await downloadUrl(feed.url, 12000);
    if (buf.length > 4 * 1024 * 1024) throw new Error('源内容过大（>4MB），拒绝解析');
    const parsed = parseFeedXml(buf.toString('utf8'));
    if (!parsed.items.length && !parsed.feedTitle) throw new Error('无法解析（不是 RSS/Atom 格式？）');
    data = { ok: true, feedTitle: parsed.feedTitle || feed.name, items: parsed.items };
  } catch (e) {
    if (hit && hit.data && hit.data.ok) data = { ...hit.data, stale: true };
    else data = { ok: false, error: e.message };
  }
  rssFeedCache.set(feed.id, { data, at: now });
  return data;
}

async function getAllFeedsData() {
  const out = [];
  for (const f of rssFeeds) {
    out.push({ id: f.id, name: f.name, url: f.url, ...(await fetchFeed(f)) });
  }
  return out;
}

// ---- 上次 push 时间持久化（服务重启后仍保留） ----
let pushState = { lastPushAt: null };
try {
  if (fs.existsSync(PUSH_STATE_PATH)) {
    const raw = fs.readFileSync(PUSH_STATE_PATH, 'utf8').replace(/^\uFEFF/, '');
    pushState = JSON.parse(raw);
  }
} catch (e) {
  console.error('读取 push-state.json 失败:', e.message);
}

function recordPushTime() {
  pushState.lastPushAt = Date.now();
  try {
    fs.writeFileSync(PUSH_STATE_PATH, JSON.stringify(pushState), 'utf8');
  } catch (e) {
    console.error('写入 push-state.json 失败:', e.message);
  }
}

// ---- dida 卡片每日执行记录持久化（{ [buttonId]: "YYYY-MM-DD" }） ----
let didaState = {};
try {
  if (fs.existsSync(DIDA_STATE_PATH)) {
    const raw = fs.readFileSync(DIDA_STATE_PATH, 'utf8').replace(/^\uFEFF/, '');
    didaState = JSON.parse(raw);
  }
} catch (e) {
  console.error('读取 dida-state.json 失败:', e.message);
}

function saveDidaState() {
  try {
    fs.writeFileSync(DIDA_STATE_PATH, JSON.stringify(didaState, null, 2), 'utf8');
  } catch (e) {
    console.error('写入 dida-state.json 失败:', e.message);
  }
}

// 本地日期 YYYY-MM-DD（卡片"每天一次"以本机日期为准）
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function todayStr() {
  return fmtDate(new Date());
}

// 本周周期锚点日期（YYYY-MM-DD）：weekly dida 按钮"本周"的唯一标识。
// weekday（0=周日..6=周六，默认 0）是周期结束日；一周内任意一天计算都得到
// 同一锚点日期，跨周则变化 → 用于"每周点过一次隐藏 / 下周自动恢复"。
function weekAnchorStr(weekday) {
  const target = weekday == null ? 0 : weekday;
  const d = new Date();
  let diff = target - d.getDay();
  if (diff < 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return fmtDate(d);
}

// 解析 "HH:MM"（24 小时制），非法返回 null
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// dida 按钮可见性：
// - 每日（默认）：今天已点过 → 隐藏；配了 showAfter 且未到点 → 隐藏
// - 每周（weekly:true，如周报按钮）：本周已点过 → 隐藏；今天不是指定 weekday → 隐藏；
//   showAfter 未到 → 隐藏。成功执行后记录本周锚点日期（weekAnchorStr），下周自动恢复可见。
function didaVisible(btn) {
  if (btn.weekly) {
    const weekday = btn.weekday == null ? 0 : btn.weekday; // 0=周日..6=周六
    const weekdayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] || '周日';
    if (didaState[btn.id] === weekAnchorStr(weekday)) {
      return { visible: false, doneToday: false, reason: '本周已执行过' };
    }
    if (new Date().getDay() !== weekday) {
      return { visible: false, doneToday: false, reason: '仅' + weekdayName + ' ' + (btn.showAfter || '') + ' 后出现' };
    }
    const t = parseHHMM(btn.showAfter);
    if (t != null) {
      const d = new Date();
      const now = d.getHours() * 60 + d.getMinutes();
      if (now < t) {
        const hh = String(Math.floor(t / 60)).padStart(2, '0');
        const mm = String(t % 60).padStart(2, '0');
        return { visible: false, doneToday: false, reason: '未到显示时间（' + weekdayName + ' ' + hh + ':' + mm + ' 后出现）' };
      }
    }
    return { visible: true, doneToday: false, reason: null };
  }
  // 每日模式
  const doneToday = didaState[btn.id] === todayStr();
  if (doneToday) return { visible: false, doneToday: true, reason: '今天已执行过' };
  const t = parseHHMM(btn.showAfter);
  if (t != null) {
    const d = new Date();
    const now = d.getHours() * 60 + d.getMinutes();
    if (now < t) {
      const hh = String(Math.floor(t / 60)).padStart(2, '0');
      const mm = String(t % 60).padStart(2, '0');
      return { visible: false, doneToday: false, reason: '未到显示时间（' + hh + ':' + mm + ' 后出现）' };
    }
  }
  return { visible: true, doneToday: false, reason: null };
}

// 返回"距上次 push 的友好描述"
function lastPushSummary() {
  if (!pushState.lastPushAt) return null;
  const seconds = Math.floor((Date.now() - pushState.lastPushAt) / 1000);
  const min = Math.floor(seconds / 60);
  if (min < 1) return { secondsAgo: seconds, text: '刚刚', active: true };
  if (min < 10) return { secondsAgo: seconds, text: min + ' 分钟前', active: true };
  const hours = Math.floor(min / 60);
  if (hours < 1) return { secondsAgo: seconds, text: min + ' 分钟前', active: false };
  const days = Math.floor(hours / 24);
  if (days < 1) return { secondsAgo: seconds, text: hours + ' 小时前', active: false };
  return { secondsAgo: seconds, text: days + ' 天前', active: false };
}

// ---- 读取 Anki 队列并统计条数 ----
function readAnkiQueue() {
  try {
    const raw = fs.readFileSync(ANKI_QUEUE_PATH, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return { total: 0, pending: 0, exists: true, error: null };
    const queue = JSON.parse(raw);
    if (!Array.isArray(queue)) return { total: 0, pending: 0, exists: true, error: '队列文件不是数组' };
    const pending = queue.filter((e) => !e.processed).length;
    return { total: queue.length, pending, exists: true, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { total: 0, pending: 0, exists: false, error: '队列文件不存在' };
    return { total: 0, pending: 0, exists: true, error: '读取队列失败: ' + e.message };
  }
}

// ---- 读取按钮配置（1 秒 TTL 缓存：改 buttons.json 刷新页面即生效，无需重启服务） ----
let buttons = [];
let buttonsTitle = '';
let buttonsLoadedAt = 0;
const BUTTONS_RELOAD_MS = 1000;

function loadButtons() {
  const now = Date.now();
  if (now - buttonsLoadedAt < BUTTONS_RELOAD_MS) return buttons;
  try {
    // 剥掉可能的 UTF-8 BOM（某些编辑器/脚本保存会带 BOM，JSON.parse 会失败）
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.buttons)) buttons = parsed.buttons;
    if (parsed && parsed.title) buttonsTitle = parsed.title;
  } catch (e) {
    console.error('无法读取 buttons.json:', e.message);
  }
  buttonsLoadedAt = now;
  return buttons;
}

loadButtons(); // 启动时加载一次

// ---- 快捷方式按钮管理（设置面板「添加快捷方式」自动添加/删除，无需手改配置、不消耗 AI token）----
const ICON_DIR = path.join(PUBLIC_DIR, 'icons');

function saveButtonsFile(list) {
  const data = { title: buttonsTitle, buttons: list };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 4), 'utf8');
  buttons = list;
  buttonsLoadedAt = 0; // 立即失效 1 秒缓存，下一次 loadButtons 读到新配置
}

function slugifyId(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

// 提取 exe/.lnk 内嵌图标为 ICO（失败返回 false，不致命：前端回退字符图标）
function extractAppIcon(target, outIco) {
  return new Promise((resolve) => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'extract-app-icon.ps1'), target, outIco,
    ], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outIco)));
  });
}

// ---- 前端静态文件版本（MD5，用于页面自检自动刷新）----
// 前端在 /api/buttons 里取到 version，与自身加载时的版本比对：
// 不一致说明页面代码已更新，自动 reload，避免用户停留在旧 JS 上（"点了没反应"的根源之一）。
const VERSION_FILES = ['app.js', 'style.css', 'index.html'];
function appVersion() {
  try {
    const h = crypto.createHash('md5');
    for (const f of VERSION_FILES) {
      h.update(fs.readFileSync(path.join(PUBLIC_DIR, f)));
    }
    return h.digest('hex').slice(0, 12);
  } catch (e) {
    return 'unknown';
  }
}

// ---- 内存运行日志 ----
const MAX_LOGS = 100;
const logs = [];

// ---- 工具：端口是否在监听 ----
function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(800);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// ---- 工具：进程是否在运行（桌面应用按钮的状态徽章，如 Anki） ----
const TASKLIST = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
function isProcessRunning(name) {
  return new Promise((resolve) => {
    const child = spawn(TASKLIST, ['/FI', 'IMAGENAME eq ' + name, '/NH'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.toLowerCase().includes(name.toLowerCase())));
  });
}

// ---- 书签小图标（favicon）代理：本地缓存 → 站点直取 → Bing 兜底 ----
const FAVICON_DIR = path.join(ROOT, 'favicons');
try { if (!fs.existsSync(FAVICON_DIR)) fs.mkdirSync(FAVICON_DIR); } catch (e) { console.error('创建 favicons 目录失败:', e.message); }

// 通用下载（支持 https/http，跟随重定向），返回 Buffer
function downloadUrl(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        downloadUrl(next, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) return reject(new Error('空响应'));
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('下载超时')));
  });
}

async function getFavicon(domain, fullUrl) {
  const cacheFile = path.join(FAVICON_DIR, domain + '.ico');
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile);
  const sources = [
    'https://' + domain + '/favicon.ico',
    'http://' + domain + '/favicon.ico',
    'https://www.bing.com/favicon.ico?url=' + encodeURIComponent(fullUrl || ('https://' + domain + '/')),
  ];
  for (const u of sources) {
    try {
      const buf = await downloadUrl(u);
      try { fs.writeFileSync(cacheFile, buf); } catch (e) { /* 缓存失败不致命 */ }
      return buf;
    } catch (e) { /* 换下一个来源 */ }
  }
  return null;
}

// ---- 调用 dsh web API（Typert unary 协议：POST /api/<method>）----
function callDshApi(method, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const rpcId = 'workbench-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10);
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
    const req = http.request({
      host: '127.0.0.1',
      port: 3080,
      path: '/api/' + method,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.result && parsed.result.ok) resolve(parsed.result.value);
          else reject(new Error('dsh API ' + method + ' 失败: ' + (parsed.result ? JSON.stringify(parsed.result) : data.slice(0, 200))));
        } catch (e) {
          reject(new Error('dsh API ' + method + ' 响应解析失败: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', (err) => reject(new Error('无法连接 dsh web (3080): ' + err.message)));
    req.on('timeout', () => { req.destroy(new Error('dsh API ' + method + ' 超时')); });
    req.write(body);
    req.end();
  });
}

// ---- dida365 MCP 客户端（今日任务信息卡）----
// 凭据从 DSH profile 的 cordis.patch.yml 读取（Bearer token），避免硬编码。
const DIDA_MCP_URL = 'https://mcp.dida365.com';
const DIDA_MCP_CONFIG = 'F:\\.dsh\\profiles\\web\\cordis.patch.yml';

function getDidaMcpToken() {
  try {
    const raw = fs.readFileSync(DIDA_MCP_CONFIG, 'utf8');
    const m = raw.match(/Authorization:\s*'Bearer\s+([^']+)'/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

// MCP streamable-http 调用（JSON-RPC 2.0）。实测该服务器无需 session：直接 tools/call 即返回。
function didaMcpCall(tool, args) {
  return new Promise((resolve, reject) => {
    const token = getDidaMcpToken();
    if (!token) return reject(new Error('未找到 dida365 MCP token'));
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } });
    const req = https.request({
      host: 'mcp.dida365.com',
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + token,
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error('dida MCP 错误: ' + (parsed.error.message || JSON.stringify(parsed.error))));
          const result = parsed.result;
          // MCP 工具级错误：isError=true 且错误信息在 content[].text 里（如 "Error executing tool ..."）
          if (result && result.isError === true) {
            let errText = '未知工具错误';
            if (Array.isArray(result.content)) {
              const texts = result.content.filter(i => i && i.type === 'text').map(i => i.text).filter(Boolean);
              if (texts.length) errText = texts[0];
            }
            return reject(new Error(errText));
          }
          resolve(result);
        } catch (e) {
          reject(new Error('dida MCP 响应解析失败: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', (err) => reject(new Error('无法连接 dida MCP: ' + err.message)));
    req.on('timeout', () => { req.destroy(new Error('dida MCP 请求超时')); });
    req.end(body);
  });
}

// 今日任务（5 分钟缓存：避免高频请求滴答 MCP，降低封号/限流风险；任务变化不频繁，5 分钟刷新足够）
let didaTodayCache = { data: null, at: 0 };
const DIDA_TODAY_CACHE_MS = 5 * 60 * 1000;

function fmtTaskTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function queryDidaToday() {
  const now = Date.now();
  if (didaTodayCache.data && now - didaTodayCache.at < DIDA_TODAY_CACHE_MS) {
    return didaTodayCache.data;
  }
  try {
    const result = await didaMcpCall('list_undone_tasks_by_time_query', { query_command: 'today' });
    const tasks = [];
    for (const item of (result && result.content) || []) {
      if (item.type !== 'text') continue;
      let t = null;
      try { t = JSON.parse(item.text); } catch (e) { continue; }
      if (!t || !t.title) continue;
      tasks.push({
        id: t.id,
        projectId: t.project_id || null,
        title: t.title,
        time: t.is_all_day ? null : fmtTaskTime(t.start_date || t.due_date),
        allDay: !!t.is_all_day,
        priority: t.priority || 0,
        tags: Array.isArray(t.tags) ? t.tags : [],
      });
    }
    // 排序：有时间的按时间升序，全天/无时间置顶（与滴答「今日」视图一致）
    tasks.sort((a, b) => {
      if (!a.time && !b.time) return 0;
      if (!a.time) return -1;
      if (!b.time) return 1;
      return a.time.localeCompare(b.time);
    });
    const data = { ok: true, count: tasks.length, tasks };
    didaTodayCache = { data, at: now };
    return data;
  } catch (e) {
    return { ok: false, error: e.message, count: 0, tasks: [] };
  }
}

// 今日专注时长（番茄钟 type=0 + 计时 type=1；10 分钟缓存，降低 MCP 请求频率）
let didaFocusCache = { data: null, at: 0 };
const DIDA_FOCUS_CACHE_MS = 10 * 60 * 1000;

// 本地日期边界（YYYY-MM-DDT00:00:00+08:00 形式，避免时区歧义）
function localDayRange() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const y = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate();
  const base = `${y}-${pad(mo)}-${pad(d)}`;
  // 滴答账号为 Asia/Shanghai（+08:00），固定用该时区边界
  return { from: `${base}T00:00:00+08:00`, to: `${base}T23:59:59+08:00` };
}

async function queryDidaFocusToday() {
  const now = Date.now();
  if (didaFocusCache.data && now - didaFocusCache.at < DIDA_FOCUS_CACHE_MS) {
    return didaFocusCache.data;
  }
  try {
    const { from, to } = localDayRange();
    const all = [];
    for (const type of [0, 1]) {
      const result = await didaMcpCall('get_focuses_by_time', { from_time: from, to_time: to, type });
      for (const item of (result && result.content) || []) {
        if (item.type !== 'text') continue;
        let rec = null;
        try { rec = JSON.parse(item.text); } catch (e) { continue; }
        if (!rec || typeof rec !== 'object') continue;
        all.push({ ...rec, _type: type });
      }
    }
    let totalMs = 0;
    let pomodoroMs = 0;
    let timingMs = 0;
    for (const rec of all) {
      const dur = typeof rec.duration === 'number' && rec.duration > 0
        ? rec.duration
        : (rec.endTime && rec.startTime ? new Date(rec.endTime) - new Date(rec.startTime) : 0);
      if (!(dur > 0)) continue;
      totalMs += dur;
      if (rec._type === 0) pomodoroMs += dur;
      else timingMs += dur;
    }
    const data = { ok: true, count: all.length, totalMs, pomodoroMs, timingMs };
    didaFocusCache = { data, at: now };
    return data;
  } catch (e) {
    return { ok: false, error: e.message, count: 0, totalMs: 0, pomodoroMs: 0, timingMs: 0 };
  }
}

// 完成任务（点击今日任务列表项 → 标记为已完成；调用 MCP complete_task）
async function completeDidaTask(projectId, taskId) {
  try {
    if (!projectId || !taskId) return { ok: false, error: '缺少 projectId 或 taskId' };
    const result = await didaMcpCall('complete_task', { project_id: projectId, task_id: taskId });
    // 完成成功后清掉今日任务缓存，下次轮询立即反映（任务从今日列表消失）
    didaTodayCache = { data: null, at: 0 };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Push 卡片流程：在 Anki 工作目录创建新对话并发送 "push" ----
const PUSH_LOCK_MS = 10 * 60 * 1000; // 锁定 10 分钟

async function runPush() {
  // 锁定检查：距上次 push 不足 10 分钟则拒绝
  const now = Date.now();
  if (pushState.lastPushAt && now - pushState.lastPushAt < PUSH_LOCK_MS) {
    const remainingMs = PUSH_LOCK_MS - (now - pushState.lastPushAt);
    const remainingMin = Math.ceil(remainingMs / 60000);
    const entry = {
      time: new Date().toLocaleTimeString(),
      id: 'push',
      name: 'Push 卡片',
      status: 'error',
      error: '10 分钟内已 push 过，剩余 ' + remainingMin + ' 分钟',
    };
    pushLog(entry);
    return { ok: false, locked: true, remainingMinutes: remainingMin, error: entry.error, entry };
  }

  const entry = {
    time: new Date().toLocaleTimeString(),
    id: 'push',
    name: 'Push 卡片',
    status: 'running',
  };
  pushLog(entry);
  try {
    const created = await callDshApi('session.create', { cwd: 'F:\\Anki - DeepSeek -Harness' });
    const sessionId = created.sessionId;
    entry.sessionId = sessionId;
    const prompted = await callDshApi('session.prompt', {
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'push' }],
    });
    recordPushTime();
    entry.status = 'done';
    entry.code = 0;
    entry.finished = new Date().toLocaleTimeString();
    return { ok: true, sessionId, accepted: prompted.accepted, entry };
  } catch (e) {
    entry.status = 'error';
    entry.error = e.message;
    return { ok: false, error: e.message, entry };
  }
}

// ---- dida 卡片流程：在指定工作目录新建 DSH 对话并发送按钮配置的 prompt ----
// 与 Push 卡片（runPush）类似，但：1) prompt 与 cwd 来自按钮配置；2) 每日一次，
// 成功后记录 dida-state（当天隐藏），失败（如 DSH 未运行）不记录、可重试。
async function runDida(btn) {
  const vis = didaVisible(btn);
  const entry = {
    time: new Date().toLocaleTimeString(),
    id: btn.id,
    name: btn.name,
    status: 'running',
  };
  if (!vis.visible) {
    entry.status = 'error';
    entry.error = vis.reason || '当前不可用';
    pushLog(entry);
    return { ok: false, error: entry.error, entry };
  }
  pushLog(entry);
  try {
    const cwd = btn.cwd || DIDA_DEFAULT_CWD;
    const created = await callDshApi('session.create', { cwd });
    const sessionId = created.sessionId;
    entry.sessionId = sessionId;
    const prompted = await callDshApi('session.prompt', {
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: btn.prompt }],
    });
    // 只有真正把文字发出去（成功创建会话并收到 prompt 受理）才记为"已完成"
    // 每日按钮记当天日期；weekly 按钮记本周锚点日期（本周点过一次隐藏，下周恢复）
    didaState[btn.id] = btn.weekly ? weekAnchorStr(btn.weekday) : todayStr();
    saveDidaState();
    entry.status = 'done';
    entry.code = 0;
    entry.finished = new Date().toLocaleTimeString();
    return { ok: true, sessionId, accepted: prompted.accepted, entry };
  } catch (e) {
    entry.status = 'error';
    entry.error = e.message;
    return { ok: false, error: e.message, entry };
  }
}

// ---- 执行命令（def: {command, args, cwd}）----
function runCommand(def, name, id) {
  return new Promise((resolve) => {
    const cmd = def.command || 'cmd.exe';
    const args = def.args || [];
    const entry = {
      time: new Date().toLocaleTimeString(),
      id: id,
      name: name,
      status: 'running',
    };
    pushLog(entry);

    let settled = false;
    // 重要：必须用 shell 模式执行完整命令行。
    // 若用 spawn(cmd, args) 数组形式，Node 会把含引号的参数（如 call "C:\...\xxx.bat"）
    // 二次转义，拼出的命令行 cmd.exe 无法解析，bat 根本不会执行（退出码 1，按钮无反应）。
    // 改为拼接字符串 + shell:true，由 cmd /d /s /c 按引号规则正确剥壳执行。
    const full = [cmd, ...args].join(' ');
    const child = spawn(full, {
      cwd: def.cwd || ROOT,
      windowsHide: true,
      stdio: 'ignore',
      shell: true,
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      entry.status = 'done';
      entry.code = code;
      entry.finished = new Date().toLocaleTimeString();
      resolve(entry);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      entry.status = 'error';
      entry.error = err.message;
      resolve(entry);
    });
    child.on('close', finish);
  });
}

function pushLog(entry) {
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.pop();
}

// ---- JSON 响应 ----
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---- 静态文件 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // 禁用缓存：保证刷新页面后总能拿到最新的 app.js/style.css（按钮改动常见坑）
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---- 序列化按钮给前端（附端口/进程状态）----
async function serializeButton(btn) {
  let running = null;
  if (btn.port) running = await isPortListening(btn.port);
  else if (btn.process) running = await isProcessRunning(btn.process);
  // 按钮图标：public/icons/<id>.ico 存在则前端显示软件自身图标（<img>），否则回退字符图标
  const icon = fs.existsSync(path.join(ICON_DIR, btn.id + '.ico')) ? 'icons/' + btn.id + '.ico' : null;
  if (btn.toggle) {
    const key = running ? 'stop' : 'start';
    const act = btn.toggle[key] || {};
    return {
      id: btn.id,
      name: btn.name,
      description: btn.description,
      size: btn.size,
      port: btn.port,
      running: running,
      icon,
      toggle: true,
      action: { key: key, label: act.label || key, color: act.color },
    };
  }
  // push 按钮：附带上次 push 时间信息 + 锁定状态
  if (btn.kind === 'push') {
    const summary = lastPushSummary();
    let locked = false;
    let lockedMinutes = 0;
    if (pushState.lastPushAt) {
      const remainingMs = PUSH_LOCK_MS - (Date.now() - pushState.lastPushAt);
      if (remainingMs > 0) {
        locked = true;
        lockedMinutes = Math.ceil(remainingMs / 60000);
      }
    }
    return { ...btn, running: null, icon, lastPush: summary, locked, lockedMinutes };
  }
  // dida 按钮：附带可见性（前端隐藏不可见卡片，实现"到点出现 / 每天点过一次隐藏"）
  if (btn.kind === 'dida') {
    const vis = didaVisible(btn);
    return { ...btn, running: null, icon, visible: vis.visible, doneToday: vis.doneToday, hiddenReason: vis.reason };
  }
  return { ...btn, running, icon };
}

// ---- HTTP 服务 ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const p = url.pathname;

  // 请求日志：写入 stdout（workbench.log），便于排查"点了没反应"。
  // GET /api/* 全是 2-5 秒级高频轮询（buttons/queue/logs 等），刷屏且让日志膨胀，
  // 不记录；POST（按钮点击）与页面/静态文件加载照常全记——
  // "有 POST 记录 = 请求到达了服务端"的排查口诀不变。
  if (!(req.method === 'GET' && p.startsWith('/api/'))) {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${p}`);
  }

  // 按钮列表（附端口状态 + 前端静态文件版本）
  if (p === '/api/buttons' && req.method === 'GET') {
    const list = [];
    for (const btn of loadButtons()) {
      list.push(await serializeButton(btn));
    }
    return json(res, { buttons: list, version: appVersion() });
  }

  // toggle 按钮：按当前端口状态自动决定执行 start 或 stop
  if (p.startsWith('/api/toggle/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/toggle/'.length));
    const btn = loadButtons().find((b) => b.id === id);
    if (!btn || !btn.toggle) {
      return json(res, { ok: false, error: '未知的 toggle 按钮: ' + id }, 404);
    }
    const running = btn.port ? await isPortListening(btn.port) : false;
    const key = running ? 'stop' : 'start';
    const def = btn.toggle[key] || {};
    const entry = await runCommand(def, btn.name + '（' + (def.label || key) + '）', btn.id);
    return json(res, { ok: true, action: key, entry });
  }

  // Anki 队列统计
  if (p === '/api/queue' && req.method === 'GET') {
    return json(res, readAnkiQueue());
  }

  // DeepSeek 余额
  if (p === '/api/balance' && req.method === 'GET') {
    const bal = await queryDeepSeekBalance();
    return json(res, bal);
  }

  // 滴答今日任务（今日任务信息卡）
  if (p === '/api/dida-today' && req.method === 'GET') {
    const data = await queryDidaToday();
    return json(res, data);
  }

  // 滴答今日专注时长（番茄钟 + 计时汇总）
  if (p === '/api/dida-focus' && req.method === 'GET') {
    const data = await queryDidaFocusToday();
    return json(res, data);
  }

  // 完成任务（点击今日任务列表项）
  if (p === '/api/dida-complete' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { projectId, taskId } = JSON.parse(body);
      const result = await completeDidaTask(projectId, taskId);
      return json(res, result, result.ok ? 200 : 500);
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
  }

  // 书签列表
  if (p === '/api/bookmarks' && req.method === 'GET') {
    return json(res, { bookmarks });
  }

  // 新增书签
  if (p === '/api/bookmarks' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { name, url } = JSON.parse(body);
      if (!name || !url) return json(res, { ok: false, error: '名字和网址都不能为空' }, 400);
      const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, url, createdAt: Date.now() };
      bookmarks.push(item);
      saveBookmarks();
      return json(res, { ok: true, bookmark: item });
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
  }

  // 书签排序（前端拖拽后提交完整 id 顺序）
  if (p === '/api/bookmarks/reorder' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { ids } = JSON.parse(body);
      if (!Array.isArray(ids)) return json(res, { ok: false, error: 'ids 必须是数组' }, 400);
      const byId = new Map(bookmarks.map((b) => [b.id, b]));
      const next = ids.map((id) => byId.get(id)).filter(Boolean);
      if (next.length !== bookmarks.length) return json(res, { ok: false, error: '书签数量不匹配' }, 400);
      bookmarks = next;
      saveBookmarks();
      return json(res, { ok: true });
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
  }

  // 删除书签
  if (p.startsWith('/api/bookmarks/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/bookmarks/'.length));
    const before = bookmarks.length;
    bookmarks = bookmarks.filter((b) => b.id !== id);
    if (bookmarks.length === before) return json(res, { ok: false, error: '书签不存在' }, 404);
    saveBookmarks();
    return json(res, { ok: true });
  }

  // RSS 订阅源列表（设置面板管理用）
  if (p === '/api/feeds' && req.method === 'GET') {
    return json(res, { feeds: rssFeeds.map((f) => ({ id: f.id, name: f.name, url: f.url })) });
  }

  // 新增 RSS 订阅源 {name, url}
  if (p === '/api/feeds' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { name, url } = JSON.parse(body);
      const clean = (url || '').trim();
      const cleanName = (name || '').trim();
      if (!cleanName || !clean) return json(res, { ok: false, error: '名称和地址都不能为空' }, 400);
      if (!/^https?:\/\/\S+$/i.test(clean)) return json(res, { ok: false, error: '地址必须以 http:// 或 https:// 开头' }, 400);
      if (rssFeeds.some((f) => f.url === clean)) return json(res, { ok: false, error: '该地址已添加过' }, 400);
      if (rssFeeds.length >= RSS_MAX_FEEDS) return json(res, { ok: false, error: '最多 ' + RSS_MAX_FEEDS + ' 个订阅源' }, 400);
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: cleanName.slice(0, 30),
        url: clean.slice(0, 500),
        createdAt: Date.now(),
      };
      rssFeeds.push(item);
      saveFeeds();
      return json(res, { ok: true, feed: item });
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
  }

  // 删除 RSS 订阅源
  if (p.startsWith('/api/feeds/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/feeds/'.length));
    const before = rssFeeds.length;
    rssFeeds = rssFeeds.filter((f) => f.id !== id);
    if (rssFeeds.length === before) return json(res, { ok: false, error: '订阅源不存在' }, 404);
    rssFeedCache.delete(id);
    saveFeeds();
    return json(res, { ok: true });
  }

  // RSS 信息卡数据（全部源合并，含每源错误/过期标记）
  if (p === '/api/rss' && req.method === 'GET') {
    const feeds = await getAllFeedsData();
    return json(res, { ok: true, feeds });
  }

  // Push 卡片：创建新对话并发送 push
  if (p === '/api/push' && req.method === 'POST') {
    const result = await runPush();
    // 锁定是业务性拒绝（HTTP 200 + locked 标志）；其他失败才 500
    return json(res, result, result.locked ? 200 : (result.ok ? 200 : 500));
  }

  // dida 卡片：创建新对话并发送按钮配置的 prompt（整理inbox / 安排今日任务）
  if (p.startsWith('/api/dida/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/dida/'.length));
    const btn = loadButtons().find((b) => b.id === id);
    if (!btn || btn.kind !== 'dida') {
      return json(res, { ok: false, error: '未知的 dida 按钮: ' + id }, 404);
    }
    const result = await runDida(btn);
    return json(res, result, result.ok ? 200 : 500);
  }

  // 执行按钮（普通按钮，向后兼容）
  if (p.startsWith('/api/run/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/run/'.length));
    const btn = loadButtons().find((b) => b.id === id);
    if (!btn) return json(res, { ok: false, error: '未知按钮: ' + id }, 404);
    const entry = await runCommand(btn, btn.name, btn.id);
    return json(res, { ok: true, entry });
  }

  // 快捷方式管理：设置面板「添加快捷方式」——自动写 buttons.json + 提取图标（不消耗 AI token）
  if (p === '/api/buttons/add' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { name, path: target, color, size } = JSON.parse(body);
      if (!target || typeof target !== 'string' || !target.trim()) return json(res, { ok: false, error: '程序路径不能为空' }, 400);
      let clean = target.trim();
      // 自动剥掉首尾成对的双引号（从地址栏/命令行复制路径常自带 "..."，如 "C:\Program Files\Zotero\zotero.exe"）
      if (clean.length >= 2 && clean.startsWith('"') && clean.endsWith('"')) {
        clean = clean.slice(1, -1).trim();
      }
      let stat = null;
      try { stat = fs.statSync(clean); } catch (e) { /* 不存在 */ }
      if (!stat || !stat.isFile()) return json(res, { ok: false, error: '路径不存在或不是文件: ' + clean }, 400);
      if (/["%&|<>^]/.test(clean)) return json(res, { ok: false, error: '路径包含不支持的特殊字符（" % & | < > ^）' }, 400);
      const ext = path.extname(clean).toLowerCase();
      if (ext !== '.exe' && ext !== '.lnk') return json(res, { ok: false, error: '仅支持 .exe 程序或 .lnk 快捷方式' }, 400);
      const baseName = path.basename(clean, ext);
      const displayName = (name && String(name).trim()) || baseName;
      const existing = new Set(loadButtons().map(b => b.id));
      let id = slugifyId(baseName);
      let n = 2;
      while (existing.has(id)) { id = slugifyId(baseName) + '-' + n; n++; }
      const btn = {
        id,
        name: displayName,
        description: '打开 ' + clean,
        size: size === 'wide' ? 'wide' : 'small',
        color: color || '#3b82f6',
        auto: true,
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          '"' + path.join(ROOT, 'launch-app.ps1') + '"',
          '"' + clean + '"',
        ],
      };
      if (ext === '.exe') btn.process = baseName.toLowerCase() + '.exe';
      saveButtonsFile(loadButtons().concat([btn]));
      const ico = path.join(ICON_DIR, id + '.ico');
      const iconOk = await extractAppIcon(clean, ico);
      return json(res, { ok: true, id, icon: iconOk ? 'icons/' + id + '.ico' : null });
    } catch (e) {
      return json(res, { ok: false, error: '添加失败: ' + e.message }, 400);
    }
  }

  // 删除自动添加的快捷方式按钮（仅 auto 标记的按钮可删，防误删手写配置）
  if (p === '/api/buttons/remove' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { id } = JSON.parse(body);
      if (!id) return json(res, { ok: false, error: '缺少按钮 id' }, 400);
      const list = loadButtons();
      const btn = list.find(b => b.id === id);
      if (!btn) return json(res, { ok: false, error: '按钮不存在: ' + id }, 404);
      if (!btn.auto) return json(res, { ok: false, error: '该按钮是手动配置的，请在 buttons.json 中删除' }, 403);
      saveButtonsFile(list.filter(b => b.id !== id));
      const ico = path.join(ICON_DIR, id + '.ico');
      try { if (fs.existsSync(ico)) fs.unlinkSync(ico); } catch (e) { /* 图标删除失败不致命 */ }
      return json(res, { ok: true });
    } catch (e) {
      return json(res, { ok: false, error: '删除失败: ' + e.message }, 400);
    }
  }

  // 更新快捷方式按钮（改颜色/尺寸；普通按钮均可改，删除仍仅限 auto）
  if (p === '/api/buttons/update' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { id, color, size } = JSON.parse(body);
      if (!id) return json(res, { ok: false, error: '缺少按钮 id' }, 400);
      const list = loadButtons();
      const btn = list.find(b => b.id === id);
      if (!btn) return json(res, { ok: false, error: '按钮不存在: ' + id }, 404);
      if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) return json(res, { ok: false, error: '颜色格式不正确' }, 400);
      if (size !== undefined && size !== 'small' && size !== 'wide') return json(res, { ok: false, error: '尺寸只能是 small 或 wide' }, 400);
      if (color) btn.color = color;
      if (size) btn.size = size;
      saveButtonsFile(list);
      return json(res, { ok: true });
    } catch (e) {
      return json(res, { ok: false, error: '更新失败: ' + e.message }, 400);
    }
  }

  // 运行日志
  if (p === '/api/logs' && req.method === 'GET') {
    return json(res, { logs });
  }

  // 书签小图标代理（前端 <img> 直接引用；缓存 24h）
  if (p === '/api/favicon' && req.method === 'GET') {
    const domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain)) return json(res, { ok: false, error: '非法 domain' }, 400);
    const fullUrl = url.searchParams.get('url') || '';
    const fav = await getFavicon(domain, fullUrl);
    if (!fav) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
    res.end(fav);
    return;
  }

  // 客户端错误上报（前端 window.onerror → 服务端日志，排查"点了没反应"）
  if (p === '/api/log-client-error' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let msg = '客户端错误';
    try { msg = (JSON.parse(body).msg || msg).slice(0, 500); } catch (e) { /* 保留默认 */ }
    console.log('[client] ' + msg);
    return json(res, { ok: true });
  }

  // 其余走静态文件
  if (req.method === 'GET') return serveStatic(req, res, p);
  res.writeHead(405);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('工作台已启动: http://127.0.0.1:' + PORT);
});
