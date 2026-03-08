const crypto = require('node:crypto');
/**
 * 管理面板 HTTP 服务
 * 改写为接收 DataProvider 模式，支持多用户系统
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const { version } = require('../../package.json');
const { CONFIG } = require('../config/config');
const { getLevelExpProgress } = require('../config/gameConfig');
const { getResourcePath, getDataFile } = require('../config/runtime-paths');
const store = require('../models/store');
const stealStats = require('../services/steal-stats');
const { addOrUpdateAccount, deleteAccount, forceDeleteAccount, cleanupExpiredAccounts } = store;
const ranch = require('../services/ranch');
const { findAccountByRef, normalizeAccountRef, resolveAccountId } = require('../services/account-resolver');
const { createModuleLogger } = require('../services/logger');
const { MiniProgramLoginSession, WxLoginSession } = require('../services/qrlogin');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');

const hashPassword = (pwd) => crypto.createHash('sha256').update(String(pwd || '')).digest('hex');
const adminLogger = createModuleLogger('admin');

// ============ 速率限制（防暴力登录/注册攻击）============
const rateLimitMap = new Map(); // key -> [timestamps]
function checkRateLimit(key, maxAttempts, windowMs) {
    const now = Date.now();
    const times = (rateLimitMap.get(key) || []).filter(t => now - t < windowMs);
    if (times.length >= maxAttempts) return false;
    times.push(now);
    rateLimitMap.set(key, times);
    // 自动清理 1 小时前的 key
    if (rateLimitMap.size > 5000) {
        for (const [k, v] of rateLimitMap.entries()) {
            if (v.every(t => now - t > 3600000)) rateLimitMap.delete(k);
        }
    }
    return true;
}
// 每 IP 登录：15 分钟内最多 20 次
const LOGIN_LIMIT = { max: 20, windowMs: 15 * 60 * 1000 };
// 每 IP 注册：1 小时内最多 5 次
const REGISTER_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 };

let app = null;
let server = null;
let provider = null; // DataProvider
let io = null;

// ============ 用户会话管理（持久化，重启后不踢登录用户）============
const SESSIONS_FILE = getDataFile('sessions.json');
const userSessions = new Map(); // token -> { userId, username, role }

function _loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            if (raw && typeof raw === 'object') {
                Object.entries(raw).forEach(([token, sess]) => userSessions.set(token, sess));
            }
        }
    } catch (e) { /* ignore */ }
}

function _saveSessions() {
    try {
        const obj = {};
        userSessions.forEach((sess, token) => { obj[token] = sess; });
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf8');
    } catch (e) { /* ignore */ }
}

_loadSessions();

