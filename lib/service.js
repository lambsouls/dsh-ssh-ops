// lib/service.js —— 把凭证库、脱敏、日志、SSH 串成一件事：一次「服务器操作」。
//
// 所有对外能力（工具 / REST）都从这里进，保证：
//   · 每条命令都上线到控制台（附带脱敏后的输入）；
//   · 每次凭证使用都会把敏感值登记进脱敏器（同一轮输出里出现的明文也能被抹掉）；
//   · 失败分类统一（auth / network / hostkey / timeout / exec），模型能据此给主人建议。

import { createVault } from './vault.js';
import { createJournal } from './journal.js';
import { runRemote, resolvePython } from './ssh.js';
import { ENV_SCRIPT, APP_SCRIPT, parseEnv, parseApps, appCommand } from './probe.js';
import { stripAnsi } from './ansi.js';

let streamSeq = 0;
const nextStreamId = () => `s${Date.now().toString(36)}${(++streamSeq).toString(36)}`;

export function createOpsService({ vaultDir, logDir, config, redactor }) {
    const vault = createVault({ vaultDir, redactor });
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
        journal,
        python,
        config: { vaultDir, logDir, defaultTimeoutMs, maxOutputBytes },

        /** 面板/工具共用的服务器清单。 */
        servers() { return vault.list(); },

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
            return { ok: true, server: result.server, ...parsed, raw: result.stdout, streamId: result.streamId };
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
