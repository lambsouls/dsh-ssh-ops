// test-live.mjs —— 端到端自测：真的起 Python SSH 助手、真的连（目标由参数给）。
// 用法：
//   node test-live.mjs --host 127.0.0.1 --port 59999 --user demo --password wrong   # 预期 auth/network 失败
//   node test-live.mjs --cred /path/to/cred.json                                    # 用真实凭证探测
//                                                                                  # （只取 host/port/user/password，不打印）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRedactor } from './lib/redact.js';
import { createOpsService } from './lib/service.js';

function args() {
    const out = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
    return out;
}

const a = args();
let cred = null;
if (a.cred) {
    const raw = JSON.parse(fs.readFileSync(a.cred, 'utf8'));
    cred = {
        host: raw.host,
        port: raw.ssh_port ?? raw.port ?? 22,
        user: raw.ssh_user ?? raw.user,
        password: raw.ssh_password ?? raw.password,
        name: raw.name ?? raw.host,
    };
    if (!cred.host || !cred.user || !cred.password) throw new Error('凭证文件缺字段');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-ops-live-'));
const redactor = createRedactor();
const ops = createOpsService({
    vaultDir: path.join(tmp, 'vault'),
    logDir: path.join(tmp, 'logs'),
    config: { pythonPath: null, defaultTimeoutMs: 30000, maxOutputBytes: 32768 },
    redactor,
});

const host = cred?.host ?? a.host;
const port = Number(cred?.port ?? a.port ?? 22);
const user = cred?.user ?? a.user;
const password = cred?.password ?? a.password;

const view = ops.vault.upsert({
    name: cred?.name ?? `${host}:${port}`,
    host, port, user, authType: 'password', secrets: { password },
});
console.log(`注册：${view.name} → ${user}@${host}:${port}（${view.id}）`);

const result = await ops.exec({
    serverId: view.id,
    command: 'id -un; uname -srm; echo "---"; cat /etc/os-release 2>/dev/null | sed -n "s/^PRETTY_NAME=//p"',
    timeoutMs: 25000,
    title: '端到端自测',
});

console.log('\n--- 结果 ---');
console.log('失败：', result.failure ? `${result.failure.kind} — ${result.failure.message}` : '无');
console.log('退出码：', result.code);
console.log('stdout：', JSON.stringify(result.stdout));
console.log('stderr：', JSON.stringify(result.stderr.slice(0, 400)));
console.log('耗时：', result.durationMs, 'ms');

const entries = ops.journal.snapshot({ limit: 200 });
const joined = entries.map((e) => e.text).join('\n');
const leaked = password && joined.includes(password);
console.log('\n控制台条目数：', entries.length);
console.log('日志泄露明文密码：', leaked ? '✗ 是（严重）' : '✓ 否');
console.log('日志样例：');
for (const e of entries.slice(0, 12)) console.log(`  [${e.kind}] ${e.text}`);

fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = leaked ? 1 : 0;
