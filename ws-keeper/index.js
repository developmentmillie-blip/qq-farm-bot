/**
 * ws-keeper - 游戏 WebSocket 连接保活服务（多账号版）
 *
 * 职责：
 *   1. 为每个账号持有一条独立的游戏服务器 WebSocket 长连接（含心跳）
 *   2. 对外暴露 HTTP API，让主容器按 accountId 发送/接收游戏消息
 *   3. 主容器随时重启/更新，保活容器中的连接不受影响，code 永不因重启失效
 *
 * HTTP API：
 *   POST /connect              body: { accountId, code }  → 建立/更新账号连接
 *   POST /disconnect           body: { accountId }        → 断开并删除账号连接
 *   GET  /status               query: ?accountId=xxx      → 单账号状态
 *   GET  /status/all                                      → 所有账号状态列表
 *   POST /send                 body: { accountId, service, method, body }  → 发游戏消息
 *   GET  /subscribe            query: ?accountId=xxx 或不传（全部）→ SSE 推送通知
 *
 * 环境变量：
 *   KEEPER_PORT       监听端口（默认 4000）
 *   KEEPER_SECRET     共享密钥，主容器请求时放 x-keeper-secret 头（默认不鉴权）
 *   GAME_SERVER_URL   游戏 WS 地址（默认 wss://gate-obt.nqf.qq.com/gate/ws）
 *   PLATFORM          平台（默认 qq）
 *   CLIENT_VERSION    客户端版本（默认 1.6.0.8_20251224）
 *   PROTO_DIR         proto 文件目录（默认 ./proto）
 */

'use strict';

const http = require('node:http');
const { Buffer } = require('node:buffer');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('node:path');
const cryptoWasm = require('./utils/crypto-wasm');

// ─────────────────────── 配置 ───────────────────────
const PORT = Number(process.env.KEEPER_PORT) || 4000;
const SECRET = process.env.KEEPER_SECRET || '';
const GAME_SERVER_URL = process.env.GAME_SERVER_URL || 'wss://gate-obt.nqf.qq.com/prod/ws';
const PLATFORM = process.env.PLATFORM || 'qq';
const OS_TAG = process.env.OS_TAG || 'iOS';
const CLIENT_VERSION = process.env.CLIENT_VERSION || '1.6.2.18_20260227';
// 优先用环境变量，其次 ws-keeper/proto，最后 fallback 到 core/src/proto
const PROTO_DIR = (() => {
    const fs = require('node:fs');
    if (process.env.PROTO_DIR) return process.env.PROTO_DIR;
    const local = path.join(__dirname, 'proto');
    if (fs.existsSync(path.join(local, 'game.proto'))) return local;
    return path.join(__dirname, '..', 'core', 'src', 'proto');
})();

// ─────────────────────── Proto 加载 ───────────────────────
let types = null;

async function loadProto() {
    const root = new protobuf.Root();
    const files = [
        'game.proto', 'userpb.proto', 'plantpb.proto', 'corepb.proto',
        'shoppb.proto', 'friendpb.proto', 'visitpb.proto', 'notifypb.proto',
        'taskpb.proto', 'itempb.proto', 'emailpb.proto', 'mallpb.proto',
        'redpacketpb.proto', 'qqvippb.proto', 'sharepb.proto', 'illustratedpb.proto',
    ];
    await root.load(files.map(f => path.join(PROTO_DIR, f)), { keepCase: true });
    types = {
        GateMessage: root.lookupType('gatepb.Message'),
        GateMeta: root.lookupType('gatepb.Meta'),
        EventMessage: root.lookupType('gatepb.EventMessage'),
        LoginRequest: root.lookupType('gamepb.userpb.LoginRequest'),
        LoginReply: root.lookupType('gamepb.userpb.LoginReply'),
        HeartbeatRequest: root.lookupType('gamepb.userpb.HeartbeatRequest'),
        HeartbeatReply: root.lookupType('gamepb.userpb.HeartbeatReply'),
    };
    console.log('[keeper] proto 加载完成, 类型数:', Object.keys(types).length);
}

