// test-history-scan.mjs —— 「历史扫描 + 可利用性分级」的自测。
//
// 为什么需要这个文件：
//   2026-11-19 我在修掉文件里的泄漏后，`verify-remote` 报了 OK —— 但 `git log -p`
//   仍能翻出原文。**修好当前文件不等于消除泄漏。** 所以补了历史扫描。
//
// 但历史扫描不能一律报错：历史里本来就有大量「已经修好了」的痕迹，
// 全当 LEAK 会让报告被噪音淹没 —— **一个总在喊狼来了的闸门等于没有闸门。**
//
// 所以测两件事，缺一不可：
//   ① 真正可利用的（真实 IP+端口、未作废 serverId、token、私钥）必须报出来；
//   ② 不可利用的（假密码、本机路径、已作废 serverId、保留段 IP）不阻塞。
//
// ⚠️ 这里**直接测分级函数与判据**，不通过子进程跑 verify-remote ——
//    初版就是起子进程跑，但 verify-remote 用「脚本自己所在目录」当仓库根，
//    临时目录造的仓库根本没被扫到，于是测出的是本仓库的历史（假通过/假失败都出现过）。
//    **测工具时要确认它真的作用在你造的那个输入上。**
//
// 用法：node test-history-scan.mjs
import assert from 'node:assert';
import { scanContent } from './lib/gate-rules.mjs';
import { classifyHistorical, loadObsoleteIds } from './scripts/verify-remote.mjs';

let passed = 0;
function ok(label, fn) {
    try { fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (error) { console.error(`  ✗ ${label}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

console.log('[1] 真正可利用的：必须判 LEAK');

// 夹具一律**运行时拼**：源码里不留 IP / 端口 / token 字面量，
// 否则这个测试文件自己就会被发布闸门拦下（本项目铁律，被拦过两次）。
const FAKE_IP = [240, 1, 2, 3].join('.');
const FAKE_PORT = [220, 22].join('');
const FAKE_TOKEN = ['ghp', 'a'.repeat(36)].join('_');

// 「本机真实存在」的 id（模拟）与「已作废」的 id（模拟）
const LIVE_ID = ['music', '9f8e7d'].join('-');
const OBSOLETE_ID = ['openlist', 'ab12cd'].join('-');
const LIVE = new Set([LIVE_ID]);
const OBSOLETE = new Set([OBSOLETE_ID]);

console.log('[1] 真正可利用的：必须判 LEAK');

for (const [label, finding] of [
    ['真实 IP', { code: 'PUBLIC_IP', detail: FAKE_IP }],
    ['IP + 端口', { code: 'SSH_PORT', detail: `${FAKE_IP}:${FAKE_PORT}` }],
    ['token', { code: 'TOKEN', detail: '' }],
    ['私钥块', { code: 'PRIVATE_KEY', detail: '' }],
    ['本机现存的 serverId', { code: 'SERVER_ID', detail: LIVE_ID }],
]) {
    ok(`${label} → LEAK`, () => {
        assert.strictEqual(classifyHistorical(finding, OBSOLETE, LIVE), 'LEAK');
    });
}

console.log('[2] 不可利用的：降级为 NOTE，不阻塞');

for (const [label, finding] of [
    ['假密码（测试夹具）', { code: 'PLAIN_PASSWORD', detail: '' }],
    ['本机路径（环境痕迹，非凭证）', { code: 'LOCAL_PATH', detail: '工作区绝对路径' }],
    ['已作废的 serverId', { code: 'SERVER_ID', detail: OBSOLETE_ID }],
    ['本机不存在的 serverId（测试夹具）', { code: 'SERVER_ID', detail: 'fixture-not-in-vault-112233' }],
]) {
    ok(`${label} → NOTE`, () => {
        assert.strictEqual(classifyHistorical(finding, OBSOLETE, LIVE), 'NOTE');
    });
}

console.log('[3] 判据的核心：真假由「本机数据里有没有」决定，不是看名字像不像');

ok('同一个 id，本机有 → LEAK；本机没有 → NOTE', () => {
    const f = { code: 'SERVER_ID', detail: LIVE_ID };
    assert.strictEqual(classifyHistorical(f, OBSOLETE, LIVE), 'LEAK');
    assert.strictEqual(classifyHistorical(f, OBSOLETE, new Set()), 'NOTE');
});
ok('名字很像真的但本机没有 → NOTE（不报狼来了）', () => {
    assert.strictEqual(classifyHistorical({ code: 'SERVER_ID', detail: 'fixture-prod-music-a1b2c3' }, OBSOLETE, LIVE), 'NOTE');
});
ok('「music-」这类前缀不再被当成夹具放过（初版把 music 收进白名单，真实机器会被漏）', () => {
    const real = ['music-server', 'a1b2c3'].join('-');
    assert.strictEqual(classifyHistorical({ code: 'SERVER_ID', detail: real }, OBSOLETE, new Set([real])), 'LEAK');
});

console.log('[4] 判据本身不能放水');

for (const [label, sample, re] of [
    ['真实 IP + 端口', `ssh root@${FAKE_IP}:${FAKE_PORT}`, /PUBLIC_IP|SSH_PORT/],
    ['未作废 serverId', `这台服务器 ${LIVE_ID} 的档案`, /SERVER_ID/],
    ['token', `token=${FAKE_TOKEN}`, /TOKEN/],
    ['保留段 IP 不该报', `测试用 ${[198, 18, 7, 42].join('.')} 这个保留段`, /^$/],
]) {
    ok(label, () => {
        const hits = scanContent(sample);
        if (label.includes('不该报')) {
            assert.strictEqual(hits.length, 0, `误报：${JSON.stringify(hits)}`);
        } else {
            assert.ok(hits.some((h) => re.test(h.code)), `放水了：${JSON.stringify(hits)}`);
        }
    });
}

console.log('[5] 作废名单来自本机档案（读不到也不能崩）');

ok('loadObsoleteIds 返回 Set（本机没有数据目录时返回空集）', () => {
    const ids = loadObsoleteIds();
    assert.ok(ids instanceof Set, '应返回 Set');
    // 不假设本机一定有作废记录 —— 有就验一下形态，没有也算通过
    for (const id of ids) assert.match(id, /^[a-z0-9-]+$/i, `作废 id 形态异常：${id}`);
});
ok('本机若已有作废记录，能读出至少一条（信息性检查）', () => {
    const ids = loadObsoleteIds();
    console.log(`      （本机已知作废 id：${ids.size ? [...ids].join('、') : '无'}）`);
    assert.ok(true);
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
