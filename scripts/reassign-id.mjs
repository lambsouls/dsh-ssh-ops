// scripts/reassign-id.mjs —— 给一台服务器换一个新的 serverId（作废旧标识）。
//
// 什么时候需要这个：
//   旧的 serverId 因为某个原因被公开出去了（写进了 commit message、文档、截图……），
//   虽然它不能用来连接服务器，但它是**本机标识** —— 配合公开的 `profiles/<id>.json`
//   结构能指认「本机有这个档案」，属于该消除的泄漏面。
//   force-push 只能改分支指针，GitHub 上仍可用 SHA 访问旧提交，所以**作废标识**是唯一
//   能立即生效的动作：旧字符串从此指向一个不存在的档案。
//
// 它做四件事，顺序不能变：
//   ① 生成新 id（与 newId 同规则：`<slug>-<6 位 hex>`）
//   ② 凭证库：把该条记录换到新 id（**其余字段一个都不动**）
//   ③ 档案文件：改名，并把档案里的 serverId 一起改掉
//   ④ 在档案时间线里留一条记录：旧 id 因为泄漏被作废
//
// 用法：
//   node scripts/reassign-id.mjs --old <旧id> --reason "泄露进公开 commit" [--dry]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const VM = /^([a-z][a-z0-9._-]*)-([0-9a-f]{6})$/;

function parseArgs(argv) {
    const out = { dry: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--dry') out.dry = true;
        else if (a === '--old') out.old = argv[++i];
        else if (a === '--reason') out.reason = argv[++i];
        else if (a === '--dir') out.dir = argv[++i];
    }
    return out;
}

function dataRoot(dir) {
    return dir ? path.resolve(dir) : path.join(os.homedir(), '.dsh', 'ssh-ops');
}

/** 与 lib/crypto.js 的 newId 同规则，但允许指定后缀以便测试。 */
function makeId(seed, suffix) {
    const base = String(seed ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'srv';
    return `${base}-${suffix ?? crypto.randomBytes(3).toString('hex')}`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.old) {
    console.error('用法：node scripts/reassign-id.mjs --old <旧id> [--reason "..."] [--dry]');
    process.exit(2);
}

const root = dataRoot(args.dir);
const vaultFile = path.join(root, 'vault', 'servers.json');
const profileDir = path.join(root, 'profiles');

if (!fs.existsSync(vaultFile)) {
    console.error(`找不到凭证库：${vaultFile}`);
    process.exit(2);
}

const data = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
const entry = (data.servers ?? []).find((s) => s.id === args.old);
if (!entry) {
    console.error(`凭证库里没有 id 为 ${args.old} 的服务器（可能已经换过 id 了）`);
    process.exit(2);
}

// 新 id 用同一个 slug 前缀，只换后缀 —— 保持可读性，同时让旧字符串失效。
const slug = args.old.replace(VM, '$1') || entry.name || 'srv';
const newId = makeId(slug);

console.log(`旧 id : ${args.old}`);
console.log(`新 id : ${newId}`);
console.log(`机器  : ${entry.name}（${entry.user}@${entry.host}:${entry.port ?? 22}）`);

if (args.dry) {
    console.log('\n[dry] 只显示计划，不改任何文件');
    process.exit(0);
}

// ── ② 凭证库：换 id，其余字段逐字节保持 ──
const backupVault = `${vaultFile}.bak-${Date.now()}`;
fs.copyFileSync(vaultFile, backupVault);
entry.id = newId;
entry.updatedAt = new Date().toISOString();
const tmpVault = `${vaultFile}.tmp-${process.pid}`;
fs.writeFileSync(tmpVault, JSON.stringify(data, null, 2) + '\n', 'utf8');
fs.renameSync(tmpVault, vaultFile);
console.log(`\n✓ 凭证库已更新（备份：${path.basename(backupVault)}）`);

// ── ③ 档案：改名 + 改 serverId ──
const oldProfileFile = path.join(profileDir, `${args.old}.json`);
const newProfileFile = path.join(profileDir, `${newId}.json`);
if (fs.existsSync(oldProfileFile)) {
    const profile = JSON.parse(fs.readFileSync(oldProfileFile, 'utf8'));
    profile.serverId = newId;
    // ── ④ 时间线留痕：这是「知识」，未来看档案的人必须知道为什么换了 id ──
    profile.timeline = Array.isArray(profile.timeline) ? profile.timeline : [];
    profile.timeline.push({
        at: new Date().toISOString(),
        kind: 'incident',
        text: `serverId 由 ${args.old} 变更为 ${newId}：旧标识${args.reason ? `（${args.reason}）` : ''}已作废。`
            + '作废原因：serverId 是本地标识，被公开后配合档案目录结构能指认本机档案，故换新。'
            + '旧 id 不再对应任何真实档案。',
    });
    profile.updatedAt = new Date().toISOString();
    fs.writeFileSync(newProfileFile, JSON.stringify(profile, null, 2) + '\n', 'utf8');
    fs.unlinkSync(oldProfileFile);
    console.log(`✓ 档案已改名：${path.basename(oldProfileFile)} → ${path.basename(newProfileFile)}`);
} else {
    console.log(`· 没有档案文件（${path.basename(oldProfileFile)} 不存在），跳过`);
}

// ── 校验：新 id 在库里有且只有一条；旧 id 已不存在 ──
const after = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
const hits = (after.servers ?? []).filter((s) => s.id === newId);
const stillOld = (after.servers ?? []).some((s) => s.id === args.old);
console.log(`\n校验：新 id 命中 ${hits.length} 条；旧 id 仍存在 = ${stillOld}`);
console.log(`档案文件存在 = ${fs.existsSync(newProfileFile)}`);
if (hits.length !== 1 || stillOld) {
    console.error('STATUS: FAIL —— 结果不符合预期，请用备份回滚');
    process.exit(1);
}
console.log('STATUS: OK');
