const { Buffer } = require('node:buffer');
const EventEmitter = require('node:events');
/**
 * WebSocket 网络层 - 连接/消息编解码/登录/心跳
 *
 * 保活模式（WS_KEEPER_URL 环境变量）：
 *   设置 WS_KEEPER_URL=http://ws-keeper:4000 后，所有 sendMsg 通过 HTTP 转发给保活容器，
 *   主容器不直接持有 WebSocket 连接，重启不影响游戏 session，code 永不因重启失效。
 */

const process = require('node:process');
const WebSocket = require('ws');
const { CONFIG } = require('../config/config');
const { createScheduler } = require('../services/scheduler');
const { updateStatusFromLogin, updateStatusGold, updateStatusLevel } = require('../services/status');
const { recordOperation } = require('../services/stats');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, log, logWarn } = require('./utils');
const cryptoWasm = require('./crypto-wasm');

// ============ 事件发射器 (用于推送通知) ============
const networkEvents = new EventEmitter();

// ============ 内部状态 ============
let ws = null;
let clientSeq = 1;
let serverSeq = 0;
const pendingCallbacks = new Map();
let wsErrorState = { code: 0, at: 0, message: '' };
const networkScheduler = createScheduler('network');

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    coupon: 0, // 点券(ID:1002)
};

function getUserState() { return userState; }
function getWsErrorState() { return { ...wsErrorState }; }
function setWsErrorState(code, message) {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: message || '' };
}
function clearWsErrorState() {
    wsErrorState = { code: 0, at: 0, message: '' };
}
function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// ============ 保活模式配置 ============
const KEEPER_URL = (process.env.WS_KEEPER_URL || '').replace(/\/$/, '');
const KEEPER_SECRET = process.env.WS_KEEPER_SECRET || '';
const keeperMode = !!KEEPER_URL;

// Worker Threads 共享 process.env，多账号并发时 FARM_ACCOUNT_ID 会被覆盖。
// 必须在模块加载时从 workerData 优先读取并固定，不能每次动态读 process.env。
const _keeperAccountId = (() => {
    try {
        const { workerData } = require('node:worker_threads');
        if (workerData && workerData.accountId) return String(workerData.accountId);
    } catch {}
    return String(process.env.FARM_ACCOUNT_ID || '');
})();
function getKeeperAccountId() { return _keeperAccountId; }

if (keeperMode) {
    log('系统', `[keeper] 保活模式已启用，代理地址: ${KEEPER_URL}`);
}

/** 向保活容器发起 HTTP 请求 */
async function keeperFetch(endpoint, options = {}) {
    const nodeHttp = KEEPER_URL.startsWith('https') ? require('node:https') : require('node:http');
    const url = new URL(endpoint, KEEPER_URL + '/');
    return new Promise((resolve, reject) => {
        const body = options.body ? Buffer.from(options.body) : null;
        const headers = {
            'Content-Type': 'application/json',
            ...(KEEPER_SECRET ? { 'x-keeper-secret': KEEPER_SECRET } : {}),
            ...(body ? { 'Content-Length': String(body.length) } : {}),
        };
        const req = nodeHttp.request({
            hostname: url.hostname,
            port: url.port || (KEEPER_URL.startsWith('https') ? 443 : 80),
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers,
        }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, data: {} }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

/** 保活模式：通过 HTTP 发送游戏消息（携带 accountId） */
async function keeperSendMsgAsync(serviceName, methodName, bodyBytes, timeout = 30000) {
    const payload = JSON.stringify({
        accountId: getKeeperAccountId(),
        service: serviceName,
        method: methodName,
        body: bodyBytes ? Buffer.from(bodyBytes).toString('base64') : '',
    });
    const timer = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`保活转发超时: ${methodName}`)), timeout)
    );
    const req = keeperFetch('/send', { method: 'POST', body: payload });
    const { status, data } = await Promise.race([req, timer]);
    if (status === 503) throw new Error(`保活容器未登录: ${data && data.error || ''}`);
    if (!data || !data.ok) throw new Error(data && data.error ? data.error : `保活转发失败: ${methodName}`);
    return { body: Buffer.from(data.body || '', 'base64'), meta: data.meta || {} };
}

