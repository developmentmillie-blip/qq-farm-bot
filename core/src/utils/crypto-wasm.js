const fs = require('fs');
const path = require('path');

let memory = null;
let encryptRaw = null;
let decryptRaw = null;
let generateTokenRaw = null;
let createBufRaw = null;
let destroyBufRaw = null;
let encoder = new TextEncoder();
let decoder = new TextDecoder();

let initPromise = null;

function initWasm() {
    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        try {
            const wasmPath = path.join(__dirname, 'tsdk.wasm');
            const wasmBuffer = fs.readFileSync(wasmPath);
            const importObject = {
                a: {
                    a: () => {}, b: () => {}, c: () => {}, d: () => {}, e: () => {},
                    f: () => {}, g: () => {}, h: () => {}, i: () => {}, j: () => {},
                    k: () => {}, l: () => {}, m: () => {}, n: () => {}, o: () => {},
                    p: () => {}, q: () => {}, r: () => {}, s: () => {}, t: () => {},
                    u: () => {}
                }
            };

            WebAssembly.instantiate(wasmBuffer, importObject)
                .then(({ instance }) => {
                    const exports = instance.exports;
                    try { exports.E(); } catch (e) { } // init_runtime
                    memory = exports.v;
                    generateTokenRaw = exports._;
                    encryptRaw = exports.J;    // in-place 加密
                    decryptRaw = exports.K;    // in-place 解密
                    createBufRaw = exports.z;  // 分配缓冲区
                    destroyBufRaw = exports.A; // 释放缓冲区
                    resolve();
                })
                .catch(reject);
        } catch (e) {
            reject(e);
        }
    });

    return initPromise;
}

// 生成签名 token（备用）
async function generateToken(str) {
    if (!memory) await initWasm();

    const data = encoder.encode(str);
    const ptr = createBufRaw ? createBufRaw(data.length + 1) : 1024;
    const memView = new Uint8Array(memory.buffer);
    memView.set(data, ptr);
    memView[ptr + data.length] = 0;

    const resPtr = generateTokenRaw(ptr, data.length);
    let end = resPtr;
    while (memView[end] !== 0 && end - resPtr < 1000) end++;

    const outputBytes = memView.slice(resPtr, end);
    if (createBufRaw) destroyBufRaw(ptr);
    return decoder.decode(outputBytes);
}

// 核心协议二进制负载加密（原地）
async function encryptBuffer(buffer) {
    if (!memory) await initWasm();

    const ptr = createBufRaw(buffer.length);
    const memView = new Uint8Array(memory.buffer);
    memView.set(buffer, ptr);

    encryptRaw(ptr, buffer.length); // in-place
    const result = Buffer.from(Buffer.from(memory.buffer, ptr, buffer.length));
    destroyBufRaw(ptr);
    return result;
}

// 核心协议二进制负载解密（原地）
async function decryptBuffer(buffer) {
    if (!memory) await initWasm();

    const ptr = createBufRaw(buffer.length);
    const memView = new Uint8Array(memory.buffer);
    memView.set(buffer, ptr);

    decryptRaw(ptr, buffer.length); // in-place
    const result = Buffer.from(Buffer.from(memory.buffer, ptr, buffer.length));
    destroyBufRaw(ptr);
    return result;
}

module.exports = {
    initWasm,
    generateToken,
    encryptBuffer,
    decryptBuffer,
    encryptData: generateToken,
};
