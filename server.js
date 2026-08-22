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

// ---- 个人环境配置（config.json，已被 .gitignore 排除；仓库带 config.example.json 模板）----
// 所有与本机强相关的路径集中在此；未配置的项回退到通用默认值，对应功能显示"未配置/
// 未找到"而不是崩溃——fresh clone 不写 config.json 也能跑起来。
let USER_CFG = {};
try {
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
  USER_CFG = JSON.parse(raw);
} catch (e) { /* 无 config.json = 全默认，开箱即用 */ }
function cfg(key, fallback) {
  const v = USER_CFG && USER_CFG[key];
  return (typeof v === 'string' && v) ? v : fallback;
}

// ---- dsh web API 配置 ----
const DSH_WEB_URL = 'http://127.0.0.1:3080';

// ---- Anki 队列配置（ankiQueuePath：与 batch_push.py 输出一致，在 config.json 配置） ----
const ANKI_QUEUE_PATH = cfg('ankiQueuePath', path.join(ROOT, 'anki-queue.json'));
const PUSH_STATE_PATH = path.join(ROOT, 'push-state.json');
const BOOKMARKS_PATH = path.join(ROOT, 'bookmarks.json');
const CREDENTIALS_PATH = cfg('credentialsPath', ''); // DeepSeek API Key 所在 yaml；未配置则余额卡提示"未找到"

// ---- 模式定义（modes.json：可扩展模式列表 + 每模式 readonly 等元数据） ----
// 启动时读取；文件缺失或解析失败 → 回退内置默认（work / entertainment）；
// 这样 modes.json 误删 / 损坏 / 首次部署都不会让服务起不来，符合 fresh clone 鲁棒性原则。
// 加新模式 = 改 modes.json 一行，零代码改动（前端动态渲染切换器 + 后端白名单校验）。
// v1 教训：本段必须先于任何调用 normalizeModeField 的加载段（bookmarks/feeds/syscards）。
// 原代码位置（line 345+）导致 bookmarks 加载段在 MODES 之前调用 normalizeModeField → TDZ。
const MODES_PATH = path.join(ROOT, 'modes.json');
const DEFAULT_MODES = {
  default: 'work',
  modes: [
    { id: 'work', name: '工作', icon: '▣', readonly: true, description: '工作模式' },
    { id: 'entertainment', name: '娱乐', icon: '▶', readonly: false, description: '娱乐模式' },
  ],
};
let MODES = DEFAULT_MODES;
try {
  if (fs.existsSync(MODES_PATH)) {
    const raw = fs.readFileSync(MODES_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.modes) && parsed.modes.length) {
      // 校验每条模式：必须有 id 字符串（其他字段缺省回退），非法项丢弃
      const valid = parsed.modes.filter((m) => m && typeof m.id === 'string' && m.id);
      if (valid.length) {
        MODES = {
          default: (typeof parsed.default === 'string' && valid.some((m) => m.id === parsed.default)) ? parsed.default : valid[0].id,
          modes: valid.map((m) => ({
            id: m.id,
            name: typeof m.name === 'string' ? m.name : m.id,
            icon: typeof m.icon === 'string' ? m.icon : '',
            readonly: m.readonly === true,
            description: typeof m.description === 'string' ? m.description : '',
          })),
        };
      }
    }
  }
} catch (e) {
  console.error('读取 modes.json 失败，使用内置默认:', e.message);
}

// ---- 模式处理基础设施（必须在书签/订阅/系统卡加载段之前就绪；v1 教训）----
// v0.8→v1 升级曾因 TDZ 静默 fallback 导致书签数据被覆盖：bookmarks.json 加载段（line 254）
// 调用 normalizeModeField → 内部访问 MODE_HIDDEN_SENTINEL → const 声明前 TDZ 抛错
// → try/catch 吞掉 → 内存空数组 → 后续 saveBookmarks 写入覆盖原文件。
// 修复：把 MODES / MODE_HIDDEN_SENTINEL / isValidModeId / normalizeModeField 上移到所有数据加载段之前。
// v0.8 引入 'hidden' 哨兵值（__hidden__）：UI 上"隐藏"按钮对应的 sentinel，所有模式都不可见，
// 不属于 MODES.modes 列表但合法需透传——单独识别。
const MODE_HIDDEN_SENTINEL = '__hidden__';
function isValidModeId(id) {
  if (id == null) return true; // null/undefined = 全部模式可见，始终合法
  if (typeof id !== 'string') return false;
  if (id === MODE_HIDDEN_SENTINEL) return true; // hidden sentinel 单独识别
  return MODES.modes.some((m) => m.id === id);
}
// 规范化 mode 字段：null 维持、字符串保留、数组项逐一校验后过滤
function normalizeModeField(m) {
  if (m == null) return null;
  if (typeof m === 'string') return isValidModeId(m) ? m : null;
  if (Array.isArray(m)) {
    const arr = m.filter((x) => typeof x === 'string' && isValidModeId(x));
    return arr.length ? arr : null;
  }
  return null;
}

// ---- 数据加载失败保护辅助（v1 教训：bookmarks.json 曾因 TDZ fallback 被覆盖为 []）----
// 加载失败时把原文件复制为 .bak 保留数据，配合下方 bookmarks 段的"锁定写入"防止再次覆盖。
// feeds / syscards / modes / buttons 暂不接（TDZ 顺序修复后它们的加载路径已无同类问题）。
function backupCorruptedData(filePath, reason) {
  try {
    if (fs.existsSync(filePath)) {
      const bakPath = filePath + '.bak';
      fs.copyFileSync(filePath, bakPath);
      console.error('[BACKUP] ' + filePath + ' -> ' + bakPath + ' (reason: ' + reason + ')');
    }
  } catch (e) {
    console.error('备份失败数据失败:', e.message);
  }
}

// ---- dida 卡片配置 ----
const DIDA_STATE_PATH = path.join(ROOT, 'dida-state.json'); // 每日执行记录（卡片"点过一次当天隐藏"依据）
// 新建 DSH 对话的工作目录（按钮可配 cwd 覆盖；config.json 的 didaDefaultCwd）
const DIDA_DEFAULT_CWD = cfg('didaDefaultCwd', process.env.USERPROFILE || '.');

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

// ---- MiniMax Token Plan 额度查询（60 秒缓存） ----
// endpoint：/v1/token_plan/remains（中国版 api.minimaxi.com / 全球版 api.minimax.io）
// 鉴权：Authorization: Bearer <Subscription Key>。响应里 model_remains 是按 model 拆分的数组，
// 每条同时含 5h 窗口（current_interval_*）和周窗口（current_weekly_*）两组；percent 字段可信，
// 当 total>0 时 count 字段可用，否则退回 percent。Cookie 路径 /coding_plan/remains 已停用。
// 这里读 MINIMAX_CN_API_KEY（credentials.yaml 中用户已填），如需全球版加 MINIMAX_GLOBAL_API_KEY。
// weeklyHourlyRatio = 周限额相当于多少个 5h 限额（用户描述为 10：1，可在 config.json 覆盖）
const MINIMAX_WEEKLY_HOURLY_RATIO = Number(cfg('minimaxWeeklyHourlyRatio', 10)) || 10;
let minimaxCache = { data: null, at: 0 };
const MINIMAX_CACHE_MS = 60 * 1000;

