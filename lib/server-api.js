// lib/server-api.js —— 面板只读数据面（/api/ssh-ops/*）。
//
// 面板绝不写：所有写操作（登记、执行、启停、改档案）只走对话里的工具。
// 端点：
//   GET  /health                  插件与凭证库概况
//   GET  /servers                 服务器清单（元信息，无凭证；含档案摘要）
//   GET  /servers/:id             单台详情（含应用清单、档案、最近操作）
//   GET  /console?since=&limit=   控制台历史（脱敏后的操作日志）
//   GET  /console/stream          SSE：实时推送日志条目
//   POST /console/clear           只清面板内存视图（不动落盘历史）
//
// 安全：本机 Host/Origin 白名单 + 自定义 fence header（跨站页面带不上自定义头，
// 会被 CORS 预检挡住）。这与 d4core / xuanji 同款口径：挡浏览器跨站，不宣称挡同机进程。

import { LOCAL_HOSTS } from './http.js';
import { writeJson, fail, parsePath, parseQuery, intParam } from './http.js';

const PREFIX = '/api/ssh-ops';
const FENCE = 'x-ssh-ops';

export function registerServerApi(ctx, ops) {
    ctx.inject(['webServer'], (wctx) => {
        wctx.effect(() => wctx.webServer.register({
            kind: 'prefix',
            path: PREFIX,
            handler: async (req, res) => {
                const hostname = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
                if (!LOCAL_HOSTS.includes(hostname)) {
                    fail(res, 403, 'FORBIDDEN_HOST', `只允许本机访问（Host「${hostname}」不在白名单）`);
                    return;
                }
                const origin = req.headers.origin;
                if (origin !== undefined) {
                    try {
                        if (!LOCAL_HOSTS.includes(new URL(String(origin)).hostname)) {
                            fail(res, 403, 'FORBIDDEN_ORIGIN', 'Origin 非本机，已拒绝');
                            return;
                        }
                    } catch {
                        fail(res, 403, 'FORBIDDEN_ORIGIN', 'Origin 畸形，已拒绝');
                        return;
                    }
                }
                const segments = parsePath(req.url, PREFIX);
                const params = parseQuery(req.url);
                // SSE 走 EventSource，浏览器不允许给它设自定义头，所以那一条允许 `?fence=1`；
                // 其余端点仍必须带自定义头（跨站页面无法伪造，会触发预检被挡）。
                const isStream = segments[0] === 'console' && segments[1] === 'stream';
                const fenced = req.headers[FENCE] === '1' || (isStream && params.get('fence') === '1');
                if (!fenced) {
                    fail(res, 403, 'FORBIDDEN', `missing fence header（${FENCE}: 1）`);
                    return;
                }
                try {
                    if (await handle(req, res, segments, params, ops)) return;
                    fail(res, 404, 'NOT_FOUND', 'unknown resource');
                } catch (error) {
                    const message = String(error?.message ?? error);
                    if (error?.name === 'RangeError') fail(res, 400, 'BAD_PARAM', message);
                    else fail(res, 500, 'INTERNAL', message);
                }
            },
        }), 'dsh-ssh-ops: server-api');
    });
}

async function handle(req, res, segments, params, ops) {
    const [head, second] = segments;

    if (head === 'health') {
        const servers = ops.servers();
        const withProfile = servers.filter((s) => s.profile).length;
        writeJson(res, 200, {
            ok: true,
            value: {
                plugin: 'dsh-ssh-ops',
                vaultDir: ops.config.vaultDir,
                logDir: ops.config.logDir,
                profileDir: ops.config.profileDir,
                python: ops.python,
                serverCount: servers.length,
                appCount: servers.reduce((n, s) => n + s.apps.length, 0),
                profileCount: withProfile,
                missingProfileCount: servers.length - withProfile,
                activeStreams: ops.journal.streamCount(),
                defaultTimeoutMs: ops.config.defaultTimeoutMs,
            },
        });
        return true;
    }

    // 单台详情必须排在列表之前：列表分支是无条件 return 的，
    // 放后面会让 /servers/:id 永远走不到（曾经就是这么坏的）。
    if (head === 'servers' && second) {
        const server = ops.vault.peek(decodeURIComponent(second));
        if (!server) { fail(res, 404, 'NOT_FOUND', '没有这台服务器'); return true; }
        const recent = ops.journal.snapshot({ limit: 200 }).filter((e) => e.serverId === server.id).slice(-40);
        let profile = null;
        try { profile = ops.profiles.get(server.id); } catch { profile = null; }
        writeJson(res, 200, { ok: true, value: { server, profile, recent } });
        return true;
    }

    if (head === 'servers') {
        const servers = ops.servers();
        writeJson(res, 200, {
            ok: true,
            value: {
                count: servers.length,
                servers: servers.map((s) => {
                    const userApps = s.apps.filter((a) => a.kind !== 'system');
                    return {
                        id: s.id,
                        name: s.name,
                        host: s.host,
                        port: s.port,
                        user: s.user,
                        auth: s.auth,
                        os: s.os,
                        reachable: s.reachable,
                        reachableAt: s.reachableAt,
                        lastUsedAt: s.lastUsedAt,
                        notes: s.notes,
                        tags: s.tags,
                        apps: s.apps,
                        appCount: userApps.length,
                        systemAppCount: s.apps.length - userApps.length,
                        profile: s.profile,
                    };
                }),
            },
        });
        return true;
    }

    if (head === 'console' && second === 'stream') {
        // SSE：实时推送。浏览器断开时退订。
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        });
        const since = intParam(params, 'since') ?? 0;
        const backlog = ops.journal.snapshot({ limit: 300, sinceSeq: since });
        res.write(`event: snapshot\ndata: ${JSON.stringify(backlog)}\n\n`);
        const off = ops.journal.onEntry((entry) => {
            try { res.write(`event: entry\ndata: ${JSON.stringify(entry)}\n\n`); } catch { /* 连接已断 */ }
        });
        const keepAlive = setInterval(() => {
            try { res.write(': ping\n\n'); } catch { /* ignore */ }
        }, 15000);
        const cleanup = () => { clearInterval(keepAlive); off(); };
        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('close', cleanup);
        return true;
    }

    if (head === 'console' && second === undefined) {
        const limit = Math.min(Math.max(intParam(params, 'limit') ?? 400, 1), 2000);
        const since = intParam(params, 'since') ?? 0;
        writeJson(res, 200, { ok: true, value: { entries: ops.journal.snapshot({ limit, sinceSeq: since }) } });
        return true;
    }

    if (head === 'console' && second === 'clear' && req.method === 'POST') {
        ops.journal.clearView();
        writeJson(res, 200, { ok: true, value: { cleared: true } });
        return true;
    }

    return false;
}