// ─────────────────────── 工具函数 ───────────────────────
function toLong(n) {
    try {
        const Long = require('long');
        return Long.fromNumber(Number(n) || 0);
    } catch {
        return Number(n) || 0;
    }
}

function toNum(v) {
    if (v == null) return 0;
    if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
    return Number(v) || 0;
}

// ─────────────────────── 多账号连接管理 ───────────────────────
/**
 * sessions: Map<accountId, AccountSession>
 *
 * AccountSession {
 *   accountId: string
 *   code: string
 *   ws: WebSocket | null
 *   loginReady: boolean
 *   clientSeq: number
 *   serverSeq: number
 *   pendingCallbacks: Map<seq, { resolve, reject, timer }>
 *   userState: { gid, name, level, gold, exp }
 *   heartbeatTimer: Timer | null
 *   reconnectTimer: Timer | null
 *   lastHeartbeatAt: number
 *   sendQueue: Array<{ resolve, reject, serviceName, methodName, bodyBytes }>
 *   sendQueueRunning: boolean
 * }
 */
const sessions = new Map();

// ─────────────────────── per-account 请求队列 ───────────────────────
/**
 * 同一账号的 WS 请求通过队列串行发出，多账号之间完全并行独立。
 *
 * 解决问题：天王模式高并发（40人×多个请求）短时间内打出大量 WS 请求，
 * 游戏服务器响应积压导致心跳包被挤掉，引起容器掉线。
 * 通过队列让请求一个接一个发出，每次只有 1 个请求在等待响应，
 * 保证心跳包不被业务请求挤占，彻底解决多账号天王模式下的掉线问题。
 *
 * 注意：Bot 侧的 keeperSendMsgAsync 超时需配合调大（30s），
 * 以容忍高峰期队列排队时间。
 */
async function runSendQueue(sess) {
    if (sess.sendQueueRunning) return;
    sess.sendQueueRunning = true;
    while (sess.sendQueue.length > 0) {
        const { resolve, reject, serviceName, methodName, bodyBytes } = sess.sendQueue.shift();
        try {
            const result = await sendMsg(sess, serviceName, methodName, bodyBytes);
            resolve(result);
        } catch (e) {
            reject(e);
        }
    }
    sess.sendQueueRunning = false;
}

function sendMsgQueued(sess, serviceName, methodName, bodyBytes) {
    return new Promise((resolve, reject) => {
        sess.sendQueue.push({ resolve, reject, serviceName, methodName, bodyBytes });
        runSendQueue(sess);
    });
}

// SSE 订阅者：{ res, accountId（null=全部）}
const sseSubscribers = new Set();

function getOrCreateSession(accountId) {
    if (!sessions.has(accountId)) {
        sessions.set(accountId, {
            accountId,
            code: '',
            ws: null,
            loginReady: false,
            clientSeq: 1,
            serverSeq: 0,
            pendingCallbacks: new Map(),
            userState: { gid: 0, name: '', level: 0, gold: 0, exp: 0 },
            heartbeatTimer: null,
            reconnectTimer: null,
            lastHeartbeatAt: Date.now(),
            sendQueue: [],
            sendQueueRunning: false,
        });
    }
    return sessions.get(accountId);
}

function destroySession(accountId) {
    const sess = sessions.get(accountId);
    if (!sess) return;
    if (sess.heartbeatTimer) clearInterval(sess.heartbeatTimer);
    if (sess.reconnectTimer) clearTimeout(sess.reconnectTimer);
    if (sess.ws) { try { sess.ws.removeAllListeners(); sess.ws.close(); } catch {} }
    sess.pendingCallbacks.forEach(cb => { clearTimeout(cb.timer); cb.reject(new Error('会话已销毁')); });
    sess.pendingCallbacks.clear();
    // 清空队列中待发的请求
    for (const item of sess.sendQueue) { item.reject(new Error('会话已销毁')); }
    sess.sendQueue = [];
    sess.sendQueueRunning = false;
    sessions.delete(accountId);
    console.log(`[keeper] 账号已断开: ${accountId}`);
}

