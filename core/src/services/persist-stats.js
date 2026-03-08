
/**
 * 统计数据持久化模块
 * 持久化路径: /app/core/data/persist-stats/<accountId>.json
 * 下线不超过 1 天则在原数据基础上继续累计
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join('/app/core/data/persist-stats');
const MAX_OFFLINE_MS = 24 * 60 * 60 * 1000; // 1天

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(accountId) {
    return path.join(DATA_DIR, `${accountId}.json`);
}

function loadSaved(accountId) {
    ensureDir();
    const fp = filePath(accountId);
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return null;
}

function saveCurrent(accountId, operations, session) {
    ensureDir();
    const d = { operations: { ...operations }, sessionGoldGained: session.goldGained || 0, sessionExpGained: session.expGained || 0, sessionCouponGained: session.couponGained || 0, savedAt: Date.now() };
    fs.writeFileSync(filePath(accountId), JSON.stringify(d), 'utf8');
}

/**
 * 登录时调用：如果上次保存时间距今不超过1天，返回要叠加的增量；否则返回 null（重新计）
 */
function tryRestore(accountId) {
    const saved = loadSaved(accountId);
    if (!saved) return null;
    const now = Date.now();
    const offlineMs = now - (saved.savedAt || 0);
    if (offlineMs > MAX_OFFLINE_MS) return null;
    return saved;
}

module.exports = { saveCurrent, tryRestore };
