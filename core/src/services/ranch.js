/**
 * 牧场模块 - 数据存储、金币机制、养殖逻辑
 *
 * 设计原则：
 * 1. 牧场数据独立存储于 data/ranch.json，绝不修改现有 store.json / accounts.json / users.json
 * 2. 牧场金币来源：账号出售果实时注入（由 warehouse.js 调用 addRanchGold）
 * 3. 品种静态配置来自 data/ranch-breeds.json（启动时加载，运行时只读）
 */

const fs = require('fs');
const path = require('path');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');

const RANCH_FILE = getDataFile('ranch.json');
const BREEDS_FILE = path.join(__dirname, '..', 'data', 'ranch-breeds.json');

// ============ 账号 -> 牧场 key 解析 ============
// 牧场数据以 "uin_<uin>" 为 key（如 uin_12345678）
// QQ号相同的账号共享同一份牧场数据；账号删除后牧场数据不丢失
// 旧数据（直接以 accountId 数字字符串为 key）在首次访问时自动迁移

function _resolveRanchKey(accountId) {
    const id = String(accountId || '');
    if (!id) return id;
    // 若已经是 uin_ 格式，直接返回
    if (id.startsWith('uin_')) return id;
    // 从 accounts.json 查找对应账号的 uin
    try {
        const { getAccounts } = require('../models/store');
        const data = getAccounts();
        const acc = data.accounts.find(a => String(a.id) === id);
        const uin = acc && (acc.uin || acc.qq);
        if (uin && String(uin).trim() && String(uin).trim() !== '0') {
            return `uin_${String(uin).trim()}`;
        }
    } catch (e) { /* 容错 */ }
    // 没有 uin 的账号（微信账号或旧数据），退回用 accountId 作 key
    return id;
}

// 首次访问某 key 时，检查是否有旧的 accountId key 数据需要迁移
function _migrateOldKey(data, ranchKey, accountId) {
    const oldKey = String(accountId);
    if (ranchKey === oldKey) return; // 没有 uin，不需要迁移
    if (data.accounts[ranchKey]) return; // 新 key 已有数据，跳过
    if (!data.accounts[oldKey]) return; // 旧 key 没数据，跳过
    // 把旧 key 的数据迁移到新 key，并删除旧 key
    data.accounts[ranchKey] = data.accounts[oldKey];
    delete data.accounts[oldKey];
    _saveRanchData();
}

// ============ 静态品种配置（只读，启动时加载） ============

let _breedsConfig = null;

function getBreedsConfig() {
    if (_breedsConfig) return _breedsConfig;
    try {
        const raw = fs.readFileSync(BREEDS_FILE, 'utf8');
        _breedsConfig = JSON.parse(raw);
    } catch (e) {
        _breedsConfig = { categories: [], feeds: [], medicines: [], breeds: [] };
    }
    return _breedsConfig;
}

// ============ 运行时牧场数据（每账号独立） ============

/**
 * 牧场数据结构（按 accountId 隔离）：
 * {
 *   accounts: {
 *     "<accountId>": {
 *       gold: 0,                           // 牧场金币（仅来自出售果实）
 *       inventory: {                        // 库存 { feedId: count, medicineId: count }
 *         pig_feed: 0,
 *         anti_flu: 0,
 *         ...
 *       },
 *       encyclopedia: {                     // 图鉴（按品种ID）
 *         "<breedId>": {
 *           unlocked: false,               // 是否已解锁
 *           unlockedAt: null,              // 解锁时间戳
 *           hasPair: false,                // 是否持有初始公母一对
 *           male: { count:0, health:100, fedAt:null },
 *           female: { count:0, health:100, fedAt:null },
 *           breedCount: 0,                 // 累计繁殖成功次数
 *           breedSuccess: false,           // 是否达成保种成功
 *           bookOwned: false,              // 是否持有保种经验书
 *           quizPassed: false,             // 是否通过知识测试
 *           lastQuizAt: null,              // 最近答题时间
 *           growthBonus: 0,                // 繁育速度加成（百分比）答题累计上限50%，好友笔记再+25%，可叠加
 *           quizBonus: 0,                  // 答题累计加成（上限50%）
 *           bookBonus: 0,                  // 好友经验笔记加成（每本+25%，无上限）
 *         }
 *       },
 *       warehouse: {                        // 仓库 { own: {itemId: count}, received: [{breedId, fromName, claimedAt}] }
 *         own: {},
 *         received: [],
 *       },
 *       mailbox: [],                        // 邮件列表 [{id, type, breedId, breedName, fromAccountId, fromName, sentAt, claimed}]
 *       activeBreeds: [],                  // 当前正在养殖的品种ID列表（最多5个）
 *       disease: {                          // 疾病状态 { breedId: { disease, startAt, curedAt } }
 *       },
 *       logs: [],                           // 最近50条操作日志
 *       createdAt: null,
 *       updatedAt: null,
 *     }
 *   }
 * }
 */

