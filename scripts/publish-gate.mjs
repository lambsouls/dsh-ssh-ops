// scripts/publish-gate.mjs —— 闸门②：把仓库推出去之前的「不会泄露」检查。
//
// 它回答一个问题：**如果现在 git push，会带走什么不该带的东西？**
// 只读、无副作用；任何一条命中就 STATUS: BLOCK 并且非零退出。
//
// 五项检查：
//   ① 敏感目录/文件是否被 git 跟踪（凭证、日志、截图、vault、私钥）
//   ② 被跟踪文件里是否有真实公网 IP（排除白名单：示例地址、公共 DNS、回环）
//   ③ 是否有本机绝对路径（用户名、盘符工作区路径）
//   ④ 是否有 PEM 私钥块 / password= 明文 / 常见 token 形状
//   ⑤ 仓库目录里是否存在不该存在的运行时数据（即使没被跟踪也算隐患）
//
// 用法：
//   node scripts/publish-gate.mjs            # 有 .git 时检查「已跟踪文件」
//   node scripts/publish-gate.mjs --all      # 不管 git，扫全目录（发布前预检用）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanAll = process.argv.includes('--all');

const PROBLEMS = [];
const add = (code, detail) => PROBLEMS.push({ code, detail });
/** 允许出现的 IP（示例 / 公共 DNS / 回环 / 保留段）。 */
const IP_ALLOW = [
    /^127\./,
    /^0\.0\.0\.0$/,
    /^255\./,
    /^10\.\d+\.\d+\.\d+$/,          // 私有段：文档里当示例无妨
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,          // 私有段：示例可，但真实内网见下面额外规则
    /^223\.5\.5\.5$/,                // 阿里公共 DNS
    /^114\.114\.114\.114$/,
    /^8\.8\.8\.8$/,
    /^1\.1\.1\.1$/,
    /^10\.9\.9\.9$/,                 // 测试夹具
    /^1\.2\.3\.4$/,
];

/** 跟踪清单。 */
function trackedFiles() {
    if (scanAll) return walk(ROOT).map((f) => path.relative(ROOT, f));
    try {
        const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
        return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
        return walk(ROOT).map((f) => path.relative(ROOT, f));
    }
}

function walk(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else acc.push(full);
    }
    return acc;
}

const files = trackedFiles();

