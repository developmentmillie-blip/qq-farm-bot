const stealStats = require('./steal-stats');
/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const protobuf = require('protobufjs');
const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantNameBySeedId, getPlantName, getPlantExp, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantById, getItemById, getSeedImageBySeedId } = require('../config/gameConfig');
const { isAutomationOn, getPreferredSeed, getAutomation, getPlantingStrategy}  = require('../models/store');
const { sendMsgAsync, getUserState, networkEvents, getWsErrorState}  = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep } = require('../utils/utils');
const { getPlantRankings } = require('./analytics');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');

// ============ 防挂模块（延迟加载，避免循环依赖）============
let _antiafkMod = null;
function _getAntiafk() {
    if (!_antiafkMod) { try { _antiafkMod = require('./antiafk'); } catch { _antiafkMod = null; } }
    return _antiafkMod;
}
// 防挂钩子：当前账号ID注入（由 worker.js 或 friend.js 注入）
let _antiafkAccountId = null;
function setAntiafkAccountId(accountId) { _antiafkAccountId = String(accountId || ''); }

// ============ 内部状态 ============
let isCheckingFarm = false;
let isFirstFarmCheck = true;
let farmLoopRunning = false;
let externalSchedulerMode = false;
const farmScheduler = createScheduler('farm');

// ============ 被动操作追踪（被偷/被帮/被捣乱）============
// 外部注入：好友列表查询函数（由 friend.js 调用 setFriendLookupCallback 注入，避免循环依赖）
let friendLookupCallback = null;
function setFriendLookupCallback(fn) { friendLookupCallback = fn; }

// 上次收到推送时各地块的快照：Map<landId, { stealers: Set, weed_owners: Set, insect_owners: Set, stole_num: number }>
const lastLandsSnapshot = new Map();

/**
 * 通过 GID 查好友名字，优先使用注入的好友列表，查不到就用 GID 字符串
 */
function lookupFriendName(gid) {
    if (typeof friendLookupCallback === 'function') {
        const name = friendLookupCallback(gid);
        if (name) return name;
    }
    return `GID:${gid}`;
}

/**
 * 对比推送的土地列表与上次快照，识别被偷/被帮除草/被帮除虫/被放草/被放虫，打日志并记录统计
 */
function diffLandsAndLog(newLands) {
    for (const land of newLands) {
        const id = toNum(land.id);
        if (!id) continue;
        const plant = land.plant;
        if (!plant) {
            // 土地无植物（已收获/空地），清除快照
            lastLandsSnapshot.delete(id);
            continue;
        }

        const newStealers = new Set((plant.stealers || []).map(g => toNum(g)));
        const newWeedOwners = new Set((plant.weed_owners || []).map(g => toNum(g)));
        const newInsectOwners = new Set((plant.insect_owners || []).map(g => toNum(g)));
        const newStoleNum = toNum(plant.stole_num);
        const plantName = plant.name || '作物';

        const prev = lastLandsSnapshot.get(id);

        if (prev) {
            // ---- 被偷：新增的 stealers ----
            for (const gid of newStealers) {
                if (!prev.stealers.has(gid)) {
                    const name = lookupFriendName(gid);
                    log('被偷', `${name} 偷了你的 ${plantName}（地块#${id}）`, {
                        module: 'farm', event: 'be_stolen', friendGid: gid, friendName: name, landId: id, plant: plantName,
                    });
                    recordOperation('beStolen', 1);
                    try {
                        const { getKeeperAccountId } = require('../utils/network');
                        const fruitId = plant.fruit_id ? Number(plant.fruit_id) : 0;
                        const fruitNum = plant.fruit_num ? Number(plant.fruit_num) : 0;
                        const ic = fruitId ? getItemById(fruitId) : null;
                        const gold = ic ? (ic.price || 0) * fruitNum : 0;
                        stealStats.recordTheyStole(getKeeperAccountId(), gid, name, gold);
                    } catch {}
                    // 防挂模块被偷钩子
                    try {
                        const af = _getAntiafk();
                        if (af && _antiafkAccountId) af.onBeStolen(_antiafkAccountId, gid, name, id);
                    } catch {}
                }
            }

            // ---- 被帮除草：weed_owners 从有到无（被人除掉了）----
            if (prev.weedOwners.size > 0 && newWeedOwners.size < prev.weedOwners.size) {
                // 除草者无法从协议中直接识别（除草后 weed_owners 清空），只记录事件
                log('被帮', `有好友帮你除草了（地块#${id} ${plantName}）`, {
                    module: 'farm', event: 'be_helped_weed', landId: id, plant: plantName,
                });
                recordOperation('beHelped', 1);
            }

            // ---- 被帮除虫：insect_owners 从有到无 ----
            if (prev.insectOwners.size > 0 && newInsectOwners.size < prev.insectOwners.size) {
                log('被帮', `有好友帮你除虫了（地块#${id} ${plantName}）`, {
                    module: 'farm', event: 'be_helped_bug', landId: id, plant: plantName,
                });
                recordOperation('beHelped', 1);
            }

            // ---- 被放草：新增的 weed_owners ----
            for (const gid of newWeedOwners) {
                if (!prev.weedOwners.has(gid)) {
                    const name = lookupFriendName(gid);
                    log('被捣乱', `${name} 在你的 ${plantName} 放了草（地块#${id}）`, {
                        module: 'farm', event: 'be_put_weed', friendGid: gid, friendName: name, landId: id, plant: plantName,
                    });
                    recordOperation('bePutWeed', 1);
                }
            }

            // ---- 被放虫：新增的 insect_owners ----
            for (const gid of newInsectOwners) {
                if (!prev.insectOwners.has(gid)) {
                    const name = lookupFriendName(gid);
                    log('被捣乱', `${name} 在你的 ${plantName} 放了虫（地块#${id}）`, {
                        module: 'farm', event: 'be_put_bug', friendGid: gid, friendName: name, landId: id, plant: plantName,
                    });
                    recordOperation('bePutBug', 1);
                }
            }
        }

        // 更新快照
        lastLandsSnapshot.set(id, {
            stealers: newStealers,
            weedOwners: newWeedOwners,
            insectOwners: newInsectOwners,
            stoleNum: newStoleNum,
        });
    }
}

