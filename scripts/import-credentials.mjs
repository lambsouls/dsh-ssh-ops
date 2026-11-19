// scripts/import-credentials.mjs —— 把外部已有的服务器凭证导入 ssh-ops 凭证库。
//
// 为什么是一个脚本：密码绝不能出现在对话、命令行参数或日志里。
// 这里让脚本自己去读凭证文件、直接调插件的 vault 写密文，全程不打印任何敏感值。
//
// 用法：
//   node scripts/import-credentials.mjs <凭证目录> [--dry]
//   node scripts/import-credentials.mjs --from <file.json> [--dry]
//
// 支持两种输入：
//   ① 目录模式：扫目录下已知形状的 JSON（host/port/user/password 等）；
//   ② 单文件模式：把任意一份 JSON 按已知键名映射成一条记录。
//
// 目标凭证库由 `~/.dsh/ssh-ops/vault`（或 `--vault <dir>`）决定，**与代码目录无关**。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRedactor } from '../lib/redact.js';
import { createVault } from '../lib/vault.js';
import { defaultVaultDir } from '../lib/paths.js';

function arg(name, fallback = null) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
}
function flag(name) {
    return process.argv.slice(2).includes(`--${name}`);
}

const dry = flag('dry');
const vaultDir = arg('vault', defaultVaultDir());
const fromFile = arg('from');
const dirArg = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== fromFile && a !== vaultDir);

const redactor = createRedactor();
const vault = createVault({ vaultDir, redactor });

/** 从任意 JSON 里抽出标准记录（容忍不同人的字段命名）。 */
function pickOf(raw, filename) {
    const host = raw.host ?? raw.ip ?? raw.address ?? safeHost(raw.webui ?? raw.url) ?? null;
    const port = Number(raw.port ?? raw.ssh_port ?? 22);
    const user = raw.user ?? raw.username ?? raw.ssh_user ?? null;
    const password = raw.password ?? raw.ssh_password ?? null;
    const privateKey = raw.privateKey ?? raw.private_key ?? null;
    if (!host || !user || (!password && !privateKey)) return null;
    return {
        name: raw.name ?? raw.title ?? filename.replace(/\.json$/i, ''),
        host,
        port,
        user,
        authType: privateKey ? 'key' : 'password',
        password,
        privateKey,
        passphrase: raw.passphrase ?? null,
        os: raw.os ?? null,
        notes: raw.note ?? raw.notes ?? null,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
    };
}

function safeHost(url) {
    if (typeof url !== 'string') return null;
    try { return new URL(url).hostname; } catch { return null; }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const candidates = [];
if (fromFile) {
    const raw = readJson(fromFile);
    if (raw) {
        const item = pickOf(raw, path.basename(fromFile));
        if (item) candidates.push(item);
        else console.log(`跳过 ${path.basename(fromFile)}：缺 host/user/password`);
    } else {
        console.log(`读不了 ${fromFile}（不是合法 JSON）`);
    }
} else if (dirArg) {
    for (const name of fs.readdirSync(dirArg)) {
        if (!name.toLowerCase().endsWith('.json')) continue;
        const raw = readJson(path.join(dirArg, name));
        if (!raw || Array.isArray(raw)) continue;
        const item = pickOf(raw, name);
        if (item) candidates.push(item);
    }
} else {
    console.log('用法：node scripts/import-credentials.mjs <凭证目录> [--dry]');
    console.log('      node scripts/import-credentials.mjs --from <file.json> [--dry]');
    process.exit(2);
}

if (candidates.length === 0) {
    console.log('没找到可导入的凭证（需要 host + user + password/privateKey）。');
    process.exit(0);
}

const report = [];
for (const item of candidates) {
    if (dry) {
        report.push(`[dry] ${item.name} → ${item.user}@${item.host}:${item.port}（${item.authType}）`);
        continue;
    }
    const view = vault.upsert({
        name: item.name,
        host: item.host,
        port: item.port,
        user: item.user,
        authType: item.authType,
        hostKeyPolicy: 'accept-new',
        notes: item.notes,
        tags: item.tags,
        os: item.os,
        secrets: { password: item.password, privateKey: item.privateKey, passphrase: item.passphrase },
    });
    report.push(`✔ ${view.name} → ${view.user}@${view.host}:${view.port}（${view.id}）`);
}

console.log(report.join('\n'));
console.log(`\n凭证库：${vaultDir}`);
console.log(`当前共 ${vault.list().length} 台：`);
for (const s of vault.list()) console.log(`  · ${s.name} ${s.user}@${s.host}:${s.port}（${s.auth}）应用 ${s.apps.length} 个`);
