/**
 * 防挂模块
 * - 被动测挂：10级以上作物被有机化肥催熟，成熟后30秒内被偷，当天累计≥5次 → 标记挂狗
 * - 主动测挂：用户开启后，10小时内随机催熟5次（每次不同地块，间隔≥1小时），某好友≥3次在30秒内偷 → 标记挂狗
 * - 偷挂狗模式：对挂狗好友专用偷菜，不影响其他好友
 * - 挂狗名单：每账号独立存储
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { log, logWarn, getServerTimeSec, toNum, sleep } = require('../utils/utils');
const { createScheduler } = require('./scheduler');

// ============ 常量 ============
const PASSIVE_DAILY_THRESHOLD = 5;      // 被动测挂：每天被偷次数阈值
const ACTIVE_TOTAL_ROUNDS = 5;          // 主动测挂：总共催熟次数
const ACTIVE_HIT_THRESHOLD = 3;         // 主动测挂：5次中至少3次被偷才标记
const ACTIVE_MIN_INTERVAL_MS = 60 * 60 * 1000;   // 主动测挂：两次催熟间隔≥1小时
const ACTIVE_TOTAL_WINDOW_MS = 10 * 60 * 60 * 1000; // 主动测挂：10小时内完成
const STEAL_WINDOW_SEC = 30;            // 成熟后30秒内被偷才算
const MIN_PLANT_LEVEL = 10;             // 10级以上作物才纳入判定

// ============ 数据文件 ============
function getAntiafkFile(accountId) {
    ensureDataDir();
    return getDataFile(`antiafk_${String(accountId || 'default')}.json`);
}

const DEFAULT_DATA = () => ({
    dogs: {},         // { [gid]: { name, markedAt, reason, removed } }
    config: {
        activeTestEnabled: false,
        stealDogsEnabled: false,
    },
    // 被动测挂：每天被偷统计 { [gid]: { [date]: count } }
    passiveLog: {},
    // 主动测挂会话（运行时内存+持久化）
    activeSession: null,
    /*
     activeSession 结构：
     {
       startedAt: ms,          // 开始时间
       rounds: [               // 已完成的催熟轮次
         { landId, matureAt, stealerGids: [gid,...], roundIndex }
       ],
       pendingRound: null,     // 当前轮次（等待观察）
       done: false,            // 是否已结束
     }
    */
});

// 内存缓存：accountId -> data
const cache = {};

function loadData(accountId) {
    const id = String(accountId || '');
    if (cache[id]) return cache[id];
    try {
        const file = getAntiafkFile(id);
        if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            const d = DEFAULT_DATA();
            if (raw && typeof raw === 'object') {
                if (raw.dogs && typeof raw.dogs === 'object') d.dogs = raw.dogs;
                if (raw.config && typeof raw.config === 'object') d.config = { ...d.config, ...raw.config };
                if (raw.passiveLog && typeof raw.passiveLog === 'object') d.passiveLog = raw.passiveLog;
                if (raw.activeSession && typeof raw.activeSession === 'object') d.activeSession = raw.activeSession;
            }
            cache[id] = d;
            return d;
        }
    } catch (e) {
        logWarn('防挂', `加载数据失败(${accountId}): ${e.message}`);
    }
    cache[id] = DEFAULT_DATA();
    return cache[id];
}

function saveData(accountId) {
    const id = String(accountId || '');
    const d = cache[id];
    if (!d) return;
    try {
        ensureDataDir();
        fs.writeFileSync(getAntiafkFile(id), JSON.stringify(d, null, 2), 'utf8');
    } catch (e) {
        logWarn('防挂', `保存数据失败(${accountId}): ${e.message}`);
    }
}

