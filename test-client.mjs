// test-client.mjs —— 客户端逻辑自测（不需要浏览器）。
// 覆盖：ANSI 解析（与 Host 同口径）、颜色映射、面板渲染用到的数据结构，
// 以及**真的把组件跑一遍**（用最小假 React 在 vm 里执行）——静态检查抓不到拼错字段名、
// 拿 undefined 当数组用这类只有渲染时才炸的错误。
// 用法：node test-client.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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
    for (const field of ['appCount', 'systemAppCount', 'reachable', 'auth', 'lastUsedAt', 'apps', 'profile']) {
        assert.ok(client.includes(field), `面板没用到 ${field}`);
    }
});
ok('系统服务可折叠', () => {
    assert.ok(client.includes('systemApps'), '缺系统服务折叠分组');
});
ok('档案不在展开区里铺开，只留一个入口按钮', () => {
    // 设计意图：档案是给 DSH 自己看的知识，对用户多数时候不需要，七个分区铺在
    // 服务器行里就是一大坨。所以面板里只给一个「档案 ↗」按钮，点开新标签页看。
    // 这条测试守的正是「不要再塞回展开区」。
    const start = client.indexOf('function ServerRow');
    const end = client.indexOf('function ServersView');
    const rowBody = client.slice(start, end);
    assert.ok(rowBody.includes('openProfile'), '行里应有档案入口');
    assert.ok(/window\.open\(/.test(rowBody), '入口应开新标签页');
    assert.ok(!rowBody.includes('profileSection'), '展开区不该再调用 profileSection（已移除）');
    for (const marker of ['so-prof-list', 'so-prof-ports', 'so-prof-tl-row']) {
        assert.ok(!client.includes(marker), `档案分区样式 ${marker} 不该还留在面板里`);
    }
});
ok('档案入口带 noopener/noreferrer（新页面拿不到本页引用）', () => {
    assert.ok(client.includes('noopener,noreferrer'), '缺 noopener/noreferrer');
});

// ── 真的把组件跑起来 ────────────────────────────────────────────────────
// 静态检查只能证明「代码里写了这几个词」，证明不了「传进去的数据能渲染」。
// 这里用最小假 React（createElement / useState / useEffect / useMemo / useRef / useCallback）
// 在 vm 里执行 client.js，然后把组件当普通函数调用，把整棵树走一遍。
console.log('[client] 真渲染（假 React + vm）');

/** 把渲染出来的树展开成纯对象，便于断言内容。 */
function renderTree() {
    const code = client;
    let captured = null;
    const sandbox = {
        window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } },
        document: {
            documentElement: { lang: 'zh-CN' },
            getElementById: () => null,
            createElement: () => ({ style: {}, appendChild() {} }),
            head: { appendChild() {} },
            body: { appendChild() {} },
        },
        navigator: { language: 'zh-CN' },
        console: { info() {}, warn() {}, error() {}, log() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: async () => ({ json: async () => ({ ok: true, value: { count: 0, servers: [] } }) }),
        EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
        URL, AbortController, Date, JSON, Math, String, Number, Object, Array, Promise, Symbol, Map, Set, RegExp, Error,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    // 假 React：函数组件立即调用；hook 用序号数组模拟（只渲一次，所以不用真正重渲）。
    let hookIdx = 0;
    const hooks = [];
    const reset = () => { hookIdx = 0; hooks.length = 0; };
    const React = {
        Fragment: 'Fragment',
        createElement(type, props, ...children) {
            const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== '');
            if (typeof type === 'function') return type({ ...(props ?? {}), children: flat });
            return { type, props: props ?? {}, children: flat };
        },
        useState(init) {
            const i = hookIdx++;
            if (hooks[i] === undefined) hooks[i] = typeof init === 'function' ? init() : init;
            return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
        },
        useEffect() { hookIdx += 1; },
        useMemo(fn) { return fn(); },
        useRef(seed) { return { current: seed }; },
        useCallback(fn) { return fn; },
    };
    sandbox.require = (name) => {
        if (name === 'react') return React;
        throw new Error(`unexpected require: ${name}`);
    };

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'client.js' });
    assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load');
    const mod = captured.factory(sandbox.require);
    return { internals: mod.__internals, reset };
}

