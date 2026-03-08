const API_ROOT = '';
let POLL_INTERVAL = 3000;
let currentAccountId = null;
let accounts = [];
let logFilterAccountId = localStorage.getItem('logFilterAccountId') || 'all';
let lastServerUptime = 0;
let lastSyncTimestamp = 0;
let expHistory = [];
let adminToken = localStorage.getItem('adminToken') || '';
let currentUser = null; // 当前登录用户信息
let isLoggedIn = false;
let pollTimer = null;
let lastAccountsPolledAt = 0;
let accountsLoading = false;
let seedLoadPromise = null;
const pendingAutomationKeys = new Set();
const automationDebounceTimers = new Map();
const automationQueuedValues = new Map();
const automationSendingKeys = new Set();
const AUTOMATION_DEBOUNCE_MS = 250;
let latestConfigRevision = 0;
let expectedConfigRevision = 0;
let lastLogsRenderKey = '';
let lastAccountLogsRenderKey = '';
let lastStatusPolledAt = 0;
let lastOperationsData = {};
const inFlightRequests = new Map();
const localUiLogs = [];
const LOCAL_UI_LOG_LIMIT = 120;
const logFilters = {
    module: localStorage.getItem('logFilterModule') || '',
    event: localStorage.getItem('logFilterEvent') || '',
    keyword: localStorage.getItem('logFilterKeyword') || '',
    isWarn: localStorage.getItem('logFilterIsWarn') || '',
    timeFrom: localStorage.getItem('logFilterTimeFrom') || '',
    timeTo: localStorage.getItem('logFilterTimeTo') || '',
};
const THEME_STORAGE_KEY = 'themeMode';

const LOG_EVENT_LABELS = {
    farm_cycle: '农场巡查',
    harvest_crop: '收获作物',
    lands_notify: '土地推送',
    remove_plant: '清理枯株',
    seed_pick: '选择种子',
    seed_buy: '购买种子',
    seed_buy_skip: '种子购买跳过',
    plant_seed: '种植种子',
    fertilize: '施加化肥',
    fertilizer_gift_open: '开启礼包',
    fertilizer_buy: '购买化肥',
    mall_free_gifts: '免费礼包',
    daily_share: '分享奖励',
    vip_daily_gift: '会员礼包',
    month_card_gift: '月卡礼包',
    illustrated_rewards: '图鉴奖励',
    friend_cycle: '好友巡查',
    friend_scan: '好友扫描',
    visit_friend: '访问好友',
    enter_farm: '进入农场',
    quiet_hours: '静默时段',
    sell_success: '出售成功',
    sell_done: '出售完成',
    sell_gain_pending: '出售收益待同步',
    sell_after_harvest: '收获后出售',
    sell_skip_invalid: '出售跳过',
    upgrade_land: '土地升级',
    unlock_land: '土地解锁',
    tick: '调度执行',
    task_scan: '获取任务',
    task_claim: '完成任务',
    api_error: '请求失败',
    // 天王模式
    base_round_start: '基础巡查开始',
    base_round_done: '基础巡查结束',
    focus_add: '列入重点',
    focus_remove: '移出重点',
    focus_steal_fail: '重点偷菜失败',
    focus_round_done: '重点巡查结束',
    camp_add: '加入蹲点',
    camp_remove: '移出蹲点',
    camp_steal: '蹲点偷菜',
    steal_skip: '跳过偷菜',
    idle: '等待巡查',
    start: '天王启动',
    start_pending: '等待启动',
};

function shouldHideLogEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const tag = String(entry.tag || '');
    const msg = String(entry.msg || '');
    if (tag === '物品') return true; // 屏蔽金币+/-等物品变更噪声
    if (msg.includes('获得物品')) return true;
    if (/金币\s*[+-]/.test(msg)) return true;
    return false;
}

const $ = id => document.getElementById(id);

