// lib/gate-rules.mjs —— 发布闸门的**唯一判据**。
//
// 为什么单独抽出来：本地闸门（publish-gate）和推送后复查（verify-remote）必须用同一套规则。
// 两处各写一份，迟早会漂移 —— 一边改了另一边没改，就会出现「本地说干净、远端其实有」或者反过来。
// 判据只有一份，两个入口共用。
//
// 所有函数都是纯函数，不碰文件系统，方便测试。

/** 允许出现的 IP（示例 / 公共 DNS / 回环 / 私有段 / 保留段）。 */
export const IP_ALLOW = [
    /^127\./,
    /^0\.0\.0\.0$/,
    /^255\./,
    /^10\.\d+\.\d+\.\d+$/,          // 私有段：文档里当示例无妨
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^223\.5\.5\.5$/,                // 阿里公共 DNS
    /^114\.114\.114\.114$/,
    /^8\.8\.8\.8$/,
    /^1\.1\.1\.1$/,
    /^10\.9\.9\.9$/,                 // 测试夹具
    /^1\.2\.3\.4$/,
    /^203\.0\.113\.\d+$/,            // TEST-NET-3，RFC 5737 文档专用保留段
    /^198\.51\.100\.\d+$/,           // TEST-NET-2
    /^192\.0\.2\.\d+$/,              // TEST-NET-1
];

/**
 * 家目录占位符白名单：只有**明显假名**才放过。
 * 不要为了少误报把 someone / user / name 加进来 —— 那些在真实机器上完全可能是真用户名，
 * 而且一旦放宽，就再也拦不住「真用户名」这种最该拦的情况。
 * `${...}` 是模板插值（代码里拼路径的正常写法），放过。
 */
export const HOME_PLACEHOLDER = /^(xxx+|you|yourname|username|<[^>]*>|\$\{[^}]*\}|\*+|\.\.\.|foo|bar)$/i;

const PASSWORD_PLACEHOLDER = /^(\*+|<[^>]*>|your[-_ ].*|xxx+|placeholder|example|sample|null|undefined|none|true|false|demo|test|changeme)$/i;

/** 以这些后缀结尾的当文本处理。 */
export const TEXT_EXT = /\.(js|mjs|cjs|json|ya?ml|md|py|ts|txt|html|css|svg|sh|ps1)$/i;

