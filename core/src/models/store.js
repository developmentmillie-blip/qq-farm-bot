const process = require('node:process');
/**
 * 运行时存储 - 自动化开关、种子偏好、账号管理、用户系统
 */

const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readTextFile, readJsonFile, writeJsonFileAtomic } = require('../services/json-db');

const USERS_FILE = getDataFile('users.json');

const STORE_FILE = getDataFile('store.json');
const ACCOUNTS_FILE = getDataFile('accounts.json');

// ============ 天王模式配置 ============
const DEFAULT_THEFT_KING = {
    enabled: false,
    minPlantLevel: 10,   // 高级作物最低等级 land_level_need >= 此值才列入加强巡查
    maxEnhanced: 10,     // 加强巡查每轮最多处理人数
    triggerBlocks: 2,    // 蹲点触发阈值（同一轮检测到 >= N 块异常成熟/被收就触发蹲点）
};

// 天王模式配置按账号存储（运行时内存，不写入 store.json，由 setTheftKingConfig 管理）
const theftKingConfigs = {};

function getTheftKingConfig(accountId) {
    const id = String(accountId || '').trim();
    // 优先内存，若无则从持久化 accountConfig 恢复
    if (id && !theftKingConfigs[id]) {
        const snap = getAccountConfigSnapshot ? getAccountConfigSnapshot(id) : null;
        if (snap && snap.theftKing) {
            theftKingConfigs[id] = { ...snap.theftKing };
        }
    }
    const src = theftKingConfigs[id] || {};
    return {
        enabled: !!src.enabled,
        minPlantLevel: Math.max(1, Number.parseInt(src.minPlantLevel, 10) || DEFAULT_THEFT_KING.minPlantLevel),
        maxEnhanced: Math.max(1, Number.parseInt(src.maxEnhanced, 10) || DEFAULT_THEFT_KING.maxEnhanced),
        triggerBlocks: Math.max(1, Number.parseInt(src.triggerBlocks, 10) || DEFAULT_THEFT_KING.triggerBlocks),
    };
}

function setTheftKingConfig(accountId, cfg) {
    const id = String(accountId || '').trim();
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    const current = theftKingConfigs[id] || {};
    theftKingConfigs[id] = {
        enabled: src.enabled !== undefined ? !!src.enabled : !!current.enabled,
        minPlantLevel: src.minPlantLevel !== undefined
            ? Math.max(1, Number.parseInt(src.minPlantLevel, 10) || DEFAULT_THEFT_KING.minPlantLevel)
            : (current.minPlantLevel || DEFAULT_THEFT_KING.minPlantLevel),
        maxEnhanced: src.maxEnhanced !== undefined
            ? Math.max(1, Number.parseInt(src.maxEnhanced, 10) || DEFAULT_THEFT_KING.maxEnhanced)
            : (current.maxEnhanced || DEFAULT_THEFT_KING.maxEnhanced),
        triggerBlocks: src.triggerBlocks !== undefined
            ? Math.max(1, Number.parseInt(src.triggerBlocks, 10) || DEFAULT_THEFT_KING.triggerBlocks)
            : (current.triggerBlocks || DEFAULT_THEFT_KING.triggerBlocks),
    };
    // 持久化到 accountConfig
    if (id) {
        const snap = getAccountConfigSnapshot(id);
        snap.theftKing = { ...theftKingConfigs[id] };
        setAccountConfigSnapshot(id, snap);
    }
    return { ...theftKingConfigs[id] };
}
const ALLOWED_PLANTING_STRATEGIES = ['preferred', 'level', 'max_exp', 'max_fert_exp', 'max_profit', 'max_fert_profit'];
const PUSHOO_CHANNELS = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher',
    'email', // 邮件渠道（nodemailer，token格式: 发件邮箱:授权码，endpoint为收件地址）
]);
const DEFAULT_OFFLINE_REMINDER = {
    channel: 'webhook',
    reloginUrlMode: 'none',
    endpoint: '',
    token: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 120,
};
// ============ 全局配置 ============
const DEFAULT_ACCOUNT_CONFIG = {
    automation: {
        farm: true,
        farm_push: true,   // 收到 LandsNotify 推送时是否立即触发巡田
        land_upgrade: true, // 是否自动升级土地
        friend: true,       // 好友互动总开关
        friend_help_exp_limit: true, // 帮忙经验达上限后自动停止帮忙
        friend_steal: true, // 偷菜
        friend_help: true,  // 帮忙
        friend_bad: false,  // 捣乱(放虫草)
        task: true,
        email: true,
        fertilizer_gift: false,
        fertilizer_buy: false,
        free_gifts: true,
        share_reward: true,
        vip_gift: true,
        month_card: true,
        open_server_gift: true,
        sell: true,
        fertilizer: 'none',
        smart_farm_schedule: true,
    },
    plantingStrategy: 'preferred',
    preferredSeedId: 0,
    intervals: {
        farm: 2,
        friend: 10,
        farmMin: 2,
        farmMax: 2,
        friendMin: 10,
        friendMax: 10,
    },
    friendQuietHours: {
        enabled: false,
        start: '23:00',
        end: '07:00',
    },
    friendBlacklist: [],
    stealWhitelist: [],
    careWhitelist: [],
};
const ALLOWED_AUTOMATION_KEYS = new Set(Object.keys(DEFAULT_ACCOUNT_CONFIG.automation));