function toLogTs(entry) {
    const t = Number(entry && entry.ts);
    if (Number.isFinite(t) && t > 0) return t;
    const parsed = Date.parse(String((entry && entry.time) || ''));
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function pushLocalUiLog(message, options = {}) {
    // 前端调试日志已关闭：不再向日志流写入 frontend/api_error 本地日志
    return;
}

function matchLogFilters(entry) {
    const e = entry || {};
    const moduleName = String(logFilters.module || '').trim();
    const eventName = String(logFilters.event || '').trim();
    const keyword = String(logFilters.keyword || '').trim().toLowerCase();
    const keywordTerms = keyword ? keyword.split(/\s+/).filter(Boolean) : [];
    const isWarnFilter = logFilters.isWarn;
    const timeFromMs = logFilters.timeFrom ? Date.parse(String(logFilters.timeFrom)) : NaN;
    const timeToMs = logFilters.timeTo ? Date.parse(String(logFilters.timeTo)) : NaN;
    const logMs = toLogTs(e);

    if (logFilterAccountId && logFilterAccountId !== 'all') {
        if (String(e.accountId || '') !== String(logFilterAccountId)) return false;
    }
    if (moduleName && String((e.meta || {}).module || '') !== moduleName) return false;
    if (eventName && String((e.meta || {}).event || '') !== eventName) return false;
    if (isWarnFilter !== '') {
        const expected = String(isWarnFilter) === '1' || String(isWarnFilter).toLowerCase() === 'true';
        if (!!e.isWarn !== expected) return false;
    }
    if (Number.isFinite(timeFromMs) && logMs < timeFromMs) return false;
    if (Number.isFinite(timeToMs) && logMs > timeToMs) return false;
    if (keywordTerms.length > 0) {
        const text = `${e.msg || ''} ${e.tag || ''} ${JSON.stringify(e.meta || {})}`.toLowerCase();
        for (const term of keywordTerms) {
            if (!text.includes(term)) return false;
        }
    }
    return true;
}

function runDedupedRequest(key, fn) {
    if (!key || typeof fn !== 'function') return Promise.resolve(null);
    const existed = inFlightRequests.get(key);
    if (existed) return existed;
    const p = (async () => {
        try {
            return await fn();
        } finally {
            if (inFlightRequests.get(key) === p) {
                inFlightRequests.delete(key);
            }
        }
    })();
    inFlightRequests.set(key, p);
    return p;
}

function pickAccountAvatar(acc) {
    if (!acc || typeof acc !== 'object') return '';
    const direct = acc.avatar || acc.avatarUrl || acc.headUrl || acc.faceUrl || acc.qlogo || '';
    if (direct) return direct;
    const qq = String(acc.qq || acc.uin || '').trim();
    if (/^\d{5,}$/.test(qq)) {
        return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`;
    }
    const name = String(acc.name || '').trim();
    if (/^\d{5,}$/.test(name)) {
        return `https://q1.qlogo.cn/g?b=qq&nk=${name}&s=640`;
    }
    return '';
}

function updateTopbarAccount(acc) {
    const nameEl = $('topbar-account-name');
    const statusEl = $('topbar-account-status');
    const avatarEl = $('topbar-account-avatar');
    const fallbackEl = $('topbar-account-fallback');
    if (!nameEl || !statusEl || !avatarEl || !fallbackEl) return;

    const name = (acc && acc.name) ? String(acc.name) : '未选择账号';
    nameEl.textContent = name;
    if (acc && typeof acc.running === 'boolean') {
        statusEl.textContent = acc.running ? '运行中' : '已停止';
    } else if (name === '未登录') {
        statusEl.textContent = '未登录';
    } else if (name === '无账号') {
        statusEl.textContent = '未添加账号';
    } else {
        statusEl.textContent = '未选择';
    }

    const initial = (name && name.trim()) ? name.trim().charAt(0).toUpperCase() : '未';
    fallbackEl.textContent = initial;

    const avatar = pickAccountAvatar(acc);
    if (avatar) {
        avatarEl.src = avatar;
        avatarEl.style.display = '';
        fallbackEl.style.display = 'none';
    } else {
        avatarEl.removeAttribute('src');
        avatarEl.style.display = 'none';
        fallbackEl.style.display = '';
    }
}

function lockHorizontalSwipeOnMobile() {
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
    const isNarrow = window.matchMedia('(max-width: 980px)').matches;
    if (!isTouch || !isNarrow) return;

    let startX = 0;
    let startY = 0;
    document.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const target = e.target;
        if (target && typeof target.closest === 'function') {
            const scroller = target.closest('.logs-container');
            if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) {
                // 日志框内部允许横向滚动查看长内容
                return;
            }
        }
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) {
            e.preventDefault();
        }
    }, { passive: false });
}