// ① 敏感路径
const SENSITIVE = [
    [/^\.runtime\//, '运行时日志目录'],
    [/^(vault|keys)\//, '凭证目录'],
    [/\/?servers\.json$/, '凭证库'],
    [/\/?master\.key$/, '主密钥'],
    [/\.pem$/i, '私钥文件'],
    [/\.ndjson$/, '操作日志'],
    [/\.(png|jpe?g|webp)$/i, '截图/位图（可能含真实 IP）'],
    [/^node_modules\//, '依赖目录'],
];
for (const f of files) {
    const normalized = f.split(path.sep).join('/');
    for (const [re, label] of SENSITIVE) {
        if (re.test(normalized)) add('SENSITIVE_PATH', `${f} ← ${label}`);
    }
}

// ②③④ 内容检查（只看文本类）
const TEXT_EXT = /\.(js|mjs|cjs|json|ya?ml|md|py|ts|txt|html|css|svg|sh|ps1)$/i;
for (const f of files) {
    if (!TEXT_EXT.test(f)) continue;
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split(/\r?\n/);

    lines.forEach((line, i) => {
        const where = `${f}:${i + 1}`;

        // ② 公网 IP
        for (const m of line.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
            const ip = m[0];
            const parts = ip.split('.').map(Number);
            if (parts.some((n) => n > 255)) continue;
            if (IP_ALLOW.some((re) => re.test(ip))) continue;
            add('PUBLIC_IP', `${where} → ${ip}`);
        }

        // ③ 本机绝对路径（用户名 / 工作区盘符路径）
        // 注意：Windows 路径可能写成反斜杠也可能写成正斜杠，两种都要认
        // （子代理审查实测发现旧版只认反斜杠，`C:/Users/xxx/...` 能过闸）。
        //
        // 占位符判定要**窄**：只认 xxx / you / <name> 这类明显假名。
        // 不要为了「少误报」把 someone / user / name 也放进来 —— 那些在真实机器上完全可能是真用户名。
        // `${user}` 这类**模板插值**是代码里正常的路径拼装，不是写死的本机路径，要放过
        // （否则闸门会把所有「拼路径的代码」都当成泄露，那它就没法用了）。
        const HOME_PLACEHOLDER = /^(xxx+|you|yourname|username|<[^>]*>|\$\{[^}]*\}|\*+|\.\.\.|foo|bar)$/i;
        const winHome = line.match(/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([^\\/\s"']+)/gi) ?? [];
        for (const m of winHome) {
            const user = m.split(/[\\/]/).pop();
            if (HOME_PLACEHOLDER.test(user.trim())) continue;
            if (line.includes('.dsh')) continue;          // ~/.dsh 是文档里的标准路径
            add('LOCAL_PATH', `${where} → 用户目录绝对路径（${user}）`);
        }
        // 具体到某个已知工作区/项目根（两种斜杠）
        if (/[A-Za-z]:[\\/]+codex[\\/]+(projects|credentials)/i.test(line)) {
            add('LOCAL_PATH', `${where} → 工作区绝对路径`);
        }
        // POSIX 的真实家目录（同样只放过明显的假名）
        const posixHome = line.match(/\/home\/([A-Za-z0-9._*-]+)/g) ?? [];
        for (const m of posixHome) {
            const user = m.split('/').pop();
            if (HOME_PLACEHOLDER.test(user)) continue;
            add('LOCAL_PATH', `${where} → POSIX 家目录 /home/${user}`);
        }

        // ④ 私钥块 / 密码明文 / token
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) add('PRIVATE_KEY', where);

        // 密码：只抓**字面量**。`password: args.password` / `password=passphrase` 这类
        // 是「从变量取值」的正常代码，不是泄露；注释里讨论 password= 形态也不是。
        const isComment = /^\s*(\/\/|#|\*|<!--)/.test(line);
        if (!isComment) {
            const pw = line.match(/\b(?:password|passwd|pwd)\b\s*[:=]\s*(.+)$/i);
            if (pw) {
                const rawValue = pw[1].trim().replace(/[,;)}\]]+$/, '').trim();
                const quoted = rawValue.match(/^(['"`])(.*)\1$/);
                const literal = quoted ? quoted[2] : null;
                const looksLikeIdentifier = /^[A-Za-z_$][\w$]*(\.[\w$]+|\[[^\]]*\])*(\([^)]*\))?$/.test(rawValue);
                const looksLikeVar = /^[A-Za-z_$][\w$.\[\]'"()\s]*$/.test(rawValue) && !quoted;
                // 占位符判定**只认明确形态**。旧版用 `/^<?[\w.-]*>?$/` 把「纯字母数字」一律当占位符，
                // 结果 `CorrectHorseBatteryStaple99` 这种真密码能直接过闸（子代理实测）。
                const isPlaceholder = literal === null
                    ? true
                    : /^(\*+|<[^>]*>|your[-_ ].*|xxx+|placeholder|example|sample|null|undefined|none|true|false|demo|test|changeme)$/i.test(literal);
                // 只有「带引号的、看起来像真密码的字面量」才算问题
                if (quoted && !looksLikeVar && !looksLikeIdentifier && !isPlaceholder && literal.length >= 6) {
                    add('PLAIN_PASSWORD', where);
                }
            }
        }
        if (/\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/.test(line)) {
            add('TOKEN', where);
        }

        // ⑤ 真实 SSH 端口。
        //    「任何 IPv4:port」太宽 —— 代理 7890、HTTP 8080、时间 10:30 都会误伤。
        //    只查「公网 IPv4 + 非默认端口」，因为那才是真实基础设施的样子。
        for (const m of line.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/g)) {
            const ip = m[1];
            const port = Number(m[2]);
            if (port === 22 || port === 80 || port === 443 || port < 1 || port > 65535) continue;
            if (IP_ALLOW.some((re) => re.test(ip))) continue;   // 回环/私有段当示例，不报
            add('SSH_PORT', `${where} → 疑似 SSH 端口 ${ip}:${port}`);
        }
    });
}

// ⑤ 仓库目录里的运行时数据（即使未被跟踪）
//    --strict-data 是给 pre-push 用的：连「存在但被 ignore 了」也算问题，
//    因为 ignore 只挡提交，不挡「有人手工 tar 整个目录」。
const strictData = process.argv.includes('--strict-data');
for (const dir of ['.runtime', 'vault', 'keys']) {
    const p = path.join(ROOT, dir);
    if (!fs.existsSync(p)) continue;
    const entries = fs.readdirSync(p).filter((n) => n !== '.gitkeep');
    if (entries.length === 0) continue;
    if (strictData) add('DATA_IN_REPO', `${dir}/ 里有 ${entries.length} 个文件（应放到 ~/.dsh/ssh-ops）`);
    else add('DATA_IN_REPO', `${dir}/ 存在于仓库目录内（应放到 ~/.dsh/ssh-ops）`);
}

// 汇总
console.log(`检查范围：${scanAll ? '全目录' : 'git 跟踪文件'}，共 ${files.length} 个文件`);
console.log('');
if (PROBLEMS.length === 0) {
    console.log('✓ 未发现敏感内容');
    console.log('STATUS: OK');
    process.exitCode = 0;
} else {
    const byCode = new Map();
    for (const p of PROBLEMS) {
        if (!byCode.has(p.code)) byCode.set(p.code, []);
        byCode.get(p.code).push(p.detail);
    }
    for (const [code, items] of byCode) {
        console.log(`✗ ${code}（${items.length} 处）`);
        for (const item of items.slice(0, 12)) console.log(`    ${item}`);
        if (items.length > 12) console.log(`    …另有 ${items.length - 12} 处`);
    }
    console.log('');
    console.log(`共 ${PROBLEMS.length} 处问题`);
    console.log('STATUS: BLOCK');
    process.exitCode = 1;
}
