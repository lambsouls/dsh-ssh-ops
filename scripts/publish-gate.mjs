// scripts/publish-gate.mjs —— 闸门①：把仓库推出去之前的「不会泄露」检查。
//
// 它回答一个问题：**如果现在 git push，会带走什么不该带的东西？**
// 只读、无副作用；任何一条命中就 STATUS: BLOCK 并且非零退出。
//
// 判据全部来自 lib/gate-rules.mjs —— 与推送后复查（verify-remote）共用同一套规则，
// 避免「本地过了、远端其实有」这种两边判据漂移的情况。
//
// 检查项：
//   ① 敏感目录/文件是否被 git 跟踪（凭证、日志、截图、vault、私钥）
//   ② 被跟踪文件内容里的：公网 IP / 本机绝对路径 / 私钥块 / 密码字面量 / token / SSH 端口
//   ③ 仓库目录里是否存在不该存在的运行时数据（即使没被跟踪也算隐患）
//
// 用法：
//   node scripts/publish-gate.mjs            # 有 .git 时检查「已跟踪文件」
//   node scripts/publish-gate.mjs --all      # 不管 git，扫全目录（发布前预检用）
//   node scripts/publish-gate.mjs --strict-data   # 连「存在但被 ignore 了」的数据目录也算问题（pre-push 用）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanContent, scanPath, summarize, TEXT_EXT } from '../lib/gate-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanAll = process.argv.includes('--all');
const strictData = process.argv.includes('--strict-data');

const PROBLEMS = [];
const add = (code, detail) => PROBLEMS.push({ code, detail });

function walk(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else acc.push(full);
    }
    return acc;
}

function trackedFiles() {
    if (scanAll) return walk(ROOT).map((f) => path.relative(ROOT, f));
    try {
        const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
        return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
        return walk(ROOT).map((f) => path.relative(ROOT, f));
    }
}

const files = trackedFiles();

// ① 敏感路径
for (const f of files) {
    for (const hit of scanPath(f)) add(hit.code, hit.detail);
}

// ② 内容检查
for (const f of files) {
    if (!TEXT_EXT.test(f)) continue;
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    for (const finding of scanContent(fs.readFileSync(full, 'utf8'))) {
        const where = `${f.split(path.sep).join('/')}:${finding.line}`;
        add(finding.code, finding.detail ? `${where} → ${finding.detail}` : where);
    }
}

// ③ 仓库目录里的运行时数据
for (const dir of ['.runtime', 'vault', 'keys']) {
    const p = path.join(ROOT, dir);
    if (!fs.existsSync(p)) continue;
    const entries = fs.readdirSync(p).filter((n) => n !== '.gitkeep');
    if (entries.length === 0) continue;
    add('DATA_IN_REPO', strictData
        ? `${dir}/ 里有 ${entries.length} 个文件（应放到 ~/.dsh/ssh-ops）`
        : `${dir}/ 存在于仓库目录内（应放到 ~/.dsh/ssh-ops）`);
}

// 汇总
console.log(`检查范围：${scanAll ? '全目录' : 'git 跟踪文件'}，共 ${files.length} 个文件`);
console.log('');
if (PROBLEMS.length === 0) {
    console.log('✓ 未发现敏感内容');
    console.log('STATUS: OK');
    process.exitCode = 0;
} else {
    const byCode = summarize(PROBLEMS);
    for (const [code, items] of byCode) {
        console.log(`✗ ${code}（${items.length} 处）`);
        for (const item of items.slice(0, 12)) console.log(`    ${item.detail}`);
        if (items.length > 12) console.log(`    …另有 ${items.length - 12} 处`);
    }
    console.log('');
    console.log(`共 ${PROBLEMS.length} 处问题`);
    console.log('STATUS: BLOCK');
    process.exitCode = 1;
}
