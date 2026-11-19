// scripts/verify-no-plaintext.mjs —— 闸门①：确认凭证与日志里没有明文密码。
//
// 做法：从源凭证文件取出密码值（只在内存里），检查它们是否出现在凭证库与日志里。
// 全程**不打印任何密码**，只输出「命中/未命中」与文件路径。
//
// 用法：
//   node scripts/verify-no-plaintext.mjs --src <凭证目录或json> [--vault <dir>] [--log <file>]
//   不给 --src 时，只扫凭证库结构（检查 secrets 字段确实是密文）与日志里的 PEM/password= 形态。
import fs from 'node:fs';
import path from 'node:path';
import { defaultVaultDir, defaultLogDir, vaultFile } from '../lib/paths.js';

function arg(name, fallback = null) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
}

const vaultDir = arg('vault', defaultVaultDir());
const logFile = arg('log', path.join(defaultLogDir(), 'ops-console.ndjson'));
const srcArg = arg('src', null);

/** 从源文件里收集「不该出现在别处」的明文。 */
const secrets = [];
function harvest(raw) {
    for (const key of ['password', 'ssh_password', 'webui_password', 'passphrase', 'privateKey', 'private_key']) {
        const v = raw?.[key];
        if (typeof v === 'string' && v.trim().length >= 4) secrets.push(v.trim());
    }
    for (const v of Object.values(raw ?? {})) {
        if (v && typeof v === 'object' && !Array.isArray(v)) harvest(v);
    }
}
if (srcArg) {
    const files = fs.statSync(srcArg).isDirectory()
        ? fs.readdirSync(srcArg).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => path.join(srcArg, f))
        : [srcArg];
    for (const f of files) {
        try { harvest(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* 坏文件跳过 */ }
    }
}

const targets = [vaultFile(vaultDir), logFile].filter((f) => fs.existsSync(f));
let hits = 0;

console.log(`凭证库：${vaultDir}`);
console.log(`待检明文条数：${secrets.length}（值不打印）`);
console.log('');

// ① 结构检查：servers.json 里密文必须真的是密文
if (fs.existsSync(vaultFile(vaultDir))) {
    const data = JSON.parse(fs.readFileSync(vaultFile(vaultDir), 'utf8'));
    const servers = data.servers ?? [];
    let missing = 0;
    for (const s of servers) {
        if (!s.secrets || s.secrets.v !== 1 || typeof s.secrets.data !== 'string') missing += 1;
    }
    console.log(`${missing === 0 ? '✓' : '✗'} 结构：${servers.length} 台服务器，${missing} 台缺密文/格式不对`);
    if (missing > 0) hits += missing;
}

// ② 明文比对
for (const file of targets) {
    const text = fs.readFileSync(file, 'utf8');
    const leaked = secrets.filter((s) => text.includes(s)).length;
    const base = path.basename(file);
    if (leaked > 0) { hits += leaked; console.log(`✗ ${base}: 命中 ${leaked} 条明文`); }
    else console.log(`✓ ${base}: 无明文（${(text.length / 1024).toFixed(1)} KB）`);
}

// ③ 兜底形态检查：日志里不该有 PEM 块或 password=明文
for (const file of targets) {
    const text = fs.readFileSync(file, 'utf8');
    const pem = (text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g) ?? []).length;
    const plainPwd = (text.match(/(?:password|passwd)\s*[=:]\s*(?!\*\*\*\*\*\*)\S{3,}/gi) ?? []).length;
    if (pem > 0) { hits += pem; console.log(`✗ ${path.basename(file)}: 有 ${pem} 处私钥块`); }
    if (plainPwd > 0) { hits += plainPwd; console.log(`✗ ${path.basename(file)}: 有 ${plainPwd} 处 password= 形态`); }
}

console.log(`\n明文命中 ${hits} 处`);
console.log(hits === 0 ? 'STATUS: OK' : 'STATUS: LEAK');
process.exitCode = hits === 0 ? 0 : 1;