function applyFontScale() {
    const root = document.documentElement;
    const isDesktop = window.matchMedia('(min-width: 981px)').matches;
    if (!isDesktop) {
        root.style.setProperty('--font-scale', '1');
        return;
    }
    const w = Math.max(window.innerWidth || 1, 1);
    const h = Math.max(window.innerHeight || 1, 1);
    const wr = w / 2560;
    const hr = h / 1440;
    // 宽高联合计算（2K 为基准 1.0）：提高“高”的影响，减轻“宽”的影响
    let scale = Math.pow(wr, 0.35) * Math.pow(hr, 0.65);
    // 对超宽/超高比例做轻微抑制，避免字体异常放大/缩小
    const aspect = w / h;
    const baseAspect = 16 / 9;
    const aspectDelta = Math.abs(Math.log(aspect / baseAspect));
    const aspectFactor = Math.max(0.96, 1 - aspectDelta * 0.04);
    scale *= aspectFactor;
    scale = Math.max(0.66, Math.min(1.45, scale));
    root.style.setProperty('--font-scale', scale.toFixed(3));
}


function updateValueWithAnim(id, newValue, className = 'value-changed') {
    const el = $(id);
    if (!el) return;
    // 只有在值变化且不为初始状态时才播放动画
    if (el.textContent !== '-' && el.textContent !== newValue) {
        el.textContent = newValue;
        el.classList.remove(className);
        void el.offsetWidth; // 触发重绘
        el.classList.add(className);
    } else {
        el.textContent = newValue;
    }
}

function renderOpsList(opsRaw) {
    const wrap = $('ops-list');
    if (!wrap) return;
    const ops = (opsRaw && typeof opsRaw === 'object') ? { ...opsRaw } : {};
    lastOperationsData = { ...ops };
    const labels = { harvest:'收获', water:'浇水', weed:'除草', bug:'除虫', fertilize:'施肥', plant:'种植', upgrade:'升级', steal:'偷菜', helpWater:'帮浇水', helpWeed:'帮除草', helpBug:'帮除虫', taskClaim:'任务', sell:'出售', beStolen:'被偷', beHelped:'被帮', bePutWeed:'被放草', bePutBug:'被放虫' };
    const icons = {
        harvest: 'fa-hand-holding-droplet',
        steal: 'fa-hand-sparkles',
        water: 'fa-tint',
        weed: 'fa-leaf',
        bug: 'fa-bug',
        plant: 'fa-seedling',
        sell: 'fa-coins',
        beStolen: 'fa-mask',
        beHelped: 'fa-hands-helping',
        bePutWeed: 'fa-spa',
        bePutBug: 'fa-skull-crossbones',
    };
    const fixedShow = ['harvest', 'steal', 'water', 'weed', 'bug', 'plant', 'sell', 'beStolen', 'beHelped', 'bePutWeed', 'bePutBug'];
    const list = fixedShow.map((k) => [k, Number(ops[k] || 0)]);
    wrap.innerHTML = list.map(([k, v]) => {
        const icon = icons[k] || 'fa-chart-column';
        return `<div class="op-stat"><span class="label"><i class="fas ${icon}" aria-hidden="true"></i>${labels[k] || k}</span><span class="count">${v}</span></div>`;
    }).join('');
    syncOpsRowsMode();
}

function syncOpsRowsMode() {
    const wrap = $('ops-list');
    if (!wrap) return;
    // 先按内容占位测量，再决定是否切换为等分行高
    wrap.classList.remove('equal-rows');
    requestAnimationFrame(() => {
        const needScroll = wrap.scrollHeight > wrap.clientHeight + 1;
        if (!needScroll) wrap.classList.add('equal-rows');
    });
}

function resetDashboardStats() {
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    setText('gold', '0');
    setText('coupon', '0');
    setText('stat-gold', '+0');
    setText('stat-coupon', '+0');
    setText('level', 'Lv0');
    setText('exp-rate', '0/时');
    setText('stat-exp', '+0');
    setText('exp-num', '0/0');
    setText('time-to-level', '');
    setText('stat-uptime', '0:00');
    setText('fert-normal-hours', '0.0h');
    setText('fert-organic-hours', '0.0h');
    setText('collect-normal', '0');
    setText('collect-rare', '0');
    setText('next-farm-check', '--');
    setText('next-friend-check', '--');
    const fill = $('exp-fill');
    if (fill) fill.style.width = '0%';
    expHistory = [];
    renderOpsList({});
}

function clearFarmView(message = '暂无账号') {
    const grid = $('farm-grid');
    const sum = $('farm-summary');
    if (grid) grid.innerHTML = `<div style="padding:20px;text-align:center;color:#666">${message}</div>`;
    if (sum) sum.textContent = '';
}