let _ranchData = null;

// 内存缓存版本（主进程用，worker子进程有独立内存）
function _loadRanchData() {
    if (_ranchData) return _ranchData;
    ensureDataDir();
    try {
        if (fs.existsSync(RANCH_FILE)) {
            const raw = fs.readFileSync(RANCH_FILE, 'utf8');
            _ranchData = JSON.parse(raw);
        }
    } catch (e) {
        console.warn('[Ranch] 读取 ranch.json 失败，使用空数据:', e.message);
    }
    if (!_ranchData || typeof _ranchData !== 'object') {
        _ranchData = { accounts: {} };
    }
    if (!_ranchData.accounts) _ranchData.accounts = {};
    return _ranchData;
}

// 每次强制从磁盘读取，用于跨进程场景（worker写、主进程读）
function _loadRanchDataFresh() {
    let data = null;
    ensureDataDir();
    try {
        if (fs.existsSync(RANCH_FILE)) {
            const raw = fs.readFileSync(RANCH_FILE, 'utf8');
            data = JSON.parse(raw);
        }
    } catch (e) {
        console.warn('[Ranch] 读取 ranch.json 失败:', e.message);
    }
    if (!data || typeof data !== 'object') data = { accounts: {} };
    if (!data.accounts) data.accounts = {};
    // 同步到内存缓存
    _ranchData = data;
    return _ranchData;
}

function _saveRanchData() {
    try {
        ensureDataDir();
        fs.writeFileSync(RANCH_FILE, JSON.stringify(_ranchData, null, 2), 'utf8');
    } catch (e) {
        console.error('[Ranch] 保存 ranch.json 失败:', e.message);
    }
}