let accountFallbackConfig = {
    ...DEFAULT_ACCOUNT_CONFIG,
    automation: { ...DEFAULT_ACCOUNT_CONFIG.automation },
    intervals: { ...DEFAULT_ACCOUNT_CONFIG.intervals },
    friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours },
};

const globalConfig = {
    accountConfigs: {},
    defaultAccountConfig: cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG),
    ui: {
        theme: 'dark',
    },
    offlineReminder: { ...DEFAULT_OFFLINE_REMINDER },
    adminPasswordHash: '',
    registerConfig: { enabled: false, inviteCode: '', inviteCodes: [], maxUsers: 0 },
    plantBlacklists: {},   // accountId -> [plantId, ...]
    friendBlacklists: {},  // accountId -> { noSteal: [...], noHelp: [...] }
    vipSmtpConfigs: {},    // userId -> { qq, notifyOffline, notifyMature(好友巡查发现成熟作物提醒) }
    adminSmtpConfig: { fromEmail: '', smtpPass: '' }, // 管理员配置发件 SMTP
};

function normalizeOfflineReminder(input) {
    const src = (input && typeof input === 'object') ? input : {};
    let offlineDeleteSec = Number.parseInt(src.offlineDeleteSec, 10);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 1) {
        offlineDeleteSec = DEFAULT_OFFLINE_REMINDER.offlineDeleteSec;
    }
    const rawChannel = (src.channel !== undefined && src.channel !== null)
        ? String(src.channel).trim().toLowerCase()
        : '';
    const endpoint = (src.endpoint !== undefined && src.endpoint !== null)
        ? String(src.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    const channel = PUSHOO_CHANNELS.has(migratedChannel)
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const rawReloginUrlMode = (src.reloginUrlMode !== undefined && src.reloginUrlMode !== null)
        ? String(src.reloginUrlMode).trim().toLowerCase()
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const reloginUrlMode = new Set(['none', 'qq_link', 'qr_code', 'all']).has(rawReloginUrlMode)
        ? rawReloginUrlMode
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const token = (src.token !== undefined && src.token !== null)
        ? String(src.token).trim()
        : DEFAULT_OFFLINE_REMINDER.token;
    const title = (src.title !== undefined && src.title !== null)
        ? String(src.title).trim()
        : DEFAULT_OFFLINE_REMINDER.title;
    const msg = (src.msg !== undefined && src.msg !== null)
        ? String(src.msg).trim()
        : DEFAULT_OFFLINE_REMINDER.msg;
    return {
        channel,
        reloginUrlMode,
        endpoint,
        token,
        title,
        msg,
        offlineDeleteSec,
    };
}

function cloneAccountConfig(base = DEFAULT_ACCOUNT_CONFIG) {
    const srcAutomation = (base && base.automation && typeof base.automation === 'object')
        ? base.automation
        : {};
    const automation = { ...DEFAULT_ACCOUNT_CONFIG.automation };
    for (const key of Object.keys(automation)) {
        if (srcAutomation[key] !== undefined) automation[key] = srcAutomation[key];
    }

    const rawBlacklist = Array.isArray(base.friendBlacklist) ? base.friendBlacklist : [];
    return {
        ...base,
        automation,
        intervals: { ...(base.intervals || DEFAULT_ACCOUNT_CONFIG.intervals) },
        friendQuietHours: { ...(base.friendQuietHours || DEFAULT_ACCOUNT_CONFIG.friendQuietHours) },
        friendBlacklist: rawBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        stealWhitelist: (Array.isArray(base.stealWhitelist)?base.stealWhitelist:[]).map(Number).filter(n=>Number.isFinite(n)&&n>0),
        careWhitelist: (Array.isArray(base.careWhitelist)?base.careWhitelist:[]).map(Number).filter(n=>Number.isFinite(n)&&n>0),
        plantingStrategy: ALLOWED_PLANTING_STRATEGIES.includes(String(base.plantingStrategy || ''))
            ? String(base.plantingStrategy)
            : DEFAULT_ACCOUNT_CONFIG.plantingStrategy,
        preferredSeedId: Math.max(0, Number.parseInt(base.preferredSeedId, 10) || 0),
    };
}

function resolveAccountId(accountId) {
    const direct = (accountId !== undefined && accountId !== null) ? String(accountId).trim() : '';
    if (direct) return direct;
    const envId = String(process.env.FARM_ACCOUNT_ID || '').trim();
    return envId;
}