function clearFriendsView(message = '暂无账号') {
    const wrap = $('friends-list');
    const sum = $('friend-summary');
    if (wrap) wrap.innerHTML = `<div style="padding:20px;text-align:center;color:#666">${message}</div>`;
    if (sum) sum.textContent = '共 0 名好友';
}

async function flushAutomationUpdate(key) {
    if (!key || automationSendingKeys.has(key)) return;
    if (!automationQueuedValues.has(key)) return;
    if (!currentAccountId) {
        automationQueuedValues.delete(key);
        pendingAutomationKeys.delete(key);
        return;
    }
    automationSendingKeys.add(key);
    pendingAutomationKeys.add(key);
    const value = automationQueuedValues.get(key);
    automationQueuedValues.delete(key);
    try {
        const resp = await api('/api/automation', 'POST', { [key]: value });
        if (resp === null) {
            await pollStatus();
        } else {
            updateRevisionState(resp);
        }
    } finally {
        automationSendingKeys.delete(key);
        if (automationQueuedValues.has(key)) {
            // 若发送期间又有新值，继续立即刷新下一次
            setTimeout(() => flushAutomationUpdate(key), 0);
        } else if (!automationDebounceTimers.has(key)) {
            // 略微延迟再移除 pending，避免状态包覆盖
            setTimeout(() => {
                if (!automationQueuedValues.has(key) && !automationSendingKeys.has(key)) {
                    pendingAutomationKeys.delete(key);
                }
            }, 300);
        }
    }
}

function queueAutomationUpdate(key, value, delayMs = AUTOMATION_DEBOUNCE_MS) {
    if (!key) return;
    automationQueuedValues.set(key, value);
    pendingAutomationKeys.add(key);
    const old = automationDebounceTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
        automationDebounceTimers.delete(key);
        flushAutomationUpdate(key);
    }, Math.max(0, Number(delayMs) || 0));
    automationDebounceTimers.set(key, timer);
}

function shouldIgnoreApiErrorLog(path, statusCode) {
    const p = String(path || '');
    const code = Number(statusCode);
    // 启动未登录时 /api/ping 返回 401 是预期行为，不记为错误日志
    if (p === '/api/ping' && code === 401) return true;
    return false;
}

function updateFriendSubControlsState() {
    const wrap = $('friend-sub-controls');
    if (!wrap) return;
    ['auto-friend-steal', 'auto-friend-help', 'auto-friend-bad'].forEach(id => {
        const input = $(id);
        if (input) input.disabled = false;
    });
    wrap.classList.remove('disabled');
}

function renderLogFilterOptions() {
    const sel = $('logs-account-filter');
    if (!sel) return;

    const hasSelected = logFilterAccountId === 'all' || accounts.some(a => a.id === logFilterAccountId);
    if (!hasSelected) logFilterAccountId = 'all';

    const options = ['<option value="all">全部账号</option>'];
    accounts.forEach(acc => {
        options.push(`<option value="${acc.id}">${escapeHtml(acc.name)}</option>`);
    });
    sel.innerHTML = options.join('');
    sel.value = logFilterAccountId;
}

function initLogFiltersUI() {
    const moduleEl = $('logs-module-filter');
    const eventEl = $('logs-event-filter');
    const keywordEl = $('logs-keyword-filter');
    const warnEl = $('logs-warn-filter');
    const timeFromEl = $('logs-time-from-filter');
    const timeToEl = $('logs-time-to-filter');

    if (moduleEl) moduleEl.value = logFilters.module;
    if (eventEl) eventEl.value = logFilters.event;
    if (keywordEl) keywordEl.value = logFilters.keyword;
    if (warnEl) warnEl.value = logFilters.isWarn;
    if (timeFromEl) timeFromEl.value = logFilters.timeFrom;
    if (timeToEl) timeToEl.value = logFilters.timeTo;
}

function buildLogQuery() {
    const p = new URLSearchParams();
    p.set('limit', '1000');
    p.set('accountId', logFilterAccountId || 'all');
    if (logFilters.module) p.set('module', logFilters.module);
    if (logFilters.event) p.set('event', logFilters.event);
    if (logFilters.keyword) p.set('keyword', logFilters.keyword);
    if (logFilters.isWarn !== '') p.set('isWarn', logFilters.isWarn);
    if (logFilters.timeFrom) p.set('timeFrom', logFilters.timeFrom);
    if (logFilters.timeTo) p.set('timeTo', logFilters.timeTo);
    return p.toString();
}