/**
 * 用首次 getAllLands 的结果初始化快照，避免启动时把历史状态全量误报
 * 在 checkFarm 第一次拿到土地数据后调用
 */
function initLandsSnapshot(lands) {
    lastLandsSnapshot.clear();
    for (const land of (lands || [])) {
        const id = toNum(land.id);
        if (!id) continue;
        const plant = land.plant;
        if (!plant) continue;
        lastLandsSnapshot.set(id, {
            stealers: new Set((plant.stealers || []).map(g => toNum(g))),
            weedOwners: new Set((plant.weed_owners || []).map(g => toNum(g))),
            insectOwners: new Set((plant.insect_owners || []).map(g => toNum(g))),
            stoleNum: toNum(plant.stole_num),
        });
    }
}

// ============ 农场 API ============

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate = null;
function setOperationLimitsCallback(callback) {
    onOperationLimitsUpdate = callback;
}

/**
 * 通用植物操作请求
 */
async function sendPlantRequest(RequestType, ReplyType, method, landIds, hostGid) {
    const body = RequestType.encode(RequestType.create({
        land_ids: landIds,
        host_gid: toLong(hostGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
    return ReplyType.decode(replyBody);
}

async function getAllLands() {
    const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
    const reply = types.AllLandsReply.decode(replyBody);
    // 更新操作限制
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}

async function harvest(landIds) {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

async function waterLand(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.WaterLandRequest, types.WaterLandReply, 'WaterLand', landIds, state.gid);
}

async function weedOut(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.WeedOutRequest, types.WeedOutReply, 'WeedOut', landIds, state.gid);
}

async function insecticide(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.InsecticideRequest, types.InsecticideReply, 'Insecticide', landIds, state.gid);
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID = 1011;
// 有机肥料 ID
const ORGANIC_FERTILIZER_ID = 1012;

/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 游戏中拖动施肥间隔很短，这里用 50ms
 */
async function fertilize(landIds, fertilizerId = NORMAL_FERTILIZER_ID) {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(fertilizerId),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 施肥失败（可能肥料不足），停止继续
            break;
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

/**
 * 有机肥循环施肥:
 * 按地块顺序 1-2-3-...-1 持续施肥，直到出现失败即停止。
 */
async function fertilizeOrganicLoop(landIds) {
    const ids = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
    if (ids.length === 0) return 0;

    let successCount = 0;
    let idx = 0;

    while (true) {
        const landId = ids[idx];
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(ORGANIC_FERTILIZER_ID),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 常见是有机肥耗尽，按需求直接停止
            break;
        }

        idx = (idx + 1) % ids.length;
        await sleep(100);
    }

    return successCount;
}

function getOrganicFertilizerTargetsFromLands(lands) {
    const list = Array.isArray(lands) ? lands : [];
    const targets = [];
    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases);
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;

        // 服务端有该字段时，<=0 说明该地当前不能再施有机肥
        if (Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times')) {
            const leftTimes = toNum(plant.left_inorc_fert_times);
            if (leftTimes <= 0) continue;
        }

        targets.push(landId);
    }
    return targets;
}

async function runFertilizerByConfig(plantedLands = []) {
    const fertilizerConfig = getAutomation().fertilizer || 'both';
    const planted = (Array.isArray(plantedLands) ? plantedLands : []).filter(Boolean);

    if (planted.length === 0 && fertilizerConfig !== 'organic' && fertilizerConfig !== 'both') {
        return { normal: 0, organic: 0 };
    }

    let fertilizedNormal = 0;
    let fertilizedOrganic = 0;

    if ((fertilizerConfig === 'normal' || fertilizerConfig === 'both') && planted.length > 0) {
        fertilizedNormal = await fertilize(planted, NORMAL_FERTILIZER_ID);
        if (fertilizedNormal > 0) {
            log('施肥', `已为 ${fertilizedNormal}/${planted.length} 块地施无机化肥`, {
                module: 'farm',
                event: 'fertilize',
                result: 'ok',
                type: 'normal',
                count: fertilizedNormal,
            });
            recordOperation('fertilize', fertilizedNormal);
        }
    }

    if (fertilizerConfig === 'organic' || fertilizerConfig === 'both') {
        let organicTargets = planted;
        try {
            const latest = await getAllLands();
            organicTargets = getOrganicFertilizerTargetsFromLands(latest && latest.lands);
        } catch (e) {
            logWarn('施肥', `获取全农场地块失败，回退已种地块: ${e.message}`);
        }

        fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
        if (fertilizedOrganic > 0) {
            // 通知防挂模块：这些地块刚被有机肥催熟
            try {
                const af = _getAntiafk();
                if (af && _antiafkAccountId && organicTargets.length > 0) {
                    // 构建 landId -> level 映射（从 latest.lands 中查）
                    const landsArr = (typeof latest !== 'undefined' && latest && latest.lands) ? latest.lands : [];
                    const levelMap = {};
                    for (const land of landsArr) {
                        const lid = toNum(land.id);
                        if (!lid) continue;
                        const plant = land.plant;
                        const plantCfg = plant ? getPlantById(toNum(plant.id)) : null;
                        levelMap[lid] = plantCfg ? (Number(plantCfg.land_level_need) || 0) : 0;
                    }
                    for (const landId of organicTargets) {
                        af.onOrganicFertApplied(_antiafkAccountId, landId, levelMap[landId] || 0);
                    }
                }
            } catch {}
            log('施肥', `有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次`, {
                module: 'farm',
                event: 'fertilize',
                result: 'ok',
                type: 'organic',
                count: fertilizedOrganic,
            });
            recordOperation('fertilize', fertilizedOrganic);
        }
    }

    return { normal: fertilizedNormal, organic: fertilizedOrganic };
}

async function removePlant(landIds) {
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: landIds.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}

async function upgradeLand(landId) {
    const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
        land_id: toLong(landId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
    return types.UpgradeLandReply.decode(replyBody);
}

async function unlockLand(landId, doShared = false) {
    const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
        land_id: toLong(landId),
        do_shared: !!doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
    return types.UnlockLandReply.decode(replyBody);
}

// ============ 商店 API ============

async function getShopInfo(shopId) {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}

async function buyGoods(goodsId, num, price) {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}

// ============ 种植 ============

function encodePlantRequest(seedId, landIds) {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用 50ms
 */
async function plantSeeds(seedId, landIds) {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = encodePlantRequest(seedId, [landId]);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            types.PlantReply.decode(replyBody);
            successCount++;
        } catch (e) {
            logWarn('种植', `土地#${landId} 失败: ${e.message}`);
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

async function findBestSeed() {
    const SEED_SHOP_ID = 2;
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return null;
    }

    const state = getUserState();
    const available = [];
    for (const goods of shopReply.goods_list) {
        if (!goods.unlocked) continue;

        let meetsConditions = true;
        let requiredLevel = 0;
        const conds = goods.conds || [];
        for (const cond of conds) {
            if (toNum(cond.type) === 1) {
                requiredLevel = toNum(cond.param);
                if (state.level < requiredLevel) {
                    meetsConditions = false;
                    break;
                }
            }
        }
        if (!meetsConditions) continue;

        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        if (limitCount > 0 && boughtNum >= limitCount) continue;

        available.push({
            goods,
            goodsId: toNum(goods.id),
            seedId: toNum(goods.item_id),
            price: toNum(goods.price),
            requiredLevel,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return null;
    }

    // 按策略排序
    const strategy = getPlantingStrategy();
    const analyticsSortByMap = {
        max_exp: 'exp',
        max_fert_exp: 'fert',
        max_profit: 'profit',
        max_fert_profit: 'fert_profit',
    };
    const analyticsSortBy = analyticsSortByMap[strategy];
    if (analyticsSortBy) {
        try {
            const rankings = getPlantRankings(analyticsSortBy);
            const availableBySeedId = new Map(available.map(a => [a.seedId, a]));
            for (const row of rankings) {
                const seedId = Number(row && row.seedId) || 0;
                if (seedId <= 0) continue;
                const lv = Number(row && row.level);
                if (Number.isFinite(lv) && lv > state.level) continue;
                const found = availableBySeedId.get(seedId);
                if (found) return found;
            }
            logWarn('商店', `策略 ${strategy} 未找到可购买作物，回退最高等级`);
        } catch (e) {
            logWarn('商店', `策略 ${strategy} 计算失败: ${e.message}，回退最高等级`);
        }
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
        return available[0];
    }
    
    // 偏好模式
    if (strategy === 'preferred') {
        const preferred = getPreferredSeed();
        if (preferred > 0) {
            const found = available.find(a => a.seedId === preferred);
            if (found) return found;
            logWarn('商店', `优先种子 ${preferred} 当前不可购买，回退自动选择`);
        }
        // 如果偏好未找到或未设置，回退到默认（等级最高）
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    }
    // 最高等级模式
    else if (strategy === 'level') {
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    } 
    // 默认
    else {
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    }

    return available[0];
}

async function getAvailableSeeds() {
    const SEED_SHOP_ID = 2;
    const state = getUserState();
    let list = [];
    
    try {
        const shopReply = await getShopInfo(SEED_SHOP_ID);
        if (shopReply.goods_list) {
            for (const goods of shopReply.goods_list) {
                // 不再过滤不可用的种子，而是返回给前端展示状态
                let requiredLevel = 0;
                for (const cond of goods.conds || []) {
                    if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
                }
                
                const limitCount = toNum(goods.limit_count);
                const boughtNum = toNum(goods.bought_num);
                const isSoldOut = limitCount > 0 && boughtNum >= limitCount;
    
                list.push({
                    seedId: toNum(goods.item_id),
                    goodsId: toNum(goods.id),
                    name: getPlantNameBySeedId(toNum(goods.item_id)),
                    price: toNum(goods.price),
                    requiredLevel,
                    locked: !goods.unlocked || state.level < requiredLevel,
                    soldOut: isSoldOut,
                });
            }
        }
    } catch (e) {
        const wsErr = getWsErrorState();
        if (!wsErr || Number(wsErr.code) !== 400) {
            logWarn('商店', `获取商店失败: ${e.message}，使用本地备选列表`);
        }
    }

    // 如果商店请求失败或为空，使用本地配置
    if (list.length === 0) {
        const allSeeds = getAllSeeds();
        list = allSeeds.map(s => ({
            ...s,
            goodsId: 0,
            price: null, // 未知价格
            requiredLevel: null, // 未知等级
            unknownMeta: true,
            locked: false,
            soldOut: false,
        }));
    }

    // 补充背包中有但商店不出售的种子（如活动种子）
    try {
        const { getBagDetail } = require('./warehouse');
        const bagData = await getBagDetail();
        if (bagData && bagData.items) {
            const shopSeedIds = new Set(list.map(s => s.seedId));
            for (const item of bagData.items) {
                if (item.category === 'seed' && !shopSeedIds.has(item.id) && item.count > 0) {
                    list.push({
                        seedId: item.id,
                        goodsId: 0,
                        name: item.name,
                        price: null,
                        requiredLevel: null,
                        locked: false,
                        soldOut: false,
                        fromBag: true,
                        bagCount: item.count,
                    });
                    shopSeedIds.add(item.id);
                }
            }
        }
    } catch (e) {
        // 获取背包失败不影响主流程
    }

    return list.sort((a, b) => {
        const av = (a.requiredLevel === null || a.requiredLevel === undefined) ? 9999 : a.requiredLevel;
        const bv = (b.requiredLevel === null || b.requiredLevel === undefined) ? 9999 : b.requiredLevel;
        return av - bv;
    });
}

async function getLandsDetail() {
    try {
        const landsReply = await getAllLands();
        if (!landsReply.lands) return { lands: [], summary: {} };
        const status = analyzeLands(landsReply.lands);
        const nowSec = getServerTimeSec();
        const lands = [];

        for (const land of landsReply.lands) {
            const id = toNum(land.id);
            const level = toNum(land.level);
            const maxLevel = toNum(land.max_level);
            const landsLevel = toNum(land.lands_level);
            const landSize = toNum(land.land_size);
            const couldUnlock = !!land.could_unlock;
            const couldUpgrade = !!land.could_upgrade;
            if (!land.unlocked) {
                lands.push({
                    id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                });
                continue;
            }
            const plant = land.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '空地',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                });
                continue;
            }
            const currentPhase = getCurrentPhase(plant.phases, false, '');
            if (!currentPhase) {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                });
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
            if (phaseVal === PlantPhase.MATURE) landStatus = 'harvestable';
            else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';
            else if (phaseVal === PlantPhase.UNKNOWN || !plant.phases.length) landStatus = 'empty';

            const needWater = (toNum(plant.dry_num) > 0) || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec);
            const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec);
            const needBug = (plant.insect_owners && plant.insect_owners.length > 0) || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec);

            lands.push({
                id,
                unlocked: true,
                status: landStatus,
                plantName,
                seedId,
                seedImage,
                phaseName,
                matureInSec,
                needWater,
                needWeed,
                needBug,
                stealable: !!plant.stealable,
                level,
                maxLevel,
                landsLevel,
                landSize,
                couldUnlock,
                couldUpgrade,
            });
        }

        return {
            lands,
            summary: {
                harvestable: status.harvestable.length,
                growing: status.growing.length,
                empty: status.empty.length,
                dead: status.dead.length,
                needWater: status.needWater.length,
                needWeed: status.needWeed.length,
                needBug: status.needBug.length,
            },
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function autoPlantEmptyLands(deadLandIds, emptyLandIds, forceSeedId = 0) {
    let landsToPlant = [...emptyLandIds];
    const state = getUserState();

    // 1. 铲除枯死/收获残留植物（一键操作）
    if (deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`, {
                module: 'farm', event: 'remove_plant', result: 'ok', count: deadLandIds.length
            });
            landsToPlant.push(...deadLandIds);
        } catch (e) {
            logWarn('铲除', `批量铲除失败: ${e.message}`, {
                module: 'farm', event: 'remove_plant', result: 'error'
            });
            // 失败时仍然尝试种植
            landsToPlant.push(...deadLandIds);
        }
    }

    if (landsToPlant.length === 0) return;

    // 2. 确定种子（forceSeedId > 0 时直接从商店查找该种子信息；否则用自动策略）
    let bestSeed;
    let skipBuy = false;  // 背包中已有种子，跳过购买
    if (forceSeedId > 0) {
        // 指定种子模式：先从商店查询该种子的 goodsId 和 price
        try {
            const SEED_SHOP_ID = 2;
            const shopReply = await getShopInfo(SEED_SHOP_ID);
            const goods = (shopReply.goods_list || []).find(g => toNum(g.item_id) === forceSeedId);
            if (goods) {
                bestSeed = {
                    seedId: forceSeedId,
                    goodsId: toNum(goods.id),
                    price: toNum(goods.price),
                };
            } else {
                // 商店没有该种子，尝试从背包获取（活动种子等）
                try {
                    const { getBagDetail } = require('./warehouse');
                    const bagData = await getBagDetail();
                    const bagItem = bagData && bagData.items && bagData.items.find(
                        it => it.id === forceSeedId && it.category === 'seed' && it.count > 0
                    );
                    if (bagItem) {
                        bestSeed = {
                            seedId: forceSeedId,
                            goodsId: 0,
                            price: 0,
                            bagCount: bagItem.count,
                        };
                        skipBuy = true;
                        log('种植', `指定种子 ${bagItem.name}(${forceSeedId}) 从背包获取，数量=${bagItem.count}`);
                    } else {
                        logWarn('商店', `指定种子 ${forceSeedId} 在商店和背包中均未找到`);
                        return;
                    }
                } catch (e) {
                    logWarn('商店', `指定种子 ${forceSeedId} 在商店中未找到，背包查询失败: ${e.message}`);
                    return;
                }
            }
        } catch (e) {
            logWarn('商店', `查询指定种子失败: ${e.message}`);
            return;
        }
    } else {
        try {
            bestSeed = await findBestSeed();
        } catch (e) {
            logWarn('商店', `查询失败: ${e.message}`);
            return;
        }
        if (!bestSeed) return;
    }

    const seedName = getPlantNameBySeedId(bestSeed.seedId);
    const growTime = getPlantGrowTime(1020000 + (bestSeed.seedId - 20000));  // 转换为植物ID
    const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
    log('商店', `最佳种子: ${seedName} (${bestSeed.seedId}) 价格=${bestSeed.price}金币${growTimeStr}`, {
        module: 'warehouse', event: 'seed_pick', seedId: bestSeed.seedId, price: bestSeed.price
    });

    // 3. 购买（背包种子跳过购买）
    let actualSeedId = bestSeed.seedId;
    if (skipBuy) {
        // 背包种子：限制种植数量不超过背包数量
        const bagAvail = bestSeed.bagCount || 0;
        if (bagAvail < landsToPlant.length) {
            landsToPlant = landsToPlant.slice(0, bagAvail);
            log('种植', `背包种子数量有限(${bagAvail})，只种 ${bagAvail} 块地`);
        }
        if (landsToPlant.length === 0) return;
    } else {
        const needCount = landsToPlant.length;
        const totalCost = bestSeed.price * needCount;
        if (totalCost > state.gold) {
            logWarn('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${state.gold} 金币`, {
                module: 'farm', event: 'seed_buy_skip', result: 'insufficient_gold', need: totalCost, current: state.gold
            });
            const canBuy = Math.floor(state.gold / bestSeed.price);
            if (canBuy <= 0) return;
            landsToPlant = landsToPlant.slice(0, canBuy);
            log('商店', `金币有限，只种 ${canBuy} 块地`);
        }

        try {
            const buyReply = await buyGoods(bestSeed.goodsId, landsToPlant.length, bestSeed.price);
            if (buyReply.get_items && buyReply.get_items.length > 0) {
                const gotItem = buyReply.get_items[0];
                const gotId = toNum(gotItem.id);
                if (gotId > 0) actualSeedId = gotId;
            }
            if (buyReply.cost_items) {
                for (const item of buyReply.cost_items) {
                    state.gold -= toNum(item.count);
                }
            }
            const boughtName = getPlantNameBySeedId(actualSeedId);
            log('购买', `已购买 ${boughtName}种子 x${landsToPlant.length}, 花费 ${bestSeed.price * landsToPlant.length} 金币`, {
                module: 'warehouse',
                event: 'seed_buy',
                result: 'ok',
                seedId: actualSeedId,
                count: landsToPlant.length,
                cost: bestSeed.price * landsToPlant.length,
            });
        } catch (e) {
            logWarn('购买', e.message);
            return;
        }
    }

    // 4. 种植（逐块拖动，间隔50ms）
    let plantedLands = [];
    try {
        const planted = await plantSeeds(actualSeedId, landsToPlant);
        log('种植', `已在 ${planted} 块地种植 (${landsToPlant.join(',')})`, {
            module: 'farm',
            event: 'plant_seed',
            result: 'ok',
            seedId: actualSeedId,
            count: planted,
        });
        if (planted > 0) {
            plantedLands = landsToPlant.slice(0, planted);
        }
    } catch (e) {
        logWarn('种植', e.message);
    }

    // 5. 施肥
    await runFertilizerByConfig(plantedLands);
}

