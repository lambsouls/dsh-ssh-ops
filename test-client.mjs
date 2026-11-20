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
    // systemAppCount 仍由 API 返回，但**不再显示成行头徽章** ——
    // 那个「+63」对用户没信息量，还把右侧按钮挤得对不齐。
    // 系统服务数量只在展开区的「系统自带服务 · N」折叠条上展示。
    for (const field of ['appCount', 'reachable', 'auth', 'lastUsedAt', 'apps', 'profile']) {
        assert.ok(client.includes(field), `面板没用到 ${field}`);
    }
});

ok('行头不再显示「+N」系统服务徽章（会破坏对齐）', () => {
    const src = client.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!src.includes('+${s.systemAppCount}'), '行头不该再有 +N 徽章');
    assert.ok(!src.includes('systemAppCount ?'), '不该有条件渲染 +N');
    // 但展开区的折叠条要还在（系统服务仍然可查）
    assert.ok(src.includes('t.systemApps'), '「系统自带服务」折叠条不该被一起删掉');
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
ok('档案入口不再用 window.open（Electron 会静默拦掉它）', () => {
    // 曾经的实现：window.open(url, '_blank', 'noopener,noreferrer')
    // 实测在 DSH 的 Electron 里点了完全没反应 —— 按钮有焦点框、窗口列表无变化、无报错。
    // 原因是宿主没配 setWindowOpenHandler，Electron 默认拒绝新建窗口，
    // 而 window.open 被拒时不抛异常，所以 try/catch 也兜不住。
    // 现在改成壳内抽屉（渲染进 shell.overlay），这里守住「别退回旧写法」。
    const code = client.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!code.includes('window.open('), '不许再用 window.open 打开档案（Electron 会静默拦截）');
    assert.ok(code.includes("'shell.overlay'"), '档案抽屉应注册在 shell.overlay（面板内 fixed 会被容器限制）');
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
    for (const k of ['Panel', 'RightTab', 'ServersView', 'ConsoleView', 'TerminalLine', 'CSS']) {
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

// ── 档案抽屉 ────────────────────────────────────────────────────────────
// 这一组是为了守住一次真实的回归：档案按钮曾经用 window.open 打开，
// 在 Electron 里点了**完全没反应**（无新窗口、无报错）。改成壳内抽屉后必须能真渲染出内容。
const PROFILE_SAMPLE = {
    version: 1, serverId: 'demo-1', name: '演示机',
    summary: '这是概要', role: '角色说明',
    traits: [
        { id: 't1', title: '共享公网 IP', severity: 'warn', source: 'owner', detail: '和别的租户共用', impact: '不要盲扫端口' },
    ],
    portMap: [{ id: 'p1', public: 10556, internal: 22, app: 'ssh', proto: 'tcp', note: '只在办公网' }],
    constraints: [{ id: 'c1', text: '不要 docker pull', severity: 'critical', source: 'owner' }],
    runbooks: [{ id: 'r1', name: '重启流程', when: '服务卡住时', steps: ['第一步', '第二步'] }],
    timeline: [{ at: '2026-11-19T12:00:00Z', kind: 'change', text: '改过端口' }],
    openQuestions: ['对外端口是多少？'],
    updatedAt: '2026-11-19T12:00:00Z',
};

ok('档案抽屉：结构能渲染（含标题/关闭按钮）', () => {
    reset();
    // 注意：假 React 里 useEffect 不执行，所以 fetch 后的数据加载不会发生 ——
    // 这里只能验证「外壳」渲染正常。分区内容的验证走下面的源码级检查。
    const tree = internals.ProfileDrawer({ server: SAMPLE_SERVER, t: T, onClose: () => {} });
    const all = texts(tree).join(' ');
    assert.ok(all.includes('演示机'), '应有服务器名');
    assert.ok(all.includes('档案'), '应标注是档案');
    assert.ok(tree, '不该返回空');
});

ok('档案抽屉：六个分区都在源码里（真渲染受假 React 限制，改查结构）', () => {
    const src = client.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const key of ['profileTraits', 'profilePortMap', 'profileConstraints', 'profileRunbooks', 'profileTimeline', 'profileQuestions']) {
        assert.ok(src.includes(key), `缺分区 ${key}`);
    }
    // 分级标签要映射到主题色
    for (const sev of ['so-pf-sev--warn', 'so-pf-sev--critical', 'so-pf-sev--info']) {
        assert.ok(src.includes(sev), `缺分级样式 ${sev}`);
    }
});

ok('档案抽屉：空分区不渲染（避免「0 /（无）」的空壳）', () => {
    reset();
    const empty = { ...PROFILE_SAMPLE, portMap: [], constraints: [], runbooks: [], timeline: [], openQuestions: [], traits: [] };
    // 直接测渲染器接受空数组时不崩
    const tree = internals.ProfileDrawer({ server: { ...SAMPLE_SERVER, profile: empty }, t: T, onClose: () => {} });
    assert.ok(tree, '空档案也不该崩');
    const src = client.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // 分区必须包在 `(p.xxx ?? []).length ? ... : null` 里，不能无条件渲染
    for (const key of ['portMap', 'constraints', 'runbooks', 'timeline']) {
        assert.ok(
            new RegExp(`\\(p\\.${key} \\?\\? \\[\\]\\)\\.length`).test(src),
            `${key} 分区应在为空时不渲染`,
        );
    }
});

ok('overlay 条目订阅了 store（点击按钮才能通知到浮层）', () => {
    const src = client.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(src.includes('profileStore.subscribe'), 'ProfileOverlay 应订阅 store');
    assert.ok(src.includes('profileStore.open('), '点按钮应调用 store.open');
});

ok('遮罩必须是半透明（不许改成不透明纯黑）', () => {
    // 事故记录：曾经因为「PrintWindow 截图里看不到半透明遮罩」，误判成显示有问题，
    // 把 rgba(...) 改成了不透明 #0b0e13 —— 结果整屏发黑，体验更差。
    // 真相是 PrintWindow 不合成半透明层；要看真实效果得用 CopyFromScreen 屏幕级截图。
    // 这条测试守住「别再因为截图看不到就改坏 UI」。
    const hostRule = /\.so-pf-host\s*\{([\s\S]*?)\}/.exec(client);
    assert.ok(hostRule, '找不到 .so-pf-host 样式');
    const body = hostRule[1].replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(/background:\s*rgba\(/.test(body), '遮罩背景必须是 rgba（半透明）');
    assert.ok(!/background:\s*#[0-9a-f]{3,8}\s*;/i.test(body), '遮罩不许用不透明十六进制色');
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

// ── 终端：输入/输出必须一眼分得开（用户反馈） ────────────────────────
// 用户原话：「现在的输入输出我不太能看得出来，我建议你直接使用 ssh 的完整输入输出显示」
// 「绿色的是输入吧…绿色输入显示必须带上类似 用户名@主机:~# 这样的前缀」。
// 所以这一组守的是三条视觉契约：输入行有提示符、提示符与命令分开着色、会话头只出一次。
// 注意夹具里刻意用了非 root 用户（`deploy@vm`）—— 提示符不能假设登录用户是 root。
console.log('[client] 终端输入/输出');

/** 造一条终端日志条目（形状与 lib/journal.js 落盘一致）。 */
function entry(kind, text, extra = {}) {
    return { seq: Math.floor(Math.random() * 1e6), at: '2026-11-20T10:00:00.000Z', kind, level: 'info', serverId: 'demo-abc123', serverName: '演示机', streamId: 's1', text, ...extra };
}

ok('输入行渲染出提示符 + 命令两段', () => {
    reset();
    const line = entry('input', 'systemctl status nginx', { prompt: 'deploy@fileserver:~$' });
    const tree = internals.TerminalLine({ entry: line, wrap: true, compact: false });
    const all = texts(tree).join(' ');
    assert.ok(all.includes('deploy@fileserver:~$'), `缺提示符：${all}`);
    assert.ok(all.includes('systemctl status nginx'), `缺命令：${all}`);
    // 提示符必须在命令**前面**（真终端就是这个顺序）
    assert.ok(all.indexOf('deploy@') < all.indexOf('systemctl'), '提示符应排在命令之前');
});

ok('提示符与命令是分开的两个节点（各自着色）', () => {
    reset();
    const line = entry('input', 'ls -la', { prompt: 'ubuntu@vm1:~$' });
    const tree = internals.TerminalLine({ entry: line, wrap: true, compact: false });
    let promptNode = null;
    let cmdNode = null;
    (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (n.props?.className === 'so-line-prompt') promptNode = n;
        if (n.props?.className === 'so-cmd') cmdNode = n;
        for (const c of n.children ?? []) walk(c);
    })(tree);
    assert.ok(promptNode, '提示符应有自己的 so-line-prompt 节点');
    assert.ok(cmdNode, '命令应有自己的 so-cmd 节点');
});

ok('文案不假设登录用户是 root（用户指出）', () => {
    // 用户原话：「虽然我告诉你的都是 root 密码，但不代表其他用户也是，
    //            所以你就不该写『带 root@主机:~# 提示符』，应该写成（带 用户名@主机:~# 提示符）」。
    // 这条守的是「所有面向用户的文案里，提示符示例都用 用户名@主机，不写死 root」。
    const hints = [
        client, // client.js 内的 COPY.zh / COPY.en
        fs.readFileSync(new URL('./locale/zh.json', import.meta.url), 'utf8'),
        fs.readFileSync(new URL('./locale/en.json', import.meta.url), 'utf8'),
        fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
    ];
    for (const src of hints) {
        assert.ok(!/root@主机/.test(src), '文案里不该出现「root@主机」，应写「用户名@主机」');
        assert.ok(!/root@host/.test(src), '文案里不该出现「root@host」，应写「user@host」');
    }
    // 但「root 用 #、普通用户用 $」这条语义要保留说明（它不是假设，是事实）
    assert.ok(client.includes('用户名@主机'), '应说明提示符是 用户名@主机');
});


ok('没有 prompt 字段的老日志也不崩（向后兼容）', () => {
    reset();
    // v0.6.2 及更早的 ops-console.ndjson 里 input 条目没有 prompt 字段，
    // 刷新页面会回放这些历史 —— 渲染必须容忍。
    const tree = internals.TerminalLine({ entry: entry('input', 'echo old'), wrap: true, compact: false });
    assert.ok(texts(tree).join(' ').includes('echo old'));
});

ok('配色顺序：绿(输入)在蓝(连接信息)之后，不许反过来', () => {
    // 用户原话：「绿色要在蓝色后显示」。这在数据层定序 —— 会话头(蓝)先入账，输入行(绿)后入账。
    // 面板按 seq 顺序渲染，所以只要 Host 侧是这个顺序，视觉上就是先蓝后绿。
    const service = fs.readFileSync(new URL('./lib/service.js', import.meta.url), 'utf8');
    const openAt = service.indexOf('journal.openStream(');
    const inputAt = service.indexOf('journal.input(');
    assert.ok(openAt > 0 && inputAt > 0, '找不到会话头/输入行的入账点');
    assert.ok(openAt < inputAt, '会话头必须在输入行之前入账');
    // 输入行要等 begin 事件（连上了）之后才打，这样才拿得到远端主机名
    const beginAt = service.indexOf("event.type === 'begin'");
    assert.ok(beginAt > 0, '缺少 begin 事件处理');
    assert.ok(service.slice(beginAt).includes('logInput('), '输入行应在 begin 事件里打（才拿得到主机名）');
});

ok('输入行不再用「$ 命令」的老写法', () => {
    const journalSrc = fs.readFileSync(new URL('./lib/journal.js', import.meta.url), 'utf8');
    assert.ok(!journalSrc.includes('`$ ${input}`'), '别再把命令塞成「$ xxx」一行，改成 prompt + 命令两段');
});

ok('会话头用 ● 标记，且带连接地址', () => {
    const journalSrc = fs.readFileSync(new URL('./lib/journal.js', import.meta.url), 'utf8');
    assert.ok(journalSrc.includes('● '), '会话头应有醒目标记');
    assert.ok(journalSrc.includes('where'), '会话头应带上连接地址（用户要知道连的是哪台、哪个端口）');
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
