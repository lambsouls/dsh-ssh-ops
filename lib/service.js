// lib/service.js —— 把凭证库、脱敏、日志、SSH 串成一件事：一次「服务器操作」。
//
// 所有对外能力（工具 / REST）都从这里进，保证：
//   · 每条命令都上线到控制台（附带脱敏后的输入）；
//   · 每次凭证使用都会把敏感值登记进脱敏器（同一轮输出里出现的明文也能被抹掉）；
//   · 失败分类统一（auth / network / hostkey / timeout / exec），模型能据此给用户建议。

import { createVault } from './vault.js';
import { createProfiles } from './profile.js';
import { createJournal } from './journal.js';
import { runRemote, resolvePython } from './ssh.js';
import { ENV_SCRIPT, APP_SCRIPT, parseEnv, parseApps, appCommand } from './probe.js';
import { stripAnsi } from './ansi.js';
import path from 'node:path';

let streamSeq = 0;
const nextStreamId = () => `s${Date.now().toString(36)}${(++streamSeq).toString(36)}`;

export function createOpsService({ vaultDir, logDir, profileDir, config, redactor }) {
    const vault = createVault({ vaultDir, redactor });
    // profileDir 缺省跟着 vaultDir 走：直接构造 service 的调用方（测试、脚本）不需要为了建档案多传一个参数。
    const resolvedProfileDir = profileDir ?? path.join(vaultDir, '..', 'profiles');
    const profiles = createProfiles({ profileDir: resolvedProfileDir });
    const journal = createJournal({ dir: logDir, redactor, streamIdFactory: nextStreamId });
    const python = resolvePython(config?.pythonPath);
    const defaultTimeoutMs = Number(config?.defaultTimeoutMs ?? 120000);
    const maxOutputBytes = Number(config?.maxOutputBytes ?? 262144);

    /** 执行一次远程命令；供工具与 REST 复用。 */
    async function exec({ serverId, command, timeoutMs, loginShell = true, color = true, title, input, silent = false }) {
        const server = vault.peek(serverId);
        if (!server) throw new Error(`没有这台服务器：${serverId}`);
        let secrets;
        try {
            secrets = vault.secretsFor(serverId);
        } catch (error) {
            journal.note({ kind: 'error', level: 'error', serverId, serverName: server.name, text: `✖ ${error?.message ?? error}` });
            throw error;
        }
        const effectiveTimeout = Math.min(Math.max(Number(timeoutMs ?? secrets.timeoutMs ?? defaultTimeoutMs), 1000), 3_600_000);
        const streamId = journal.openStream({
            serverId,
            serverName: server.name,
            title: title ?? `SSH ${server.user}@${server.host}:${server.port}`,
            input: silent ? (input ?? null) : (input ?? command),
        });
        journal.meta(streamId, `连接 ${server.user}@${server.host}:${server.port}（${server.auth === 'key' ? '密钥' : '密码'}认证，超时 ${Math.round(effectiveTimeout / 1000)}s）`);

        const result = await runRemote({
            python,
            vaultSecrets: secrets,
            command,
            timeoutMs: effectiveTimeout,
            loginShell,
            color,
            onEvent: (event) => {
                if (event.type === 'out') journal.output(streamId, 'out', event.text);
                else if (event.type === 'err') journal.output(streamId, 'err', event.text);
                else if (event.type === 'begin') journal.meta(streamId, `已连接：${event.user}@${event.host}:${event.port}`);
            },
        });

        journal.closeStream(streamId, { code: result.code, durationMs: result.durationMs, failure: result.failure ?? null });
        vault.markUsed(serverId);
        if (!result.failure) vault.markReachable(serverId, true);
        else if (result.failure.kind === 'network' || result.failure.kind === 'hostkey') vault.markReachable(serverId, false);

        let stdout = result.stdout;
        let stderr = result.stderr;
        let truncated = false;
        if (stdout.length > maxOutputBytes) { stdout = stdout.slice(0, maxOutputBytes); truncated = true; }
        if (stderr.length > Math.floor(maxOutputBytes / 3)) { stderr = stderr.slice(0, Math.floor(maxOutputBytes / 3)); truncated = true; }

        return {
            server: { id: server.id, name: server.name, host: server.host, port: server.port, user: server.user },
            code: result.code,
            // 给模型的是**去色**文本：模型不需要 \x1b[32m，留着既噪音又烧 token。
            stdout: redactor.text(stripAnsi(stdout)),
            stderr: redactor.text(stripAnsi(stderr)),
            durationMs: result.durationMs,
            truncated,
            streamId,
            ...(result.failure ? { failure: { ...result.failure, message: redactor.text(result.failure.message) } } : {}),
        };
    }

    const api = {
        vault,
        profiles,
        journal,
        python,
        config: { vaultDir, logDir, profileDir: resolvedProfileDir, defaultTimeoutMs, maxOutputBytes },

        /** 面板/工具共用的服务器清单。附带档案极简摘要，让「这台机器有什么脾气」一眼可见。 */
        servers() {
            const list = vault.list();
            const summaries = profiles.summaries();
            return list.map((s) => {
                const p = summaries.get(s.id);
                return {
                    ...s,
                    profile: p ? {
                        summary: p.summary,
                        role: p.role,
                        traitCount: p.traitCount,
                        constraintCount: p.constraintCount,
                        portMapCount: p.portMapCount,
                        openQuestionCount: p.openQuestionCount,
                        updatedAt: p.updatedAt,
                    } : null,
                };
            });
        },

        /** 读一份档案（没有就返回 null）。 */
        profile(serverId) {
            const server = vault.peek(serverId);
            if (!server) throw new Error(`没有这台服务器：${serverId}`);
            return { server, profile: profiles.get(serverId) };
        },

        /**
         * 只改显示名与标签（面板唯一的写入面）。
         *
         * 这一层负责「把人话变成改动」，并留痕：
         *   · 传了不认识的字段 → 报错（不静默忽略，否则用户以为改了其实没改）；
         *   · 每次改动写一条日志，面板控制台能看到「谁在什么时候把 X 改名成 Y」；
         *   · 只碰 vault 的 name/tags，**不碰档案里的 role**（角色定位是另一回事，
         *     改名不该顺手改掉「这台机器是干什么的」）。
         */
        renameServer(serverId, input = {}) {
            const server = vault.peek(serverId);
            if (!server) throw new Error(`没有这台服务器：${serverId}`);

            const allowed = new Set(['name', 'tags']);
            const unknown = Object.keys(input).filter((k) => !allowed.has(k));
            if (unknown.length > 0) {
                throw new Error(`只允许改 name / tags，拒绝了：${unknown.join('、')}`);
            }
            if (input.name === undefined && input.tags === undefined) {
                throw new Error('没有要改的字段（name / tags 至少给一个）');
            }

            const before = { name: server.name, tags: server.tags };
            const updated = vault.setIdentity(serverId, { name: input.name, tags: input.tags });

            const changes = [];
            if (before.name !== updated.name) changes.push(`名字「${before.name}」→「${updated.name}」`);
            if (JSON.stringify(before.tags) !== JSON.stringify(updated.tags)) {
                changes.push(`标签[${before.tags.join('、') || '空'}] → [${updated.tags.join('、') || '空'}]`);
            }
            if (changes.length) {
                journal.note({
                    kind: 'meta', level: 'meta', serverId: updated.id, serverName: updated.name,
                    text: `✎ 改标识：${changes.join('；')}`,
                });
            }

            return { server: updated, changed: changes.length > 0 };
        },

        /**
         * 新建或增量更新档案。
         * 关键点：`source` 缺省是 agent —— 模型自己写的东西不能冒充用户说的。
         */
        saveProfile(serverId, patch) {
            const server = vault.peek(serverId);
            if (!server) throw new Error(`没有这台服务器：${serverId}`);
            const isNew = !profiles.exists(serverId);
            const profile = profiles.patch(server, patch ?? {});
            const what = [
                patch?.summary !== undefined ? '概要' : null,
                patch?.traits !== undefined ? `${countOf(patch.traits)} 条特征` : null,
                patch?.portMap !== undefined ? `${countOf(patch.portMap)} 条端口映射` : null,
                patch?.constraints !== undefined ? `${countOf(patch.constraints)} 条约束` : null,
                patch?.runbooks !== undefined ? `${countOf(patch.runbooks)} 条处置` : null,
                patch?.timeline !== undefined ? `${countOf(patch.timeline)} 条时间线` : null,
                patch?.openQuestions !== undefined ? `${countOf(patch.openQuestions)} 个待确认` : null,
            ].filter(Boolean);
            journal.note({
                kind: 'meta', level: 'meta', serverId: server.id, serverName: server.name,
                text: `${isNew ? '✚ 新建' : '✎ 更新'}档案${what.length ? `：${what.join('、')}` : ''}`,
            });
            return { server, profile, isNew };
        },

        exec,

        /** 连通性 + 环境画像（连一次拿全）。 */
        async probe(serverId) {
            const server = vault.peek(serverId);
            if (!server) throw new Error(`没有这台服务器：${serverId}`);
            const result = await exec({
                serverId,
                command: ENV_SCRIPT,
                timeoutMs: Math.min(defaultTimeoutMs, 60000),
                title: `环境探测 ${server.name}`,
                input: '(环境探测脚本：OS / 内核 / 资源 / 服务管理器)',
                silent: true,
            });
            if (result.failure) return { ok: false, server: result.server, failure: result.failure, streamId: result.streamId };
            const env = parseEnv(result.stdout);
            vault.markReachable(serverId, true, env.os ?? undefined);
            return { ok: true, server: result.server, env, raw: result.stdout, durationMs: result.durationMs, streamId: result.streamId };
        },

        /** 应用发现；write=true 时把结果合并进凭证库。 */
        async discoverApps(serverId, { write = true } = {}) {
            const server = vault.peek(serverId);
            if (!server) throw new Error(`没有这台服务器：${serverId}`);
            const result = await exec({
                serverId,
                command: APP_SCRIPT,
                timeoutMs: Math.min(defaultTimeoutMs, 90000),
                title: `应用发现 ${server.name}`,
                input: '(应用发现脚本：systemd / docker / compose / 监听端口)',
                silent: true,
            });
            if (result.failure) return { ok: false, server: result.server, failure: result.failure, streamId: result.streamId };
            const parsed = parseApps(result.stdout);
            if (write) {
                vault.replaceDiscoveredApps(serverId, parsed.apps.map((a) => ({
                    name: a.name, kind: a.kind, port: a.port, manager: a.manager, service: a.service, notes: a.notes,
                })));
            }
            // 档案里的「待确认」提示：发现到的东西和档案记的对不上时不要自动改档案——
            // 档案是知识、发现是状态，两者冲突要人来判断（可能是别人动过这台机器）。
            const drift = profiles.exists(serverId) ? profileDrift(profiles.get(serverId), parsed) : null;
            return { ok: true, server: result.server, ...parsed, raw: result.stdout, streamId: result.streamId, drift };
        },

        /** 对某台机器上的某个应用做 status/start/stop/restart/reload/logs。 */
        async appAction(serverId, { app: appName, action, lines = 120, composeDir }) {
            const server = vault.peek(serverId);
            if (!server) throw new Error(`没有这台服务器：${serverId}`);
            const app = (server.apps ?? []).find((a) => a.name === appName || a.service === appName);
            if (!app) {
                const known = (server.apps ?? []).map((a) => a.name).join('、') || '（这台机器还没做过应用发现）';
                throw new Error(`「${server.name}」上没有登记应用「${appName}」。已知：${known}`);
            }
            const command = appCommand(app, action, { lines, composeDir });
            return exec({
                serverId,
                command,
                timeoutMs: Math.min(defaultTimeoutMs, 120000),
                title: `${app.name} · ${action}`,
                input: command,
            });
        },
    };
    return api;
}