function normalizeAccountConfig(input, fallback = accountFallbackConfig) {
    const src = (input && typeof input === 'object') ? input : {};
    const cfg = cloneAccountConfig(fallback || DEFAULT_ACCOUNT_CONFIG);

    if (src.automation && typeof src.automation === 'object') {
        for (const [k, v] of Object.entries(src.automation)) {
            if (!ALLOWED_AUTOMATION_KEYS.has(k)) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'none'];
                cfg.automation[k] = allowed.includes(v) ? v : cfg.automation[k];
            } else {
                cfg.automation[k] = !!v;
            }
        }
    }

    if (src.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(src.plantingStrategy)) {
        cfg.plantingStrategy = src.plantingStrategy;
    }

    if (src.preferredSeedId !== undefined && src.preferredSeedId !== null) {
        cfg.preferredSeedId = Math.max(0, Number.parseInt(src.preferredSeedId, 10) || 0);
    }

    if (src.intervals && typeof src.intervals === 'object') {
        for (const [type, sec] of Object.entries(src.intervals)) {
            if (cfg.intervals[type] === undefined) continue;
            cfg.intervals[type] = Math.max(1, Number.parseInt(sec, 10) || cfg.intervals[type] || 1);
        }
        cfg.intervals = normalizeIntervals(cfg.intervals);
    } else {
        cfg.intervals = normalizeIntervals(cfg.intervals);
    }

    if (src.friendQuietHours && typeof src.friendQuietHours === 'object') {
        const old = cfg.friendQuietHours || {};
        cfg.friendQuietHours = {
            enabled: src.friendQuietHours.enabled !== undefined ? !!src.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(src.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(src.friendQuietHours.end, old.end || '07:00'),
        };
    }

    if (Array.isArray(src.friendBlacklist)) {
        cfg.friendBlacklist = src.friendBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 天王模式配置持久化
    if (src.theftKing && typeof src.theftKing === 'object') {
        const tk = src.theftKing;
        cfg.theftKing = {
            enabled: !!tk.enabled,
            minPlantLevel: Math.max(1, Number.parseInt(tk.minPlantLevel, 10) || 10),
            maxEnhanced: Math.max(1, Number.parseInt(tk.maxEnhanced, 10) || 10),
            triggerBlocks: Math.max(1, Number.parseInt(tk.triggerBlocks, 10) || 2),
        };
    }
    if (Array.isArray(src.stealWhitelist)) {
        cfg.stealWhitelist = src.stealWhitelist.map(Number).filter(n=>Number.isFinite(n)&&n>0);
    }
    if (Array.isArray(src.careWhitelist)) {
        cfg.careWhitelist = src.careWhitelist.map(Number).filter(n=>Number.isFinite(n)&&n>0);
    }
    return cfg;
}

function getAccountConfigSnapshot(accountId) {
    const id = resolveAccountId(accountId);
    if (!id) return cloneAccountConfig(accountFallbackConfig);
    return normalizeAccountConfig(globalConfig.accountConfigs[id], accountFallbackConfig);
}

function setAccountConfigSnapshot(accountId, nextConfig, persist = true) {
    const id = resolveAccountId(accountId);
    if (!id) {
        accountFallbackConfig = normalizeAccountConfig(nextConfig, accountFallbackConfig);
        globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);
        if (persist) saveGlobalConfig();
        return cloneAccountConfig(accountFallbackConfig);
    }
    globalConfig.accountConfigs[id] = normalizeAccountConfig(nextConfig, accountFallbackConfig);
    if (persist) saveGlobalConfig();
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

function removeAccountConfig(accountId) {
    const id = resolveAccountId(accountId);
    if (!id) return;
    if (globalConfig.accountConfigs[id]) {
        delete globalConfig.accountConfigs[id];
        saveGlobalConfig();
    }
}

function ensureAccountConfig(accountId, options = {}) {
    const id = resolveAccountId(accountId);
    if (!id) return null;
    if (globalConfig.accountConfigs[id]) {
        return cloneAccountConfig(globalConfig.accountConfigs[id]);
    }
    globalConfig.accountConfigs[id] = normalizeAccountConfig(globalConfig.defaultAccountConfig, accountFallbackConfig);
    // 新账号默认不施肥（不受历史 defaultAccountConfig 旧值影响）
    if (globalConfig.accountConfigs[id] && globalConfig.accountConfigs[id].automation) {
        globalConfig.accountConfigs[id].automation.fertilizer = 'none';
    }
    if (options.persist !== false) saveGlobalConfig();
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

// 加载全局配置
function loadGlobalConfig() {
    ensureDataDir();
    try {
        const data = readJsonFile(STORE_FILE, () => ({}));
        if (data && typeof data === 'object') {
            if (data.defaultAccountConfig && typeof data.defaultAccountConfig === 'object') {
                accountFallbackConfig = normalizeAccountConfig(data.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
            } else {
                accountFallbackConfig = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
            }
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

            const cfgMap = (data.accountConfigs && typeof data.accountConfigs === 'object')
                ? data.accountConfigs
                : {};
            globalConfig.accountConfigs = {};
            for (const [id, cfg] of Object.entries(cfgMap)) {
                const sid = String(id || '').trim();
                if (!sid) continue;
                globalConfig.accountConfigs[sid] = normalizeAccountConfig(cfg, accountFallbackConfig);
            }
            // 统一规范化，确保内存中不残留旧字段（如 automation.friend）
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);
            for (const [id, cfg] of Object.entries(globalConfig.accountConfigs)) {
                globalConfig.accountConfigs[id] = normalizeAccountConfig(cfg, accountFallbackConfig);
            }
            globalConfig.ui = { ...globalConfig.ui, ...(data.ui || {}) };
            const theme = String(globalConfig.ui.theme || '').toLowerCase();
            globalConfig.ui.theme = ['dark','light','harvest','spring','nightfarm'].includes(theme) ? theme : 'dark';
            globalConfig.offlineReminder = normalizeOfflineReminder(data.offlineReminder);
            if (typeof data.adminPasswordHash === 'string') {
                globalConfig.adminPasswordHash = data.adminPasswordHash;
            }
            if (data.registerConfig && typeof data.registerConfig === 'object') {
                globalConfig.registerConfig = normalizeRegisterConfig(data.registerConfig);
            }
            if (data.plantBlacklists && typeof data.plantBlacklists === 'object') {
                globalConfig.plantBlacklists = data.plantBlacklists;
            }
            if (data.friendBlacklists && typeof data.friendBlacklists === 'object') {
                globalConfig.friendBlacklists = data.friendBlacklists;
            }
            if (data.vipSmtpConfigs && typeof data.vipSmtpConfigs === 'object') {
                globalConfig.vipSmtpConfigs = data.vipSmtpConfigs;
            }
            if (data.adminSmtpConfig && typeof data.adminSmtpConfig === 'object') {
                globalConfig.adminSmtpConfig = {
                    fromEmail: String(data.adminSmtpConfig.fromEmail || '').trim(),
                    smtpPass: String(data.adminSmtpConfig.smtpPass || '').trim(),
                };
            }
        }
    } catch (e) {
        console.error('加载配置失败:', e.message);
    }
}

function sanitizeGlobalConfigBeforeSave() {
    // default 配置统一白名单净化
    accountFallbackConfig = normalizeAccountConfig(globalConfig.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

    // 每个账号配置也统一净化
    const map = (globalConfig.accountConfigs && typeof globalConfig.accountConfigs === 'object')
        ? globalConfig.accountConfigs
        : {};
    const nextMap = {};
    for (const [id, cfg] of Object.entries(map)) {
        const sid = String(id || '').trim();
        if (!sid) continue;
        nextMap[sid] = normalizeAccountConfig(cfg, accountFallbackConfig);
    }
    globalConfig.accountConfigs = nextMap;
}

// 保存全局配置
function saveGlobalConfig() {
    ensureDataDir();
    try {
        const oldJson = readTextFile(STORE_FILE, '');

        sanitizeGlobalConfigBeforeSave();
        const newJson = JSON.stringify(globalConfig, null, 2);
        
        if (oldJson !== newJson) {
            console.warn('[系统] 正在保存配置到:', STORE_FILE);
            writeJsonFileAtomic(STORE_FILE, globalConfig);
        }
    } catch (e) {
        console.error('保存配置失败:', e.message);
    }
}

function getAdminPasswordHash() {
    return String(globalConfig.adminPasswordHash || '');
}

function setAdminPasswordHash(hash) {
    globalConfig.adminPasswordHash = String(hash || '');
    saveGlobalConfig();
    return globalConfig.adminPasswordHash;
}

// 初始化加载
loadGlobalConfig();

function getAutomation(accountId) {
    return { ...getAccountConfigSnapshot(accountId).automation };
}

function getConfigSnapshot(accountId) {
    const cfg = getAccountConfigSnapshot(accountId);
    return {
        automation: { ...cfg.automation },
        plantingStrategy: cfg.plantingStrategy,
        preferredSeedId: cfg.preferredSeedId,
        intervals: { ...cfg.intervals },
        friendQuietHours: { ...cfg.friendQuietHours },
        friendBlacklist: [...(cfg.friendBlacklist || [])],
        stealWhitelist: [...(cfg.stealWhitelist || [])],
        careWhitelist: [...(cfg.careWhitelist || [])],
        theftKing: cfg.theftKing ? { ...cfg.theftKing } : undefined,
        ui: { ...globalConfig.ui },
    };
}

function applyConfigSnapshot(snapshot, options = {}) {
    const cfg = snapshot || {};
    const persist = options.persist !== false;
    const accountId = options.accountId;

    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);

    if (cfg.automation && typeof cfg.automation === 'object') {
        for (const [k, v] of Object.entries(cfg.automation)) {
            if (next.automation[k] === undefined) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'none'];
                next.automation[k] = allowed.includes(v) ? v : next.automation[k];
            } else {
                next.automation[k] = !!v;
            }
        }
    }

    if (cfg.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(cfg.plantingStrategy)) {
        next.plantingStrategy = cfg.plantingStrategy;
    }

    if (cfg.preferredSeedId !== undefined && cfg.preferredSeedId !== null) {
        next.preferredSeedId = Math.max(0, Number.parseInt(cfg.preferredSeedId, 10) || 0);
    }

    if (cfg.intervals && typeof cfg.intervals === 'object') {
        for (const [type, sec] of Object.entries(cfg.intervals)) {
            if (next.intervals[type] === undefined) continue;
            next.intervals[type] = Math.max(1, Number.parseInt(sec, 10) || next.intervals[type] || 1);
        }
        next.intervals = normalizeIntervals(next.intervals);
    }

    if (cfg.friendQuietHours && typeof cfg.friendQuietHours === 'object') {
        const old = next.friendQuietHours || {};
        next.friendQuietHours = {
            enabled: cfg.friendQuietHours.enabled !== undefined ? !!cfg.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(cfg.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(cfg.friendQuietHours.end, old.end || '07:00'),
        };
    }

    if (Array.isArray(cfg.friendBlacklist)) {
        next.friendBlacklist = cfg.friendBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }
    if (Array.isArray(cfg.stealWhitelist)) {
        next.stealWhitelist = cfg.stealWhitelist.map(Number).filter(n=>Number.isFinite(n)&&n>0);
    }
    if (Array.isArray(cfg.careWhitelist)) {
        next.careWhitelist = cfg.careWhitelist.map(Number).filter(n=>Number.isFinite(n)&&n>0);
    }
    if (cfg.ui && typeof cfg.ui === 'object') {
        const theme = String(cfg.ui.theme || '').toLowerCase();
        if (['dark','light','harvest','spring','nightfarm'].includes(theme)) {
            globalConfig.ui.theme = theme;
        }
    }

    setAccountConfigSnapshot(accountId, next, false);
    if (persist) saveGlobalConfig();
    return getConfigSnapshot(accountId);
}

function setAutomation(key, value, accountId) {
    return applyConfigSnapshot({ automation: { [key]: value } }, { accountId });
}

function isAutomationOn(key, accountId) {
    return !!getAccountConfigSnapshot(accountId).automation[key];
}

function getPreferredSeed(accountId) {
    return getAccountConfigSnapshot(accountId).preferredSeedId;
}

function getPlantingStrategy(accountId) {
    return getAccountConfigSnapshot(accountId).plantingStrategy;
}

function getIntervals(accountId) {
    return { ...getAccountConfigSnapshot(accountId).intervals };
}

const INTERVAL_MAX_SEC = 86400;

function normalizeIntervals(intervals) {
    const src = (intervals && typeof intervals === 'object') ? intervals : {};
    const toSec = (v, d) => Math.min(INTERVAL_MAX_SEC, Math.max(1, Number.parseInt(v, 10) || d));
    const farm = toSec(src.farm, 2);
    const friend = toSec(src.friend, 10);

    let farmMin = toSec(src.farmMin, farm);
    let farmMax = toSec(src.farmMax, farm);
    if (farmMin > farmMax) [farmMin, farmMax] = [farmMax, farmMin];

    let friendMin = toSec(src.friendMin, friend);
    let friendMax = toSec(src.friendMax, friend);
    if (friendMin > friendMax) [friendMin, friendMax] = [friendMax, friendMin];

    return {
        ...src,
        farm,
        friend,
        farmMin,
        farmMax,
        friendMin,
        friendMax,
    };
}

function normalizeTimeString(v, fallback) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return fallback;
    const hh = Math.max(0, Math.min(23, Number.parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, Number.parseInt(m[2], 10)));
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getFriendQuietHours(accountId) {
    return { ...getAccountConfigSnapshot(accountId).friendQuietHours };
}

function getFriendBlacklist(accountId) {
    return [...(getAccountConfigSnapshot(accountId).friendBlacklist || [])];
}

function setFriendBlacklist(accountId, list) {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.friendBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.friendBlacklist];
}