// ─────────────────────── 消息收发 ───────────────────────
async function encodeMsg(sess, serviceName, methodName, bodyBytes) {
    const seq = sess.clientSeq++;
    // WASM 加密：对业务 body 进行加密后再封包
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        try {
            finalBody = await cryptoWasm.encryptBuffer(finalBody);
        } catch (e) {
            console.warn(`[keeper:${sess.accountId}] encryptBuffer 失败，使用明文:`, e.message);
        }
    }
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(seq),
            server_seq: toLong(sess.serverSeq),
        },
        body: finalBody,
    });
    return { encoded: Buffer.from(types.GateMessage.encode(msg).finish()), seq };
}

async function sendMsg(sess, serviceName, methodName, bodyBytes) {
    return new Promise(async (resolve, reject) => {
        if (!sess.ws || sess.ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('WS 未连接'));
        }
        let encoded, seq;
        try {
            ({ encoded, seq } = await encodeMsg(sess, serviceName, methodName, bodyBytes));
        } catch (e) {
            return reject(e);
        }
        const timer = setTimeout(() => {
            sess.pendingCallbacks.delete(seq);
            reject(new Error(`请求超时: ${methodName} seq=${seq}`));
        }, 15000);
        sess.pendingCallbacks.set(seq, { resolve, reject, timer });
        sess.ws.send(encoded);
    });
}

async function handleMessage(sess, data) {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > sess.serverSeq) sess.serverSeq = seq;
        }

        const msgType = meta.message_type;

        // 服务端返回的 body 是明文 protobuf，不需要解密
        const bodyBuf = Buffer.from(msg.body || []);

        // 游戏推送通知 → 广播给订阅者
        if (msgType === 3) {
            broadcastNotify(sess.accountId, msg, bodyBuf);
            return;
        }

        // 响应
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);
            const cb = sess.pendingCallbacks.get(clientSeqVal);
            if (cb) {
                clearTimeout(cb.timer);
                sess.pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    cb.reject(new Error(`${meta.service_name}.${meta.method_name} error=${errorCode} ${meta.error_message || ''}`));
                } else {
                    cb.resolve({
                        body: bodyBuf.toString('base64'),
                        meta: {
                            service_name: meta.service_name || '',
                            method_name: meta.method_name || '',
                            error_code: errorCode,
                        }
                    });
                }
            }
        }
    } catch (e) {
        console.warn(`[keeper:${sess.accountId}] 解码失败:`, e.message);
    }
}

function broadcastNotify(accountId, msg, decryptedBody) {
    if (sseSubscribers.size === 0) return;
    try {
        const bodyB64 = (decryptedBody || Buffer.from(msg.body || [])).toString('base64');
        const meta = msg.meta || {};
        const payload = JSON.stringify({
            type: 'notify',
            accountId,
            meta: {
                service_name: meta.service_name || '',
                method_name: meta.method_name || '',
            },
            body: bodyB64,
        });
        for (const sub of sseSubscribers) {
            if (sub.accountId && sub.accountId !== accountId) continue;
            try {
                sub.res.write(`data: ${payload}\n\n`);
            } catch {
                sseSubscribers.delete(sub);
            }
        }
    } catch {}
}

function broadcastWsError(accountId, code) {
    if (sseSubscribers.size === 0) return;
    const payload = JSON.stringify({ type: 'ws_error', accountId, code });
    const toClose = [];
    for (const sub of sseSubscribers) {
        if (sub.accountId && sub.accountId !== accountId) continue;
        try { sub.res.write(`data: ${payload}\n\n`); } catch {}
        toClose.push(sub);
    }
    // 400 code 失效：强制关闭该账号的 SSE 连接，触发 worker 端的 onSseDisconnect 重登录流程
    if (code === 400) {
        setTimeout(() => {
            for (const sub of toClose) {
                try { sub.res.end(); } catch {}
                sseSubscribers.delete(sub);
            }
        }, 200);
    }
}