function _getAccountRanch(accountId) {
    const data = _loadRanchData();
    const ranchKey = _resolveRanchKey(accountId);
    const key = ranchKey || String(accountId);
    _migrateOldKey(data, key, accountId);
    if (!data.accounts[key]) {
        data.accounts[key] = {
            gold: 0,
            inventory: {},
            warehouse: { own: {}, received: [] },
            mailbox: [],
            encyclopedia: {},
            activeBreeds: [],
            disease: {},
            logs: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        _saveRanchData();
    }
    return data.accounts[key];
}

function _addLog(accountId, msg) {
    const ranch = _getAccountRanch(accountId);
    const entry = { t: Date.now(), msg };
    ranch.logs.unshift(entry);
    if (ranch.logs.length > 50) ranch.logs.length = 50;
}

// ============ 初始化图鉴条目 ============

function _ensureBreedEntry(ranch, breedId) {
    if (!ranch.encyclopedia[breedId]) {
        ranch.encyclopedia[breedId] = {
            unlocked: false,
            unlockedAt: null,
            hasPair: false,
            male: { count: 0, health: 100, fedAt: null },
            female: { count: 0, health: 100, fedAt: null },
            breedCount: 0,
            breedSuccess: false,
            bookOwned: false,
            quizPassed: false,
            lastQuizAt: null,
            quizBonus: 0,   // 答题累计加成（最高50%）
            bookBonus: 0,   // 好友经验笔记加成（每本+25%，可叠加）
            growthBonus: 0, // 总加成 = quizBonus + bookBonus
        };
    }
    // 兼容旧数据：补充新字段
    const e = ranch.encyclopedia[breedId];
    if (e.quizBonus === undefined) e.quizBonus = Math.min(50, e.growthBonus || 0);
    if (e.bookBonus === undefined) e.bookBonus = 0;
    if (e.growthBonus === undefined) e.growthBonus = e.quizBonus + e.bookBonus;
    return ranch.encyclopedia[breedId];
}

// ============ 金币 ============

/**
 * 出售果实时增加牧场金币（由 warehouse.js 在卖出成功后调用）
 * @param {string} accountId
 * @param {number} amount 出售获得的金币数量（等额）
 */
function addRanchGold(accountId, amount) {
    if (!amount || amount <= 0) return;
    // worker 子进程写入：强制从磁盘读最新数据，避免主进程缓存覆盖
    _loadRanchDataFresh();
    const ranch = _getAccountRanch(accountId);
    ranch.gold = (ranch.gold || 0) + Math.floor(amount);
    ranch.updatedAt = Date.now();
    _addLog(accountId, `出售果实获得牧场金币 +${Math.floor(amount)}，当前共 ${ranch.gold}`);
    _saveRanchData();
}

function getRanchGold(accountId) {
    return _getAccountRanch(accountId).gold || 0;
}

// ============ 商店购买 ============

function buyItem(accountId, itemId, quantity) {
    quantity = Math.max(1, Math.floor(Number(quantity) || 1));
    const cfg = getBreedsConfig();
    const allItems = [...(cfg.feeds || []), ...(cfg.medicines || [])];
    const item = allItems.find(i => i.id === itemId);
    if (!item) return { ok: false, msg: '未知商品' };

    const ranch = _getAccountRanch(accountId);
    const totalCost = item.price * quantity;
    if ((ranch.gold || 0) < totalCost) {
        return { ok: false, msg: `牧场金币不足，需要 ${totalCost}，当前 ${ranch.gold || 0}` };
    }
    ranch.gold -= totalCost;
    ranch.inventory[itemId] = (ranch.inventory[itemId] || 0) + quantity;
    // 同步写入仓库（自购物品）
    if (!ranch.warehouse) ranch.warehouse = { own: {}, received: [] };
    if (!ranch.warehouse.own) ranch.warehouse.own = {};
    ranch.warehouse.own[itemId] = (ranch.warehouse.own[itemId] || 0) + quantity;
    ranch.updatedAt = Date.now();
    _addLog(accountId, `购买 ${item.name} x${quantity}，花费 ${totalCost} 金币，已存入仓库`);
    _saveRanchData();
    return { ok: true, msg: `成功购买 ${item.name} x${quantity}，已存入仓库` };
}

// ============ 图鉴解锁 ============

/**
 * 检查某账号是否满足解锁前置条件
 * unlockRequires 格式：
 *   null                                    → 直接解锁，无条件
 *   { type:'prevConserved', breedId }        → 指定品种保种成功
 *   { type:'anyConserved', exactDiff }       → 全局任意一个 breedDifficulty===exactDiff 的品种保种成功
 *                                              3★入口→exactDiff:2，4★入口→exactDiff:3，5★入口→exactDiff:4
 */
function _checkUnlockRequires(ranch, requires, cfg) {
    if (!requires) return { ok: true };
    if (requires.type === 'prevConserved') {
        const e = ranch.encyclopedia[requires.breedId];
        if (!e || !e.breedSuccess) {
            const prevBreed = cfg.breeds.find(b => b.id === requires.breedId);
            return { ok: false, msg: `需要先完成「${prevBreed ? prevBreed.name : requires.breedId}」的保种任务` };
        }
        return { ok: true };
    }
    if (requires.type === 'anyConserved') {
        const exactDiff = requires.exactDiff || requires.maxDiff || 2;
        const qualified = cfg.breeds.filter(b => (b.breedDifficulty || 1) === exactDiff);
        const any = qualified.some(b => {
            const e = ranch.encyclopedia[b.id];
            return e && e.breedSuccess;
        });
        if (!any) {
            return { ok: false, msg: `需要先完成任意一个${exactDiff}★繁育难度品种的保种任务` };
        }
        return { ok: true };
    }
    return { ok: true };
}

/**
 * 解锁指定品种（按 unlockRequires 条件校验）
 */
function unlockBreed(accountId, breedId) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return { ok: false, msg: '未知品种' };

    const ranch = _getAccountRanch(accountId);
    const entry = _ensureBreedEntry(ranch, breedId);

    if (entry.unlocked) return { ok: false, msg: '已经解锁' };

    // 检查解锁前置条件
    const check = _checkUnlockRequires(ranch, breed.unlockRequires || null, cfg);
    if (!check.ok) return { ok: false, msg: check.msg };

    // 解锁并赠送公母一对
    entry.unlocked = true;
    entry.unlockedAt = Date.now();
    entry.hasPair = true;
    entry.male = { count: 1, health: 100, fedAt: null };
    entry.female = { count: 1, health: 100, fedAt: null };

    ranch.updatedAt = Date.now();
    _addLog(accountId, `解锁品种「${breed.name}」，赠送公母各1只`);
    _saveRanchData();
    return { ok: true, msg: `成功解锁「${breed.name}」，已赠送公母一对`, breed };
}

// ============ 喂食 ============