function updateRevisionState(obj) {
    if (!obj || typeof obj !== 'object') return;
    const rev = Number(obj.configRevision || 0);
    if (rev > 0) {
        if (rev > latestConfigRevision) latestConfigRevision = rev;
        if (rev > expectedConfigRevision) expectedConfigRevision = rev;
    }
}

// ============ 工具函数 ============
function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function fmtRemainSec(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    if (n <= 0) return '';
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分`;
    return `${n}秒`;
}

function toSafeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

const THEMES = ['dark', 'light', 'harvest', 'spring', 'nightfarm'];
const THEME_ICONS = {
    dark:      '<i class="fas fa-moon"></i>',
    light:     '<i class="fas fa-sun"></i>',
    harvest:   '<i class="fas fa-wheat-awn"></i>',
    spring:    '<i class="fas fa-seedling"></i>',
    nightfarm: '<i class="fas fa-water"></i>',
};
const THEME_LABELS = {
    dark:      '暗夜（深色）',
    light:     '清新（浅色）',
    harvest:   '金秋麦穗',
    spring:    '春日田园',
    nightfarm: '夏日荷塘',
};

function applyTheme(mode) {
    const validMode = THEMES.includes(mode) ? mode : 'dark';
    THEMES.forEach(t => document.body.classList.remove(t + '-theme'));
    if (validMode !== 'dark') document.body.classList.add(validMode + '-theme');
    const btn = $('btn-theme');
    if (btn) {
        btn.innerHTML = THEME_ICONS[validMode];
        btn.title = '切换主题：当前 ' + THEME_LABELS[validMode];
    }
}

function initTheme() {
    const stored = String(localStorage.getItem(THEME_STORAGE_KEY) || '').toLowerCase();
    const mode = THEMES.includes(stored) ? stored : 'dark';
    applyTheme(mode);
}

let passwordToggleBound = false;
function initPasswordToggles() {
    if (passwordToggleBound) return;
    passwordToggleBound = true;

    document.addEventListener('mousedown', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.password-toggle') : null;
        if (!btn) return;
        e.preventDefault();
    });

    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.password-toggle') : null;
        if (!btn) return;
        const targetId = String(btn.getAttribute('data-target') || '');
        const input = targetId ? $(targetId) : null;
        if (!input) return;
        const toText = input.type === 'password';
        input.type = toText ? 'text' : 'password';
        btn.innerHTML = `<i class="fas ${toText ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i>`;
        btn.setAttribute('aria-label', toText ? '隐藏密码' : '显示密码');
        btn.setAttribute('aria-pressed', toText ? 'true' : 'false');
    });
}

async function syncThemeFromServer() {
    const data = await api('/api/settings');
    const serverTheme = data && data.ui && THEMES.includes(data.ui.theme)
        ? data.ui.theme
        : '';
    if (serverTheme) {
        localStorage.setItem(THEME_STORAGE_KEY, serverTheme);
        applyTheme(serverTheme);
    }
}