// ─────────────────────── 登录 ───────────────────────
function sendLogin(sess) {
    const body = Buffer.from(types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: {
            client_version: CLIENT_VERSION,
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
    })).finish());

    sendMsg(sess, 'gamepb.userpb.UserService', 'Login', body)
        .then(({ body: bodyB64 }) => {
            try {
                const replyBytes = Buffer.from(bodyB64, 'base64');
                const reply = types.LoginReply.decode(replyBytes);
                if (reply.basic) {
                    const u = sess.userState;
                    u.gid = toNum(reply.basic.gid);
                    u.name = reply.basic.name || '未知';
                    u.level = toNum(reply.basic.level);
                    u.gold = toNum(reply.basic.gold);
                    u.exp = toNum(reply.basic.exp);
                    sess.loginReady = true;
                    console.log(`[keeper:${sess.accountId}] 登录成功: ${u.name} GID=${u.gid} Lv${u.level}`);
                    startHeartbeat(sess);
                }
            } catch (e) {
                console.warn(`[keeper:${sess.accountId}] 登录回包解码失败:`, e.message);
            }
        })
        .catch(e => {
            console.warn(`[keeper:${sess.accountId}] 登录失败:`, e.message);
        });
}

// ─────────────────────── 心跳 ───────────────────────
function startHeartbeat(sess) {
    if (sess.heartbeatTimer) clearInterval(sess.heartbeatTimer);
    sess.lastHeartbeatAt = Date.now();

    const doHeartbeat = () => {
        if (!sess.loginReady || !sess.userState.gid) return;
        if (!sess.ws || sess.ws.readyState !== WebSocket.OPEN) return;
        const body = Buffer.from(types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(sess.userState.gid),
            client_version: CLIENT_VERSION,
        })).finish());
        sendMsg(sess, 'gamepb.userpb.UserService', 'Heartbeat', body)
            .then(() => { sess.lastHeartbeatAt = Date.now(); })
            .catch(e => console.warn(`[keeper:${sess.accountId}] 心跳失败:`, e.message));
    };

    // 加随机抖动（0-10秒），避免多账号心跳同时触发
    const jitter = Math.floor(Math.random() * 10000);
    setTimeout(() => {
        if (!sess.loginReady) return;
        doHeartbeat();
        sess.heartbeatTimer = setInterval(doHeartbeat, 30000);
    }, jitter);
}