/** 保活模式：订阅游戏服务器推送通知（SSE 长连接，仅订阅本账号） */
function startKeeperNotifySubscription() {
    const nodeHttp = KEEPER_URL.startsWith('https') ? require('node:https') : require('node:http');
    const subscribePath = getKeeperAccountId()
        ? `/subscribe?accountId=${encodeURIComponent(getKeeperAccountId())}`
        : '/subscribe';
    const urlObj = new URL(KEEPER_URL);
    const headers = { ...(KEEPER_SECRET ? { 'x-keeper-secret': KEEPER_SECRET } : {}) };

    // SSE 断开后：检查 keeper 是否还有本账号的 session，没有则重新触发完整登录流程
    function onSseDisconnect() {
        setTimeout(() => {
            const statusPath = getKeeperAccountId()
                ? `/status?accountId=${encodeURIComponent(getKeeperAccountId())}`
                : '/status/all';
            keeperFetch(statusPath).then(({ data }) => {
                if (data && data.connected) {
                    // keeper 还在线且已登录，只需重新订阅 SSE
                    doConnect();
                } else if (data && data.exists && data.codeSet === false) {
                    // code 已失效（400），不要用旧 code 重连，让 ws_error 事件触发 cleanup 等待用户重新扫码
                    // 只重新订阅 SSE，以便接收后续事件
                    log('系统', '[keeper] SSE 断开：code 已失效，等待新 code...');
                    doConnect();
                } else {
                    // keeper session 丢失或网络抖动后重连，重新走完整登录流程
                    if (savedCode) {
                        log('系统', '[keeper] SSE 断开后检测到未登录，重新发送 code...');
                    }
                    connect(savedCode || null, savedLoginCallback);
                }
            }).catch(() => {
                // keeper 完全不可达，等待恢复后重新订阅
                doConnect();
            });
        }, 5000);
    }

    function doConnect() {
        const req = nodeHttp.request({
            hostname: urlObj.hostname,
            port: urlObj.port || (KEEPER_URL.startsWith('https') ? 443 : 80),
            path: subscribePath,
            method: 'GET',
            headers,
        }, (res) => {
            let buf = '';
            res.on('data', (chunk) => {
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const raw = line.slice(5).trim();
                    if (!raw) continue;
                    try { handleKeeperEvent(JSON.parse(raw)); } catch {}
                }
            });
            res.on('end', () => { onSseDisconnect(); });
            res.on('error', () => { onSseDisconnect(); });
        });
        req.on('error', () => { onSseDisconnect(); });
        req.end();
    }

    doConnect();
    log('系统', '[keeper] 已启动保活推送订阅');
}

/** 处理保活容器推送的事件（游戏通知 / ws_error） */
function handleKeeperEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'ws_error') {
        const code = Number(event.code) || 0;
        setWsErrorState(code, '保活容器 WS 错误');
        networkEvents.emit('ws_error', { code, message: '保活容器 WS 错误' });
        return;
    }
    if (event.type === 'notify') {
        try {
            const bodyBytes = Buffer.from(event.body || '', 'base64');
            handleNotify({ meta: event.meta || {}, body: bodyBytes });
        } catch {}
    }
}

// ============ 消息编解码 ============
async function encodeMsg(serviceName, methodName, bodyBytes) {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        try {
            finalBody = await cryptoWasm.encryptBuffer(finalBody);
        } catch (e) {
            logWarn('系统', `[WS] encryptBuffer 失败，使用明文: ${e.message}`);
        }
    }
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeq),
            server_seq: toLong(serverSeq),
        },
        body: finalBody,
    });
    const encoded = types.GateMessage.encode(msg).finish();
    clientSeq++;
    return encoded;
}

async function sendMsg(serviceName, methodName, bodyBytes, callback) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        log('系统', '[WS] 连接未打开');
        if (callback) callback(new Error('连接未打开'));
        return false;
    }
    const seq = clientSeq;
    let encoded;
    try {
        encoded = await encodeMsg(serviceName, methodName, bodyBytes);
    } catch (err) {
        if (callback) callback(err);
        return false;
    }
    if (callback) pendingCallbacks.set(seq, callback);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (callback) {
            pendingCallbacks.delete(seq);
            callback(new Error('连接已在加密途中关闭'));
        }
        return false;
    }
    ws.send(encoded);
    return true;
}

/** Promise 版发送 */
function sendMsgAsync(serviceName, methodName, bodyBytes, timeout = 10000) {
    // 保活模式：通过 HTTP 转发给保活容器
    if (keeperMode) {
        return keeperSendMsgAsync(serviceName, methodName, bodyBytes, timeout);
    }

    return new Promise((resolve, reject) => {
        // 检查连接状态
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error(`连接未打开: ${methodName}`));
            return;
        }

        const seq = clientSeq;
        const timeoutKey = `request_timeout_${seq}`;
        networkScheduler.setTimeoutTask(timeoutKey, timeout, () => {
            pendingCallbacks.delete(seq);
            // 检查当前待处理的请求数
            const pending = pendingCallbacks.size;
            reject(new Error(`请求超时: ${methodName} (seq=${seq}, pending=${pending})`));
        });

        sendMsg(serviceName, methodName, bodyBytes, (err, body, meta) => {
            networkScheduler.clear(timeoutKey);
            if (err) reject(err);
            else resolve({ body, meta });
        }).then(sent => {
            if (!sent) {
                networkScheduler.clear(timeoutKey);
                reject(new Error(`发送失败: ${methodName}`));
            }
        }).catch(err => {
            networkScheduler.clear(timeoutKey);
            reject(err);
        });
    });
}