function feedBreed(accountId, breedId) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return { ok: false, msg: '未知品种' };

    const ranch = _getAccountRanch(accountId);
    const entry = ranch.encyclopedia[breedId];
    if (!entry || !entry.unlocked) return { ok: false, msg: '品种未解锁' };
    if (!entry.hasPair) return { ok: false, msg: '没有可饲养的动物' };

    const category = cfg.categories.find(c => c.id === breed.categoryId);
    const feedId = category ? category.feedType : null;
    if (!feedId) return { ok: false, msg: '无对应饲料类型' };

    const feedItem = cfg.feeds.find(f => f.id === feedId);
    const needed = breed.feedPerDay || 2;
    if ((ranch.inventory[feedId] || 0) < needed) {
        return { ok: false, msg: `${feedItem ? feedItem.name : feedId} 数量不足，需要 ${needed} 份` };
    }

    ranch.inventory[feedId] -= needed;
    // 同步扣减仓库显示库存
    if (ranch.warehouse && ranch.warehouse.own && ranch.warehouse.own[feedId] !== undefined) {
        ranch.warehouse.own[feedId] = Math.max(0, (ranch.warehouse.own[feedId] || 0) - needed);
        if (ranch.warehouse.own[feedId] === 0) delete ranch.warehouse.own[feedId];
    }
    const now = Date.now();
    entry.male.fedAt = now;
    entry.female.fedAt = now;
    // 喂食后健康恢复
    entry.male.health = Math.min(100, (entry.male.health || 0) + 20);
    entry.female.health = Math.min(100, (entry.female.health || 0) + 20);
    ranch.updatedAt = now;
    _addLog(accountId, `喂食「${breed.name}」，消耗 ${feedItem ? feedItem.name : feedId} x${needed}`);
    _saveRanchData();
    return { ok: true, msg: `喂食成功` };
}

// ============ 治疗 ============

function treatBreed(accountId, breedId, medicineId) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return { ok: false, msg: '未知品种' };

    const ranch = _getAccountRanch(accountId);
    const entry = ranch.encyclopedia[breedId];
    if (!entry || !entry.unlocked) return { ok: false, msg: '品种未解锁' };

    const medicine = cfg.medicines.find(m => m.id === medicineId);
    if (!medicine) return { ok: false, msg: '未知药品' };
    if (!medicine.targetCategories.includes(breed.categoryId)) {
        return { ok: false, msg: `${medicine.name} 不适用于该品种` };
    }
    if ((ranch.inventory[medicineId] || 0) < 1) {
        return { ok: false, msg: `${medicine.name} 库存不足` };
    }

    ranch.inventory[medicineId] -= 1;
    // 同步扣减仓库显示库存
    if (ranch.warehouse && ranch.warehouse.own && ranch.warehouse.own[medicineId] !== undefined) {
        ranch.warehouse.own[medicineId] = Math.max(0, (ranch.warehouse.own[medicineId] || 0) - 1);
        if (ranch.warehouse.own[medicineId] === 0) delete ranch.warehouse.own[medicineId];
    }
    // 治疗疾病
    if (ranch.disease && ranch.disease[breedId]) {
        delete ranch.disease[breedId];
    }
    entry.male.health = Math.min(100, (entry.male.health || 0) + 30);
    entry.female.health = Math.min(100, (entry.female.health || 0) + 30);
    ranch.updatedAt = Date.now();
    _addLog(accountId, `使用「${medicine.name}」为「${breed.name}」治疗`);
    _saveRanchData();
    return { ok: true, msg: `治疗成功，${medicine.name} 已使用` };
}

// ============ 繁殖 ============

