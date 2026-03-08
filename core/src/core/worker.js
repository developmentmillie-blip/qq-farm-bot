const process = require('node:process');
/**
 * 子进程 Worker - 负责运行单个账号的挂机逻辑
 */
const { parentPort, workerData } = require('node:worker_threads');
const { CONFIG } = require('../config/config');
const { getLevelExpProgress } = require('../config/gameConfig');
const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot, getTheftKingConfig } = require('../models/store');
const { checkAndClaimEmails } = require('../services/email');
const { getEmailDailyState } = require('../services/email');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, getLandsDetail, getAvailableSeeds, runFarmOperation, runFertilizerByConfig, setAntiafkAccountId, fertilize, ORGANIC_FERTILIZER_ID } = require('../services/farm');
const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, getFriendsList, getFriendLandsDetail, doFriendOperation, startTheftKingMode, stopTheftKingMode, getTheftKingStatus, setStealNotifyCallback, startStealDogsMode, stopStealDogsMode, setStealDogsAccountId } = require('../services/friend');
const { processInviteCodes } = require('../services/invite');
const { autoBuyOrganicFertilizer, buyFreeGifts, getFreeGiftDailyState } = require('../services/mall');
const { performDailyMonthCardGift, getMonthCardDailyState } = require('../services/monthcard');
const { performDailyOpenServerGift, getOpenServerDailyState } = require('../services/openserver');
const { performDailyVipGift, getVipDailyState } = require('../services/qqvip');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { performDailyShare, getShareDailyState } = require('../services/share');
const { setInitialValues, resetSessionGains, recordOperation, setStatsAccountId, getStats } = require('../services/stats');
const { saveCurrent } = require('../services/persist-stats');
const { initStatusBar, setStatusPlatform, statusData } = require('../services/status');
const { setRecordGoldExpHook } = require('../services/status');
const { cleanupTaskSystem, checkAndClaimTasks, getTaskClaimDailyState, getTaskDailyStateLikeApp, getGrowthTaskStateLikeApp } = require('../services/task');
const { sellAllFruits, getBag, getBagItems, openFertilizerGiftPacksSilently } = require('../services/warehouse');
const { addRanchGold } = require('../services/ranch');
const { connect, cleanup, getWs, getUserState, networkEvents } = require('../utils/network');
const { loadProto } = require('../utils/proto');
const { setLogHook, log, toNum } = require('../utils/utils');

// fork 模式（无 parentPort）下写入 env 供其他模块使用；
// thread 模式下 process.env 是所有线程共享的，不写避免多账号互相覆盖，
// network.js 已改为从 workerData.accountId 固定读取。
if (!parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}

function sendToMaster(payload) {
    if (process.send) {
        process.send(payload);
        return;
    }
    if (parentPort) {
        parentPort.postMessage(payload);
    }
}

function onMasterMessage(handler) {
    if (process.send) {
        process.on('message', handler);
    }
    if (parentPort) {
        parentPort.on('message', handler);
    }
}