// ============ 消息处理 ============
async function handleMessage(data) {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let msg;
        try {
            msg = types.GateMessage.decode(buf);
        } catch (err) {
            logWarn('解码', `外层 GateMessage 解码失败: ${err.message}`);
            return;
        }
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // 解密 body
        let bodyBuf = Buffer.from(msg.body || []);
        if (bodyBuf.length > 0) {
            try {
                bodyBuf = await cryptoWasm.decryptBuffer(bodyBuf);
            } catch (e) {
                // 解密失败时回退明文（兼容不需要解密的场景）
                bodyBuf = Buffer.from(msg.body || []);
            }
        }

        // Notify
        if (msgType === 3) {
            try {
                handleNotify({ meta, body: bodyBuf });
            } catch (e) {
                logWarn('推送', `Notify 处理失败: ${e.message}`);
            }
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const cb = pendingCallbacks.get(clientSeqVal);
            if (cb) {
                pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    cb(new Error(`${meta.service_name}.${meta.method_name} 错误: code=${errorCode} ${meta.error_message || ''}`));
                } else {
                    cb(null, bodyBuf, meta);
                }
                return;
            }

            if (errorCode !== 0) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }
        }
    } catch (err) {
        logWarn('解码', err.message);
    }
}

function handleNotify(msg) {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        const eventBody = event.body;

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = types.KickoutNotify.decode(eventBody);
                log('推送', `原因: ${notify.reason_message || '未知'}`);
                networkEvents.emit('kickout', {
                    type,
                    reason: notify.reason_message || '未知',
                });
            } catch { }
            return;
        }

        // 土地状态变化 (被放虫/放草/偷菜等)
        if (type.includes('LandsNotify')) {
            try {
                const notify = types.LandsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = notify.lands || [];
                if (lands.length > 0) {
                    // 如果是自己的农场，触发事件
                    if (hostGid === userState.gid || hostGid === 0) {
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch { }
            return;
        }

        // 物品变化通知 (经验/金币等)
        if (type.includes('ItemNotify')) {
            try {
                const notify = types.ItemNotify.decode(eventBody);
                const items = notify.items || [];
                for (const itemChg of items) {
                    const item = itemChg.item;
                    if (!item) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);
                    
                    // 仅使用 ID=1101 作为经验值标准
                    if (id === 1101) {
                        // 优先使用总量；若仅有 delta 也可累加
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        // 这里调用 updateStatusLevel 会触发 status.js -> worker.js -> stats.js 的更新流程
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        // 金币通知有时只有 delta 没有总量，避免把未提供总量误当 0 覆盖
                        if (count > 0) {
                            userState.gold = count;
                        } else if (delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        // 点券
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    }
                }
            } catch { }
            return;
        }

        // 基本信息变化 (升级等)
        if (type.includes('BasicNotify')) {
            try {
                const notify = types.BasicNotify.decode(eventBody);
                if (notify.basic) {
                    const oldLevel = userState.level;
                    if (hasOwn(notify.basic, 'level')) {
                        const nextLevel = toNum(notify.basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(notify.basic, 'gold')) {
                        const nextGold = toNum(notify.basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(notify.basic, 'exp')) {
                        const exp = toNum(notify.basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch { }
            return;
        }

        // 好友申请通知 (微信同玩)
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                const applications = notify.applications || [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch { }
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = types.FriendAddedNotify.decode(eventBody);
                const friends = notify.friends || [];
                if (friends.length > 0) {
                    const names = friends.map(f => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                }
            } catch { }
            return;
        }

        // 商品解锁通知 (升级后解锁新种子等)
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = types.GoodsUnlockNotify.decode(eventBody);
                const goods = notify.goods_list || [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch { }
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = types.TaskInfoNotify.decode(eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info);
                }
            } catch { }
            
        }

        // 其他未处理的推送类型 (调试用)
        // log('推送', `未处理类型: ${type}`);
    } catch (e) {
        logWarn('推送', `解码失败: ${e.message}`);
    }
}

// ============ 登录 ============
function sendLogin(onLoginSuccess) {
    const body = types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: {
            client_version: CONFIG.clientVersion,
            sys_software: 'iOS 26.2.1',
            network: 'wifi',
            memory: '7672',
            device_id: 'iPhone X<iPhone18,3>',
        },
        share_cfg_id: toLong(0),
        scene_id: '1256',
        report_data: {
            callback: '', cd_extend_info: '', click_id: '', clue_token: '',
            minigame_channel: 'other', minigame_platid: 2, req_id: '', trackid: '',
        },
    })).finish();

    sendMsg('gamepb.userpb.UserService', 'Login', body, (err, bodyBytes, _meta) => {
        if (err) {
            log('登录', `失败: ${err.message}`);
            // 如果是验证失败，直接退出进程
            if (err.message.includes('code=')) {
                log('系统', '账号验证失败，即将停止运行...');
                networkScheduler.setTimeoutTask('login_error_exit', 1000, () => process.exit(0));
            }
            return;
        }
        try {
            const reply = types.LoginReply.decode(bodyBytes);
            if (reply.basic) {
                clearWsErrorState();
                userState.gid = toNum(reply.basic.gid);
                userState.name = reply.basic.name || '未知';
                userState.level = toNum(reply.basic.level);
                userState.gold = toNum(reply.basic.gold);
                userState.exp = toNum(reply.basic.exp);

                // 更新状态栏
                updateStatusFromLogin({
                    name: userState.name,
                    level: userState.level,
                    gold: userState.gold,
                    exp: userState.exp,
                });

                log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);

                console.warn('');
                console.warn('========== 登录成功 ==========');
                console.warn(`  GID:    ${userState.gid}`);
                console.warn(`  昵称:   ${userState.name}`);
                console.warn(`  等级:   ${userState.level}`);
                console.warn(`  金币:   ${userState.gold}`);
                if (reply.time_now_millis) {
                    syncServerTime(toNum(reply.time_now_millis));
                    console.warn(`  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`);
                }
                console.warn('===============================');
                console.warn('');
            }

            startHeartbeat();
            if (onLoginSuccess) onLoginSuccess();
        } catch (e) {
            log('登录', `解码失败: ${e.message}`);
        }
    });
}

// ============ 心跳 ============
let lastHeartbeatResponse = Date.now();
let heartbeatMissCount = 0;

function startHeartbeat() {
    networkScheduler.clear('heartbeat_interval');
    lastHeartbeatResponse = Date.now();
    heartbeatMissCount = 0;
    
    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, () => {
        if (!userState.gid) return;
        
        // 检查上次心跳响应时间，超过 60 秒没响应说明连接有问题
        const timeSinceLastResponse = Date.now() - lastHeartbeatResponse;
        if (timeSinceLastResponse > 60000) {
            heartbeatMissCount++;
            logWarn('心跳', `连接可能已断开 (${Math.round(timeSinceLastResponse/1000)}s 无响应, pending=${pendingCallbacks.size})`);
            if (heartbeatMissCount >= 2) {
                log('心跳', '尝试重连...');
                // 清理待处理的回调，避免堆积
                pendingCallbacks.forEach((cb, _seq) => {
                    try { cb(new Error('连接超时，已清理')); } catch {}
                });
                pendingCallbacks.clear();
            }
        }
        
        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(userState.gid),
            client_version: CONFIG.clientVersion,
        })).finish();
        sendMsg('gamepb.userpb.UserService', 'Heartbeat', body, (err, replyBody) => {
            if (err || !replyBody) return;
            lastHeartbeatResponse = Date.now();
            heartbeatMissCount = 0;
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                if (reply.server_time) syncServerTime(toNum(reply.server_time));
            } catch { }
        });
    });
}