function tryBreed(accountId, breedId) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return { ok: false, msg: '未知品种' };

    const ranch = _getAccountRanch(accountId);
    const entry = ranch.encyclopedia[breedId];
    if (!entry || !entry.unlocked) return { ok: false, msg: '品种未解锁' };
    if (!entry.hasPair) return { ok: false, msg: '需要持有公母一对才能繁殖' };
    if (entry.breedSuccess) return { ok: false, msg: '已完成保种任务' };

    // 检查疾病
    if (ranch.disease && ranch.disease[breedId] && !ranch.disease[breedId].curedAt) {
        return { ok: false, msg: '动物患病中，请先治疗' };
    }
    // 检查健康度
    if ((entry.male.health || 0) < 30 || (entry.female.health || 0) < 30) {
        return { ok: false, msg: '健康度过低，请先喂食恢复健康' };
    }

    // 检查上次繁殖冷却（breedDays 天一次）
    const cdMs = (breed.breedDays || 3) * 24 * 60 * 60 * 1000;
    const lastBreed = entry._lastBreedAt || 0;
    const now = Date.now();
    if (now - lastBreed < cdMs) {
        const remainH = Math.ceil((cdMs - (now - lastBreed)) / 3600000);
        return { ok: false, msg: `繁殖冷却中，还需等待约 ${remainH} 小时` };
    }

    // 繁殖成功
    const bonus = (entry.growthBonus || 0) / 100;
    const successRate = Math.min(0.95, 0.7 + bonus);
    const success = Math.random() < successRate;
    if (!success) {
        entry._lastBreedAt = now;
        ranch.updatedAt = now;
        _addLog(accountId, `「${breed.name}」本次繁殖未成功，请继续尝试`);
        _saveRanchData();
        return { ok: true, bred: false, msg: '本次繁殖未成功，请继续尝试' };
    }

    entry.breedCount = (entry.breedCount || 0) + 1;
    entry._lastBreedAt = now;
    // 繁殖后健康轻微下降
    entry.male.health = Math.max(0, (entry.male.health || 100) - 10);
    entry.female.health = Math.max(0, (entry.female.health || 100) - 15);

    // 随机触发疾病（概率10%）
    if (Math.random() < 0.1) {
        const diseaseList = breed.diseaseRisk || [];
        if (diseaseList.length > 0) {
            const disease = diseaseList[Math.floor(Math.random() * diseaseList.length)];
            ranch.disease = ranch.disease || {};
            ranch.disease[breedId] = { disease, startAt: now, curedAt: null };
            _addLog(accountId, `「${breed.name}」感染了 ${disease}，请及时治疗`);
        }
    }

    const target = breed.breedTarget || 4;
    let msg = `「${breed.name}」繁殖成功！累计 ${entry.breedCount}/${target} 次`;

    // 检查是否达成保种成功
    if (entry.breedCount >= target && !entry.breedSuccess) {
        entry.breedSuccess = true;
        entry.bookOwned = true;
        msg += `\n🎉 保种成功！获得《${breed.name}保种经验》书籍，可赠送好友`;
        _addLog(accountId, `「${breed.name}」保种成功，获得保种经验书籍`);

        // 尝试解锁下一品种（同品类）
        const nextBreed = cfg.breeds
            .filter(b => b.categoryId === breed.categoryId && b.unlockOrder === breed.unlockOrder + 1)
            .sort((a, b) => a.unlockOrder - b.unlockOrder)[0];
        if (nextBreed) {
            const nextEntry = _ensureBreedEntry(ranch, nextBreed.id);
            if (!nextEntry.unlocked) {
                nextEntry.unlocked = true;
                nextEntry.unlockedAt = now;
                nextEntry.hasPair = true;
                nextEntry.male = { count: 1, health: 100, fedAt: null };
                nextEntry.female = { count: 1, health: 100, fedAt: null };
                msg += `\n✨ 解锁新品种「${nextBreed.name}」，已赠送公母一对！`;
                _addLog(accountId, `自动解锁下一品种「${nextBreed.name}」`);
            }
        }
    }

    ranch.updatedAt = now;
    _saveRanchData();
    return { ok: true, bred: true, msg, breedCount: entry.breedCount, breedSuccess: entry.breedSuccess };
}

// ============ 知识测验 ============

/**
 * 获取测验题目（不含答案）——必须已解锁图鉴才能答题
 */
function getQuiz(accountId, breedId) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed || !breed.quiz || breed.quiz.length === 0) {
        return { ok: false, msg: '暂无测验题目' };
    }
    // 必须已解锁图鉴
    const ranch = _getAccountRanch(accountId);
    const entry = ranch.encyclopedia[breedId];
    if (!entry || !entry.unlocked) {
        return { ok: false, msg: `请先解锁「${breed.name}」图鉴才能参与知识答题` };
    }
    const questions = breed.quiz.map((q, i) => ({
        index: i,
        q: q.q,
        options: q.options,
    }));
    return { ok: true, breedId, breedName: breed.name, questions };
}

/**
 * 提交测验答案（answers: [0,1,2,...] 按题目顺序的选项下标）——必须已解锁图鉴
 */