function getStealWhitelist(accountId) {
    return [...(getAccountConfigSnapshot(accountId).stealWhitelist || [])];
}

function setStealWhitelist(accountId, list) {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.stealWhitelist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.stealWhitelist];
}

function getCareWhitelist(accountId) {
    return [...(getAccountConfigSnapshot(accountId).careWhitelist || [])];
}

function setCareWhitelist(accountId, list) {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.careWhitelist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.careWhitelist];
}
function getUI() {
    return { ...globalConfig.ui };
}

function setUITheme(theme) {
    const t = String(theme || '').toLowerCase();
    const VALID = ['dark','light','harvest','spring','nightfarm'];
    const next = VALID.includes(t) ? t : 'dark';
    return applyConfigSnapshot({ ui: { theme: next } });
}

function getOfflineReminder() {
    return normalizeOfflineReminder(globalConfig.offlineReminder);
}

function setOfflineReminder(cfg) {
    const current = normalizeOfflineReminder(globalConfig.offlineReminder);
    globalConfig.offlineReminder = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
    saveGlobalConfig();
    return getOfflineReminder();
}

// ============ 账号管理 ============
function loadAccounts() {
    ensureDataDir();
    const data = readJsonFile(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
    return normalizeAccountsData(data);
}

function saveAccounts(data) {
    ensureDataDir();
    writeJsonFileAtomic(ACCOUNTS_FILE, normalizeAccountsData(data));
}

function getAccounts() {
    return loadAccounts();
}

function normalizeAccountsData(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const maxId = accounts.reduce((m, a) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (accounts.length === 0) nextId = 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

function addOrUpdateAccount(acc) {
    const data = normalizeAccountsData(loadAccounts());
    let touchedAccountId = '';
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            const existing = data.accounts[idx];
            const merged = { ...existing, ...acc, name: acc.name !== undefined ? acc.name : existing.name, updatedAt: Date.now() };
            // 保留原有 userId（不允许通过更新操作清除账号归属）
            if (!merged.userId && existing.userId) merged.userId = existing.userId;
            data.accounts[idx] = merged;
            touchedAccountId = String(data.accounts[idx].id || '');
        }
    } else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        const newAccEntry = {
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        if (acc.userId) newAccEntry.userId = String(acc.userId);
        data.accounts.push(newAccEntry);
    }
    saveAccounts(data);
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    return data;
}

function deleteAccount(id) {
    const data = normalizeAccountsData(loadAccounts());
    const target = data.accounts.find(a => a.id === String(id));
    if (!target) {
        saveAccounts(data);
        return data;
    }
    // 软删除：标记 deletedAt + expireAt（2天后）
    if (!target.deletedAt) {
        const now = Date.now();
        target.deletedAt = now;
        target.expireAt = now + 2 * 24 * 3600 * 1000;
        saveAccounts(data);
        return data;
    }
    // 已软删且过期：真正删除
    if (Date.now() >= target.expireAt) {
        data.accounts = data.accounts.filter(a => a.id !== String(id));
        if (data.accounts.length === 0) data.nextId = 1;
        saveAccounts(data);
        removeAccountConfig(id);
    }
    return data;
}

function forceDeleteAccount(id) {
    const data = normalizeAccountsData(loadAccounts());
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) data.nextId = 1;
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}

