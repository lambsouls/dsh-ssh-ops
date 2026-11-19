// scripts/check-issues.mjs —— 检查 GitHub Issues / PR（**严格只读**）。
//
// ⚠️ 本仓库的约定：**发现了 Issue 先汇报给维护者，不要自己回复或改代码**。
//    所以这个脚本**只做 GET**，不回复、不打标签、不关闭、不改代码。
//    它存在的唯一目的是「把新 Issue 整理成人话，交给维护者定夺」。
//    （fork 后可以改成你自己的流程。）
//
// 为什么用 GraphQL/API 而不是 gh CLI：这台机器没装 gh，而且 API 够用。
// 匿名限额 60 次/小时，本脚本跑一次只花 1~2 次（列表 + 可选详情），不会打满。
//
// 用法：
//   node scripts/check-issues.mjs                    # 列出所有 open 的 issue + PR
//   node scripts/check-issues.mjs --state all        # 连已关闭的也要
//   node scripts/check-issues.mjs --json             # 机器可读输出
//   node scripts/check-issues.mjs --since <ISO日期>   # 只看这个时间之后创建的
//
// 退出码：0 = 查成功（有没有 issue 都算成功）；2 = 没查成（网络/限流）。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
};

const state = argOf('state', 'open');
const asJson = argv.includes('--json');
const since = argOf('since', null);

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function repoSlug() {
    const url = git(['remote', 'get-url', 'origin']);
    // 手工切分比正则稳：兼容 `git@host:owner/repo.git` 与 `https://host/owner/repo(.git)`
    const clean = url.replace(/\.git$/, '').replace(/\/$/, '');
    const parts = clean.split(/[/:]/).filter(Boolean);
    if (parts.length < 2) throw new Error(`无法从 remote URL 解析仓库名：${url}`);
    return parts.slice(-2).join('/');
}

async function api(url) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const headers = {
        'user-agent': 'dsh-ssh-ops-check-issues',
        accept: 'application/vnd.github+json',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`GitHub API ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 160)}` : ''}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${Math.max(1, min)} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    return d < 30 ? `${d} 天前` : `${Math.floor(d / 30)} 个月前`;
}

function snippet(text, max = 160) {
    const one = String(text ?? '').replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max)}…` : one;
}

async function main() {
    const slug = repoSlug();

    // ⚠️ GitHub 上另有一个同名仓库（caoyiwei850/dsh-ssh-ops，2026-08 建，不同项目）。
    // 认错仓库就会去看别人的 issue。这里硬校验 owner。
    const EXPECTED_OWNER = 'lambsouls';
    const [owner] = slug.split('/');
    if (String(owner).toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
        console.error(`✗ 仓库 owner 不对：${slug}`);
        console.error(`  本项目是 ${EXPECTED_OWNER}/dsh-ssh-ops。检查 git remote 是否被改过。`);
        console.error('STATUS: WRONG_REPO');
        process.exitCode = 2;
        return;
    }

    let items;
    try {
        // 一次拿全（公开仓库匿名可读；限额消耗 1 次）
        items = await api(`https://api.github.com/repos/${slug}/issues?state=${state}&per_page=100&sort=created&direction=desc`);
    } catch (error) {
        if (error.status === 403 || error.status === 429) {
            console.error(`✗ 被限流了：${error.message}`);
            console.error('  匿名限额 60 次/小时。等一会儿，或设 GITHUB_TOKEN 环境变量。');
        } else {
            console.error(`✗ 查不到 Issues：${error.message}`);
        }
        console.error('STATUS: ERROR');
        process.exitCode = 2;
        return;
    }

    // GitHub 的 issues 接口把 PR 也混在里面，用 pull_request 字段区分
    let rows = items.map((it) => ({
        number: it.number,
        title: it.title,
        kind: it.pull_request ? 'PR' : 'Issue',
        state: it.state,
        author: it.user?.login ?? '(未知)',
        createdAt: it.created_at,
        updatedAt: it.updated_at,
        comments: it.comments ?? 0,
        labels: (it.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
        body: snippet(it.body, 200),
        url: it.html_url,
    }));

    if (since) {
        const from = new Date(since).getTime();
        rows = rows.filter((r) => new Date(r.createdAt).getTime() >= from);
    }

    if (asJson) {
        console.log(JSON.stringify({ repo: slug, state, count: rows.length, items: rows }, null, 2));
        process.exitCode = 0;
        return;
    }

    console.log(`仓库：${slug}`);
    console.log(`状态：${state}    共 ${rows.length} 条（Issue 与 PR 分开标注）`);
    console.log('');

    if (rows.length === 0) {
        console.log('（没有需要处理的条目）');
        console.log('STATUS: OK');
        process.exitCode = 0;
        return;
    }

    for (const r of rows) {
        const tag = r.kind === 'PR' ? 'PR  ' : 'Issue';
        const labels = r.labels.length ? `  [${r.labels.join(', ')}]` : '';
        console.log(`${tag} #${r.number}  ${r.title}${labels}`);
        console.log(`       ${r.author} 创建于 ${ago(r.createdAt)}${r.comments ? ` · ${r.comments} 条评论` : ''}`);
        if (r.body) console.log(`       ${r.body}`);
        console.log(`       ${r.url}`);
        console.log('');
    }

    console.log('─'.repeat(60));
    console.log('⚠ 这些内容**只是给你看的**。按本仓库的约定：');
    console.log('  不要自己回复、不要自己改代码、不要打标签或关闭。');
    console.log('  先整理成人话汇报给维护者，等维护者定夺。');
    console.log('STATUS: OK');
    process.exitCode = 0;
}

main().catch((error) => {
    console.error(`\n✗ 检查失败：${error?.message ?? error}`);
    console.log('STATUS: ERROR');
    process.exitCode = 2;
});