function submitQuiz(accountId, breedId, answers) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed || !breed.quiz || breed.quiz.length === 0) {
        return { ok: false, msg: '暂无测验题目' };
    }

    const ranch = _getAccountRanch(accountId);
    const entry = _ensureBreedEntry(ranch, breedId);
    // 必须已解锁图鉴
    if (!entry.unlocked) {
        return { ok: false, msg: `请先解锁「${breed.name}」图鉴才能参与知识答题` };
    }

    // 答题冷却：2分钟
    const now = Date.now();
    const QUIZ_CD_MS = 2 * 60 * 1000;
    if (entry.lastQuizAt && now - entry.lastQuizAt < QUIZ_CD_MS) {
        const remainS = Math.ceil((QUIZ_CD_MS - (now - entry.lastQuizAt)) / 1000);
        return { ok: false, msg: `答题冷却中，还需等待 ${remainS} 秒` };
    }

    const total = breed.quiz.length;
    let correct = 0;
    const results = breed.quiz.map((q, i) => {
        const userAns = answers[i];
        const isCorrect = userAns === q.answer;
        if (isCorrect) correct++;
        return { correct: isCorrect, correctAnswer: q.answer };
    });

    entry.lastQuizAt = now;

    if (correct === total) {
        entry.quizPassed = true;
        entry.quizBonus = Math.min(50, (entry.quizBonus || 0) + 50);
        entry.growthBonus = (entry.quizBonus || 0) + (entry.bookBonus || 0);
        ranch.updatedAt = now;
        _addLog(accountId, `「${breed.name}」知识测验全部答对，答题加成 +50%（答题上限50%，当前答题加成 ${entry.quizBonus}%，总加成 ${entry.growthBonus}%）`);
        _saveRanchData();
        return {
            ok: true,
            allCorrect: true,
            correct,
            total,
            results,
            msg: `全部答对！答题加成 +50%（当前答题 ${entry.quizBonus}% + 笔记 ${entry.bookBonus || 0}% = 总加成 ${entry.growthBonus}%）`,
        };
    } else {
        ranch.updatedAt = now;
        _saveRanchData();
        return {
            ok: true,
            allCorrect: false,
            correct,
            total,
            results,
            msg: `答对 ${correct}/${total} 题，全部答对才能获得加成`,
        };
    }
}

// ============ 赠送保种书籍（发邮件给目标账号） ============

/**
 * 赠送保种书籍：发送邮件到目标账号的 mailbox
 * toAccountId: 目标账号ID（数字或字符串）
 * fromName: 赠送人名称（用于展示）
 */