// ============ WebSocket 连接 ============
let savedLoginCallback = null;
let savedCode = null;

function connect(code, onLoginSuccess) {
    // ─── 保活模式：不直连游戏服务器，通知保活容器建连，再订阅推送 ───
    if (keeperMode) {
        if (onLoginSuccess) savedLoginCallback = onLoginSuccess;
        if (code) savedCode = code;

        // 通知保活容器建立/更新连接（携带 accountId）
        if (code) {
            keeperFetch('/connect', {
                method: 'POST',
                body: JSON.stringify({ accountId: getKeeperAccountId(), code }),
            }).then(({ data }) => {
                log('系统', `[keeper] 已发送 code 给保活容器: ${data && data.message || ''}`);
            }).catch(e => {
                logWarn('系统', `[keeper] 通知保活容器失败: ${e.message}`);
            });
        }

        // 等待保活容器该账号登录就绪，轮询 /status?accountId=xxx
        const statusPath = getKeeperAccountId()
            ? `/status?accountId=${encodeURIComponent(getKeeperAccountId())}`
            : '/status/all';
        let pollCount = 0;
        const pollLogin = () => {
            keeperFetch(statusPath).then(({ data }) => {
                if (data && data.connected) {
                    // 保活容器已登录，同步用户状态到本地
                    if (data.user) {
                        Object.assign(userState, data.user);
                        clearWsErrorState();
                        updateStatusFromLogin({
                            name: userState.name,
                            level: userState.level,
                            gold: userState.gold,
                            exp: userState.exp,
                        });
                        log('系统', `[keeper] 已同步登录状态: ${userState.name} (Lv${userState.level})`);
                    }
                    pollCount = 0;
                    if (savedLoginCallback) savedLoginCallback();
                    // 启动推送订阅
                    startKeeperNotifySubscription();
                } else {
                    pollCount++;
                    // keeper 无 session（keeper 重启/session 丢失），重新发送 code
                    // 注意：data.exists 未返回时为 undefined，不等于 false，避免误判"登录中"状态
                    // codeSet === false 表示 code 已 400 失效，不重发旧 code，停止轮询等待新 code
                    if (data && data.exists && data.codeSet === false) {
                        // code 已失效，停止轮询，等待 ws_error 事件或用户提供新 code
                        log('系统', '[keeper] code 已失效（400），停止轮询，等待新 code...');
                        savedCode = null;
                        return;
                    }
                    if (pollCount >= 2 && data.exists === false && savedCode) {
                        log('系统', '[keeper] keeper session 丢失，重新发送 code...');
                        keeperFetch('/connect', {
                            method: 'POST',
                            body: JSON.stringify({ accountId: getKeeperAccountId(), code: savedCode }),
                        }).catch(() => {});
                    }
                    // 未就绪，3秒后再查
                    networkScheduler.setTimeoutTask('keeper_poll_login', 3000, pollLogin);
                }
            }).catch(() => {
                pollCount++;
                networkScheduler.setTimeoutTask('keeper_poll_login', 5000, pollLogin);
            });
        };
        pollLogin();
        return;
    }

    // ─── 直连模式（无保活容器）───
    savedLoginCallback = onLoginSuccess;
    if (code) savedCode = code;
    const url = `${CONFIG.serverUrl}?platform=${CONFIG.platform}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${savedCode}&openID=`;

    ws = new WebSocket(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
            'Origin': 'https://gate-obt.nqf.qq.com',
        },
    });

    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
        sendLogin(onLoginSuccess);
    });

    ws.on('message', (data) => {
        handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    ws.on('close', (code, _reason) => {
        console.warn(`[WS] 连接关闭 (code=${code})`);
        cleanup();
        // 自动重连：延迟 5s 后重试，复用已保存的登录回调
        if (savedLoginCallback) {
            networkScheduler.setTimeoutTask('auto_reconnect', 5000, () => {
                log('系统', '[WS] 尝试自动重连...');
                reconnect(null);
            });
        }
    });

    ws.on('error', (err) => {
        const message = err && err.message ? String(err.message) : '';
        logWarn('系统', `[WS] 错误: ${message}`);
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const code = Number.parseInt(match[1], 10) || 0;
            if (code) {
                setWsErrorState(code, message);
                networkEvents.emit('ws_error', { code, message });
            }
        }
    });
}

function cleanup() {
    networkScheduler.clearAll();
    pendingCallbacks.clear();
}

function reconnect(newCode) {
    if (keeperMode) {
        // 保活模式：更新 code 并通知保活容器重新建连
        if (newCode) savedCode = newCode;
        connect(newCode || savedCode, savedLoginCallback);
        return;
    }
    cleanup();
    if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
    }
    userState.gid = 0;
    connect(newCode || savedCode, savedLoginCallback);
}

/**
 * 获取 WS 对象（保活模式下返回虚拟对象供调用方判断连接状态）
 * worker.js 里 syncStatus 用 ws.readyState === 1 判断是否已连接
 */
function getWs() {
    if (keeperMode) {
        // 保活模式：返回虚拟对象，close() 是空操作（真实连接在 keeper 里）
        const ready = userState.gid > 0;
        return {
            readyState: ready ? 1 /* OPEN */ : 3 /* CLOSED */,
            close: () => {},
            removeAllListeners: () => {},
        };
    }
    return ws;
}

module.exports = {
    connect, reconnect, cleanup, getWs,
    sendMsg, sendMsgAsync,
    getUserState,
    getKeeperAccountId,
    getWsErrorState,
    networkEvents,
    keeperMode,
};