// ─────────────────────── 建立 WS 连接 ───────────────────────
function connectAccount(accountId, code) {
    const sess = getOrCreateSession(accountId);

    // 更新 code
    if (code) sess.code = code;
    if (!sess.code) {
        console.warn(`[keeper:${accountId}] 无 code，跳过连接`);
        return;
    }

    // 清理旧连接
    if (sess.reconnectTimer) { clearTimeout(sess.reconnectTimer); sess.reconnectTimer = null; }
    if (sess.heartbeatTimer) { clearInterval(sess.heartbeatTimer); sess.heartbeatTimer = null; }
    if (sess.ws) { sess.ws.removeAllListeners(); try { sess.ws.close(); } catch {} sess.ws = null; }
    sess.loginReady = false;
    sess.pendingCallbacks.forEach(cb => { clearTimeout(cb.timer); cb.reject(new Error('重连中')); });
    sess.pendingCallbacks.clear();
    sess.clientSeq = 1;
    sess.serverSeq = 0;

    const url = `${GAME_SERVER_URL}?platform=${PLATFORM}&os=${OS_TAG}&ver=${CLIENT_VERSION}&code=${sess.code}&openID=`;
    console.log(`[keeper:${accountId}] 连接游戏服务器... code=${sess.code.slice(0, 8)}...`);

    const wsConn = new WebSocket(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
            'Origin': 'https://gate-obt.nqf.qq.com',
        },
    });
    wsConn.binaryType = 'arraybuffer';
    sess.ws = wsConn;

    wsConn.on('open', () => {
        console.log(`[keeper:${accountId}] WS 已连接，发送登录...`);
        sendLogin(sess);
    });

    wsConn.on('message', (data) => {
        handleMessage(sess, Buffer.isBuffer(data) ? data : Buffer.from(data)).catch(e => {
            console.warn(`[keeper:${accountId}] handleMessage 异常:`, e.message);
        });
    });

    wsConn.on('close', (closeCode) => {
        console.warn(`[keeper:${accountId}] WS 关闭 (code=${closeCode})，5秒后重连...`);
        sess.loginReady = false;
        if (sess.heartbeatTimer) { clearInterval(sess.heartbeatTimer); sess.heartbeatTimer = null; }
        // 只要 code 存在就一直重连——主容器重启不影响这里
        if (sess.code) {
            sess.reconnectTimer = setTimeout(() => connectAccount(accountId, null), 5000);
        }
    });

    wsConn.on('error', (err) => {
        const msg = err && err.message ? String(err.message) : '';
        console.warn(`[keeper:${accountId}] WS 错误: ${msg}`);
        const match = msg.match(/Unexpected server response:\s*(\d+)/i);
        if (match && Number(match[1]) === 400) {
            console.warn(`[keeper:${accountId}] code 已失效（400），等待主容器提供新 code`);
            sess.code = ''; // 清掉，不再自动重连
            sess.loginReady = false;
            if (sess.reconnectTimer) { clearTimeout(sess.reconnectTimer); sess.reconnectTimer = null; }
            // 通知主容器
            broadcastWsError(accountId, 400);
        }
    });
}

// ─────────────────────── HTTP API ───────────────────────
function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch { resolve({}); }
        });
    });
}

