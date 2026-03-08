/**
 * 推送接口封装（基于 pushoo，另支持 email 渠道）
 */

const pushoo = require('pushoo').default;

function assertRequiredText(name, value) {
    const text = String(value || '').trim();
    if (!text) {
        throw new Error(`${name} 不能为空`);
    }
    return text;
}

/**
 * 通过 QQ 邮箱 SMTP 发送邮件推送
 * endpoint: 收件邮箱地址（可填多个，英文逗号分隔）
 * token: 格式 "发件QQ邮箱:授权码"，如 "123456@qq.com:abcdabcdabcd"
 */
async function sendEmailMessage({ endpoint, token, title, content }) {
    const nodemailer = require('nodemailer');

    const to = assertRequiredText('endpoint(收件邮箱)', endpoint);
    const tokenStr = assertRequiredText('token(发件邮箱:授权码)', token);
    const colonIdx = tokenStr.indexOf(':');
    if (colonIdx < 1) {
        throw new Error('email token 格式应为 "发件邮箱:授权码"，如 123456@qq.com:abcdabcdabcd');
    }
    const fromEmail = tokenStr.slice(0, colonIdx).trim();
    const authPass = tokenStr.slice(colonIdx + 1).trim();
    if (!fromEmail || !authPass) {
        throw new Error('email token 格式应为 "发件邮箱:授权码"');
    }

    // 自动识别 SMTP 配置：QQ邮箱 / 163 / 126 / Gmail / 自定义
    let smtpHost = 'smtp.qq.com';
    let smtpPort = 465;
    let smtpSecure = true;
    const domain = fromEmail.split('@')[1] || '';
    if (domain === '163.com') { smtpHost = 'smtp.163.com'; smtpPort = 465; smtpSecure = true; }
    else if (domain === '126.com') { smtpHost = 'smtp.126.com'; smtpPort = 465; smtpSecure = true; }
    else if (domain === 'gmail.com') { smtpHost = 'smtp.gmail.com'; smtpPort = 465; smtpSecure = true; }
    else if (domain === 'outlook.com' || domain === 'hotmail.com') { smtpHost = 'smtp-mail.outlook.com'; smtpPort = 587; smtpSecure = false; }
    // 其余默认 QQ

    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: { user: fromEmail, pass: authPass },
    });

    await transporter.sendMail({
        from: `"Bot提醒" <${fromEmail}>`,
        to,
        subject: title,
        text: content,
    });

    return { ok: true, code: 'ok', msg: 'ok', raw: null };
}

/**
 * 发送推送
 * @param {object} payload
 * @param {string} payload.channel 必填 推送渠道（pushoo 平台名 或 "email"）
 * @param {string} [payload.endpoint] webhook URL / email收件地址
 * @param {string} payload.token 必填 推送 token（email渠道格式: "发件邮箱:授权码"）
 * @param {string} payload.title 必填 推送标题
 * @param {string} payload.content 必填 推送内容
 * @returns {Promise<{ok: boolean, code: string, msg: string, raw: any}>} 推送结果
 */
async function sendPushooMessage(payload = {}) {
    const channel = assertRequiredText('channel', payload.channel);
    const endpoint = String(payload.endpoint || '').trim();
    const rawToken = String(payload.token || '').trim();
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);

    // email 渠道单独处理
    if (channel === 'email') {
        try {
            return await sendEmailMessage({ endpoint, token: rawToken, title, content });
        } catch (e) {
            return { ok: false, code: 'error', msg: e.message || 'email send failed', raw: null };
        }
    }

    const token = channel === 'webhook' ? rawToken : assertRequiredText('token', rawToken);

    const options = {};
    if (channel === 'webhook') {
        const url = assertRequiredText('endpoint', endpoint);
        options.webhook = { url, method: 'POST' };
    }

    const request = { title, content };
    if (token) request.token = token;
    if (channel === 'webhook') request.options = options;

    const result = await pushoo(channel, request);

    const raw = (result && typeof result === 'object') ? result : { data: result };
    const hasError = !!(raw && raw.error);
    const code = String(raw.code || raw.errcode || (hasError ? 'error' : 'ok'));
    const message = String(raw.msg || raw.message || (hasError ? (raw.error.message || 'push failed') : 'ok'));
    const ok = !hasError && (code === 'ok' || code === '0' || code === '' || String(raw.status || '').toLowerCase() === 'success');

    return {
        ok,
        code,
        msg: message,
        raw,
    };
}

module.exports = {
    sendPushooMessage,
};