function exitWorker(code = 0) {
    if (parentPort) {
        try {
            parentPort.close();
        } catch {}
        return;
    }
    process.exit(code);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLocalDateTime24(date = new Date()) {
    const d = date instanceof Date ? date : new Date();
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

// 捕获日志发送给主进程
setLogHook((tag, msg, isWarn, meta) => {
    sendToMaster({
        type: 'log',
        data: {
            time: formatLocalDateTime24(new Date()),
            tag,
            msg,
            isWarn,
            meta: meta || {},
        }
    });
});

// 捕获金币经验变化
setRecordGoldExpHook((gold, exp) => {
    // 更新内部统计
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);

    // 发送给主进程
    sendToMaster({ type: 'stat_update', data: { gold, exp } });
});

// 天王模式：偷菜失败移出重点名单时，通知主进程触发下线提醒推送
setStealNotifyCallback(({ gid, name, reason, skipCount }) => {
    sendToMaster({
        type: 'steal_notify',
        gid,
        friendName: name,
        reason,       // 'quota_full' | 'request_fail'
        skipCount,
    });
});

let isRunning = false;
let loginReady = false;
let appliedConfigRevision = 0;
let unifiedSchedulerRunning = false;
let farmTaskRunning = false;
let friendTaskRunning = false;
let nextFarmRunAt = 0;
let nextFriendRunAt = 0;
let lastStatusHash = '';
let lastStatusSentAt = 0;
let onSellGain = null;
let onFarmHarvested = null;
let harvestSellRunning = false;
let onWsError = null;
let wsErrorHandledAt = 0;
let lastDailyRunDate = '';
const workerScheduler = createScheduler('worker');

function isDailyRoutineEnabled(auto) {
    const a = (auto && typeof auto === 'object') ? auto : {};
    return !!(a.email && a.free_gifts && a.share_reward && a.vip_gift && a.month_card && a.open_server_gift);
}

function getLocalDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function runDailyRoutines(force = false) {
    if (!loginReady) return;
    const auto = getAutomation();
    try {
        if (auto.email) await checkAndClaimEmails(force);
        if (auto.share_reward) await performDailyShare(force);
        if (auto.month_card) await performDailyMonthCardGift(force);
        if (auto.open_server_gift) await performDailyOpenServerGift(force);
        if (auto.free_gifts) await buyFreeGifts(force);
        if (auto.vip_gift) await performDailyVipGift(force);
    } catch (e) {
        log('系统', `每日任务调度失败: ${e.message}`, { module: 'system', event: 'daily_routine', result: 'error' });
    }
}

function stopDailyRoutineTimer() {
    workerScheduler.clear('daily_routine_interval');
}

function startDailyRoutineTimer() {
    stopDailyRoutineTimer();
    lastDailyRunDate = getLocalDateKey();
    // 新账号登录后按当前设置强制执行一次领取
    runDailyRoutines(true).catch(() => null);
    workerScheduler.setIntervalTask('daily_routine_interval', 30 * 1000, () => {
        if (!loginReady) return;
        const today = getLocalDateKey();
        if (today === lastDailyRunDate) return;
        lastDailyRunDate = today;
        runDailyRoutines(true).catch(() => null);
    });
}

const INTERVAL_MAX_SEC = 86400;

function normalizeIntervalRangeSec(minSec, maxSec, fallbackSec) {
    const fallback = Math.max(1, Number.parseInt(fallbackSec, 10) || 1);
    const clampSec = (v) => Math.min(INTERVAL_MAX_SEC, Math.max(1, Number.parseInt(v, 10) || fallback));
    let min = clampSec(minSec);
    let max = clampSec(maxSec);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals) {
    const data = (intervals && typeof intervals === 'object') ? intervals : {};

    const farmLegacy = Math.max(1, Number.parseInt(data.farm, 10) || 2);
    const farmRange = normalizeIntervalRangeSec(data.farmMin, data.farmMax, farmLegacy);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    const friendLegacy = Math.max(1, Number.parseInt(data.friend, 10) || 10);
    const friendRange = normalizeIntervalRangeSec(data.friendMin, data.friendMax, friendLegacy);
    CONFIG.friendCheckIntervalMin = friendRange.min * 1000;
    CONFIG.friendCheckIntervalMax = friendRange.max * 1000;
    CONFIG.friendCheckInterval = CONFIG.friendCheckIntervalMin;
}

function randomIntervalMs(minMs, maxMs) {
    const minSec = Math.max(1, Math.floor(Math.max(1000, Number(minMs) || 1000) / 1000));
    const maxSec = Math.max(minSec, Math.floor(Math.max(1000, Number(maxMs) || minSec * 1000) / 1000));
    if (maxSec === minSec) return minSec * 1000;
    const sec = minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
    return sec * 1000;
}

function resetUnifiedSchedule() {
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    const friendMs = randomIntervalMs(
        CONFIG.friendCheckIntervalMin || CONFIG.friendCheckInterval || 10000,
        CONFIG.friendCheckIntervalMax || CONFIG.friendCheckInterval || 10000
    );
    const now = Date.now();
    nextFarmRunAt = now + farmMs;
    nextFriendRunAt = now + friendMs;
}

async function runFarmTick(auto) {
    if (farmTaskRunning) return;
    farmTaskRunning = true;
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    try {
        if (auto.farm) await checkFarm();
        if (auto.task) await checkAndClaimTasks();
        if (auto.email) await checkAndClaimEmails();
        if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
        if (auto.fertilizer_buy) await autoBuyOrganicFertilizer();
    } catch (e) {
        log('系统', `农场调度执行失败: ${e.message}`, { module: 'system', event: 'farm_tick', result: 'error' });
    } finally {
        nextFarmRunAt = Date.now() + farmMs;
        farmTaskRunning = false;
    }
}

async function runFriendTick(auto) {
    if (friendTaskRunning) return;
    friendTaskRunning = true;
    const friendMs = randomIntervalMs(
        CONFIG.friendCheckIntervalMin || CONFIG.friendCheckInterval || 10000,
        CONFIG.friendCheckIntervalMax || CONFIG.friendCheckInterval || 10000
    );
    try {
        if (auto.friend_steal || auto.friend_help || auto.friend_bad) await checkFriends();
    } catch (e) {
        log('系统', `好友调度执行失败: ${e.message}`, { module: 'system', event: 'friend_tick', result: 'error' });
    } finally {
        nextFriendRunAt = Date.now() + friendMs;
        friendTaskRunning = false;
    }
}

async function runUnifiedTick() {
    if (!unifiedSchedulerRunning || !loginReady) return;
    const now = Date.now();
    const dueFarm = now >= nextFarmRunAt;
    const dueFriend = now >= nextFriendRunAt;
    if (!dueFarm && !dueFriend) return;

    const auto = getAutomation();
    const tasks = [];
    if (dueFarm) tasks.push(runFarmTick(auto));
    if (dueFriend) tasks.push(runFriendTick(auto));
    await Promise.all(tasks);
}

function scheduleUnifiedNextTick() {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');
    if (!loginReady) return;

    const now = Date.now();
    const nextAt = Math.min(
        Number(nextFarmRunAt) || (now + 1000),
        Number(nextFriendRunAt) || (now + 1000)
    );
    const delayMs = Math.max(1000, nextAt - now); // 最低 1 秒

    workerScheduler.setTimeoutTask('unified_next_tick', delayMs, async () => {
        try {
            await runUnifiedTick();
        } finally {
            scheduleUnifiedNextTick();
        }
    });
}

function startUnifiedScheduler() {
    if (unifiedSchedulerRunning) return;
    unifiedSchedulerRunning = true;
    resetUnifiedSchedule();
    scheduleUnifiedNextTick();
}

function stopUnifiedScheduler() {
    unifiedSchedulerRunning = false;
    farmTaskRunning = false;
    friendTaskRunning = false;
    workerScheduler.clear('unified_next_tick');
}

function applyRuntimeConfig(snapshot, syncNow = false) {
    const prevAuto = getAutomation();
    applyConfigSnapshot(snapshot || {}, { persist: false });
    const rev = Number((snapshot || {}).__revision || 0);
    if (rev > 0) appliedConfigRevision = rev;

    // 优先使用本次下发的间隔，避免 worker 内部 store 漂移导致回退默认值
    const incomingIntervals = (snapshot && snapshot.intervals && typeof snapshot.intervals === 'object')
        ? snapshot.intervals
        : null;
    if (incomingIntervals) {
        applyIntervalsToRuntime(incomingIntervals);
    }

    if (loginReady) {
        refreshFarmCheckLoop(200);
        refreshFriendCheckLoop(200);
        resetUnifiedSchedule();
        scheduleUnifiedNextTick();

        // 保存设置后若“自动处理日常”开启，则立即执行一次
        const hasAutomationPayload = !!(snapshot && snapshot.automation && typeof snapshot.automation === 'object');
        if (hasAutomationPayload) {
            const nextAuto = getAutomation();
            const wasEnabled = isDailyRoutineEnabled(prevAuto);
            const nowEnabled = isDailyRoutineEnabled(nextAuto);
            if (!wasEnabled && nowEnabled) {
                // 保存设置时 /api/automation 可能触发多次 config_sync，这里做防抖且仅关->开触发
                workerScheduler.setTimeoutTask('daily_routine_immediate', 400, () => {
                    runDailyRoutines(true).catch(() => null);
                });
            }

            const prevFertilizerMode = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const nextFertilizerMode = String(nextAuto && nextAuto.fertilizer ? nextAuto.fertilizer : '').toLowerCase();
            const fertilizerChanged = prevFertilizerMode !== nextFertilizerMode;
            if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic')) {
                // 保存设置时 /api/automation 可能连续触发多次 config_sync，这里做防抖为一次立即施肥
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 600, async () => {
                    if (!loginReady) return;
                    try {
                        await runFertilizerByConfig([]);
                    } catch (e) {
                        log('施肥', `保存配置后立即施肥失败: ${e.message}`, {
                            module: 'farm',
                            event: 'fertilize',
                            result: 'error',
                        });
                    }
                });
            }
        }
    }

    if (syncNow) syncStatus();

    // 天王模式配置同步（从 config_sync 带过来的持久化配置）
    if (snapshot && snapshot.theftKingConfig && typeof snapshot.theftKingConfig === 'object') {
        const { setTheftKingConfig } = require('../models/store');
        setTheftKingConfig(undefined, snapshot.theftKingConfig);
    }

    // 天王模式启停
    if (loginReady) {
        const tkCfg = getTheftKingConfig();
        if (tkCfg.enabled) {
            startTheftKingMode();
        } else {
            stopTheftKingMode();
        }
    }
}