function getMiniMaxKey() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    // 优先匹配中国版专用 key，其次通用 key（兼容用户使用同一 key 或配置其他变体）
    const m = raw.match(/MINIMAX_CN_API_KEY:\s*["']?(sk-[^\s"']+)/)
           || raw.match(/MINIMAX_API_KEY:\s*["']?(sk-[^\s"']+)/)
           || raw.match(/MINIMAX_GLOBAL_API_KEY:\s*["']?(sk-[^\s"']+)/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function epochSeconds(v) {
  // 自动判别秒/毫秒（阈值 1e9/1e12）
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

function parseMiniMaxModelRemains(entry) {
  // entry 来自 model_remains 数组单条；同时含 5h + 周两组字段
  const result = { '5h': null, week: null };
  const endSec5h = epochSeconds(entry.end_time);
  const endSecWeek = epochSeconds(entry.weekly_end_time);
  const minutes5h = entry.start_time && endSec5h ? Math.round((endSec5h - epochSeconds(entry.start_time)) / 60) : null;
  const minutesWeek = entry.weekly_start_time && endSecWeek ? Math.round((endSecWeek - epochSeconds(entry.weekly_start_time)) / 60) : null;

  function buildWindow(minutes, endSec, total, usage, percent) {
    // 优先用 percent（中国版是「剩余百分比」，与国际版语义一致——已用 = 100 - percent）；
    // count 字段仅在 total>0 时才有可信语义（usage_count 在某些站点是已用、某些是剩余，跨站点不一致）。
    let remainingPct = null, usedPct = null, totalVal = null;
    if (Number.isFinite(Number(percent))) {
      const p = Math.max(0, Math.min(100, Number(percent)));
      remainingPct = Math.round(p * 10) / 10;
      usedPct = Math.round((100 - p) * 10) / 10;
    }
    if (Number(total) > 0 && Number.isFinite(Number(usage))) {
      totalVal = Number(total);
    }
    return {
      total: totalVal,
      remainingPct,
      usedPct,
      windowMinutes: minutes,
      resetAt: endSec || null,
    };
  }

  result['5h'] = buildWindow(
    minutes5h, endSec5h,
    entry.current_interval_total_count, entry.current_interval_usage_count,
    entry.current_interval_remaining_percent
  );
  result.week = buildWindow(
    minutesWeek, endSecWeek,
    entry.current_weekly_total_count, entry.current_weekly_usage_count,
    entry.current_weekly_remaining_percent
  );
  if (result['5h'] && result['5h'].remainingPct === null) result['5h'] = null;
  if (result.week && result.week.remainingPct === null) result.week = null;
  return result;
}

function queryMiniMaxCodingPlan() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (minimaxCache.data && now - minimaxCache.at < MINIMAX_CACHE_MS) {
      resolve(minimaxCache.data);
      return;
    }
    const key = getMiniMaxKey();
    if (!key) {
      resolve({ ok: false, error: '未找到 MINIMAX_CN_API_KEY' });
      return;
    }
    const req = httpsRequest('api.minimaxi.com', '/v1/token_plan/remains', {
      headers: {
        Authorization: 'Bearer ' + key,
        accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeoutMs: 15000,
    });
    req.then((parsed) => {
      // 响应形如 { model_remains: [...], base_resp: {...} } —— 没有嵌套 data；
      // 兼容旧形态（整对象再包一层 data）
      const container = (parsed && parsed.data && (parsed.data.model_remains || parsed.data.base_resp)) ? parsed.data : parsed;
      const topResp = container.base_resp || (parsed && parsed.base_resp);
      if (topResp && Number(topResp.status_code) !== 0) {
        const msg = topResp.status_msg || ('status_code ' + topResp.status_code);
        const data = { ok: false, error: 'API: ' + msg };
        minimaxCache = { data, at: now };
        resolve(data);
        return;
      }
      const modelRemains = Array.isArray(container.model_remains) ? container.model_remains : [];
      // 取首个 model_remains（多数 plan 只有一条；多条时取第一个含 5h+周双窗口的）
      const windows = { '5h': null, week: null };
      for (const entry of modelRemains) {
        const r = parseMiniMaxModelRemains(entry);
        if (!windows['5h'] && r['5h']) windows['5h'] = r['5h'];
        if (!windows.week && r.week) windows.week = r.week;
        if (windows['5h'] && windows.week) break;
      }
      const planName = container.current_subscribe_title || container.plan_name
        || container.combo_title || container.current_plan_title
        || (container.current_combo_card && container.current_combo_card.title) || null;
      const result = {
        ok: true,
        planName: planName ? String(planName).trim() : null,
        modelName: (modelRemains[0] && (modelRemains[0].modelName || modelRemains[0].model_name)) || null,
        windows,
        modelCount: modelRemains.length,
        weeklyHourlyRatio: MINIMAX_WEEKLY_HOURLY_RATIO,
        updatedAt: now,
      };
      minimaxCache = { data: result, at: now };
      resolve(result);
    }).catch((err) => {
      resolve({ ok: false, error: err.message });
    });
  });
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
// 启动加载状态：true = 加载失败（文件存在但解析异常 / TDZ / 解析结果非数组）；false = 正常或文件不存在。
// 加载失败时必须拒绝 saveBookmarks 写入——否则内存空数组会把原文件覆盖为 []。
// 真实事故（v1 升级期）：MODE_HIDDEN_SENTINEL TDZ → catch 兜底 → 内存 [] → 用户测试触发
// POST+DELETE → saveBookmarks 覆盖原文件 → 书签全部丢失。详见 DEV §8 2026-08-19 + §0 第 9 条铁律。
let bookmarksLoadFailed = false;
let bookmarks = [];
try {
  if (fs.existsSync(BOOKMARKS_PATH)) {
    const raw = fs.readFileSync(BOOKMARKS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // 旧数据无 mode 字段 → 补 null（全部模式可见，与先前行为一致；向后兼容）
      bookmarks = parsed.map((b) => ({
        ...b,
        mode: (b && 'mode' in b) ? normalizeModeField(b.mode) : null,
      }));
    } else {
      // 文件存在但不是数组（结构损坏）→ 备份原文件 + 标记失败
      backupCorruptedData(BOOKMARKS_PATH, 'parsed value is not an array');
      bookmarksLoadFailed = true;
    }
  }
  // 文件不存在 = 全新安装，正常空状态，不算失败
} catch (e) {
  console.error('读取 bookmarks.json 失败:', e.message);
  backupCorruptedData(BOOKMARKS_PATH, e.message);
  bookmarksLoadFailed = true;
}

function saveBookmarks() {
  if (bookmarksLoadFailed) {
    // 加载失败时拒绝写入：宁可服务不可写，也不让空数组覆盖原文件。
    // 恢复路径：手动从 bookmarks.json.bak 恢复内容到 bookmarks.json，然后重启服务。
    console.error('[FATAL] 拒绝写入 bookmarks.json：启动加载失败，备份在 ' + BOOKMARKS_PATH + '.bak。请手动检查并从 .bak 恢复后重启服务。');
    return false;
  }
  try {
    fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2), 'utf8');
  } catch (e) {
    console.error('写入 bookmarks.json 失败:', e.message);
  }
}

// ---- 投资计算器：当前持仓 + 目标权重加载 ----
// invest-holdings.json 是用户当前持仓（4 个标的的金额）+ lastRebalance 日期。本机专属（D050），不入库。
// 加载失败保护与 bookmarks 同款（v1.1 教训）：宁可拒绝写入，也不让内存空对象覆盖原文件。
// 注意：D050 隔离 + v1.1 TDZ 教训，常量必须在加载段之前声明（bookmarks 的灾难就是 const 晚于 let 导致 TDZ）。
const HOLDINGS_PATH = path.join(ROOT, 'invest-holdings.json');
const INVEST_PERSONAL_PATH = path.join(ROOT, 'invest-personal.json');
// ---- 投资个人配置默认（缺字段/全新安装时使用） ----
// 目标权重：方案 B（均衡型 25/20/25/30）——投资-personal.json 的 targets 字段之和不=100 时也回退到这套
const DEFAULT_INVEST_CONFIG = {
  targets: {
    '红利低波50': 25,
    '沪港深成长红利低波动': 20,
    '中证全指': 25,
    '纳斯达克100': 30,
  },
  dailyPerWorkday: 100,        // 预计每个工作日定投金额（元；用户设置）
  workdays: [1, 2, 3, 4, 5],   // 工作日定义（周日=0；默认周一到周五）
  showSellInRebalance: true,   // 是否在视图显示"推荐卖出"（用户 v3 反馈：卖出需要挑时间所以默认显示，但允许关掉）
};
let holdingsLoadFailed = false;
let holdings = { holdings: {}, lastRebalance: null };
try {
  if (fs.existsSync(HOLDINGS_PATH)) {
    const raw = fs.readFileSync(HOLDINGS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // 旧数据无 lastRebalance → null；holdings 字段必须为对象
      holdings = {
        holdings: (parsed.holdings && typeof parsed.holdings === 'object' && !Array.isArray(parsed.holdings))
          ? parsed.holdings
          : {},
        lastRebalance: (typeof parsed.lastRebalance === 'string') ? parsed.lastRebalance : null,
      };
    } else {
      // 文件存在但不是对象（结构损坏）→ 备份 + 标记失败
      backupCorruptedData(HOLDINGS_PATH, 'parsed value is not an object');
      holdingsLoadFailed = true;
    }
  }
  // 文件不存在 = 全新安装，正常空状态，不算失败
} catch (e) {
  console.error('读取 invest-holdings.json 失败:', e.message);
  backupCorruptedData(HOLDINGS_PATH, e.message);
  holdingsLoadFailed = true;
}

function saveHoldings() {
  if (holdingsLoadFailed) {
    console.error('[FATAL] 拒绝写入 invest-holdings.json：启动加载失败，备份在 ' + HOLDINGS_PATH + '.bak。请手动检查并从 .bak 恢复后重启服务。');
    return false;
  }
  try {
    fs.writeFileSync(HOLDINGS_PATH, JSON.stringify(holdings, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('写入 invest-holdings.json 失败:', e.message);
    return false;
  }
}

// ---- 投资个人配置（invest-personal.json：targets / dailyPerWorkday / workdays） ----
// 三字段合一：目标权重（必须和=100，容差±0.5）+ 预计每个工作日定投额（默认 100 元）+ 工作日定义（默认 [1,2,3,4,5]，周日=0）
// 加载失败保护与 holdings 同款：备份为 .bak + 拒写入（v1.1 教训扩展——D050 防护扩到所有用户数据文件）。
let investConfigLoadFailed = false;
let investConfig = { ...DEFAULT_INVEST_CONFIG };
try {
  if (fs.existsSync(INVEST_PERSONAL_PATH)) {
    const raw = fs.readFileSync(INVEST_PERSONAL_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // targets: 4 个标的百分比之和必须 = 100（容差 ±0.5）——不达标则用默认
      let targets = DEFAULT_INVEST_CONFIG.targets;
      if (parsed.targets && typeof parsed.targets === 'object') {
        const sum = Object.values(parsed.targets).reduce((s, v) => s + Number(v), 0);
        if (Math.abs(sum - 100) < 0.5) {
          targets = parsed.targets;
        } else {
          console.error('invest-personal.json targets 之和 = ' + sum + ' ≠ 100，使用默认目标');
        }
      }
      // dailyPerWorkday: 数字 ≥0；非法回退默认
      const dailyPerWorkday = (typeof parsed.dailyPerWorkday === 'number' && parsed.dailyPerWorkday >= 0)
        ? parsed.dailyPerWorkday
        : DEFAULT_INVEST_CONFIG.dailyPerWorkday;
      // workdays: 0-6 整数数组；非法项过滤后空则用默认
      const wd = Array.isArray(parsed.workdays)
        ? parsed.workdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
      const workdays = wd.length ? wd : DEFAULT_INVEST_CONFIG.workdays;
      // showSellInRebalance: 布尔；缺省 true（旧数据无此字段 → 默认显示卖出建议）
      const showSellInRebalance = typeof parsed.showSellInRebalance === 'boolean'
        ? parsed.showSellInRebalance
        : DEFAULT_INVEST_CONFIG.showSellInRebalance;
      investConfig = { targets, dailyPerWorkday, workdays, showSellInRebalance };
    } else {
      backupCorruptedData(INVEST_PERSONAL_PATH, 'parsed value is not an object');
      investConfigLoadFailed = true;
    }
  }
  // 文件不存在 = 全新安装，使用默认；不算失败（不设 LoadFailed）
} catch (e) {
  console.error('读取 invest-personal.json 失败:', e.message);
  backupCorruptedData(INVEST_PERSONAL_PATH, e.message);
  investConfigLoadFailed = true;
}

function saveInvestConfig() {
  if (investConfigLoadFailed) {
    console.error('[FATAL] 拒绝写入 invest-personal.json：启动加载失败，备份在 ' + INVEST_PERSONAL_PATH + '.bak。请手动检查并从 .bak 恢复后重启服务。');
    return false;
  }
  try {
    // 保留其它字段（如 sections 描述）；只覆盖我们要管的 3 个字段
    let existing = {};
    try {
      const raw = fs.readFileSync(INVEST_PERSONAL_PATH, 'utf8').replace(/^\uFEFF/, '');
      existing = JSON.parse(raw) || {};
    } catch { /* 文件已被备份但内存空对象也要写回 */ }
    const next = {
      ...existing,
      targets: investConfig.targets,
      dailyPerWorkday: investConfig.dailyPerWorkday,
      workdays: investConfig.workdays,
    };
    fs.writeFileSync(INVEST_PERSONAL_PATH, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('写入 invest-personal.json 失败:', e.message);
    return false;
  }
}

// 向后兼容：旧 loadTargets() 改为包装器（POST /api/invest-calc/holdings 等仍调用）
// 返回 in-memory 状态（启动时已加载 + POST /api/invest-calc/config 时同步更新）
function loadTargets() {
  return investConfig.targets;
}

// ---- 投资计算器辅助函数 ----

// 再平衡方案（v3.3 重做）：把"卖出"和"买入"作为完整方案同时计算
//   卖出（可选）：每个超配资产卖回到目标值（基于当前 total）
//   买入：偏离弥补定投法——每日固定总额（= dailyPerWorkday）按"缺口"比例分配给低配标的；
//     缺口 = max(0, 目标金额 - 当前金额)，只算低配资产，缺口越大分得越多；
//     超配资产（含偏离特别大的）直接 0；全部不缺（Σ缺口=0）时回退按目标权重分配（照常定投）。
//   关键点（用户 v3.3 反馈）：每日定投就是"每天真的就一共投 dailyPerWorkday 那么多"，
//     不做"基础按权重 + 低配按差额补仓"的超额加码——所以买入合计必须 === dailyPerWorkday。
//     偏离靠每日定投自动弥补，不推荐一次性大额买入。
//   卖出区仍显示"卖出后总市值"（用户挑时间卖）；买入按当前 total 算缺口，不依赖是否真卖出。
//   返回 { showSellInRebalance, sells, totalSell, buys, totalBuy, postSellTotal }
//     sells: [{asset, amount}]    超配资产卖出金额
//     buys: [{asset, amount}]     每个工作日买入金额（合计 === dailyPerWorkday）
function computeRebalancePlan({ rows, total, dailyPerWorkday, workdays, showSellInRebalance }) {
  const sells = [];
  let postSellTotal = total;
  if (showSellInRebalance) {
    // 1. 计算卖出（每个超配资产卖回到目标值——基于当前 total）
    for (const r of rows) {
      if (Number(r.deviation) > 0) {
        const targetAmount = total * (Number(r.target) || 0) / 100;
        const sellAmount = r.amount - targetAmount;
        if (sellAmount > 0) {
          sells.push({ asset: r.name, amount: Math.round(sellAmount) });
        }
      }
    }
    postSellTotal = total - sells.reduce((s, a) => s + a.amount, 0);
  }
  // 2. 计算每日买入（v3.3：固定总额按缺口比例分配——偏离弥补定投法）
  const daily = Math.max(0, Number(dailyPerWorkday) || 0);
  let allocWeights = rows.map((r) => {
    if (total > 0) {
      const targetAmount = total * (Number(r.target) || 0) / 100;
      return Math.max(0, targetAmount - r.amount);
    }
    return 0;
  });
  const weightSum = allocWeights.reduce((s, v) => s + v, 0);
  if (weightSum <= 0) {
    // 全部不缺（无持仓 / 刚再平衡 / 全部达标）：回退按目标权重分配，照常定投
    allocWeights = rows.map((r) => Number(r.target) || 0);
  }
  const allocSum = allocWeights.reduce((s, v) => s + v, 0);
  // 最大余数法：把 daily 整数金额摊到各标的，保证合计 === daily
  const raw = allocWeights.map((w, i) => ({
    i,
    w,
    amount: allocSum > 0 ? Math.floor(daily * w / allocSum) : 0,
    frac: allocSum > 0 ? (daily * w / allocSum) - Math.floor(daily * w / allocSum) : 0,
  }));
  let remaining = daily - raw.reduce((s, b) => s + b.amount, 0);
  const order = raw.slice().sort((a, b) => b.frac - a.frac);
  for (const b of order) {
    if (remaining <= 0) break;
    if (b.w <= 0) continue; // 超配/零权重标的绝不分余数
    b.amount += 1;
    remaining -= 1;
  }
  const buys = raw.map((b) => ({ asset: rows[b.i].name, amount: b.amount }));
  return {
    showSellInRebalance,
    sells,
    totalSell: Math.round(sells.reduce((s, a) => s + a.amount, 0)),
    buys,
    totalBuy: daily,
    postSellTotal: Math.round(postSellTotal),
  };
}

// 软约束警告（编辑模式下用——只是文字警告，不阻断保存）
//   nasdaqOver: 纳指 > 40%（绝对 %）
//   redDuoOver: 红利低波50 + 沪港深成长红利低波动 > 45%（绝对 %，分散性不足）
//   任何字段缺失/为 0 都视为不触发
function computeWarnings(targets) {
  const warnings = [];
  const nasdaq = Number(targets['纳斯达克100']) || 0;
  if (nasdaq > INVEST_WARN_NASDAQ_MAX) {
    warnings.push({
      type: 'nasdaq_over',
      message: '纳指占比 ' + nasdaq + '% 超过建议上限 ' + INVEST_WARN_NASDAQ_MAX + '%，赌注过大',
      level: 'warn',
    });
  }
  const red1 = Number(targets['红利低波50']) || 0;
  const red2 = Number(targets['沪港深成长红利低波动']) || 0;
  const redSum = red1 + red2;
  if (redSum > INVEST_WARN_RED_DUO_MAX) {
    warnings.push({
      type: 'red_duo_over',
      message: '双红利低波合计 ' + redSum + '% 超过建议上限 ' + INVEST_WARN_RED_DUO_MAX + '%，分散性不足',
      level: 'warn',
    });
  }
  return warnings;
}

// ---- 系统信息卡 mode 持久化（syscards-state.json：8 张内置信息卡的 mode 字段）----
// 存储路径常量 + 初始化见 normalizeModeField 之后的「系统卡 mode」段。
// SYS_CARDS 是 app.js 内置的（keyed 渲染复用 DOM），无 buttons.json 这种配置文件；
// 用户在「模式管理区」给每张系统卡配 mode 后，需要服务端持久化 + 启动时回填到前端 SYS_CARDS。
// 字段语义与 bookmarks/feeds 同款：null = 全部模式可见；字符串 = 单模式；数组 = 多模式；'__hidden__' = 隐藏。
const SYSCARDS_PATH = path.join(ROOT, 'syscards-state.json');
// ---- RSS 订阅源（信息卡：用户自配 RSS/Atom 源，持久化到 feeds.json）----
// 注意：MODES_PATH / DEFAULT_MODES / MODES 加载逻辑已上移至 file 顶部「模式处理基础设施」块，
// 原因：bookmarks.json 加载段调用 normalizeModeField 时 MODES 尚未初始化 → TDZ → 书签数据丢失。
// 见 DEV §8 2026-08-19 条目 + §0 第 9 条铁律。

// ---- 模式定义 / 工具函数基础设施已上移至 file 顶部「模式处理基础设施」块（line 64 附近）----
// 原本段代码（MODES_PATH / DEFAULT_MODES / MODES 加载 + MODE_HIDDEN_SENTINEL / isValidModeId / normalizeModeField）
// 已统一上移，确保 bookmarks/feeds/syscards 加载段调用 normalizeModeField 时全部就绪。
// TDZ 静默 fallback 事故见 DEV §8 2026-08-19 条目 + §0 第 9 条铁律。

// ---- 系统信息卡 mode 持久化（syscards-state.json：8 张内置信息卡的 mode 字段）----
// SYS_CARDS 是 app.js 内置的（keyed 渲染复用 DOM），无 buttons.json 这种配置文件；
// 用户在「模式管理区」给每张系统卡配 mode 后，需要服务端持久化 + 启动时回填到前端 SYS_CARDS。
// 字段语义与 bookmarks/feeds 同款：null = 全部模式可见；字符串 = 单模式；数组 = 多模式；'__hidden__' = 隐藏。
// SYS_CARDS_WHITELIST 的 id 必须与 app.js 的 SYS_CARDS key 完全对齐（前后端硬约定）。
const SYS_CARDS_WHITELIST = [
  'sys-balance',
  'sys-status',
  'sys-dsh-sessions',
  'sys-bookmarks',
  'sys-dida-today',
  'sys-dida-focus',
  'sys-minimax',
  'sys-rss',
  // 投资方案卡（v2 重做后：仅 1 个投资计算器；硬约束删除，警告搬进计算器设置面板）
  'sys-invest-calc',
];
// 系统卡的展示名（与 app.js SYS_CARDS.name 对齐；用于模式管理区行展示）
const SYS_CARD_DISPLAY_NAMES = {
  'sys-balance':      'DeepSeek 余额',
  'sys-status':       '系统状态',
  'sys-dsh-sessions': 'DSH 对话',
  'sys-bookmarks':    '书签',
  'sys-dida-today':   '滴答今日任务',
  'sys-dida-focus':   '滴答专注',
  'sys-minimax':      'MiniMax 套餐',
  'sys-rss':          'RSS 订阅',
  'sys-invest-calc':      '投资计算器',
};
// 投资方案卡数据文件映射（id → JSON 文件名；白名单 + 固定文件名双重防路径遍历）
// v2 重做后已无 invest-info 类卡；invest-personal.json 改为计算器 config 源（由 INVEST_PERSONAL_PATH 直接读取，不经此映射）
const INVEST_FILES = {};
// 阈值常量（与原 invest-cadence.json §再平衡方案 + §5 条硬约束 对齐）
const INVEST_THRESHOLD_NORMAL = 5;   // 触发季度再平衡的偏差（绝对 %）
const INVEST_THRESHOLD_EMERG = 10;   // 触发立即再平衡的偏差（绝对 %）
const INVEST_FORCE_MONTHS = 6;       // 距上次再平衡满 N 个月强制再平衡
// 软约束阈值（编辑模式下标红警告，不阻止保存；v2 设计：硬约束卡删除，警告搬进设置面板）
const INVEST_WARN_NASDAQ_MAX = 40;          // 纳指占比建议上限（> 即警告）
const INVEST_WARN_RED_DUO_MAX = 45;          // 双红利低波合计建议上限（> 即警告，分散性不足）
let syscardModes = {};  // id -> normalizeModeField 后的 mode 字段（启动时从文件读；旧数据缺省视为 null）
try {
  if (fs.existsSync(SYSCARDS_PATH)) {
    const raw = fs.readFileSync(SYSCARDS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const id of SYS_CARDS_WHITELIST) {
        const v = parsed[id];
        syscardModes[id] = (v !== undefined) ? normalizeModeField(v) : null;
      }
    }
  }
  // 旧文件缺失 / 解析失败 / 是数组 → 全部置 null（向后兼容：默认全部模式可见）
  for (const id of SYS_CARDS_WHITELIST) {
    if (!(id in syscardModes)) syscardModes[id] = null;
  }
} catch (e) {
  console.error('读取 syscards-state.json 失败，使用内置默认:', e.message);
  for (const id of SYS_CARDS_WHITELIST) syscardModes[id] = null;
}

function saveSysCards() {
  try {
    fs.writeFileSync(SYSCARDS_PATH, JSON.stringify(syscardModes, null, 2), 'utf8');
  } catch (e) {
    console.error('写入 syscards-state.json 失败:', e.message);
  }
}

const FEEDS_PATH = path.join(ROOT, 'feeds.json');
const RSS_CACHE_MS = 15 * 60 * 1000; // 单源缓存 15 分钟（源不会变得更快，避免频繁抓取）
const RSS_MAX_ITEMS = 8;             // 每源最多条数（卡片展示用，多了没意义）
const RSS_MAX_FEEDS = 12;            // 最多订阅源数（防止配置爆炸）

let rssFeeds = [];
try {
  if (fs.existsSync(FEEDS_PATH)) {
    const raw = fs.readFileSync(FEEDS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // 旧订阅源无 mode 字段 → 补 null（全部模式可见）
      rssFeeds = parsed.map((f) => ({
        ...f,
        mode: (f && 'mode' in f) ? normalizeModeField(f.mode) : null,
      }));
    }
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
    // fresh clone 没有 public/icons/ 目录时 PS 脚本会 DirectoryNotFound（真实踩过：
    // 本机目录一直存在从未暴露）。先确保目录存在，建目录失败不致命、走回退。
    try { if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'extract-app-icon.ps1'), target, outIco,
    ], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outIco)));
  });
}

