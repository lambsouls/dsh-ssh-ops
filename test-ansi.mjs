// test-ansi.mjs —— ANSI 解析自测（Host 与 Client 两份实现必须一致）。
import assert from 'node:assert';
import { stripAnsi, parseAnsi, styleAtEnd } from './lib/ansi.js';

let passed = 0;
function ok(label, fn) {
    try { fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (e) { console.error(`  ✗ ${label}\n    ${e?.message ?? e}`); process.exitCode = 1; }
}

console.log('[ansi] stripAnsi');
ok('去掉基本颜色码', () => {
    assert.strictEqual(stripAnsi('\x1b[32mOK\x1b[0m done'), 'OK done');
});
ok('去掉 256 色与真彩', () => {
    assert.strictEqual(stripAnsi('\x1b[38;5;208mwarn\x1b[0m'), 'warn');
    assert.strictEqual(stripAnsi('\x1b[38;2;255;100;0mrgb\x1b[0m'), 'rgb');
});
ok('去掉光标/清屏/标题等非 SGR 序列', () => {
    assert.strictEqual(stripAnsi('\x1b[2J\x1b[H\x1b]0;title\x07body'), 'body');
});
ok('保留普通文本与换行', () => {
    assert.strictEqual(stripAnsi('a\nb\tc'), 'a\nb\tc');
});
ok('非字符串不炸', () => {
    assert.strictEqual(stripAnsi(null), '');
    assert.strictEqual(stripAnsi(undefined), '');
});

console.log('[ansi] parseAnsi');
ok('默认样式（无码）', () => {
    const spans = parseAnsi('plain');
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].text, 'plain');
    assert.strictEqual(spans[0].fg, null);
});
ok('绿色前景', () => {
    const spans = parseAnsi('\x1b[32mok\x1b[0m x');
    assert.strictEqual(spans[0].text, 'ok');
    assert.strictEqual(spans[0].fg, '#98c379');
    assert.strictEqual(spans[1].text, ' x');
    assert.strictEqual(spans[1].fg, null);
});
ok('亮红 + 粗体', () => {
    const spans = parseAnsi('\x1b[1;91mfail\x1b[0m');
    assert.strictEqual(spans[0].fg, '#ff7b86');
    assert.strictEqual(spans[0].bold, true);
});
ok('256 色', () => {
    const spans = parseAnsi('\x1b[38;5;208mo\x1b[0m');
    assert.ok(/^rgb\(/.test(spans[0].fg), spans[0].fg);
});
ok('真彩', () => {
    const spans = parseAnsi('\x1b[38;2;18;52;86mc\x1b[0m');
    assert.strictEqual(spans[0].fg, 'rgb(18,52,86)');
});
ok('背景色与反显', () => {
    const spans = parseAnsi('\x1b[41;7minv\x1b[0m');
    assert.strictEqual(spans[0].bg, '#e06c75');
    assert.strictEqual(spans[0].inverse, true);
});
ok('跨行继承样式', () => {
    const first = parseAnsi('\x1b[33mline1');
    const carried = styleAtEnd(first);
    const second = parseAnsi('line2', carried);
    assert.strictEqual(second[0].fg, '#e5c07b');
});
ok('中途 22 取消粗体但保留颜色', () => {
    const spans = parseAnsi('\x1b[1;32ma\x1b[22mb\x1b[0m');
    assert.strictEqual(spans[0].bold, true);
    assert.strictEqual(spans[1].bold, false);
    assert.strictEqual(spans[1].fg, '#98c379');
});
ok('docker 真实输出片段', () => {
    const line = '\x1b[32mopenlist\x1b[0m\t\x1b[1mUp 5 weeks\x1b[0m';
    const spans = parseAnsi(line);
    assert.strictEqual(spans[0].text, 'openlist');
    assert.strictEqual(spans[0].fg, '#98c379');
    assert.strictEqual(spans[1].text, '\t');
    assert.strictEqual(spans[2].text, 'Up 5 weeks');
    assert.strictEqual(spans[2].bold, true);
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
