// lib/tools.js —— 暴露给模型的工具。
//
// 设计取向：
//   · 只读的（server_list / server_env / server_profile）随时可以调；
//   · 有副作用的（server_exec / app_control）把动作和后果说清楚，让模型自己判断要不要先征询用户；
//   · 登记与导入（server_register / server_import）允许写入凭证，但凭证值只经参数进来、只进密文；
//   · 档案写入（server_profile_save）写的是**运维知识**，不是凭证 —— 但它会影响后续所有判断，
//     所以每条事实都要带 source，模型自己写的一律标 agent，不许冒充用户说的 owner；
//   · 每只工具返回里都带 streamId（有远程连接时），与面板控制台对得上号。

import { renderProfile, renderProfileLine, SOURCES, SEVERITIES, TRAIT_KINDS } from './profile.js';

const SERVER_ID_SCHEMA = { type: 'string', description: '服务器 ID（从 ssh_server_list 拿）。' };

const APP_ACTION = ['status', 'start', 'stop', 'restart', 'reload', 'logs'];

/** 档案里各种列表项的参数形状（三处共用：写工具声明、测试、将来做 schema 校验）。 */
const PROFILE_ITEM_SCHEMA = {
    trait: {
        type: 'object',
        description: '一条专属特征：这台机器区别于别的机器的脾气。',
        properties: {
            id: { type: 'string', description: '稳定 id；不传则按 title 生成。同 id 写入＝更新。' },
            title: { type: 'string', description: '一句话说清是什么，例如「与别人共享公网 IP」。', required: true },
            kind: { type: 'string', enum: TRAIT_KINDS, description: '类别，默认 other。' },
            severity: { type: 'string', enum: SEVERITIES, description: 'info/note/warn/critical，默认 note。' },
            detail: { type: 'string', description: '展开说明。' },
            impact: { type: 'string', description: '运维含义：这条会怎样影响操作（做错了会怎样）。' },
            evidence: { type: 'string', description: '依据：谁说的 / 哪条命令的输出 / 什么现象。' },
            source: { type: 'string', enum: SOURCES, description: 'owner=用户告知 / probe=实测 / agent=推断。默认 agent。' },
            since: { type: 'string', description: '从什么时候起是这样（可只写日期）。' },
        },
        required: ['title'],
    },
    portMap: {
        type: 'object',
        description: '一条对外端口映射：接入侧把公网端口转发到机器内部端口。',
        properties: {
            id: { type: 'string' },
            public: { type: 'number', description: '对外（公网）端口。' },
            internal: { type: 'number', description: '内部（容器/本机监听）端口。' },
            app: { type: 'string', description: '这个端口是哪个应用。' },
            proto: { type: 'string', enum: ['http', 'https', 'tcp', 'udp', 'ssh', 'other'], description: '默认 http。' },
            note: { type: 'string', description: '备注，例如「只在办公网可达」。' },
            source: { type: 'string', enum: SOURCES, description: '默认 owner（端口对应关系通常只有用户知道）。' },
        },
    },
    constraint: {
        type: 'object',
        description: '一条硬约束 / 不要碰的事。',
        properties: {
            id: { type: 'string' },
            text: { type: 'string', description: '约束本身，例如「不要 docker pull，出网拉不到镜像」。', required: true },
            severity: { type: 'string', enum: SEVERITIES, description: '默认 warn。' },
            source: { type: 'string', enum: SOURCES, description: '默认 owner。' },
        },
        required: ['text'],
    },
    runbook: {
        type: 'object',
        description: '一套常用处置步骤（出这个问题时按这个做）。',
        properties: {
            id: { type: 'string' },
            name: { type: 'string', description: '这套处置叫什么。', required: true },
            when: { type: 'string', description: '什么情况下用它。' },
            steps: { type: 'array', items: { type: 'string' }, description: '按顺序的步骤。' },
            verifiedAt: { type: 'string', description: '最近一次实际验证通过的时间。' },
            source: { type: 'string', enum: SOURCES, description: '默认 agent。' },
        },
        required: ['name'],
    },
    timeline: {
        type: 'object',
        description: '一条时间线记录：做过什么改动 / 出过什么事故 / 定过什么决定。',
        properties: {
            at: { type: 'string', description: '时间（ISO 或 YYYY-MM-DD）；不传用当前时间。' },
            kind: { type: 'string', enum: ['change', 'incident', 'note', 'decision'], description: '默认 note。' },
            text: { type: 'string', description: '发生了什么。', required: true },
        },
        required: ['text'],
    },
};

