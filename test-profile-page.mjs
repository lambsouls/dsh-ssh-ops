// test-profile-page.mjs —— 档案页面（独立 HTML）的自测。
//
// 这个页面的特殊性：它把「本机档案」摊开成一个**网页**。所以两类测试缺一不可：
//   ① **内容完整** —— 七个分区该有的都在（它是给人看的，缺了就白打开）；
//   ② **转义正确** —— 档案里的文本可能来自模型输出或用户输入，
//      直接插进 HTML 就是 XSS。这是这个文件最该守的东西。
//
// 用法：node test-profile-page.mjs
import assert from 'node:assert';
import { renderProfilePage, esc } from './lib/profile-html.js';

let passed = 0;
function ok(label, fn) {
    try { fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (error) { console.error(`  ✗ ${label}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

const SERVER = { id: 'demo-abc123', name: '演示机', host: '10.0.0.5', port: 2222, user: 'root' };
const PROFILE = {
    version: 1, serverId: 'demo-abc123', name: '演示机', host: '10.0.0.5',
    createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T10:00:00.000Z',
    summary: '与别人共享公网 IP，只租到部分端口',
    role: '音乐服务器',
    traits: [
        { id: 'shared-ip', title: '与别人共享公网 IP', kind: 'network', severity: 'critical', detail: '只租到一部分端口', impact: '不能盲扫', evidence: '用户告知', source: 'owner', since: '2026-11-19' },
        { id: 'net-drive', title: '音乐在网盘挂载上', kind: 'storage', severity: 'warn', detail: null, impact: '别全库 rescan', evidence: null, source: 'probe', since: null },
    ],
    portMap: [
        { id: 'pm-a', public: 10207, internal: 5244, app: 'openlist', proto: 'http', note: null, source: 'owner' },
        { id: 'pm-b', public: null, internal: 4533, app: 'navidrome', proto: 'http', note: '对外端口待确认', source: 'agent' },
    ],
    constraints: [{ id: 'c-a', text: '不要扫描共享 IP 的端口', severity: 'critical', source: 'owner' }],
    runbooks: [{ id: 'rb-a', name: '离线更新镜像', when: '要装新镜像时', steps: ['中转机取包', '本机 curl', 'docker build'], verifiedAt: '2026-10-13', source: 'probe' }],
    timeline: [
        { at: '2026-11-19T09:00:00.000Z', kind: 'decision', text: '决定给每台机器建档' },
        { at: '2026-11-19T10:00:00.000Z', kind: 'incident', text: '扫了端口，被指出不该做' },
    ],
    openQuestions: ['navidrome 的对外端口是多少？'],
};

console.log('[1] 内容完整：七个分区都在');
const html = renderProfilePage(SERVER, PROFILE);
for (const [label, needle] of [
    ['标题含机器名', '演示机'],
    ['摘要', '与别人共享公网 IP'],
    ['专属特征区', '专属特征'],
    ['特征标题', '与别人共享公网 IP'],
    ['特征影响', '不能盲扫'],
    ['端口映射区', '对外端口'],
    ['端口数字', '10207'],
    ['端口说明', 'navidrome'],
    ['硬约束区', '硬约束'],
    ['约束正文', '不要扫描共享 IP 的端口'],
    ['处置区', '常用处置'],
    ['处置步骤', '中转机取包'],
    ['待确认区', '待确认'],
    ['待确认正文', 'navidrome 的对外端口'],
    ['时间线区', '时间线'],
    ['时间线条目', '决定给每台机器建档'],
    ['来源标记', '用户告知'],
    ['更新日期', '2026-11-19'],
]) {
    ok(label, () => assert.ok(html.includes(needle), `页面里找不到「${needle}」`));
}

console.log('[2] 转义（这是这个文件最该守的东西）');
ok('esc 处理五个 HTML 元字符', () => {
    assert.strictEqual(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});
ok('esc 对 null/undefined 返回空串而不是 "null"', () => {
    assert.strictEqual(esc(null), '');
    assert.strictEqual(esc(undefined), '');
});
ok('档案里塞 script 不会变成可执行标签', () => {
    const evil = {
        ...PROFILE,
        traits: [{ id: 'x', title: '<script>alert(1)</script>', kind: 'other', severity: 'note', detail: null, impact: null, evidence: null, source: 'agent', since: null }],
    };
    const page = renderProfilePage(SERVER, evil);
    assert.ok(!page.includes('<script>alert(1)</script>'), '标签原样出现了 —— 这是 XSS');
    assert.ok(page.includes('&lt;script&gt;'), '应转义后显示');
});
ok('属性注入（引号）被转义', () => {
    // 判据不能用「页面里有没有 onerror 字样」—— 转义之后它仍会作为**文本**出现，
    // 那不是漏洞。真正要断言的是：**没有被构造成标签/属性**。
    const evil = { ...SERVER, name: '"><img src=x onerror=alert(1)>' };
    const page = renderProfilePage(evil, PROFILE);
    assert.ok(!page.includes('<img src=x'), '构造出了真的 img 标签 —— 这是 XSS');
    assert.ok(!/["']\s*onerror\s*=/i.test(page), '构造出了真的 onerror 属性 —— 这是 XSS');
    assert.ok(page.includes('&quot;&gt;&lt;img'), '应整体转义成文本');
    // 同时确认它确实落在 title 里（而不是被悄悄丢掉）
    assert.ok(/<title>[^<]*&quot;&gt;&lt;img/.test(page), '机器名应出现在 title 且已转义');
});
ok('用户输入里的 & 不会破坏排版', () => {
    const page = renderProfilePage({ ...SERVER, name: 'A & B' }, PROFILE);
    assert.ok(page.includes('A &amp; B'));
});
ok('端口备注里的尖括号被转义', () => {
    const evil = {
        ...PROFILE,
        portMap: [{ id: 'p', public: 1, internal: 2, app: 'x', proto: 'http', note: '<b>粗</b>', source: 'owner' }],
    };
    const page = renderProfilePage(SERVER, evil);
    assert.ok(!page.includes('<b>粗</b>'));
    assert.ok(page.includes('&lt;b&gt;'));
});

console.log('[3] 边界');
ok('没有档案时有明确的空状态文案', () => {
    const page = renderProfilePage(SERVER, null);
    assert.ok(page.includes('还没有档案'), '应有空状态提示');
    assert.ok(page.includes('演示机'), '标题仍应是机器名');
});
ok('各分区为空时不渲染空壳（不留空标题）', () => {
    const empty = { ...PROFILE, traits: [], portMap: [], constraints: [], runbooks: [], openQuestions: [], timeline: [] };
    const page = renderProfilePage(SERVER, empty);
    for (const title of ['专属特征', '对外端口', '硬约束', '常用处置', '待确认', '时间线']) {
        assert.ok(!page.includes(title), `空档案不该出现「${title}」标题`);
    }
});
ok('完全没有 server 也不崩', () => {
    assert.ok(renderProfilePage(null, PROFILE).length > 0);
});
ok('页面自包含：没有外部资源请求', () => {
    // 它可能在没网络的机器上打开，也可能被另存下来看。
    // 任何 http(s):// 的外链（src/href/@import）都不该有。
    assert.ok(!/<img[^>]+src=["']https?:/i.test(html), '有外部图片');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(html), '有外部样式');
    assert.ok(!/<script[^>]+src=/i.test(html), '有外部脚本');
    assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(html), 'CSS 里有外部 @import');
});
ok('页面声明了 UTF-8 与 viewport', () => {
    assert.ok(html.includes('<meta charset="utf-8">'));
    assert.ok(html.includes('name="viewport"'));
});
ok('页面不带 referrer（不把本页地址漏给外部）', () => {
    assert.ok(html.includes('name="referrer"') && html.includes('no-referrer'));
});
ok('配色有深浅两套兜底（独立打开也能读）', () => {
    assert.ok(html.includes('prefers-color-scheme: dark'), '缺深色兜底');
    // 主题令牌要有兜底值：在 DSH 里跟随主题，独立打开时也不能是纯黑字纯白底
    assert.ok(/var\(--dsw-alias-[a-z-]+,\s*#[0-9a-f]{3,6}\)/i.test(html), '主题令牌缺兜底值');
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