async function api(path, method = 'GET', body = null, raw = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;
    if (currentAccountId) {
        headers['x-account-id'] = currentAccountId;
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    
    try {
        const r = await fetch(API_ROOT + path, opts);
        if (r.status === 401) {
            if (!shouldIgnoreApiErrorLog(path, 401)) {
                pushLocalUiLog(`[${method}] ${path} 未授权 (401)`, { module: 'frontend', event: 'api_error' });
            }
            setLoginState(false);
            return null;
        }
        const j = await r.json();
        if (!j.ok) {
            pushLocalUiLog(`[${method}] ${path} 失败: ${j.error || 'unknown error'}`, {
                module: 'frontend',
                event: 'api_error',
            });
            return null;
        }
        if (raw) return j;
        if (j.data !== undefined) return j.data;
        if (j.result !== undefined) return { result: j.result };
        return true;
    } catch (e) {
        console.error('API Error:', e);
        pushLocalUiLog(`[${method}] ${path} 异常: ${e.message || 'network error'}`, {
            module: 'frontend',
            event: 'api_error',
        });
        return null;
    }
}

async function checkRegisterStatus() {
    try {
        const r = await fetch(API_ROOT + '/api/register-status');
        const j = await r.json();
        const enabled = j && j.ok && j.data && j.data.enabled;
        const switchToReg = $('btn-switch-to-reg');
        const switchTip = $('login-switch-tip');
        if (switchToReg) switchToReg.style.display = enabled ? '' : 'none';
        if (switchTip) switchTip.style.display = enabled ? '' : 'none';
    } catch (e) {
        // 忽略，默认隐藏注册入口
        const switchToReg = $('btn-switch-to-reg');
        const switchTip = $('login-switch-tip');
        if (switchToReg) switchToReg.style.display = 'none';
        if (switchTip) switchTip.style.display = 'none';
    }
}

function showLogin(message = '') {
    const overlay = $('login-overlay');
    if (overlay) overlay.classList.add('show');
    const msg = $('login-error');
    if (msg) msg.textContent = message || '';
    checkRegisterStatus();
}

function hideLogin() {
    const overlay = $('login-overlay');
    if (overlay) overlay.classList.remove('show');
    const msg = $('login-error');
    if (msg) msg.textContent = '';
}

function stopPolling() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

function getPollIntervalMs() {
    if (document.visibilityState !== 'visible' || !isLoggedIn) return 10000;
    const activePage = document.querySelector('.page.active');
    const pageId = activePage ? activePage.id : '';
    if (!currentAccountId) return 8000;
    if (pageId === 'page-dashboard') return 3000;
    if (pageId === 'page-personal' || pageId === 'page-friends') return 4000;
    return 6000;
}

function startPolling() {
    stopPolling();
    const tick = async () => {
        if (document.visibilityState === 'visible' && isLoggedIn) {
            const activePage = document.querySelector('.page.active');
            const activePageId = activePage ? activePage.id : '';
            const now = Date.now();

            // 仅在首页高频拉状态，其他页面低频兜底刷新顶部连接状态
            const statusDue = activePageId === 'page-dashboard' || (now - lastStatusPolledAt > 12000);
            if (statusDue) {
                await pollStatus();
                lastStatusPolledAt = now;
            }

            // 周期刷新账号列表，确保被动删除（踢下线/离线自动删除）能及时反映到前端
            if (!accountsLoading && (now - lastAccountsPolledAt > 3500)) {
                accountsLoading = true;
                try {
                    await loadAccounts();
                } finally {
                    lastAccountsPolledAt = Date.now();
                    accountsLoading = false;
                }
            }

            // 运行日志只在首页拉取
            if (activePageId === 'page-dashboard') {
                await pollLogs();
            }

            if ($('page-accounts') && $('page-accounts').classList.contains('active')) {
                await pollAccountLogs();
            }
        }
        pollTimer = setTimeout(tick, getPollIntervalMs());
    };
    pollTimer = setTimeout(tick, 200);
}

function setLoginState(loggedIn) {
    isLoggedIn = loggedIn;
    if (loggedIn) {
        hideLogin();
        updateUserManagementUI();
        startPolling();
        loadAccounts();
        syncThemeFromServer();
        if (typeof loadRegisterConfig === "function" && currentUser && currentUser.role === "admin") { loadRegisterConfig(); }
    } else {
        stopPolling();
        inFlightRequests.clear();
        currentAccountId = null;
        accounts = [];
        resetDashboardStats();
        logFilterAccountId = 'all';
        $('current-account-name').textContent = '未登录';
        updateTopbarAccount({ name: '未登录' });
        $('conn-text').textContent = '请登录';
        $('conn-dot').className = 'dot offline';
        clearFarmView('请先登录并选择账号');
        clearFriendsView('请先登录并选择账号');
        showLogin('');
    }
}

async function checkLogin() {
    if (!adminToken) {
        setLoginState(false);
        return;
    }
    const ping = await api('/api/ping');
    if (ping) {
        if (ping.user) {
            currentUser = ping.user; // 恢复用户信息
        }
        setLoginState(true);
        // 如果有用户信息,更新用户管理UI可见性
        updateUserManagementUI();
    } else {
        setLoginState(false);
    }
}

function updateUserManagementUI() {
    const userManagementSection = $('user-management-section');
    const registerConfigSection = $('register-config-section');
    const isAdmin = currentUser && currentUser.role === 'admin';
    if (userManagementSection) userManagementSection.style.display = isAdmin ? '' : 'none';
    if (registerConfigSection) registerConfigSection.style.display = isAdmin ? '' : 'none';

    // 防挂菜单：仅 admin / vip 可见
    const navAntiafk = $('nav-antiafk');
    if (navAntiafk) {
        const canSee = currentUser && (currentUser.role === 'admin' || currentUser.role === 'vip');
        navAntiafk.style.display = canSee ? '' : 'none';
    }
}

async function doLogin() {
    const username = $('login-username') ? $('login-username').value.trim() : '';
    const password = $('login-password').value;
    if (!username) { showLogin('请输入用户名'); return; }
    if (!password) { showLogin('请输入密码'); return; }
    try {
        const r = await fetch(API_ROOT + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (r.status === 401) {
            showLogin('用户名或密码错误');
            return;
        }
        const j = await r.json();
        if (j && j.ok && j.data && j.data.token) {
            adminToken = j.data.token;
            currentUser = j.data.user || null;
            localStorage.setItem('adminToken', adminToken);
            setLoginState(true);
        } else {
            showLogin(j.error || '登录失败');
        }
    } catch (e) {
        console.error('Login Error:', e);
        showLogin('登录失败');
    }
}

async function doRegister() {
    const username = ($('login-username') && $('login-username').value.trim()) || '';
    const password = ($('login-password') && $('login-password').value) || '';
    const inviteCode = ($('reg-invite-code') && $('reg-invite-code').value.trim()) || '';
    if (!username || username.length < 2) { showLogin('用户名至少2位'); return; }
    if (!password || password.length < 4) { showLogin('密码至少4位'); return; }
    try {
        const r = await fetch(API_ROOT + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, inviteCode })
        });
        const j = await r.json();
        if (j && j.ok) {
            showLogin('注册成功，请登录');
            switchLoginMode(false); // 切回登录
        } else {
            showLogin(j.error || '注册失败');
        }
    } catch (e) {
        showLogin('注册失败');
    }
}

