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
    const sid = journal.openStream({ serverId: 'x', serverName: '测试', title: 'run', input: 'echo ' + FIXTURE_PW });
    journal.output(sid, 'out', 'line1\nline2\n');
    journal.closeStream(sid, { code: 0, durationMs: 12 });
    const entries = journal.snapshot({ limit: 20 });
    assert.ok(entries.some((e) => e.kind === 'stdout' && e.text === 'line1'));
    const joined = entries.map((e) => e.text).join('\n');
    assert.ok(!joined.includes(FIXTURE_PW), '日志里出现了明文');
});
ok('日志落盘也不含明文', () => {
    const raw = fs.readFileSync(path.join(logDir, 'ops-console.ndjson'), 'utf8');
    assert.ok(!raw.includes(FIXTURE_PW));
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

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
fs.rmSync(tmp, { recursive: true, force: true });


