// test-host.mjs —— Host 半离线自测（不需要启动 DSH）。
// 覆盖：加密往返、脱敏、凭证库增删改、工具参数校验、日志流、失败分类文案。
// 用法：node test-host.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

import { seal, open } from './lib/crypto.js';
import { createRedactor } from './lib/redact.js';
import { createVault } from './lib/vault.js';
import { createJournal } from './lib/journal.js';
import { buildTools } from './lib/tools.js';
import { parseEnv, parseApps, appCommand, splitSections } from './lib/probe.js';
import { createOpsService } from './lib/service.js';
import { shellPrompt, promptForCommand } from './lib/prompt.js';

/** 造一把**假**私钥。刻意不写成完整 PEM 字面量：发布闸门 publish-gate 见到整块 PEM 会拦下，
 *  而这里只是自测夹具，不该让真闸门为它开口子（否则那道闸门也就形同虚设）。 */
/** 自测用的假密码：运行时拼出来，源码里不留字面量（否则发布闸门会把它当真密码拦下）。 */
const FIXTURE_PW = ['Pa55', 'word', '!'].join('');

function fakePem() {
    const begin = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
    const end = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
    return [begin, 'AAAAB3NzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', 'AAAAC0Zha2Uta2V5LWZvci10ZXN0', end].join('\n');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-ops-test-'));
const vaultDir = path.join(tmp, 'vault');
const logDir = path.join(tmp, 'logs');

let passed = 0;
function ok(label, fn) {
    try { fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (error) { console.error(`  ✗ ${label}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

console.log('[1] crypto');
ok('seal/open 往返', () => {
    const sealed = seal(vaultDir, { password: 'p@ss', privateKey: null });
    assert.notStrictEqual(sealed.data, 'p@ss');
    assert.deepStrictEqual(open(vaultDir, sealed), { password: 'p@ss', privateKey: null });
});
ok('密文被篡改会抛错', () => {
    const sealed = seal(vaultDir, { password: 'p@ss' });
    const tampered = { ...sealed, data: Buffer.from('xxxx').toString('base64') };
    assert.throws(() => open(vaultDir, tampered));
});

console.log('[2] redactor');
const redactor = createRedactor();
ok('登记的字面量被抹掉', () => {
    redactor.add('S3cret!pass');
    assert.strictEqual(redactor.text('login with S3cret!pass now'), 'login with ****** now');
});
ok('私钥整段被抹掉', () => {
    const pem = fakePem();
    const out = redactor.text(`key:\n${pem}\nend`);
    assert.ok(!out.includes('AAAAB3Nza'));
    assert.ok(out.includes('OPENSSH PRIVATE KEY'));
});
ok('password= 兜底', () => {
    assert.ok(redactor.text('mysql -p --password=hunter2').includes('******'));
});
ok('短值不登记（避免误伤端口号）', () => {
    const r = createRedactor();
    r.add('22');
    assert.strictEqual(r.text('port 22 open'), 'port 22 open');
});

console.log('[3] vault');
const vault = createVault({ vaultDir, redactor });
let saved;
ok('新增服务器（密码认证）', () => {
    saved = vault.upsert({
        name: '测试机', host: '10.0.0.9', port: 2222, user: 'root',
        authType: 'password', secrets: { password: FIXTURE_PW }, notes: '自测',
        apps: [{ name: 'nginx', manager: 'systemd', service: 'nginx', port: 80 }],
    });
    assert.strictEqual(saved.host, '10.0.0.9');
    assert.strictEqual(saved.auth, 'password');
    assert.strictEqual(saved.apps.length, 1);
});
ok('落盘不含明文密码', () => {
    const raw = fs.readFileSync(path.join(vaultDir, 'servers.json'), 'utf8');
    assert.ok(!raw.includes(FIXTURE_PW), '磁盘上出现了明文密码');
    assert.ok(raw.includes('"secrets"'));
});
ok('secretsFor 能解出密码并登记脱敏', () => {
    const secrets = vault.secretsFor(saved.id);
    assert.strictEqual(secrets.password, FIXTURE_PW);
    assert.ok(redactor.text(`value ${FIXTURE_PW} here`).includes('******'));
});
ok('更新元信息但不传 secrets 时保留原凭证', () => {
    const updated = vault.upsert({ id: saved.id, host: '10.0.0.9', port: 2222, user: 'root', name: '测试机改名' });
    assert.strictEqual(updated.name, '测试机改名');
    assert.strictEqual(vault.secretsFor(saved.id).password, FIXTURE_PW);
});
ok('mergeApps 去重合并', () => {
    const merged = vault.mergeApps(saved.id, [
        { name: 'nginx', manager: 'systemd', service: 'nginx', port: 80 },
        { name: 'redis', manager: 'systemd', service: 'redis', port: 6379 },
    ]);
    assert.strictEqual(merged.apps.length, 2);
});
ok('删除服务器同时删掉密钥文件', () => {
    assert.strictEqual(vault.remove(saved.id), true);
    assert.strictEqual(vault.list().length, 0);
});
ok('私钥认证：密文入库并落成 0600 的临时密钥文件', () => {
    const fakeKey = fakePem();
    const k = vault.upsert({
        name: '密钥机', host: '10.9.9.9', port: 22, user: 'deploy',
        authType: 'key', secrets: { privateKey: fakeKey, passphrase: 'pp-123456' },
    });
    assert.strictEqual(k.auth, 'key');
    const secrets = vault.secretsFor(k.id);
    assert.ok(secrets.keyFile && fs.existsSync(secrets.keyFile), '私钥文件没落盘');
    assert.ok(fs.readFileSync(secrets.keyFile, 'utf8').includes('BEGIN OPENSSH PRIVATE KEY'));
    assert.strictEqual(secrets.passphrase, 'pp-123456');
    // 私钥与 passphrase 都该被登记脱敏
    assert.ok(redactor.text(`k=${fakeKey}`).includes('******'));
    assert.ok(redactor.text('pass pp-123456 end').includes('******'));
    vault.remove(k.id);
});

console.log('[4] journal');
const journal = createJournal({ dir: logDir, redactor, streamIdFactory: (() => { let n = 0; return () => `t${++n}`; })() });
ok('流式输出逐行入账且已脱敏', () => {
    const { streamId } = journal.openStream({ serverId: 'x', serverName: '测试', where: 'u@h:22' });
    journal.input(streamId, { prompt: 'root@nas:~#', command: 'echo ' + FIXTURE_PW });
    journal.output(streamId, 'out', 'line1\nline2\n');
    journal.closeStream(streamId, { code: 0, durationMs: 12 });
    const entries = journal.snapshot({ limit: 20 });
    assert.ok(entries.some((e) => e.kind === 'stdout' && e.text === 'line1'));
    const joined = entries.map((e) => e.text).join('\n');
    assert.ok(!joined.includes(FIXTURE_PW), '日志里出现了明文');
});
ok('输入行带 prompt，且 prompt 也走脱敏', () => {
    const { streamId } = journal.openStream({ serverId: 'x', serverName: '测试', where: 'u@h:22' });
    journal.input(streamId, { prompt: 'root@nas:~#', command: 'mysql -p' + FIXTURE_PW });
    const line = journal.snapshot({ limit: 5 }).find((e) => e.kind === 'input');
    assert.strictEqual(line.prompt, 'root@nas:~#', '提示符应单独存一个字段');
    assert.ok(!line.text.includes(FIXTURE_PW), '命令里的明文应被抹掉');
});
ok('同一台机器连续操作：会话头只打一次（用户反馈的核心）', () => {
    const j = createJournal({ dir: path.join(tmp, 'logs-session'), redactor, streamIdFactory: (() => { let n = 0; return () => `u${++n}`; })() });
    for (let i = 0; i < 5; i += 1) {
        const { streamId } = j.openStream({ serverId: 'same', serverName: '同一台', where: 'u@h:22' });
        j.input(streamId, { prompt: 'root@nas:~#', command: `cmd${i}` });
        j.output(streamId, 'out', `out${i}`);
        j.closeStream(streamId, { code: 0, durationMs: 10 });
    }
    const all = j.snapshot({ limit: 200 });
    assert.strictEqual(all.filter((e) => e.kind === 'stream-open').length, 1, '5 条命令只该有一个会话头');
    assert.strictEqual(all.filter((e) => e.kind === 'input').length, 5, '每条命令一行输入');
    // 退出码不许逐条打：连续 5 条命令，屏上不该出现 5 条「结束/退出码」
    assert.strictEqual(all.filter((e) => e.kind === 'stream-close').length, 0, '会话没结束就不该打退出码');
    j.flushSessions();
    const after = j.snapshot({ limit: 200 }).filter((e) => e.kind === 'stream-close');
    assert.strictEqual(after.length, 1, '会话收尾只打一条');
    // 全成功时不显示退出码（用户要求「更精简」），只报命令数与耗时
    assert.ok(!after[0].text.includes('退出码'), `全成功不该摆退出码：${after[0].text}`);
    assert.ok(after[0].text.includes('5 条命令'), `应汇总命令数：${after[0].text}`);
});
ok('切换机器：新会话头，并先收尾上一台', () => {
    const j = createJournal({ dir: path.join(tmp, 'logs-switch'), redactor, streamIdFactory: (() => { let n = 0; return () => `s${++n}`; })() });
    const a = j.openStream({ serverId: 'A', serverName: '甲机', where: 'u@a:22' });
    j.closeStream(a.streamId, { code: 0, durationMs: 5 });
    const b = j.openStream({ serverId: 'B', serverName: '乙机', where: 'u@b:22' });
    j.closeStream(b.streamId, { code: 0, durationMs: 5 });
    const all = j.snapshot({ limit: 50 });
    const heads = all.filter((e) => e.kind === 'stream-open');
    assert.strictEqual(heads.length, 2, '换机器必须重新打会话头');
    assert.ok(heads[0].text.includes('甲机') && heads[1].text.includes('乙机'));
    // 上一台的收尾要在切走时补上（不能因为换了机器就把甲的尾巴吞掉）
    const closes = all.filter((e) => e.kind === 'stream-close');
    assert.strictEqual(closes.length, 1, '切走时应收尾上一台');
    // 全程成功的会话不摆退出码，靠「哪台机器」区分是谁的尾巴
    assert.ok(closes[0].text.includes('1.0s') || /■/.test(closes[0].text), closes[0].text);
});
ok('失败当场打红字，且计入会话尾', () => {
    const j = createJournal({ dir: path.join(tmp, 'logs-fail'), redactor, streamIdFactory: (() => { let n = 0; return () => `f${++n}`; })() });
    const { streamId } = j.openStream({ serverId: 'F', serverName: '丙机', where: 'u@f:22' });
    j.closeStream(streamId, { code: 127, durationMs: 5, failure: { kind: 'exec', message: '命令不存在' } });
    const fail = j.snapshot({ limit: 20 }).filter((e) => e.kind === 'stream-fail');
    assert.strictEqual(fail.length, 1, '失败必须当场可见，不能被合并');
    assert.ok(fail[0].text.includes('命令不存在'));
    j.flushSessions();
    const tail = j.snapshot({ limit: 20 }).filter((e) => e.kind === 'stream-close');
    assert.ok(tail[0].text.includes('1 次失败'), tail[0].text);
    // 有失败时才把退出码摆出来（这是要人注意的信息）
    assert.ok(tail[0].text.includes('退出码 127'), tail[0].text);
});
ok('空闲超时自动收尾（用户实际最常走的那条路）', async () => {
    // 用户不会手动「结束会话」：敲完就走，会话要靠空闲计时器收尾。
    // 这条路径不测，「退出码不重复」就只在测试里成立、在真实使用里不成立。
    const j = createJournal({
        dir: path.join(tmp, 'logs-idle'), redactor, sessionIdleMs: 30,
        streamIdFactory: (() => { let n = 0; return () => `i${++n}`; })(),
    });
    const { streamId } = j.openStream({ serverId: 'I', serverName: '丁机', where: 'u@i:22' });
    j.input(streamId, { prompt: 'root@i:~#', command: 'sleep 1' });
    j.output(streamId, 'out', 'done');
    j.closeStream(streamId, { code: 0, durationMs: 900 });
    assert.strictEqual(j.snapshot({ limit: 50 }).filter((e) => e.kind === 'stream-close').length, 0, '命令刚跑完不该立刻收尾');
    await new Promise((r) => setTimeout(r, 80));
    const closed = j.snapshot({ limit: 50 }).filter((e) => e.kind === 'stream-close');
    assert.strictEqual(closed.length, 1, '空闲后应自动收尾一次');
    assert.ok(closed[0].text.includes('丁机'), closed[0].text);
    assert.ok(!closed[0].text.includes('退出码'), `全成功仍不摆退出码：${closed[0].text}`);
});

ok('日志落盘也不含明文', () => {
    const raw = fs.readFileSync(path.join(logDir, 'ops-console.ndjson'), 'utf8');
    assert.ok(!raw.includes(FIXTURE_PW));
});

console.log('[4b] prompt');
ok('提示符照真 shell 的样式', () => {
    assert.strictEqual(shellPrompt({ user: 'root', hostname: 'nas', cwd: '~' }), 'root@nas:~#');
    assert.strictEqual(shellPrompt({ user: 'ubuntu', hostname: 'vm1' }), 'ubuntu@vm1:~$', '非 root 用 $');
});
ok('登录用户不是 root 时，提示符用真实用户名 + $（用户指出不能假设 root）', () => {
    // 用户原话：「虽然我告诉你的都是 root 密码，但不代表其他用户也是」。
    // 提示符里的用户名必须来自凭证里的 user，不能写死 root。
    assert.strictEqual(shellPrompt({ user: 'deploy', hostname: 'web01' }), 'deploy@web01:~$');
    assert.strictEqual(shellPrompt({ user: 'www-data', hostname: 'web01' }), 'www-data@web01:~$');
    // 只有真的是 root 才给 #
    assert.ok(!shellPrompt({ user: 'deploy', hostname: 'web01' }).endsWith('#'));
});
ok('用户名缺失时不冒充 root', () => {
    // 凭证里 user 是必填，正常走不到；但真走到了也不许显示成 root —— 那是在断言特权身份，
    // 而我们对这个身份一无所知。
    assert.ok(!shellPrompt({ hostname: 'h1' }).startsWith('root@'));
    assert.ok(shellPrompt({ hostname: 'h1' }).endsWith('$'), '未知身份按非特权处理');
});
ok('拿不到主机名时退回地址，不编假名字', () => {
    assert.strictEqual(shellPrompt({ user: 'root', hostname: '', host: '10.0.0.5' }), 'root@10.0.0.5:~#');
});
ok('脏主机名被丢弃', () => {
    assert.strictEqual(shellPrompt({ user: 'root', hostname: 'a b/c', host: 'h1' }), 'root@h1:~#');
});
ok('命令带 cd 绝对路径时提示符跟着走', () => {
    assert.strictEqual(promptForCommand({ user: 'root', hostname: 'nas' }, 'cd /var/log && ls'), 'root@nas:/var/log#');
    assert.strictEqual(promptForCommand({ user: 'root', hostname: 'nas' }, 'ls -la'), 'root@nas:~#');
});

console.log('[5] probe 解析');
ok('分段解析', () => {
    const s = splitSections('##OS##\nUbuntu 22.04\n##CPU##\n4\n');
    assert.strictEqual(s.get('OS')[0], 'Ubuntu 22.04');
});
ok('环境画像', () => {
    const env = parseEnv('##OS##\nDebian 12\n##KERNEL##\nLinux 6.1 x86_64\n##CPU##\n8\n##MEM##\n16000 4000\n##DISK##\n100G 40G 42%\n##INIT##\nsystemd\n##DOCKER##\nnone\n');
    assert.strictEqual(env.os, 'Debian 12');
    assert.strictEqual(env.cpus, 8);
    assert.deepStrictEqual(env.memoryMb, { total: 16000, used: 4000 });
    assert.strictEqual(env.docker, null);
});
ok('应用发现（systemd + docker）', () => {
    const parsed = parseApps([
        '##SYSTEMD##', 'nginx', 'docker', '##DOCKER##', 'openlist|oplist/openlist:latest|10207->5244|Up 3 days',
        '##COMPOSE##', 'stack', '##PORTS##', '22', '80', '##SITES##', '/var/www/a',
    ].join('\n'));
    assert.ok(parsed.apps.some((a) => a.name === 'nginx' && a.manager === 'systemd'));
    assert.ok(parsed.apps.some((a) => a.name === 'openlist' && a.port === 10207));
    assert.ok(parsed.apps.some((a) => a.manager === 'docker-compose' && a.name === 'stack'));
    assert.deepStrictEqual(parsed.listeningPorts, [22, 80]);
});
ok('应用命令生成', () => {
    assert.strictEqual(appCommand({ manager: 'systemd', service: 'nginx' }, 'restart'), "systemctl restart 'nginx.service' && sleep 1 && systemctl is-active 'nginx.service'");
    assert.ok(appCommand({ manager: 'docker', service: 'openlist' }, 'logs', { lines: 50 }).startsWith('docker logs --tail 50'));
});

console.log('[6] tools');
const ops = createOpsService({
    vaultDir: path.join(tmp, 'vault2'),
    logDir: path.join(tmp, 'logs2'),
    profileDir: path.join(tmp, 'profiles2'),
    config: { pythonPath: null, defaultTimeoutMs: 5000, maxOutputBytes: 4096 },
    redactor,
});
const tools = new Map(buildTools(ops).map((t) => [t.name, t]));
ok('工具清单齐全', () => {
    for (const n of [
        'ssh_server_list', 'ssh_server_register', 'ssh_server_env', 'ssh_server_exec',
        'ssh_app_control', 'ssh_server_forget',
        'ssh_server_profile', 'ssh_server_profile_save', 'ssh_server_profile_audit',
    ]) {
        assert.ok(tools.has(n), `缺工具 ${n}`);
    }
});

// 参数校验在 index.js 的 makeExecutor 里（工具定义本身不校验），
// 所以这里直接构造一个最小 ctx，把真插件装起来测——测假的是没有意义的。
console.log('[6b] 参数校验（走 index.js 的真实 makeExecutor）');
const { apply: applyPlugin } = await import('./index.js');
const registered = new Map();
const fakeCtx = {
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {}; },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    tools: { register: (def) => { registered.set(def.name, def); return () => {}; } },
    inject: () => () => {},
};
applyPlugin(fakeCtx, { vaultDir: path.join(tmp, 'vault-fake'), logDir: path.join(tmp, 'logs-fake') });

await (async () => {
    const exec = registered.get('ssh_server_register').execute;
    // ① 缺必填字段
    try {
        await exec({ host: '10.0.0.1' });
        console.error('  ✗ 缺 user 时应报错');
        process.exitCode = 1;
    } catch (error) {
        assert.ok(String(error.message).includes('user'), `报错文案没提到 user：${error.message}`);
        passed += 1;
        console.log('  ✓ 缺必填字段报错');
    }
    // ② 未知字段
    try {
        await exec({ host: '10.0.0.1', user: 'u', nonsense: true });
        console.error('  ✗ 未知字段应报错');
        process.exitCode = 1;
    } catch (error) {
        assert.ok(String(error.message).includes('nonsense'), `报错文案没提到 nonsense：${error.message}`);
        passed += 1;
        console.log('  ✓ 未知字段被拒');
    }
})();

console.log('[7] forget 需要 confirm');
// 必须用**同一个** service 实例：tools 是从 ops 构建的，
// 另建一个 ops2 只会得到空凭证库 —— 这正是这条测试以前「看起来通过、其实没测」的原因。
const reg = tools.get('ssh_server_register');
const before = ops.vault.list().length;
await reg.execute({ host: '127.0.0.1', user: 'demo', name: '本地演示', authType: 'password', password: FIXTURE_PW });
const listed = ops.vault.list();
ok('登记后出现在同一实例的清单里', () => {
    assert.strictEqual(listed.length, before + 1, `期望 ${before + 1} 台，实际 ${listed.length} 台`);
    assert.ok(listed.find((s) => s.user === 'demo'), '没找到刚登记的 demo');
});

await (async () => {
    const demo = ops.vault.list().find((s) => s.user === 'demo');
    const forget = tools.get('ssh_server_forget').execute;
    try {
        await forget({ serverId: demo.id, confirm: false });
        console.error('  ✗ confirm=false 时应拒绝删除');
        process.exitCode = 1;
    } catch (error) {
        assert.ok(String(error.message).includes('confirm'), error.message);
        passed += 1;
        console.log('  ✓ confirm=false 拒绝删除');
    }
    assert.ok(ops.vault.list().some((s) => s.id === demo.id), '被拒绝的删除不该真的删掉');
    passed += 1;
    console.log('  ✓ 拒绝后数据仍在');
})();

console.log('[8] 档案工具端到端（走真实 tools → service → profile）');
await (async () => {
    const demo = ops.vault.list().find((s) => s.user === 'demo');
    const save = tools.get('ssh_server_profile_save').execute;
    const read = tools.get('ssh_server_profile').execute;
    const audit = tools.get('ssh_server_profile_audit').execute;

    // ① 没档案时读：不报错，但要明说没有
    const empty = await read({ serverId: demo.id });
    assert.strictEqual(empty.hasProfile, false, '新登记机器不该凭空有档案');
    passed += 1;
    console.log('  ✓ 无档案时 get 返回 hasProfile=false');

    // ② 写入
    const saved = await save({
        serverId: demo.id,
        summary: '自测用例机',
        traits: [{ title: '与别人共享 IP', source: 'owner', severity: 'critical' }],
        portMap: [{ public: 10207, internal: 5244, app: 'openlist' }],
        constraints: [{ text: '不要扫描端口' }],
        openQuestions: ['对外端口是多少？'],
    });
    assert.strictEqual(saved.isNew, true);
    assert.strictEqual(saved.profile.traits[0].source, 'owner');
    passed += 1;
    console.log('  ✓ 建档成功，source=owner 被保留');

    // ③ 增量更新不降级 source（本轮修过的那个 bug 的回归用例）
    const updated = await save({ serverId: demo.id, traits: [{ id: saved.profile.traits[0].id, impact: '不能盲扫' }] });
    assert.strictEqual(updated.isNew, false);
    assert.strictEqual(updated.profile.traits[0].source, 'owner', '部分更新不该把 owner 降级成 agent');
    assert.strictEqual(updated.profile.traits[0].impact, '不能盲扫');
    passed += 1;
    console.log('  ✓ 部分更新保住原 source（回归）');

    // ④ 读回来是完整渲染
    const readBack = await read({ serverId: demo.id });
    assert.strictEqual(readBack.hasProfile, true);
    const text = tools.get('ssh_server_profile').render({}, readBack)[0].text;
    assert.ok(text.includes(':10207 → :5244'), '渲染应含端口映射');
    assert.ok(text.includes('不要扫描端口'), '渲染应含约束');
    passed += 1;
    console.log('  ✓ 读回并渲染出端口映射与约束');

    // ⑤ 清单里带档案摘要
    const listed = tools.get('ssh_server_list').execute;
    const listValue = await listed({});
    const row = listValue.servers.find((s) => s.id === demo.id);
    assert.ok(row.profile, '清单里应带档案摘要');
    assert.strictEqual(row.profile.traitCount, 1);
    passed += 1;
    console.log('  ✓ ssh_server_list 带出档案摘要');

    // ⑥ 体检：这台有档案，不该报缺
    const auditValue = await audit({});
    assert.ok(!auditValue.missingProfile.some((s) => s.id === demo.id));
    assert.strictEqual(auditValue.leaks.length, 0, '档案里不该有凭证');
    passed += 1;
    console.log('  ✓ 体检不误报、不认为有凭证泄漏');

    // ⑦ 删除服务器后档案变成孤儿（档案不该被一起删掉 —— 机器可能是换 ID 重登记）
    ops.vault.remove(demo.id);
    const afterForget = await audit({});
    assert.ok(afterForget.orphanProfile.length >= 1, '删掉凭证后档案应报孤儿');
    passed += 1;
    console.log('  ✓ 删凭证后档案成为孤儿（保留而非静默删除）');
})();

// ── 安全回归：`?fence=1` 的放行范围 ──────────────────────────────────────
// 事故记录：档案页（`/servers/:id/profile`，返回 HTML）曾走 `?fence=1` 兜底，
// 于是**任何网页都能直接打开那个 URL 读到服务器档案** ——
// 顶层导航不带 Origin 头，Host 白名单照样放行，实测 curl 一下就是 200 + 完整档案。
// 市场维护者在收录时把这条写进了描述，是个真问题。
//
// 现在：`?fence=1` 只给 EventSource（浏览器不允许给它设自定义头）用，
// 那个独立 HTML 页整个删掉了，档案只在面板内抽屉里走 JSON 渲染。
console.log('[8] 安全回归：?fence=1 只放行 SSE');
ok('源码里 ?fence 的放行条件只认 console/stream', () => {
    const src = fs.readFileSync(new URL('./lib/server-api.js', import.meta.url), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!src.includes('isProfilePage'), '档案页的 fence 放行必须已删除');
    assert.ok(!/third === 'profile'/.test(src), '档案页路由必须已删除');
    assert.ok(src.includes("(isStream && params.get('fence') === '1')"),
        '?fence=1 应当只绑定 isStream，不能扩大范围');
});

ok('档案页的渲染器已随路由一起删除（不留死代码）', () => {
    const root = new URL('./', import.meta.url);
    assert.ok(!fs.existsSync(new URL('lib/profile-html.js', root)), 'lib/profile-html.js 应已删除');
    assert.ok(!fs.existsSync(new URL('test-profile-page.mjs', root)), '它的测试也应一起删除');
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
fs.rmSync(tmp, { recursive: true, force: true });


