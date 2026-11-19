// scripts/gate-selftest.mjs —— 闸门的对抗性自测：**证明它能拦住东西**。
//
// 一个没被对抗测试过的闸门，只是一段让人安心的代码。
// 这里造一批「应该被拦」和「不该被拦」的样本，实际跑闸门，比对结果。
//
// 注意：样本都是**运行时拼出来**的字符串 —— 如果写成字面量，这个文件自己就会被闸门拦下
// （这也顺便证明了闸门没有为「测试文件」开口子）。
//
// 用法：node scripts/gate-selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanPath, scanContent } from '../lib/gate-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, '_gate_probe');

// 用拼接伪造，避免本文件被自己的规则命中
const octet = (a, b, c, d) => [a, b, c, d].join('.');
// 用一个**不在白名单**里的公网地址形状。注意别用 203.0.113.x / 192.0.2.x ——
// 那些是 RFC 5737 文档保留段，已在 IP_ALLOW 里，测不出东西来。
const realIp = octet(198, 18, 7, 42);
const port = [105, 56].join('');                // 非默认 SSH 端口
const user = ['some', 'one'].join('');          // 看起来像真用户名
const strongPw = ['Correct', 'Horse', 'Battery', 99].join('');  // 纯字母数字的真密码形态
const pemBegin = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const pemEnd = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const fakeToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');

const SHOULD_BLOCK = [
    ['LOCAL_PATH', 'win-forward-slash.js', `const home = "C:/Users/${user}/AppData/Local";`],
    ['LOCAL_PATH', 'posix-home.js', `const p = "/home/${user}/project";`],
    // 回归用例：曾经漏过闸门并真的推到了 GitHub 上（只查 projects/credentials 的旧判据）。
    // 这里用拼接构造，避免本文件自己又被拦一次。注意要拼出 "盘符:盘符/段/段" 的形状。
    ['LOCAL_PATH', 'workspace-tmp-path.js', `const b = "${['D:', 'codex', '.tmp', 'x.bundle'].join('/')}";`],
    ['PLAIN_PASSWORD', 'plain-alpha-password.js', `const cfg = { password: "${strongPw}" };`],
    ['SSH_PORT', 'ssh-port.js', `real: ${realIp}:${port}`],
    ['PUBLIC_IP', 'public-ip.js', `const ip = "${realIp}";`],
    ['PRIVATE_KEY', 'private-key.js', `${pemBegin}\nAAAA\n${pemEnd}`],
    ['TOKEN', 'token.js', `const t = "${fakeToken}";`],
];

// 敏感路径用例：这些文件「内容本身可能很干净」，但只要路径落在这些目录里就不该进仓库。
// 用 --path 模式测（闸门对路径的判定不看内容）。
const SHOULD_BLOCK_PATHS = [
    ['SENSITIVE_PATH', 'profiles/demo-abc123.json', '服务器档案目录'],
    ['SENSITIVE_PATH', 'vault/servers.json', '凭证库'],
    ['SENSITIVE_PATH', 'logs/ops-console.ndjson', '操作日志'],
];

// 真实 serverId 用例：直接测纯函数。这是 2026-11-19 真出过事的漏洞类型
// （公开版文档里写进了一台真机的真实 serverId + 拓扑，而闸门报了 OK）。
//
// ⚠️ 下面第一条刻意保留「当初那段的原文形状」：id 前面是「<功能>服务器」而不是「这台服务器」。
// 判据第一版只认后者，结果自测全绿却拦不住真实原文。**判据要拿真实形状的样本验。**
// 这里的 slug 与后缀都是**虚构值**，不指向任何真实机器
// （真实那个已经作废，不该再被写进仓库 —— 写进去等于让作废失效）。
const SHOULD_BLOCK_IDS = [
    `**三台机器的档案都已建立**。其中音乐服务器（\`${['acme-srv', 'a1b2c3'].join('-')}\`）的档案里有：`,
    `serverId: "${['vps-hk', '3f2a1b'].join('-')}" 已登记。`,
];

const SHOULD_PASS = [
    ['placeholder.js', `// 示例：const home = "C:/Users/xxx/AppData";\nconst p = "/home/you/project";`],
    ['loopback.js', `const local = "127.0.0.1";\nconst any = "0.0.0.0";`],
    ['private-ip.js', `const lan = "192.168.1.10";\nconst ex = "10.0.0.5";`],
    ['var-password.js', `const cfg = { password: args.password, passwd: current.pwd };`],
    ['star-password.js', `const masked = { password: "******" };`],
    ['default-port.js', `const addr = "10.1.2.3:22";\nconst proxy = "127.0.0.1:7890";\nconst web = "192.168.1.5:8080";`],
    ['time-not-port.js', `const t = "10:30:45";`],
    // serverId 判据的误报控制：这些「长得像 id」的串都不该被拦
    ['git-short-hash.md', `见提交 ${['a', 'b12cd3'].join('')}，这是 git 短哈希。`],
    ['npm-scope.md', `安装 @types/${['node', '18ab3f'].join('-')} 与 @deepseek-ai/dsh-ssh-ops。`],
    ['fixture-id.js', `const SERVER = { id: 'demo-abc123', name: '演示机' };  // 测试夹具`],
    ['no-context-prose.md', `这一行有 ${['foo', 'bar', '12ab34'].join('-')} 这样的串，但没有服务器上下文词。`],
];