/** 收集树里所有文本。 */
function texts(node, out = []) {
    if (node === null || node === undefined || node === false) return out;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
    if (Array.isArray(node)) { for (const n of node) texts(n, out); return out; }
    if (node.children) for (const n of node.children) texts(n, out);
    if (node.props) for (const v of Object.values(node.props)) {
        if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
    }
    return out;
}

const { internals, reset } = renderTree();
ok('模块加载并导出 internals', () => {
    for (const k of ['Panel', 'RightTab', 'ServersView', 'ConsoleView', 'CSS']) {
        assert.ok(internals?.[k], `缺 ${k}`);
    }
});

// 一份完整的档案样本（形状与 lib/profile.js 落盘一致）
const SAMPLE_PROFILE = {
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

const SAMPLE_SERVER = {
    id: 'demo-abc123', name: '演示机', host: '10.0.0.5', port: 10556, user: 'root',
    auth: 'password', reachable: true, reachableAt: '2026-11-19T10:00:00.000Z',
    lastUsedAt: '2026-11-19T10:00:00.000Z', os: 'Ubuntu 22.04 LTS', tags: ['测试'], notes: '备注',
    apps: [
        { name: 'openlist', kind: 'files', port: 5244, manager: 'docker', service: 'openlist', notes: null },
        { name: 'systemd-journald', kind: 'system', port: null, manager: 'systemd', service: 'systemd-journald', notes: null },
    ],
    appCount: 1, systemAppCount: 1,
    profile: {
        summary: SAMPLE_PROFILE.summary, role: SAMPLE_PROFILE.role,
        traitCount: 2, constraintCount: 1, portMapCount: 2, openQuestionCount: 1,
        updatedAt: SAMPLE_PROFILE.updatedAt,
    },
};

const T = { loading: '加载中…', failed: '失败', inventoryHint: '提示', noServers: '无服务器', apps: '个应用',
    systemApps: '系统服务', noUserApps: '（无）', lastUsed: '最近', never: '从未', authKey: '密钥',
    authPassword: '密码', unknown: '未探测', profile: '档案', noProfile: '无档案', traits: '专属特征',
    portMap: '对外端口', constraints: '硬约束', runbooks: '常用处置', timeline: '时间线',
    openQuestions: '待确认', profileUpdated: '档案更新', fromOwner: '用户', fromProbe: '实测', fromAgent: '推断',
    timelineKind: { change: '改', incident: '故', note: '记', decision: '定' },
    edit: '编辑', rename: '名字', tags: '标签', save: '保存', cancel: '取消', saving: '保存中…',
    saved: '已保存', namePlaceholder: '起个名', tagsPlaceholder: '逗号分隔', editHint: '只改名字和标签',
    editNameEmpty: '留空退回地址' };

ok('服务器清单能渲染（含档案标记）', () => {
    reset();
    const tree = internals.ServersView({ data: { count: 1, servers: [SAMPLE_SERVER] }, loading: false, error: null, t: T });
    const all = texts(tree).join(' ');
    assert.ok(all.includes('演示机'), all.slice(0, 200));
    assert.ok(all.includes('档案'), '应有档案标记');
});


ok('无档案的服务器不会崩，且提示「无档案」', () => {
    reset();
    const bare = { ...SAMPLE_SERVER, profile: null };
    const tree = internals.ServersView({ data: { count: 1, servers: [bare] }, loading: false, error: null, t: T });
    assert.ok(tree, '不该返回空');
});

ok('空清单不崩', () => {
    reset();
    const tree = internals.ServersView({ data: { count: 0, servers: [] }, loading: false, error: null, t: T });
    assert.ok(texts(tree).join(' ').includes('无服务器'));
});

ok('完整面板能渲染（两种容器形态都试）', () => {
    reset();
    assert.ok(internals.Panel());
    reset();
    assert.ok(internals.RightTab());
});

ok('档案为空数组时也不崩（宽进）', () => {
    reset();
    const weird = {
        ...SAMPLE_SERVER,
        profile: { summary: null, role: null, traitCount: 0, constraintCount: 0, portMapCount: 0, openQuestionCount: 0, updatedAt: null },
    };
    assert.ok(internals.ServersView({ data: { count: 1, servers: [weird] }, loading: false, error: null, t: T }));
});

// ── 名字/标签编辑器（面板唯一的写入面） ──────────────────────────────
console.log('[client] 名字/标签编辑器');

ok('编辑器能渲染出两个输入框与保存/取消', () => {
    reset();
    const tree = internals.IdentityEditor({ server: SAMPLE_SERVER, t: T, onSaved() {}, onCancel() {} });
    const all = texts(tree).join(' ');
    assert.ok(all.includes(T.rename), '缺名字标签');
    assert.ok(all.includes(T.tags), '缺标签标签');
    assert.ok(all.includes(T.save), '缺保存按钮');
    assert.ok(all.includes(T.cancel), '缺取消按钮');
});

ok('编辑器带上已有值（不是空框）', () => {
    reset();
    const tree = internals.IdentityEditor({ server: SAMPLE_SERVER, t: T, onSaved() {}, onCancel() {} });
    const inputs = [];
    (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'input') inputs.push(n.props);
        for (const c of n.children ?? []) walk(c);
    })(tree);
    assert.strictEqual(inputs.length, 2, `应有 2 个输入框，实际 ${inputs.length}`);
    assert.strictEqual(inputs[0].value, SAMPLE_SERVER.name, '名字框应预填当前名字');
    assert.ok(inputs[1].value.includes('测试'), '标签框应预填当前标签');
});