// ============ 实时推送 ============
function emitRealtimeStatus(accountId, status) {
    if (!io) return;
    const id = String(accountId || '').trim();
    if (!id) return;
    io.to(`account:${id}`).emit('status:update', { accountId: id, status });
    io.to('account:all').emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(entry) {
    if (!io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();
    if (id) io.to(`account:${id}`).emit('log:new', payload);
    io.to('account:all').emit('log:new', payload);
}

function emitRealtimeAccountLog(entry) {
    if (!io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();
    if (id) io.to(`account:${id}`).emit('account-log:new', payload);
    io.to('account:all').emit('account-log:new', payload);
}

function startAdminServer(dataProvider) {
    if (app) return;
    provider = dataProvider;

    // 启动时清理已过期的软删除账号
    if (cleanupExpiredAccounts) cleanupExpiredAccounts();

    app = express();
    app.use(express.json());

    const issueToken = () => crypto.randomBytes(24).toString('hex');

    // 用户认证中间件
    const authRequired = (req, res, next) => {
        const token = req.headers['x-admin-token'];
        if (!token || !userSessions.has(token)) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        req.userSession = userSessions.get(token);
        req.adminToken = token;
        next();
    };

    // 管理员权限中间件
    const adminRequired = (req, res, next) => {
        if (!req.userSession || req.userSession.role !== 'admin') {
            return res.status(403).json({ ok: false, error: 'Forbidden: Admin access required' });
        }
        next();
    };

    // CORS 头（包含 PUT 方法）
    app.use((req,res,next)=>{console.log('[REQ]',req.method,req.path);next();});
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    // 静态目录：panel/（原版前端）
    // __dirname = fotest/core/src/controllers，panel 在 fotest/core/panel
    const panelDir = path.join(__dirname, '../../panel');
    if (fs.existsSync(panelDir)) {
        app.use(express.static(panelDir));
    } else {
        adminLogger.warn('panel dir not found', { panelDir });
        app.get('/', (req, res) => res.send('panel not found.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // ============ 登录（无需 auth）============
    app.post('/api/login', (req, res) => {
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        if (!checkRateLimit(`login:${clientIp}`, LOGIN_LIMIT.max, LOGIN_LIMIT.windowMs)) {
            return res.status(429).json({ ok: false, error: '登录尝试过于频繁，请15分钟后再试' });
        }
        const { username, password } = req.body || {};

        // 新版：用户名+密码登录
        if (username) {
            const user = store.getUserByUsername(username);
            if (!user) {
                return res.status(401).json({ ok: false, error: '用户名或密码错误' });
            }
            const inputHash = hashPassword(password || '');
            if (user.passwordHash !== inputHash) {
                return res.status(401).json({ ok: false, error: '用户名或密码错误' });
            }
            const token = issueToken();
            userSessions.set(token, {
                userId: user.id,
                username: user.username,
                role: user.role,
            });
            _saveSessions();
            // 记录最后登录时间，供自动清理使用
            try { store.updateUser(user.id, { lastLoginAt: Date.now() }); } catch { /* ignore */ }
            return res.json({
                ok: true,
                data: {
                    token,
                    user: { id: user.id, username: user.username, role: user.role },
                }
            });
        }

        // 兼容旧版：仅密码登录（admin 用户）
        const input = String(password || '');
        const storedHash = store.getAdminPasswordHash ? store.getAdminPasswordHash() : '';
        let ok = false;
        if (storedHash) {
            ok = hashPassword(input) === storedHash;
        } else {
            ok = input === String(CONFIG.adminPassword || '');
        }
        if (!ok) {
            return res.status(401).json({ ok: false, error: 'Invalid password' });
        }
        const adminUser = store.getUserByUsername('admin');
        const token = issueToken();
        userSessions.set(token, {
            userId: adminUser ? adminUser.id : '1',
            username: 'admin',
            role: 'admin',
        });
        _saveSessions();
        // 记录最后登录时间
        if (adminUser) { try { store.updateUser(adminUser.id, { lastLoginAt: Date.now() }); } catch { /* ignore */ } }
        res.json({ ok: true, data: { token, user: { id: adminUser ? adminUser.id : '1', username: 'admin', role: 'admin' } } });
    });

    // ============ 注册（无需 auth）============
    app.post('/api/register', (req, res) => {
        try {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            if (!checkRateLimit(`register:${clientIp}`, REGISTER_LIMIT.max, REGISTER_LIMIT.windowMs)) {
                return res.status(429).json({ ok: false, error: '注册尝试过于频繁，请1小时后再试' });
            }
            const { username, password, inviteCode } = req.body || {};
            const regConfig = store.getRegisterConfig ? store.getRegisterConfig() : { enabled: false, inviteCodes: [], maxUsers: 0 };
            if (!regConfig.enabled) {
                return res.status(403).json({ ok: false, error: '管理员未开放注册' });
            }
            // 多邀请码校验
            const inviteCodes = regConfig.inviteCodes || [];
            const hasAnyCodes = inviteCodes.length > 0 || regConfig.inviteCode;
            if (hasAnyCodes) {
                const inputCode = String(inviteCode || '').trim();
                if (!inputCode) {
                    return res.status(400).json({ ok: false, error: '请输入邀请码' });
                }
                const valid = store.validateInviteCode ? store.validateInviteCode(inputCode) : (inputCode === regConfig.inviteCode);
                if (!valid) {
                    return res.status(400).json({ ok: false, error: '邀请码错误或已达使用上限' });
                }
            }
            if (regConfig.maxUsers > 0) {
                const allUsers = store.getUsers ? store.getUsers() : { users: [] };
                const regularUserCount = (allUsers.users || []).filter(u => u.role === 'user' || u.role === 'vip').length;
                if (regularUserCount >= regConfig.maxUsers) {
                    return res.status(400).json({ ok: false, error: `注册人数已达上限（${regConfig.maxUsers}人）` });
                }
            }
            if (!username || String(username).trim().length < 2) {
                return res.status(400).json({ ok: false, error: '用户名至少2位' });
            }
            if (!password || String(password).length < 4) {
                return res.status(400).json({ ok: false, error: '密码至少4位' });
            }
            const passwordHash = hashPassword(password);
            const newUser = store.addUser({ username: String(username).trim(), passwordHash, role: 'user' });
            // 消耗邀请码使用次数
            if (hasAnyCodes && store.consumeInviteCode) {
                store.consumeInviteCode(String(inviteCode || '').trim());
            }
            res.json({ ok: true, data: { id: newUser.id, username: newUser.username, role: newUser.role } });
        } catch (e) {
            res.status(400).json({ ok: false, error: e.message });
        }
    });

    // 公开接口：注册状态（用于登录页判断是否显示注册入口）
    app.get('/api/register-status', (req, res) => {
        try {
            const cfg = store.getRegisterConfig ? store.getRegisterConfig() : { enabled: false, inviteCodes: [], maxUsers: 0 };
            const inviteCodes = cfg.inviteCodes || [];
            const requireInviteCode = inviteCodes.length > 0 || !!(cfg.inviteCode);
            res.json({ ok: true, data: { enabled: !!cfg.enabled, requireInviteCode } });
        } catch (e) {
            res.json({ ok: true, data: { enabled: false, requireInviteCode: false } });
        }
    });

    // ============ 手机抓包 code 接收接口（无需认证）============
    // 支持 GET 和 POST，实际请求为 GET + query 参数
    // 参数说明：
    //   code      - 必须，抓包获取的 auth code
    //   openID    - 可选，QQ游戏 gid（全局唯一），优先用于精确匹配账号
    //   uin       - 可选，QQ号，次优先匹配
    //   accountId - 可选，账号ID，用于精确匹配已有账号
    //   username  - 可选，系统用户名，新账号归属到该用户；同时在该用户下按 openID/uin 查找
    // 流程：
    //   1. 有 uin/accountId → 精确匹配已有账号，只更新 code，不改变归属
    //   2. 有 username      → 先用 openID(gid) 精确匹配，再用 uin 匹配；找不到则新建，并自动合并该用户下失效的旧账号
    //   3. 都没有且只有1个账号 → 直接更新那个账号
    //   4. 都没有且多个账号 → 返回错误
    const _codeCaptureHandler = (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const code = String(req.query.code || body.code || '').trim();
            if (!code) {
                adminLogger.warn('code-capture: 未收到 code', { query: req.query });
                return res.status(400).json({ ok: false, error: '缺少 code 字段' });
            }

            const rawRef    = String(body.accountId || body.id || req.query.accountId || req.query.id || '').trim();
            const uin       = String(body.uin || body.qq || req.query.uin || req.query.qq || '').trim();
            const username  = String(body.username || req.query.username || '').trim();
            const openID    = String(body.openID || body.openid || req.query.openID || req.query.openid || '').trim();

            adminLogger.info('code-capture: 收到请求', { code: code.slice(0, 16) + '...', rawRef, uin, username });

            // ---- 激活账号的公共函数 ----
            const activateAccount = (accountId) => {
                addOrUpdateAccount({ id: accountId, code, lastValidCodeAt: Date.now() });
                if (provider && provider.isAccountRunning && provider.isAccountRunning(accountId)) {
                    if (provider.sendWorkerMessage) {
                        provider.sendWorkerMessage(accountId, { type: 'update_code', code });
                    } else {
                        provider.restartAccount && provider.restartAccount(accountId);
                    }
                } else if (provider && provider.startAccount) {
                    provider.startAccount(accountId);
                }
            };

            // ---- 迁移旧账号设置到新账号，然后删除旧账号 ----
            const mergeOldAccount = (oldAccountId, newAccountId) => {
                try {
                    const oldCfg = store.getAccountConfigSnapshot
                        ? store.getAccountConfigSnapshot(oldAccountId)
                        : null;
                    if (oldCfg) {
                        store.setAccountConfigSnapshot && store.setAccountConfigSnapshot(newAccountId, oldCfg);
                    }
                    // 迁移黑名单
                    if (store.getPlantBlacklist && store.setPlantBlacklist) {
                        const bl = store.getPlantBlacklist(oldAccountId);
                        if (bl && bl.length) store.setPlantBlacklist(newAccountId, bl);
                    }
                    if (store.getFriendBlacklistMulti && store.setFriendBlacklistMulti) {
                        const fbl = store.getFriendBlacklistMulti(oldAccountId);
                        if (fbl) store.setFriendBlacklistMulti(newAccountId, fbl);
                    }
                    // 迁移白名单
                    if (store.getStealWhitelist && store.setStealWhitelist) {
                        const swl = store.getStealWhitelist(oldAccountId);
                        if (swl && swl.length) store.setStealWhitelist(newAccountId, swl);
                    }
                    if (store.getCareWhitelist && store.setCareWhitelist) {
                        const cwl = store.getCareWhitelist(oldAccountId);
                        if (cwl && cwl.length) store.setCareWhitelist(newAccountId, cwl);
                    }
                    store.forceDeleteAccount && store.forceDeleteAccount(oldAccountId);
                    adminLogger.info('code-capture: 已合并旧账号设置', { from: oldAccountId, to: newAccountId });
                } catch (mergeErr) {
                    adminLogger.warn('code-capture: 合并旧账号设置失败: ' + mergeErr.message);
                }
            };

            const accountList = getAccountList();

            // ---- 场景1：有 uin 或 accountId，精确匹配 ----
            const refKey = rawRef || uin;
            if (refKey) {
                const existing = findAccountByRef(accountList, refKey);
                if (existing) {
                    const accountId = String(existing.id);
                    activateAccount(accountId);
                    if (provider && provider.addAccountLog) {
                        provider.addAccountLog('update', `抓包更新 code: ${existing.name || accountId}`, accountId, existing.name || '');
                    }
                    adminLogger.info('code-capture: 精确匹配已更新', { accountId, name: existing.name });
                    return res.json({ ok: true, action: 'updated', accountId, name: existing.name || '' });
                }
                // 有 uin 但没找到账号 → 继续尝试 username 流程或报错
                if (!username) {
                    return res.status(404).json({ ok: false, error: `未找到 uin/accountId=${refKey} 对应的账号，可加 username=用户名 参数新建并归属到指定用户` });
                }
            }

            // ---- 场景2：有 username，在该用户下操作 ----
            if (username) {
                const targetUser = store.getUserByUsername(username);
                if (!targetUser) {
                    return res.status(404).json({ ok: false, error: `用户名 "${username}" 不存在` });
                }
                const userId = String(targetUser.id);
                const userAccounts = store.getAccountsByUserId
                    ? store.getAccountsByUserId(userId).filter(a => !a.deletedAt)
                    : accountList.filter(a => String(a.userId) === userId && !a.deletedAt);

                // 优先用 openID（gid）精确匹配该用户下的账号（gid 是全局唯一的 QQ 游戏 ID）
                if (openID) {
                    const matchedByGid = userAccounts.find(a => String(a.gid || '') === openID);
                    if (matchedByGid) {
                        const accountId = String(matchedByGid.id);
                        activateAccount(accountId);
                        if (provider && provider.addAccountLog) {
                            provider.addAccountLog('update', `抓包更新 code: ${matchedByGid.name || accountId}`, accountId, matchedByGid.name || '');
                        }
                        adminLogger.info('code-capture: username+openID(gid) 匹配已更新', { accountId, name: matchedByGid.name, username, openID });
                        return res.json({ ok: true, action: 'updated', accountId, name: matchedByGid.name || '' });
                    }
                }

                // 再用 uin 匹配
                if (uin) {
                    const matched = userAccounts.find(a => String(a.uin || a.qq || '') === uin);
                    if (matched) {
                        const accountId = String(matched.id);
                        activateAccount(accountId);
                        if (provider && provider.addAccountLog) {
                            provider.addAccountLog('update', `抓包更新 code: ${matched.name || accountId}`, accountId, matched.name || '');
                        }
                        adminLogger.info('code-capture: username+uin 匹配已更新', { accountId, name: matched.name, username });
                        return res.json({ ok: true, action: 'updated', accountId, name: matched.name || '' });
                    }
                }

                // 在该用户下找"失效账号"（code 为空或 status=offline/error 且不在运行）候选合并
                const staleAccounts = userAccounts.filter(a => {
                    if (openID && String(a.gid || '') === openID) return false; // 已处理
                    if (uin && String(a.uin || a.qq || '') === uin) return false; // 已处理
                    const isRunning = provider && provider.isAccountRunning && provider.isAccountRunning(String(a.id));
                    return !isRunning && (!a.code || a.status === 'offline' || a.status === 'error');
                });

                // 新建账号，归属到该用户
                const newName = (uin ? `QQ${uin}` : `抓包账号_${Date.now()}`);
                const payload = { code, name: newName, userId };
                if (uin) { payload.uin = uin; payload.qq = uin; }
                const newData = addOrUpdateAccount(payload);
                const newAcc = newData.accounts.find(a => String(a.userId) === userId && a.name === newName && !a.deletedAt);
                const newAccId = newAcc ? String(newAcc.id) : '';

                if (newAccId) {
                    // 如果只有一个失效账号，自动合并其设置（名称、config、黑白名单）
                    if (staleAccounts.length === 1) {
                        const stale = staleAccounts[0];
                        // 迁移昵称（若新账号名是自动生成的）
                        if (stale.name && (newName === `QQ${uin}` || newName.startsWith('抓包账号_'))) {
                            addOrUpdateAccount({ id: newAccId, name: stale.name });
                        }
                        mergeOldAccount(String(stale.id), newAccId);
                    }
                    // 启动新账号
                    if (provider && provider.startAccount) provider.startAccount(newAccId);
                    if (provider && provider.addAccountLog) {
                        provider.addAccountLog('add', `抓包新建账号: ${newAcc ? newAcc.name : newName} (归属: ${username})`, newAccId, newAcc ? newAcc.name : newName);
                    }
                }

                // 重新读取最新名称（可能被合并更新了）
                const finalAcc = getAccountList().find(a => String(a.id) === newAccId);
                adminLogger.info('code-capture: username 模式新建账号', { newAccId, username, userId, mergedFrom: staleAccounts.length === 1 ? staleAccounts[0].id : null });
                return res.json({
                    ok: true,
                    action: 'created',
                    accountId: newAccId,
                    name: finalAcc ? finalAcc.name : newName,
                    mergedFrom: staleAccounts.length === 1 ? String(staleAccounts[0].id) : null,
                });
            }

            // ---- 场景3：无任何标识，只有1个账号则直接更新 ----
            const activeAccounts = accountList.filter(a => !a.deletedAt);
            if (activeAccounts.length === 1) {
                const only = activeAccounts[0];
                const accountId = String(only.id);
                activateAccount(accountId);
                if (provider && provider.addAccountLog) {
                    provider.addAccountLog('update', `抓包更新 code: ${only.name || accountId}`, accountId, only.name || '');
                }
                adminLogger.info('code-capture: 单账号模式已更新', { accountId, name: only.name });
                return res.json({ ok: true, action: 'updated', accountId, name: only.name || '' });
            }

            // ---- 场景4：无法确定目标 ----
            const hint = activeAccounts.length > 1
                ? `系统有 ${activeAccounts.length} 个账号，请在 URL 中加 uin=QQ号 或 username=用户名 来指定目标`
                : '系统暂无账号，请加 username=用户名 参数来指定归属用户新建账号';
            adminLogger.warn('code-capture: 无法确定目标账号', { accountCount: activeAccounts.length });
            return res.status(404).json({ ok: false, error: hint });

        } catch (e) {
            adminLogger.error('code-capture 异常: ' + e.message, { stack: e.stack });
            return res.status(500).json({ ok: false, error: e.message });
        }
    };
    app.get('/api/code-capture', _codeCaptureHandler);
    app.post('/api/code-capture', _codeCaptureHandler);

    // 以下 API 需要认证（除 /login /register /qr/create /qr/check /register-status 外）
    app.use('/api', (req, res, next) => {
        if (req.path === '/login' || req.path === '/register' || req.path === '/qr/create' || req.path === '/qr/check' || req.path === '/qr/wx/create' || req.path === '/qr/wx/check' || req.path === '/register-status' || req.path === '/code-capture') return next();
        return authRequired(req, res, next);
    });

    // ============ 修改密码 ============
    app.post('/api/admin/change-password', (req, res) => {
        const body = req.body || {};
        const targetUserId = body.userId; // 管理员可指定目标用户，否则修改自己

        // 如果指定了 userId 且当前用户是管理员，直接修改目标用户密码（无需旧密码）
        if (targetUserId && req.userSession.role === 'admin') {
            const newPassword = String(body.newPassword || '');
            if (newPassword.length < 4) {
                return res.status(400).json({ ok: false, error: '新密码长度至少为 4 位' });
            }
            try {
                store.updateUser(targetUserId, { passwordHash: hashPassword(newPassword) });
                return res.json({ ok: true });
            } catch (e) {
                return res.status(400).json({ ok: false, error: e.message });
            }
        }

        // 否则需要旧密码验证（修改自己的密码）
        const oldPassword = String(body.oldPassword || '');
        const newPassword = String(body.newPassword || '');
        if (newPassword.length < 4) {
            return res.status(400).json({ ok: false, error: '新密码长度至少为 4 位' });
        }
        // 验证旧密码
        const currentUser = store.getUserById(req.userSession.userId);
        if (currentUser) {
            if (currentUser.passwordHash !== hashPassword(oldPassword)) {
                return res.status(400).json({ ok: false, error: '原密码错误' });
            }
            try {
                store.updateUser(req.userSession.userId, { passwordHash: hashPassword(newPassword) });
                return res.json({ ok: true });
            } catch (e) {
                return res.status(400).json({ ok: false, error: e.message });
            }
        }
        // 兼容旧版
        const storedHash = store.getAdminPasswordHash ? store.getAdminPasswordHash() : '';
        const ok = storedHash
            ? hashPassword(oldPassword) === storedHash
            : oldPassword === String(CONFIG.adminPassword || '');
        if (!ok) {
            return res.status(400).json({ ok: false, error: '原密码错误' });
        }
        if (store.setAdminPasswordHash) {
            store.setAdminPasswordHash(hashPassword(newPassword));
        }
        res.json({ ok: true });
    });

    // ============ Ping（返回 user 字段）============
    app.get('/api/ping', (req, res) => {
        const session = req.userSession;
        const user = session ? { id: session.userId, username: session.username, role: session.role } : null;
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version, user } });
    });

    app.get('/api/auth/validate', (req, res) => {
        res.json({ ok: true, data: { valid: true } });
    });

    // ============ 登出 ============
    app.post('/api/logout', (req, res) => {
        const token = req.adminToken;
        if (token) {
            userSessions.delete(token);
            _saveSessions();
            if (io) {
                for (const socket of io.sockets.sockets.values()) {
                    if (String(socket.data.adminToken || '') === String(token)) {
                        socket.disconnect(true);
                    }
                }
            }
        }
        res.json({ ok: true });
    });

    // ============ 注册配置（管理员）============
    app.get('/api/register-config', adminRequired, (req, res) => {
        try {
            const cfg = store.getRegisterConfig ? store.getRegisterConfig() : { enabled: false, inviteCode: '', maxUsers: 0 };
            res.json({ ok: true, data: cfg });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/register-config', adminRequired, (req, res) => {
        try {
            const { enabled, inviteCode, inviteCodes, maxUsers } = req.body || {};
            const current = store.getRegisterConfig ? store.getRegisterConfig() : {};
            const cfg = store.setRegisterConfig
                ? store.setRegisterConfig({
                    enabled: enabled !== undefined ? !!enabled : current.enabled,
                    inviteCode: inviteCode !== undefined ? String(inviteCode || '') : current.inviteCode,
                    inviteCodes: inviteCodes !== undefined ? inviteCodes : current.inviteCodes,
                    maxUsers: maxUsers !== undefined ? Math.max(0, Number.parseInt(maxUsers || 0, 10) || 0) : current.maxUsers,
                })
                : {};
            res.json({ ok: true, data: cfg });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 用户管理（管理员）============
    app.get('/api/users', adminRequired, (req, res) => {
        try {
            const data = store.getUsers();
            const users = (data.users || []).map(u => ({
                id: u.id,
                username: u.username,
                role: u.role,
                createdAt: u.createdAt,
                updatedAt: u.updatedAt,
            }));
            res.json({ ok: true, data: { users } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/users', adminRequired, (req, res) => {
        try {
            const { username, password, role } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
            }
            if (String(password).length < 4) {
                return res.status(400).json({ ok: false, error: '密码长度至少为 4 位' });
            }
            const validRole = (role === 'admin' || role === 'vip') ? role : 'user';
            const passwordHash = hashPassword(password);
            const newUser = store.addUser({ username: String(username).trim(), passwordHash, role: validRole });
            res.json({
                ok: true,
                data: { id: newUser.id, username: newUser.username, role: newUser.role, createdAt: newUser.createdAt },
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.put('/api/users/:id', adminRequired, (req, res) => {
        try {
            const { password, role } = req.body || {};
            const updates = {};
            if (password) {
                if (String(password).length < 4) {
                    return res.status(400).json({ ok: false, error: '密码长度至少为 4 位' });
                }
                updates.passwordHash = hashPassword(password);
            }
            if (role) {
                if (role !== 'admin' && role !== 'vip' && role !== 'user') {
                    return res.status(400).json({ ok: false, error: '角色只能是 admin、vip 或 user' });
                }
                updates.role = role;
            }
            const updated = store.updateUser(req.params.id, updates);
            res.json({
                ok: true,
                data: { id: updated.id, username: updated.username, role: updated.role, updatedAt: updated.updatedAt },
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.delete('/api/users/:id', adminRequired, (req, res) => {
        try {
            store.deleteUser(req.params.id);
            res.json({ ok: true, data: { message: '用户已删除' } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/users/:id/accounts', adminRequired, (req, res) => {
        try {
            const accounts = store.getAccountsByUserId(req.params.id);
            res.json({ ok: true, data: { accounts } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 管理员专用：将账号转移到指定用户（或清除归属）
    app.put('/api/accounts/:id/rebind', adminRequired, (req, res) => {
        try {
            const accountId = req.params.id;
            const { userId } = req.body || {};
            // userId 为空字符串或 null 表示清除归属
            const targetUserId = (userId !== undefined && userId !== null && String(userId).trim() !== '')
                ? String(userId).trim() : null;
            // 如果指定了目标用户，验证用户是否存在
            if (targetUserId) {
                const targetUser = store.getUserById(targetUserId);
                if (!targetUser) {
                    return res.status(400).json({ ok: false, error: '目标用户不存在' });
                }
            }
            const result = store.rebindAccount(accountId, targetUserId);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            res.json({ ok: true, data: { message: '账号归属已更新' } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 调度任务快照 ============
    app.get('/api/scheduler', async (req, res) => {
        try {
            const id = getAccId(req);
            if (provider && typeof provider.getSchedulerStatus === 'function') {
                const data = await provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({ ok: true, data: { runtime: getSchedulerRegistrySnapshot(), worker: null, workerError: 'DataProvider does not support scheduler status' } });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // ============ 账号管理（含用户隔离）============

    const getAccountList = () => {
        try {
            if (provider && typeof provider.getAccounts === 'function') {
                const data = provider.getAccounts();
                if (data && Array.isArray(data.accounts)) return data.accounts;
            }
        } catch {
            // ignore
        }
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        return Array.isArray(data.accounts) ? data.accounts : [];
    };

    const isSoftRuntimeError = (err) => {
        const msg = String((err && err.message) || '');
        return msg === '账号未运行' || msg === 'API Timeout';
    };

    function handleApiError(res, err) {
        if (isSoftRuntimeError(err)) {
            return res.json({ ok: false, error: err.message });
        }
        return res.status(500).json({ ok: false, error: err.message });
    }

    const resolveAccId = (rawRef) => {
        const input = normalizeAccountRef(rawRef);
        if (!input) return '';
        if (provider && typeof provider.resolveAccountId === 'function') {
            const resolvedByProvider = normalizeAccountRef(provider.resolveAccountId(input));
            if (resolvedByProvider) return resolvedByProvider;
        }
        const resolved = resolveAccountId(getAccountList(), input);
        return resolved || input;
    };

    function getAccId(req) {
        return resolveAccId(req.headers['x-account-id']);
    }

    app.get('/api/accounts', (req, res) => {
        try {
            const userSession = req.userSession;
            let data = provider.getAccounts();

            if (userSession.role === 'admin') {
                // 管理员可看到软删除账号，加上剩余时间字段
                data.accounts = data.accounts.map(a => {
                    if (!a.deletedAt) return a;
                    const remainMs = (a.expireAt || (a.deletedAt + 2 * 24 * 3600 * 1000)) - Date.now();
                    const remainHours = Math.max(0, Math.ceil(remainMs / 3600000));
                    return { ...a, _pendingDelete: true, _deleteRemainHours: remainHours };
                });
            } else {
                // 普通用户只看自己的、未软删除的
                data.accounts = data.accounts.filter(a => String(a.userId) === String(userSession.userId) && !a.deletedAt);
            }

            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList();
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }
            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (provider && typeof provider.setRuntimeAccountName === 'function') {
                provider.setRuntimeAccountName(accountId, remark);
            }
            if (provider && provider.addAccountLog) {
                provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/accounts', (req, res) => {
        try {
            const userSession = req.userSession;
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const isUpdate = !!body.id;
            const resolvedUpdateId = isUpdate ? (resolveAccId(body.id) || String(body.id)) : '';
            const payload = isUpdate ? { ...body, id: resolvedUpdateId } : body;
            let wasRunning = false;

            if (isUpdate) {
                const allAccounts = provider.getAccounts();
                const targetAccount = (allAccounts.accounts || []).find(a => String(a.id) === String(payload.id));
                if (targetAccount && userSession.role !== 'admin' && String(targetAccount.userId) !== String(userSession.userId)) {
                    return res.status(403).json({ ok: false, error: '无权限修改此账号' });
                }
                if (provider.isAccountRunning) {
                    wasRunning = provider.isAccountRunning(payload.id);
                }
            }

            // 新账号数量限制校验
            if (!isUpdate) {
                const ACCOUNT_LIMIT = { user: 3, vip: 5 };
                const limit = ACCOUNT_LIMIT[userSession.role];
                if (limit !== undefined) {
                    const allAccounts = provider.getAccounts();
                    const userAccountCount = (allAccounts.accounts || []).filter(
                        a => String(a.userId) === String(userSession.userId) && !a.deletedAt
                    ).length;
                    if (userAccountCount >= limit) {
                        return res.status(403).json({ ok: false, error: `账号数量已达上限（${userSession.role === 'vip' ? '超级会员' : '普通会员'}最多 ${limit} 个账号）` });
                    }
                }
            }

            // 新账号自动关联当前用户
            if (!isUpdate && !payload.userId) {
                payload.userId = userSession.userId;
            }

            const data = addOrUpdateAccount(payload);
            if (provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts[data.accounts.length - 1] || {}).id || '');
                const accountName = payload.name || '';
                provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }

            if (!isUpdate) {
                const newAcc = data.accounts[data.accounts.length - 1];
                if (newAcc) provider.startAccount(newAcc.id);
            } else if (wasRunning) {
                const newCode = payload.code ? String(payload.code).trim() : null;
                if (newCode && provider.sendWorkerMessage) {
                    provider.sendWorkerMessage(payload.id, { type: 'update_code', code: newCode });
                } else {
                    provider.restartAccount(payload.id);
                }
            }

            // 过滤返回数据
            if (userSession.role !== 'admin') {
                data.accounts = data.accounts.filter(a => String(a.userId) === String(userSession.userId));
            }

            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.delete('/api/accounts/:id', (req, res) => {
        try {
            const userSession = req.userSession;
            const before = provider.getAccounts();
            const target = (before.accounts || []).find(a => String(a.id) === String(req.params.id));

            if (target && userSession.role !== 'admin' && String(target.userId) !== String(userSession.userId)) {
                return res.status(403).json({ ok: false, error: '无权限删除此账号' });
            }

            provider.stopAccount(req.params.id);
            const data = deleteAccount(req.params.id);

            const after = (data.accounts || []).find(a => String(a.id) === String(req.params.id));
            const isSoftDeleted = !!after;

            if (provider.addAccountLog) {
                provider.addAccountLog(
                    'delete',
                    isSoftDeleted
                        ? `停用账号（2天后删除）: ${(target && target.name) || req.params.id}`
                        : `删除账号: ${(target && target.name) || req.params.id}`,
                    req.params.id,
                    target ? target.name : ''
                );
            }

            let returnAccounts = (data.accounts || []).filter(a => !a.deletedAt);
            if (userSession.role !== 'admin') {
                returnAccounts = returnAccounts.filter(a => String(a.userId) === String(userSession.userId));
            }

            res.json({ ok: true, softDeleted: isSoftDeleted, data: { ...data, accounts: returnAccounts } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 管理员强制立即删除账号（不等2天）
    app.delete('/api/accounts/:id/force', adminRequired, (req, res) => {
        try {
            const before = provider.getAccounts();
            const target = (before.accounts || []).find(a => String(a.id) === String(req.params.id));
            provider.stopAccount(req.params.id);
            const data = forceDeleteAccount(req.params.id);
            if (provider.addAccountLog) {
                provider.addAccountLog('delete', `强制删除账号: ${(target && target.name) || req.params.id}`, req.params.id, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 管理员一键清除所有待删除账号
    app.delete('/api/accounts/pending/all', adminRequired, (req, res) => {
        try {
            const allAccounts = provider.getAccounts().accounts || [];
            const pendingList = allAccounts.filter(a => !!a.deletedAt);
            for (const a of pendingList) {
                provider.stopAccount(a.id);
                forceDeleteAccount(a.id);
                if (provider.addAccountLog) {
                    provider.addAccountLog('delete', `批量清除待删除账号: ${a.name || a.id}`, a.id, a.name || '');
                }
            }
            res.json({ ok: true, cleared: pendingList.length });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 账号日志（返回 { ok: true, data: list }）
    app.get('/api/account-logs', (req, res) => {
        try {
            const limit = Number.parseInt(req.query.limit) || 100;
            let list = provider.getAccountLogs ? provider.getAccountLogs(limit) : [];
            if (req.userSession.role !== 'admin') {
                const userAccounts = store.getAccountsByUserId(req.userSession.userId);
                const myAccountIds = new Set(userAccounts.map(a => String(a.id)));
                list = (list || []).filter(l => l.accountId && myAccountIds.has(String(l.accountId)));
            }
            res.json({ ok: true, data: Array.isArray(list) ? list : [] });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 启动/停止账号 ============
    app.post('/api/accounts/:id/start', (req, res) => {
        try {
            const ok = provider.startAccount(resolveAccId(req.params.id));
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/accounts/:id/stop', (req, res) => {
        try {
            const ok = provider.stopAccount(resolveAccId(req.params.id));
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 状态 & 自动化 ============
    app.get('/api/status', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = provider.getStatus(id);
            if (data && data.status) {
                const { level, exp } = data.status;
                const progress = getLevelExpProgress(level, exp);
                data.levelProgress = progress;
            }
            // 被偷次数用 stealStats 的真实历史数据覆盖（比实时推送检测更准确）
            if (data && data.operations) {
                try {
                    const ss = stealStats.getStats(id);
                    const statsMap = (ss && ss.stats) ? ss.stats : {};
                    let totalBeStolen = 0;
                    for (const s of Object.values(statsMap)) totalBeStolen += (s.theyStole || 0);
                    data.operations.beStolen = totalBeStolen;
                } catch {}
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.post('/api/automation', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        try {
            let lastData = null;
            for (const [k, v] of Object.entries(req.body)) {
                lastData = await provider.setAutomation(id, k, v);
            }
            res.json({ ok: true, data: lastData || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 农田 & 好友 ============
    app.get('/api/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getLands(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.get('/api/friends', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getFriends(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // 好友偷菜互动统计
    app.get('/api/steal-stats', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false });
            const data = stealStats.getStats(id);
            const care = stealStats.getSpecialCare(id);
            res.json({ ok: true, stats: data, specialCare: care });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    app.post('/api/special-care', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false });
            const gids = Array.isArray((req.body || {}).gids) ? (req.body || {}).gids : [];
            const result = stealStats.setSpecialCare(id, gids);
            res.json({ ok: true, data: result });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    app.get('/api/friend/:gid/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.post('/api/friend/:gid/op', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const opType = String((req.body || {}).opType || '');
            const data = await provider.doFriendOp(id, req.params.gid, opType);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // ============ 好友黑名单（noSteal/noHelp 结构，完整替换）============
    app.get('/api/friend-blacklist', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            const list = store.getFriendBlacklistMulti ? store.getFriendBlacklistMulti(id) : { noSteal: [], noHelp: [] };
            res.json({ ok: true, data: list });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/friend-blacklist', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            const { noSteal, noHelp } = req.body || {};
            const result = store.setFriendBlacklistMulti
                ? store.setFriendBlacklistMulti(id, { noSteal: noSteal || [], noHelp: noHelp || [] })
                : {};
            // 同步配置到 worker 进程
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            res.json({ ok: true, data: result });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 兼容旧版好友黑名单 toggle 接口
    app.post('/api/friend-blacklist/toggle', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const gid = String((req.body || {}).gid || '');
        if (!gid) return res.status(400).json({ ok: false, error: 'Missing gid' });
        const current = store.getFriendBlacklistMulti ? store.getFriendBlacklistMulti(id) : { noSteal: [], noHelp: [] };
        const noStealSet = new Set(current.noSteal.map(String));
        const noHelpSet = new Set(current.noHelp.map(String));
        // 默认 toggle noSteal
        if (noStealSet.has(gid)) {
            noStealSet.delete(gid);
        } else {
            noStealSet.add(gid);
        }
        const saved = store.setFriendBlacklistMulti
            ? store.setFriendBlacklistMulti(id, { noSteal: [...noStealSet], noHelp: [...noHelpSet] })
            : current;
        if (provider && typeof provider.broadcastConfig === 'function') {
            provider.broadcastConfig(id);
        }
        res.json({ ok: true, data: saved });
    });


    // ============ 好友捣乱/照顾白名单 ============
    app.get('/api/friend-whitelist', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            const stealWhitelist = store.getStealWhitelist ? store.getStealWhitelist(id) : [];
            const careWhitelist = store.getCareWhitelist ? store.getCareWhitelist(id) : [];
            res.json({ ok: true, data: { stealWhitelist, careWhitelist } });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });
    app.post('/api/friend-whitelist', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            const { stealWhitelist, careWhitelist } = req.body || {};
            const savedSteal = store.setStealWhitelist ? store.setStealWhitelist(id, stealWhitelist || []) : [];
            const savedCare = store.setCareWhitelist ? store.setCareWhitelist(id, careWhitelist || []) : [];
            if (provider && typeof provider.broadcastConfig === 'function') provider.broadcastConfig(id);
            res.json({ ok: true, data: { stealWhitelist: savedSteal, careWhitelist: savedCare } });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });
    // ============ 植物黑名单 ============
    app.get('/api/plant-blacklist', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            const list = store.getPlantBlacklist ? store.getPlantBlacklist(id) : [];
            res.json({ ok: true, data: list });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/plant-blacklist', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            const { plantIds } = req.body || {};
            const list = store.setPlantBlacklist ? store.setPlantBlacklist(id, plantIds || []) : [];
            res.json({ ok: true, data: list });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 果实出售黑名单（按账号独立配置，兼容无 x-account-id 时使用全局）
    app.get('/api/fruit-sell-blacklist', (req, res) => {
        try {
            const id = getAccId(req);
            const list = store.getFruitSellBlacklist ? store.getFruitSellBlacklist(id || '') : [];
            res.json({ ok: true, data: list });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/fruit-sell-blacklist', (req, res) => {
        try {
            const id = getAccId(req);
            const { fruitNames } = req.body || {};
            const list = store.setFruitSellBlacklist ? store.setFruitSellBlacklist(fruitNames || [], id || '') : [];
            res.json({ ok: true, data: list });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 种子 & 背包 & 礼包 ============
    app.get('/api/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.get('/api/bag', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getBag(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // 出售背包物品 POST /api/bag/sell { items: [{id, count}] }
    app.post('/api/bag/sell', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        const { items } = req.body || {};
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ ok: false, error: '请传入 items 数组' });
        }
        try {
            const validItems=(items||[]).map(it=>({id:Number(it.id)||0,count:Math.max(1,Number(it.count)||1),uid:Number(it.uid)||0})).filter(it=>it.id>0);
            if(!validItems.length)return res.status(400).json({ok:false,error:"no valid items"});
            const result=await provider.sellBagItems(id,validItems);
            res.json({ ok: true, result });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // 使用背包道具 POST /api/bag/use { itemId, count }
    app.post('/api/bag/use', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        const { itemId, count } = req.body || {};
        if (!itemId) return res.status(400).json({ ok: false, error: '请传入 itemId' });
        try {
            const result = await provider.useBagItem(id, Number(itemId), Number(count) || 1);
            res.json({ ok: true, result });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.get('/api/daily-gifts', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getDailyGifts(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // ============ 农场一键操作 ============
    app.post('/api/farm/operate', async (req, res) => {
                const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const { opType } = req.body;
            const farmResult = await provider.doFarmOp(id, opType);
            // 只向前端返回轻量字段，避免 status 大对象传输超时
            const { hadWork = false, actions = [] } = farmResult || {};
            res.json({ ok: true, result: { hadWork, actions } });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // ============ 数据分析 ============
    app.get('/api/analytics', async (req, res) => {
        try {
            const sortBy = req.query.sort || 'exp';
            const { getPlantRankings } = require('../services/analytics');
            const data = getPlantRankings(sortBy);
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 天王模式 ============
    app.get('/api/theft-king', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        // vip 或 admin 才可使用天王模式
        const sess = req.userSession;
        const canUseTheftKing = sess && (sess.role === 'admin' || sess.role === 'vip');
        try {
            const cfg = store.getTheftKingConfig(id);
            res.json({ ok: true, data: { ...cfg, canUse: canUseTheftKing } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/theft-king', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const sess = req.userSession;
        if (!sess || (sess.role !== 'admin' && sess.role !== 'vip')) {
            return res.status(403).json({ ok: false, error: '天王模式仅限超级用户(VIP)或管理员使用' });
        }
        try {
            const cfg = store.setTheftKingConfig(id, req.body || {});
            // 推送配置到 worker
            if (provider && typeof provider.setTheftKingConfig === 'function') {
                await provider.setTheftKingConfig(id, cfg);
            }
            res.json({ ok: true, data: cfg });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/theft-king/status', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = provider && typeof provider.getTheftKingStatus === 'function'
                ? await provider.getTheftKingStatus(id)
                : { running: false, focusCount: 0, campCount: 0, focusList: [], campList: [] };
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ VIP SMTP 配置（超级用户邮件提醒）============
    app.get('/api/vip-smtp', (req, res) => {
        const sess = req.userSession;
        if (!sess) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        try {
            const cfg = store.getVipSmtpConfig ? store.getVipSmtpConfig(sess.userId) : null;
            if (!cfg) return res.json({ ok: true, data: { qq: '', notifyOffline: true, notifyMature: false } });
            res.json({ ok: true, data: {
                qq: cfg.qq || '',
                notifyOffline: !!cfg.notifyOffline,
                notifyMature: !!cfg.notifyMature,
            }});
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/vip-smtp', (req, res) => {
        const sess = req.userSession;
        if (!sess) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        // 只有 vip 和 admin 才能配置
        if (sess.role !== 'admin' && sess.role !== 'vip') {
            return res.status(403).json({ ok: false, error: '仅超级用户(VIP)或管理员可配置邮件提醒' });
        }
        try {
            const { qq, notifyOffline, notifyMature } = req.body || {};
            const cfg = store.setVipSmtpConfig ? store.setVipSmtpConfig(sess.userId, {
                qq: qq !== undefined ? qq : undefined,
                notifyOffline: notifyOffline !== undefined ? notifyOffline : undefined,
                notifyMature: notifyMature !== undefined ? notifyMature : undefined,
            }) : {};
            res.json({ ok: true, data: { qq: cfg.qq, notifyOffline: cfg.notifyOffline, notifyMature: cfg.notifyMature } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 管理员 SMTP 发件配置 ============
    app.get('/api/admin-smtp', adminRequired, (req, res) => {
        try {
            const cfg = store.getAdminSmtpConfig ? store.getAdminSmtpConfig() : { fromEmail: '', smtpPass: '' };
            res.json({ ok: true, data: { fromEmail: cfg.fromEmail || '', smtpPassSet: !!(cfg.smtpPass) } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin-smtp', adminRequired, (req, res) => {
        try {
            const { fromEmail, smtpPass } = req.body || {};
            const current = store.getAdminSmtpConfig ? store.getAdminSmtpConfig() : {};
            const cfg = store.setAdminSmtpConfig ? store.setAdminSmtpConfig({
                fromEmail: fromEmail !== undefined ? fromEmail : current.fromEmail,
                smtpPass: smtpPass !== undefined ? smtpPass : current.smtpPass,
            }) : {};
            res.json({ ok: true, data: { fromEmail: cfg.fromEmail, smtpPassSet: !!(cfg.smtpPass) } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 设置 ============
    app.post('/api/settings/save', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        try {
            const data = await provider.saveSettings(id, req.body || {});
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/settings/theme', async (req, res) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/settings/offline-reminder', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const data = store.setOfflineReminder ? store.setOfflineReminder(body) : {};
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/settings', async (req, res) => {
        try {
            const id = getAccId(req);
            const intervals = store.getIntervals(id);
            const strategy = store.getPlantingStrategy(id);
            const preferredSeed = store.getPreferredSeed(id);
            const friendQuietHours = store.getFriendQuietHours(id);
            const automation = store.getAutomation(id);
            const ui = store.getUI();
            const offlineReminder = store.getOfflineReminder
                ? store.getOfflineReminder()
                : { channel: 'webhook', reloginUrlMode: 'none', endpoint: '', token: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 120 };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, ui, offlineReminder } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 日志 ============
    app.get('/api/logs', (req, res) => {
        const session = req.userSession;
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();

        if (session && session.role !== 'admin') {
            const userAccounts = store.getAccountsByUserId(session.userId);
            const userAccountIds = new Set(userAccounts.map(a => String(a.id)));
            if (queryAccountIdRaw && queryAccountIdRaw !== 'all') {
                if (!userAccountIds.has(queryAccountIdRaw)) {
                    return res.status(403).json({ ok: false, error: '无权访问此账号日志' });
                }
            }
        }

        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(queryAccountIdRaw)) : getAccId(req);
        const options = {
            limit: Number.parseInt(req.query.limit) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        let list = provider.getLogs(id, options);
        if (session && session.role !== 'admin') {
            const userAccounts = store.getAccountsByUserId(session.userId);
            const userAccountIds = new Set(userAccounts.map(a => String(a.id)));
            list = list.filter(log => {
                const aid = String(log.accountId || '');
                return aid && userAccountIds.has(aid);
            });
        }
        res.json({ ok: true, data: list });
    });

    // 清空指定账号的运行日志
    app.delete('/api/logs', (req, res) => {
        try {
            const accountIdRaw = (req.headers['x-account-id'] || '').toString().trim();
            if (!accountIdRaw) {
                return res.status(400).json({ ok: false, error: '缺少 x-account-id' });
            }
            const session = req.userSession;
            if (session && session.role !== 'admin') {
                const userAccounts = store.getAccountsByUserId(session.userId);
                const userAccountIds = new Set(userAccounts.map(a => String(a.id)));
                if (!userAccountIds.has(accountIdRaw)) {
                    return res.status(403).json({ ok: false, error: '无权操作此账号日志' });
                }
            }
            const result = provider.clearLogs(accountIdRaw);
            // 通知前端日志已清空（发一个空日志快照）
            if (io) {
                io.to(accountIdRaw).to('all').emit('logs', []);
            }
            return res.json({ ok: true, data: result });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ QR Code Login APIs ============
    // 微信扫码登录接口
    app.post('/api/qr/wx/create', async (req, res) => {
        try {
            const result = await WxLoginSession.requestQR();
            res.json({ ok: true, data: { uuid: result.uuid, qrcode: result.image } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/qr/wx/check', async (req, res) => {
        const { uuid } = req.body || {};
        if (!uuid) return res.status(400).json({ ok: false, error: 'Missing uuid' });
        try {
            const result = await WxLoginSession.queryStatus(uuid);
            if (result.status === 'OK') {
                const authCode = await WxLoginSession.getAuthCode(result.wxid);
                res.json({ ok: true, data: { status: 'OK', code: authCode, wxid: result.wxid, nickname: result.nickname } });
            } else {
                res.json({ ok: true, data: { status: 'Wait' } });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/qr/create', async (req, res) => {
        try {
            const result = await MiniProgramLoginSession.requestLoginCode();
            // 前端使用 result.data.qrcode 显示图片，而 requestLoginCode 返回的是 image 字段
            res.json({ ok: true, data: { ...result, qrcode: result.image || result.qrcode || '' } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/qr/check', async (req, res) => {
        const { code } = req.body || {};
        if (!code) {
            return res.status(400).json({ ok: false, error: 'Missing code' });
        }
        try {
            const result = await MiniProgramLoginSession.queryStatus(code);
            if (result.status === 'OK') {
                const ticket = result.ticket;
                const uin = result.uin || '';
                const nickname = result.nickname || '';
                const appid = '1112386029';
                const authCode = await MiniProgramLoginSession.getAuthCode(ticket, appid);
                let avatar = '';
                if (uin) {
                    avatar = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;
                }
                res.json({ ok: true, data: { status: 'OK', code: authCode, uin, avatar, nickname } });
            } else if (result.status === 'Used') {
                res.json({ ok: true, data: { status: 'Used' } });
            } else if (result.status === 'Wait') {
                res.json({ ok: true, data: { status: 'Wait' } });
            } else {
                res.json({ ok: true, data: { status: 'Error', error: result.msg } });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ Ranch（牧场）APIs ============
    app.get('/api/ranch/config', (req, res) => {
        try {
            const data = ranch.getConfig();
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/ranch/state', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = ranch.getRanchState(id);
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/ranch/unlock', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const { breedId } = req.body || {};
        if (!breedId) return res.status(400).json({ ok: false, error: 'Missing breedId' });
        try {
            const result = ranch.unlockBreed(id, breedId);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/ranch/breed', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const { breedId } = req.body || {};
        if (!breedId) return res.status(400).json({ ok: false, error: 'Missing breedId' });
        try {
            const result = ranch.tryBreed(id, breedId);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/ranch/feed', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const { breedId } = req.body || {};
        if (!breedId) return res.status(400).json({ ok: false, error: 'Missing breedId' });
        try {
            const result = ranch.feedBreed(id, breedId);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/ranch/treat', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const { breedId, medicineId } = req.body || {};
        if (!breedId || !medicineId) return res.status(400).json({ ok: false, error: 'Missing breedId or medicineId' });
        try {
            const result = ranch.treatBreed(id, breedId, medicineId);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/ranch/buy', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const { itemId, quantity } = req.body || {};
        if (!itemId) return res.status(400).json({ ok: false, error: 'Missing itemId' });
        try {
            const result = ranch.buyItem(id, itemId, quantity || 1);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/ranch/quiz/:breedId', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const result = ranch.getQuiz(id, req.params.breedId);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/ranch/quiz/:breedId', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const { answers } = req.body || {};
        if (!Array.isArray(answers)) return res.status(400).json({ ok: false, error: 'Missing answers array' });
        try {
            const result = ranch.submitQuiz(id, req.params.breedId, answers);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/ranch/warehouse', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const result = ranch.getWarehouse(id);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/ranch/mailbox', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const result = ranch.getMailbox(id);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/ranch/mail/claim', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const { mailId } = req.body || {};
        if (!mailId) return res.status(400).json({ ok: false, error: 'Missing mailId' });
        try {
            const result = ranch.claimMail(id, mailId);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/ranch/all-accounts', (req, res) => {
        try {
            const data = provider.getAccounts();
            const accounts = (data.accounts || [])
                .filter(a => !a.deletedAt)
                .map(a => ({
                    id: a.id,
                    name: a.name || a.nick || `账号${a.id}`,
                    uin: a.uin || a.qq || '',
                }));
            res.json({ ok: true, accounts });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/ranch/gift-book', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const { breedId, toAccountId, fromName } = req.body || {};
        if (!breedId || !toAccountId) return res.status(400).json({ ok: false, error: 'Missing breedId or toAccountId' });
        try {
            const result = ranch.giftBook(id, breedId, toAccountId, fromName || '');
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 管理员牧场调整 ============
    app.get('/api/admin/ranch/config', adminRequired, (req, res) => {
        res.json({ ok: true, data: ranch.getConfig() });
    });

    app.post('/api/admin/ranch/gold', adminRequired, (req, res) => {
        const { accountId, amount, action } = req.body || {};
        if (!accountId || amount === undefined) {
            return res.status(400).json({ ok: false, error: '缺少 accountId 或 amount' });
        }
        const n = Number(amount);
        if (!Number.isFinite(n)) return res.status(400).json({ ok: false, error: 'amount 必须为数字' });
        try {
            const result = ranch.adminSetGold(String(accountId), n, action || 'add');
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/ranch/unlock', adminRequired, (req, res) => {
        const { accountId, breedId } = req.body || {};
        if (!accountId || !breedId) return res.status(400).json({ ok: false, error: '缺少参数' });
        try {
            const result = ranch.adminUnlockBreed(String(accountId), breedId);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/ranch/inventory', adminRequired, (req, res) => {
        const { accountId, itemId, quantity } = req.body || {};
        if (!accountId || !itemId) return res.status(400).json({ ok: false, error: '缺少参数' });
        const qty = Math.max(1, Number.parseInt(quantity) || 1);
        try {
            const result = ranch.adminAddInventory(String(accountId), itemId, qty);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/admin/ranch/state/:accountId', adminRequired, (req, res) => {
        try {
            res.json({ ok: true, data: ranch.getRanchState(req.params.accountId) });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/ranch/reset-quiz', adminRequired, (req, res) => {
        const { accountId, breedId } = req.body || {};
        if (!accountId || !breedId) return res.status(400).json({ ok: false, error: '缺少参数' });
        try {
            const result = ranch.adminResetQuizCooldown(String(accountId), breedId);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/ranch/breed-params', adminRequired, (req, res) => {
        const { breedId, breedDays, breedTarget, feedPerDay } = req.body || {};
        if (!breedId) return res.status(400).json({ ok: false, error: '缺少 breedId' });
        try {
            const result = ranch.adminSetBreedParams(breedId, { breedDays, breedTarget, feedPerDay });
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/admin/ranch/item-price', adminRequired, (req, res) => {
        const { itemId, price } = req.body || {};
        if (!itemId || price === undefined) return res.status(400).json({ ok: false, error: '缺少参数' });
        const p = Number(price);
        if (!Number.isFinite(p) || p < 0) return res.status(400).json({ ok: false, error: 'price 必须为非负数字' });
        try {
            const result = ranch.adminSetItemPrice(itemId, p);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 防挂（antiafk）============
    const antiafk = (() => { try { return require('../services/antiafk'); } catch { return null; } })();
    const { startStealDogsMode, stopStealDogsMode } = require('../services/friend');

    // 获取防挂状态 + 挂狗名单（admin/vip 可用）
    app.get('/api/antiafk/status', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            if (!antiafk) return res.status(500).json({ ok: false, error: '防挂模块未加载' });
            const data = antiafk.getStatus(id);
            res.json({ ok: true, data });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // 设置防挂配置（主动测挂开关 / 偷挂狗开关）
    app.post('/api/antiafk/config', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            if (!antiafk) return res.status(500).json({ ok: false, error: '防挂模块未加载' });
            const { activeTestEnabled, stealDogsEnabled } = req.body || {};

            if (activeTestEnabled !== undefined) {
                antiafk.setActiveTestEnabled(id, !!activeTestEnabled);
            }
            if (stealDogsEnabled !== undefined) {
                antiafk.setStealDogsEnabled(id, !!stealDogsEnabled);
                if (stealDogsEnabled) {
                    startStealDogsMode(id);
                } else {
                    stopStealDogsMode();
                }
            }
            res.json({ ok: true, data: antiafk.getStatus(id) });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // 移除挂狗（软删除）
    app.post('/api/antiafk/remove-dog', (req, res) => {
        try {
            const id = getAccId(req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            if (!antiafk) return res.status(500).json({ ok: false, error: '防挂模块未加载' });
            const { gid } = req.body || {};
            if (!gid) return res.status(400).json({ ok: false, error: '缺少 gid' });
            const result = antiafk.removeDog(id, String(gid));
            res.json(result);
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // ============ SPA fallback ============
    app.get('*', (req, res) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
            return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        const indexHtml = path.join(panelDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
            res.sendFile(indexHtml);
        } else {
            res.status(404).send('panel not found.');
        }
    });

    // ============ Socket.IO ============
    const applySocketSubscription = (socket, accountRef = '') => {
        const incoming = String(accountRef || '').trim();
        const resolved = incoming && incoming !== 'all' ? resolveAccId(incoming) : '';
        for (const room of socket.rooms) {
            if (room.startsWith('account:')) socket.leave(room);
        }
        if (resolved) {
            socket.join(`account:${resolved}`);
            socket.data.accountId = resolved;
        } else {
            socket.join('account:all');
            socket.data.accountId = '';
        }
        socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

        try {
            const targetId = socket.data.accountId || '';
            if (targetId && provider && typeof provider.getStatus === 'function') {
                const currentStatus = provider.getStatus(targetId);
                socket.emit('status:update', { accountId: targetId, status: currentStatus });
            }
            if (provider && typeof provider.getLogs === 'function') {
                const currentLogs = provider.getLogs(targetId, { limit: 100 });
                socket.emit('logs:snapshot', {
                    accountId: targetId || 'all',
                    logs: Array.isArray(currentLogs) ? currentLogs : [],
                });
            }
            if (provider && typeof provider.getAccountLogs === 'function') {
                let currentAccountLogs = provider.getAccountLogs(100);
                // 非管理员只推送自己账号的日志
                const sockSess = socket.data.adminToken ? userSessions.get(socket.data.adminToken) : null;
                if (sockSess && sockSess.role !== 'admin') {
                    const userAccIds = new Set(store.getAccountsByUserId(sockSess.userId).map(a => String(a.id)));
                    currentAccountLogs = (currentAccountLogs || []).filter(l => l.accountId && userAccIds.has(String(l.accountId)));
                }
                socket.emit('account-logs:snapshot', {
                    logs: Array.isArray(currentAccountLogs) ? currentAccountLogs : [],
                });
            }
        } catch {
            // ignore snapshot push errors
        }
    };

    const port = CONFIG.adminPort || 3000;
    server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    io = new SocketIOServer(server, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    io.use((socket, next) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        if (!token || !userSessions.has(token)) {
            return next(new Error('Unauthorized'));
        }
        socket.data.adminToken = token;
        return next();
    });

    io.on('connection', (socket) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now() });

        socket.on('subscribe', (payload) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(socket, body.accountId || '');
        });
    });

    // ============ 定时自动清理（每小时）============
    // 规则1：role=user（非 vip/admin）且 3 天未登录，且名下无运行中 worker → 删除用户及其账号
    // 规则2：账号 1 天内从未 connected=true（lastValidCodeAt 或 createdAt 超 1 天）→ 删除账号
    const AUTO_CLEAN_INTERVAL = 60 * 60 * 1000; // 1 小时
    const USER_INACTIVE_MS    = 3 * 24 * 3600 * 1000; // 3 天
    const ACCOUNT_INVALID_MS  = 1 * 24 * 3600 * 1000; // 1 天

    function runAutoClean() {
        try {
            const now = Date.now();
            const allAccData = store.getAccounts ? store.getAccounts() : { accounts: [] };
            const allAccounts = (allAccData.accounts || []).filter(a => !a.deletedAt);

            // --- 规则2：1天内无有效 code 的账号 ---
            for (const acc of allAccounts) {
                // 若账号 worker 正在运行且 connected，跳过（以实时状态为准）
                if (provider && typeof provider.isAccountRunning === 'function' && provider.isAccountRunning(acc.id)) continue;
                const baseTime = acc.lastValidCodeAt || acc.createdAt || 0;
                if (now - baseTime >= ACCOUNT_INVALID_MS) {
                    try {
                        if (store.deleteAccount) store.deleteAccount(acc.id);
                        adminLogger.info(`账号 ${acc.name || acc.id} 超过1天未获取到有效 code，已自动删除`, { module: 'auto_clean', event: 'account_expired', accountId: acc.id });
                    } catch (e) {
                        adminLogger.error(`自动清理账号失败: ${e.message}`);
                    }
                }
            }

            // --- 规则1：role=user 且 3 天未登录，且名下无运行中账号 ---
            const usersData = store.getUsers ? store.getUsers() : { users: [] };
            const users = usersData.users || [];
            for (const user of users) {
                if (user.role !== 'user') continue; // vip/admin 豁免
                const loginTime = user.lastLoginAt || user.createdAt || 0;
                if (now - loginTime < USER_INACTIVE_MS) continue;
                // 检查该用户名下是否有账号正在运行
                const userAccounts = store.getAccountsByUserId ? store.getAccountsByUserId(user.id) : [];
                const hasRunning = userAccounts.some(acc =>
                    provider && typeof provider.isAccountRunning === 'function' && provider.isAccountRunning(acc.id)
                );
                if (hasRunning) continue;
                try {
                    if (store.deleteUser) store.deleteUser(user.id);
                    adminLogger.info(`用户 ${user.username} 超过3天未登录且无运行中账号，已自动删除`, { module: 'auto_clean', event: 'user_inactive', userId: user.id });
                } catch (e) {
                    adminLogger.error(`自动清理用户失败: ${e.message}`);
                }
            }
        } catch (e) {
            adminLogger.error(`自动清理任务异常: ${e.message}`);
        }
    }

    // 启动后延迟 5 分钟首次执行，避免刚重启时误删
    setTimeout(() => {
        runAutoClean();
        setInterval(runAutoClean, AUTO_CLEAN_INTERVAL);
    }, 5 * 60 * 1000);
}

module.exports = {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
