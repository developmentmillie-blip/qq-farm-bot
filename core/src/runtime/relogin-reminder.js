const { sleep } = require('../utils/utils');
const QRCode = (() => { try { return require('qrcode'); } catch(e) { return null; } })();

function createReloginReminderService(options) {
    const {
        store,
        miniProgramLoginSession,
        sendPushooMessage,
        log,
        addAccountLog,
        getAccounts,
        addOrUpdateAccount,
        resolveWorkerControls,
    } = options;

    const reloginWatchers = new Map(); // key: accountId:loginCode

    function getOfflineAutoDeleteMs() {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        const sec = Math.max(1, Number.parseInt(cfg && cfg.offlineDeleteSec, 10) || 120);
        return sec * 1000;
    }

    /**
     * 通过 VIP SMTP 向账号归属用户发送邮件通知
     * @param {string} accountId
     * @param {string} title
     * @param {string} content
     */
    async function sendVipEmailNotify(accountId, title, content) {
        if (!store.getVipSmtpConfig || !store.getAdminSmtpConfig) return;
        try {
            // 找到账号归属用户
            const allData = store.getAccounts ? store.getAccounts() : { accounts: [] };
            const account = (allData.accounts || []).find(a => String(a.id) === String(accountId));
            if (!account || !account.userId) return;
            const userId = String(account.userId);
            // 获取用户角色（只有 vip/admin 才发）
            const userData = store.getUsers ? store.getUsers() : { users: [] };
            const user = (userData.users || []).find(u => String(u.id) === userId);
            if (!user || (user.role !== 'vip' && user.role !== 'admin')) return;
            // 获取 VIP 收件配置（只需 QQ 号）
            const smtpCfg = store.getVipSmtpConfig(userId);
            if (!smtpCfg || !smtpCfg.qq) return;
            // 使用管理员配置的发件 SMTP
            const adminCfg = store.getAdminSmtpConfig();
            if (!adminCfg || !adminCfg.fromEmail || !adminCfg.smtpPass) return;
            const toEmail = `${smtpCfg.qq}@qq.com`;
            const token = `${adminCfg.fromEmail}:${adminCfg.smtpPass}`;
            await sendPushooMessage({
                channel: 'email',
                endpoint: toEmail,
                token,
                title,
                content,
            });
        } catch (e) {
            log('错误', `VIP邮件通知发送异常: ${e.message}`);
        }
    }

    /**
     * 好友巡查发现成熟作物提醒（供 friend.js 调用，notifyMature 字段控制）
     */
    async function triggerFriendMatureNotify({ accountId, accountName, friendName, stealableCount }) {
        if (!store.getVipSmtpConfig) return;
        try {
            const allData = store.getAccounts ? store.getAccounts() : { accounts: [] };
            const account = (allData.accounts || []).find(a => String(a.id) === String(accountId));
            if (!account || !account.userId) return;
            const smtpCfg = store.getVipSmtpConfig(String(account.userId));
            if (!smtpCfg || !smtpCfg.notifyMature || !smtpCfg.qq) return;
            const title = `[成熟提醒] 好友农场有成熟作物`;
            const content = `账号 ${accountName || accountId} 巡查好友「${friendName || '未知'}」时发现 ${stealableCount || 0} 块成熟作物，自动偷菜未开启，请手动前往偷菜。`;
            await sendVipEmailNotify(accountId, title, content);
        } catch (e) {
            log('错误', `好友成熟通知异常: ${e.message}`);
        }
    }

    function applyReloginCode({ accountId = '', accountName = '', authCode = '', uin = '', userId = '' }) {
        const code = String(authCode || '').trim();
        if (!code) return;

        const data = getAccounts();
        const list = Array.isArray(data.accounts) ? data.accounts : [];
        const found = list.find(a => String(a.id) === String(accountId));
        const avatar = uin ? `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640` : '';
        const controls = (typeof resolveWorkerControls === 'function') ? (resolveWorkerControls() || {}) : {};
        const startWorker = typeof controls.startWorker === 'function' ? controls.startWorker : null;
        const restartWorker = typeof controls.restartWorker === 'function' ? controls.restartWorker : null;

        if (found) {
            addOrUpdateAccount({
                id: found.id,
                name: found.name,
                code,
                platform: found.platform || 'qq',
                qq: uin || found.qq || found.uin || '',
                uin: uin || found.uin || found.qq || '',
                avatar: avatar || found.avatar || '',
            });
            if (restartWorker) {
                restartWorker({
                    ...found,
                    code,
                    qq: uin || found.qq || found.uin || '',
                    uin: uin || found.uin || found.qq || '',
                    avatar: avatar || found.avatar || '',
                });
            }
            addAccountLog('update', `重登录成功，已更新账号: ${found.name}`, found.id, found.name, { reason: 'relogin' });
            log('系统', `重登录成功，账号已更新并重启: ${found.name}`);
            return;
        }

        // 新建账号：携带 userId（原账号所属用户）
        const created = addOrUpdateAccount({
            name: accountName || (uin ? String(uin) : '重登录账号'),
            code,
            platform: 'qq',
            qq: uin || '',
            uin: uin || '',
            avatar,
            userId: userId || undefined,
        });
        const newAcc = (created.accounts || [])[created.accounts.length - 1];
        if (newAcc) {
            if (startWorker) startWorker(newAcc);
            addAccountLog('add', `重登录成功，已新增账号: ${newAcc.name}`, newAcc.id, newAcc.name, { reason: 'relogin' });
            log('系统', `重登录成功，已新增账号并启动: ${newAcc.name}`, { accountId: String(newAcc.id), accountName: newAcc.name });
        }
    }

    function startReloginWatcher({ loginCode, accountId = '', accountName = '', userId = '' }) {
        const code = String(loginCode || '').trim();
        if (!code) return;

        const key = `${accountId || 'unknown'}:${code}`;
        if (reloginWatchers.has(key)) return;
        reloginWatchers.set(key, { startedAt: Date.now() });
        log('系统', `已启动重登录监听: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });

        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            reloginWatchers.delete(key);
        };

        (async () => {
            const maxRounds = 120; // ~2分钟
            for (let i = 0; i < maxRounds; i += 1) {
                try {
                    const status = await miniProgramLoginSession.queryStatus(code);
                    if (!status || status.status === 'Wait') {
                        await sleep(1000);
                        continue;
                    }
                    if (status.status === 'Used') {
                        log('系统', `重登录二维码已失效: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });
                        stop();
                        return;
                    }
                    if (status.status === 'OK') {
                        const ticket = String(status.ticket || '').trim();
                        const uin = String(status.uin || '').trim();
                        if (!ticket) {
                            log('错误', '重登录监听失败: ticket 为空');
                            stop();
                            return;
                        }
                        const authCode = await miniProgramLoginSession.getAuthCode(ticket, '1112386029');
                        if (!authCode) {
                            log('错误', '重登录监听失败: 未获取到新 code');
                            stop();
                            return;
                        }
                        applyReloginCode({ accountId, accountName, authCode, uin, userId });
                        stop();
                        return;
                    }
                    await sleep(1000);
                } catch {
                    await sleep(1000);
                }
            }
            log('系统', `重登录监听超时: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });
            stop();
        })();
    }

    async function triggerOfflineReminder(payload = {}) {
        try {
            const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
            if (!cfg) return;

            const channelName = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const channel = channelName;
            const token = String(cfg.token || '').trim();
            const baseTitle = String(cfg.title || '').trim();
            const accountName = String(payload.accountName || payload.accountId || '').trim();

            // 支持调用方覆盖 title/content（如天王模式偷菜失败通知）
            const title = payload._overrideTitle || (accountName ? `${baseTitle} ${accountName}` : baseTitle);
            let content = payload._overrideContent || String(cfg.msg || '').trim();

            // VIP SMTP 下线提醒（额外发送）
            const accountIdStr = String(payload.accountId || '').trim();
            if (accountIdStr && !String(payload.reason || '').startsWith('steal_fail')) {
                try {
                    const allData = store.getAccounts ? store.getAccounts() : { accounts: [] };
                    const acc = (allData.accounts || []).find(a => String(a.id) === accountIdStr);
                    if (acc && acc.userId) {
                        const smtpCfg = store.getVipSmtpConfig ? store.getVipSmtpConfig(String(acc.userId)) : null;
                        const adminCfg = store.getAdminSmtpConfig ? store.getAdminSmtpConfig() : null;
                        if (smtpCfg && smtpCfg.notifyOffline && smtpCfg.qq && adminCfg && adminCfg.fromEmail && adminCfg.smtpPass) {
                            const toEmail = `${smtpCfg.qq}@qq.com`;
                            await sendPushooMessage({
                                channel: 'email',
                                endpoint: toEmail,
                                token: `${adminCfg.fromEmail}:${adminCfg.smtpPass}`,
                                title: `[掉线提醒] ${accountName || accountIdStr}`,
                                content: `账号 ${accountName || accountIdStr} 已下线，请及时处理！`,
                            }).catch(() => {});
                        }
                    }
                } catch {}
            }

            // 兼容旧推送渠道
            if (channel && token && title && content) {
                const isStealFail = String(payload.reason || '').startsWith('steal_fail');
                const reloginUrlMode = isStealFail ? 'none' : String(cfg.reloginUrlMode || 'none').trim().toLowerCase();

                if (reloginUrlMode === 'qq_link' || reloginUrlMode === 'qr_code' || reloginUrlMode === 'all') {
                    try {
                        const qr = await miniProgramLoginSession.requestLoginCode();
                        const loginCode = String((qr && qr.code) || '').trim();
                        const qqUrl = String((qr && (qr.url || qr.loginUrl)) || '').trim();
                        if (qqUrl) {
                            if (reloginUrlMode === 'qq_link') {
                                content = `${content}\n\n重登录链接: ${qqUrl}`;
                            } else if (reloginUrlMode === 'qr_code') {
                                // 生成 Base64 二维码图片嵌入消息
                                if (QRCode) {
                                    try {
                                        const qrImg = await QRCode.toDataURL(qqUrl);
                                        content = `${content}\n\n重登录二维码:<br><img src="${qrImg}" />`;
                                    } catch {
                                        content = `${content}\n\n重登录链接: ${qqUrl}`;
                                    }
                                } else {
                                    content = `${content}\n\n重登录链接: ${qqUrl}`;
                                }
                            } else if (reloginUrlMode === 'all') {
                                // 同时附上链接和二维码图片
                                content = `${content}\n\n重登录链接: ${qqUrl}`;
                                if (QRCode) {
                                    try {
                                        const qrImg = await QRCode.toDataURL(qqUrl);
                                        content = `${content}<br><img src="${qrImg}" />`;
                                    } catch {}
                                }
                            }
                        }
                        if (loginCode) {
                            // 查找原账号的 userId 以便重登后关联回同一用户
                            const allAccData = store.getAccounts ? store.getAccounts() : { accounts: [] };
                            const origAcc = (allAccData.accounts || []).find(a => String(a.id) === String(payload.accountId || '').trim());
                            startReloginWatcher({
                                loginCode,
                                accountId: String(payload.accountId || '').trim(),
                                accountName: String(payload.accountName || '').trim(),
                                userId: origAcc ? String(origAcc.userId || '') : '',
                            });
                        }
                    } catch (e) {
                        log('错误', `获取重登录链接失败: ${e.message}`);
                    }
                }

                if (channel === 'webhook' && !endpoint) {
                    // webhook 需要 endpoint，跳过
                } else {
                    const ret = await sendPushooMessage({ channel, endpoint, token, title, content });
                    if (ret && ret.ok) {
                        log('系统', `下线提醒发送成功: ${accountName}`);
                    } else {
                        log('错误', `下线提醒发送失败: ${ret && ret.msg ? ret.msg : 'unknown'}`);
                    }
                }
            }
        } catch (e) {
            log('错误', `下线提醒发送异常: ${e.message}`);
        }
    }

    return {
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        startReloginWatcher,
        applyReloginCode,
        sendVipEmailNotify,
        triggerFriendMatureNotify,
    };
}

module.exports = {
    createReloginReminderService,
};