// 接收主进程指令
onMasterMessage(async (msg) => {
    try {
        if (msg.type === 'start') {
            await startBot(msg.config);
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            handleApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        }
    } catch (e) {
        sendToMaster({ type: 'error', error: e.message });
    }
});

async function startBot(config) {
    if (isRunning) return;
    isRunning = true;

    const { code, platform, farmInterval, friendInterval } = config;

    CONFIG.platform = platform || 'qq';
    if (farmInterval) {
        CONFIG.farmCheckInterval = farmInterval;
        CONFIG.farmCheckIntervalMin = farmInterval;
        CONFIG.farmCheckIntervalMax = farmInterval;
    }
    if (friendInterval) {
        CONFIG.friendCheckInterval = friendInterval;
        CONFIG.friendCheckIntervalMin = friendInterval;
        CONFIG.friendCheckIntervalMax = friendInterval;
    }

    await loadProto();

    log('系统', '正在连接服务器...');

    // 加载保存的配置
    applyRuntimeConfig(getConfigSnapshot(), false);

    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (payload) => {
        if ((Number(payload?.code) || 0) !== 400) return;
        const now = Date.now();
        if (now - wsErrorHandledAt < 4000) return;
        wsErrorHandledAt = now;
        log('系统', '连接被拒绝，可能需要更新 Code');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: payload?.message || '',
        });
        if (isRunning) {
            workerScheduler.setTimeoutTask('ws_error_cleanup', 1000, () => {
                if (isRunning) cleanup();
            });
        }
    };
    networkEvents.on('ws_error', onWsError);

    networkEvents.on('kickout', onKickout);

    const onLoginSuccess = async () => {
        loginReady = true;
        if (onSellGain) {
            networkEvents.off('sell', onSellGain);
        }
        onSellGain = (deltaGold) => {
            const delta = Number(deltaGold || 0);
            if (!Number.isFinite(delta) || delta <= 0) return;
            recordOperation('sell', 1);
            // 出售果实所得金币同步注入牧场金币
            const accountId = (workerData && workerData.accountId) || process.env.FARM_ACCOUNT_ID;
            if (accountId) addRanchGold(accountId, delta);
        };
        networkEvents.on('sell', onSellGain);

        if (onFarmHarvested) {
            networkEvents.off('farmHarvested', onFarmHarvested);
        }
        onFarmHarvested = async () => {
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await sellAllFruits();
            } catch (e) {
                log('仓库', `收获后自动出售失败: ${e.message}`, { module: 'warehouse', event: 'sell_after_harvest', result: 'error' });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        // 登录后主动拉一次背包，初始化点券(ID:1002)数量
        try {
            const bagReply = await getBag();
            const items = getBagItems(bagReply);
            let coupon = 0;
            for (const it of (items || [])) {
                if (toNum(it && it.id) === 1002) {
                    coupon = toNum(it.count);
                    break;
                }
            }
            const state = getUserState();
            state.coupon = Math.max(0, coupon);
        } catch {
            // ignore
        }
        // 登录成功后，以当前金币/经验/点券作为统计基线，并清空会话增量
        const latest = getUserState();
        const _wdAccountId = (require('worker_threads').workerData || {}).accountId || '';
        setStatsAccountId(_wdAccountId);
        setInitialValues(Number(latest.gold || 0), Number(latest.exp || 0), Number(latest.coupon || 0));
        resetSessionGains();

        // 防挂模块：注入 accountId 和回调
        if (_wdAccountId) {
            try {
                const antiafk = require('../services/antiafk');
                setAntiafkAccountId(_wdAccountId);
                // 注入地块获取函数（供主动测挂随机选地块）
                antiafk.setGetLandsCallback(_wdAccountId, async () => {
                    const reply = await (require('../services/farm').getAllLands)();
                    const { getPlantById } = require('../config/gameConfig');
                    return ((reply && reply.lands) || []).map(land => {
                        const id = require('../utils/utils').toNum(land.id);
                        const plant = land.plant;
                        const plantCfg = plant ? getPlantById(require('../utils/utils').toNum(plant.id)) : null;
                        const landLevel = plantCfg ? (Number(plantCfg.land_level_need) || 0) : 0;
                        const { getCurrentPhase } = require('../services/farm');
                        const { PlantPhase } = require('../config/config');
                        let status = 'empty';
                        if (plant && plant.phases && plant.phases.length > 0) {
                            const cp = getCurrentPhase(plant.phases, false, '');
                            if (cp) {
                                const pv = require('../utils/utils').toNum(cp.phase);
                                if (pv === PlantPhase.MATURE) status = 'mature';
                                else if (pv === PlantPhase.DEAD) status = 'dead';
                                else status = 'growing';
                            }
                        }
                        return { id, unlocked: !!land.unlocked, status, landsLevel: landLevel, plantName: (plant && plant.name) || '' };
                    });
                });
                // 注入有机施肥函数
                antiafk.setFertilizeCallback(_wdAccountId, async (landId) => {
                    try {
                        const { toLong } = require('../utils/utils');
                        const { sendMsgAsync } = require('../utils/network');
                        const { types } = require('../utils/proto');
                        const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                            land_ids: [toLong(landId)],
                            fertilizer_id: toLong(ORGANIC_FERTILIZER_ID),
                        })).finish();
                        await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
                        // 通知 farm.js 的防挂钩子
                        antiafk.onOrganicFertApplied(_wdAccountId, landId, 10); // level=10 占位，主动测挂已过滤过
                        return true;
                    } catch { return false; }
                });
                // 恢复未完成的主动测挂会话
                antiafk.resumeActiveTestIfNeeded(_wdAccountId);
                // 恢复偷挂狗模式
                setStealDogsAccountId(_wdAccountId);
                if (antiafk.isStealDogsEnabled(_wdAccountId)) {
                    startStealDogsMode(_wdAccountId);
                }
            } catch (e) {
                // 防挂模块初始化失败不影响主流程
            }
        }

        // 登录成功后启动各模块
        await processInviteCodes();
        if (getAutomation().fertilizer_gift) {
            await openFertilizerGiftPacksSilently().catch(() => 0);
        }
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });
        // 天王模式：延迟 20s 启动，确保登录后状态稳定
        if (getTheftKingConfig().enabled) {
            workerScheduler.setTimeoutTask('theft_king_auto_start', 20000, () => {
                if (getTheftKingConfig().enabled) {
                    log('天王', '上线 20s 后自动恢复天王模式', { module: 'theft_king', event: 'auto_restore' });
                    startTheftKingMode();
                }
            });
        }
        startUnifiedScheduler();
        // 每日礼包/任务改为跨日调度，不在农场轮询内执行
        startDailyRoutineTimer();

        // 立即发送一次状态
        syncStatus();
    };

    connect(code, onLoginSuccess);

    // 启动定时状态同步
    workerScheduler.setIntervalTask('status_sync', 3000, syncStatus, { preventOverlap: true });

    // 每5分钟持久化一次统计（避免重启丢失）
    workerScheduler.setIntervalTask('stats_persist', 300000, () => {
        try {
            const s = getStats(null, null, false, null);
            if (_wdAccountId) saveCurrent(_wdAccountId, s.operations || {}, { goldGained: s.sessionGoldGained || 0, expGained: s.sessionExpGained || 0, couponGained: s.sessionCouponGained || 0 });
        } catch {}
    });
}