function cleanupExpiredAccounts() {
    const data = normalizeAccountsData(loadAccounts());
    const now = Date.now();
    const before = data.accounts.length;
    data.accounts = data.accounts.filter(a => {
        if (!a.deletedAt) return true;
        return now < (a.expireAt || (a.deletedAt + 2 * 24 * 3600 * 1000));
    });
    if (data.accounts.length !== before) {
        saveAccounts(data);
    }
}

// ============ 黑名单 ============
const FRUIT_SELL_BLACKLIST_KEY = '__fruit_sell__';

function getPlantBlacklist(accountId) {
    const id = String(accountId || '').trim();
    if (!id) return [];
    return Array.isArray(globalConfig.plantBlacklists[id]) ? [...globalConfig.plantBlacklists[id]] : [];
}

function setPlantBlacklist(accountId, plantIds) {
    const id = String(accountId || '').trim();
    if (!id) return [];
    globalConfig.plantBlacklists[id] = (Array.isArray(plantIds) ? plantIds : []).map(String);
    saveGlobalConfig();
    return [...globalConfig.plantBlacklists[id]];
}

function getFruitSellBlacklist(accountId) {
    const id = String(accountId || '').trim();
    // 有账号ID时使用账号独立key，否则回退全局key
    const key = id ? ('__fruit_sell__:' + id) : FRUIT_SELL_BLACKLIST_KEY;
    return getPlantBlacklist(key);
}

