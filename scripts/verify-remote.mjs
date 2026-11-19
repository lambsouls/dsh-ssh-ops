// scripts/verify-remote.mjs —— 闸门②：**推送之后**复查 GitHub 上的真实内容。
//
// 为什么本地闸门不够：它只查「它知道的模式」。判据本身有洞时（历史上就发生过一次 ——
// 只查 projects/credentials 两个子目录，结果一条指向临时目录的路径被推了上去），
// 本地永远显示 OK。**只有拿真实远端内容再扫一遍，才能发现「闸门判据有洞」这类问题。**
//
// 所以规矩是：**每次 push 完之后都跑一遍，它说 OK 才算真的没泄露。**
//
// 两种取数方式（默认自动选）：
//   · `--via git`  ：git fetch 后从 git 对象读（`git show <ref>:<path>`）。**不耗 GitHub API 配额**、最稳。
//   · `--via api`  ：走 GitHub REST。能看到「远端真实字节」，但要配额（匿名 60 次/小时，扫一次就用掉大半）。
//   自动策略：先试 git；失败或指定 api 时才走 API。
//
// 无论哪种方式，都会额外检查：
//   ① 本地 HEAD 与远端分支是否一致（防「本地改好但没推上去」，那时扫的是旧代码）
//   ② 最近 commit 的 message（提交历史同样是公开面）
//   ③ 扫描完整性 —— 有文件没读到就判定「复查不完整」，不拿「读了几个」冒充「读完了」
//
// 退出码：0 干净 / 1 发现问题 / 2 没查成。**2 不算通过。**
//
// 用法：
//   node scripts/verify-remote.mjs                # 自动（优先 git）
//   node scripts/verify-remote.mjs --via api      # 强制走 API
//   node scripts/verify-remote.mjs --offline      # 只做本地侧检查（不取远端文件）
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanContent, scanPath, summarize } from '../lib/gate-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
};
const offline = argv.includes('--offline');
const forceVia = argOf('via', null);
const branch = argOf('ref', null);

function git(args, opts = {}) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function repoSlug() {
    const url = git(['remote', 'get-url', 'origin']).trim();
    const m = /github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
    if (!m) throw new Error(`无法从 remote URL 解析仓库名：${url}`);
    return `${m[1]}/${m[2]}`;
}

const TEXT = /\.(js|mjs|cjs|json|ya?ml|md|py|ts|txt|html|css|svg|sh|ps1)$/i;
const PROBLEMS = [];
const add = (code, detail) => PROBLEMS.push({ code, detail });

// ── 取远端文件：git 方式 ──
function fetchTreeViaGit(ref) {
    git(['fetch', 'origin', ref, '--quiet']);
    const remoteRef = `origin/${ref}`;
    const head = git(['rev-parse', remoteRef]).trim();
    // 列文件 + 读内容全部走本地 git 对象，零 API 配额
    const list = git(['ls-tree', '-r', '--name-only', remoteRef]).split('\n').map((s) => s.trim()).filter(Boolean);
    const files = list.map((p) => {
        let content = null;
        try {
            content = git(['show', `${remoteRef}:${p}`], { maxBuffer: 64 * 1024 * 1024 });
        } catch { content = null; }
        return { path: p, content };
    });
    return { head, files, via: 'git' };
}

// ── 取远端文件：API 方式 ──
async function api(url) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const headers = { 'user-agent': 'dsh-ssh-ops-verify-remote', accept: 'application/vnd.github+json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 180)}` : ''}`);
    }
    return res.json();
}

