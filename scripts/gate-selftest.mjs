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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, '_gate_probe');

// 用拼接伪造，避免本文件被自己的规则命中
const octet = (a, b, c, d) => [a, b, c, d].join('.');
const realIp = octet(203, 0, 113, 9);          // TEST-NET-3，专用于文档示例的保留段，非真实主机
const port = [105, 56].join('');                // 非默认 SSH 端口
const user = ['some', 'one'].join('');          // 看起来像真用户名
const strongPw = ['Correct', 'Horse', 'Battery', 99].join('');  // 纯字母数字的真密码形态
const pemBegin = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const pemEnd = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const fakeToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');

const SHOULD_BLOCK = [
    ['LOCAL_PATH', 'win-forward-slash.js', `const home = "C:/Users/${user}/AppData/Local";`],
    ['LOCAL_PATH', 'posix-home.js', `const p = "/home/${user}/project";`],
    ['PLAIN_PASSWORD', 'plain-alpha-password.js', `const cfg = { password: "${strongPw}" };`],
    ['SSH_PORT', 'ssh-port.js', `real: ${realIp}:${port}`],
    ['PUBLIC_IP', 'public-ip.js', `const ip = "${realIp}";`],
    ['PRIVATE_KEY', 'private-key.js', `${pemBegin}\nAAAA\n${pemEnd}`],
    ['TOKEN', 'token.js', `const t = "${fakeToken}";`],
];

const SHOULD_PASS = [
    ['placeholder.js', `// 示例：const home = "C:/Users/xxx/AppData";\nconst p = "/home/you/project";`],
    ['loopback.js', `const local = "127.0.0.1";\nconst any = "0.0.0.0";`],
    ['private-ip.js', `const lan = "192.168.1.10";\nconst ex = "10.0.0.5";`],
    ['var-password.js', `const cfg = { password: args.password, passwd: current.pwd };`],
    ['star-password.js', `const masked = { password: "******" };`],
    ['default-port.js', `const addr = "10.1.2.3:22";\nconst proxy = "127.0.0.1:7890";\nconst web = "192.168.1.5:8080";`],
    ['time-not-port.js', `const t = "10:30:45";`],
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

cleanProbe();
fs.rmSync(PROBE, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
console.log(fail === 0 ? 'STATUS: OK' : 'STATUS: FAIL');
process.exitCode = fail === 0 ? 0 : 1;
