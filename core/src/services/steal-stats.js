
/**
 * 好友偷菜互动统计模块
 * 持久化路径: /app/core/data/steal-stats/<accountId>.json
 * 数据结构: { gid: { name, iStole: 0, iStoleGold: 0, theyStle: 0, theyStoleGold: 0 } }
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join('/app/core/data/steal-stats');

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(accountId) {
    return path.join(DATA_DIR, `${accountId}.json`);
}

function loadData(accountId) {
    ensureDir();
    const fp = filePath(accountId);
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return {};
}

function saveData(accountId, data) {
    ensureDir();
    fs.writeFileSync(filePath(accountId), JSON.stringify(data), 'utf8');
}

// 我偷了对方
function recordIStole(accountId, gid, name, goldDelta) {
    const d = loadData(accountId);
    const k = String(gid);
    if (!d[k]) d[k] = { name: name || k, iStole: 0, iStoleGold: 0, theyStole: 0, theyStoleGold: 0 };
    d[k].iStole = (d[k].iStole || 0) + 1;
    d[k].iStoleGold = (d[k].iStoleGold || 0) + (Number(goldDelta) || 0);
    if (name) d[k].name = name;
    saveData(accountId, d);
}

// 对方偷了我
function recordTheyStole(accountId, gid, name, goldDelta) {
    const d = loadData(accountId);
    const k = String(gid);
    if (!d[k]) d[k] = { name: name || k, iStole: 0, iStoleGold: 0, theyStole: 0, theyStoleGold: 0 };
    d[k].theyStole = (d[k].theyStole || 0) + 1;
    d[k].theyStoleGold = (d[k].theyStoleGold || 0) + (Number(goldDelta) || 0);
    if (name) d[k].name = name;
    saveData(accountId, d);
}

function getStats(accountId) {
    return loadData(accountId);
}

function getSpecialCare(accountId) {
    ensureDir();
    const fp = path.join(DATA_DIR, `${accountId}_care.json`);
    try { if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
    return [];
}

function setSpecialCare(accountId, gidList) {
    ensureDir();
    const fp = path.join(DATA_DIR, `${accountId}_care.json`);
    fs.writeFileSync(fp, JSON.stringify(gidList.map(String)), 'utf8');
    return gidList.map(String);
}

module.exports = { recordIStole, recordTheyStole, getStats, getSpecialCare, setSpecialCare };