function sendJSON(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function checkSecret(req) {
    if (!SECRET) return true;
    return req.headers['x-keeper-secret'] === SECRET;
}

const httpServer = http.createServer(async (req, res) => {
    if (!checkSecret(req)) {
        return sendJSON(res, 403, { ok: false, error: 'Forbidden' });
    }

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = urlObj.pathname;

    // ─── GET /status/all ───
    if (req.method === 'GET' && pathname === '/status/all') {
        const list = [];
        for (const [accountId, sess] of sessions) {
            list.push({
                accountId,
                connected: sess.loginReady,
                wsState: sess.ws ? sess.ws.readyState : -1,
                user: sess.loginReady ? { ...sess.userState } : null,
                codeSet: !!sess.code,
            });
        }
        return sendJSON(res, 200, { ok: true, sessions: list });
    }

    // ─── GET /status?accountId=xxx ───
    if (req.method === 'GET' && pathname === '/status') {
        const accountId = urlObj.searchParams.get('accountId') || '';
        if (!accountId) return sendJSON(res, 400, { ok: false, error: 'accountId is required' });
        const sess = sessions.get(accountId);
        if (!sess) return sendJSON(res, 200, { ok: true, connected: false, exists: false });
        return sendJSON(res, 200, {
            ok: true,
            exists: true,
            connected: sess.loginReady,
            wsState: sess.ws ? sess.ws.readyState : -1,
            user: sess.loginReady ? { ...sess.userState } : null,
            codeSet: !!sess.code,
        });
    }

    // ─── POST /connect ───
    if (req.method === 'POST' && pathname === '/connect') {
        const body = await readJsonBody(req);
        const accountId = String(body.accountId || '').trim();
        const code = String(body.code || '').trim();
        if (!accountId) return sendJSON(res, 400, { ok: false, error: 'accountId is required' });
        if (!code) return sendJSON(res, 400, { ok: false, error: 'code is required' });

        const existing = sessions.get(accountId);
        // 幂等：账号已登录且 code 未变，无需重置连接
        if (existing && existing.loginReady && existing.code === code) {
            return sendJSON(res, 200, { ok: true, message: `账号 ${accountId} 已登录，无需重连`, alreadyConnected: true });
        }
        connectAccount(accountId, code);
        return sendJSON(res, 200, { ok: true, message: `已接受 code，账号 ${accountId} 开始连接` });
    }

    // ─── POST /disconnect ───
    if (req.method === 'POST' && pathname === '/disconnect') {
        const body = await readJsonBody(req);
        const accountId = String(body.accountId || '').trim();
        if (!accountId) return sendJSON(res, 400, { ok: false, error: 'accountId is required' });
        destroySession(accountId);
        return sendJSON(res, 200, { ok: true, message: `账号 ${accountId} 已断开` });
    }

    // ─── POST /send ───
    if (req.method === 'POST' && pathname === '/send') {
        const body = await readJsonBody(req);
        const accountId = String(body.accountId || '').trim();
        const service = String(body.service || '').trim();
        const method = String(body.method || '').trim();
        const bodyBytes = body.body ? Buffer.from(body.body, 'base64') : Buffer.alloc(0);

        if (!accountId) return sendJSON(res, 400, { ok: false, error: 'accountId is required' });
        if (!service || !method) return sendJSON(res, 400, { ok: false, error: 'service/method is required' });

        const sess = sessions.get(accountId);
        if (!sess) return sendJSON(res, 404, { ok: false, error: '账号不存在，请先调用 /connect' });
        if (!sess.loginReady) return sendJSON(res, 503, { ok: false, error: '账号未登录，请稍后重试', loginReady: false });

        try {
            const queueLen = sess.sendQueue.length;
            if (queueLen > 0) {
                console.log(`[keeper:${accountId}] 队列排队 method=${method} queueLen=${queueLen}`);
            }
            const result = await sendMsgQueued(sess, service, method, bodyBytes);
            return sendJSON(res, 200, { ok: true, ...result });
        } catch (e) {
            return sendJSON(res, 500, { ok: false, error: e.message });
        }
    }

    // ─── GET /subscribe?accountId=xxx（可选，不传则订阅全部账号）───
    if (req.method === 'GET' && pathname === '/subscribe') {
        const filterAccountId = urlObj.searchParams.get('accountId') || null;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        res.write(': connected\n\n');

        const sub = { res, accountId: filterAccountId };
        sseSubscribers.add(sub);

        const keepAlive = setInterval(() => {
            try { res.write(': ping\n\n'); }
            catch { sseSubscribers.delete(sub); clearInterval(keepAlive); }
        }, 20000);

        req.on('close', () => {
            sseSubscribers.delete(sub);
            clearInterval(keepAlive);
        });
        return;
    }

    sendJSON(res, 404, { ok: false, error: 'Not Found' });
});

// ─────────────────────── 全局异常保护 ───────────────────────
process.on('uncaughtException', (err) => {
    console.error('[keeper] 未捕获异常（已忽略，进程继续运行）:', err && err.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[keeper] 未处理 Promise 拒绝（已忽略）:', reason && reason.message || reason);
});

// ─────────────────────── 心跳死亡检测：所有账号心跳超时自动重连 ───────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [accountId, sess] of sessions) {
        if (!sess.loginReady) continue;
        // 超过 90 秒没有心跳响应，主动重连
        if (now - sess.lastHeartbeatAt > 90 * 1000) {
            console.warn(`[keeper:${accountId}] 心跳超时，主动重连...`);
            connectAccount(accountId, null);
        }
    }
}, 30000);

// ─────────────────────── 启动 ───────────────────────
(async () => {
    await loadProto();

    // 预初始化 WASM 加解密模块
    try {
        await cryptoWasm.initWasm();
        console.log('[keeper] WASM 加密模块初始化成功');
    } catch (e) {
        console.error('[keeper] WASM 加密模块初始化失败:', e.message);
        process.exit(1);
    }

    httpServer.listen(PORT, () => {
        console.log(`[keeper] HTTP API 监听 :${PORT}`);
        console.log(`[keeper] 端点: GET /status/all | GET /status | POST /connect | POST /disconnect | POST /send | GET /subscribe`);
    });
})();