export function buildTools(ops) {
    return [
        {
            name: 'ssh_server_list',
            description:
                '列出本机托管的 Linux 服务器（地址、端口、用户、认证方式、已登记应用、可达状态、最近使用时间）。' +
                '只返回元信息，不含任何密码或密钥。要操作某台机器前先用它拿到服务器 ID。' +
                '每台机器附带档案摘要（这台机器独有的脾气，如共享 IP、端口不对应、出网受限）——动手前先看它。',
            parameters: {},
            isConcurrencySafe: true,
            async execute() {
                const servers = ops.servers();
                return {
                    count: servers.length,
                    vaultDir: ops.config.vaultDir,
                    profileDir: ops.config.profileDir,
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
                            profile: s.profile,
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
                    const prof = s.profile ? `\n    ▣ ${renderProfileLine(s.profile)}` : '\n    ▣ 无档案（这台机器的独有特征还没记；需要时用 ssh_server_profile_save 建）';
                    return `• ${s.name}（${s.id}）${s.user}@${s.host}:${s.port}｜${s.auth === 'key' ? '密钥' : '密码'}认证｜${state}${apps}${prof}`;
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
                const profile = ops.profiles.get(args.serverId);
                return {
                    ok: true,
                    server: env.server,
                    env: env.env,
                    apps: discovery?.ok ? discovery.apps : (server?.apps ?? []),
                    listeningPorts: discovery?.ok ? discovery.listeningPorts : [],
                    siteDirs: discovery?.ok ? discovery.siteDirs : [],
                    discoveryFailure: discovery && !discovery.ok ? discovery.failure : null,
                    profile: profile ? { summary: profile.summary, role: profile.role, traitCount: profile.traits.length, constraintCount: profile.constraints.length, portMapCount: profile.portMap.length, updatedAt: profile.updatedAt } : null,
                    drift: discovery?.ok ? discovery.drift : null,
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

                // 档案是知识、探测是状态：两者的差异要摆出来让人判断，不自动改档案。
                if (value.profile) {
                    lines.push('', `▣ 档案：${renderProfileLine(value.profile)}`);
                } else {
                    lines.push('', '▣ 这台机器还没有档案——它的独有特征（共享 IP？端口不对应？出网受限？）现在只能靠猜。');
                }
                if (value.drift) {
                    const bits = [];
                    for (const m of value.drift.stalePortMap ?? []) {
                        bits.push(`  ▲ 档案记 :${m.public} → 内部 :${m.internal}${m.app ? `（${m.app}）` : ''}，但这次没看到 ${m.internal} 在监听——是停了、改端口了，还是接入侧改了？`);
                    }
                    if (value.drift.missingApps?.length) {
                        bits.push(`  ▲ 档案提到的应用这次没发现：${value.drift.missingApps.join('、')}`);
                    }
                    if (bits.length) lines.push('', '档案与实测有出入（不要自动改档案，先确认是谁动过这台机器）：', ...bits);
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        {
            name: 'ssh_server_profile',
            description:
                '读某台服务器的专属档案：这台机器区别于别的机器的脾气（共享公网 IP、对外端口与内部端口不对应、' +
                '数据在网盘挂载、出网拉不到镜像、哪个服务是别人在用的……）、对外端口映射表、硬约束、' +
                '常用处置步骤、变更与事故时间线、还没确认的问题。' +
                '**动手改任何东西之前先读它**；出问题第一件事也是读它——档案记的是知识，探测得到的是状态。',
            parameters: {
                serverId: { ...SERVER_ID_SCHEMA, required: true },
            },
            isConcurrencySafe: true,
            async execute(args) {
                const { server, profile } = ops.profile(args.serverId);
                return { ok: true, server, profile, hasProfile: Boolean(profile) };
            },
            render(args, value) {
                if (!value.hasProfile) {
                    return [{
                        type: 'text',
                        text: `「${value.server.name}」还没有档案。\n` +
                            `如果这台机器有独有特征（共享 IP、端口不对应、数据在哪、什么不能碰），把它们记下来：\n` +
                            `ssh_server_profile_save 传 summary / traits / portMap / constraints —— 一次只记你确实知道的事实，` +
                            `不知道的就写进 openQuestions 问用户，不要编。`,
                    }];
                }
                return [{ type: 'text', text: renderProfile(value.profile) }];
            },
        },
        {
            name: 'ssh_server_profile_save',
            description:
                '建立或增量更新某台服务器的专属档案。**写的是运维知识，不是凭证**（密码/私钥永远走 ssh_server_register）。\n' +
                '什么时候用：用户告诉你这台机器的独有情况（「这个 IP 是共享的」「对外端口和内部对不上」）、' +
                '你实测到一条容易忘的事实、踩过一个坑之后想把处置步骤固化下来、或者做过一次改动要留痕。\n' +
                '写法要求：\n' +
                '  · 每条事实带 source —— owner=用户说的、probe=实测、agent=你自己推断的（默认）。**推断的不许标 owner**。\n' +
                '  · 只记确实知道的。不确定的写进 openQuestions 去问，不要用「大概/可能」把档案污染成噪音。\n' +
                '  · 列表项按 id 增量合并：同 id 传新值＝更新，不传 id 则按标题生成。传 removeXxxIds 才删除。\n' +
                '  · 端口映射只在**对外端口与内部端口不一致**时才需要记——一致的情况不记也不影响判断。',
            parameters: {
                serverId: { ...SERVER_ID_SCHEMA, required: true },
                summary: { type: 'string', description: '一句话说清这台机器是什么、要注意什么（清单里会显示）。' },
                role: { type: 'string', description: '角色定位，例如「音乐服务器（主要跑 navidrome）」。' },
                name: { type: 'string', description: '档案里显示的名字（缺省跟随凭证库）。' },
                traits: {
                    type: 'array',
                    description: '专属特征。',
                    items: PROFILE_ITEM_SCHEMA.trait,
                },
                portMap: {
                    type: 'array',
                    description: '对外端口 → 内部端口映射（仅在两者不对应时需要）。',
                    items: PROFILE_ITEM_SCHEMA.portMap,
                },
                constraints: {
                    type: 'array',
                    description: '硬约束 / 不要碰的事。',
                    items: PROFILE_ITEM_SCHEMA.constraint,
                },
                runbooks: {
                    type: 'array',
                    description: '常用处置步骤。',
                    items: PROFILE_ITEM_SCHEMA.runbook,
                },
                timeline: {
                    type: 'array',
                    description: '时间线记录（改动 / 事故 / 决定）。',
                    items: PROFILE_ITEM_SCHEMA.timeline,
                },
                openQuestions: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '还没确认、需要问用户的问题。写进来就等于记下「这里不能猜」。',
                },
                removeTraitIds: { type: 'array', items: { type: 'string' }, description: '要删掉的特征 id。' },
                removePortMapIds: { type: 'array', items: { type: 'string' }, description: '要删掉的端口映射 id。' },
                removeConstraintIds: { type: 'array', items: { type: 'string' }, description: '要删掉的约束 id。' },
                removeRunbookIds: { type: 'array', items: { type: 'string' }, description: '要删掉的处置 id。' },
                resolveQuestions: { type: 'array', items: { type: 'string' }, description: '已经问清楚了的待确认项（按包含匹配移除）。' },
            },
            async execute(args) {
                const { serverId, ...patch } = args;
                const result = ops.saveProfile(serverId, patch);
                return { ok: true, isNew: result.isNew, server: result.server, profile: result.profile };
            },
            render(_args, value) {
                const p = value.profile;
                const bits = [
                    p.traits.length ? `${p.traits.length} 特征` : null,
                    p.portMap.length ? `${p.portMap.length} 端口映射` : null,
                    p.constraints.length ? `${p.constraints.length} 约束` : null,
                    p.runbooks.length ? `${p.runbooks.length} 处置` : null,
                    p.timeline.length ? `${p.timeline.length} 时间线` : null,
                    p.openQuestions.length ? `${p.openQuestions.length} 待确认` : null,
                ].filter(Boolean);
                return [{
                    type: 'text',
                    text: `${value.isNew ? '✚ 已建立' : '✎ 已更新'}「${value.server.name}」的档案${bits.length ? `：${bits.join('、')}` : ''}。`,
                }];
            },
        },
        {
            name: 'ssh_server_profile_audit',
            description:
                '体检一遍所有服务器档案：哪些机器有凭证但没档案（独有特征还没记，将来必踩）、' +
                '哪些档案对应的机器已经不在凭证库（孤儿档案）、哪些档案里居然写了密码或私钥（不该出现，该清掉）。' +
                '只读，不改任何东西。',
            parameters: {},
            isConcurrencySafe: true,
            async execute() {
                const servers = ops.servers();
                const audit = ops.profiles.audit(servers);
                return { ok: true, serverCount: servers.length, profileDir: ops.config.profileDir, ...audit };
            },
            render(_args, value) {
                const lines = [`档案体检：${value.serverCount} 台服务器，档案目录 ${value.profileDir}`];
                if (!value.missingProfile.length && !value.orphanProfile.length && !value.leaks.length) {
                    lines.push('✔ 每台服务器都有档案，没有孤儿档案，也没有凭证泄漏迹象。');
                }
                if (value.missingProfile.length) {
                    lines.push('', `▲ ${value.missingProfile.length} 台还没有档案（独有特征无处可查，将来只能靠猜）：`);
                    for (const s of value.missingProfile) lines.push(`  · ${s.name}（${s.id}）`);
                }
                if (value.orphanProfile.length) {
                    lines.push('', `· ${value.orphanProfile.length} 份孤儿档案（机器已不在凭证库，档案还留着）：`);
                    for (const id of value.orphanProfile) lines.push(`  · ${id}`);
                    lines.push('  （如果这台机器只是换了 ID，把档案接过去；真删了就用 ssh_server_profile 读一遍确认后删掉文件）');
                }
                if (value.leaks.length) {
                    lines.push('', `‼ ${value.leaks.length} 份档案里疑似写了凭证（档案不该存密码/私钥）：`);
                    for (const l of value.leaks) lines.push(`  · ${l.id} ← ${l.what}`);
                }
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
