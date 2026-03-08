const stealStats = require('./steal-stats');
/**
 * 好友农场操作 - 进入/离开/帮忙/偷菜/巡查
 */

const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantName, getPlantById, getSeedImageBySeedId, getPlantNameBySeedId } = require('../config/gameConfig');
const { isAutomationOn, getFriendQuietHours, getFriendBlacklist, getFriendBlacklistMulti, getTheftKingConfig, getAccounts, getVipSmtpConfig, getAdminSmtpConfig, getStealWhitelist, getCareWhitelist, getPlantBlacklist } = require('../models/store');
const { sendPushooMessage } = require('./push');
const { sendMsgAsync, getUserState, networkEvents, getKeeperAccountId } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, toTimeSec, getServerTimeSec, log, logWarn, sleep } = require('../utils/utils');
const { getCurrentPhase, setOperationLimitsCallback, setFriendLookupCallback } = require('./farm');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { sellAllFruits } = require('./warehouse');

// ============ 内部状态 ============
let isCheckingFriends = false;
let friendLoopRunning = false;
let externalSchedulerMode = false;
let friendCheckAbort = false;  // 中断标志：天王模式启动时置 true，让正在跑的巡查轮提前退出
let lastResetDate = '';  // 上次重置日期 (YYYY-MM-DD)
const friendScheduler = createScheduler('friend');

// 好友名字缓存（GID -> 名字），供 farm.js 被动操作追踪时查名字
const friendNameCache = new Map();
function updateFriendNameCache(friends) {
    const DEFAULT_NICKNAME = '小小农夫';
    for (const f of (friends || [])) {
        const gid = toNum(f.gid);
        if (!gid) continue;
        const rawName = (String(f.remark || '').trim() || String(f.name || '').trim());
        const isDefault = !rawName || rawName === DEFAULT_NICKNAME;
        friendNameCache.set(gid, isDefault ? `GID:${gid}` : rawName);
    }
}
function lookupFriendNameFromCache(gid) {
    return friendNameCache.get(toNum(gid)) || null;
}

// 操作限制状态 (从服务器响应中更新)
// 操作类型ID (根据游戏代码):
// 10001 = 收获, 10002 = 铲除, 10003 = 放草, 10004 = 放虫
// 10005 = 除草(帮好友), 10006 = 除虫(帮好友), 10007 = 浇水(帮好友), 10008 = 偷菜
const operationLimits = new Map();

// 操作类型名称映射
const OP_NAMES = {
    10001: '收获',
    10002: '铲除',
    10003: '放草',
    10004: '放虫',
    10005: '除草',
    10006: '除虫',
    10007: '浇水',
    10008: '偷菜',
};

let canGetHelpExp = true;
let helpAutoDisabledByLimit = false;

function parseTimeToMinutes(timeStr) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return null;
    const h = Number.parseInt(m[1], 10);
    const min = Number.parseInt(m[2], 10);
    if (Number.isNaN(h) || Number.isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

function inFriendQuietHours(now = new Date()) {
    const cfg = getFriendQuietHours();
    if (!cfg || !cfg.enabled) return false;

    const start = parseTimeToMinutes(cfg.start);
    const end = parseTimeToMinutes(cfg.end);
    if (start === null || end === null) return false;

    const cur = now.getHours() * 60 + now.getMinutes();
    if (start === end) return true; // 起止相同视为全天静默
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end; // 跨天时段
}

// ============ 好友 API ============

async function getAllFriends() {
    // QQ 平台使用 SyncAll（传入空 open_ids 数组获取所有好友），微信平台使用 GetAll
    const isQQ = CONFIG.platform === 'qq';
    if (isQQ) {
        const requestObj = types.SyncAllFriendsRequest.create({ open_ids: [] });
        const body = types.SyncAllFriendsRequest.encode(requestObj).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', body);
        return types.SyncAllFriendsReply.decode(replyBody);
    } else {
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
        return types.GetAllFriendsReply.decode(replyBody);
    }
}

// ============ 好友申请 API (微信同玩) ============

async function getApplications() {
    const body = types.GetApplicationsRequest.encode(types.GetApplicationsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetApplications', body);
    return types.GetApplicationsReply.decode(replyBody);
}

async function acceptFriends(gids) {
    const body = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
        friend_gids: gids.map(g => toLong(g)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'AcceptFriends', body);
    return types.AcceptFriendsReply.decode(replyBody);
}

async function enterFriendFarm(friendGid) {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,  // ENTER_REASON_FRIEND
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
    return types.VisitEnterReply.decode(replyBody);
}

async function leaveFriendFarm(friendGid) {
    const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
        host_gid: toLong(friendGid),
    })).finish();
    try {
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body);
    } catch { /* 离开失败不影响主流程 */ }
}

/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
function checkDailyReset() {
    // 使用服务器时间（北京时间 UTC+8）计算当前日期，避免时区偏差
    const nowSec = getServerTimeSec();
    const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
    const bjOffset = 8 * 3600 * 1000;
    const bjDate = new Date(nowMs + bjOffset);
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    const today = `${y}-${m}-${d}`;  // 北京时间日期 YYYY-MM-DD
    if (lastResetDate !== today) {
        if (lastResetDate !== '') {
            log('系统', '跨日重置，清空操作限制缓存');
        }
        operationLimits.clear();
        canGetHelpExp = true;
        if (helpAutoDisabledByLimit) {
            helpAutoDisabledByLimit = false;
            log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
                module: 'friend',
                event: 'friend_cycle',
                result: 'ok',
            });
        }
        // 跨日重置天王模式重点名单的偷菜失败计数，避免昨天失败记录影响今天
        for (const [, info] of focusFriends) {
            info.stealSkipCount = 0;
        }
        lastResetDate = today;
    }
}

function autoDisableHelpByExpLimit() {
    if (!canGetHelpExp) return;
    canGetHelpExp = false;
    helpAutoDisabledByLimit = true;
    log('好友', '今日帮助经验已达上限，自动停止帮忙', {
        module: 'friend',
        event: 'friend_cycle',
        result: 'ok',
    });
}

/**
 * 更新操作限制状态
 */
function updateOperationLimits(limits) {
    if (!limits || limits.length === 0) return;
    checkDailyReset();
    for (const limit of limits) {
        const id = toNum(limit.id);
        if (id > 0) {
            const data = {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: toNum(limit.day_exp_times),
                dayExpTimesLimit: toNum(limit.day_ex_times_lt), // 协议字段名为 day_ex_times_lt
            };
            operationLimits.set(id, data);
        }
    }
}

function canGetExpByCandidates(opIds = []) {
    const ids = Array.isArray(opIds) ? opIds : [opIds];
    for (const id of ids) {
        if (canGetExp(toNum(id))) return true;
    }
    return false;
}

/**
 * 检查某操作是否还能获得经验
 */
