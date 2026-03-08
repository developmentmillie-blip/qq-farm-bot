const { createScheduler } = require('../services/scheduler');

function createWorkerManager(options) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount,
        deleteAccount,
        getAccountsByUserId,
        forceDeleteAccount,
        store: storeRef,
        onStatusSync,
        onWorkerLog,
    } = options;
    const managerScheduler = createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';

    function createThreadWorker(account) {
        const worker = new WorkerThread(workerScriptPath, {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
            },
        });
        // 与 child_process 保持同形接口
        worker.send = (payload) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }

    function createForkWorker(account) {
        if (processRef.pkg) {
            // 打包后也走 fork + execPath，确保 IPC 通道可用
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || '') },
            });
        }
        return fork(workerScriptPath, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || '') },
        });
    }

    function createWorkerProcess(account) {
        if (useThreadRuntime) return createThreadWorker(account);
        return createForkWorker(account);
    }

    function startWorker(account) {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false; // 已运行

        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child = null;
        try {
            child = createWorkerProcess(account);
        } catch (err) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }

        workers[account.id] = {
            process: child,
            status: null, // 最新状态快照
            logs: [],
            requests: new Map(), // pending API requests
            reqId: 1,
            name: account.name,
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            wsError: null,
        };

        // 发送启动指令
        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
            },
        });
        child.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(account.id) });

        // 监听消息
        child.on('message', (msg) => {
            handleWorkerMessage(account.id, msg);
        });

        child.on('error', (err) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code, signal) => {
            const current = workers[account.id];
            const displayName = (current && current.name) || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }

    function stopWorker(accountId) {
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        // process.kill will happen in 'exit' handler or we can force it
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    function restartWorker(account) {
        if (!account) return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) return startWorker(account);
        const proc = worker.process;
        let started = false;
        const startOnce = () => {
            if (started) return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) return startWorker(account);
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(account);
        };
        const killIfStale = () => {
            const current = workers[accountId];
            if (!current || current.process !== proc) return false;
            try {
                current.process.kill();
            } catch {}
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            return startOnce();
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started) return;
            killIfStale();
            startOnce();
        });
    }

    function handleWorkerMessage(accountId, msg) {
        const worker = workers[accountId];
        if (!worker) return;

        if (msg.type === 'status_sync') {
            // 合并状态
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            // 尝试更新昵称到 store
            if (msg.data && msg.data.status && msg.data.status.name) {
                const newNick = String(msg.data.status.name).trim();
                // 忽略无效昵称
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    // 避免频繁写入，只在内存中无昵称或不一致时更新
                    if (worker.name !== newNick) {
                        const oldName = worker.name;
                        worker.name = newNick;
                        addOrUpdateAccount({
                            id: accountId,
                            name: newNick,
                        });
                        // 仅在首次同步或名称变更时记录日志
                        if (oldName !== newNick) {
                            log('系统', `已同步账号昵称: ${oldName} -> ${newNick}`, { accountId, accountName: newNick });
                        }
                    }
                }
            }

            // 按 gid 自动合并同用户下的旧账号（仅执行一次）
            if (!worker._gidMerged && msg.data && msg.data.status) {
                const syncedGid = Number(msg.data.status.gid);
                if (syncedGid > 0 && typeof getAccountsByUserId === 'function' && typeof forceDeleteAccount === 'function') {
                    // 先把 gid 持久化到本账号
                    addOrUpdateAccount({ id: accountId, gid: syncedGid });
                    worker._gidMerged = true;

                    // 找本账号所属用户 ID（从 storeRef 读取）
                    try {
                        const allAccList = storeRef
                            ? (storeRef.getAccounts().accounts || [])
                            : [];
                        const selfAcc = allAccList.find(a => String(a.id) === String(accountId));
                        const userId = selfAcc ? String(selfAcc.userId || '') : '';

                        if (userId) {
                            const sameUserAccounts = getAccountsByUserId(userId).filter(a => !a.deletedAt);
                            const staleMatches = sameUserAccounts.filter(a => {
                                if (String(a.id) === String(accountId)) return false; // 排除自身
                                if (Number(a.gid) !== syncedGid) return false;
                                // 是否未运行（proc/thread 两种模式都检查）
                                const w = workers[String(a.id)];
                                const isRunning = w && (w.proc || w.thread || w.stopping === false);
                                return !isRunning;
                            });

                            for (const stale of staleMatches) {
                                const staleId = String(stale.id);
                                try {
                                    // 迁移设置到当前（新）账号
                                    if (storeRef && storeRef.getAccountConfigSnapshot && storeRef.setAccountConfigSnapshot) {
                                        const oldCfg = storeRef.getAccountConfigSnapshot(staleId);
                                        if (oldCfg) storeRef.setAccountConfigSnapshot(accountId, oldCfg);
                                    }
                                    if (storeRef && storeRef.getPlantBlacklist && storeRef.setPlantBlacklist) {
                                        const bl = storeRef.getPlantBlacklist(staleId);
                                        if (bl && bl.length) storeRef.setPlantBlacklist(accountId, bl);
                                    }
                                    if (storeRef && storeRef.getFriendBlacklistMulti && storeRef.setFriendBlacklistMulti) {
                                        const fbl = storeRef.getFriendBlacklistMulti(staleId);
                                        if (fbl) storeRef.setFriendBlacklistMulti(accountId, fbl);
                                    }
                                    if (storeRef && storeRef.getStealWhitelist && storeRef.setStealWhitelist) {
                                        const swl = storeRef.getStealWhitelist(staleId);
                                        if (swl && swl.length) storeRef.setStealWhitelist(accountId, swl);
                                    }
                                    if (storeRef && storeRef.getCareWhitelist && storeRef.setCareWhitelist) {
                                        const cwl = storeRef.getCareWhitelist(staleId);
                                        if (cwl && cwl.length) storeRef.setCareWhitelist(accountId, cwl);
                                    }
                                    forceDeleteAccount(staleId);
                                    log('系统', `已自动合并旧账号 (gid=${syncedGid}): ${stale.name || staleId} -> ${worker.name || accountId}`, { accountId, accountName: worker.name });
                                } catch (mergeErr) {
                                    log('错误', `按 gid 合并旧账号失败: ${mergeErr.message}`, { accountId });
                                }
                            }
                        }
                    } catch (e) {
                        log('错误', `gid 合并逻辑异常: ${e.message}`, { accountId });
                    }
                }
            }

            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
                // 记录账号最后一次成功在线时间（供无效账号清理使用）
                try { addOrUpdateAccount({ id: accountId, lastValidCodeAt: Date.now() }); } catch { /* ignore */ }
            } else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs();
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    } catch (e) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            // 保存日志
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'error') {
            log('错误', `账号[${accountId}]进程报错: ${msg.error}`, { accountId: String(accountId), accountName: worker.name });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                addAccountLog(
                    'ws_400',
                    `账号 ${worker.name} 登录失效，请更新 Code`,
                    accountId,
                    worker.name,
                );
                // 触发下线提醒（含自动重登录链接），与被踢下线处理一致
                triggerOfflineReminder({
                    accountId,
                    accountName: worker.name,
                    reason: 'ws_400',
                    offlineMs: 0,
                });
            }
        } else if (msg.type === 'account_kicked') {
            const reason = msg.reason || '未知';
            log('系统', `账号 ${worker.name} 被踢下线，已自动停止账号`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} 被踢下线，已自动停止`, accountId, worker.name, { reason });
            stopWorker(accountId);
        } else if (msg.type === 'steal_notify') {
            // 天王模式：偷菜失败多次无法偷到，通知用户手动处理
            const friendName = msg.friendName || '未知';
            const stealReason = msg.reason === 'quota_full' ? '今日次数已用完' : '请求持续失败，可能被防偷';
            const title = `天王模式：${worker.name} 无法偷菜`;
            const content = `好友「${friendName}」有成熟作物但无法偷取（${stealReason}），请手动前往偷菜。`;
            log('天王', `${worker.name} 无法偷 ${friendName} 的菜（${stealReason}），已发推送提醒`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `steal_fail:${msg.reason || 'unknown'}`,
                offlineMs: 0,
                _overrideTitle: title,
                _overrideContent: content,
            });
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(new Error(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        }
    }

    function callWorkerApi(accountId, method, ...args) {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));

        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });

            // 超时处理（doFarmOp 需要施肥+验证，允许更长时间）
            const timeoutMs = method === 'doFarmOp' ? 30000 : 10000;
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, timeoutMs, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });

            worker.process.send({ type: 'api_call', id, method, args });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
    };
}

module.exports = {
    createWorkerManager,
};
