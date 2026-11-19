// scripts/verify-remote.mjs —— 闸门②：**推送之后**复查 GitHub 上的真实内容。
//
// 为什么本地闸门不够：它只查「它知道的模式」。判据本身有洞时（历史上就发生过一次 ——
// 只查 projects/credentials 两个子目录，结果一条指向临时目录的路径被推了上去），
// 本地永远显示 OK。**只有拿真实远端内容再扫一遍，才能发现「闸门判据有洞」这类问题。**
//
// 所以规矩是：**每次 push 完之后都跑一遍这个脚本，它说 OK 才算真的没泄露。**
//
// 它做什么：
//   ① 用 GitHub API 列出远端全部文件（按实际推送的 commit，不是本地猜）
//   ② 逐个下载文本文件内容，用 lib/gate-rules.mjs 的**同一套判据**扫
//   ③ 额外比对：本地 HEAD 与远端分支是否一致（防止「本地改好但没推上去」）
//   ④ 额外检查：最新 commit 的 message 里有没有敏感信息（commit 历史同样是公开面）
//
// 用法：
//   node scripts/verify-remote.mjs                # 默认 origin + 当前分支
//   node scripts/verify-remote.mjs --ref main     # 指定分支
//   node scripts/verify-remote.mjs --offline      # 只用 Git（不调 API），扫 commit message 与 diff
//
// 退出码：0 = 干净；1 = 发现问题；2 = 环境/网络问题（区分「有问题」和「没查成」）。
import fs from 'node:fs';
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

const PROXY = process.env.SSH_OPS_PROXY || 'http://127.0.0.1:7890';
const ref = argOf('ref', null);
const offline = argv.includes('--offline');

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// 从 remote URL 推仓库全名（支持 SSH 与 HTTPS 两种写法）
function repoSlug() {
    const url = git(['remote', 'get-url', 'origin']);
    const m = /github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
    if (!m) throw new Error(`无法从 remote URL 解析仓库名：${url}`);
    return `${m[1]}/${m[2]}`;
}

async function api(url) {
    const res = await fetch(url, {
        headers: { 'user-agent': 'dsh-ssh-ops-verify-remote', accept: 'application/vnd.github+json' },
        // Node 的 fetch 不认系统代理；用全局 dispatcher 又太重，这里手工走代理不现实，
        // 所以：如果设了 HTTPS_PROXY，就要求调用方用支持代理的 Node（或让系统代理透明处理）。
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
    return res.json();
}

const PROBLEMS = [];
const add = (code, detail) => PROBLEMS.push({ code, detail });

async function main() {
    const slug = repoSlug();
    const branch = ref ?? git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const localHead = git(['rev-parse', 'HEAD']);

    console.log(`仓库：${slug}`);
    console.log(`分支：${branch}`);
    console.log(`本地 HEAD：${localHead.slice(0, 8)}`);
    console.log('');

    // ── 本地/远端一致性 ──
    let remoteHead = null;
    try {
        const out = git(['ls-remote', 'origin', `refs/heads/${branch}`]);
        remoteHead = out.split(/\s+/)[0] || null;
    } catch (error) {
        console.log(`⚠ 读不到远端引用：${error.message}`);
    }
    if (remoteHead) {
        console.log(`远端 HEAD：${remoteHead.slice(0, 8)}`);
        if (remoteHead === localHead) console.log('✓ 本地与远端一致（远端就是本地这次的提交）');
        else {
            console.log('⚠ 本地与远端不一致 —— 远端扫的是远端那次提交，不是本地最新');
            add('HEAD_MISMATCH', `本地 ${localHead.slice(0, 8)} ≠ 远端 ${remoteHead.slice(0, 8)}`);
        }
    }
    console.log('');

    // ── commit message 也检查（历史是公开面）──
    try {
        const log = git(['log', '--format=%H%n%B%n---END---', '-n', '20']);
        const msgs = log.split('---END---').filter((s) => s.trim());
        for (const block of msgs) {
            const lines = block.trim().split('\n');
            const sha = lines[0].slice(0, 8);
            for (const finding of scanContent(lines.slice(1).join('\n'))) {
                add(finding.code, `commit ${sha} message 第 ${finding.line} 行${finding.detail ? ` → ${finding.detail}` : ''}`);
            }
        }
        console.log(`✓ 已检查最近 ${msgs.length} 条 commit message`);
    } catch (error) {
        console.log(`⚠ commit message 检查跳过：${error.message}`);
    }

    if (offline) {
        console.log('\n（--offline：不下载远端文件，只做了本地侧检查）');
        return report();
    }

    // ── 下载远端文件树 ──
    const treeRef = remoteHead ?? branch;
    let tree;
    try {
        const data = await api(`https://api.github.com/repos/${slug}/git/trees/${treeRef}?recursive=1`);
        tree = (data.tree ?? []).filter((n) => n.type === 'blob');
    } catch (error) {
        console.log(`\n✗ 无法读取远端文件树：${error.message}`);
        console.log('  提示：API 需要网络可达（github.com 直连不稳时可设 HTTPS_PROXY 或先开代理）。');
        process.exitCode = 2;
        return;
    }
    console.log(`✓ 远端共 ${tree.length} 个文件`);

    // ── 路径规则 ──
    for (const node of tree) {
        for (const hit of scanPath(node.path)) add(hit.code, `远端 ${hit.detail}`);
    }

    // ── 逐文件下载内容并扫描 ──
    const TEXT = /\.(js|mjs|cjs|json|ya?ml|md|py|ts|txt|html|css|svg|sh|ps1)$/i;
    const textNodes = tree.filter((n) => TEXT.test(n.path));
    console.log(`✓ 其中 ${textNodes.length} 个文本文件需要逐个检查`);
    console.log('');

    let checked = 0;
    let failed = 0;
    for (const node of textNodes) {
        try {
            const blob = await api(`https://api.github.com/repos/${slug}/git/blobs/${node.sha}`);
            const text = Buffer.from(blob.content ?? '', blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
            const findings = scanContent(text);
            if (findings.length > 0) {
                for (const f of findings) {
                    add(f.code, `${node.path}:${f.line}${f.detail ? ` → ${f.detail}` : ''}`);
                }
                console.log(`  ✗ ${node.path}（${findings.length} 处）`);
            } else {
                console.log(`  ✓ ${node.path}`);
            }
            checked += 1;
        } catch (error) {
            failed += 1;
            console.log(`  ? ${node.path} — 读取失败：${error.message.slice(0, 80)}`);
        }
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
        process.exitCode = process.exitCode ?? 0;
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