function canGetExp(opId) {
    const limit = operationLimits.get(opId);
    if (!limit) return false;  // 没有限制信息，保守起见不帮助（等待限制数据）
    if (limit.dayExpTimesLimit <= 0) return true;  // 没有经验上限
    return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * 检查某操作是否还有次数
 */
function canOperate(opId) {
    const limit = operationLimits.get(opId);
    if (!limit) return true;
    if (limit.dayTimesLimit <= 0) return true;
    return limit.dayTimes < limit.dayTimesLimit;
}

/**
 * 获取某操作剩余次数
 */
function getRemainingTimes(opId) {
    const limit = operationLimits.get(opId);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

/**
 * 获取操作限制详情 (供管理面板使用)
 */
function getOperationLimits() {
    const result = {};
    for (const id of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]) {
        const limit = operationLimits.get(id);
        if (limit) {
            result[id] = {
                name: OP_NAMES[id] || `#${id}`,
                ...limit,
                remaining: getRemainingTimes(id),
            };
        }
    }
    return result;
}

async function helpWater(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    const reply = types.WaterLandReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function helpWeed(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
    const reply = types.WeedOutReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function helpInsecticide(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
    const reply = types.InsecticideReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function stealHarvest(friendGid, landIds) {
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    const reply = types.HarvestReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    return reply;
}

/**
 * 天王模式专用偷菜：不依赖自动偷菜开关，直接偷指定好友的所有可偷地块
 * 只偷 level >= minPlantLevel 的地块，避免顺带偷低等级白萝卜等作物
 * 返回：>0 偷到的数量；0 请求失败/无可偷；-1 今日次数已用完
 */
async function stealFriendForKing(gid, name, parsedLands) {
    const cfg = getTheftKingConfig();
    const minLevel = cfg.minPlantLevel;
    const stealableItems = parsedLands.filter(l => l.unlocked && l.status === 'stealable' && l.level >= minLevel);
    if (stealableItems.length === 0) return 0;

    const precheck = await checkCanOperateRemote(gid, 10008);
    if (!precheck.canOperate) {
        log('天王', `${name} 今日偷菜次数已用完，跳过`, { module: 'theft_king', event: 'steal_skip', gid });
        return -1;
    }
    const canStealNum = precheck.canStealNum > 0 ? precheck.canStealNum : stealableItems.length;
    const targetItems = stealableItems.slice(0, canStealNum);
    const targetLands = targetItems.map(l => l.id);

    let ok = 0;
    const stolenNames = [];
    try {
        await stealHarvest(gid, targetLands);
        ok = targetLands.length;
        targetItems.forEach(l => { if (l.plantName) stolenNames.push(l.plantName); });
    } catch {
        for (const item of targetItems) {
            try {
                await stealHarvest(gid, [item.id]);
                ok++;
                if (item.plantName) stolenNames.push(item.plantName);
            } catch { /* ignore */ }
            await sleep(100);
        }
    }
    if (ok > 0) {
        recordOperation('steal', ok);
        try {
            const goldPerSteal = targetItems.reduce((sum, l) => {
                const pc = getPlantById(l.plantId);
                const fruitId = pc && pc.fruit && pc.fruit.id;
                const fruitCount = pc && pc.fruit && pc.fruit.count || 0;
                const ic = fruitId ? getItemById(fruitId) : null;
                return sum + (ic ? (ic.price || 0) * fruitCount : 0);
            }, 0);
            stealStats.recordIStole(getKeeperAccountId(), gid, name, goldPerSteal);
        } catch {}
        const plantStr = [...new Set(stolenNames)].join('/');
        log('天王', `${name} 偷取 ${ok} 块${plantStr ? `(${plantStr})` : ''}`, { module: 'theft_king', event: 'steal', gid, count: ok, plants: plantStr });
    }
    return ok;
}

async function putPlantItems(friendGid, landIds, RequestType, ReplyType, method) {
    let ok = 0;
    const ids = Array.isArray(landIds) ? landIds : [];
    for (const landId of ids) {
        try {
            const body = RequestType.encode(RequestType.create({
                land_ids: [toLong(landId)],
                host_gid: toLong(friendGid),
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
            const reply = ReplyType.decode(replyBody);
            updateOperationLimits(reply.operation_limits);
            ok++;
        } catch { /* ignore single failure */ }
        await sleep(100);
    }
    return ok;
}

async function putPlantItemsDetailed(friendGid, landIds, RequestType, ReplyType, method) {
    let ok = 0;
    const failed = [];
    const ids = Array.isArray(landIds) ? landIds : [];
    for (const landId of ids) {
        try {
            const body = RequestType.encode(RequestType.create({
                land_ids: [toLong(landId)],
                host_gid: toLong(friendGid),
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
            const reply = ReplyType.decode(replyBody);
            updateOperationLimits(reply.operation_limits);
            ok++;
        } catch (e) {
            failed.push({ landId, reason: e && e.message ? e.message : '未知错误' });
        }
        await sleep(100);
    }
    return { ok, failed };
}

async function putInsects(friendGid, landIds) {
    return putPlantItems(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

async function putWeeds(friendGid, landIds) {
    return putPlantItems(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

async function putInsectsDetailed(friendGid, landIds) {
    return putPlantItemsDetailed(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

async function putWeedsDetailed(friendGid, landIds) {
    return putPlantItemsDetailed(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

async function checkCanOperateRemote(friendGid, operationId) {
    if (!types.CheckCanOperateRequest || !types.CheckCanOperateReply) {
        return { canOperate: true, canStealNum: 0 };
    }
    try {
        const body = types.CheckCanOperateRequest.encode(types.CheckCanOperateRequest.create({
            host_gid: toLong(friendGid),
            operation_id: toLong(operationId),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'CheckCanOperate', body);
        const reply = types.CheckCanOperateReply.decode(replyBody);
        return {
            canOperate: !!reply.can_operate,
            canStealNum: toNum(reply.can_steal_num),
        };
    } catch {
        // 预检查失败时降级为不拦截，避免因协议抖动导致完全不操作
        return { canOperate: true, canStealNum: 0 };
    }
}

// ============ 好友土地分析 ============

function analyzeFriendLands(lands, myGid, friendName = '') {
    const result = {
        stealable: [],   // 可偷
        stealableInfo: [],  // 可偷植物信息 { landId, plantId, name }
        needWater: [],   // 需要浇水
        needWeed: [],    // 需要除草
        needBug: [],     // 需要除虫
        canPutWeed: [],  // 可以放草
        canPutBug: [],   // 可以放虫
    };

    for (const land of lands) {
        const id = toNum(land.id);
        const plant = land.plant;

        if (!plant || !plant.phases || plant.phases.length === 0) {
            continue;
        }

        const currentPhase = getCurrentPhase(plant.phases, false, `[${friendName}]土地#${id}`);
        if (!currentPhase) {
            continue;
        }
        const phaseVal = currentPhase.phase;

        if (phaseVal === PlantPhase.MATURE) {
            if (plant.stealable) {
                result.stealable.push(id);
                const plantId = toNum(plant.id);
                const plantName = getPlantName(plantId) || plant.name || '未知';
                result.stealableInfo.push({ landId: id, plantId, name: plantName });
            }
            continue;
        }

        if (phaseVal === PlantPhase.DEAD) continue;

        // 帮助操作
        if (toNum(plant.dry_num) > 0) result.needWater.push(id);
        if (plant.weed_owners && plant.weed_owners.length > 0) result.needWeed.push(id);
        if (plant.insect_owners && plant.insect_owners.length > 0) result.needBug.push(id);

        // 捣乱操作: 检查是否可以放草/放虫
        // 条件: 没有草且我没放过草
        const weedOwners = plant.weed_owners || [];
        const insectOwners = plant.insect_owners || [];
        const iAlreadyPutWeed = weedOwners.some(gid => toNum(gid) === myGid);
        const iAlreadyPutBug = insectOwners.some(gid => toNum(gid) === myGid);

        // 每块地最多2个草/虫，且我没放过
        if (weedOwners.length < 2 && !iAlreadyPutWeed) {
            result.canPutWeed.push(id);
        }
        if (insectOwners.length < 2 && !iAlreadyPutBug) {
            result.canPutBug.push(id);
        }
    }
    return result;
}

/**
 * 获取好友列表 (供面板)
 */
async function getFriendsList() {
    try {
        const reply = await getAllFriends();
        const friends = reply.game_friends || [];
        const state = getUserState();
        const DEFAULT_NICKNAME = '小小农夫';
        return friends
            .filter(f => toNum(f.gid) !== state.gid)
            .map(f => {
                // 备注或昵称为「小小农夫」（游戏默认昵称）或空白时，改用 GID 显示
                const rawName = (String(f.remark || '').trim() || String(f.name || '').trim());
                const isDefaultOrEmpty = !rawName.trim() || rawName.trim() === DEFAULT_NICKNAME;
                const displayName = isDefaultOrEmpty ? `GID:${toNum(f.gid)}` : rawName.trim();
                return {
                    gid: toNum(f.gid),
                    name: displayName,
                    avatarUrl: String(f.avatar_url || '').trim(),
                    plant: f.plant ? {
                        stealNum: toNum(f.plant.steal_plant_num),
                        dryNum: toNum(f.plant.dry_num),
                        weedNum: toNum(f.plant.weed_num),
                        insectNum: toNum(f.plant.insect_num),
                    } : null,
                };
            })
            .sort((a, b) => {
                // 固定顺序：先按名称，再按 GID，避免刷新时顺序抖动
                const an = String(a.name || '');
                const bn = String(b.name || '');
                const byName = an.localeCompare(bn, 'zh-CN');
                if (byName !== 0) return byName;
                return Number(a.gid || 0) - Number(b.gid || 0);
            });
    } catch {
        return [];
    }
}

/**
 * 获取指定好友的农田详情 (进入-获取-离开)
 * 天王模式运行时优先返回缓存，避免与天王模式进出农场冲突
 */
async function getFriendLandsDetail(friendGid) {
    const gid = toNum(friendGid);

    // 天王模式运行时，若有缓存则直接返回（避免与天王模式进出农场冲突）
    if (theftKingRunning && kingFriendLandsCache.has(gid)) {
        const cached = kingFriendLandsCache.get(gid);
        return { lands: cached.lands, summary: cached.summary, fromCache: true, cachedAt: cached.updatedAt };
    }
    try {
        const enterReply = await enterFriendFarm(friendGid);
        const lands = enterReply.lands || [];
        const state = getUserState();
        const analyzed = analyzeFriendLands(lands, state.gid, '');
        await leaveFriendFarm(friendGid);

        const landsList = [];
        const nowSec = getServerTimeSec();
        for (const land of lands) {
            const id = toNum(land.id);
            const level = toNum(land.level);
            const unlocked = !!land.unlocked;
            if (!unlocked) {
                landsList.push({
                    id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '未解锁',
                    level,
                    needWater: false,
                    needWeed: false,
                    needBug: false,
                });
                continue;
            }
            const plant = land.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                landsList.push({ id, unlocked: true, status: 'empty', plantName: '', phaseName: '空地', level });
                continue;
            }
            const currentPhase = getCurrentPhase(plant.phases, false, '');
            if (!currentPhase) {
                landsList.push({ id, unlocked: true, status: 'empty', plantName: '', phaseName: '', level });
                continue;
            }
            const phaseVal = currentPhase.phase;
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            const plantCfg = getPlantById(plantId);
            const seedId = toNum(plantCfg && plantCfg.seed_id);
            const seedImage = seedId > 0 ? getSeedImageBySeedId(seedId) : '';
            const phaseName = PHASE_NAMES[phaseVal] || '';
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;
            let landStatus = 'growing';
            if (phaseVal === PlantPhase.MATURE) landStatus = plant.stealable ? 'stealable' : 'harvested';
            else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';

            landsList.push({
                id,
                unlocked: true,
                status: landStatus,
                plantName,
                seedId,
                seedImage,
                phaseName,
                level,
                matureInSec,
                needWater: toNum(plant.dry_num) > 0,
                needWeed: (plant.weed_owners && plant.weed_owners.length > 0),
                needBug: (plant.insect_owners && plant.insect_owners.length > 0),
                plantId,
            });
        }

        return {
            lands: landsList,
            summary: analyzed,
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function runBatchWithFallback(ids, batchFn, singleFn) {
    const target = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (target.length === 0) return 0;
    try {
        await batchFn(target);
        return target.length;
    } catch {
        let ok = 0;
        for (const landId of target) {
            try {
                await singleFn([landId]);
                ok++;
            } catch { /* ignore */ }
            await sleep(100);
        }
        return ok;
    }
}

/**
 * 面板手动好友操作（单个好友）
 * opType: 'steal' | 'water' | 'weed' | 'bug' | 'bad'
 */
async function doFriendOperation(friendGid, opType) {
    const gid = toNum(friendGid);
    if (!gid) return { ok: false, message: '无效好友ID', opType };

    // 天王模式运行时，帮助类操作暂停，避免与天王模式进出农场冲突
    if (theftKingRunning && opType !== 'steal') {
        return { ok: false, message: '天王模式运行中，帮助操作已暂停（关闭天王模式后恢复）', opType };
    }

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        return { ok: false, message: `进入好友农场失败: ${e.message}`, opType };
    }

    try {
        const lands = enterReply.lands || [];
        const state = getUserState();
        const status = analyzeFriendLands(lands, state.gid, '');
        let count = 0;

        if (opType === 'steal') {
            if (!status.stealable.length) return { ok: true, opType, count: 0, message: '没有可偷取土地' };
            const precheck = await checkCanOperateRemote(gid, 10008);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '今日偷菜次数已用完' };
            const maxNum = precheck.canStealNum > 0 ? precheck.canStealNum : status.stealable.length;
            const target = status.stealable.slice(0, maxNum);
            count = await runBatchWithFallback(target, (ids) => stealHarvest(gid, ids), (ids) => stealHarvest(gid, ids));
            if (count > 0) {
                recordOperation('steal', count);
                // 手动偷取成功后立即尝试出售一次果实
                try {
                    await sellAllFruits();
                } catch (e) {
                    logWarn('仓库', `手动偷取后自动出售失败: ${e.message}`, {
                        module: 'warehouse',
                        event: 'sell_after_steal',
                        result: 'error',
                        mode: 'manual',
                    });
                }
            }
            return { ok: true, opType, count, message: `偷取完成 ${count} 块` };
        }

        if (opType === 'water') {
            if (!status.needWater.length) return { ok: true, opType, count: 0, message: '没有可浇水土地' };
            const precheck = await checkCanOperateRemote(gid, 10007);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '今日浇水次数已用完' };
            count = await runBatchWithFallback(status.needWater, (ids) => helpWater(gid, ids), (ids) => helpWater(gid, ids));
            if (count > 0) recordOperation('helpWater', count);
            return { ok: true, opType, count, message: `浇水完成 ${count} 块` };
        }

        if (opType === 'weed') {
            if (!status.needWeed.length) return { ok: true, opType, count: 0, message: '没有可除草土地' };
            const precheck = await checkCanOperateRemote(gid, 10005);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '今日除草次数已用完' };
            count = await runBatchWithFallback(status.needWeed, (ids) => helpWeed(gid, ids), (ids) => helpWeed(gid, ids));
            if (count > 0) recordOperation('helpWeed', count);
            return { ok: true, opType, count, message: `除草完成 ${count} 块` };
        }

        if (opType === 'bug') {
            if (!status.needBug.length) return { ok: true, opType, count: 0, message: '没有可除虫土地' };
            const precheck = await checkCanOperateRemote(gid, 10006);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '今日除虫次数已用完' };
            count = await runBatchWithFallback(status.needBug, (ids) => helpInsecticide(gid, ids), (ids) => helpInsecticide(gid, ids));
            if (count > 0) recordOperation('helpBug', count);
            return { ok: true, opType, count, message: `除虫完成 ${count} 块` };
        }

        if (opType === 'bad') {
            let bugCount = 0;
            let weedCount = 0;
            if (!status.canPutBug.length && !status.canPutWeed.length) {
                return { ok: true, opType, count: 0, bugCount: 0, weedCount: 0, message: '没有可捣乱土地' };
            }

            // 手动捣乱不依赖预检查，逐块执行（与 terminal-farm-main 保持一致）
            let failDetails = [];
            if (status.canPutBug.length) {
                const bugRet = await putInsectsDetailed(gid, status.canPutBug);
                bugCount = bugRet.ok;
                failDetails = failDetails.concat((bugRet.failed || []).map(f => `放虫#${f.landId}:${f.reason}`));
                if (bugCount > 0) recordOperation('bug', bugCount);
            }
            if (status.canPutWeed.length) {
                const weedRet = await putWeedsDetailed(gid, status.canPutWeed);
                weedCount = weedRet.ok;
                failDetails = failDetails.concat((weedRet.failed || []).map(f => `放草#${f.landId}:${f.reason}`));
                if (weedCount > 0) recordOperation('weed', weedCount);
            }
            count = bugCount + weedCount;
            if (count <= 0) {
                const reasonPreview = failDetails.slice(0, 2).join(' | ');
                return {
                    ok: true,
                    opType,
                    count: 0,
                    bugCount,
                    weedCount,
                    message: reasonPreview ? `捣乱失败: ${reasonPreview}` : '捣乱失败或今日次数已用完'
                };
            }
            return { ok: true, opType, count, bugCount, weedCount, message: `捣乱完成 虫${bugCount}/草${weedCount}` };
        }

        return { ok: false, opType, count: 0, message: '未知操作类型' };
    } catch (e) {
        return { ok: false, opType, count: 0, message: e.message || '操作失败' };
    } finally {
        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
    }
}

// ============ 拜访好友 ============

async function visitFriend(friend, totalActions, myGid, whitelists = {}) {
    const { gid, name } = friend;
    const { stealWhiteSet = null, careWhiteSet = null, noStealSet = null, noHelpSet = null } = whitelists;

    // 进农场前再次检查：天王模式已启动或巡查已被中断，立即放弃本次访问
    if (theftKingRunning || friendCheckAbort) return;

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        logWarn('好友', `进入 ${name} 农场失败: ${e.message}`, {
            module: 'friend', event: 'enter_farm', result: 'error', friendName: name, friendGid: gid
        });
        return;
    }

    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return;
    }

    const status = analyzeFriendLands(lands, myGid, name);

    // 执行操作
    const actions = [];

    // 1. 帮助操作 (除草/除虫/浇水)
    // 照顾白名单过滤：白名单非空时，仅对名单内好友进行帮助操作
    const inCareWhitelist = careWhiteSet === null || careWhiteSet.has(gid);
    // noHelp 黑名单：名单内好友不帮忙（支持 GID 字符串或名字匹配）
    const inNoHelp = noHelpSet !== null && (noHelpSet.has(String(gid)) || noHelpSet.has(name));
    const helpEnabled = inCareWhitelist && !inNoHelp && !!isAutomationOn('friend_help');
    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');
    if (!stopWhenExpLimit) canGetHelpExp = true;
    if (!helpEnabled) {
        // 自动帮忙关闭，直接跳过帮助操作
    } else if (stopWhenExpLimit && !canGetHelpExp) {
        // 今日已达到经验上限后停止帮忙
    } else {
        const helpOps = [
            { id: 10005, expIds: [10005, 10003], list: status.needWeed, fn: helpWeed, key: 'weed', name: '草', record: 'helpWeed' },
            { id: 10006, expIds: [10006, 10002], list: status.needBug, fn: helpInsecticide, key: 'bug', name: '虫', record: 'helpBug' },
            { id: 10007, expIds: [10007, 10001], list: status.needWater, fn: helpWater, key: 'water', name: '水', record: 'helpWater' }
        ];

        for (const op of helpOps) {
            const allowByExp = (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExp);
            if (op.list.length > 0 && allowByExp) {
                const precheck = await checkCanOperateRemote(gid, op.id);
                if (precheck.canOperate) {
                    const count = await runBatchWithFallback(
                        op.list,
                        (ids) => op.fn(gid, ids, stopWhenExpLimit),
                        (ids) => op.fn(gid, ids, stopWhenExpLimit)
                    );
                    if (count > 0) {
                        actions.push(`${op.name}${count}`);
                        totalActions[op.key] += count;
                        recordOperation(op.record, count);
                    }
                }
            }
        }
    }

    // 2. 偷菜操作；未开启偷菜但发现成熟作物时，发邮件提醒
    // noSteal 黑名单：名单内好友不偷菜（支持 GID 字符串或名字匹配）
    const inNoSteal = noStealSet !== null && (noStealSet.has(String(gid)) || noStealSet.has(name));
    if (!isAutomationOn('friend_steal') && status.stealable.length > 0) {
        _emitFriendMatureNotify({ friendName: name, stealableCount: status.stealable.length }).catch(() => {});
    }
    if (!inNoSteal && isAutomationOn('friend_steal') && status.stealable.length > 0) {
        // 植物黑名单过滤：跳过黑名单内的植物
        const _plantBL = new Set(getPlantBlacklist(getKeeperAccountId()));
        if (_plantBL.size > 0) {
            status.stealable = status.stealableInfo
                .filter(x => !_plantBL.has(x.name))
                .map(x => x.landId);
        }
        if (!status.stealable.length) return;
        const precheck = await checkCanOperateRemote(gid, 10008);
        if (precheck.canOperate) {
            const canStealNum = precheck.canStealNum > 0 ? precheck.canStealNum : status.stealable.length;
            const targetLands = status.stealable.slice(0, canStealNum);
            
            let ok = 0;
            const stolenPlants = [];
            
            // 尝试批量偷取
            try {
                await stealHarvest(gid, targetLands);
                ok = targetLands.length;
                targetLands.forEach(id => {
                    const info = status.stealableInfo.find(x => x.landId === id);
                    if (info) stolenPlants.push(info.name);
                });
            } catch {
                // 批量失败，降级为单个
                for (const landId of targetLands) {
                    try {
                        await stealHarvest(gid, [landId]);
                        ok++;
                        const info = status.stealableInfo.find(x => x.landId === landId);
                        if (info) stolenPlants.push(info.name);
                    } catch { /* ignore */ }
                    await sleep(100);
                }
            }

            if (ok > 0) {
                const plantNames = [...new Set(stolenPlants)].join('/');
                actions.push(`偷${ok}${plantNames ? `(${  plantNames  })` : ''}`);
                totalActions.steal += ok;
                recordOperation('steal', ok);
                // 记录互动统计
                try {
                    const goldPerSteal = targetLands.reduce((sum, landId) => {
                        const info = status.stealableInfo.find(x => x.landId === landId);
                        const pc = info ? getPlantById(info.plantId) : null;
                        const fruitId = pc && pc.fruit && pc.fruit.id;
                        const fruitCount = pc && pc.fruit && pc.fruit.count || 0;
                        const ic = fruitId ? getItemById(fruitId) : null;
                        return sum + (ic ? (ic.price || 0) * fruitCount : 0);
                    }, 0);
                    stealStats.recordIStole(getKeeperAccountId(), gid, name, goldPerSteal);
                } catch {}
            }
        }
    }

    // 3. 捣乱操作 (放虫/放草)
    // 捣乱白名单过滤：白名单非空时，仅对名单内好友捣乱
    const inStealWhitelist = stealWhiteSet === null || stealWhiteSet.has(gid);
    const autoBad = inStealWhitelist && isAutomationOn('friend_bad');
    if (autoBad) {
        if (status.canPutBug.length > 0 && canOperate(10004)) {
            const remaining = getRemainingTimes(10004);
            const toProcess = status.canPutBug.slice(0, remaining);
            const ok = await putInsects(gid, toProcess);
            if (ok > 0) { actions.push(`放虫${ok}`); totalActions.putBug += ok; }
        }
    
        if (status.canPutWeed.length > 0 && canOperate(10003)) {
            const remaining = getRemainingTimes(10003);
            const toProcess = status.canPutWeed.slice(0, remaining);
            const ok = await putWeeds(gid, toProcess);
            if (ok > 0) { actions.push(`放草${ok}`); totalActions.putWeed += ok; }
        }
    }

    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: 'visit_friend', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }

    await leaveFriendFarm(gid);
}

// ============ 好友巡查主循环 ============

async function checkFriends() {
    const state = getUserState();
    // 天王模式运行时，禁止普通好友巡查（无论从何处调用）
    if (theftKingRunning) return false;
    // 首先检查主开关，如果未开启则直接返回
    if (!isAutomationOn('friend')) return false;

    const helpEnabled = !!isAutomationOn('friend_help');
    const stealEnabled = !!isAutomationOn('friend_steal');
    const badEnabled = !!isAutomationOn('friend_bad');
    const hasAnyFriendOp = helpEnabled || stealEnabled || badEnabled;
    if (isCheckingFriends || !state.gid || !hasAnyFriendOp) return false;
    if (inFriendQuietHours()) return false;
    
    isCheckingFriends = true;
    checkDailyReset();

    try {
        const friendsReply = await getAllFriends();
        const friends = friendsReply.game_friends || [];
        if (friends.length === 0) { 
            log('好友', '没有好友', { module: 'friend', event: 'friend_scan', result: 'empty' }); 
            return false; 
        }
        // 更新好友名字缓存，供被动操作追踪（被偷/被放草虫）时查名字
        updateFriendNameCache(friends);

        const canPutBugOrWeed = canOperate(10004) || canOperate(10003);
        const autoBadEnabled = isAutomationOn('friend_bad');
        const blacklist = new Set(getFriendBlacklist());
        const stealWL = getStealWhitelist();
        const careWL = getCareWhitelist();
        const stealWhiteSet = stealWL.length > 0 ? new Set(stealWL) : null;
        const careWhiteSet = careWL.length > 0 ? new Set(careWL) : null;
        // noSteal/noHelp 细分黑名单：存的是名字或 GID 字符串，统一转 String 匹配
        const multiBlacklist = getFriendBlacklistMulti(state.id);
        const noStealSet = multiBlacklist.noSteal.length > 0 ? new Set(multiBlacklist.noSteal.map(String)) : null;
        const noHelpSet  = multiBlacklist.noHelp.length  > 0 ? new Set(multiBlacklist.noHelp.map(String))  : null;

        const priorityFriends = [];
        const otherFriends = [];
        const visitedGids = new Set();

        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid) continue;
            if (visitedGids.has(gid)) continue;
            if (blacklist.has(gid)) continue;
            
            const name = f.remark || f.name || `GID:${gid}`;
            const p = f.plant;
            const stealNum = p ? toNum(p.steal_plant_num) : 0;
            const dryNum = p ? toNum(p.dry_num) : 0;
            const weedNum = p ? toNum(p.weed_num) : 0;
            const insectNum = p ? toNum(p.insect_num) : 0;
            
            const hasAction = stealNum > 0 || dryNum > 0 || weedNum > 0 || insectNum > 0;

            if (hasAction) {
                priorityFriends.push({ 
                    gid, name, isPriority: true,
                    stealNum, dryNum, weedNum, insectNum // 保存状态用于排序
                });
                visitedGids.add(gid);
            } else if ((autoBadEnabled && canPutBugOrWeed) || helpEnabled || stealEnabled) {
                otherFriends.push({ gid, name, isPriority: false });
                visitedGids.add(gid);
            }
        }
        
        // 排序优化: 优先偷菜多的，其次是需要帮助多的
        priorityFriends.sort((a, b) => {
            if (b.stealNum !== a.stealNum) return b.stealNum - a.stealNum; // 偷菜优先
            // 其次按帮助需求总数
            const helpA = a.dryNum + a.weedNum + a.insectNum;
            const helpB = b.dryNum + b.weedNum + b.insectNum;
            return helpB - helpA;
        });

        const friendsToVisit = [...priorityFriends, ...otherFriends];

        if (friendsToVisit.length === 0) {
            return false;
        }

        const totalActions = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };

        for (let i = 0; i < friendsToVisit.length; i++) {
            const friend = friendsToVisit[i];
            
            // 天王模式启动时中断当前巡查轮
            if (friendCheckAbort) {
                log('好友', '天王模式已启动，中断当前巡查轮', { module: 'friend', event: 'friend_cycle', result: 'aborted' });
                break;
            }

            // 如果是仅捣乱的好友（帮忙/偷菜均未开启），且次数已用完，则停止
            if (!friend.isPriority && !helpEnabled && !stealEnabled && !canOperate(10004) && !canOperate(10003)) {
                break;
            }

            try {
                await visitFriend(friend, totalActions, state.gid, { stealWhiteSet, careWhiteSet, noStealSet, noHelpSet });
            } catch {
                // 单个好友访问失败不影响整体
            }
            
            // 稍微等待，避免请求过快
            await sleep(200);
        }

        // 偷菜后自动出售
        if (totalActions.steal > 0) {
            try {
                await sellAllFruits();
            } catch {
                // ignore
            }
        }

        // 生成总结日志
        const summary = [];
        if (totalActions.steal > 0) summary.push(`偷${totalActions.steal}`);
        if (totalActions.weed > 0) summary.push(`除草${totalActions.weed}`);
        if (totalActions.bug > 0) summary.push(`除虫${totalActions.bug}`);
        if (totalActions.water > 0) summary.push(`浇水${totalActions.water}`);
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);
        
        if (summary.length > 0) {
            log('好友', `巡查 ${friendsToVisit.length} 人 → ${summary.join('/')}`, {
                module: 'friend', event: 'friend_cycle', result: 'ok', visited: friendsToVisit.length, summary
            });
        }
        return summary.length > 0;

    } catch (err) {
        logWarn('好友', `巡查异常: ${err.message}`);
        return false;
    } finally {
        isCheckingFriends = false;
    }
}

/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop() {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;
    await checkFriends();
    if (!friendLoopRunning) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}

function startFriendCheckLoop(options = {}) {
    if (friendLoopRunning) return;
    // 天王模式运行期间禁止启动普通好友巡查（仅允许天王模式停止时的内部恢复调用）
    if (theftKingRunning && !options._fromTheftKingStop) return;
    friendCheckAbort = false;  // 恢复中断标志
    externalSchedulerMode = !!options.externalScheduler;
    friendLoopRunning = true;

    // 注册操作限制更新回调，从农场检查中获取限制信息
    setOperationLimitsCallback(updateOperationLimits);
    // 注入好友名字查询回调，供 farm.js 被动操作追踪时查名字
    setFriendLookupCallback(lookupFriendNameFromCache);

    // 监听好友申请推送 (微信同玩)
    networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);

    if (!externalSchedulerMode) {
        // 延迟 5 秒后启动循环，等待登录和首次农场检查完成
        friendScheduler.setTimeoutTask('friend_check_loop', 5000, () => friendCheckLoop());
    }

    // 启动时检查一次待处理的好友申请
    friendScheduler.setTimeoutTask('friend_check_bootstrap_applications', 3000, () => checkAndAcceptApplications());
}

function stopFriendCheckLoop() {
    friendLoopRunning = false;
    externalSchedulerMode = false;
    friendCheckAbort = true;  // 通知正在跑的巡查轮尽快退出
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    friendScheduler.clearAll();
}

function refreshFriendCheckLoop(delayMs = 200) {
    if (!friendLoopRunning || externalSchedulerMode) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}

// ============ 自动同意好友申请 (微信同玩) ============

/**
 * 处理服务器推送的好友申请
 */
function onFriendApplicationReceived(applications) {
    const names = applications.map(a => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);

    // 自动同意
    const gids = applications.map(a => toNum(a.gid));
    acceptFriendsWithRetry(gids);
}

/**
 * 检查并同意所有待处理的好友申请
 */
async function checkAndAcceptApplications() {
    try {
        const reply = await getApplications();
        const applications = reply.applications || [];
        if (applications.length === 0) return;

        const names = applications.map(a => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);

        const gids = applications.map(a => toNum(a.gid));
        await acceptFriendsWithRetry(gids);
    } catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}

/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids) {
    if (gids.length === 0) return;
    try {
        const reply = await acceptFriends(gids);
        const friends = reply.friends || [];
        if (friends.length > 0) {
            const names = friends.map(f => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    } catch (e) {
        logWarn('申请', `同意失败: ${e.message}`);
    }
}

// ============ 超级偷菜（天王模式）============

/**
 * 从 enterFriendFarm 的原始 lands 列表解析出带 matureInSec/status 的结构
 * （复用 getFriendLandsDetail 的内部逻辑，但不重复进出农场）
 */
function parseLandsFromRaw(rawLands) {
    const nowSec = getServerTimeSec();
    const landsList = [];
    for (const land of (rawLands || [])) {
        const id = toNum(land.id);
        const unlocked = !!land.unlocked;
        if (!unlocked) { landsList.push({ id, unlocked: false, status: 'locked', level: 0, matureInSec: 0 }); continue; }
        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) {
            landsList.push({ id, unlocked: true, status: 'empty', level: 0, matureInSec: 0 }); continue;
        }
        // level 存 land_level_need（种植需求等级），用于与 minPlantLevel 比较
        const plantCfg = getPlantById(toNum(plant.id));
        const level = plantCfg ? (Number(plantCfg.land_level_need) || 0) : 0;
        const plantName = getPlantName(toNum(plant.id)) || plant.name || '';
        const currentPhase = getCurrentPhase(plant.phases, false, '');
        if (!currentPhase) { landsList.push({ id, unlocked: true, status: 'empty', level, matureInSec: 0 }); continue; }
        const phaseVal = toNum(currentPhase.phase);
        const maturePhase = Array.isArray(plant.phases)
            ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
            : null;
        const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
        const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;
        let status = 'growing';
        if (phaseVal === PlantPhase.MATURE) status = plant.stealable ? 'stealable' : 'harvested';
        else if (phaseVal === PlantPhase.DEAD) status = 'dead';
        landsList.push({ id, unlocked: true, status, level, matureInSec, isFertilizing: toNum(plant.left_inorc_fert_times) > 0, plantName });
    }
    return landsList;
}

/**
 * 从已解析的 landsList 中判断蹲点信号
 * 触发条件（满足任一，且 level >= minLevel）：
 *   1. growing 且 matureInSec <= 60（1分钟内成熟）
 *   2. growing 且 isFertilizing 且 matureInSec <= 300（有有机肥且5分钟内成熟）
 * 注意：harvested（被收走）单独不触发蹲点，被收走不代表会马上重种高级作物
 */
function shouldCampFromParsed(landsList, minLevel) {
    for (const land of (landsList || [])) {
        if (!land.unlocked) continue;
        if (land.level < minLevel) continue;
        if (land.status === 'growing' && land.matureInSec <= 60) return true;
        if (land.status === 'growing' && land.isFertilizing && land.matureInSec <= 300) return true;
    }
    return false;
}

/**
 * 比对两次快照判断是否有土地变动
 * snapshot: Map<landId, status>
 */
function hasLandChanged(prev, curr) {
    if (!prev || !curr) return false;
    for (const [id, status] of curr) {
        if (prev.get(id) !== status) return true;
    }
    return false;
}

function buildLandSnapshot(landsList) {
    const map = new Map();
    for (const l of (landsList || [])) {
        map.set(l.id, l.status);
    }
    return map;
}

/**
 * 将 parsedLands 写入天王模式土地缓存（供面板展示，避免冲突）
 * 同时构造 getFriendLandsDetail 兼容的格式（带 plantName/needWater 等字段）
 */
function updateKingLandsCache(gid, parsedLands) {
    // parsedLands 里已有 plantName，构建面板需要的格式
    const lands = parsedLands.map(l => ({
        id: l.id,
        unlocked: l.unlocked,
        status: l.status,
        level: l.level,
        plantName: l.plantName || '',
        phaseName: l.status === 'stealable' ? '成熟（可偷）' : l.status === 'growing' ? '生长中' : l.status === 'harvested' ? '已收获' : l.status === 'dead' ? '已枯死' : l.status === 'empty' ? '空地' : '未解锁',
        matureInSec: l.matureInSec || 0,
        needWater: false,
        needWeed: false,
        needBug: false,
    }));
    const stealable = parsedLands.filter(l => l.unlocked && l.status === 'stealable').length;
    kingFriendLandsCache.set(gid, {
        lands,
        summary: { stealable, water: 0, weed: 0, bug: 0, total: lands.filter(l => l.unlocked).length },
        updatedAt: Date.now(),
    });
}



// ---- 天王模式内部状态 ----
let theftKingRunning = false;
const theftKingScheduler = createScheduler('theft_king');

// 天王模式无法偷菜通知回调（由 worker.js 注入，用于向主进程发推送提醒）
let _stealNotifyCallback = null;

// 好友巡查成熟作物邮件提醒防抖（gid -> lastNotifyAt ms），同一好友1小时内只发一次
const _friendMatureNotifyAt = new Map();

/**
 * 普通好友巡查发现成熟作物（偷菜未开启），通过 VIP SMTP 向账号归属用户发邮件提醒
 */
async function _emitFriendMatureNotify({ friendName, stealableCount }) {
    try {
        const { workerData } = require('node:worker_threads');
        const accountId = String(
            (workerData && workerData.accountId) ||
            (typeof process !== 'undefined' && process.env && process.env.FARM_ACCOUNT_ID) ||
            ''
        );
        if (!accountId) return;
        // 防抖：以 friendName+accountId 为 key，1小时内不重复发
        const debounceKey = `${accountId}:${friendName}`;
        const lastAt = _friendMatureNotifyAt.get(debounceKey) || 0;
        if (Date.now() - lastAt < 3600 * 1000) return;
        _friendMatureNotifyAt.set(debounceKey, Date.now());

        const allData = getAccounts ? getAccounts() : { accounts: [] };
        const account = (allData.accounts || []).find(a => String(a.id) === accountId);
        if (!account || !account.userId) return;
        const smtpCfg = getVipSmtpConfig ? getVipSmtpConfig(String(account.userId)) : null;
        if (!smtpCfg || !smtpCfg.notifyMature || !smtpCfg.qq) return;
        const adminCfg = getAdminSmtpConfig ? getAdminSmtpConfig() : null;
        if (!adminCfg || !adminCfg.fromEmail || !adminCfg.smtpPass) return;
        const toEmail = `${smtpCfg.qq}@qq.com`;
        await sendPushooMessage({
            channel: 'email',
            endpoint: toEmail,
            token: `${adminCfg.fromEmail}:${adminCfg.smtpPass}`,
            title: `[成熟提醒] 好友农场有成熟作物`,
            content: `账号 ${account.name || accountId} 巡查好友「${friendName}」时发现 ${stealableCount} 块成熟作物，自动偷菜未开启，请手动前往偷菜。`,
        });
    } catch { /* 邮件失败不影响主流程 */ }
}
function setStealNotifyCallback(cb) { _stealNotifyCallback = cb; }
function _emitStealNotify(payload) {
    if (typeof _stealNotifyCallback === 'function') {
        try { _stealNotifyCallback(payload); } catch { /* ignore */ }
    }
}

/**
 * 天王模式蹲点成功偷菜后，通过 VIP SMTP 向账号所属面板用户发邮件
 * @param {string} friendName  被偷好友名称
 * @param {number} stealCount  偷到的数量
 */
async function _sendTheftKingMatureEmail(friendName, stealCount) {
    try {
        const { workerData } = require('node:worker_threads');
        const accountId = String(
            (workerData && workerData.accountId) ||
            (typeof process !== 'undefined' && process.env && process.env.FARM_ACCOUNT_ID) ||
            ''
        );
        if (!accountId) return;
        const allData = getAccounts ? getAccounts() : { accounts: [] };
        const account = (allData.accounts || []).find(a => String(a.id) === accountId);
        if (!account || !account.userId) return;
        const smtpCfg = getVipSmtpConfig ? getVipSmtpConfig(String(account.userId)) : null;
        if (!smtpCfg || !smtpCfg.notifyMature || !smtpCfg.qq) return;
        const adminCfg = getAdminSmtpConfig ? getAdminSmtpConfig() : null;
        if (!adminCfg || !adminCfg.fromEmail || !adminCfg.smtpPass) return;
        const toEmail = `${smtpCfg.qq}@qq.com`;
        await sendPushooMessage({
            channel: 'email',
            endpoint: toEmail,
            token: `${adminCfg.fromEmail}:${adminCfg.smtpPass}`,
            title: `[天王提醒] 蹲点偷菜成功`,
            content: `账号 ${account.name || accountId} 在好友「${friendName}」农场成功偷取 ${stealCount} 块！`,
        });
    } catch { /* 邮件失败不影响主流程 */ }
}

// 重点好友集合：Map<gid, { name, lastSeenHighCropAt: number }>
// lastSeenHighCropAt：最近一次检测到高等级作物的时间戳(ms)，超过2小时未见则移出
const focusFriends = new Map();

// 天王模式好友土地缓存：Map<gid, { lands: parsedLands[], updatedAt: number }>
// 每次进入好友农场后写入，供面板展示，避免面板操作与天王模式进出农场冲突
const kingFriendLandsCache = new Map();

// 蹲点好友集合：Map<gid, { name, snapshot: Map, lastChangedAt: number, campStartAt: number }>
const campFriends = new Map();

// 记录上一轮基础巡查时哪些好友已列入重点（gid Set），下一轮基础巡查时优先遍历新人
const lastBaseRoundFocusGids = new Set();

// 上一轮基础巡查完成时间戳
let lastBaseRoundDoneAt = 0;




/**
 * 判断当前好友是否有高等级作物（进入农场后用原始数据判断）
 */
function hasHighLevelCrop(rawLands, minLevel) {
    for (const land of (rawLands || [])) {
        if (!land || !land.unlocked) continue;
        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const plantCfg = getPlantById(toNum(plant.id));
        const levelNeed = plantCfg ? (Number(plantCfg.land_level_need) || 0) : 0;
        if (levelNeed >= minLevel) return true;
    }
    return false;
}

/**
 * 主调度循环：严格串行
 *
 * 流程：
 *   1. 有蹲点对象 → 跑一轮蹲点巡查（逐个退出直到全空），跑完进重点巡查
 *   2. 有重点对象 → 跑一轮完整重点巡查（收集本轮所有蹲点对象），跑完进蹲点或继续重点
 *   3. 重点也空，且距上次基础巡查 >= 1小时 → 跑基础巡查
 *   4. 不满足条件 → 等到下次基础巡查时间
 */
async function theftKingLoop() {
    if (!theftKingRunning) return;

    if (campFriends.size > 0) {
        await theftKingCampRound();
        theftKingScheduler.setTimeoutTask('main_loop', 1000, theftKingLoop);
        return;
    }

    if (focusFriends.size > 0) {
        await theftKingFocusRound();
        theftKingScheduler.setTimeoutTask('main_loop', 1000, theftKingLoop);
        return;
    }

    // 蹲点和重点都空，判断是否该开始新一轮基础巡查
    const sinceLastBase = Date.now() - lastBaseRoundDoneAt;
    if (lastBaseRoundDoneAt === 0 || sinceLastBase >= 3600 * 1000) {
        await theftKingBaseRound();
        theftKingScheduler.setTimeoutTask('main_loop', 1000, theftKingLoop);
    } else {
        const waitMs = Math.max(5000, 3600 * 1000 - sinceLastBase);
        log('天王', `等待下次基础巡查 (${Math.round(waitMs / 60000)} 分钟后)`, { module: 'theft_king', event: 'idle' });
        theftKingScheduler.setTimeoutTask('main_loop', waitMs, theftKingLoop);
    }
}

/**
 * 基础巡查：遍历所有好友，标记高等级作物好友列入重点名单
 * 优先遍历上一轮未列入重点的好友；已在重点名单的无需再进，由重点巡查高频检查
 * 连续 2 轮无高等级作物则移出重点名单
 */
async function theftKingBaseRound() {
    if (!theftKingRunning) return;
    const cfg = getTheftKingConfig();
    const minLevel = cfg.minPlantLevel;
    const state = getUserState();
    if (!state.gid) return;

    checkDailyReset(); // 跨日重置偷菜次数计数等状态

    log('天王', '基础巡查开始', { module: 'theft_king', event: 'base_round_start' });

    let friendsReply;
    try {
        friendsReply = await getAllFriends();
    } catch (e) {
        logWarn('天王', `基础巡查获取好友列表失败: ${e.message}`);
        return;
    }
    const allFriends = friendsReply.game_friends || [];
    const blacklist = new Set(getFriendBlacklist());

    // 先将所有重点好友的 missCount +1，本轮遇到则归零
    for (const [, info] of focusFriends) {
        info.missCount = (info.missCount || 0) + 1;
    }

    // 排序：优先遍历上一轮未列入重点/蹲点的新人，已是重点的放后面（由重点巡查负责）
    const newFriends = [];
    for (const f of allFriends) {
        const gid = toNum(f.gid);
        if (gid === state.gid || blacklist.has(gid)) continue;
        if (campFriends.has(gid)) continue;
        if (focusFriends.has(gid)) continue; // 已在重点名单，跳过（重点巡查负责，missCount 已+1）
        newFriends.push(f);
    }

    let addedCount = 0;
    for (const f of newFriends) {
        if (!theftKingRunning) break;

        const gid = toNum(f.gid);
        let enterReply;
        try {
            enterReply = await enterFriendFarm(gid);
        } catch {
            await sleep(200);
            continue;
        }
        const rawLands = enterReply.lands || [];
        const name = (String(f.remark || '').trim() || String(f.name || '').trim()) || `GID:${gid}`;

        if (hasHighLevelCrop(rawLands, minLevel)) {
            focusFriends.set(gid, { name, lastSeenHighCropAt: Date.now(), baseRoundCheckCount: 0, stealSkipCount: 0 });
            addedCount++;
            log('天王', `${name} 列入重点巡查`, { module: 'theft_king', event: 'focus_add', gid });
        }

        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
        await sleep(200);
    }

    // 清理重点好友：2小时内经过3轮基础巡查的重点检查均无高等级作物才移出
    // 每次基础巡查给在重点名单的好友 baseRoundCheckCount +1（由重点巡查更新 lastSeenHighCropAt/重置计数）
    for (const [gid, info] of [...focusFriends.entries()]) {
        info.baseRoundCheckCount = (info.baseRoundCheckCount || 0) + 1;
        const noHighCropTooLong = Date.now() - (info.lastSeenHighCropAt || 0) >= 2 * 60 * 60 * 1000;
        if (info.baseRoundCheckCount >= 3 && noHighCropTooLong) {
            focusFriends.delete(gid);
            log('天王', `${info.name} 2小时内3轮基础巡查均无高等级作物，移出重点`, { module: 'theft_king', event: 'focus_remove', gid });
        }
    }

    // 记录本轮结束时重点+蹲点名单，供下一轮基础巡查排序
    lastBaseRoundFocusGids.clear();
    for (const gid of focusFriends.keys()) lastBaseRoundFocusGids.add(gid);
    for (const gid of campFriends.keys()) lastBaseRoundFocusGids.add(gid);

    lastBaseRoundDoneAt = Date.now();
    log('天王', `基础巡查结束，重点好友: ${focusFriends.size} 人，蹲点: ${campFriends.size} 人${addedCount > 0 ? `，新增重点 ${addedCount} 人` : ''}`, {
        module: 'theft_king', event: 'base_round_done',
    });
}

/**
 * 重点巡查：跑完整轮所有重点好友，把满足蹲点条件的全部收集进 campFriends
 * 跑完一轮后由主循环决定下一步（有蹲点对象则进蹲点，否则继续重点）
 */
async function theftKingFocusRound() {
    if (!theftKingRunning) return;
    const cfg = getTheftKingConfig();
    const minLevel = cfg.minPlantLevel;
    const state = getUserState();
    if (!state.gid) return;
    // noSteal 细分黑名单：列入此名单的好友天王模式也跳过偷菜
    const multiBlFocus = getFriendBlacklistMulti(state.id);
    const noStealSetFocus = multiBlFocus.noSteal.length > 0 ? new Set(multiBlFocus.noSteal.map(String)) : null;

    const focusList = [...focusFriends.entries()];
    let campAddedCount = 0;
    for (let i = 0; i < focusList.length; i++) {
        if (!theftKingRunning) return;

        const [gid, info] = focusList[i];

        try {
            const enterReply = await enterFriendFarm(gid);
            const rawLands = enterReply.lands || [];
            const parsedLands = parseLandsFromRaw(rawLands);
            updateKingLandsCache(gid, parsedLands);

            const hasStealable = parsedLands.some(l => l.unlocked && l.level >= minLevel && l.status === 'stealable');
            const needCamp = shouldCampFromParsed(parsedLands, minLevel);

                if (hasStealable || needCamp) {
                    // 有可偷的先偷（直接调底层，不依赖自动偷菜开关）
                    if (hasStealable) {
                        // noSteal 黑名单检查
                        const kingNoSteal = noStealSetFocus !== null && (noStealSetFocus.has(String(gid)) || noStealSetFocus.has(info.name));
                        if (kingNoSteal) {
                            log('天王', `${info.name} 在不偷菜名单中，跳过偷取`, { module: 'theft_king', event: 'steal_skip_blacklist', gid });
                            try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                            await sleep(200);
                            continue;
                        }
                        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                        let stealOk = 0;
                        try { stealOk = await stealFriendForKing(gid, info.name, parsedLands); } catch { /* ignore */ }
                        if (stealOk <= 0) {
                            // 偷失败（次数用完 -1 或请求失败 0）→ 不加入蹲点
                            // 次数用完(-1) 和 请求失败(0) 都计入 stealSkipCount：
                            //   -1（次数用完）：连续2次移出
                            //   0（请求失败，如防偷/服务器拒绝）：连续3次移出
                            info.stealSkipCount = (info.stealSkipCount || 0) + 1;
                            const skipLimit = stealOk === -1 ? 2 : 3;
                            if (info.stealSkipCount >= skipLimit) {
                                focusFriends.delete(gid);
                                const reason = stealOk === -1 ? '次数已用完' : '请求持续失败';
                                log('天王', `${info.name} 连续 ${info.stealSkipCount} 次偷菜${reason}，移出重点名单→等待基础巡查重新发现`, { module: 'theft_king', event: 'focus_remove', gid });
                                // 通知用户手动偷菜
                                _emitStealNotify({ gid, name: info.name, reason: stealOk === -1 ? 'quota_full' : 'request_fail', skipCount: info.stealSkipCount });
                                try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                                if (i < focusList.length - 1) await sleep(200);
                                continue;
                            }
                            log('天王', `${info.name} 重点巡查发现成熟但偷菜失败（${stealOk === -1 ? '次数用完' : '请求失败'}，skipCount=${info.stealSkipCount}），跳过蹲点`, { module: 'theft_king', event: 'focus_steal_fail', gid });
                            try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                        } else {
                            // 偷成功后重新进，更新快照后加入蹲点
                            try {
                                const reEnter = await enterFriendFarm(gid);
                                const reSnap = buildLandSnapshot(parseLandsFromRaw(reEnter.lands || []));
                                campFriends.set(gid, { name: info.name, snapshot: reSnap, lastChangedAt: Date.now(), campStartAt: Date.now() });
                                try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                            } catch {
                                campFriends.set(gid, { name: info.name, snapshot: buildLandSnapshot(parsedLands), lastChangedAt: Date.now(), campStartAt: Date.now() });
                            }
                            focusFriends.delete(gid);
                            campAddedCount++;
                            log('天王', `${info.name} 重点巡查触发蹲点（已偷）`, { module: 'theft_king', event: 'camp_add', gid });
                        }
                    } else {
                        const snap = buildLandSnapshot(parsedLands);
                        campFriends.set(gid, { name: info.name, snapshot: snap, lastChangedAt: Date.now(), campStartAt: Date.now() });
                        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                        focusFriends.delete(gid);
                        campAddedCount++;
                        log('天王', `${info.name} 重点巡查触发蹲点`, { module: 'theft_king', event: 'camp_add', gid });
                    }
            } else {
                // 更新高等级作物最近观测时间，发现则重置基础巡查计数
                if (hasHighLevelCrop(rawLands, minLevel)) {
                    info.lastSeenHighCropAt = Date.now();
                    info.baseRoundCheckCount = 0;
                }

                try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                const totalActions = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
                try { await visitFriend({ gid, name: info.name }, totalActions, state.gid); } catch { /* ignore */ }
            }
        } catch {
            try { await leaveFriendFarm(gid); } catch { /* ignore */ }
        }

        if (i < focusList.length - 1) await sleep(200);
    }

    if (campAddedCount > 0) {
        log('天王', `重点巡查结束，本轮新增蹲点 ${campAddedCount} 人，当前蹲点: ${campFriends.size} 人`, {
            module: 'theft_king', event: 'focus_round_done',
        });
    }
}

/**
 * 蹲点巡查：串行遍历所有蹲点好友，跑完一轮
 * 2 分钟无变动则退出蹲点，无条件放回重点名单
 */
async function theftKingCampRound() {
    if (!theftKingRunning) return;
    const state = getUserState();
    if (!state.gid) return;
    // noSteal 细分黑名单
    const multiBlCamp = getFriendBlacklistMulti(state.id);
    const noStealSetCamp = multiBlCamp.noSteal.length > 0 ? new Set(multiBlCamp.noSteal.map(String)) : null;

    const campList = [...campFriends.entries()];
    let removedCount = 0;
    for (let i = 0; i < campList.length; i++) {
        if (!theftKingRunning) return;
        const [gid, campInfo] = campList[i];

        try {
            const enterReply = await enterFriendFarm(gid);
            const rawLands = enterReply.lands || [];
            const parsedLands = parseLandsFromRaw(rawLands);
            updateKingLandsCache(gid, parsedLands);
            const currSnap = buildLandSnapshot(parsedLands);
            const changed = hasLandChanged(campInfo.snapshot, currSnap);
            const campMinLevel = getTheftKingConfig().minPlantLevel;
            const hasStealable = parsedLands.some(l => l.unlocked && l.status === 'stealable' && l.level >= campMinLevel);

            if (hasStealable || changed) {
                try { await leaveFriendFarm(gid); } catch { /* ignore */ }

                let stealOk = 0;
                if (hasStealable) {
                    // noSteal 黑名单检查
                    const campNoSteal = noStealSetCamp !== null && (noStealSetCamp.has(String(gid)) || noStealSetCamp.has(campInfo.name));
                    if (campNoSteal) {
                        log('天王', `${campInfo.name} 在不偷菜名单中，跳过蹲点偷取`, { module: 'theft_king', event: 'steal_skip_blacklist', gid });
                        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                        await sleep(200);
                        continue;
                    }
                    // 发现成熟直接偷（不依赖自动偷菜开关）
                    try { stealOk = await stealFriendForKing(gid, campInfo.name, parsedLands); } catch { /* ignore */ }
                    if (stealOk <= 0) {
                        // 偷菜失败（次数用完或请求失败）→ 直接退出蹲点，无需重进判断
                        log('天王', `${campInfo.name} 蹲点发现成熟但偷菜失败，退出蹲点→回到重点巡查`, { module: 'theft_king', event: 'camp_remove', gid });
                        campFriends.delete(gid);
                        focusFriends.set(gid, { name: campInfo.name, lastSeenHighCropAt: Date.now(), baseRoundCheckCount: 0, stealSkipCount: 0 });
                        removedCount++;
                        if (i < campList.length - 1) await sleep(200);
                        continue;
                    }
                    campInfo.lastChangedAt = Date.now();
                    // 蹲点偷菜成功后，异步发送 VIP 邮件通知
                    _sendTheftKingMatureEmail(campInfo.name, stealOk).catch(() => {});
                } else {
                    // 仅变动时走 visitFriend 处理帮助类操作
                    const totalActions = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
                    try { await visitFriend({ gid, name: campInfo.name }, totalActions, state.gid); } catch { /* ignore */ }
                    campInfo.lastChangedAt = Date.now();
                }

                log('天王', `${campInfo.name} 蹲点${hasStealable ? '发现成熟已偷' : '检测到变动，已处理'}`, { module: 'theft_king', event: 'camp_action', gid });

                // 偷成功后重新进取快照，判断是否还有蹲点价值
                try {
                    const reEnter = await enterFriendFarm(gid);
                    const reParsed = parseLandsFromRaw(reEnter.lands || []);
                    campInfo.snapshot = buildLandSnapshot(reParsed);
                    const cfg2 = getTheftKingConfig();
                    const stillHasStealable = reParsed.some(l => l.unlocked && l.status === 'stealable' && l.level >= cfg2.minPlantLevel);
                    const stillNeedCamp = reParsed.some(l => l.unlocked && l.level >= cfg2.minPlantLevel && l.status === 'growing' && l.matureInSec <= 60);
                    try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                    if (!stillHasStealable && !stillNeedCamp) {
                        campFriends.delete(gid);
                        focusFriends.set(gid, { name: campInfo.name, lastSeenHighCropAt: Date.now(), baseRoundCheckCount: 0, stealSkipCount: 0 });
                        removedCount++;
                        log('天王', `${campInfo.name} 偷完后无需继续蹲点，退出→回到重点巡查`, { module: 'theft_king', event: 'camp_remove', gid });
                    }
                } catch {
                    campInfo.snapshot = currSnap;
                    try { await leaveFriendFarm(gid); } catch { /* ignore */ }
                }
            } else {
                campInfo.snapshot = currSnap;
            }

            // 超时检查：无论 hasStealable 还是 changed，都统一在这里判断
            // 超过 2 分钟无成功操作，或超过 10 分钟强制退出，避免无限蹲点
            const campMaxMs = 2 * 60 * 1000;
            const campTotalMs = 10 * 60 * 1000;
            if (campFriends.has(gid)) {
                const noChangeTimeout = Date.now() - campInfo.lastChangedAt > campMaxMs;
                const campTooLong = campInfo.campStartAt && (Date.now() - campInfo.campStartAt > campTotalMs);
                if (noChangeTimeout || campTooLong) {
                    campFriends.delete(gid);
                    focusFriends.set(gid, { name: campInfo.name, lastSeenHighCropAt: Date.now(), baseRoundCheckCount: 0, stealSkipCount: 0 });
                    removedCount++;
                    const reason = campTooLong ? '蹲点超过10分钟强制退出' : '蹲点2分钟无成功操作，退出蹲点';
                    log('天王', `${campInfo.name} ${reason}→回到重点巡查`, { module: 'theft_king', event: 'camp_remove', gid });
                }
            }
            if (!hasStealable && !changed) {
                try { await leaveFriendFarm(gid); } catch { /* ignore */ }
            }
        } catch {
            try { await leaveFriendFarm(gid); } catch { /* ignore */ }
        }

        if (i < campList.length - 1) await sleep(200);
    }

    log('天王', `蹲点巡查跑完一轮，当前蹲点: ${campFriends.size} 人${removedCount > 0 ? `，本轮退出蹲点 ${removedCount} 人` : ''}`, {
        module: 'theft_king', event: 'camp_round_done',
    });
}

function startTheftKingMode() {
    if (theftKingRunning) return;
    theftKingRunning = true;
    focusFriends.clear();
    campFriends.clear();
    lastBaseRoundFocusGids.clear();
    lastBaseRoundDoneAt = 0;

    // 先停掉调度器，阻止普通巡查发起新一轮
    stopFriendCheckLoop();

    if (isCheckingFriends) {
        // 普通巡查当前轮仍在跑，等待其结束后再延时 1s 启动
        log('天王', '等待普通好友巡查当前轮结束后启动…', { module: 'theft_king', event: 'start_pending' });
        const waitAndStart = () => {
            if (isCheckingFriends) {
                // 每 200ms 检查一次
                theftKingScheduler.setTimeoutTask('wait_friend_loop', 200, waitAndStart);
            } else {
                log('天王', '普通好友巡查已结束，1s 后启动超级偷菜模式', { module: 'theft_king', event: 'start' });
                theftKingScheduler.setTimeoutTask('main_loop', 1000, theftKingLoop);
            }
        };
        theftKingScheduler.setTimeoutTask('wait_friend_loop', 200, waitAndStart);
    } else {
        log('天王', '超级偷菜模式启动，普通好友巡查已暂停', { module: 'theft_king', event: 'start' });
        theftKingScheduler.setTimeoutTask('main_loop', 1000, theftKingLoop);
    }
}

function stopTheftKingMode() {
    if (!theftKingRunning) return;
    theftKingRunning = false;
    theftKingScheduler.clearAll();
    focusFriends.clear();
    campFriends.clear();
    kingFriendLandsCache.clear();
    // 恢复普通好友巡查（_fromTheftKingStop 标记允许绕过天王模式守卫）
    startFriendCheckLoop({ externalScheduler: true, _fromTheftKingStop: true });
    log('天王', '超级偷菜模式停止，普通好友巡查已恢复', { module: 'theft_king', event: 'stop' });
}

function getTheftKingStatus() {
    return {
        running: theftKingRunning,
        focusCount: focusFriends.size,
        campCount: campFriends.size,
        focusList: [...focusFriends.entries()].map(([gid, v]) => ({ gid, name: v.name, lastSeenHighCropAt: v.lastSeenHighCropAt })),
        campList: [...campFriends.entries()].map(([gid, v]) => ({ gid, name: v.name, lastChangedAt: v.lastChangedAt })),
    };
}

// ============ 偷挂狗模式 ============

const stealDogsScheduler = createScheduler('steal_dogs');
let stealDogsRunning = false;
let _stealDogsAccountId = null;

function setStealDogsAccountId(accountId) { _stealDogsAccountId = String(accountId || ''); }

/**
 * 偷挂狗模式主循环：每小时巡查一次，只对挂狗好友执行偷菜
 */
async function _stealDogsLoop() {
    if (!stealDogsRunning) return;
    await _stealDogsRound();
    if (stealDogsRunning) {
        stealDogsScheduler.setTimeoutTask('steal_dogs_loop', 60 * 60 * 1000, _stealDogsLoop);
    }
}

async function _stealDogsRound() {
    if (!stealDogsRunning) return;
    let antiafk;
    try { antiafk = require('./antiafk'); } catch { return; }
    if (!_stealDogsAccountId) return;

    if (!antiafk.isStealDogsEnabled(_stealDogsAccountId)) return;

    const dogGids = antiafk.getActiveDogGids(_stealDogsAccountId);
    if (dogGids.size === 0) {
        log('防挂', '偷挂狗：挂狗名单为空，跳过本轮', { module: 'steal_dogs' });
        return;
    }

    const state = getUserState();
    if (!state.gid) return;

    let friendsReply;
    try { friendsReply = await getAllFriends(); } catch (e) {
        logWarn('防挂', `偷挂狗：获取好友列表失败: ${e.message}`);
        return;
    }

    const friends = (friendsReply.game_friends || []).filter(f => {
        const gid = toNum(f.gid);
        return gid !== state.gid && dogGids.has(gid);
    });

    if (friends.length === 0) {
        log('防挂', '偷挂狗：挂狗均不在好友列表中，跳过', { module: 'steal_dogs' });
        return;
    }

    log('防挂', `偷挂狗：开始巡查 ${friends.length} 个挂狗好友`, { module: 'steal_dogs', event: 'round_start', count: friends.length });

    let totalStolen = 0;
    for (const f of friends) {
        if (!stealDogsRunning) break;
        const gid = toNum(f.gid);
        const name = f.remark || f.name || `GID:${gid}`;
        try {
            const enterReply = await enterFriendFarm(gid);
            const rawLands = enterReply.lands || [];
            const parsedLands = parseLandsFromRaw(rawLands);
            // 用天王模式同款逻辑偷高等级作物（stealFriendForKing 自带 minPlantLevel 过滤）
            const ok = await stealFriendForKing(gid, name, parsedLands);
            if (ok > 0) totalStolen += ok;
            await leaveFriendFarm(gid);
        } catch (e) {
            logWarn('防挂', `偷挂狗：访问 ${name}(${gid}) 失败: ${e.message}`);
        }
        await sleep(500);
    }

    if (totalStolen > 0) {
        try { await (require('./warehouse').sellAllFruits)(); } catch {}
        log('防挂', `偷挂狗：本轮共偷 ${totalStolen} 块`, { module: 'steal_dogs', event: 'round_done', totalStolen });
    }
}

function startStealDogsMode(accountId) {
    if (stealDogsRunning) return;
    if (accountId) _stealDogsAccountId = String(accountId);
    stealDogsRunning = true;
    log('防挂', '偷挂狗模式已启动', { module: 'steal_dogs', event: 'start' });
    stealDogsScheduler.setTimeoutTask('steal_dogs_loop', 2000, _stealDogsLoop);
}

function stopStealDogsMode() {
    stealDogsRunning = false;
    stealDogsScheduler.clearAll();
    log('防挂', '偷挂狗模式已停止', { module: 'steal_dogs', event: 'stop' });
}

module.exports = {
    checkFriends, startFriendCheckLoop, stopFriendCheckLoop,
    refreshFriendCheckLoop,
    checkAndAcceptApplications,
    getOperationLimits,
    getFriendsList,
    getFriendLandsDetail,
    doFriendOperation,
    startTheftKingMode,
    stopTheftKingMode,
    getTheftKingStatus,
    setStealNotifyCallback,
    startStealDogsMode,
    stopStealDogsMode,
    setStealDogsAccountId,
};