// 解析 .lnk 快捷方式的 TargetPath（供徽章做进程检测；UWP 等解析不出的返回 null）
// 路径经环境变量传入、输出强制 UTF-8：中文路径（滴答清单等）经命令行参数/默认
// 代码页往返都会乱码，env + OutputEncoding 双向都稳。
function resolveLnkTarget(target) {
  return new Promise((resolve) => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output (New-Object -ComObject WScript.Shell).CreateShortcut($env:WB_LNK).TargetPath';
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      env: Object.assign({}, process.env, { WB_LNK: target }),
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const t = out.trim();
      resolve(t || null);
    });
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
// 一次 tasklist 全量快照缓存 1 秒：一轮 /api/buttons 里多个进程按钮共用，
// 不再每个按钮各起一个 tasklist。cmd 里先 chcp 65001：tasklist 输出跟随
// 控制台代码页（默认 GBK），中文进程名（滴答清单等）必须切 UTF-8 才能比对。
// 前缀匹配与 launch-app.ps1 的 Get-Process 通配保持一致：实际进程名可能带
// 后缀（如 Reasonix.exe 运行时叫 reasonix-desktop.exe），精确匹配会永远
// 误报"已停止"，进而出现"徽章显示没运行、点击却只是激活不启动"的矛盾。
let procSnapshot = { at: 0, names: [] };