function getCurrentPhase(phases, debug, landLabel) {
    if (!phases || phases.length === 0) return null;

    const nowSec = getServerTimeSec();

    if (debug) {
        console.warn(`    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
        for (let i = 0; i < phases.length; i++) {
            const p = phases[i];
            const bt = toTimeSec(p.begin_time);
            const phaseName = PHASE_NAMES[p.phase] || `阶段${p.phase}`;
            const diff = bt > 0 ? (bt - nowSec) : 0;
            const diffStr = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
            console.warn(`    ${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
        }
    }

    for (let i = phases.length - 1; i >= 0; i--) {
        const beginTime = toTimeSec(phases[i].begin_time);
        if (beginTime > 0 && beginTime <= nowSec) {
            if (debug) {
                console.warn(`    ${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[i].phase] || phases[i].phase}`);
            }
            return phases[i];
        }
    }

    if (debug) {
        console.warn(`    ${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`);
    }
    return phases[0];
}

function analyzeLands(lands) {
    const result = {
        harvestable: [], needWater: [], needWeed: [], needBug: [], needNormalFert: [],
        growing: [], empty: [], dead: [], unlockable: [], upgradable: [],
        harvestableInfo: [], growingInfo: [],
    };

    const nowSec = getServerTimeSec();
    const debug = isFirstFarmCheck;

    for (const land of lands) {
        const id = toNum(land.id);
        if (!land.unlocked) {
            if (land.could_unlock) {
                result.unlockable.push(id);
            }
            continue;
        }
        if (land.could_upgrade) {
            result.upgradable.push(id);
        }

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) {
            result.empty.push(id);
            continue;
        }

        const plantName = plant.name || '未知作物';
        const landLabel = `土地#${id}(${plantName})`;

        const currentPhase = getCurrentPhase(plant.phases, debug, landLabel);
        if (!currentPhase) {
            result.empty.push(id);
            continue;
        }
        const phaseVal = currentPhase.phase;

        if (phaseVal === PlantPhase.DEAD) {
            result.dead.push(id);
            continue;
        }

        if (phaseVal === PlantPhase.MATURE) {
            result.harvestable.push(id);
            const plantId = toNum(plant.id);
            // plant.id 在游戏协议里是 seed_id，getPlantNameBySeedId 才能正确取中文名
            const plantNameFromConfig = getPlantNameBySeedId(plantId) || getPlantName(plantId);
            const plantExp = getPlantExp(plantId);
            result.harvestableInfo.push({
                landId: id,
                plantId,
                name: plantNameFromConfig || plantName,
                exp: plantExp,
            });
            continue;
        }

        const dryNum = toNum(plant.dry_num);
        const dryTime = toTimeSec(currentPhase.dry_time);
        if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
            result.needWater.push(id);
        }

        const weedsTime = toTimeSec(currentPhase.weeds_time);
        const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec);
        if (hasWeeds) {
            result.needWeed.push(id);
        }

        const insectTime = toTimeSec(currentPhase.insect_time);
        const hasBugs = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec);
        if (hasBugs) {
            result.needBug.push(id);
        }

        const _mp=Array.isArray(plant.phases)?plant.phases.find(p=>p&&toNum(p.phase)===PlantPhase.MATURE):null;
        const _mAt=_mp?toTimeSec(_mp.begin_time):0;
        result.growingInfo.push({landId:id,matureAt:_mAt});
        // 无机肥：当前阶段 ferts_used[1011]==0 说明本阶段还未施过
        const _fertsUsed = currentPhase.ferts_used || {};
        const _normalFertKey = Object.prototype.hasOwnProperty.call(_fertsUsed, 1011) ? 1011
            : (Object.prototype.hasOwnProperty.call(_fertsUsed, '1011') ? '1011' : null);
        const _normalFertUsed = _normalFertKey !== null ? toNum(_fertsUsed[_normalFertKey]) : 0;
        if (_normalFertUsed === 0) { result.needNormalFert.push(id); }
        result.growing.push(id);
    }

    return result;
}

