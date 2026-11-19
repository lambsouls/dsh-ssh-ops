// index.js —— dsh-ssh-ops（服务器运维台）Host 半。
//
// 装载做四件事：
//   ① 建凭证库（AES-256-GCM 加密落盘）与操作日志（控制台数据源），并把敏感值登记进脱敏器；
//   ② 注册 6 只 ssh_* 工具（清单 / 登记 / 探测 / 执行 / 应用控制 / 删除）；
//   ③ 注入一段系统提示：运维纪律（凭证不外泄、危险操作先确认、命令要可读）；
//   ④ 挂一条只读 REST 面（/api/ssh-ops/*，含 SSE），供面板显示服务器总览与实时控制台。
//
// 依赖：本插件不 import 任何 @deepseek-ai/* 包。宿主 tools.register 只要
// { name, description, parameters(原始 JSON Schema), output: { schema, render }, execute }，
// 少一个 peer 依赖就少一处「profile 里解析不到包」的崩溃面（d4core 同款做法）。
// 远端执行走本机 Python + paramiko（子进程），凭证经 stdin 传入。

import { buildTools } from './lib/tools.js';
import { createOpsService } from './lib/service.js';
import { createRedactor } from './lib/redact.js';
import { defaultVaultDir, defaultLogDir } from './lib/paths.js';
import { registerServerApi } from './lib/server-api.js';

export const name = 'dsh-ssh-ops';

/** 工具表必须；webServer 可选（缺席时只是没有面板数据面，工具照常可用）。 */
export const inject = ['tools'];

const DEFAULTS = {
    vaultDir: defaultVaultDir(),
    logDir: defaultLogDir(),
    pythonPath: null,
    defaultTimeoutMs: 120000,
    maxOutputBytes: 262144,
};

const DISCIPLINE = `【运维纪律（dsh-ssh-ops 服务器运维台）】
1. 凭证只存在于本机凭证库：不要在任何回复、日志、命令回显里写出密码、私钥、passphrase；
   需要展示时一律写 ******。工具返回里若意外出现敏感值，按已泄露处理并提示用户轮换。
2. 操作服务器前先 ssh_server_list 拿到 serverId；不确定机器上有什么时先 ssh_server_env 探测，
   不要凭空假设发行版、服务管理器或路径。
3. 你的每一条远程命令都会实时显示在用户面前的插件控制台里：命令要能读懂、一次做一件事，
   不要用一串 && 把七八步塞成一条黑箱命令。
4. 有破坏性的动作（删除数据、停机、改网络/防火墙、动数据库、升级系统、清理容器）先向用户说明
   影响并取得确认，再执行；能用只读命令查清楚的，不要上手就改。
5. 失败时按工具返回的 failure.kind 说人话（auth=认证被拒、network=网络不通、hostkey=主机密钥变更、
   timeout=超时），给出下一步可执行的排查动作，不要笼统说「连不上」。
6. 应用清单以 ssh_server_env 的发现结果为准；ssh_app_control 只对已登记的应用生效，
   找不到就先发现，不要猜服务名。`;

/** 把作者的属性表编译成宿主接受的原始 JSON Schema（等价于 defineTool 的参数编译）。 */
function toParameterSchema(properties = {}) {
    const props = {};
    const required = [];
    for (const [key, spec] of Object.entries(properties)) {
        const { required: isRequired, ...rest } = spec ?? {};
        props[key] = rest;
        if (isRequired === true) required.push(key);
    }
    const schema = { type: 'object', properties: props };
    if (required.length > 0) schema.required = required;
    return schema;
}

/** 校验一次工具调用：拒绝未声明字段，缺失必填字段直接报错。 */
function makeExecutor(tool) {
    const allowed = new Set(Object.keys(tool.parameters ?? {}));
    const required = Object.entries(tool.parameters ?? {})
        .filter(([, s]) => s?.required === true)
        .map(([k]) => k);
    const rawExecute = tool.execute;
    return async (args, exec) => {
        const given = args ?? {};
        const unknown = Object.keys(given).filter((k) => !allowed.has(k));
        if (unknown.length > 0) throw new Error(`无效参数（未知字段）：${unknown.join('、')}；可用参数：${[...allowed].join('、') || '（无）'}`);
        const missing = required.filter((k) => given[k] === undefined || given[k] === null || given[k] === '');
        if (missing.length > 0) throw new Error(`缺少必填参数：${missing.join('、')}`);
        return rawExecute(given, exec);
    };
}

function asHostDefinition(tool) {
    return {
        name: tool.name,
        description: tool.description,
        parameters: toParameterSchema(tool.parameters),
        output: {
            schema: tool.output?.schema ?? { type: 'object', additionalProperties: true },
            render: tool.render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]),
        },
        ...(tool.isConcurrencySafe ? { isConcurrencySafe: () => true } : {}),
        execute: makeExecutor(tool),
    };
}

export function apply(ctx, config = {}) {
    const resolved = { ...DEFAULTS, ...(config ?? {}) };
    const redactor = createRedactor();

    const ops = createOpsService({
        vaultDir: resolved.vaultDir,
        logDir: resolved.logDir,
        config: resolved,
        redactor,
    });

    // 启动：回放日志尾巴 + 把已有凭证的敏感值登记给脱敏器
    let known = 0;
    try { known = ops.vault.warm(); } catch (error) {
        ctx.logger?.warn?.(`[dsh-ssh-ops] 凭证库读取失败：${error?.message ?? error}`);
    }
    ops.journal.warm();

    ctx.effect(() => () => redactor.clear(), 'dsh-ssh-ops: redactor');

    for (const tool of buildTools(ops)) {
        ctx.effect(() => ctx.tools.register(asHostDefinition(tool)), `dsh-ssh-ops: tool ${tool.name}`);
    }

    // systemPrompt 是可选服务：没 inject 就不能直接读 ctx.systemPrompt（会抛错），用 ctx.get 探测。
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
    if (systemPrompt && typeof systemPrompt.section === 'function') {
        ctx.effect(() => systemPrompt.section({ name: 'dsh-ssh-ops/discipline', order: 60, text: DISCIPLINE }),
            'dsh-ssh-ops: system prompt');
    }

    registerServerApi(ctx, ops);

    ctx.logger?.info?.(`[dsh-ssh-ops] 就绪：凭证库 ${resolved.vaultDir}（${known} 台）、Python ${ops.python}`);
}

export { DISCIPLINE };
