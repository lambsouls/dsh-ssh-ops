// test-identity.mjs —— 「改名 / 改标签」这条唯一写入面的自测。
//
// 这个文件的存在理由：面板上开了插件里**唯一**的写入口。写入口的测试重点不是
// 「改成功了」，而是「**除此之外什么都改不了**」——所以要大量断言「没发生什么」：
// 地址没变、凭证没变、id 没变、多传的字段被拒。
//
// 用法：node test-identity.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

import { createVault } from './lib/vault.js';
import { createRedactor } from './lib/redact.js';
import { createOpsService } from './lib/service.js';
import { readJsonBody } from './lib/http.js';

/** 假密码：运行时拼出来，源码里不留字面量（否则发布闸门会当真密码拦下）。 */
const FIXTURE_PW = ['Pa55', 'word', '!'].join('');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-ops-identity-'));
const vaultDir = path.join(tmp, 'vault');
const logDir = path.join(tmp, 'logs');
const profileDir = path.join(tmp, 'profiles');

let passed = 0;
function ok(label, fn) {
    try { fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (error) { console.error(`  ✗ ${label}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

const redactor = createRedactor();
const vault = createVault({ vaultDir, redactor });

console.log('[1] vault.setIdentity 的改动面');

const created = vault.upsert({
    name: '原始名字', host: '10.0.0.7', port: 2222, user: 'root', authType: 'password',
    secrets: { password: FIXTURE_PW }, tags: ['旧标签'], notes: '备注不该被碰',
    apps: [{ name: 'navidrome', manager: 'docker', port: 4533 }],
});
const id = created.id;
const beforeRaw = fs.readFileSync(path.join(vaultDir, 'servers.json'), 'utf8');
const beforeEntry = JSON.parse(beforeRaw).servers.find((s) => s.id === id);

ok('改名字生效', () => {
    const v = vault.setIdentity(id, { name: '音乐服务器' });
    assert.strictEqual(v.name, '音乐服务器');
});
ok('改标签生效', () => {
    const v = vault.setIdentity(id, { tags: ['生产', '音乐'] });
    assert.deepStrictEqual(v.tags, ['生产', '音乐']);
});
ok('名字留空退回 host（不留空名字）', () => {
    const v = vault.setIdentity(id, { name: '   ' });
    assert.strictEqual(v.name, '10.0.0.7', '空名字应回退到地址');
});
ok('名字过长被拒（不是静默截断）', () => {
    assert.throws(() => vault.setIdentity(id, { name: 'x'.repeat(65) }), /名字太长/);
});

console.log('[2] 改动面之外的一切必须原封不动');

const afterRaw = fs.readFileSync(path.join(vaultDir, 'servers.json'), 'utf8');
const afterEntry = JSON.parse(afterRaw).servers.find((s) => s.id === id);

ok('id 没变（变了档案就成孤儿）', () => {
    assert.strictEqual(afterEntry.id, beforeEntry.id);
});
ok('host / port / user 没变（改错地址会让你以为在操作另一台机器）', () => {
    assert.strictEqual(afterEntry.host, beforeEntry.host);
    assert.strictEqual(afterEntry.port, beforeEntry.port);
    assert.strictEqual(afterEntry.user, beforeEntry.user);
});
ok('authType / secrets 没变（凭证只走 register）', () => {
    assert.strictEqual(afterEntry.authType, beforeEntry.authType);
    assert.deepStrictEqual(afterEntry.secrets, beforeEntry.secrets, 'secrets 密文不该被重写');
});
ok('notes / apps 没变（不是这次要改的东西）', () => {
    assert.strictEqual(afterEntry.notes, beforeEntry.notes);
    assert.deepStrictEqual(afterEntry.apps, beforeEntry.apps);
});
ok('密码仍能正常解出（没被改坏）', () => {
    assert.strictEqual(vault.secretsFor(id).password, FIXTURE_PW);
});
ok('不存在的服务器报错而不是静默成功', () => {
    assert.throws(() => vault.setIdentity('nope-xxxxxx', { name: 'x' }), /没有这台服务器/);
});

console.log('[3] 标签归一');

ok('去空、去首尾空格', () => {
    const v = vault.setIdentity(id, { tags: ['  生产  ', '', '   ', '音乐'] });
    assert.deepStrictEqual(v.tags, ['生产', '音乐']);
});
ok('去重且保留顺序（顺序本身是信息）', () => {
    const v = vault.setIdentity(id, { tags: ['b', 'a', 'b', 'c'] });
    assert.deepStrictEqual(v.tags, ['b', 'a', 'c']);
});
ok('大小写不同视为同一个标签', () => {
    const v = vault.setIdentity(id, { tags: ['Prod', 'prod', 'PROD'] });
    assert.deepStrictEqual(v.tags, ['Prod'], '大小写不同的同名标签不该并存');
});
ok('数量上限（多于 12 个截断）', () => {
    const v = vault.setIdentity(id, { tags: Array.from({ length: 20 }, (_, i) => `t${i}`) });
    assert.strictEqual(v.tags.length, 12);
});
ok('单个标签长度上限', () => {
    const v = vault.setIdentity(id, { tags: ['x'.repeat(40)] });
    assert.strictEqual(v.tags[0].length, 24);
});
ok('传字符串也能解析（逗号分隔，中英文都认）', () => {
    const v = vault.setIdentity(id, { tags: '生产, 国内，音乐' });
    assert.deepStrictEqual(v.tags, ['生产', '国内', '音乐']);
});
ok('传空数组＝清空标签', () => {
    const v = vault.setIdentity(id, { tags: [] });
    assert.deepStrictEqual(v.tags, []);
});

console.log('[4] service.renameServer 的准入');

const ops = createOpsService({
    vaultDir, logDir, profileDir,
    config: { pythonPath: null, defaultTimeoutMs: 5000, maxOutputBytes: 4096 },
    redactor,
});

ok('只允许 name / tags：多传字段直接报错（不静默忽略）', () => {
    assert.throws(() => ops.renameServer(id, { name: 'x', host: '1.2.3.4' }), /只允许改 name \/ tags/);
});
ok('试图改端口被拒', () => {
    assert.throws(() => ops.renameServer(id, { port: 22 }), /只允许改/);
});
ok('试图改用户名被拒', () => {
    assert.throws(() => ops.renameServer(id, { user: 'evil' }), /只允许改/);
});
ok('试图写 password 被拒', () => {
    assert.throws(() => ops.renameServer(id, { password: 'x' }), /只允许改/);
});
ok('一个字段都不给时报错', () => {
    assert.throws(() => ops.renameServer(id, {}), /没有要改的字段/);
});
ok('正常改名成功并返回 changed', () => {
    const r = ops.renameServer(id, { name: '音乐服务器', tags: ['音乐'] });
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.server.name, '音乐服务器');
    assert.deepStrictEqual(r.server.tags, ['音乐']);
});
ok('改成同样的值 → changed=false（仍算成功，但不写日志噪音）', () => {
    const r = ops.renameServer(id, { name: '音乐服务器', tags: ['音乐'] });
    assert.strictEqual(r.changed, false);
});

console.log('[5] 改动会留下痕迹');

ok('改名的操作进了控制台日志', () => {
    const entries = ops.journal.snapshot({ limit: 50 });
    assert.ok(entries.some((e) => e.text.includes('改标识') && e.text.includes('音乐服务器')),
        `日志里没有改标识记录；现有：${entries.map((e) => e.text).join(' | ')}`);
});
ok('日志里不含密码', () => {
    const joined = ops.journal.snapshot({ limit: 100 }).map((e) => e.text).join('\n');
    assert.ok(!joined.includes(FIXTURE_PW));
});
ok('改名不影响档案里的角色定位', () => {
    ops.saveProfile(id, { role: '音乐服务器（主要跑 navidrome）' });
    ops.renameServer(id, { name: '完全不同的名字' });
    const profile = ops.profiles.get(id);
    assert.strictEqual(profile.role, '音乐服务器（主要跑 navidrome）', '改名不该改掉「这台机器是干什么的」');
});
ok('改名不影响档案的存在与内容', () => {
    const profile = ops.profiles.get(id);
    assert.ok(profile, '档案应仍在');
    assert.strictEqual(profile.serverId, id);
});

console.log('[6] readJsonBody 的边界（唯一写端点的入口）');

/** 造一个假 req：把 data/end/error 事件按需触发。 */
function fakeReq({ headers = {}, chunks = [], emitError = null } = {}) {
    const handlers = {};
    const req = {
        headers,
        on(event, fn) { (handlers[event] ||= []).push(fn); return req; },
        destroy() { req.destroyed = true; },
        _emit(event, arg) { for (const fn of handlers[event] ?? []) fn(arg); },
        _end() { req._emit('end'); },
    };
    // 用微任务派发，模拟真实异步
    Promise.resolve().then(() => {
        if (emitError) { req._emit('error', emitError); return; }
        for (const c of chunks) req._emit('data', Buffer.from(c));
        req._end();
    });
    return req;
}

async function runBodyTests() {
    const good = await readJsonBody(fakeReq({
        headers: { 'content-type': 'application/json' },
        chunks: [JSON.stringify({ name: '甲', tags: ['a'] })],
    }));
    ok('正常 JSON 能读出', () => assert.deepStrictEqual(good, { name: '甲', tags: ['a'] }));

    await assert.rejects(
        () => readJsonBody(fakeReq({ headers: { 'content-type': 'text/plain' }, chunks: ['{}'] })),
        /content-type/,
        '非 JSON content-type 应被拒',
    );
    passed += 1; console.log('  ✓ 非 JSON content-type 被拒');

    await assert.rejects(
        () => readJsonBody(fakeReq({ headers: { 'content-type': 'application/json' }, chunks: ['{ 坏 JSON'] })),
        /不是合法 JSON/,
    );
    passed += 1; console.log('  ✓ 坏 JSON 被拒');

    await assert.rejects(
        () => readJsonBody(fakeReq({ headers: { 'content-type': 'application/json' }, chunks: ['x'.repeat(9000)] })),
        /过大/,
    );
    passed += 1; console.log('  ✓ 超大请求体被拒');

    const empty = await readJsonBody(fakeReq({ headers: { 'content-type': 'application/json' }, chunks: [] }));
    ok('空体返回空对象（不抛错）', () => assert.deepStrictEqual(empty, {}));

    const split = await readJsonBody(fakeReq({
        headers: { 'content-type': 'application/json; charset=utf-8' },
        chunks: ['{"name":', '"分片"}'],
    }));
    ok('分片到达能正确拼接', () => assert.strictEqual(split.name, '分片'));

    const cn = await readJsonBody(fakeReq({
        headers: { 'content-type': 'application/json' },
        chunks: [JSON.stringify({ name: '中文名字', tags: ['生产'] })],
    }));
    ok('中文不乱码', () => assert.strictEqual(cn.name, '中文名字'));
}

await runBodyTests();

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
fs.rmSync(tmp, { recursive: true, force: true });
