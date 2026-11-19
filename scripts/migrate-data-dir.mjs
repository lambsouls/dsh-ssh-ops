// scripts/migrate-data-dir.mjs —— 把旧位置的数据搬到新的用户数据目录。
//
// 背景：v0.2.x 之前凭证库放在工作区的 credentials 目录、日志放在插件目录 .runtime\logs。
// 后者极其危险 —— 跑一次就会把真实 IP 写进代码仓库。v0.3.0 起统一搬到 ~/.dsh/ssh-ops/。
// 本脚本只负责搬，不硬编码任何人的盘符路径（源目录由 --from-* 指定）。
//
// 用法：node scripts/migrate-data-dir.mjs [--from-vault <dir>] [--from-log <dir>] [--dry]
// 行为：目标已存在则不覆盖（打印提示），源目录保留不动（迁移是复制，不是移动）。
import fs from 'node:fs';
import path from 'node:path';
import { defaultVaultDir, defaultLogDir } from '../lib/paths.js';

function arg(name, fallback = null) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
}
const dry = process.argv.slice(2).includes('--dry');

const toVault = defaultVaultDir();
const toLog = defaultLogDir();
const fromVault = arg('from-vault');
const fromLog = arg('from-log');

function copyDir(from, to, label) {
    if (!from || !fs.existsSync(from)) { console.log(`- ${label}: 源不存在，跳过（${from ?? '未指定'}）`); return; }
    if (fs.existsSync(to) && fs.readdirSync(to).length > 0) {
        console.log(`- ${label}: 目标已有数据，不覆盖（${to}）`);
        return;
    }
    if (dry) { console.log(`[dry] ${label}: ${from} → ${to}`); return; }
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    console.log(`✔ ${label}: ${from} → ${to}`);
}

console.log('目标数据目录：');
console.log(`  凭证 ${toVault}`);
console.log(`  日志 ${toLog}`);
console.log('');
copyDir(fromVault, toVault, '凭证库');
copyDir(fromLog, toLog, '操作日志');

console.log('\n提示：源目录不会被删除。确认新位置工作正常后，旧目录可以自己清理。');