function setFruitSellBlacklist(names, accountId) {
    const id = String(accountId || '').trim();
    const key = id ? ('__fruit_sell__:' + id) : FRUIT_SELL_BLACKLIST_KEY;
    return setPlantBlacklist(key, names);
}

function getFriendBlacklistMulti(accountId) {
    const id = String(accountId || '').trim();
    if (!id) return { noSteal: [], noHelp: [] };
    const bl = globalConfig.friendBlacklists[id];
    if (!bl || typeof bl !== 'object') return { noSteal: [], noHelp: [] };
    return {
        noSteal: Array.isArray(bl.noSteal) ? [...bl.noSteal] : [],
        noHelp: Array.isArray(bl.noHelp) ? [...bl.noHelp] : [],
    };
}

function setFriendBlacklistMulti(accountId, cfg) {
    const id = String(accountId || '').trim();
    if (!id) return { noSteal: [], noHelp: [] };
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    globalConfig.friendBlacklists[id] = {
        noSteal: (Array.isArray(src.noSteal) ? src.noSteal : []).map(String),
        noHelp: (Array.isArray(src.noHelp) ? src.noHelp : []).map(String),
    };
    saveGlobalConfig();
    return { ...globalConfig.friendBlacklists[id] };
}

// ============ 注册配置 ============
function normalizeRegisterConfig(src) {
    const s = (src && typeof src === 'object') ? src : {};
    // inviteCodes: [{ code, maxUses, usedCount }]
    let inviteCodes = [];
    if (Array.isArray(s.inviteCodes)) {
        inviteCodes = s.inviteCodes
            .filter(ic => ic && String(ic.code || '').trim())
            .map(ic => ({
                code: String(ic.code).trim(),
                maxUses: Math.max(0, Number.parseInt(ic.maxUses, 10) || 0),
                usedCount: Math.max(0, Number.parseInt(ic.usedCount, 10) || 0),
            }));
    }
    // 兼容旧版单邀请码字段
    const legacyCode = String(s.inviteCode || '').trim();
    if (legacyCode && !inviteCodes.some(ic => ic.code === legacyCode)) {
        inviteCodes.push({ code: legacyCode, maxUses: 0, usedCount: 0 });
    }
    return {
        enabled: !!s.enabled,
        inviteCode: legacyCode, // 兼容字段
        inviteCodes,
        maxUsers: Math.max(0, Number.parseInt(s.maxUsers, 10) || 0),
    };
}

