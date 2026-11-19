// test-profile.mjs —— 服务器档案模块自测（不需要 DSH，也不需要连服务器）。
// 覆盖：归一化、按 id 增量合并、删除、漂移检查、渲染、体检、文件系统落点。
// 用法：node test-profile.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

import { createProfiles, normalizeProfile, renderProfile, renderProfileLine } from './lib/profile.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-ops-profile-'));
const profileDir = path.join(tmp, 'profiles');

let passed = 0;
function ok(label, fn) {
    try { fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (error) { console.error(`  ✗ ${label}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

const SERVER = { id: 'music-abc123', name: '音乐服务器', host: '10.0.0.7' };

console.log('[1] 归一化');
ok('空档案有稳定形状', () => {
    const p = normalizeProfile(null, SERVER);
    assert.deepStrictEqual(p.traits, []);
    assert.deepStrictEqual(p.portMap, []);
    assert.deepStrictEqual(p.openQuestions, []);
    assert.strictEqual(p.serverId, 'music-abc123');
    assert.strictEqual(p.host, '10.0.0.7');
});
ok('非法 severity/kind/source 落到 null（由 finalize 补默认值），不抛错', () => {
    const raw = normalizeProfile({
        traits: [{ title: '随便写点什么', severity: '灾难级', kind: '玄学', source: '我猜的' }],
    }, SERVER);
    assert.strictEqual(raw.traits[0].severity, null, '非法值应是 null（表示本次没提供）');
    assert.strictEqual(raw.traits[0].kind, null);
    assert.strictEqual(raw.traits[0].source, null);
});
ok('落盘/读回的档案一定带齐默认值，且 source 默认 agent 不是 owner', () => {
    const tmpDir = path.join(tmp, 'defaults');
    const p2 = createProfiles({ profileDir: tmpDir });
    const saved = p2.put({ id: 'd-xxxxxx', name: 'D', host: '10.0.0.8' }, { traits: [{ title: '随便写点什么' }] });
    assert.strictEqual(saved.traits[0].severity, 'note');
    assert.strictEqual(saved.traits[0].kind, 'other');
    assert.strictEqual(saved.traits[0].source, 'agent', '缺省 source 必须是 agent，绝不能默认成 owner');
});
ok('没有标题也没有 id 可推导的特征不会进档案', () => {
    const tmpDir = path.join(tmp, 'notitle');
    const p2 = createProfiles({ profileDir: tmpDir });
    const saved = p2.put({ id: 'n-xxxxxx', name: 'N', host: '10.0.0.9' }, {
        traits: [{ detail: '只有细节没有标题' }, { title: '有标题' }],
    });
    assert.strictEqual(saved.traits.length, 1);
    assert.strictEqual(saved.traits[0].title, '有标题');
});
ok('端口容错：数字 / 带协议 / 完全不知道', () => {
    const p = normalizeProfile({
        portMap: [
            { public: 10207, internal: 5244, app: 'openlist' },
            { public: '4533/tcp', internal: '4533', app: 'navidrome' },
            { public: 'not-a-port', internal: null, app: 'x' },
        ],
    }, SERVER);
    assert.strictEqual(p.portMap.length, 3);
    assert.strictEqual(p.portMap[0].public, 10207);
    assert.strictEqual(p.portMap[1].public, 4533);
    assert.strictEqual(p.portMap[2].public, null);
});
ok('时间线按时间排序且截断到上限', () => {
    const many = Array.from({ length: 260 }, (_, i) => ({
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        text: `事件 ${i}`,
    }));
    const p = normalizeProfile({ timeline: many }, SERVER);
    assert.strictEqual(p.timeline.length, 200, '应截断到 200 条');
    assert.ok(p.timeline[0].at < p.timeline[p.timeline.length - 1].at, '应按时间升序');
});

console.log('[2] 读写与增量合并');
const profiles = createProfiles({ profileDir });
ok('没有档案时 get 返回 null（不自动建空档案）', () => {
    assert.strictEqual(profiles.get(SERVER.id), null);
    assert.strictEqual(profiles.exists(SERVER.id), false);
});
ok('patch 首次写入即建档', () => {
    const p = profiles.patch(SERVER, {
        role: '音乐服务器（主要跑 navidrome）',
        summary: '共享公网 IP，只有部分端口；出网拉不到镜像',
    });
    assert.strictEqual(p.role, '音乐服务器（主要跑 navidrome）');
    assert.ok(profiles.exists(SERVER.id), '落盘文件应存在');
});
ok('同 id 的特征是更新，不是新增', () => {
    profiles.patch(SERVER, { traits: [{ id: 'shared-ip', title: '与别人共享公网 IP', source: 'owner' }] });
    const p = profiles.patch(SERVER, { traits: [{ id: 'shared-ip', title: '与别人共享公网 IP', detail: '只租到部分端口', source: 'owner' }] });
    assert.strictEqual(p.traits.length, 1, '同 id 应合并');
    assert.strictEqual(p.traits[0].detail, '只租到部分端口', '新字段应写入');
    assert.strictEqual(p.traits[0].source, 'owner');
});
ok('中文标题生成的 id 也能被后续更新命中（回归：曾因校验用了 ASCII-only 正则而永远丢更新）', () => {
    // 用独立的档案目录，避免污染后续「traitCount 应为 0」之类的断言
    const isoDir = path.join(tmp, 'cn-id');
    const iso = createProfiles({ profileDir: isoDir });
    const p1 = iso.patch({ id: 'cn-xxxxxx', name: 'CN', host: '10.0.0.11' }, { traits: [{ title: '整条都没有 id 的中文标题' }] });
    const madeId = p1.traits[0].id;
    assert.ok(madeId, '中文标题必须能生成合法条目 id');
    const p2 = iso.patch({ id: 'cn-xxxxxx', name: 'CN', host: '10.0.0.11' }, { traits: [{ id: madeId, impact: '后续补上的含义' }] });
    const target = p2.traits.find((t) => t.id === madeId);
    assert.ok(target, `按 id 更新应命中，实际 id 列表：${p2.traits.map((t) => t.id).join('、')}`);
    assert.strictEqual(target.impact, '后续补上的含义');
    assert.strictEqual(p2.traits.filter((t) => t.id === madeId).length, 1, '不该变成两条');
});
ok('部分更新不会抹掉同条目的其它字段', () => {
    const p = profiles.patch(SERVER, { traits: [{ id: 'shared-ip', impact: '不能盲扫端口' }] });
    assert.strictEqual(p.traits[0].detail, '只租到部分端口', '旧 detail 不该丢');
    assert.strictEqual(p.traits[0].impact, '不能盲扫端口', '新 impact 应写入');
});
ok('端口映射增量追加', () => {
    profiles.patch(SERVER, {
        portMap: [
            { id: 'pm-openlist', public: 10207, internal: 5244, app: 'openlist', source: 'owner' },
            { id: 'pm-unknown', app: '资金交易接口', note: '对照关系不在此台机器上，待查', source: 'agent' },
        ],
    });
    const p = profiles.get(SERVER.id);
    assert.strictEqual(p.portMap.length, 2);
    assert.strictEqual(p.portMap[0].public, 10207);
    assert.strictEqual(p.portMap[1].public, null, '不知道对外端口时 public 应为 null 而不是编一个');
});
ok('removeTraitIds 能删掉指定条目', () => {
    const p = profiles.patch(SERVER, { removeTraitIds: ['shared-ip'] });
    assert.strictEqual(p.traits.find((t) => t.id === 'shared-ip'), undefined);
});
ok('resolveQuestions 按包含匹配移除待确认项', () => {
    profiles.patch(SERVER, { openQuestions: ['navidrome 的对外端口是多少？', 'CloudDrive 挂的是哪家的网盘？'] });
    const p = profiles.patch(SERVER, { resolveQuestions: ['navidrome 的对外端口'] });
    assert.strictEqual(p.openQuestions.length, 1);
    assert.ok(p.openQuestions[0].includes('CloudDrive'));
});
ok('时间线追加而不是替换', () => {
    profiles.patch(SERVER, { timeline: [{ at: '2026-11-19', kind: 'decision', text: '决定给每台机器建档案' }] });
    profiles.patch(SERVER, { timeline: [{ at: '2026-11-19', kind: 'note', text: '又记了一条' }] });
    assert.strictEqual(profiles.get(SERVER.id).timeline.length, 2);
});

console.log('[3] 一致性加固');
ok('非法 serverId（含路径分隔符）被拒绝', () => {
    assert.throws(() => profiles.get('../../etc/passwd'));
    assert.throws(() => profiles.patch({ id: 'a/b' }, { summary: 'x' }));
});
ok('summaries 只回统计，不回全文', () => {
    const s = profiles.summaries();
    const entry = s.get(SERVER.id);
    assert.ok(entry);
    assert.strictEqual(entry.traitCount, 0);
    assert.strictEqual(entry.portMapCount, 2);
    assert.strictEqual(entry.openQuestionCount, 1);
    assert.strictEqual(entry.traits, undefined, '摘要对象里不该带 traits 列表');
    assert.strictEqual(entry.timeline, undefined, '摘要对象里不该带时间线全文');
});
ok('坏档案文件不拖垮 summaries', () => {
    fs.writeFileSync(path.join(profileDir, 'broken-xxxxxx.json'), '{ 这不是 JSON', 'utf8');
    const s = profiles.summaries();
    assert.ok(s.get(SERVER.id), '好档案仍应读得出');
    assert.ok(!s.has('broken-xxxxxx'), '坏档案应被跳过');
    fs.unlinkSync(path.join(profileDir, 'broken-xxxxxx.json'));
});
ok('audit 发现缺档案 / 孤儿档案 / 凭证泄漏', () => {
    profiles.patch({ id: 'orphan-zzz9', name: '已删掉的机器' }, { summary: '孤儿' });
    // 泄漏检测看的是**磁盘上的原文**，所以直接把一个带 password 字段的手写档案写进去。
    // 密码值运行时拼出来（源码里不留字面量，否则发布闸门会把它当真密码拦下）。
    const fakePw = ['hunter', '2', 'hunter', '2'].join('');
    const leakDir = path.join(tmp, 'leak');
    fs.mkdirSync(leakDir, { recursive: true });
    const leaky = path.join(leakDir, 'leaky-aaaa.json');
    fs.writeFileSync(leaky, JSON.stringify({ version: 1, serverId: 'leaky-aaaa', password: fakePw }), 'utf8');
    const leakProfiles = createProfiles({ profileDir: leakDir });
    const audit = profiles.audit([SERVER]);
    assert.deepStrictEqual(audit.missingProfile, [], 'SERVER 有档案，不该报缺');
    assert.ok(audit.orphanProfile.includes('orphan-zzz9'), '孤儿档案应被发现');
    assert.strictEqual(leakProfiles.audit([{ id: 'leaky-aaaa' }]).leaks.length, 1, '档案里的 password 字段应被揪出');
});

console.log('[4] 渲染');
ok('渲染含各分区与来源标记', () => {
    const p = profiles.get(SERVER.id);
    const text = renderProfile(p);
    assert.ok(text.includes('音乐服务器'), text);
    assert.ok(text.includes('对外端口 → 内部'), '应有端口映射分区');
    assert.ok(text.includes(':10207 → :5244'), '端口映射应可读');
    assert.ok(text.includes('待确认'), '应有待确认分区');
    assert.ok(text.includes('时间线'), '应有时间线分区');
});
ok('无档案时渲染成提示而不是空白', () => {
    assert.ok(renderProfile(null).includes('还没有档案'));
});
ok('summary 一行渲染不换行', () => {
    const line = renderProfileLine({ summary: '共享 IP', traitCount: 3, portMapCount: 2, constraintCount: 1, openQuestionCount: 4 });
    assert.ok(!line.includes('\n'));
    assert.ok(line.includes('3 特征') && line.includes('2 端口映射'));
});

console.log('[5] 文件系统边界');
ok('档案落在 profileDir 里，文件名就是 serverId', () => {
    assert.ok(fs.existsSync(path.join(profileDir, `${SERVER.id}.json`)));
});
ok('档案文件是 UTF-8 无 BOM', () => {
    const raw = fs.readFileSync(path.join(profileDir, `${SERVER.id}.json`));
    assert.notStrictEqual(raw[0], 0xEF, '不应有 BOM');
});
ok('档案不写密码字段（除非有人硬塞）', () => {
    const raw = fs.readFileSync(path.join(profileDir, `${SERVER.id}.json`), 'utf8');
    assert.ok(!/"password"\s*:/i.test(raw));
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
fs.rmSync(tmp, { recursive: true, force: true });