async function stopBot() {
    if (!isRunning) return exitWorker(0);
    isRunning = false;
    loginReady = false;
    stopUnifiedScheduler();
    networkEvents.off('kickout', onKickout);
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopTheftKingMode();
    stopDailyRoutineTimer();
    cleanupTaskSystem();
    workerScheduler.clearAll();
    cleanup();
    const ws = getWs();
    if (ws) ws.close();
    exitWorker(0);
}

function onKickout(payload) {
    const reason = payload && payload.reason ? payload.reason : '未知';
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${reason}`);
    sendToMaster({ type: 'account_kicked', reason });
    workerScheduler.setTimeoutTask('kickout_stop', 200, () => {
        stopBot().catch(() => exitWorker(0));
    });
}

// 处理来自 Admin 面板的直接调用请求 (如: 购买种子、开关设置等)
async function handleApiCall(msg) {
    const { id, method, args } = msg;
    let result = null;
    let error = null;

    try {
        switch (method) {
            case 'getLands':
                result = await getLandsDetail();
                break;
            case 'getFriends':
                result = await getFriendsList();
                break;
            case 'getFriendLands':
                result = await getFriendLandsDetail(args[0]);
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1]);
                break;
            case 'getSeeds':
                result = await getAvailableSeeds();
                break;
            case 'getBag':
                result = await require('../services/warehouse').getBagDetail();
                break;
            case 'sellBagItems': {
                const { sellItems, deriveGoldGainFromSellReply, getCurrentTotals } = require('../services/warehouse');
                const sellPayload = (args && args[0]) || [];
                const goldBefore = getCurrentTotals().gold;
                const reply = await sellItems(sellPayload);
                const { gain } = deriveGoldGainFromSellReply(reply, goldBefore);
                result = { reply, gold: gain > 0 ? gain : null };
                break;
            }
            case 'useBagItem': {
                const { useItem } = require('../services/warehouse');
                const useItemId = Number(args && args[0]) || 0;
                const useCount = Number(args && args[1]) || 1;
                result = await useItem(useItemId, useCount, []);
                break;
            }
            case 'setAutomation': {
                const payload = args && args[0] ? args[0] : {};
                applyRuntimeConfig({ automation: { [payload.key]: payload.value } }, true);
                result = getAutomation();
                break;
            }
            case 'doFarmOp': {
                const farmOpResult = await runFarmOperation(args[0]); // opType
                // 只向 master 传轻量字段，避免 status 大对象序列化超时
                result = { hadWork: !!(farmOpResult && farmOpResult.hadWork), actions: (farmOpResult && farmOpResult.actions) || [] };
                break;
            }
            case 'getAnalytics': {
                const { getPlantRankings } = require('../services/analytics');
                result = getPlantRankings(args[0]); // sortBy
                break;
            }
            case 'getDailyGiftOverview':
                result = await getDailyGiftOverview();
                break;
            case 'getSchedulers':
                result = getSchedulerRegistrySnapshot();
                break;
            case 'getTheftKingStatus':
                result = getTheftKingStatus();
                break;
            case 'setTheftKingConfig': {
                const tkPayload = args && args[0] ? args[0] : {};
                const { setTheftKingConfig } = require('../models/store');
                setTheftKingConfig(undefined, tkPayload);
                const tkCfg = getTheftKingConfig();
                if (loginReady) {
                    if (tkCfg.enabled) { startTheftKingMode(); } else { stopTheftKingMode(); }
                }
                result = tkCfg;
                break;
            }
            default:
                error = 'Unknown method';
        }
    } catch (e) {
        error = e.message;
    }

    sendToMaster({ type: 'api_response', id, result, error });
}

async function getDailyGiftOverview() {
    const auto = getAutomation() || {};
    const task = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp()
        : (getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 });
    const growthTask = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp()
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };
    const email = getEmailDailyState ? getEmailDailyState() : { doneToday: false, lastCheckAt: 0 };
    const free = getFreeGiftDailyState ? getFreeGiftDailyState() : { doneToday: false, lastClaimAt: 0 };
    const share = getShareDailyState ? getShareDailyState() : { doneToday: false, lastClaimAt: 0 };
    const vip = getVipDailyState ? getVipDailyState() : { doneToday: false, lastClaimAt: 0 };
    const month = getMonthCardDailyState ? getMonthCardDailyState() : { doneToday: false, lastClaimAt: 0 };
    const openServer = getOpenServerDailyState ? getOpenServerDailyState() : { doneToday: false, lastClaimAt: 0, lastCheckAt: 0 };

    return {
        date: new Date().toISOString().slice(0, 10),
        growth: {
            key: 'growth_task',
            label: '成长任务',
            doneToday: !!growthTask.doneToday,
            completedCount: Number(growthTask.completedCount || 0),
            totalCount: Number(growthTask.totalCount || 0),
            tasks: Array.isArray(growthTask.tasks) ? growthTask.tasks : [],
        },
        gifts: [
            {
                key: 'task_claim',
                label: '每日任务',
                enabled: !!auto.task,
                doneToday: !!task.doneToday,
                lastAt: Number(task.lastClaimAt || 0),
                completedCount: Number(task.completedCount || 0),
                totalCount: Number(task.totalCount || 3),
            },
            { key: 'email_rewards', label: '邮箱奖励', enabled: !!auto.email, doneToday: !!email.doneToday, lastAt: Number(email.lastCheckAt || 0) },
            { key: 'mall_free_gifts', label: '商城免费礼包', enabled: !!auto.free_gifts, doneToday: !!free.doneToday, lastAt: Number(free.lastClaimAt || 0) },
            { key: 'daily_share', label: '分享礼包', enabled: !!auto.share_reward, doneToday: !!share.doneToday, lastAt: Number(share.lastClaimAt || 0) },
            {
                key: 'vip_daily_gift',
                label: '会员礼包',
                enabled: !!auto.vip_gift,
                doneToday: !!vip.doneToday,
                lastAt: Number(vip.lastClaimAt || vip.lastCheckAt || 0),
                hasGift: Object.prototype.hasOwnProperty.call(vip, 'hasGift') ? !!vip.hasGift : undefined,
                canClaim: Object.prototype.hasOwnProperty.call(vip, 'canClaim') ? !!vip.canClaim : undefined,
                result: vip.result || '',
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: !!auto.month_card,
                doneToday: !!month.doneToday,
                lastAt: Number(month.lastClaimAt || month.lastCheckAt || 0),
                hasCard: Object.prototype.hasOwnProperty.call(month, 'hasCard') ? !!month.hasCard : undefined,
                hasClaimable: Object.prototype.hasOwnProperty.call(month, 'hasClaimable') ? !!month.hasClaimable : undefined,
                result: month.result || '',
            },
            {
                key: 'open_server_gift',
                label: '开服红包',
                enabled: !!auto.open_server_gift,
                doneToday: !!openServer.doneToday,
                lastAt: Number(openServer.lastClaimAt || openServer.lastCheckAt || 0),
                hasClaimable: Object.prototype.hasOwnProperty.call(openServer, 'hasClaimable') ? !!openServer.hasClaimable : undefined,
                result: openServer.result || '',
            },
        ],
    };
}

function syncStatus() {
    if (!process.send && !parentPort) return;

    const userState = getUserState();
    const ws = getWs();
    const connected = !!(loginReady && ws && ws.readyState === 1);

    let expProgress = null;
    const level = (userState.level ?? statusData.level ?? 0);
    const exp = (userState.exp ?? statusData.exp ?? 0);

    if (level > 0 && exp >= 0) {
        expProgress = getLevelExpProgress(level, exp);
    }

    const limits = require('../services/friend').getOperationLimits();
    const fullStats = require('../services/stats').getStats(statusData, userState, connected, limits);
    const nowMs = Date.now();
    fullStats.nextChecks = {
        farmRemainSec: Math.max(0, Math.ceil((Number(nextFarmRunAt || 0) - nowMs) / 1000)),
        friendRemainSec: Math.max(0, Math.ceil((Number(nextFriendRunAt || 0) - nowMs) / 1000)),
    };

    fullStats.automation = getAutomation();
    fullStats.preferredSeed = getPreferredSeed();
    fullStats.levelProgress = expProgress;
    fullStats.configRevision = appliedConfigRevision;
    const hash = JSON.stringify(fullStats);
    const now = Date.now();
    if (hash !== lastStatusHash || now - lastStatusSentAt > 8000) {
        lastStatusHash = hash;
        lastStatusSentAt = now;
        sendToMaster({ type: 'status_sync', data: fullStats });
    }
}