/** patch 里给的那一项可能是对象也可能是数组，统一数个数。 */
function countOf(value) {
    if (Array.isArray(value)) return value.length;
    return value === undefined || value === null || value === '' ? 0 : 1;
}

/**
 * 档案 vs 实测的漂移检查。
 *
 * 只查「档案说 H 端口映射到内部 I，但现在 H 上的容器都变了」这类**可机械判定**的事，
 * 不做任何推断式改写。返回的每条都是「需要人确认」的线索，不是结论：
 * 机器可能被别人动过，也可能是我们记错了——这两种处理方式完全相反。
 */
function profileDrift(profile, parsed) {
    if (!profile) return null;
    const listening = new Set(parsed.listeningPorts ?? []);
    const staleInternal = (profile.portMap ?? [])
        .filter((m) => m.internal && !listening.has(m.internal))
        .map((m) => ({ public: m.public, internal: m.internal, app: m.app }));

    // 档案里说这台机器上应该有某个应用，但这次没发现（可能容器停了、也可能被删了）
    const discovered = new Set((parsed.apps ?? []).map((a) => a.name));
    const notedApps = (profile.traits ?? [])
        .map((t) => /(?:应用|服务|容器)[「:：]?\s*([A-Za-z0-9._-]{2,40})/.exec(t.detail ?? ''))
        .filter(Boolean)
        .map((m) => m[1]);
    const missingApps = [...new Set(notedApps)].filter((n) => !discovered.has(n));

    const out = {};
    if (staleInternal.length) out.stalePortMap = staleInternal;
    if (missingApps.length) out.missingApps = missingApps;
    return Object.keys(out).length ? out : null;
}