/** 某些路径本身就意味着「不该进仓库」。 */
export const SENSITIVE_PATH_RULES = [
    [/^\.runtime\//, '运行时日志目录'],
    [/^(vault|keys)\//, '凭证目录'],
    [/^profiles\//, '服务器档案目录'],
    [/\/?servers\.json$/, '凭证库'],
    [/\/?master\.key$/, '主密钥'],
    [/\.pem$/i, '私钥文件'],
    [/\.ndjson$/, '操作日志'],
    [/\.(png|jpe?g|webp)$/i, '截图/位图（可能含真实 IP）'],
    [/^node_modules\//, '依赖目录'],
    // 私密维护手册：里面写着本机路径与个人偏好，只该待在工作区，绝不进仓库
    [/dsh-ssh-ops-handoff\.md$/i, '私密维护手册（含本机路径与个人偏好）'],
];

/**
 * 真实 serverId 的形状：`<slug>-<6 位小写 hex>`（见 lib/crypto.js 的 newId）。
 *
 * 为什么需要这条判据：2026-11-19 公开版 HANDOFF.md 里写进了**一台真机的真实 serverId**，
 * 闸门当时报 OK —— 因为它只查 IP / 路径 / 密码 / 私钥这些模式，
 * 而 serverId 既不「长得像」敏感值，也不含任何可识别的敏感数据，但它是**本机标识**：
 * 配合公开的目录结构（`profiles/<serverId>.json`）就能指认某台真实机器的档案，
 * 加上拓扑描述还能推断出那台机器有什么薄弱点。**它属于「本机事实」，不该在公开面。**
 *
 * （这个注释里刻意不写那个真实 id —— 写了就会触发它自己的判据。见下面「宁可窄一点」。）
 *
 * 误报控制是这条判据的难点，试过三版才定下来：
 *    · 第一版：整行有「服务器」字样 + 行内有 id 形状 → 误伤严重，
 *      一行里只要出现那个词，任何类似形状的串都会被报，连测试夹具自己都进不去。
 *    · 第二版：要求「serverId / 这台服务器」这类强上下文 → **自测全绿但拦不住真实原文**，
 *      因为当初那段的上下文词是「音乐服务器」。教训：判据要拿真实样本验。
 *    · 现在：id 两侧 40 字符内出现 `服务器 / 档案 / 凭证 / profile / vault` 之一，
 *      且后缀必须是 6 位 hex（`newId` 用 randomBytes(3) = 6 位）。
 *      git 短哈希（7 位）、`@types/node-xxxxxx`（前面不是标识词）都不命中。
 *
 * 宁可窄一点：这条判据的目的是「抓住我把本机标识写进公开文档」，
 * 不是做通用标识符检测器。**会误伤的地方不要开。**
 */
const SERVER_ID_SHAPE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{6}\b/;

/**
 * 只在 id **紧邻**这些词时才认为它是本插件那台机器（而不是任意类似形状的串）。
 *
 * 这里特意把「服务器」本身也算进去 —— 真实漏网的那句里，id 前面的上下文词是
 * 「<某功能>服务器」而不是「这台服务器」。第一版只认后者的结果是：
 * **自测全绿，但真实泄漏原文拦不住**。判据要拿真实样本验，不能只拿自己造的样本验。
 */
const SERVER_ID_CONTEXT = /serverId|server_id|服务器|档案|凭证|profile|vault/i;

/** 明显是夹具/占位的 id：测试里用的假值不该被拦（否则测试文件自己进不去）。 */
const SERVER_ID_FIXTURE = /^(demo|test|fake|sample|example|xxx|placeholder|leaky|broken|orphan|cn|n|d|t|pm|music|foo|bar)-/i;

/**
 * 扫一段文本，返回问题列表。
 * @param {string} text
 * @returns {Array<{code: string, line: number, detail: string}>}
 */
export function scanContent(text) {
    const findings = [];
    const lines = String(text ?? '').split(/\r?\n/);
    const push = (code, line, detail) => findings.push({ code, line, detail });

    lines.forEach((line, idx) => {
        const lineNo = idx + 1;

        // ── 公网 IP ──
        for (const m of line.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
            const ip = m[0];
            if (ip.split('.').map(Number).some((n) => n > 255)) continue;
            if (IP_ALLOW.some((re) => re.test(ip))) continue;
            push('PUBLIC_IP', lineNo, ip);
        }

        // ── 真实 serverId（本机标识，配合目录结构能指认某台真实机器）──
        // 判据：id 两侧 40 个字符以内，必须出现「serverId / 服务器 ID / 这台服务器」这类明确上下文。
        // 只判「整行有没有服务器字样」会误伤 —— 一行里出现那个词，任何类似形状的串都会被报。
        for (const m of line.matchAll(new RegExp(SERVER_ID_SHAPE.source, 'g'))) {
            const candidate = m[0];
            if (SERVER_ID_FIXTURE.test(candidate)) continue;
            const start = Math.max(0, m.index - 40);
            const window = line.slice(start, m.index + candidate.length + 40);
            if (!SERVER_ID_CONTEXT.test(window)) continue;
            push('SERVER_ID', lineNo, candidate);
        }

        // ── Windows 家目录（反斜杠与正斜杠都认；模板插值放过；.dsh 是文档标准路径）──
        for (const m of line.matchAll(/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([^\\/\s"']+)/gi)) {
            const user = m[1];
            if (HOME_PLACEHOLDER.test(user.trim())) continue;
            if (line.includes('.dsh')) continue;
            push('LOCAL_PATH', lineNo, `用户目录绝对路径（${user}）`);
        }

        // ── 工作区路径：无条件拦，不做任何例外 ──
        // 旧版曾只查 projects/credentials 两个子目录，结果指向临时目录的一条路径漏过了闸门。
        if (/[A-Za-z]:[\\/]+codex[\\/]/i.test(line)) {
            push('LOCAL_PATH', lineNo, '工作区绝对路径');
        }

        // ── POSIX 家目录 ──
        for (const m of line.matchAll(/\/home\/([A-Za-z0-9._*-]+)/g)) {
            const user = m[1];
            if (HOME_PLACEHOLDER.test(user)) continue;
            push('LOCAL_PATH', lineNo, `POSIX 家目录 /home/${user}`);
        }

        // ── 私钥块 ──
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) push('PRIVATE_KEY', lineNo, '');

        // ── 密码字面量（只抓带引号、看起来像真密码的；变量取值是正常代码）──
        const isComment = /^\s*(\/\/|#|\*|<!--)/.test(line);
        if (!isComment) {
            const pw = line.match(/\b(?:password|passwd|pwd)\b\s*[:=]\s*(.+)$/i);
            if (pw) {
                const raw = pw[1].trim().replace(/[,;)}\]]+$/, '').trim();
                const quoted = raw.match(/^(['"`])(.*)\1$/);
                const literal = quoted ? quoted[2] : null;
                const looksLikeIdentifier = /^[A-Za-z_$][\w$]*(\.[\w$]+|\[[^\]]*\])*(\([^)]*\))?$/.test(raw);
                const looksLikeVar = /^[A-Za-z_$][\w$.\[\]'"()\s]*$/.test(raw) && !quoted;
                const isPlaceholder = literal === null ? true : PASSWORD_PLACEHOLDER.test(literal);
                if (quoted && !looksLikeVar && !looksLikeIdentifier && !isPlaceholder && literal.length >= 6) {
                    push('PLAIN_PASSWORD', lineNo, '');
                }
            }
        }

        // ── 常见 token 形状 ──
        if (/\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/.test(line)) {
            push('TOKEN', lineNo, '');
        }

        // ── 公网 IPv4 + 非默认端口（真实基础设施长相）──
        for (const m of line.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/g)) {
            const ip = m[1];
            const port = Number(m[2]);
            if (port === 22 || port === 80 || port === 443 || port < 1 || port > 65535) continue;
            if (IP_ALLOW.some((re) => re.test(ip))) continue;
            push('SSH_PORT', lineNo, `${ip}:${port}`);
        }
    });

    return findings;
}

/** 检查一个仓库相对路径够不够「敏感」。 */
export function scanPath(relPath) {
    const normalized = String(relPath).split('\\').join('/');
    const hits = [];
    for (const [re, label] of SENSITIVE_PATH_RULES) {
        if (re.test(normalized)) hits.push({ code: 'SENSITIVE_PATH', detail: `${normalized} ← ${label}` });
    }
    return hits;
}

/** 汇总成可读报告文本。 */
export function summarize(findings) {
    const byCode = new Map();
    for (const f of findings) {
        if (!byCode.has(f.code)) byCode.set(f.code, []);
        byCode.get(f.code).push(f);
    }
    return byCode;
}