async function checkFarmAndGetStatus() {
    const state = getUserState();
    if (isCheckingFarm || !state.gid || !isAutomationOn('farm')) return null;
    isCheckingFarm = true;
    try {
        const result = await runFarmOperation('auto');
        isFirstFarmCheck = false;
        return result && result.status;
    } catch (err) {
        logWarn('巡田', '检查失败: ' + err.message);
        return null;
    } finally {
        isCheckingFarm = false;
    }
}

async function checkFarm() {
    const s = await checkFarmAndGetStatus();
    return s !== null;
}

/**
 * 手动/自动执行农场操作
 * @param {string} opType - 'all'(手动一键全收), 'auto'(自动控制), 'harvest', 'clear', 'plant', 'upgrade'
 */
async function runFarmOperation(opType) {
    const landsReply = await getAllLands();
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all' && opType !== 'auto') {
            log('农场', '没有土地数据');
        }
        return { hadWork: false, actions: [] };
    }

    const lands = landsReply.lands;
    // 首次巡田时初始化被动追踪快照，避免把历史状态全量误报
    if (isFirstFarmCheck) {
        initLandsSnapshot(lands);
    }
    const status = analyzeLands(lands);

    // 摘要
    const statusParts = [];
    if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
    if (status.needWeed.length) statusParts.push(`草:${status.needWeed.length}`);
    if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
    if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
    if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
    if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
    if (status.unlockable.length) statusParts.push(`解:${status.unlockable.length}`);
    if (status.upgradable.length) statusParts.push(`升:${status.upgradable.length}`);
    statusParts.push(`长:${status.growing.length}`);

    const actions = [];
    const batchOps = [];

    // 辅助：从 lands 数组中提取各地块成熟时间快照 { landId -> matureTimeSec }
    function captureMatureSnapshot(landsArr) {
        const map = new Map();
        for (const land of (landsArr || [])) {
            const id = toNum(land.id);
            if (!id || !land.plant || !Array.isArray(land.plant.phases)) continue;
            const mp = land.plant.phases.find(p => p && toNum(p.phase) === PlantPhase.MATURE);
            map.set(id, mp ? toTimeSec(mp.begin_time) : 0);
        }
        return map;
    }

    // 执行除草/虫/水（all 模式：批量执行，不做事后验证避免超时；clear 模式：验证实际结果）
    if (opType === 'all' || opType === 'auto' || opType === 'clear') {
        const hasAny = status.needWeed.length > 0 || status.needBug.length > 0 || status.needWater.length > 0;
        if (hasAny) {
            if (status.needWeed.length > 0) {
                batchOps.push(weedOut(status.needWeed).catch(e => logWarn('除草', e.message)));
            }
            if (status.needBug.length > 0) {
                batchOps.push(insecticide(status.needBug).catch(e => logWarn('除虫', e.message)));
            }
            if (status.needWater.length > 0) {
                batchOps.push(waterLand(status.needWater).catch(e => logWarn('浇水', e.message)));
            }
            await Promise.all(batchOps);

            if (opType === 'clear') {
                // 手动除草/虫/水：操作后重新拉取，通过实际状态判断结果
                try {
                    const afterReply = await getAllLands();
                    const afterStatus = analyzeLands(afterReply.lands || []);
                    const afterWeedSet = new Set(afterStatus.needWeed);
                    const afterBugSet = new Set(afterStatus.needBug);
                    const afterWaterSet = new Set(afterStatus.needWater);
                    const clearedWeed = status.needWeed.filter(id => !afterWeedSet.has(id)).length;
                    const clearedBug = status.needBug.filter(id => !afterBugSet.has(id)).length;
                    const wateredCount = status.needWater.filter(id => !afterWaterSet.has(id)).length;
                    if (clearedWeed > 0) { actions.push(`除草${clearedWeed}`); recordOperation('weed', clearedWeed); }
                    if (clearedBug > 0) { actions.push(`除虫${clearedBug}`); recordOperation('bug', clearedBug); }
                    if (wateredCount > 0) { actions.push(`浇水${wateredCount}`); recordOperation('water', wateredCount); }
                } catch (e) {
                    // 拉取失败时按发送数量回退
                    if (status.needWeed.length > 0) { actions.push(`除草${status.needWeed.length}`); recordOperation('weed', status.needWeed.length); }
                    if (status.needBug.length > 0) { actions.push(`除虫${status.needBug.length}`); recordOperation('bug', status.needBug.length); }
                    if (status.needWater.length > 0) { actions.push(`浇水${status.needWater.length}`); recordOperation('water', status.needWater.length); }
                }
            } else {
                // all 模式自动巡田：不做额外拉取，直接按已分析的数量记录
                if (status.needWeed.length > 0) { actions.push(`除草${status.needWeed.length}`); recordOperation('weed', status.needWeed.length); }
                if (status.needBug.length > 0) { actions.push(`除虫${status.needBug.length}`); recordOperation('bug', status.needBug.length); }
                if (status.needWater.length > 0) { actions.push(`浇水${status.needWater.length}`); recordOperation('water', status.needWater.length); }
            }
        }
    }

    // 单独浇水
    if (opType === 'water') {
        if (status.needWater.length > 0) {
            try {
                await waterLand(status.needWater);
                const afterReply = await getAllLands();
                const afterStatus = analyzeLands(afterReply.lands || []);
                const afterWaterSet = new Set(afterStatus.needWater);
                const count = status.needWater.filter(id => !afterWaterSet.has(id)).length;
                if (count > 0) {
                    actions.push(`浇水${count}`);
                    recordOperation('water', count);
                    log('浇水', `浇水完成 ${count} 块`, { module: 'farm', event: 'water', count });
                } else {
                    log('浇水', '浇水请求已发送，但地块干旱状态未改变', { module: 'farm', event: 'water', count: 0 });
                }
            } catch (e) { logWarn('浇水', e.message); }
        } else {
            log('浇水', '没有需要浇水的地块', { module: 'farm', event: 'water', count: 0 });
        }
    }

    // 一键施无机肥（只对本阶段未施过无机肥的地块施，施后对比成熟期）
    if (opType === 'fert_normal') {
        const fertTargets = status.needNormalFert || [];
        if (fertTargets.length > 0) {
            try {
                const beforeSnapshot = captureMatureSnapshot(lands);
                const count = await fertilize(fertTargets, NORMAL_FERTILIZER_ID);
                if (count > 0) {
                    const afterReply = await getAllLands();
                    const afterSnapshot = captureMatureSnapshot(afterReply.lands || []);
                    const changed = fertTargets.filter(id => {
                        const before = beforeSnapshot.get(id) || 0;
                        const after = afterSnapshot.get(id) || 0;
                        return after > 0 && after !== before;
                    }).length;
                    if (changed > 0) {
                        actions.push(`无机肥${changed}`);
                        recordOperation('fertilize', changed);
                        log('施肥', `手动施无机肥完成，${changed} 块成熟期已改变`, { module: 'farm', event: 'fertilize_normal', count: changed });
                    } else {
                        log('施肥', `施无机肥已发送 ${count} 块，但成熟期无变化（可能已达上限）`, { module: 'farm', event: 'fertilize_normal', count: 0 });
                    }
                }
            } catch (e) { logWarn('施肥', e.message); }
        } else {
            log('施肥', '没有可施无机肥的地块（本阶段均已施过）', { module: 'farm', event: 'fertilize_normal', count: 0 });
        }
    }

    // 一键施有机肥（给所有可施有机肥的地块施一轮有机肥，施后对比成熟期）
    if (opType === 'fert_organic') {
        const organicTargets = getOrganicFertilizerTargetsFromLands(lands);
        if (organicTargets.length > 0) {
            try {
                const beforeSnapshot = captureMatureSnapshot(lands);
                const count = await fertilize(organicTargets, ORGANIC_FERTILIZER_ID);
                if (count > 0) {
                    const afterReply = await getAllLands();
                    const afterSnapshot = captureMatureSnapshot(afterReply.lands || []);
                    const changed = organicTargets.filter(id => {
                        const before = beforeSnapshot.get(id) || 0;
                        const after = afterSnapshot.get(id) || 0;
                        return after > 0 && after !== before;
                    }).length;
                    if (changed > 0) {
                        actions.push(`有机肥${changed}`);
                        recordOperation('fertilize', changed);
                        log('施肥', `手动施有机肥完成，${changed} 块成熟期已改变`, { module: 'farm', event: 'fertilize_organic', count: changed });
                    } else {
                        log('施肥', `施有机肥已发送 ${count} 块，但成熟期无变化（可能已耗尽）`, { module: 'farm', event: 'fertilize_organic', count: 0 });
                    }
                }
            } catch (e) { logWarn('施肥', e.message); }
        } else {
            log('施肥', '没有可施有机肥的地块（已满或无作物）', { module: 'farm', event: 'fertilize_organic', count: 0 });
        }
    }

    // 执行收获
    let harvestedLandIds = [];
    if (opType === 'all' || opType === 'auto' || opType === 'harvest') {
        if (status.harvestable.length > 0) {
            try {
                if (status.harvestable.length > 0)
                await harvest(status.harvestable);
                log('收获', `收获完成 ${status.harvestable.length} 块土地`, {
                    module: 'farm',
                    event: 'harvest_crop',
                    result: 'ok',
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                });
                actions.push(`收获${status.harvestable.length}`);
                recordOperation('harvest', status.harvestable.length);
                harvestedLandIds = [...status.harvestable];
                networkEvents.emit('farmHarvested', {
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                    opType,
                });
            } catch (e) {
                logWarn('收获', e.message, {
                    module: 'farm',
                    event: 'harvest_crop',
                    result: 'error',
                });
            }
        }
    }

    // 执行种植（'auto' 自动控制种植；'all' 一键全收不种植；单独点种植用 'plant'）
    if (opType === 'auto' || opType === 'plant') {
        const allDeadLands = [...status.dead];
        const allEmptyLands = [...status.empty];
        // 注意：如果是单纯点"一键种植"，harvestedLandIds 为空，只种当前的空地/死地
        // 兼容两季作物：收获后重新获取土地状态，避免把第二季误铲
        if (harvestedLandIds.length > 0) {
            try {
                const refreshedReply = await getAllLands();
                if (refreshedReply.lands && refreshedReply.lands.length > 0) {
                    const refreshedStatus = analyzeLands(refreshedReply.lands);
                    for (const hid of harvestedLandIds) {
                        if (refreshedStatus.empty.includes(hid)) {
                            allEmptyLands.push(hid);
                        } else if (refreshedStatus.dead.includes(hid)) {
                            allDeadLands.push(hid);
                        }
                        // 否则：仍在生长（两季作物第二季），本轮跳过
                    }
                }
            } catch (e) {
                logWarn('巡田', `收获后刷新土地状态失败: ${e.message}，跳过收获地块的后续处理`);
            }
        }
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                const plantCount = allDeadLands.length + allEmptyLands.length;
                await autoPlantEmptyLands(allDeadLands, allEmptyLands);
                actions.push(`种植${plantCount}`);
                recordOperation('plant', plantCount);
            } catch (e) { logWarn('种植', e.message); }
        }
    }

    // 指定种子种植（plant_specific:seedId）
    if (typeof opType === 'string' && opType.startsWith('plant_specific:')) {
        const seedId = Number(opType.split(':')[1]);
        if (seedId > 0) {
            const allDeadLands = [...status.dead, ...harvestedLandIds];
            const allEmptyLands = [...status.empty];
            if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
                try {
                    await autoPlantEmptyLands(allDeadLands, allEmptyLands, seedId);
                    const plantCount = allDeadLands.length + allEmptyLands.length;
                    actions.push(`种植${plantCount}`);
                    recordOperation('plant', plantCount);
                } catch (e) { logWarn('种植', e.message); }
            }
        }
    }


    // 单块施无机肥 (fert_normal_land:<landId>)
    if (typeof opType === 'string' && opType.startsWith('fert_normal_land:')) {
        const targetId = Number(opType.split(':')[1]);
        if (targetId > 0) {
            try {
                await fertilize([targetId], NORMAL_FERTILIZER_ID);
                actions.push('无机肥1');
                recordOperation('fertilize', 1);
            } catch (e) { logWarn('施肥', e.message); }
        }
    }

    // 单块施有机肥 (fert_organic_land:<landId>)
    if (typeof opType === 'string' && opType.startsWith('fert_organic_land:')) {
        const targetId = Number(opType.split(':')[1]);
        if (targetId > 0) {
            try {
                await fertilize([targetId], ORGANIC_FERTILIZER_ID);
                actions.push('有机肥1');
                recordOperation('fertilize', 1);
            } catch (e) { logWarn('施肥', e.message); }
        }
    }

    // 单块种植指定种子 (plant_specific_land:<seedId>:<landId>)
    if (typeof opType === 'string' && opType.startsWith('plant_specific_land:')) {
        const parts = opType.split(':');
        const seedId = Number(parts[1]);
        const targetId = Number(parts[2]);
        if (seedId > 0 && targetId > 0) {
            try {
                await autoPlantEmptyLands([targetId], [], seedId);
                actions.push('种植1');
                recordOperation('plant', 1);
            } catch (e) { logWarn('种植', e.message); }
        }
    }

    // 执行土地解锁/升级（手动 upgrade 总是执行；自动 all 受开关控制）
    const shouldAutoUpgrade = (opType === 'all' || opType === 'auto') && isAutomationOn('land_upgrade');
    if (shouldAutoUpgrade || opType === 'upgrade') {
        if (status.unlockable.length > 0) {
            let unlocked = 0;
            for (const landId of status.unlockable) {
                try {
                    await unlockLand(landId, false);
                    log('解锁', `土地#${landId} 解锁成功`, {
                        module: 'farm', event: 'unlock_land', result: 'ok', landId
                    });
                    unlocked++;
                } catch (e) {
                    logWarn('解锁', `土地#${landId} 解锁失败: ${e.message}`, {
                        module: 'farm', event: 'unlock_land', result: 'error', landId
                    });
                }
                await sleep(200);
            }
            if (unlocked > 0) {
                actions.push(`解锁${unlocked}`);
            }
        }

        if (status.upgradable.length > 0) {
            let upgraded = 0;
            for (const landId of status.upgradable) {
                try {
                    const reply = await upgradeLand(landId);
                    const newLevel = reply.land ? toNum(reply.land.level) : '?';
                    log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
                        module: 'farm', event: 'upgrade_land', result: 'ok', landId, level: newLevel
                    });
                    upgraded++;
                } catch (e) {
                    log('升级', `土地#${landId} 升级失败: ${e.message}`, {
                        module: 'farm', event: 'upgrade_land', result: 'error', landId
                    });
                }
                await sleep(200);
            }
            if (upgraded > 0) {
                actions.push(`升级${upgraded}`);
                recordOperation('upgrade', upgraded);
            }
        }
    }

    // 日志
    const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
    if (actions.length > 0) {
         log('农场', `[${statusParts.join(' ')}]${actionStr}`, {
             module: 'farm', event: 'farm_cycle', opType, actions
         });
    }
    return { hadWork: actions.length > 0, actions, status };
}