function runGate() {
    try {
        const out = execFileSync('node', ['scripts/publish-gate.mjs', '--all'], { cwd: ROOT, encoding: 'utf8' });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
}

function cleanProbe() {
    if (!fs.existsSync(PROBE)) return;
    for (const f of fs.readdirSync(PROBE)) fs.rmSync(path.join(PROBE, f));
}

let pass = 0;
let fail = 0;
fs.mkdirSync(PROBE, { recursive: true });

console.log('[1] 应当被拦下的样本');
for (const [code, name, body] of SHOULD_BLOCK) {
    cleanProbe();
    fs.writeFileSync(path.join(PROBE, name), body, 'utf8');
    const r = runGate();
    if (!r.ok && r.out.includes(code)) { console.log(`  ✓ ${name} → ${code}`); pass += 1; }
    else { console.log(`  ✗ ${name} 漏过（期望 ${code}，实际 ${r.ok ? 'PASS' : 'BLOCK 但 code 不符'}）`); fail += 1; }
}

console.log('[2] 不该被误伤的样本');
cleanProbe();
for (const [name, body] of SHOULD_PASS) fs.writeFileSync(path.join(PROBE, name), body, 'utf8');
const clean = runGate();
if (clean.ok) { console.log(`  ✓ ${SHOULD_PASS.length} 个合法样本全部放行`); pass += 1; }
else {
    console.log('  ✗ 误报：合法样本被拦');
    console.log(clean.out.split('\n').filter((l) => l.includes('→')).slice(0, 10).join('\n'));
    fail += 1;
}

// 敏感路径判定直接测纯函数：起子进程去测「某个文件在某个目录里」既慢又不稳，
// 而 scanPath 是纯函数，测它才是测「判据本身」。
console.log('[3] 敏感路径判据');
for (const [code, relPath, label] of SHOULD_BLOCK_PATHS) {
    const hits = scanPath(relPath);
    if (hits.some((h) => h.code === code && h.detail.includes(label))) {
        console.log(`  ✓ ${relPath} → ${code}（${label}）`);
        pass += 1;
    } else {
        console.log(`  ✗ ${relPath} 没被拦（期望 ${code} / ${label}，实际 ${JSON.stringify(hits)}）`);
        fail += 1;
    }
}
// 反向：正常代码路径不该被误判
const SHOULD_PASS_PATHS = ['index.js', 'lib/profile.js', 'lib/tools.js', 'test-profile.mjs', 'docs/README.md'];
let pathOk = true;
for (const p of SHOULD_PASS_PATHS) {
    const hits = scanPath(p);
    if (hits.length) { console.log(`  ✗ 误伤正常路径：${p} → ${JSON.stringify(hits)}`); pathOk = false; }
}
if (pathOk) { console.log(`  ✓ ${SHOULD_PASS_PATHS.length} 个正常代码路径未被误伤`); pass += 1; }
else fail += 1;

// 真实 serverId 判据
console.log('[4] 真实 serverId 判据（2026-11-19 真出过事的漏洞）');
for (const sample of SHOULD_BLOCK_IDS) {
    const hits = scanContent(sample).filter((h) => h.code === 'SERVER_ID');
    if (hits.length) { console.log(`  ✓ 拦下：${hits.map((h) => h.detail).join('、')}`); pass += 1; }
    else { console.log(`  ✗ 漏过：${sample}`); fail += 1; }
}
// 反向：占位的 / 无上下文的 id 不该被拦（否则测试文件自己都进不去）
const SERVER_ID_SAFE = [
    `const SERVER = { id: "${['demo', 'abc123'].join('-')}" };        // 夹具`,
    `见提交 ab12cd3 与 @types/${['node', '18ab3f'].join('-')}`,
    `这里有个 ${['foo', 'bar', '12ab34'].join('-')} 但没有标识类上下文`,
];
let idOk = true;
for (const sample of SERVER_ID_SAFE) {
    const hits = scanContent(sample).filter((h) => h.code === 'SERVER_ID');
    if (hits.length) { console.log(`  ✗ 误伤：${sample} → ${hits.map((h) => h.detail).join('、')}`); idOk = false; }
}
if (idOk) { console.log(`  ✓ ${SERVER_ID_SAFE.length} 个占位/无上下文的样本未被误伤`); pass += 1; }
else fail += 1;

cleanProbe();
fs.rmSync(PROBE, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
console.log(fail === 0 ? 'STATUS: OK' : 'STATUS: FAIL');
process.exitCode = fail === 0 ? 0 : 1;


