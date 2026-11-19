// lib/http.js —— REST 面的共享 HTTP 基元。

export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export const writeJson = (res, status, value) => {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
};

export const fail = (res, status, code, message) => {
    writeJson(res, status, { ok: false, error: { code, message: String(message ?? '') } });
};

export const parsePath = (url, prefix) => {
    const pathname = new URL(url ?? '/', 'http://localhost').pathname;
    return pathname.slice(prefix.length).split('/').filter(Boolean);
};

export const parseQuery = (url) => new URL(url ?? '/', 'http://localhost').searchParams;

export const intParam = (params, key) => {
    const raw = params.get(key);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
};

/**
 * 读一个 JSON 请求体。
 *
 * 三道限制都是必须的，不是「防御性编程」的客套：
 *   ① **大小上限**：面板只发一个名字和几个标签，正常情况下不到 1 KB。
 *      不设上限就等于给本机任何进程一个「往我内存里灌数据」的入口。
 *   ② **超时**：半开连接的请求会永久占着 handler。
 *   ③ **只接受 application/json**：挡掉表单跨站提交（配合 Origin 校验是两道独立的墙）。
 *
 * 解析失败抛错，由调用方转成 400 —— 不要在这里写响应，保持纯函数。
 */
export function readJsonBody(req, { limitBytes = 8 * 1024, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const type = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!type.includes('application/json')) {
            reject(new Error('content-type 必须是 application/json'));
            return;
        }
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('读取请求体超时')), timeoutMs);

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limitBytes) {
                finish(new Error(`请求体过大（上限 ${limitBytes} 字节）`));
                try { req.destroy(); } catch { /* 已断开 */ }
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (done) return;
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text.trim()) { finish(null, {}); return; }
            try { finish(null, JSON.parse(text)); }
            catch { finish(new Error('请求体不是合法 JSON')); }
        });
        req.on('error', (error) => finish(error));
    });
}