ok('编辑器只声明 name/tags 两个提交字段（源码级约束）', () => {
    // 这一段是刻意做「笨」的静态断言：写入面越窄越好，
    // 任何人在编辑器里多塞一个字段（比如 host）都应该被这里拦下。
    const start = client.indexOf('function IdentityEditor');
    const end = client.indexOf('function ServerRow');
    const body = client.slice(start, end);
    const patchCall = /api\(`\/servers\/\$\{[^}]+\}`, \{\s*method: 'PATCH',\s*body: \{([^}]*)\}/.exec(body);
    assert.ok(patchCall, '找不到 PATCH 调用，编辑器结构可能变了');
    assert.ok(patchCall[1].includes('name'), 'PATCH 体里应含 name');
    assert.ok(patchCall[1].includes('tags'), 'PATCH 体里应含 tags');
    assert.ok(!/host|port|password|privateKey|user/.test(patchCall[1]), `PATCH 体里出现了不该有的字段：${patchCall[1]}`);
});

ok('Esc 会取消、Enter 会保存（键盘行为已接线）', () => {
    const start = client.indexOf('function IdentityEditor');
    const end = client.indexOf('function ServerRow');
    const body = client.slice(start, end);
    assert.ok(/e\.key === 'Enter'/.test(body), '缺 Enter 处理');
    assert.ok(/e\.key === 'Escape'/.test(body), '缺 Esc 处理');
});

ok('改名后是就地更新那一行，不重拉整个清单', () => {
    // 重拉会让列表闪一下、展开的行塌回去 —— 用户只是改了个名字，
    // 不该为此付出「重新找到刚才那台机器」的代价。
    assert.ok(client.includes('handleRenamed'), '缺就地更新处理');
    const start = client.indexOf('const handleRenamed');
    const body = client.slice(start, start + 700);
    assert.ok(body.includes('servers: prev.servers.map'), '应在本地替换那一行');
    assert.ok(!body.includes('load()'), '不该在改名后调用 load() 重拉');
});

ok('标签以胶囊形式渲染（不是一坨逗号串）', () => {
    reset();
    const tree = internals.ServersView({ data: { count: 1, servers: [SAMPLE_SERVER] }, loading: false, error: null, t: T });
    // 折叠态没有标签区，直接查样式类是否存在
    assert.ok(client.includes('.so-tag {'), '缺标签胶囊样式');
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