function getRegisterConfig() {
    return { ...globalConfig.registerConfig, inviteCodes: [...(globalConfig.registerConfig.inviteCodes || [])] };
}

function setRegisterConfig(cfg) {
    globalConfig.registerConfig = normalizeRegisterConfig({ ...globalConfig.registerConfig, ...(cfg || {}) });
    saveGlobalConfig();
    return getRegisterConfig();
}

/** 使用邀请码（成功返回 true，失败返回 false） */
function consumeInviteCode(code) {
    const codes = globalConfig.registerConfig.inviteCodes || [];
    const idx = codes.findIndex(ic => ic.code === String(code || '').trim());
    if (idx < 0) return false; // 不存在
    const ic = codes[idx];
    if (ic.maxUses > 0 && ic.usedCount >= ic.maxUses) return false; // 已用完
    codes[idx] = { ...ic, usedCount: ic.usedCount + 1 };
    saveGlobalConfig();
    return true;
}

/** 校验邀请码是否可用（不消耗） */
function validateInviteCode(code) {
    const cfg = globalConfig.registerConfig;
    if (!cfg.inviteCodes || cfg.inviteCodes.length === 0) {
        // 无配置邀请码 => 也要看 legacyCode
        if (!cfg.inviteCode) return true; // 无需邀请码
        return String(code || '') === cfg.inviteCode;
    }
    const ic = cfg.inviteCodes.find(c => c.code === String(code || '').trim());
    if (!ic) return false;
    if (ic.maxUses > 0 && ic.usedCount >= ic.maxUses) return false;
    return true;
}

// ============ VIP SMTP 配置 ============
function getVipSmtpConfig(userId) {
    const id = String(userId || '').trim();
    if (!id) return null;
    return globalConfig.vipSmtpConfigs[id] || null;
}

function setVipSmtpConfig(userId, cfg) {
    const id = String(userId || '').trim();
    if (!id) return null;
    const src = (cfg && typeof cfg === 'object') ? cfg : {};
    const current = globalConfig.vipSmtpConfigs[id] || {};
    globalConfig.vipSmtpConfigs[id] = {
        qq: src.qq !== undefined ? String(src.qq || '').trim() : String(current.qq || '').trim(),
        notifyOffline: src.notifyOffline !== undefined ? !!src.notifyOffline : (current.notifyOffline !== undefined ? !!current.notifyOffline : true),
        notifyMature: src.notifyMature !== undefined ? !!src.notifyMature : (current.notifyMature !== undefined ? !!current.notifyMature : false),
    };
    saveGlobalConfig();
    return { ...globalConfig.vipSmtpConfigs[id] };
}

// ============ 管理员 SMTP 发件配置 ============
function getAdminSmtpConfig() {
    return { ...globalConfig.adminSmtpConfig };
}

function setAdminSmtpConfig(cfg) {
    const src = (cfg && typeof cfg === 'object') ? cfg : {};
    globalConfig.adminSmtpConfig = {
        fromEmail: src.fromEmail !== undefined ? String(src.fromEmail || '').trim() : globalConfig.adminSmtpConfig.fromEmail,
        smtpPass: src.smtpPass !== undefined ? String(src.smtpPass || '').trim() : globalConfig.adminSmtpConfig.smtpPass,
    };
    saveGlobalConfig();
    return { ...globalConfig.adminSmtpConfig };
}

