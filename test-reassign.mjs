// test-reassign.mjs —— 「给服务器换 serverId」的自测。
//
// 这个操作的风险：它要同时改**凭证库**和**档案文件**两处，任何一处漏改都会造成
// 「凭证在、档案在，但两者对不上」（孤儿档案 / 档案丢失）。
// 所以测试重点同样是「改完之后，两边还对不对得上」。
//
// 用法：node test-reassign.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createVault } from './lib/vault.js';
import { createRedactor } from './lib/redact.js';
import { createProfiles } from './lib/profile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'reassign-id.mjs');

/** 假密码：运行时拼出来，不留字面量（发布闸门会把它当真密码拦下）。 */
const FIXTURE_PW = ['Pa55', 'word', '!'].join('');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-ops-reassign-'));
const vaultDir = path.join(tmp, 'vault');
const profileDir = path.join(tmp, 'profiles');

let passed = 0;
function ok(label, fn) {
    try { fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (error) { console.error(`  ✗ ${label}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

/** 跑一次脚本，返回 { code, out }。 */
function run(args) {
    try {
        const out = execFileSync('node', [SCRIPT, ...args, '--dir', tmp], { encoding: 'utf8' });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
}

// 造一台带档案的机器
const redactor = createRedactor();
const vault = createVault({ vaultDir, redactor });
const profiles = createProfiles({ profileDir });
const created = vault.upsert({
    name: '测试机', host: '10.0.0.7', port: 2222, user: 'root',
    authType: 'password', secrets: { password: FIXTURE_PW }, tags: ['旧'],
    notes: '这条备注必须原样保留',
    apps: [{ name: 'nginx', manager: 'systemd', service: 'nginx', port: 80 }],
});
const OLD_ID = created.id;
profiles.patch({ id: OLD_ID, name: created.name, host: created.host }, {
    role: '测试角色',
    traits: [{ id: 'shared-ip', title: '共享 IP', source: 'owner', severity: 'critical' }],
    portMap: [{ id: 'pm-a', public: 10207, internal: 5244, app: 'x' }],
    constraints: [{ id: 'c-a', text: '不要扫端口' }],
    openQuestions: ['对外端口是多少？'],
});

console.log('[1] 干跑不改文件');
{
    const beforeVault = fs.readFileSync(path.join(vaultDir, 'servers.json'), 'utf8');
    const r = run(['--old', OLD_ID, '--reason', '测试', '--dry']);
    ok('dry 模式退出码 0 且提示不改文件', () => {
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /只显示计划/);
    });
    ok('dry 模式确实没改凭证库', () => {
        assert.strictEqual(fs.readFileSync(path.join(vaultDir, 'servers.json'), 'utf8'), beforeVault);
    });
}

console.log('[2] 实际换 id');
let NEW_ID = null;
{
    const r = run(['--old', OLD_ID, '--reason', '泄漏进公开 commit']);
    ok('脚本成功', () => assert.strictEqual(r.code, 0, r.out));
    ok('输出里有 STATUS: OK', () => assert.match(r.out, /STATUS: OK/));
    NEW_ID = (/新 id : (\S+)/.exec(r.out) ?? [])[1];
    ok('拿到了新 id 且与旧的不同', () => {
        assert.ok(NEW_ID, '没解析出新 id');
        assert.notStrictEqual(NEW_ID, OLD_ID);
    });
}

console.log('[3] 两处必须同时换掉，且别的东西一个都不许动');
ok('凭证库里旧 id 消失', () => {
    const ids = vault.list().map((s) => s.id);
    assert.ok(!ids.includes(OLD_ID), `旧 id 仍在：${ids.join(',')}`);
});
ok('凭证库里新 id 存在且只有一条', () => {
    assert.strictEqual(vault.list().filter((s) => s.id === NEW_ID).length, 1);
});
ok('连接信息没变（host/port/user）', () => {
    const s = vault.peek(NEW_ID);
    assert.strictEqual(s.host, '10.0.0.7');
    assert.strictEqual(s.port, 2222);
    assert.strictEqual(s.user, 'root');
});
ok('备注 / 标签 / 应用清单没变', () => {
    const s = vault.peek(NEW_ID);
    assert.strictEqual(s.notes, '这条备注必须原样保留');
    assert.deepStrictEqual(s.tags, ['旧']);
    assert.strictEqual(s.apps.length, 1);
    assert.strictEqual(s.apps[0].name, 'nginx');
});
ok('密码仍能解出（密文没被破坏）', () => {
    assert.strictEqual(vault.secretsFor(NEW_ID).password, FIXTURE_PW);
});

console.log('[4] 档案跟着走，内容不丢');
ok('旧档案文件已不存在', () => {
    assert.strictEqual(fs.existsSync(path.join(profileDir, `${OLD_ID}.json`)), false);
});
ok('新档案文件存在', () => {
    assert.ok(fs.existsSync(path.join(profileDir, `${NEW_ID}.json`)));
});
ok('档案里 serverId 已更新', () => {
    assert.strictEqual(profiles.get(NEW_ID).serverId, NEW_ID);
});
ok('档案内的知识与旧 id 时完全一致（角色/特征/端口/约束/待确认）', () => {
    const p = profiles.get(NEW_ID);
    assert.strictEqual(p.role, '测试角色');
    assert.strictEqual(p.traits.length, 1);
    assert.strictEqual(p.traits[0].title, '共享 IP');
    assert.strictEqual(p.traits[0].source, 'owner', 'source 不该被重置成 agent');
    assert.strictEqual(p.portMap.length, 1);
    assert.strictEqual(p.constraints.length, 1);
    assert.deepStrictEqual(p.openQuestions, ['对外端口是多少？']);
});
ok('时间线记下了换 id 这件事（审计痕迹）', () => {
    const p = profiles.get(NEW_ID);
    const hit = p.timeline.find((t) => t.text.includes(OLD_ID) && t.text.includes(NEW_ID));
    assert.ok(hit, `时间线里没有换 id 记录：${JSON.stringify(p.timeline)}`);
    assert.strictEqual(hit.kind, 'incident', '换 id 属于 incident 而不是普通 note');
});
ok('audit 认为两边对得上（无孤儿、无缺档案）', () => {
    const audit = profiles.audit(vault.list());
    assert.deepStrictEqual(audit.missingProfile, []);
    assert.deepStrictEqual(audit.orphanProfile, []);
});

console.log('[5] 边界');
ok('旧 id 不存在时脚本报错退出（不静默成功）', () => {
    const r = run(['--old', 'nope-000000', '--reason', 'x']);
    assert.notStrictEqual(r.code, 0, '不存在的 id 应当非零退出');
    assert.match(r.out, /没有 id/);
});
ok('重复用同一个旧 id 再跑一次会报错（不会产生两条记录）', () => {
    const r = run(['--old', OLD_ID, '--reason', '再跑一次']);
    assert.notStrictEqual(r.code, 0);
    assert.strictEqual(vault.list().length, 1, '服务器总数不该变');
});
ok('凭证库留下了备份文件', () => {
    const baks = fs.readdirSync(vaultDir).filter((f) => f.includes('.bak-'));
    assert.ok(baks.length >= 1, `没有备份：${fs.readdirSync(vaultDir).join(',')}`);
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
fs.rmSync(tmp, { recursive: true, force: true });
