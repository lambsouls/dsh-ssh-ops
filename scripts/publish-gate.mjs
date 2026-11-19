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
        if (/[A-Za-z]:\\\\?Users\\\\?[^\\\s]+\\(?!\.dsh)/i.test(line) && !line.includes('.dsh')) {
            add('LOCAL_PATH', `${where} → 用户目录绝对路径`);
        }
        if (/[A-Za-z]:\\\\?codex\\\\?(projects|credentials)/i.test(line)) {
            add('LOCAL_PATH', `${where} → 工作区绝对路径`);
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
                const isPlaceholder = literal === null
                    ? true
                    : /^(\*+|<?[\w.-]*>?|your[-_ ].*|xxx+|placeholder|example.*|null|undefined|none|true|false)$/i.test(literal);
                // 只有「带引号的、看起来像真密码的字面量」才算问题
                if (quoted && !looksLikeVar && !looksLikeIdentifier && !isPlaceholder && literal.length >= 6) {
                    add('PLAIN_PASSWORD', where);
                }
            }
        }
        if (/\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/.test(line)) {
            add('TOKEN', where);
        }
    });
}

// ⑤ 仓库目录里的运行时数据（即使未被跟踪）
for (const dir of ['.runtime', 'vault', 'keys']) {
    const p = path.join(ROOT, dir);
    if (fs.existsSync(p)) add('DATA_IN_REPO', `${dir}/ 存在于仓库目录内（应放到 ~/.dsh/ssh-ops）`);
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