// ============ 工具 ============
function getBjDate(msSinceEpoch) {
    const ms = msSinceEpoch || Date.now();
    const bjOffset = 8 * 3600 * 1000;
    const bjDate = new Date(ms + bjOffset);
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ============ 被动测挂 ============

/**
 * 记录：有机化肥刚催熟了某地块（level >= 10）
 * 由 farm.js 在有机肥施肥成功后立刻调用
 * @param {string} accountId
 * @param {number} landId
 * @param {number} landLevel  种植需求等级 (land_level_need)
 */
function onOrganicFertApplied(accountId, landId, landLevel) {
    if ((landLevel || 0) < MIN_PLANT_LEVEL) return;
    const d = loadData(accountId);
    if (!d._organicWatchMap) d._organicWatchMap = {};
    d._organicWatchMap[landId] = Date.now();
}

/**
 * 记录：好友 friendGid 偷了 accountId 的 landId 地块
 * 由 farm.js diffLandsAndLog 被偷回调中调用（持续运行，无需开关）
 */
function onBeStolen(accountId, friendGid, friendName, landId) {
    if (!accountId || !friendGid) return;
    const d = loadData(accountId);
    if (!d._organicWatchMap) d._organicWatchMap = {};

    const matureAt = d._organicWatchMap[landId];
    if (!matureAt) return; // 该地块没在有机肥监控名单内

    const now = Date.now();
    const deltaSec = (now - matureAt) / 1000;
    if (deltaSec > STEAL_WINDOW_SEC) return; // 超过30秒

    // 被动计数 +1
    const gidStr = String(toNum(friendGid));
    if (!d.passiveLog[gidStr]) d.passiveLog[gidStr] = {};
    const today = getBjDate(now);
    d.passiveLog[gidStr][today] = (d.passiveLog[gidStr][today] || 0) + 1;

    log('防挂', `被动：${friendName}(${gidStr}) 在30秒内偷了有机催熟地块#${landId}，今日第${d.passiveLog[gidStr][today]}次`, {
        module: 'antiafk', event: 'passive_steal', gid: gidStr, count: d.passiveLog[gidStr][today],
    });

    if (d.passiveLog[gidStr][today] >= PASSIVE_DAILY_THRESHOLD) {
        _markAsDog(d, gidStr, friendName, 'passive', accountId);
    }

    // 主动测挂：如果有进行中的轮次，也记录
    _recordActiveRoundSteal(d, friendGid, landId, now);

    saveData(accountId);
}

// ============ 主动测挂 ============

// 主动测挂调度器（每个账号一个）
const activeSchedulers = {};
function _getActiveScheduler(accountId) {
    if (!activeSchedulers[accountId]) {
        activeSchedulers[accountId] = createScheduler(`antiafk_active_${accountId}`);
    }
    return activeSchedulers[accountId];
}

/**
 * 开启/关闭主动测挂
 */
function setActiveTestEnabled(accountId, enabled) {
    const d = loadData(accountId);
    const was = d.config.activeTestEnabled;
    d.config.activeTestEnabled = !!enabled;

    if (enabled && !was) {
        // 重置会话，开始新一轮
        d.activeSession = {
            startedAt: Date.now(),
            rounds: [],
            pendingRound: null,
            done: false,
        };
        log('防挂', '主动测挂已开启，将在下次农场检查时开始首次催熟', { module: 'antiafk', event: 'active_start' });
        saveData(accountId);
        // 立刻触发一次（延迟5秒，等农场服务可用）
        _getActiveScheduler(accountId).setTimeoutTask('active_first_round', 5000, () => runActiveTestRound(accountId));
    } else if (!enabled && was) {
        d.activeSession = null;
        _getActiveScheduler(accountId).clearAll();
        log('防挂', '主动测挂已关闭', { module: 'antiafk', event: 'active_stop' });
        saveData(accountId);
    } else {
        saveData(accountId);
    }
    return d.config;
}

/**
 * 获取当前有效的10级以上已种植地块列表
 * 需要由 farm.js 的 getAllLands + getPlantById 提供数据
 * 通过注入的 getLandsCallback 获取
 */
let _getLandsCallbacks = {}; // accountId -> async fn(): lands[]

function setGetLandsCallback(accountId, fn) {
    _getLandsCallbacks[accountId] = fn;
}

// 有机施肥回调（由 farm.js 注入）
let _fertilizeCallback = {}; // accountId -> async fn(landId): bool

function setFertilizeCallback(accountId, fn) {
    _fertilizeCallback[accountId] = fn;
}

/**
 * 主动测挂：执行一次催熟轮次
 * 由调度器定期触发，也可由开启时立即调用
 */
async function runActiveTestRound(accountId) {
    const d = loadData(accountId);
    if (!d.config.activeTestEnabled) return;
    if (!d.activeSession || d.activeSession.done) return;

    const sess = d.activeSession;
    const now = Date.now();

    // 超过10小时，结束会话
    if (now - sess.startedAt > ACTIVE_TOTAL_WINDOW_MS) {
        _finalizeActiveSession(d, accountId);
        saveData(accountId);
        return;
    }

    // 已完成5轮
    if (sess.rounds.length >= ACTIVE_TOTAL_ROUNDS && !sess.pendingRound) {
        _finalizeActiveSession(d, accountId);
        saveData(accountId);
        return;
    }

    // 还在等待观察阶段（pendingRound 设置后等30秒）
    if (sess.pendingRound && !sess.pendingRound.observed) {
        // 检查30秒观察窗口是否到期
        if (now - sess.pendingRound.matureAt < STEAL_WINDOW_SEC * 1000) {
            // 还没到期，继续等待
            const remaining = STEAL_WINDOW_SEC * 1000 - (now - sess.pendingRound.matureAt);
            _getActiveScheduler(accountId).setTimeoutTask('active_round', remaining + 2000, () => runActiveTestRound(accountId));
            return;
        }
        // 观察窗口到期，归档当前轮次
        sess.rounds.push({ ...sess.pendingRound, observed: true });
        sess.pendingRound = null;
        saveData(accountId);

        // 检查是否需要继续
        if (sess.rounds.length >= ACTIVE_TOTAL_ROUNDS) {
            _finalizeActiveSession(d, accountId);
            saveData(accountId);
            return;
        }
    }

    // 检查距上次催熟的间隔
    const lastRound = sess.rounds[sess.rounds.length - 1];
    if (lastRound) {
        const elapsed = now - (lastRound.matureAt || lastRound.fertAt || 0);
        if (elapsed < ACTIVE_MIN_INTERVAL_MS) {
            const wait = ACTIVE_MIN_INTERVAL_MS - elapsed;
            log('防挂', `主动测挂：距上次催熟不足1小时，${Math.ceil(wait/60000)}分钟后再执行`, { module: 'antiafk' });
            _getActiveScheduler(accountId).setTimeoutTask('active_round', wait + 1000, () => runActiveTestRound(accountId));
            return;
        }
    }

    // 获取可用地块
    const getLands = _getLandsCallbacks[accountId];
    if (typeof getLands !== 'function') {
        logWarn('防挂', `主动测挂：未注入地块获取函数(${accountId})`);
        return;
    }

    let lands;
    try {
        lands = await getLands();
    } catch (e) {
        logWarn('防挂', `主动测挂：获取地块失败: ${e.message}`);
        _getActiveScheduler(accountId).setTimeoutTask('active_round', 60 * 1000, () => runActiveTestRound(accountId));
        return;
    }

    // 过滤：10级以上、已种植、尚未在本轮次用过
    const usedLandIds = new Set([
        ...(sess.rounds.map(r => r.landId)),
        sess.pendingRound ? sess.pendingRound.landId : null,
    ].filter(Boolean));

    const candidates = (lands || []).filter(l =>
        l.unlocked &&
        l.status === 'growing' &&
        (l.landLevel || l.landsLevel || 0) >= MIN_PLANT_LEVEL &&
        !usedLandIds.has(l.id)
    );

    if (candidates.length === 0) {
        logWarn('防挂', `主动测挂：没有可用的10级以上地块，1小时后重试`);
        _getActiveScheduler(accountId).setTimeoutTask('active_round', ACTIVE_MIN_INTERVAL_MS, () => runActiveTestRound(accountId));
        return;
    }

    // 随机选一块
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const roundIndex = sess.rounds.length + 1;

    log('防挂', `主动测挂第${roundIndex}/${ACTIVE_TOTAL_ROUNDS}轮：对地块#${target.id}(${target.plantName || ''})施有机肥`, { module: 'antiafk', event: 'active_fertilize', landId: target.id, round: roundIndex });

    // 施有机肥
    const doFertilize = _fertilizeCallback[accountId];
    let fertOk = false;
    if (typeof doFertilize === 'function') {
        try {
            fertOk = await doFertilize(target.id);
        } catch (e) {
            logWarn('防挂', `主动测挂：施肥失败: ${e.message}`);
        }
    }

    if (!fertOk) {
        logWarn('防挂', `主动测挂：施肥失败，1小时后重试`);
        _getActiveScheduler(accountId).setTimeoutTask('active_round', ACTIVE_MIN_INTERVAL_MS, () => runActiveTestRound(accountId));
        return;
    }

    // 记录施肥时间（会在 onOrganicFertApplied 里更新 _organicWatchMap，这里也更新pendingRound的matureAt）
    const fertAt = Date.now();
    // 通知被动监控
    if (!d._organicWatchMap) d._organicWatchMap = {};
    d._organicWatchMap[target.id] = fertAt;

    sess.pendingRound = {
        landId: target.id,
        fertAt,
        matureAt: fertAt, // 有机肥会瞬间催熟，所以施肥即成熟
        stealerGids: [],
        roundIndex,
        observed: false,
    };

    saveData(accountId);

    // 等待30秒观察窗口
    _getActiveScheduler(accountId).setTimeoutTask('active_round', STEAL_WINDOW_SEC * 1000 + 2000, () => runActiveTestRound(accountId));
}

/**
 * 主动测挂：在观察窗口内记录被偷（由 onBeStolen 内部调用）
 */
function _recordActiveRoundSteal(d, friendGid, landId, now) {
    if (!d.activeSession || d.activeSession.done) return;
    const pending = d.activeSession.pendingRound;
    if (!pending || pending.observed) return;
    if (pending.landId !== toNum(landId)) return;

    const delta = (now - pending.matureAt) / 1000;
    if (delta > STEAL_WINDOW_SEC) return;

    const gidStr = String(toNum(friendGid));
    if (!pending.stealerGids.includes(gidStr)) {
        pending.stealerGids.push(gidStr);
        log('防挂', `主动测挂第${pending.roundIndex}轮：${gidStr} 在${Math.round(delta)}秒内偷了地块#${landId}`, { module: 'antiafk', event: 'active_steal_hit' });
    }
}

/**
 * 主动测挂：会话结束，统计结果
 */
function _finalizeActiveSession(d, accountId) {
    const sess = d.activeSession;
    if (!sess || sess.done) return;
    sess.done = true;

    // 归档 pendingRound
    if (sess.pendingRound && !sess.pendingRound.observed) {
        sess.rounds.push({ ...sess.pendingRound, observed: true });
        sess.pendingRound = null;
    }

    // 统计每个偷过的好友命中几轮
    const hitMap = {}; // gid -> { count, name }
    for (const round of sess.rounds) {
        for (const gidStr of (round.stealerGids || [])) {
            if (!hitMap[gidStr]) hitMap[gidStr] = { count: 0 };
            hitMap[gidStr].count += 1;
        }
    }

    for (const [gidStr, info] of Object.entries(hitMap)) {
        log('防挂', `主动测挂结束：好友${gidStr} 命中${info.count}/${ACTIVE_TOTAL_ROUNDS}次`, { module: 'antiafk', event: 'active_result', gid: gidStr, hit: info.count });
        if (info.count >= ACTIVE_HIT_THRESHOLD) {
            const friendName = `GID:${gidStr}`;
            _markAsDog(d, gidStr, friendName, 'active', accountId);
        }
    }

    // 自动关闭主动测挂（已完成一轮完整检测）
    d.config.activeTestEnabled = false;
    _getActiveScheduler(accountId).clearAll();
    log('防挂', `主动测挂会话结束，共完成${sess.rounds.length}轮`, { module: 'antiafk', event: 'active_done' });
}

// ============ 挂狗标记 ============

function _markAsDog(d, gidStr, friendName, reason, accountId) {
    if (d.dogs[gidStr] && !d.dogs[gidStr].removed) {
        // 已经是挂狗，更新时间
        d.dogs[gidStr].markedAt = Date.now();
        d.dogs[gidStr].name = friendName || d.dogs[gidStr].name;
        log('防挂', `更新挂狗记录：${friendName}(${gidStr}) reason=${reason}`, { module: 'antiafk', event: 'dog_update', gid: gidStr });
    } else {
        d.dogs[gidStr] = {
            name: friendName,
            markedAt: Date.now(),
            reason,
            removed: false,
        };
        log('防挂', `标记为挂狗：${friendName}(${gidStr}) reason=${reason}`, { module: 'antiafk', event: 'dog_mark', gid: gidStr, reason });
    }
}

// ============ 对外 API ============

/**
 * 获取状态（用于管理面板）
 */
function getStatus(accountId) {
    const d = loadData(accountId);
    const activeDogs = Object.entries(d.dogs)
        .filter(([, v]) => !v.removed)
        .map(([gid, v]) => ({ gid, ...v }));

    const activeSession = d.activeSession ? {
        startedAt: d.activeSession.startedAt,
        roundsDone: d.activeSession.rounds.length,
        totalRounds: ACTIVE_TOTAL_ROUNDS,
        done: !!d.activeSession.done,
        pendingRound: d.activeSession.pendingRound ? {
            landId: d.activeSession.pendingRound.landId,
            roundIndex: d.activeSession.pendingRound.roundIndex,
            matureAt: d.activeSession.pendingRound.matureAt,
            stealCount: (d.activeSession.pendingRound.stealerGids || []).length,
        } : null,
    } : null;

    return {
        config: { ...d.config },
        dogs: activeDogs,
        dogCount: activeDogs.length,
        activeSession,
    };
}

/**
 * 移除挂狗（用户操作，软删除）
 */
function removeDog(accountId, gidStr) {
    const d = loadData(accountId);
    const key = String(gidStr);
    if (!d.dogs[key]) return { ok: false, msg: '该好友不在挂狗名单中' };
    d.dogs[key].removed = true;
    saveData(accountId);
    return { ok: true };
}

/**
 * 设置偷挂狗开关
 */
function setStealDogsEnabled(accountId, enabled) {
    const d = loadData(accountId);
    d.config.stealDogsEnabled = !!enabled;
    saveData(accountId);
    return d.config;
}

/**
 * 查询某 gid 是否是挂狗
 */
function isDog(accountId, friendGid) {
    const d = loadData(accountId);
    const gidStr = String(toNum(friendGid));
    const dog = d.dogs[gidStr];
    return !!(dog && !dog.removed);
}

/**
 * 获取偷挂狗开关
 */
function isStealDogsEnabled(accountId) {
    const d = loadData(accountId);
    return !!d.config.stealDogsEnabled;
}

/**
 * 获取活跃挂狗列表（gid Set）
 */
function getActiveDogGids(accountId) {
    const d = loadData(accountId);
    const set = new Set();
    for (const [gid, v] of Object.entries(d.dogs)) {
        if (!v.removed) set.add(Number(gid));
    }
    return set;
}

/**
 * 恢复主动测挂（重启后恢复未完成的会话）
 */
function resumeActiveTestIfNeeded(accountId) {
    const d = loadData(accountId);
    if (!d.config.activeTestEnabled) return;
    if (!d.activeSession || d.activeSession.done) return;

    const now = Date.now();
    if (now - d.activeSession.startedAt > ACTIVE_TOTAL_WINDOW_MS) {
        // 超时了，直接结束
        _finalizeActiveSession(d, accountId);
        saveData(accountId);
        return;
    }

    log('防挂', `恢复主动测挂会话（已完成${d.activeSession.rounds.length}/${ACTIVE_TOTAL_ROUNDS}轮）`, { module: 'antiafk', event: 'active_resume' });
    // 延迟10秒启动，等待网络连接
    _getActiveScheduler(accountId).setTimeoutTask('active_round', 10 * 1000, () => runActiveTestRound(accountId));
}

module.exports = {
    // 被动监控（由 farm.js 调用）
    onOrganicFertApplied,
    onBeStolen,
    // 主动测挂
    setActiveTestEnabled,
    runActiveTestRound,
    setGetLandsCallback,
    setFertilizeCallback,
    resumeActiveTestIfNeeded,
    // 偷挂狗
    setStealDogsEnabled,
    isStealDogsEnabled,
    isDog,
    getActiveDogGids,
    // 管理
    getStatus,
    removeDog,
    // 常量（供前端展示）
    PASSIVE_DAILY_THRESHOLD,
    ACTIVE_TOTAL_ROUNDS,
    ACTIVE_HIT_THRESHOLD,
    STEAL_WINDOW_SEC,
    MIN_PLANT_LEVEL,
};
