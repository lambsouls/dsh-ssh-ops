// lib/redact.js —— 输出脱敏。
//
// 两个层次：
//   ① 已知凭证值精确替换（服务器密码 / 私钥 / passphrase / 密钥文件内容）；
//   ② 常见敏感模式兜底（OpenSSH 私钥块、`password=...`、Bearer、AWS/GitHub token 形状）。
// 控制台、工具返回、日志一律先过这里；凭证值本身从不入库到日志。

const MASK = '******';

/** 私钥块整段抹掉（保留首尾标识，便于排错时判断是哪种算法）。 */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

const PATTERNS = [
    // sshpass -p 'xxx' / -p"xxx"
    [/\b(sshpass\b[^\n]*?-p\s*)(['"]?)[^\s'"]+\2/gi, `$1$2${MASK}$2`],
    // password= / passwd: / pwd =
    [/\b(pass(?:word|wd|phrase)?\s*[=:]\s*)(['"]?)[^\s'"]{2,}\2/gi, `$1$2${MASK}$2`],
    // Authorization: Bearer xxx
    [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${MASK}`],
    // 常见云/token 形状
    [/\b(sk-[A-Za-z0-9]{16,})/g, MASK],
    [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, MASK],
    [/\b(AKIA[0-9A-Z]{16})\b/g, MASK],
];

export function createRedactor() {
    /** 动态登记的敏感字面量（只留在内存，不落盘）。 */
    const literals = new Set();

    const api = {
        /** 登记一条敏感值；长度 < 4 的忽略，避免把 "22" 这种数字也抹掉。 */
        add(value) {
            if (typeof value !== 'string') return;
            const v = value.trim();
            if (v.length < 4) return;
            literals.add(v);
            // 私钥按行也登记一遍：远端 echo 单行时同样能命中
            if (v.includes('PRIVATE KEY')) {
                for (const line of v.split(/\r?\n/)) {
                    const t = line.trim();
                    if (t.length >= 24 && !t.startsWith('-----')) literals.add(t);
                }
            }
        },
        addAll(values) {
            for (const v of values ?? []) api.add(v);
        },
        /** 清空（插件卸载时）。 */
        clear() { literals.clear(); },
        /** 脱敏一段文本。 */
        text(input) {
            if (typeof input !== 'string' || input === '') return input ?? '';
            let out = input.replace(PEM_BLOCK, (_m, kind) => `-----BEGIN ${kind}-----${MASK}-----END ${kind}-----`);
            // 长字面量优先替换，避免短值先把长值切碎
            const sorted = [...literals].sort((a, b) => b.length - a.length);
            for (const lit of sorted) {
                if (out.includes(lit)) out = out.split(lit).join(MASK);
            }
            for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
            return out;
        },
        /** 脱敏一个结构化返回里的所有字符串（深拷贝）。 */
        deep(value) {
            if (typeof value === 'string') return api.text(value);
            if (Array.isArray(value)) return value.map((v) => api.deep(v));
            if (value && typeof value === 'object') {
                const out = {};
                for (const [k, v] of Object.entries(value)) out[k] = api.deep(v);
                return out;
            }
            return value;
        },
        /** 只给测试/诊断用：登记了多少条。 */
        size() { return literals.size; },
    };
    return api;
}

export { MASK };