function getProcessNames() {
  return new Promise((resolve) => {
    if (Date.now() - procSnapshot.at < 1000) return resolve(procSnapshot.names);
    const child = spawn('cmd.exe', ['/d', '/c', 'chcp 65001 >nul & tasklist /fo csv /nh'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => resolve(procSnapshot.names));
    child.on('close', () => {
      const names = [];
      for (const line of out.split(/\r?\n/)) {
        const m = /^"(.+?\.exe)"/i.exec(line.trim());
        if (m) names.push(m[1].slice(0, -4).toLowerCase());
      }
      procSnapshot = { at: Date.now(), names };
      resolve(names);
    });
  });
}

function isProcessRunning(name) {
  if (!name) return Promise.resolve(null);
  const want = String(name).toLowerCase().replace(/\.exe$/, '');
  return getProcessNames().then((names) => names.some((n) => n.startsWith(want)));
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

// ---- DSH 会话状态聚合（前端 /api/dsh-sessions）v0.6.2 ----
// 调用 DSH 3080 `session.list` 拿所有 sessions，聚合运行/待确认状态。
// 状态语义：
//   - 3080 不可达 → status='offline'
//   - 调用成功但列表为空 → status='idle' / running=0 / total=0
//   - 任意 session.running=true → status='working' / running=N / total=M
//   - 全部 running=false → status='idle' / running=0 / total=M
//   - 调用失败 / 解析失败 → status='error'
// 前端轮询 5 秒（与 push 卡片同款节奏），状态变化时卡片亮：
//   working=琥珀脉冲（转圈） / idle=无显示 / offline=无显示 / error=无显示
//   pending = running=false & plan.pending=true & !blank（极少见）
//   error / ask_user_question 等状态不在 session.list API → 技术限制无法暴露
// 历史：v0.6 三态（working/unread/pending）→ v0.6.2 移除 unread（用户反馈"不实用"）

function classifySessions(list) {
  const running = list.filter((s) => s && s.running === true);
  const nonRunning = list.filter((s) => s && s.running !== true);
  const total = list.length;

  // 待确认：plan 模式写完计划等待用户接受（极少见；plan.pending=true 且非 running）
  const pending = nonRunning.filter((s) => {
    if (s.blank === true) return false;
    const proj = (s.projections && s.projections.values) || {};
    return proj.plan && proj.plan.pending === true;
  });

  return { running, pending, total };
}

async function fetchDshSessions() {
  try {
    const resp = await callDshApi('session.list', {}, 5000);
    // DSH 协议：callDshApi 解析的是 result.value；DSH 3080 实际返回 { items: [...] }
    const list = (resp && resp.items) ? resp.items : (Array.isArray(resp) ? resp : []);
    const cls = classifySessions(list);
    const running = cls.running.length;
    // 取出当前正在工作的 session 摘要（id + title + cwd）→ 前端 hover 看详情
    const active = cls.running.slice(0, 5).map((s) => ({
      sessionId: s.sessionId,
      title: (s.projections && s.projections.values && s.projections.values.title) || null,
      cwd: s.cwd || null,
      updatedAt: s.updatedAt || null,
    }));
    // 待确认会话标题（最多 5 个）
    const pendingSample = cls.pending.slice(0, 5).map((s) => ({
      sessionId: s.sessionId,
      title: (s.projections && s.projections.values && s.projections.values.title) || null,
      cwd: s.cwd || null,
    }));
    return {
      ok: true,
      status: running > 0 ? 'working' : 'idle',
      running,
      total: cls.total,
      pendingCount: cls.pending.length,
      active,
      pending: pendingSample,
    };
  } catch (e) {
    // 3080 不可达 / API 错误 → 区分 offline vs error
    const offline = String(e.message || '').includes('ECONNREFUSED') || String(e.message || '').includes('ECONNRESET');
    return {
      ok: false,
      status: offline ? 'offline' : 'error',
      error: e.message,
      running: 0,
      total: 0,
      pendingCount: 0,
      active: [],
      pending: [],
    };
  }
}

// ---- dida365 MCP 客户端（今日任务信息卡）----
// 凭据从 DSH profile 的 cordis.patch.yml 读取（Bearer token），避免硬编码。
const DIDA_MCP_URL = 'https://mcp.dida365.com';
const DIDA_MCP_CONFIG = cfg('didaMcpConfig', ''); // 滴答 MCP Bearer token 所在的 cordis.patch.yml（config.json 配置）

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

// ---- Push 卡片流程：在 Anki 工作目录创建新对话并发送 "push anki 卡片" ----
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
    const created = await callDshApi('session.create', { cwd: cfg('pushCwd', DIDA_DEFAULT_CWD) });
    const sessionId = created.sessionId;
    entry.sessionId = sessionId;
    const prompted = await callDshApi('session.prompt', {
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'push anki 卡片' }],
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

  // 模式定义（modes.json 透传，前端用白名单校验 + 渲染切换器）
  if (p === '/api/modes' && req.method === 'GET') {
    return json(res, MODES);
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

  // DSH 会话状态聚合（feedback 2：DSH 对话状态变化指示）
  if (p === '/api/dsh-sessions' && req.method === 'GET') {
    const data = await fetchDshSessions();
    return json(res, data);
  }

  // MiniMax 编程套餐额度（5h 窗口 + 周窗口）
  if (p === '/api/minimax-coding-plan' && req.method === 'GET') {
    const data = await queryMiniMaxCodingPlan();
    return json(res, data);
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
    return json(res, { bookmarks, loadFailed: bookmarksLoadFailed });
  }

  // 新增书签
  if (p === '/api/bookmarks' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { name, url, mode } = JSON.parse(body);
      if (!name || !url) return json(res, { ok: false, error: '名字和网址都不能为空' }, 400);
      // mode 字段：null / 字符串 / 数组；非法值回退到 null（全部模式可见）
      const normMode = normalizeModeField(mode);
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        url,
        mode: normMode,
        createdAt: Date.now(),
      };
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

  // PATCH /api/bookmarks/<id>：编辑现有书签（name / url / mode 字段可选）
  // 字段规范化：mode 走 normalizeModeField（与服务端 normalizeRule 一致），非法 id 静默回退 null
  if (p.startsWith('/api/bookmarks/') && req.method === 'PATCH') {
    const id = decodeURIComponent(p.slice('/api/bookmarks/'.length));
    const idx = bookmarks.findIndex((b) => b.id === id);
    if (idx < 0) return json(res, { ok: false, error: '书签不存在' }, 404);
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const patch = JSON.parse(body) || {};
      const cur = bookmarks[idx];
      // name 缺省保留；非空字符串才覆盖
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        if (typeof patch.name !== 'string' || !patch.name.trim()) {
          return json(res, { ok: false, error: '名称不能为空' }, 400);
        }
        cur.name = patch.name.trim();
      }
      // url 缺省保留；非空字符串才覆盖
      if (Object.prototype.hasOwnProperty.call(patch, 'url')) {
        if (typeof patch.url !== 'string' || !patch.url.trim()) {
          return json(res, { ok: false, error: '网址不能为空' }, 400);
        }
        cur.url = patch.url.trim();
      }
      // mode 字段：显式 patch 才覆盖（保留 null=全部模式可见 / 字符串=单模式 / 数组=多模式）
      if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
        cur.mode = normalizeModeField(patch.mode);
      }
      bookmarks[idx] = cur;
      saveBookmarks();
      return json(res, { ok: true, bookmark: cur });
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
  }

  // RSS 订阅源列表（设置面板管理用）
  if (p === '/api/feeds' && req.method === 'GET') {
    return json(res, { feeds: rssFeeds.map((f) => ({ id: f.id, name: f.name, url: f.url, mode: f.mode != null ? f.mode : null })) });
  }

  // 新增 RSS 订阅源 {name, url, mode?}
  if (p === '/api/feeds' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { name, url, mode } = JSON.parse(body);
      const clean = (url || '').trim();
      const cleanName = (name || '').trim();
      if (!cleanName || !clean) return json(res, { ok: false, error: '名称和地址都不能为空' }, 400);
      if (!/^https?:\/\/\S+$/i.test(clean)) return json(res, { ok: false, error: '地址必须以 http:// 或 https:// 开头' }, 400);
      if (rssFeeds.some((f) => f.url === clean)) return json(res, { ok: false, error: '该地址已添加过' }, 400);
      if (rssFeeds.length >= RSS_MAX_FEEDS) return json(res, { ok: false, error: '最多 ' + RSS_MAX_FEEDS + ' 个订阅源' }, 400);
      const normMode = normalizeModeField(mode);
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: cleanName.slice(0, 30),
        url: clean.slice(0, 500),
        mode: normMode,
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

  // PATCH /api/feeds/<id>：编辑现有 RSS 订阅源（v5 feedback 3：模式管理区的 RSS 行 inline 编辑 mode）
  // 字段语义与 PATCH /api/bookmarks/<id> 同款：name / url / mode 字段可选保留
  // mode 字段走 normalizeModeField 校验（null / 字符串 / 数组）
  if (p.startsWith('/api/feeds/') && req.method === 'PATCH') {
    const id = decodeURIComponent(p.slice('/api/feeds/'.length));
    const idx = rssFeeds.findIndex((f) => f.id === id);
    if (idx < 0) return json(res, { ok: false, error: '订阅源不存在' }, 404);
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const patch = JSON.parse(body) || {};
      const cur = rssFeeds[idx];
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        if (typeof patch.name !== 'string' || !patch.name.trim()) {
          return json(res, { ok: false, error: '名称不能为空' }, 400);
        }
        cur.name = patch.name.trim().slice(0, 30);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'url')) {
        if (typeof patch.url !== 'string' || !patch.url.trim()) {
          return json(res, { ok: false, error: '地址不能为空' }, 400);
        }
        if (!/^https?:\/\/\S+$/i.test(patch.url.trim())) {
          return json(res, { ok: false, error: '地址必须以 http:// 或 https:// 开头' }, 400);
        }
        cur.url = patch.url.trim().slice(0, 500);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
        cur.mode = normalizeModeField(patch.mode);
      }
      rssFeeds[idx] = cur;
      saveFeeds();
      return json(res, { ok: true, feed: cur });
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
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
      // 进程徽章：.exe 直接用文件名；.lnk 解析出真实目标 exe 再配
      // （解析失败如 UWP 快捷方式则无徽章，不影响点击功能）
      let processName = null;
      if (ext === '.exe') {
        processName = baseName.toLowerCase() + '.exe';
      } else if (ext === '.lnk') {
        const realTarget = await resolveLnkTarget(clean);
        if (realTarget && /\.exe$/i.test(realTarget)) {
          processName = path.basename(realTarget).toLowerCase();
        }
      }
      if (processName) btn.process = processName;
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
      const { id, color, size, mode } = JSON.parse(body);
      if (!id) return json(res, { ok: false, error: '缺少按钮 id' }, 400);
      const list = loadButtons();
      const btn = list.find(b => b.id === id);
      if (!btn) return json(res, { ok: false, error: '按钮不存在: ' + id }, 404);
      if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) return json(res, { ok: false, error: '颜色格式不正确' }, 400);
      if (size !== undefined && size !== 'small' && size !== 'wide') return json(res, { ok: false, error: '尺寸只能是 small 或 wide' }, 400);
      if (color) btn.color = color;
      if (size) btn.size = size;
      // mode 字段：null = 全部模式可见；字符串 = 单模式；数组 = 多模式（normalizeModeField 兜底非法值）
      if (mode !== undefined) btn.mode = normalizeModeField(mode);
      saveButtonsFile(list);
      return json(res, { ok: true });
    } catch (e) {
      return json(res, { ok: false, error: '更新失败: ' + e.message }, 400);
    }
  }

  // 系统信息卡 mode：返回 8 张内置系统卡的当前 mode（供「模式管理区」展示 + renderGrid 过滤）
  if (p === '/api/syscards' && req.method === 'GET') {
    const cards = SYS_CARDS_WHITELIST.map((id) => ({
      id,
      name: SYS_CARD_DISPLAY_NAMES[id] || id,
      mode: syscardModes[id] != null ? syscardModes[id] : null,
    }));
    return json(res, { cards });
  }

  // PATCH /api/syscards/<id>：更新某张系统卡的 mode（字段语义与 PATCH bookmarks/feeds 同款）
  // 仅接受白名单内的 id；非法 mode id 走 normalizeModeField 静默回退 null
  if (p.startsWith('/api/syscards/') && req.method === 'PATCH') {
    const id = decodeURIComponent(p.slice('/api/syscards/'.length));
    if (!SYS_CARDS_WHITELIST.includes(id)) {
      return json(res, { ok: false, error: '未知的系统卡: ' + id }, 404);
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const patch = JSON.parse(body) || {};
      if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
        syscardModes[id] = normalizeModeField(patch.mode);
      }
      saveSysCards();
      return json(res, { ok: true, card: { id, mode: syscardModes[id] } });
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
  }

  // 投资方案卡数据：GET /api/invest/:id → 读取对应 JSON 返回
  // id 仅接受 INVEST_FILES 白名单；缺失文件返回 _missing:true（前端显示占位文案），不报错
  if (p.startsWith('/api/invest/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/invest/'.length));
    if (!INVEST_FILES[id]) {
      return json(res, { ok: false, error: '未知的投资卡: ' + id }, 400);
    }
    const filePath = path.join(ROOT, INVEST_FILES[id]);
    if (!fs.existsSync(filePath)) {
      return json(res, { ok: true, data: { sections: [], _missing: true } });
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      return json(res, { ok: true, data });
    } catch (e) {
      return json(res, { ok: false, error: '方案文件解析失败' }, 500);
    }
  }

  // 投资计算器：GET /api/invest-calc → 返回目标 / 当前 / 偏差 / 状态判断 / 再平衡方案
  // 状态机（与原 invest-cadence.json §再平衡方案 + §5 条硬约束 对齐）：
  //   - 任一偏差 > 10% → 'emergency'（立即再平衡）
  //   - 任一偏差 > 5%  → 'threshold'（季度再平衡触发）
  //   - 距 lastRebalance > 6 个月 → 'forced'（强制再平衡）
  //   - 否则 → 'ok'（无需再平衡）
  // v2 新增：dailyPerWorkday / workdays / todayRecommendation（基于工作日定投+低配补仓）
  // v3 新增：warnings（软约束：纳指>40% / 双红利低波合计>45%，仅用于编辑模式展示，GET 也透传便于状态栏）
  // v3.3 变更：rebalancePlan 的 buys 改为「固定总额按缺口比例分配」（偏离弥补定投法，合计===dailyPerWorkday）；
  //   前端不再渲染状态/操作建议块（一次性买卖金额列表已删除）——偏离靠每日定投自动弥补
  if (p === '/api/invest-calc' && req.method === 'GET') {
    const targets = loadTargets();
    const dailyPerWorkday = investConfig.dailyPerWorkday;
    const workdays = investConfig.workdays;
    const current = (holdings && holdings.holdings) || {};
    // 计算总额 + 各资产占比
    const assetNames = Object.keys(targets);
    const rows = assetNames.map((name) => {
      const t = Number(targets[name]) || 0;
      const amt = Number(current[name]) || 0;
      return { name, target: t, amount: amt };
    });
    const total = rows.reduce((s, r) => s + r.amount, 0);
    if (total > 0) {
      rows.forEach((r) => {
        r.currentPct = +(r.amount / total * 100).toFixed(2);
        r.deviation = +(r.currentPct - r.target).toFixed(2);
      });
    } else {
      rows.forEach((r) => { r.currentPct = 0; r.deviation = 0; });
    }
    // 状态判断：按优先级 emergency > forced > threshold > ok
    let status = 'ok';
    const triggerAssets = rows.filter((r) => Math.abs(r.deviation) > INVEST_THRESHOLD_NORMAL);
    const emergencyAssets = rows.filter((r) => Math.abs(r.deviation) > INVEST_THRESHOLD_EMERG);
    let nextCheck = null;
    if (holdings.lastRebalance) {
      const last = new Date(holdings.lastRebalance);
      const next = new Date(last);
      next.setMonth(next.getMonth() + INVEST_FORCE_MONTHS);
      nextCheck = next.toISOString().slice(0, 10);
    }
    let forceTriggered = false;
    if (holdings.lastRebalance) {
      const last = new Date(holdings.lastRebalance);
      const monthsSince = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24 * 30);
      forceTriggered = monthsSince >= INVEST_FORCE_MONTHS;
    }
    if (emergencyAssets.length > 0) {
      status = 'emergency';
    } else if (forceTriggered) {
      status = 'forced';
    } else if (triggerAssets.length > 0) {
      status = 'threshold';
    }
    // 操作步骤（仅 emergency/threshold/forced 时返回；列出每个触发资产的买卖金额）
    const actions = (status === 'ok') ? [] : (() => {
      const targetAmt = (r) => +(total * r.target / 100).toFixed(0);
      const actions = [];
      // 超配：实际 > 目标 → 卖出金额 = 实际 - 目标
      // 低配：实际 < 目标 → 买入金额 = 目标 - 实际
      const overAll = rows.filter((r) => r.deviation > INVEST_THRESHOLD_NORMAL);
      const underAll = rows.filter((r) => r.deviation < -INVEST_THRESHOLD_NORMAL);
      overAll.forEach((r) => actions.push({ type: 'sell', asset: r.name, amount: r.amount - targetAmt(r) }));
      underAll.forEach((r) => actions.push({ type: 'buy', asset: r.name, amount: targetAmt(r) - r.amount }));
      return actions;
    })();
    // 再平衡方案（v3：完整卖出+买入方案；v3.3 买入改为固定总额按缺口比例分配）
    const rebalancePlan = computeRebalancePlan({
      rows, total, dailyPerWorkday, workdays,
      showSellInRebalance: investConfig.showSellInRebalance,
    });
    // 软约束警告（用于编辑模式标红；GET 也透传，前端决定何时显示）
    const warnings = computeWarnings(targets);
    return json(res, {
      ok: true,
      data: {
        targets,
        rows,
        total,
        status,
        actions,
        lastRebalance: holdings.lastRebalance || null,
        nextCheck,
        loadFailed: holdingsLoadFailed,
        // v2 字段
        dailyPerWorkday,
        workdays,
        // v3 替换 todayRecommendation → rebalancePlan（含 sells + buys + postSellTotal）
        rebalancePlan,
        showSellInRebalance: investConfig.showSellInRebalance,
        warnings,
      },
    });
  }

  // POST /api/invest-calc/config → 保存目标权重 + 预计工作日定投额 + 工作日定义 + 是否显示卖出建议
  // body: { targets, dailyPerWorkday, workdays?, showSellInRebalance? }
  // targets 之和必须 = 100（容差 ±0.5）；dailyPerWorkday ≥0；workdays 是 0-6 整数数组（可选）；showSellInRebalance 布尔（可选）
  if (p === '/api/invest-calc/config' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      // targets：必须 4 个标的之和 = 100
      if (!parsed.targets || typeof parsed.targets !== 'object' || Array.isArray(parsed.targets)) {
        return json(res, { ok: false, error: 'targets 必须为对象' }, 400);
      }
      const newTargets = {};
      for (const name of Object.keys(parsed.targets)) {
        const v = Number(parsed.targets[name]);
        if (!Number.isFinite(v) || v < 0) {
          return json(res, { ok: false, error: 'targets[' + name + '] 非法' }, 400);
        }
        newTargets[name] = v;
      }
      const sum = Object.values(newTargets).reduce((s, v) => s + v, 0);
      if (Math.abs(sum - 100) >= 0.5) {
        return json(res, { ok: false, error: 'targets 之和必须 = 100（当前 ' + sum.toFixed(2) + '）' }, 400);
      }
      // dailyPerWorkday：数字 ≥0
      const newDaily = Number(parsed.dailyPerWorkday);
      if (!Number.isFinite(newDaily) || newDaily < 0) {
        return json(res, { ok: false, error: 'dailyPerWorkday 必须为 ≥0 数字' }, 400);
      }
      // workdays：可选字段（前端 v2.1 已删除 UI；保留 schema 字段向后兼容 invest-personal.json 中的历史自定义值）
      // 缺省时保持当前 in-memory 值不变——客户端不发送 = 不修改；非法值忽略
      let newWorkdays = investConfig.workdays;
      if (parsed.workdays !== undefined) {
        if (!Array.isArray(parsed.workdays)) {
          return json(res, { ok: false, error: 'workdays 必须为数组' }, 400);
        }
        const filtered = parsed.workdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        if (!filtered.length) {
          return json(res, { ok: false, error: 'workdays 至少包含 1 个工作日' }, 400);
        }
        newWorkdays = filtered;
      }
      // showSellInRebalance：可选布尔（v3 新增；缺省保持 in-memory 当前值；非法类型 → 400）
      let newShowSell = investConfig.showSellInRebalance;
      if (parsed.showSellInRebalance !== undefined) {
        if (typeof parsed.showSellInRebalance !== 'boolean') {
          return json(res, { ok: false, error: 'showSellInRebalance 必须为布尔' }, 400);
        }
        newShowSell = parsed.showSellInRebalance;
      }
      if (investConfigLoadFailed) {
        return json(res, { ok: false, error: '配置文件加载失败，禁止写入（详见 .bak）', loadFailed: true }, 500);
      }
      investConfig = {
        targets: newTargets,
        dailyPerWorkday: newDaily,
        workdays: newWorkdays,
        showSellInRebalance: newShowSell,
      };
      const ok = saveInvestConfig();
      return json(res, { ok });
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
  }

  // POST /api/invest-calc/holdings → 保存当前持仓金额；body: { holdings: { asset: amount } }
  if (p === '/api/invest-calc/holdings' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      if (!parsed.holdings || typeof parsed.holdings !== 'object' || Array.isArray(parsed.holdings)) {
        return json(res, { ok: false, error: 'holdings 必须为对象' }, 400);
      }
      // 仅接受目标权重里有的标的；金额强制为 ≥0 数字
      const targets = loadTargets();
      const sanitized = {};
      for (const name of Object.keys(targets)) {
        const v = Number(parsed.holdings[name]);
        if (Number.isFinite(v) && v >= 0) sanitized[name] = v;
      }
      if (holdingsLoadFailed) {
        return json(res, { ok: false, error: '持仓文件加载失败，禁止写入（详见 .bak）', loadFailed: true }, 500);
      }
      holdings.holdings = sanitized;
      const ok = saveHoldings();
      return json(res, { ok });
    } catch (e) {
      return json(res, { ok: false, error: '请求格式错误: ' + e.message }, 400);
    }
  }

  // POST /api/invest-calc/rebalanced → 标记已再平衡（lastRebalance = today）
  if (p === '/api/invest-calc/rebalanced' && req.method === 'POST') {
    if (holdingsLoadFailed) {
      return json(res, { ok: false, error: '持仓文件加载失败，禁止写入', loadFailed: true }, 500);
    }
    holdings.lastRebalance = new Date().toISOString().slice(0, 10);
    const ok = saveHoldings();
    return json(res, { ok, lastRebalance: holdings.lastRebalance });
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
