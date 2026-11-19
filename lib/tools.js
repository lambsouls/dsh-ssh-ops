// lib/tools.js —— 暴露给模型的 6 只工具。
//
// 设计取向：
//   · 只读的（server_list / server_env）随时可以调；
//   · 有副作用的（server_exec / app_control）把动作和后果说清楚，让模型自己判断要不要先征询用户；
//   · 登记与导入（server_register / server_import）允许写入凭证，但凭证值只经参数进来、只进密文；
//   · 每只工具返回里都带 streamId，与面板控制台对得上号。

const SERVER_ID_SCHEMA = { type: 'string', description: '服务器 ID（从 ssh_server_list 拿）。' };

const APP_ACTION = ['status', 'start', 'stop', 'restart', 'reload', 'logs'];

export function buildTools(ops) {
    return [
        {
            name: 'ssh_server_list',
            description:
                '列出本机托管的 Linux 服务器（地址、端口、用户、认证方式、已登记应用、可达状态、最近使用时间）。' +
                '只返回元信息，不含任何密码或密钥。要操作某台机器前先用它拿到服务器 ID。',
            parameters: {},
            isConcurrencySafe: true,
            async execute() {
                const servers = ops.servers();
                return {
                    count: servers.length,
                    vaultDir: ops.config.vaultDir,
                    servers: servers.map((s) => {
                        const userApps = s.apps.filter((a) => a.kind !== 'system');
                        const systemApps = s.apps.filter((a) => a.kind === 'system');
                        return {
                            id: s.id,
                            name: s.name,
                            host: s.host,
                            port: s.port,
                            user: s.user,
                            auth: s.auth,
                            reachable: s.reachable,
                            reachableAt: s.reachableAt,
                            os: s.os,
                            apps: userApps.map((a) => a.name),
                            appCount: userApps.length,
                            systemAppCount: systemApps.length,
                            systemApps: systemApps.map((a) => a.name),
                            lastUsedAt: s.lastUsedAt,
                            notes: s.notes,
                        };
                    }),
                };
            },
            render(_args, value) {
                if (value.count === 0) return [{ type: 'text', text: '还没有登记任何服务器。用 ssh_server_register 加一台。' }];
                const lines = value.servers.map((s) => {
                    const state = s.reachable === true ? '可达' : s.reachable === false ? '不可达' : '未探测';
                    const userApps = (s.userApps ?? s.apps ?? []);
                    const sysCount = s.systemAppCount ?? 0;
                    const apps = userApps.length
                        ? `｜应用 ${userApps.slice(0, 12).join('、')}${userApps.length > 12 ? ` 等 ${userApps.length} 个` : ''}${sysCount ? `（另 ${sysCount} 个系统服务）` : ''}`
                        : (sysCount ? `｜仅系统服务 ${sysCount} 个` : '｜应用未发现');
                    return `• ${s.name}（${s.id}）${s.user}@${s.host}:${s.port}｜${s.auth === 'key' ? '密钥' : '密码'}认证｜${state}${apps}`;
                });
                return [{ type: 'text', text: `共 ${value.count} 台服务器：\n${lines.join('\n')}` }];
            },
        },
        {
            name: 'ssh_server_register',
            description:
                '登记或更新一台服务器的有效凭证（地址、端口、用户名、密码或私钥、备注、已装应用清单）。' +
                '密码/私钥会以 AES-256-GCM 加密写入本机凭证库，不会回显、不会进日志。' +
                '更新已有服务器时，不传 password/privateKey 就保留原凭证（只改元信息）。',
            parameters: {
                id: { type: 'string', description: '要更新的服务器 ID；不传则按 host+port 匹配或新建。' },
                name: { type: 'string', description: '便于识别的名字，例如「香港 OpenList」。缺省用 host。' },
                host: { type: 'string', description: 'IP 或域名。', required: true },
                port: { type: 'number', description: 'SSH 端口，默认 22。' },
                user: { type: 'string', description: 'SSH 用户名。', required: true },
                authType: { type: 'string', enum: ['password', 'key'], description: '认证方式，默认 password。' },
                password: { type: 'string', description: '密码（authType=password 时）。' },
                privateKey: { type: 'string', description: '私钥全文（authType=key 时，PEM/OpenSSH 格式）。' },
                passphrase: { type: 'string', description: '私钥口令（如果私钥加密）。' },
                keyPath: { type: 'string', description: '本机私钥文件路径（authType=key 且不想传全文时用）。' },
                hostKeyPolicy: { type: 'string', enum: ['accept-new', 'strict', 'off'], description: '主机密钥策略，默认 accept-new（未知主机接受并记住，已知主机校验）。' },
                os: { type: 'string', description: '已知的操作系统描述，例如 Ubuntu 22.04。' },
                notes: { type: 'string', description: '备注：用途、归属、注意事项。' },
                tags: { type: 'array', items: { type: 'string' }, description: '标签，例如 ["生产","国内"]。' },
                apps: {
                    type: 'array',
                    description: '已装应用清单（可以先手工填，也可以之后让 ssh_server_env 自动发现）。',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            kind: { type: 'string' },
                            port: { type: 'number' },
                            manager: { type: 'string', enum: ['systemd', 'docker', 'docker-compose', 'generic'] },
                            service: { type: 'string' },
                            notes: { type: 'string' },
                        },
                        required: ['name'],
                    },
                },
            },
            async execute(args) {
                const view = ops.vault.upsert({
                    id: args.id,
                    name: args.name,
                    host: args.host,
                    port: args.port,
                    user: args.user,
                    authType: args.authType,
                    hostKeyPolicy: args.hostKeyPolicy,
                    keyPath: args.keyPath,
                    os: args.os,
                    notes: args.notes,
                    tags: args.tags,
                    apps: args.apps,
                    secrets: {
                        password: args.password,
                        privateKey: args.privateKey,
                        passphrase: args.passphrase,
                    },
                });
                ops.journal.note({
                    kind: 'meta', level: 'meta', serverId: view.id, serverName: view.name,
                    text: `✚ 凭证已保存：${view.user}@${view.host}:${view.port}（${view.auth === 'key' ? '密钥' : '密码'}认证）`,
                });
                return { ok: true, server: view };
            },
            render(_args, value) {
                const s = value.server;
                return [{ type: 'text', text: `已保存「${s.name}」（${s.id}）：${s.user}@${s.host}:${s.port}，${s.auth === 'key' ? '密钥' : '密码'}已加密入库。应用登记 ${s.apps.length} 个。` }];
            },
        },
        {
            name: 'ssh_server_env',
            description:
                '连一次服务器，拿回环境画像（发行版、内核、运行时长、CPU、内存、磁盘、服务管理器、docker 版本），' +
                '并可选做应用发现（systemd 运行中的服务 / docker 容器 / compose 项目 / 监听端口），把结果合并进凭证库。' +
                '这是「这台机器上有什么、能管什么」的权威来源。',
            parameters: {
                serverId: { ...SERVER_ID_SCHEMA, required: true },
                discoverApps: { type: 'boolean', description: '是否同时做应用发现并回写（默认 true）。' },
            },
            isConcurrencySafe: true,
            async execute(args) {
                const env = await ops.probe(args.serverId);
                if (!env.ok) return { ok: false, server: env.server, failure: env.failure, hint: failureHint(env.failure) };
                let discovery = null;
                if (args.discoverApps !== false) {
                    discovery = await ops.discoverApps(args.serverId, { write: true });
                }
                const server = ops.vault.peek(args.serverId);
                return {
                    ok: true,
                    server: env.server,
                    env: env.env,
                    apps: discovery?.ok ? discovery.apps : (server?.apps ?? []),
                    listeningPorts: discovery?.ok ? discovery.listeningPorts : [],
                    siteDirs: discovery?.ok ? discovery.siteDirs : [],
                    discoveryFailure: discovery && !discovery.ok ? discovery.failure : null,
                };
            },
            render(_args, value) {
                if (!value.ok) return [{ type: 'text', text: `探测失败：${value.failure.kind} — ${value.failure.message}\n${value.hint ?? ''}`.trim() }];
                const e = value.env;
                const parts = [
                    `✔ ${value.server.name} 可达`,
                    e.os ? `系统：${e.os}` : null,
                    e.kernel ? `内核：${e.kernel}` : null,
                    e.cpus ? `CPU：${e.cpus} 核` : null,
                    e.memoryMb ? `内存：已用 ${e.memoryMb.used}/${e.memoryMb.total} MB` : null,
                    e.disk ? `根盘：${e.disk.used}/${e.disk.total}（${e.disk.usePercent}）` : null,
                    e.init ? `服务管理器：${e.init}` : null,
                    e.docker ? e.docker : null,
                ].filter(Boolean);
                const all = value.apps ?? [];
                const userApps = all.filter((a) => a.kind !== 'system');
                const systemApps = all.filter((a) => a.kind === 'system');
                const fmt = (a) => `  · ${a.name}（${a.manager ?? 'generic'}${a.port ? `，端口 ${a.port}` : ''}）`;
                const lines = [`${parts.join('\n')}`, `发现应用 ${all.length} 个（系统自带服务 ${systemApps.length} 个）：`];
                if (userApps.length) lines.push(userApps.map(fmt).join('\n'));
                else lines.push('  （没有识别出额外的用户应用）');
                if (systemApps.length) lines.push(`  系统自带：${systemApps.map((a) => a.name).join('、')}`);
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        {
            name: 'ssh_server_exec',
            description:
                '在一台已登记的服务器上执行一条 shell 命令（经 bash -lc），返回 stdout / stderr / 退出码。' +
                '这条命令会实时出现在插件面板的「控制台」里（凭证显示为 ******），所以要把它当成用户看得见的操作来写。' +
                '适合：查状态、看日志、启停服务、改配置、装包。危险操作（删数据、关机、改网络）先跟用户确认。',
            parameters: {
                serverId: { ...SERVER_ID_SCHEMA, required: true },
                command: { type: 'string', description: '远程命令（bash -lc 执行）。多行用 && 或换行拼接。', required: true },
                timeoutMs: { type: 'number', description: '超时毫秒，默认 120000，上限 3600000。' },
                loginShell: { type: 'boolean', description: '是否包一层 bash -lc（默认 true，会加载登录环境的 PATH）。' },
            },
            async execute(args) {
                const result = await ops.exec({
                    serverId: args.serverId,
                    command: args.command,
                    timeoutMs: args.timeoutMs,
                    loginShell: args.loginShell !== false,
                });
                return {
                    ok: !result.failure && result.code === 0,
                    ...result,
                    ...(result.failure ? { hint: failureHint(result.failure) } : {}),
                };
            },
            render(_args, value) {
                const head = value.failure
                    ? `✖ ${value.server.name}：${value.failure.kind} — ${value.failure.message}`
                    : `▸ ${value.server.name} · 退出码 ${value.code} · ${(value.durationMs / 1000).toFixed(1)}s`;
                const body = [value.stdout?.trim(), value.stderr?.trim()].filter(Boolean).join('\n--- stderr ---\n');
                return [{ type: 'text', text: `${head}\n${body || '（无输出）'}${value.truncated ? '\n…（已截断）' : ''}` }];
            },
        },
        {
            name: 'ssh_app_control',
            description:
                '对某台服务器上已发现/已登记的应用做运维动作：status / start / stop / restart / reload / logs。' +
                '自动按该应用的 manager（systemd / docker / docker-compose）选对命令。' +
                '先用 ssh_server_env 让应用被发现，再调这里。',
            parameters: {
                serverId: { ...SERVER_ID_SCHEMA, required: true },
                app: { type: 'string', description: '应用名（systemd 单元名 / 容器名 / compose 项目名）。', required: true },
                action: { type: 'string', enum: APP_ACTION, description: '动作。', required: true },
                lines: { type: 'number', description: 'logs 时取最后多少行，默认 120。' },
                composeDir: { type: 'string', description: 'docker-compose 项目的目录（该 manager 必填）。' },
            },
            async execute(args) {
                const result = await ops.appAction(args.serverId, {
                    app: args.app, action: args.action, lines: args.lines, composeDir: args.composeDir,
                });
                return { ok: !result.failure && result.code === 0, ...result, ...(result.failure ? { hint: failureHint(result.failure) } : {}) };
            },
            render(_args, value) {
                const head = value.failure
                    ? `✖ ${value.server.name}：${value.failure.kind} — ${value.failure.message}`
                    : `▸ ${value.server.name} · 退出码 ${value.code}`;
                const body = [value.stdout?.trim(), value.stderr?.trim()].filter(Boolean).join('\n--- stderr ---\n');
                return [{ type: 'text', text: `${head}\n${body || '（无输出）'}` }];
            },
        },
        {
            name: 'ssh_server_forget',
            description: '从凭证库删除一台服务器（连同它的密码/私钥密文与临时密钥文件）。不可撤销。',
            parameters: {
                serverId: { ...SERVER_ID_SCHEMA, required: true },
                confirm: { type: 'boolean', description: '必须显式传 true 才会删除。', required: true },
            },
            async execute(args) {
                if (args.confirm !== true) throw new Error('需要 confirm=true 才会删除服务器凭证');
                const before = ops.vault.peek(args.serverId);
                const removed = ops.vault.remove(args.serverId);
                if (removed && before) {
                    ops.journal.note({ kind: 'meta', level: 'warn', serverId: null, serverName: null, text: `✖ 已删除服务器凭证：${before.name}（${before.user}@${before.host}:${before.port}）` });
                }
                return { ok: removed, removed: before ? { id: before.id, name: before.name, host: before.host } : null };
            },
            render(_args, value) {
                return [{ type: 'text', text: value.ok ? `已删除「${value.removed.name}」的凭证。` : '没有找到这台服务器。' }];
            },
        },
    ];
}

function failureHint(failure) {
    switch (failure?.kind) {
        case 'auth': return '提示：认证被拒。先确认用户名/密码或私钥是否最新，再确认服务器是否禁用了密码登录（PasswordAuthentication no）。';
        case 'network': return '提示：网络不通。确认地址、SSH 端口、安全组/防火墙，以及是否需要跳板或代理。';
        case 'hostkey': return '提示：主机密钥变了（可能重装系统）。确认是用户自己重装后，用 hostKeyPolicy=accept-new 重新登记该机。';
        case 'timeout': return '提示：命令超时。缩短命令、加 timeout、或在命令里改成分段/后台执行。';
        case 'env': return '提示：本机缺少 paramiko 或 Python 不可用，需要修运行时环境。';
        default: return '';
    }
}

export { failureHint };
