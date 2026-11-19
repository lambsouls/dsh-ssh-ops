// lib/server-api.js —— 面板数据面（/api/ssh-ops/*）。
//
// ⚠️ 这里**只有一个写端点**：`PATCH /servers/:id`，而且它只能改「显示名」与「标签」。
//    除它之外的写操作（登记凭证、执行命令、启停服务、改档案）**全部只走对话里的工具**。
//
// 为什么这一个可以开：改名/改标签**不碰服务器**，改的是本机凭证库里的两个给人看的字段
// （见 vault.setIdentity 的三条硬约束）。而「面板一能写，它就成了带 root 权限的 Web 控制台」——
// 那句话针对的是能触发远程操作的面板，不是改个名字。这条边界要守住：
// **凡是会影响服务器状态的东西，一律不许进这个 REST 面。**
//
// 端点：
//   GET   /health                  插件与凭证库概况
//   GET   /servers                 服务器清单（元信息，无凭证；含档案摘要）
//   GET   /servers/:id             单台详情（含应用清单、档案、最近操作）
//   GET   /servers/:id/profile     档案的**独立 HTML 页面**（新标签页打开用）
//   PATCH /servers/:id             ★ 唯一的写端点：改显示名 / 标签
//   GET   /console?since=&limit=   控制台历史（脱敏后的操作日志）
//   GET   /console/stream          SSE：实时推送日志条目
//   POST  /console/clear           只清面板内存视图（不动落盘历史）
//
// 安全：本机 Host/Origin 白名单 + 自定义 fence header（跨站页面带不上自定义头，
// 会被 CORS 预检挡住）。这与 d4core / xuanji 同款口径：挡浏览器跨站，不宣称挡同机进程。

import { LOCAL_HOSTS } from './http.js';
import { writeJson, fail, parsePath, parseQuery, intParam, readJsonBody } from './http.js';
import { renderProfilePage } from './profile-html.js';

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
                // SSE 走 EventSource、档案页走浏览器**直接导航**（window.open），
                // 这两种情况下浏览器都不允许我们设自定义头，所以允许 `?fence=1` 兜底。
                // 其余端点仍必须带自定义头 —— 跨站页面无法伪造自定义头，会触发 CORS 预检被挡。
                // 为什么 `?fence=1` 在这里仍然安全：这些端点**没有副作用**（只读 + 只返回 GET），
                // 且照旧受 Host/Origin 白名单保护；写端点（PATCH）绝不能用查询参数放行。
                const isStream = segments[0] === 'console' && segments[1] === 'stream';
                const isProfilePage = segments[0] === 'servers' && segments[2] === 'profile';
                const fenced = req.headers[FENCE] === '1'
                    || ((isStream || isProfilePage) && params.get('fence') === '1');
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
    const [head, second, third] = segments;

    // ── 档案的独立页面 ──
    // 必须排在 `/servers/:id` 之前：那个分支是无条件 return 的，放后面就永远走不到。
    // 档案是给 DSH 自己看的知识，对用户多数时候不需要 —— 所以面板里只给一个
    // 「档案 ↗」按钮，点开就是这个页面，不往服务器行里铺。
    if (head === 'servers' && second && third === 'profile') {
        if (req.method !== 'GET') {
            res.setHeader?.('allow', 'GET');
            fail(res, 405, 'METHOD_NOT_ALLOWED', `档案页面只支持 GET，收到 ${req.method}`);
            return true;
        }
        const server = ops.vault.peek(decodeURIComponent(second));
        if (!server) { fail(res, 404, 'NOT_FOUND', '没有这台服务器'); return true; }
        let profile = null;
        try { profile = ops.profiles.get(server.id); } catch { profile = null; }
        const html = renderProfilePage(server, profile);
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            // 页面是自包含的（无外链），但这几个头仍然值得给：
            // 它是把本机档案摊开成一个网页，不该被嵌进别人的 frame，也不该带 referrer。
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        });
        res.end(html);
        return true;
    }

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
        const serverId = decodeURIComponent(second);

        // ★ 唯一的写端点。改动范围在 service.renameServer 里被钉死为 name/tags。
        if (req.method === 'PATCH') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (error) {
                fail(res, 400, 'BAD_BODY', error?.message ?? error);
                return true;
            }
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                fail(res, 400, 'BAD_BODY', '请求体必须是 JSON 对象');
                return true;
            }
            let result;
            try {
                result = ops.renameServer(serverId, body);
            } catch (error) {
                const message = String(error?.message ?? error);
                // 「不存在」和「参数不对」要分开报，面板才能给出不同提示
                if (message.includes('没有这台服务器')) fail(res, 404, 'NOT_FOUND', message);
                else fail(res, 400, 'BAD_REQUEST', message);
                return true;
            }
            writeJson(res, 200, { ok: true, value: { server: result.server, changed: result.changed } });
            return true;
        }

        if (req.method !== 'GET') {
            // 明确拒绝其它动词：不写「405 但没有 Allow」这种半吊子响应。
            res.setHeader?.('allow', 'GET, PATCH');
            fail(res, 405, 'METHOD_NOT_ALLOWED', `该资源只支持 GET / PATCH，收到 ${req.method}`);
            return true;
        }

        const server = ops.vault.peek(serverId);
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