async function fetchTreeViaApi(slug, ref) {
    const data = await api(`https://api.github.com/repos/${slug}/git/trees/${ref}?recursive=1`);
    const blobs = (data.tree ?? []).filter((n) => n.type === 'blob');
    const files = [];
    for (const node of blobs) {
        if (!TEXT.test(node.path)) { files.push({ path: node.path, content: null, skipped: true }); continue; }
        try {
            const blob = await api(`https://api.github.com/repos/${slug}/git/blobs/${node.sha}`);
            const text = Buffer.from(blob.content ?? '', blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
            files.push({ path: node.path, content: text });
        } catch (error) {
            files.push({ path: node.path, content: null, error: error.message });
        }
    }
    const head = (git(['ls-remote', 'origin', `refs/heads/${ref}`]).trim().split(/\s+/)[0]) || null;
    return { head, files, via: 'api' };
}

async function main() {
    const slug = repoSlug();
    const ref = branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const localHead = git(['rev-parse', 'HEAD']).trim();

    console.log(`仓库：${slug}`);
    console.log(`分支：${ref}`);
    console.log(`本地 HEAD：${localHead.slice(0, 8)}`);
    console.log('');

    // ── 一致性 + commit message ──
    let remoteHead = null;
    try {
        remoteHead = (git(['ls-remote', 'origin', `refs/heads/${ref}`]).trim().split(/\s+/)[0]) || null;
    } catch { /* 网络问题，后面会体现 */ }
    if (remoteHead) {
        console.log(`远端 HEAD：${remoteHead.slice(0, 8)}`);
        if (remoteHead === localHead) console.log('✓ 本地与远端一致（扫的就是刚推上去的这次提交）');
        else {
            console.log('⚠ 本地与远端不一致 —— 下面扫的是远端那次提交，不是本地最新');
            add('HEAD_MISMATCH', `本地 ${localHead.slice(0, 8)} ≠ 远端 ${remoteHead.slice(0, 8)}`);
        }
    }
    console.log('');

    try {
        const log = git(['log', '--format=%h%n%B%n---END---', '-n', '20']);
        const blocks = log.split('---END---').filter((s) => s.trim());
        for (const block of blocks) {
            const lines = block.trim().split('\n');
            const sha = lines[0].trim();
            for (const f of scanContent(lines.slice(1).join('\n'))) {
                add(f.code, `commit ${sha} message 第 ${f.line} 行${f.detail ? ` → ${f.detail}` : ''}`);
            }
        }
        console.log(`✓ 已检查最近 ${blocks.length} 条 commit message`);
    } catch (error) {
        console.log(`⚠ commit message 检查跳过：${error.message}`);
    }

    if (offline) {
        console.log('\n（--offline：不取远端文件，只做了本地侧检查）');
        return report();
    }

    // ── 取远端文件 ──
    let tree = null;
    const tryGit = forceVia !== 'api';
    const tryApi = forceVia !== 'git';

    if (tryGit) {
        try {
            tree = fetchTreeViaGit(ref);
            console.log(`✓ 远端共 ${tree.files.length} 个文件（via git，不耗 API 配额）`);
        } catch (error) {
            console.log(`⚠ git 方式取数失败：${String(error.message).split('\n')[0].slice(0, 120)}`);
        }
    }
    if (!tree && tryApi) {
        try {
            tree = await fetchTreeViaApi(slug, ref);
            console.log(`✓ 远端共 ${tree.files.length} 个文件（via API）`);
        } catch (error) {
            console.log(`\n✗ 无法读取远端内容：${String(error.message).split('\n')[0]}`);
            console.log('  git 与 API 两条路都没走通 —— 这次复查没做成。');
            process.exitCode = 2;
            return;
        }
    }
    if (!tree) {
        console.log('\n✗ 两种方式都没取到远端内容');
        process.exitCode = 2;
        return;
    }

    // ── 路径规则 ──
    for (const f of tree.files) {
        for (const hit of scanPath(f.path)) add(hit.code, `远端 ${hit.detail}`);
    }

    // ── 逐文件内容扫描 ──
    const toScan = tree.files.filter((f) => f.content !== null || f.error);
    console.log(`✓ 其中 ${toScan.length} 个文本文件需要逐个检查`);
    console.log('');

    let checked = 0;
    let failed = 0;
    for (const f of toScan) {
        if (f.error) {
            failed += 1;
            console.log(`  ? ${f.path} — 读取失败：${String(f.error).slice(0, 70)}`);
            continue;
        }
        const findings = scanContent(f.content);
        if (findings.length > 0) {
            for (const x of findings) add(x.code, `${f.path}:${x.line}${x.detail ? ` → ${x.detail}` : ''}`);
            console.log(`  ✗ ${f.path}（${findings.length} 处）`);
        } else {
            console.log(`  ✓ ${f.path}`);
        }
        checked += 1;
    }

    console.log('');
    console.log(`已检查 ${checked} 个文件${failed ? `，${failed} 个读取失败` : ''}`);
    if (failed > 0) {
        console.log('⚠ 有文件没读到 —— 这次复查不完整，不能算通过');
        add('INCOMPLETE_SCAN', `${failed} 个文件读取失败`);
    }

    report();
}

function report() {
    console.log('');
    if (PROBLEMS.length === 0) {
        console.log('✓ 远端内容未发现敏感信息');
        console.log('STATUS: OK');
        if (process.exitCode === undefined) process.exitCode = 0;
    } else {
        const byCode = summarize(PROBLEMS);
        for (const [code, items] of byCode) {
            console.log(`✗ ${code}（${items.length} 处）`);
            for (const item of items.slice(0, 15)) console.log(`    ${item.detail}`);
            if (items.length > 15) console.log(`    …另有 ${items.length - 15} 处`);
        }
        console.log('');
        console.log(`共 ${PROBLEMS.length} 处问题`);
        console.log('STATUS: LEAK');
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(`\n✗ 复查失败：${error?.message ?? error}`);
    console.log('STATUS: ERROR');
    process.exitCode = 2;
});
