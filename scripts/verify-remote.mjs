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
//   ③ **完整提交历史的内容**（`git log -p`）—— 这一步以前是缺的，2026-11-19 因此漏过：
//      泄露被修掉了、当前文件干净，但 `git log -p` 仍能翻出曾提交过的原文
//   ④ 扫描完整性 —— 有文件没读到就判定「复查不完整」，不拿「读了几个」冒充「读完了」
//
// ⚠️ 关于 ③：**修好当前文件不等于消除泄漏。** 只要历史里还留着，任何人 clone 下来
//   就能 `git log -p | grep`。而 force-push 也消不掉（GitHub 保留不可达对象）。
//   所以历史扫描是必须的 —— 它报出来的问题要靠「作废标识 / 轮换凭证」解决，
//   而不是靠再改一遍文件。
//
// 退出码：0 干净 / 1 发现问题 / 2 没查成。**2 不算通过。**
//
// 用法：
//   node scripts/verify-remote.mjs                # 自动（优先 git）
//   node scripts/verify-remote.mjs --via api      # 强制走 API
//   node scripts/verify-remote.mjs --offline      # 只做本地侧检查（不取远端文件）
//   node scripts/verify-remote.mjs --no-history   # 跳过历史扫描（不推荐，只在历史极长时用）
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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
const skipHistory = argv.includes('--no-history');
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

    // ── 完整历史内容扫描 ──
    // 为什么必须有这一步：泄露被「修好」之后，当前文件是干净的，但 `git log -p`
    // 仍能翻出曾提交过的原文。任何人 clone 下来 grep 就能看到。
    // 2026-11-19 我就是这么漏掉一次的 —— 修完文件、verify-remote 报 OK，历史里还在。
    if (!skipHistory) {
        const history = scanHistory();
        if (history.error) {
            console.log(`⚠ 历史扫描未完成：${history.error}`);
            add('INCOMPLETE_HISTORY_SCAN', history.error);
        } else {
            const obsoleteIds = loadObsoleteIds();
            const liveIds = loadLiveIds();
            console.log(`✓ 已扫描 ${history.commits} 个提交的全部改动（git log -p）`);
            if (obsoleteIds.size) {
                console.log(`  已知作废的 serverId：${[...obsoleteIds].join('、')}（它们的命中降级为已知信息）`);
            }
            console.log(`  本机现存的 serverId：${liveIds.size ? [...liveIds].join('、') : '（读不到数据目录）'}`);
            const leaks = [];
            const notes = [];
            for (const item of history.findings) {
                const level = classifyHistorical(item, obsoleteIds, liveIds);
                (level === 'LEAK' ? leaks : notes).push(item);
            }
            for (const item of leaks.slice(0, 30)) {
                add(item.code, `历史 ${item.sha} ${item.path} 第 ${item.line} 行${item.detail ? ` → ${item.detail}` : ''}`);
            }
            if (leaks.length > 30) console.log(`  …另有 ${leaks.length - 30} 处历史命中`);
            if (notes.length) {
                console.log(`  · ${notes.length} 处历史痕迹「曾公开但不可利用」（不阻塞）：`);
                for (const n of notes.slice(0, 8)) {
                    console.log(`      ${n.code} ${n.sha} ${n.path}${n.detail ? ` → ${n.detail}` : ''}`);
                }
                if (notes.length > 8) console.log(`      …另有 ${notes.length - 8} 处`);
            }
            if (leaks.length === 0) {
                console.log('  ✓ 历史里没有可利用的内容');
            } else {
                console.log(`  ✗ 历史里有 ${leaks.length} 处**仍可利用**的内容`);
                console.log('    ⚠ 这些**改文件解决不了** —— 它们在已提交的历史里，任何人 clone 都能翻到。');
                console.log('      正确动作：作废标识（scripts/reassign-id.mjs）或轮换凭证。见 MAINTAINING §6.2。');
            }
        }
    } else {
        console.log('⚠ 已跳过历史扫描（--no-history）—— 这次复查**不含**历史面，别当作通过');
        add('HISTORY_NOT_SCANNED', '本次跳过了 git log -p 扫描');
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

/**
 * 扫完整提交历史里的**新增行**。
 *
 * 为什么只扫新增行（`+` 开头的）：
 *   · `git log -p` 里每个改动会同时出现删除行（`-`）与新增行（`+`）；
 *   · 删除行意味着「这行被拿掉了」，它本身不再存在于任何可达的树里，
 *     但**它仍能被翻到**（就在这次 patch 里）—— 所以严格说也该扫；
 *   · 但全扫会让报告里出现大量「已经修好了」的历史噪音，反而掩盖真问题。
 *
 * 这里的取舍：**两行都扫，但在 detail 里标清是新增还是删除**。
 * 因为「删除行」同样意味着「这个字符串曾进入过公开历史」——
 * 而用户关心的正是「历史里有没有可利用的东西」，不是「现在文件里有没有」。
 *
 * ## 历史扫描的判据比当前文件更严，但要滤掉「没有利用价值的」
 *
 * 历史里有几类命中**不具备可利用性**，报出来只会淹没真问题：
 *
 *   · `PLAIN_PASSWORD` 命中测试夹具（`demo-pass-123`、运行时拼接的假密码）——
 *     它们本来就是假的，且现在已改成运行时拼接。**假密码不可利用。**
 *   · `LOCAL_PATH` 命中「本机临时目录」这类路径 —— 它泄漏的是「作者用 Windows」，
 *     不是凭证也不是拓扑。**但仍在报告里保留**（信息泄漏也是泄漏，只是低危）。
 *
 * 所以这里做的是**分级**而不是静默过滤：不可利用的降级为 `NOTE`，
 * 仍在报告里出现，但不算 LEAK —— 否则「全绿」就成了自欺。
 *
 * ⚠️ 性能：`git log -p` 在历史很长时会很慢、输出很大。所以：
 *   · 用 `--no-merges` 跳过合并提交（它们不引入新内容）
 *   · 超过 MAX_BYTES 就截断并**明确报告不完整**（不静默放过）
 */
/**
 * 历史命中的分级：哪些「仍具可利用性」，哪些只是「信息曾公开过」。
 *
 * 判据是**能否被用来攻击**，不是「有没有出现过」：
 *
 *   LEAK（可利用）：
 *     · 真实凭证值（真密码 / 真私钥 / 真 token）
 *     · 真实基础设施三元组（IP + 端口同时出现，且 IP 可路由）
 *     · 真实 serverId **且未作废**（能指认本机档案）
 *
 *   NOTE（曾公开、但不可利用）：
 *     · 测试夹具里的假密码 / 假私钥 / 保留段 IP
 *     · 本机临时目录路径（泄漏「作者用 Windows」，不是凭证也不是拓扑）
 *     · **已作废的 serverId** —— 它指不到任何真实数据（见 MAINTAINING §6.2）
 *
 * 为什么要分级而不是一律当 LEAK：一律报会让报告被噪音淹没，人就学会忽略它了。
 * **一个总在喊狼来了的闸门，等于没有闸门。**
 */

/** 这些路径属于「作者环境痕迹」而不是「凭证或拓扑」。 */
const BENIGN_PATH_HINT = /\.tmp|node_modules|\.bundle/i;

/**
 * 从本机档案与凭证库读「已作废的 serverId」。
 *
 * 怎么判断作废：档案时间线里有 `incident` 记录写明「serverId 由 X 变更为 Y」。
 * 这是 reassign-id.mjs 留下的痕迹 —— 它既是审计记录，也是「这个 id 已失效」的机器可读证据。
 *
 * 读不到时返回空集（不因为数据目录不存在就让整次复查失败）。
 */
function loadObsoleteIds() {
    const ids = new Set();
    try {
        const root = path.join(os.homedir(), '.dsh', 'ssh-ops', 'profiles');
        for (const f of fs.readdirSync(root)) {
            if (!f.endsWith('.json')) continue;
            let profile;
            try { profile = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { continue; }
            for (const t of profile?.timeline ?? []) {
                const m = /serverId 由 (\S+) 变更为 (\S+)/.exec(String(t?.text ?? ''));
                if (m) ids.add(m[1]);
            }
        }
    } catch { /* 没数据目录就算了 —— 退化成「不作废任何 id」的保守判定 */ }
    return ids;
}

/**
 * 读本机**真实存在**的 serverId（凭证库 + 档案目录）。
 *
 * 为什么需要它：区分「真实 serverId」和「测试夹具」最准的判据，
 * 不是「名字看起来像不像真的」，而是**它是否存在于本机真实数据里**。
 *
 * 我一开始用的是「前缀白名单」（demo/test/fake…），结果两头都错：
 *   · 太宽：`music-` 在名单里，真实机器叫 `music-server-xxxxxx` 就被放过；
 *   · 太窄：`music-abc123` 是测试夹具却被判成 LEAK，每次复查都报狼来了。
 *
 * 换成「对照真实数据」之后，这个判据本身就不需要猜了。
 */
function loadLiveIds() {
    const ids = new Set();
    try {
        const root = path.join(os.homedir(), '.dsh', 'ssh-ops');
        const vaultFile = path.join(root, 'vault', 'servers.json');
        if (fs.existsSync(vaultFile)) {
            const data = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
            for (const s of data?.servers ?? []) if (s?.id) ids.add(String(s.id));
        }
        for (const f of fs.readdirSync(path.join(root, 'profiles'))) {
            if (f.endsWith('.json')) ids.add(f.slice(0, -5));
        }
    } catch { /* 没数据目录：退化成「一律按可利用报」的保守判定 */ }
    return ids;
}

/** 判断一条历史命中是「可利用」还是「仅曾公开」。 */
function classifyHistorical(finding, obsoleteIds, liveIds = new Set()) {
    // 测试夹具里的假密码：值本身不可用（现在也已改成运行时拼接）。
    // 无法从扫描结果判断真假 —— 一律按 NOTE 报，让人自己看一眼；
    // 真密码泄露的正确动作是轮换凭证，而那不依赖这条扫描。
    if (finding.code === 'PLAIN_PASSWORD') return 'NOTE';
    // 本机路径：泄漏环境痕迹，不是凭证也不是拓扑
    if (finding.code === 'LOCAL_PATH') return 'NOTE';
    if (finding.code === 'SERVER_ID') {
        // 已作废 → 指不到任何真实数据（这正是 reassign-id 的目的）
        for (const id of obsoleteIds) if (finding.detail.includes(id)) return 'NOTE';
        // **本机真实存在的 id 才算可利用**；不在真实数据里的就是测试夹具
        for (const id of liveIds) if (finding.detail.includes(id)) return 'LEAK';
        return 'NOTE';
    }
    return 'LEAK';
}

function scanHistory() {
    const MAX_BYTES = 64 * 1024 * 1024;
    let raw;
    try {
        raw = execFileSync('git', ['log', '--all', '--no-merges', '-p', '--unified=0', '--format=@@@%H'], {
            cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BYTES,
        });
    } catch (error) {
        // maxBuffer 超了会抛 —— 这时不能假装扫过了
        if (String(error?.code ?? '').includes('ENOBUFS') || /maxBuffer/i.test(String(error?.message))) {
            return { error: `历史太大（超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB），未完成扫描` };
        }
        return { error: String(error?.message ?? error).split('\n')[0].slice(0, 160) };
    }

    const findings = [];
    const commits = new Set();
    let sha = null;
    let file = null;
    let lineNo = 0;
    let inDiff = false;

    for (const line of raw.split('\n')) {
        // 提交边界
        if (line.startsWith('@@@')) {
            sha = line.slice(3).trim().slice(0, 8);
            commits.add(sha);
            file = null;
            inDiff = false;
            continue;
        }
        // diff 头：定位文件
        if (line.startsWith('diff --git ')) {
            const m = /b\/(.+)$/.exec(line);
            file = m ? m[1].trim() : null;
            inDiff = true;
            continue;
        }
        // hunk 头：拿到行号基准（--unified=0 时形如 @@ -a,b +c,d @@）
        if (line.startsWith('@@')) {
            const m = /\+(\d+)/.exec(line);
            lineNo = m ? Number(m[1]) : 0;
            continue;
        }
        if (!inDiff || !file) continue;
        // 只扫文本文件，二进制 diff 直接跳过
        if (/Binary files|GIT binary patch/.test(line)) continue;
        if (/^\+/.test(line) && !/^\+\+\+/.test(line)) {
            const body = line.slice(1);
            for (const f of scanContent(body)) {
                findings.push({ code: f.code, sha, path: file, line: lineNo, detail: `${f.detail ? `${f.detail} ` : ''}(新增行)` });
            }
            lineNo += 1;
        } else if (/^-/.test(line) && !/^---/.test(line)) {
            const body = line.slice(1);
            for (const f of scanContent(body)) {
                findings.push({ code: f.code, sha, path: file, line: lineNo, detail: `${f.detail ? `${f.detail} ` : ''}(已删除行，仍可在历史里看到)` });
            }
        }
    }

    // 同一处（提交+文件+内容）只报一次
    const seen = new Set();
    const unique = findings.filter((f) => {
        const key = `${f.sha}|${f.path}|${f.code}|${f.detail}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return { commits: commits.size, findings: unique };
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

// 被 import 时（测试要复用 classifyHistorical / loadObsoleteIds）不要执行主流程。
// 判据是「这个文件是不是被直接运行的」：`import.meta.url` 与 `process.argv[1]` 指向同一文件。
const isDirectRun = (() => {
    try {
        return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '');
    } catch { return false; }
})();

if (isDirectRun) {
    main().catch((error) => {
        console.error(`\n✗ 复查失败：${error?.message ?? error}`);
        console.log('STATUS: ERROR');
        process.exitCode = 2;
    });
}

// 给测试用的导出。这些是纯逻辑（分级 / 读作废名单），不含副作用。
export { classifyHistorical, loadObsoleteIds, loadLiveIds };