function switchLoginMode(toRegister) {
    const loginBtn = $('btn-login');
    const regBtn = $('btn-register');
    const modeTitle = $('login-mode-title');
    const inviteGroup = $('reg-invite-group');
    const switchToReg = $('btn-switch-to-reg');
    const switchToLogin = $('btn-switch-to-login');
    const switchTip = $('login-switch-tip');
    if (toRegister) {
        if (loginBtn) loginBtn.style.display = 'none';
        if (regBtn) regBtn.style.display = '';
        if (modeTitle) modeTitle.textContent = '注册新账号';
        if (inviteGroup) inviteGroup.style.display = '';
        if (switchToReg) switchToReg.style.display = 'none';
        if (switchToLogin) switchToLogin.style.display = '';
        if (switchTip) switchTip.style.display = 'none';
    } else {
        if (loginBtn) loginBtn.style.display = '';
        if (regBtn) regBtn.style.display = 'none';
        if (modeTitle) modeTitle.textContent = '登录面板';
        if (inviteGroup) inviteGroup.style.display = 'none';
        if (switchToReg) switchToReg.style.display = '';
        if (switchToLogin) switchToLogin.style.display = 'none';
        if (switchTip) switchTip.style.display = '';
    }
    showLogin('');
}

// ============ Toast 提示 ============
let _toastTimer = null;
function showToast(msg, typeOrDuration = 'success') {
    let el = document.getElementById('global-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'global-toast';
        el.style.cssText = 'position:fixed;top:72px;left:50%;transform:translateX(-50%);color:#fff;padding:9px 22px;border-radius:24px;font-size:14px;z-index:9999;pointer-events:none;transition:opacity 0.3s;box-shadow:0 4px 16px rgba(0,0,0,0.25);';
        document.body.appendChild(el);
    }
    const colorMap = {
        success: 'rgba(24,160,111,0.92)',
        error:   'rgba(220,60,60,0.92)',
        warn:    'rgba(220,150,30,0.92)',
        info:    'rgba(50,130,200,0.92)',
    };
    let duration = 2500;
    if (typeof typeOrDuration === 'number') {
        duration = typeOrDuration;
        el.style.background = colorMap.success;
    } else {
        el.style.background = colorMap[typeOrDuration] || colorMap.success;
    }
    el.textContent = msg;
    el.style.opacity = '1';
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, duration);
}
window.showToast = showToast;

// ============ 账号管理 ============

function doLogout() {
    localStorage.removeItem('adminToken');
    try {
        navigator.sendBeacon(API_ROOT + '/api/logout');
    } catch(e) {}
    window.location.href = window.location.pathname + '?t=' + Date.now();
}





