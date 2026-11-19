// test-client.mjs —— 客户端逻辑自测（不需要浏览器）。
// 覆盖：ANSI 解析（与 Host 同口径）、颜色映射、面板渲染用到的数据结构。
// 用法：node test-client.mjs
import fs from 'node:fs';
import assert from 'node:assert';
import { parseAnsi, stripAnsi } from './lib/ansi.js';

let passed = 0;
function ok(label, fn) {
    try { fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (e) { console.error(`  ✗ ${label}\n    ${e?.message ?? e}`); process.exitCode = 1; }
}

const client = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');

console.log('[client] 静态检查');
ok('client.js 不含 import/export 语句（必须是经典脚本）', () => {
    assert.ok(!/^\s*import\s/m.test(client), '发现 import');
    assert.ok(!/^\s*export\s/m.test(client), '发现 export');
});
ok('注册了右侧栏 tab 类型与内容', () => {
    assert.ok(client.includes("ctx.sidebarRightTabs.register"), '缺 tab 类型注册');
    assert.ok(client.includes("'sidebar.right.pane.tab'"), '缺 tab 内容注册');
});
ok('注册了侧栏入口与主面板', () => {
    assert.ok(client.includes("'sidebar.panellist'"));
    assert.ok(client.includes("name: 'main'"));
});
ok('终端是黑底（不跟随主题变量作为背景）', () => {
    assert.ok(/\.so-term\s*\{[^}]*background:\s*#0d1117/.test(client), '终端背景不是黑底');
});
ok('样式没引用 @deepseek-ai 客户端包', () => {
    assert.ok(!client.includes('@deepseek-ai/dsh-client-ui-primitives'));
});
ok('所有颜色变量都来自主题令牌（除终端区）', () => {
    const tokens = [...client.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
    const bad = tokens.filter((t) => !t.startsWith('so-') && !t.startsWith('dsw-alias-') && !t.startsWith('dsw-specific-'));
    assert.deepStrictEqual(bad, [], `非主题令牌：${bad.join(', ')}`);
});

console.log('[client] ANSI 渲染口径（与 Host lib/ansi.js 一致）');
ok('彩色行 → spans', () => {
    const spans = parseAnsi('\x1b[1;32mok\x1b[0m rest');
    assert.strictEqual(spans[0].fg, '#98c379');
    assert.strictEqual(spans[0].bold, true);
    assert.strictEqual(spans[1].text, ' rest');
});
ok('真彩', () => {
    assert.strictEqual(parseAnsi('\x1b[38;2;1;2;3mx\x1b[0m')[0].fg, 'rgb(1,2,3)');
});
ok('stripAnsi 给模型看', () => {
    assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m plain'), 'red plain');
});

console.log('[client] 数据结构契约');
ok('服务器行需要的字段都在', () => {
    for (const field of ['appCount', 'systemAppCount', 'reachable', 'auth', 'lastUsedAt', 'apps']) {
        assert.ok(client.includes(field), `面板没用到 ${field}`);
    }
});
ok('系统服务可折叠', () => {
    assert.ok(client.includes('systemApps'), '缺系统服务折叠分组');
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