// ============ 用户系统 ============
function _loadUsers() {
    ensureDataDir();
    try {
        if (fs.existsSync(USERS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            if (raw && Array.isArray(raw.users)) return raw;
        }
    } catch (e) { /* ignore */ }
    return { users: [], nextId: 1 };
}

function _saveUsers(data) {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function _ensureAdminUser() {
    const data = _loadUsers();
    if (data.users.length === 0) {
        // 首次：创建默认 admin，密码 'admin'
        const crypto = require('node:crypto');
        const hash = crypto.createHash('sha256').update('admin').digest('hex');
        data.users.push({ id: '1', username: 'admin', passwordHash: hash, role: 'admin', createdAt: Date.now(), updatedAt: Date.now() });
        data.nextId = 2;
        _saveUsers(data);
    }
    return data;
}

function getUsers() {
    return _ensureAdminUser();
}

function getUserByUsername(username) {
    const data = _ensureAdminUser();
    return data.users.find(u => u.username === String(username || '').trim());
}

function getUserById(id) {
    const data = _ensureAdminUser();
    return data.users.find(u => String(u.id) === String(id));
}

function addUser({ username, passwordHash, role }) {
    const data = _ensureAdminUser();
    const name = String(username || '').trim();
    if (!name) throw new Error('用户名不能为空');
    if (data.users.find(u => u.username === name)) throw new Error('用户名已存在');
    const id = String(data.nextId++);
    const validRole = (role === 'admin' || role === 'vip') ? role : 'user';
    const newUser = { id, username: name, passwordHash: String(passwordHash || ''), role: validRole, createdAt: Date.now(), updatedAt: Date.now() };
    data.users.push(newUser);
    _saveUsers(data);
    return newUser;
}

function updateUser(id, updates) {
    const data = _ensureAdminUser();
    const idx = data.users.findIndex(u => String(u.id) === String(id));
    if (idx < 0) throw new Error('用户不存在');
    if (updates.username) {
        const conflict = data.users.find(u => u.username === updates.username && String(u.id) !== String(id));
        if (conflict) throw new Error('用户名已存在');
    }
    data.users[idx] = { ...data.users[idx], ...updates, id: data.users[idx].id, updatedAt: Date.now() };
    _saveUsers(data);
    return data.users[idx];
}

function deleteUser(id) {
    const data = _ensureAdminUser();
    const target = data.users.find(u => String(u.id) === String(id));
    if (!target) throw new Error('用户不存在');
    const admins = data.users.filter(u => u.role === 'admin');
    if (target.role === 'admin' && admins.length <= 1) throw new Error('不能删除最后一个管理员');
    data.users = data.users.filter(u => String(u.id) !== String(id));
    _saveUsers(data);
    // 级联删除该用户的 QQ 账号
    const accData = normalizeAccountsData(loadAccounts());
    accData.accounts = accData.accounts.filter(a => String(a.userId) !== String(id));
    if (accData.accounts.length === 0) accData.nextId = 1;
    saveAccounts(accData);
    return true;
}

/**
 * 管理员专用：将账号转移到指定用户下（修改 userId 归属）
 * @param {string} accountId - 账号 ID
 * @param {string|null} newUserId - 目标用户 ID，null 表示清除归属（无主账号）
 * @returns {{ ok: boolean, error?: string }}
 */
function rebindAccount(accountId, newUserId) {
    const data = normalizeAccountsData(loadAccounts());
    const idx = data.accounts.findIndex(a => String(a.id) === String(accountId));
    if (idx < 0) return { ok: false, error: '账号不存在' };
    const acc = data.accounts[idx];
    if (newUserId) {
        acc.userId = String(newUserId);
    } else {
        delete acc.userId;
    }
    acc.updatedAt = Date.now();
    saveAccounts(data);
    return { ok: true };
}

function getAccountsByUserId(userId) {
    const data = normalizeAccountsData(loadAccounts());
    return data.accounts.filter(a => String(a.userId) === String(userId));
}

module.exports = {
    getConfigSnapshot,
    applyConfigSnapshot,
    getAutomation,
    setAutomation,
    isAutomationOn,
    getPreferredSeed,
    getPlantingStrategy,
    getIntervals,
    getFriendQuietHours,
    getFriendBlacklist,
    setFriendBlacklist,
    getStealWhitelist,
    setStealWhitelist,
    getCareWhitelist,
    setCareWhitelist,
    getUI,
    setUITheme,
    getOfflineReminder,
    setOfflineReminder,
    getAccounts,
    addOrUpdateAccount,
    deleteAccount,
    forceDeleteAccount,
    cleanupExpiredAccounts,
    getAdminPasswordHash,
    setAdminPasswordHash,
    // 黑名单
    getPlantBlacklist,
    setPlantBlacklist,
    getFruitSellBlacklist,
    setFruitSellBlacklist,
    getFriendBlacklistMulti,
    setFriendBlacklistMulti,
    // 注册配置
    getRegisterConfig,
    setRegisterConfig,
    consumeInviteCode,
    validateInviteCode,
    // 天王模式
    getTheftKingConfig,
    setTheftKingConfig,
    // 用户系统
    getUsers,
    getUserByUsername,
    getUserById,
    addUser,
    updateUser,
    deleteUser,
    getAccountsByUserId,
    rebindAccount,
    // VIP SMTP
    getVipSmtpConfig,
    setVipSmtpConfig,
    // 管理员 SMTP 发件配置
    getAdminSmtpConfig,
    setAdminSmtpConfig,
    // 账号配置快照（供合并账号等场景使用）
    getAccountConfigSnapshot,
    setAccountConfigSnapshot,
};
