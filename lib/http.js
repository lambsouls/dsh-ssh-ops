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