function giftBook(fromAccountId, breedId, toAccountId, fromName) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return { ok: false, msg: '未知品种' };

    const fromRanch = _getAccountRanch(fromAccountId);
    const fromEntry = fromRanch.encyclopedia[breedId];
    if (!fromEntry || !fromEntry.bookOwned) return { ok: false, msg: '未持有该品种的保种经验书' };

    const toId = String(toAccountId);
    const fromKey = _resolveRanchKey(fromAccountId);
    const toKey = _resolveRanchKey(toId);
    if (toKey === fromKey) return { ok: false, msg: '不能赠送给自己（相同QQ账号）' };

    // 写入目标账号邮件箱
    const toRanch = _getAccountRanch(toId);
    if (!toRanch.mailbox) toRanch.mailbox = [];
    const mailId = `book_${breedId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    toRanch.mailbox.push({
        id: mailId,
        type: 'book',
        breedId,
        breedName: breed.name,
        fromAccountId: String(fromAccountId),
        fromName: fromName || String(fromAccountId),
        sentAt: Date.now(),
        claimed: false,
    });
    toRanch.updatedAt = Date.now();

    // 赠送后扣除书籍（每本只能赠出一次）
    fromEntry.bookOwned = false;
    fromRanch.updatedAt = Date.now();

    _addLog(fromAccountId, `将《${breed.name}保种经验》书籍赠送给 ${fromName || toId}，书籍已转出`);
    _saveRanchData();
    return { ok: true, msg: `已将《${breed.name}保种经验》赠送，对方可在邮件箱领取` };
}

// ============ 邮件箱 ============

function getMailbox(accountId) {
    const ranch = _getAccountRanch(accountId);
    if (!ranch.mailbox) ranch.mailbox = [];
    return { ok: true, mails: ranch.mailbox };
}

/**
 * 领取邮件中的书籍
 * 领取后：存入 warehouse.received，并对该品种 bookBonus += 25%，growthBonus 同步更新
 */
function claimMail(accountId, mailId) {
    const cfg = getBreedsConfig();
    const ranch = _getAccountRanch(accountId);
    if (!ranch.mailbox) ranch.mailbox = [];
    const mail = ranch.mailbox.find(m => m.id === mailId);
    if (!mail) return { ok: false, msg: '邮件不存在' };
    if (mail.claimed) return { ok: false, msg: '已领取过此邮件' };

    mail.claimed = true;
    mail.claimedAt = Date.now();

    if (mail.type === 'book') {
        // 存入仓库（收到的区域）
        if (!ranch.warehouse) ranch.warehouse = { own: {}, received: [] };
        if (!ranch.warehouse.received) ranch.warehouse.received = [];
        ranch.warehouse.received.push({
            breedId: mail.breedId,
            breedName: mail.breedName,
            fromName: mail.fromName,
            receivedAt: Date.now(),
        });

        // 加成 +25%（无上限，可叠加）
        const entry = _ensureBreedEntry(ranch, mail.breedId);
        entry.bookBonus = (entry.bookBonus || 0) + 25;
        entry.growthBonus = (entry.quizBonus || 0) + entry.bookBonus;

        _addLog(accountId, `领取《${mail.breedName}保种经验》书籍，笔记加成 +25%（当前笔记加成 ${entry.bookBonus}%，总加成 ${entry.growthBonus}%）`);
    }

    ranch.updatedAt = Date.now();
    _saveRanchData();
    return { ok: true, msg: `领取成功！${mail.type === 'book' ? `《${mail.breedName}保种经验》已存入仓库，繁育加成 +25%` : ''}` };
}

// ============ 获取仓库信息 ============

function getWarehouse(accountId) {
    const ranch = _getAccountRanch(accountId);
    const cfg = getBreedsConfig();
    if (!ranch.warehouse) ranch.warehouse = { own: {}, received: [] };

    // 将 own 物品 ID 映射到名称/图标等
    const allItems = [...(cfg.feeds || []), ...(cfg.medicines || [])];
    const ownItems = Object.entries(ranch.warehouse.own || {}).map(([itemId, count]) => {
        const item = allItems.find(i => i.id === itemId);
        return { itemId, count, name: item ? item.name : itemId, icon: item ? item.icon : '📦', price: item ? item.price : 0 };
    }).filter(x => x.count > 0);

    return {
        ok: true,
        own: ownItems,
        received: (ranch.warehouse.received || []).slice().reverse(), // 最新的在前
    };
}

// ============ 管理员专用函数 ============

/**
 * 管理员增加/设置账号牧场金币
 * action: 'add' | 'set'
 */
function adminSetGold(accountId, amount, action) {
    const ranch = _getAccountRanch(accountId);
    const before = ranch.gold || 0;
    if (action === 'set') {
        ranch.gold = Math.max(0, Math.floor(amount));
    } else {
        ranch.gold = Math.max(0, (ranch.gold || 0) + Math.floor(amount));
    }
    ranch.updatedAt = Date.now();
    _addLog(accountId, `[管理员] ${action === 'set' ? '设置' : '增加'}金币，${before} → ${ranch.gold}`);
    _saveRanchData();
    return { ok: true, msg: `金币已${action === 'set' ? '设置' : '增加'}，当前 ${ranch.gold}`, gold: ranch.gold };
}

/**
 * 管理员强制解锁品种（忽略前置条件）
 */
function adminUnlockBreed(accountId, breedId) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return { ok: false, msg: '未知品种' };
    const ranch = _getAccountRanch(accountId);
    const entry = _ensureBreedEntry(ranch, breedId);
    if (entry.unlocked) return { ok: false, msg: '品种已解锁' };
    entry.unlocked = true;
    entry.unlockedAt = Date.now();
    entry.hasPair = true;
    entry.male = { count: 1, health: 100, fedAt: null };
    entry.female = { count: 1, health: 100, fedAt: null };
    ranch.updatedAt = Date.now();
    _addLog(accountId, `[管理员] 强制解锁品种「${breed.name}」`);
    _saveRanchData();
    return { ok: true, msg: `已强制解锁「${breed.name}」` };
}

/**
 * 管理员补充账号库存
 */
function adminAddInventory(accountId, itemId, quantity) {
    const cfg = getBreedsConfig();
    const allItems = [...(cfg.feeds || []), ...(cfg.medicines || [])];
    const item = allItems.find(i => i.id === itemId);
    if (!item) return { ok: false, msg: '未知商品 id: ' + itemId };
    const ranch = _getAccountRanch(accountId);
    ranch.inventory[itemId] = (ranch.inventory[itemId] || 0) + quantity;
    // 同步写入仓库（管理员补货视同自购）
    if (!ranch.warehouse) ranch.warehouse = { own: {}, received: [] };
    if (!ranch.warehouse.own) ranch.warehouse.own = {};
    ranch.warehouse.own[itemId] = (ranch.warehouse.own[itemId] || 0) + quantity;
    ranch.updatedAt = Date.now();
    _addLog(accountId, `[管理员] 补充库存 ${item.name} x${quantity}`);
    _saveRanchData();
    return { ok: true, msg: `已补充 ${item.name} x${quantity}，当前库存 ${ranch.inventory[itemId]}` };
}

/**
 * 管理员重置某品种答题冷却
 */
function adminResetQuizCooldown(accountId, breedId) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return { ok: false, msg: '未知品种' };
    const ranch = _getAccountRanch(accountId);
    const entry = _ensureBreedEntry(ranch, breedId);
    entry.lastQuizAt = null;
    ranch.updatedAt = Date.now();
    _addLog(accountId, `[管理员] 重置「${breed.name}」答题冷却`);
    _saveRanchData();
    return { ok: true, msg: `「${breed.name}」答题冷却已重置` };
}

// 运行时品种参数覆盖（存储在内存，重启后从 JSON 读取）
const _breedParamOverrides = {}; // breedId -> { breedDays, breedTarget, feedPerDay }
const _itemPriceOverrides = {};  // itemId -> price

/**
 * 管理员修改品种繁殖参数（运行时覆盖，重启后持久化需重新调用）
 */
function adminSetBreedParams(breedId, params) {
    const cfg = getBreedsConfig();
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return { ok: false, msg: '未知品种' };
    const override = _breedParamOverrides[breedId] || {};
    if (params.breedDays !== undefined) {
        const v = parseInt(params.breedDays);
        if (Number.isFinite(v) && v >= 1) { override.breedDays = v; breed.breedDays = v; }
    }
    if (params.breedTarget !== undefined) {
        const v = parseInt(params.breedTarget);
        if (Number.isFinite(v) && v >= 1) { override.breedTarget = v; breed.breedTarget = v; }
    }
    if (params.feedPerDay !== undefined) {
        const v = parseInt(params.feedPerDay);
        if (Number.isFinite(v) && v >= 1) { override.feedPerDay = v; breed.feedPerDay = v; }
    }
    _breedParamOverrides[breedId] = override;
    return { ok: true, msg: `「${breed.name}」参数已更新`, params: override };
}

/**
 * 管理员修改商品价格（运行时覆盖）
 */
function adminSetItemPrice(itemId, price) {
    const cfg = getBreedsConfig();
    const allItems = [...(cfg.feeds || []), ...(cfg.medicines || [])];
    const item = allItems.find(i => i.id === itemId);
    if (!item) return { ok: false, msg: '未知商品' };
    item.price = Math.floor(price);
    _itemPriceOverrides[itemId] = Math.floor(price);
    return { ok: true, msg: `「${item.name}」价格已更新为 ${item.price}` };
}

// ============ 查询接口 ============

function getRanchState(accountId) {
    // 主进程读取：强制从磁盘 fresh 读，确保拿到 worker 子进程写入的最新金币等数据
    _loadRanchDataFresh();
    const ranch = _getAccountRanch(accountId);
    const cfg = getBreedsConfig();

    // 计算喂食状态和疾病状态
    const now = Date.now();
    const encyclopediaView = {};
    for (const [breedId, entry] of Object.entries(ranch.encyclopedia || {})) {
        const breed = cfg.breeds.find(b => b.id === breedId);
        const msFedAgo = entry.male.fedAt ? now - entry.male.fedAt : Infinity;
        const needFeed = msFedAgo > 8 * 3600 * 1000; // 超过8小时未喂食
        const cdMs = ((breed && breed.breedDays) || 3) * 24 * 3600 * 1000;
        const lastBreed = entry._lastBreedAt || 0;
        const breedCdRemainSec = Math.max(0, Math.ceil((cdMs - (now - lastBreed)) / 1000));
        encyclopediaView[breedId] = {
            ...entry,
            needFeed,
            diseased: !!(ranch.disease && ranch.disease[breedId] && !ranch.disease[breedId].curedAt),
            breedCdRemainSec,
        };
    }

    return {
        gold: ranch.gold || 0,
        inventory: ranch.inventory || {},
        encyclopedia: encyclopediaView,
        disease: ranch.disease || {},
        logs: (ranch.logs || []).slice(0, 20),
        updatedAt: ranch.updatedAt,
        mailUnread: (ranch.mailbox || []).filter(m => !m.claimed).length,
    };
}

function getConfig() {
    return getBreedsConfig();
}

module.exports = {
    addRanchGold,
    getRanchGold,
    buyItem,
    unlockBreed,
    feedBreed,
    treatBreed,
    tryBreed,
    getQuiz,
    submitQuiz,
    giftBook,
    getMailbox,
    claimMail,
    getWarehouse,
    getRanchState,
    getConfig,
    // 管理员专用
    adminSetGold,
    adminUnlockBreed,
    adminAddInventory,
    adminResetQuizCooldown,
    adminSetBreedParams,
    adminSetItemPrice,
};