function calcSmartFarmDelay(status) {
    if (!isAutomationOn('smart_farm_schedule')) return CONFIG.farmCheckInterval;
    if (status && status.harvestable && status.harvestable.length > 0) return 0;
    const nowMs = Date.now();
    const times = (status && status.growingInfo || []).map(i => i.matureAt).filter(t => t > 0);
    if (times.length === 0) return CONFIG.farmCheckInterval;
    const earliest = Math.min(...times);
    const delay = earliest * 1000 - nowMs + 500;
    return Math.min(Math.max(delay, 5000), 30 * 60 * 1000);
}

function scheduleNextFarmCheck(delayMs, status) {
    if (externalSchedulerMode) return;
    if (!farmLoopRunning) return;
    const d = (delayMs !== undefined) ? delayMs : calcSmartFarmDelay(status);
    farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, d), async () => {
        if (!farmLoopRunning) return;
        const r = await checkFarmAndGetStatus();
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(undefined, r);
    });
}

function startFarmCheckLoop(options = {}) {
    if (farmLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('landsChanged', onLandsChangedPush);
    if (!externalSchedulerMode) {
        scheduleNextFarmCheck(2000);
    }
}

let lastPushTime = 0;
function onLandsChangedPush(lands) {
    // 先做被动操作 diff（无论 farm_push 开关如何，始终追踪）
    try { diffLandsAndLog(lands); } catch { /* 不影响主流程 */ }

    if (!isAutomationOn('farm_push')) {
        return;
    }
    if (isCheckingFarm) return;
    const now = Date.now();
    if (now - lastPushTime < 500) return;
    lastPushTime = now;
    log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
        module: 'farm', event: 'lands_notify', result: 'trigger_check', count: lands.length
    });
    farmScheduler.setTimeoutTask('farm_push_check', 100, async () => {
        if (!isCheckingFarm) await checkFarm();
    });
}

function stopFarmCheckLoop() {
    farmLoopRunning = false;
    externalSchedulerMode = false;
    farmScheduler.clearAll();
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
}

function refreshFarmCheckLoop(delayMs = 200) {
    if (!farmLoopRunning) return;
    scheduleNextFarmCheck(delayMs);
}

module.exports = {
    checkFarm, startFarmCheckLoop, stopFarmCheckLoop,
    refreshFarmCheckLoop,
    getCurrentPhase,
    setOperationLimitsCallback,
    setFriendLookupCallback,
    initLandsSnapshot,
    getAllLands,
    getLandsDetail,
    getAvailableSeeds,
    runFarmOperation, // 导出新函数
    runFertilizerByConfig,
    setAntiafkAccountId,
    fertilize,
    ORGANIC_FERTILIZER_ID,
};
