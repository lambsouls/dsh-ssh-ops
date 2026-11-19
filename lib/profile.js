// lib/profile.js —— 每台服务器自己的「档案」。
//
// 为什么要有这个东西：
//   凭证库记录的是「怎么连」（host / port / user / 密码），环境探测记录的是「此刻有什么」
//   （发行版、容器、监听端口）。但运维真正会踩的坑往往**不在**这两者里，而是这台机器
//   独有的脾气：
//     · 和别人的机器共享一个公网 IP，我们只有其中一段端口 → 对外端口和内部端口对不上，
//       这层映射在机器内部 `ss` 看不见（是接入侧转发的），不问就永远推不出来；
//     · 数据不在本地盘，在网盘挂载上 → 清缓存和清数据是两件事；
//     · 这台机器的出网被限，拉不了 Docker Hub → 任何「docker pull」的想法都是错的；
//     · 某个服务是别人在用的，重启会把别人的东西一起打掉。
//   这些是**知识**，不是**状态**。状态每次探测都能重新得到，知识丢了就再也想不起来。
//   所以给每台服务器一份独立档案，出问题第一件事是翻它。
//
// 和凭证的关系：
//   · 档案不加密（要能直接读、要能在出问题时被 grep 到），但同样**不进仓库**；
//   · 档案以 serverId 为键，与凭证解耦 —— 改密码、换认证方式都不会丢档案；
//   · 档案里**永远不写密码、私钥、passphrase**。凭据归 vault，档案归知识。
//
// 一条硬规则：每条事实都带 source。
//   owner = 主人明确告知（最高权威，不要自己推翻）
//   probe = 工具实测（会随环境漂移，过期了要重测）
//   agent = 推理得出（最低权威，写明推论依据，被推翻就改）

import fs from 'node:fs';
import path from 'node:path';
import { profileFile } from './paths.js';

const VERSION = 1;

/** 事实来源：权限从高到低。owner 说的话不要自动改写。 */
export const SOURCES = ['owner', 'probe', 'agent'];

/** 严重度：影响「做错会怎样」。 */
export const SEVERITIES = ['info', 'note', 'warn', 'critical'];

/** trait 的类别：让人一眼知道这是哪一类特征。 */
export const TRAIT_KINDS = ['network', 'access', 'storage', 'runtime', 'dependency', 'behavior', 'ownership', 'other'];

/**
 * serverId 会直接变成文件名，所以只能接受严格字符集 —— 它来自凭证库，本来就是 ASCII。
 * ⚠️ 别拿这个正则去校验「档案条目的 id」：条目 id 由标题生成，标题可以是中文
 * （见 ITEM_ID_RE）。两个场景混用一个正则，会让中文标题的条目生成不出合法 id、
 * 于是每次「更新它」都被当成新条目丢弃 —— 这个 bug 真的发生过。
 */
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** 档案条目 id：只活 JSON 里，允许中文与空格以外的常见字符。 */
const ITEM_ID_RE = /^[A-Za-z0-9._\u4e00-\u9fa5-]{1,80}$/;

function nowIso() {
    return new Date().toISOString();
}

/** serverId 直接进文件名，必须先确认它不含路径分隔符。 */
function assertServerId(serverId) {
    const id = String(serverId ?? '').trim();
    if (!ID_RE.test(id)) throw new Error(`服务器 ID 不合法（只允许字母数字 . _ -）：${id}`);
    return id;
}

/** 从标题生成稳定的 slug（同标题得到同 id，重复写入就是更新而不是新增）。 */
function slug(text, fallback = 'item') {
    const base = String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return base || fallback;
}

function oneOf(value, allowed, fallback) {
    const v = String(value ?? '').trim().toLowerCase();
    return allowed.includes(v) ? v : fallback;
}

function str(value, max = 4000) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    return s ? s.slice(0, max) : null;
}

/** 端口：容忍 "10207" / "10207/tcp" / "10207-10209"。返回整数或 null。 */
function asPort(value) {
    if (value === undefined || value === null || value === '') return null;
    const m = /(\d{1,5})/.exec(String(value));
    if (!m) return null;
    const n = Number(m[1]);
    return n > 0 && n <= 65535 ? n : null;
}

// ─── 归一化 ────────────────────────────────────────────────────────────────

function normalizeTrait(raw, index) {
    // title 允许为空：只给 id 的调用是「更新已有条目的某个字段」，不该被当成非法数据丢掉。
    // 是否保留由 prepareIncoming 判定（无 title 且 id 不在已有集合里 → 丢弃）。
    const title = str(raw?.title ?? raw?.name, 200);
    const id = ITEM_ID_RE.test(String(raw?.id ?? '')) ? String(raw.id) : (title ? slug(raw?.id ?? title, `trait-${index + 1}`) : null);
    return {
        id,
        title,
        // 下面四项故意留 null：值是 null 表示「本次没提供」，合并时就不会覆盖已有值，
        // 也不需要为「默认值」和「显式给的值」准备两套判断。默认值统一在 finalize 里补。
        kind: oneOf(raw?.kind, TRAIT_KINDS, null),
        severity: oneOf(raw?.severity, SEVERITIES, null),
        source: oneOf(raw?.source, SOURCES, null),
        detail: str(raw?.detail, 4000),
        impact: str(raw?.impact, 2000),
        evidence: str(raw?.evidence, 2000),
        since: str(raw?.since, 40),
    };
}

function normalizePortMapEntry(raw, index) {
    const app = str(raw?.app, 120);
    const pub = asPort(raw?.public);
    const inner = asPort(raw?.internal);
    if (pub === null && app === null) return null;
    return {
        id: ITEM_ID_RE.test(String(raw?.id ?? '')) ? String(raw.id) : slug(`${pub ?? 'x'}-${app ?? 'x'}`, `pm-${index + 1}`),
        // 端口可能是「本次不提供」，所以要区分「没给」和「给了空」：
        // 合并时 null 不覆盖已有值，因此记录「这次到底说了没说」。
        public: pub,
        publicGiven: raw?.public !== undefined,
        internal: inner,
        internalGiven: raw?.internal !== undefined,
        app,
        proto: oneOf(raw?.proto, ['http', 'https', 'tcp', 'udp', 'ssh', 'other'], null),
        note: str(raw?.note, 1000),
        source: oneOf(raw?.source, SOURCES, null),
    };
}

function normalizeConstraint(raw, index) {
    const text = str(typeof raw === 'string' ? raw : raw?.text, 2000);
    if (!text) return null;
    return {
        id: ITEM_ID_RE.test(String(raw?.id ?? '')) ? String(raw.id) : slug(typeof raw === 'string' ? raw : (raw?.id ?? text), `c-${index + 1}`),
        text,
        severity: oneOf(typeof raw === 'string' ? undefined : raw?.severity, SEVERITIES, null),
        source: oneOf(typeof raw === 'string' ? undefined : raw?.source, SOURCES, null),
    };
}

function normalizeRunbook(raw, index) {
    const name = str(raw?.name ?? raw?.title, 200);
    if (!name) return null;
    const steps = (Array.isArray(raw?.steps) ? raw.steps : [raw?.steps])
        .map((s) => str(s, 2000))
        .filter(Boolean);
    return {
        id: ITEM_ID_RE.test(String(raw?.id ?? '')) ? String(raw.id) : slug(raw?.id ?? name, `rb-${index + 1}`),
        name,
        when: str(raw?.when, 500),
        steps,
        verifiedAt: str(raw?.verifiedAt, 40),
        source: oneOf(raw?.source, SOURCES, null),
    };
}

function normalizeTimelineEntry(raw, index) {
    const text = str(typeof raw === 'string' ? raw : raw?.text, 2000);
    if (!text) return null;
    return {
        at: str(raw?.at, 40) ?? nowIso(),
        kind: oneOf(typeof raw === 'string' ? undefined : raw?.kind, ['change', 'incident', 'note', 'decision'], 'note'),
        text,
        // 时间线条目本身不会超过 MAX_TIMELINE，但 index 参与 id 兜底，保留参数形态
        _i: index,
    };
}

const MAX_TIMELINE = 200;

function normalizeTimeline(list) {
    return (Array.isArray(list) ? list : [])
        .map(normalizeTimelineEntry)
        .filter(Boolean)
        .map(({ _i, ...rest }) => rest)
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .slice(-MAX_TIMELINE);
}

/**
 * 补默认值。放在「合并之后、落盘之前」的唯一一处：
 * 归一化阶段留 null 表示「本次没提供」，合并阶段不会用 null 覆盖已有值，
 * 到这里才给真正的默认值 —— 这样「只更新一个字段」不会把别的字段重置成默认。
 */
function finalize(profile) {
    const p = { ...profile };
    p.traits = (p.traits ?? []).map((t) => ({
        ...t,
        title: t.title ?? '',
        kind: t.kind ?? 'other',
        severity: t.severity ?? 'note',
        source: t.source ?? 'agent',
    })).filter((t) => t.id);
    p.portMap = (p.portMap ?? []).map((m) => ({ ...m, proto: m.proto ?? 'http', source: m.source ?? 'owner' }))
        .map(({ publicGiven, internalGiven, ...m }) => m);
    p.constraints = (p.constraints ?? []).map((c) => ({
        ...c,
        severity: c.severity ?? 'warn',
        source: c.source ?? 'owner',
    }));
    p.runbooks = (p.runbooks ?? []).map((r) => ({ ...r, source: r.source ?? 'agent' }));
    return p;
}

/**
 * 合并一批「本次提供的条目」进已有列表。
 *
 * 三条规则，都是为了「只改一个字段不能弄坏别的字段」：
 *   ① 给了 id 且已存在 → 覆盖本次提供的字段，null/undefined 的不动；
 *   ② 给了 id 但不认识 → 追加（允许引用尚不存在的条目，配合后续补全）；
 *   ③ 没给 id：有 title 就按 title 生成 id 再走 ①/②；连 title 都没有 → 丢弃（没有任何可用信息）。
 */
function mergeItems(existing, incoming) {
    const out = existing.map((e) => ({ ...e }));
    const known = new Set(out.map((e) => e.id));
    for (const item of incoming) {
        if (!item.id) continue;
        const at = out.findIndex((e) => e.id === item.id);
        if (at >= 0) {
            const patch = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== null && v !== undefined));
            out[at] = { ...out[at], ...patch };
        } else if (known.has(item.id)) {
            continue;
        } else {
            // 新条目必须有可读的标题或正文，否则只是噪音
            const meaningful = item.title || item.text || item.name || item.app;
            if (!meaningful) continue;
            out.push(item);
            known.add(item.id);
        }
    }
    return out;
}

function emptyProfile(server = {}) {
    const at = nowIso();
    return {
        version: VERSION,
        serverId: server.id ?? null,
        name: server.name ?? server.host ?? null,
        host: server.host ?? null,
        createdAt: at,
        updatedAt: at,
        summary: null,
        role: null,
        traits: [],
        portMap: [],
        constraints: [],
        runbooks: [],
        timeline: [],
        openQuestions: [],
    };
}

/** 把任意输入压成合法档案。宽进严出：坏字段丢弃，不因一条脏数据整个档案读不出来。 */
export function normalizeProfile(raw, server = {}) {
    const base = emptyProfile(server);
    const p = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
    return {
        version: VERSION,
        serverId: str(p.serverId, 80) ?? base.serverId,
        name: str(p.name, 200) ?? base.name,
        host: str(p.host, 200) ?? base.host,
        createdAt: str(p.createdAt, 40) ?? base.createdAt,
        updatedAt: str(p.updatedAt, 40) ?? base.updatedAt,
        summary: str(p.summary, 1000),
        role: str(p.role, 200),
        traits: (Array.isArray(p.traits) ? p.traits : []).map(normalizeTrait).filter(Boolean),
        portMap: (Array.isArray(p.portMap) ? p.portMap : []).map(normalizePortMapEntry).filter(Boolean),
        constraints: (Array.isArray(p.constraints) ? p.constraints : []).map(normalizeConstraint).filter(Boolean),
        runbooks: (Array.isArray(p.runbooks) ? p.runbooks : []).map(normalizeRunbook).filter(Boolean),
        timeline: normalizeTimeline(p.timeline),
        openQuestions: (Array.isArray(p.openQuestions) ? p.openQuestions : []).map((q) => str(q, 1000)).filter(Boolean),
    };
}

// ─── 读写 ──────────────────────────────────────────────────────────────────

/**
 * @param {{ profileDir: string }} options
 */
export function createProfiles({ profileDir }) {
    fs.mkdirSync(profileDir, { recursive: true });

    function read(serverId) {
        const id = assertServerId(serverId);
        const file = profileFile(profileDir, id);
        if (!fs.existsSync(file)) return null;
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            throw new Error(`档案 ${file} 不是合法 JSON：${error?.message ?? error}`);
        }
        // 落盘的是 finalize 过的成品；读回来再跑一遍 normalize+finalize，
        // 保证「手改过的档案」也能被当成合法输入（宽进），而不是直接抛错。
        return finalize(normalizeProfile(parsed, { id }));
    }

    function write(profile) {
        const id = assertServerId(profile.serverId);
        const file = profileFile(profileDir, id);
        const tmp = `${file}.tmp-${process.pid}`;
        const payload = { ...finalize(normalizeProfile(profile, { id })), updatedAt: nowIso() };
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, file);
        return payload;
    }

    const api = {
        dir: profileDir,

        exists(serverId) {
            try {
                return fs.existsSync(profileFile(profileDir, assertServerId(serverId)));
            } catch { return false; }
        },

        /** 读档案；没有就返回 null（不自动创建 —— 空档案会让人误以为「已经记过了」）。 */
        get(serverId) {
            return read(serverId);
        },

        /** 读档案，没有就用这份 server 元信息起一个（只写回，不落盘）。 */
        getOrDefault(server) {
            const id = assertServerId(server?.id);
            return read(id) ?? normalizeProfile(null, server);
        },

        /** 新建或覆盖整份档案。 */
        put(server, patch) {
            const id = assertServerId(server?.id);
            const existing = read(id);
            const merged = applyPatch(existing ?? emptyProfile(server), patch, { server });
            return write({ ...merged, serverId: id, host: server.host ?? merged.host, name: server.name ?? merged.name });
        },

        /** 增量更新（推荐）：只给要改的字段。 */
        patch(server, patch) {
            const id = assertServerId(server?.id);
            const existing = read(id);
            const base = existing ?? emptyProfile(server);
            const merged = applyPatch(base, patch, { server });
            return write({ ...merged, serverId: id });
        },

        remove(serverId) {
            const id = assertServerId(serverId);
            const file = profileFile(profileDir, id);
            if (!fs.existsSync(file)) return false;
            fs.unlinkSync(file);
            return true;
        },

        /** 所有档案的极简摘要，给清单用。读不出来的档案跳过（不因此让整个清单失败）。 */
        summaries() {
            const out = new Map();
            let files = [];
            try { files = fs.readdirSync(profileDir).filter((f) => f.endsWith('.json')); } catch { return out; }
            for (const f of files) {
                const id = f.slice(0, -5);
                if (!ID_RE.test(id)) continue;
                try {
                    const profile = read(id);
                    if (!profile) continue;
                    out.set(id, {
                        summary: profile.summary,
                        role: profile.role,
                        traitCount: profile.traits.length,
                        constraintCount: profile.constraints.length,
                        portMapCount: profile.portMap.length,
                        openQuestionCount: profile.openQuestions.length,
                        updatedAt: profile.updatedAt,
                    });
                } catch { /* 单份档案坏了不该拖垮清单 */ }
            }
            return out;
        },

        /**
         * 档案与凭证库的一致性检查：有凭证没档案、有档案没凭证、档案里写了密码。
         * 给一次性的「体检」用，不在每次读取时跑。
         *
         * ⚠️ 泄漏检测必须读**磁盘原文**：read() 会归一化，password 这类未知字段会被丢掉，
         * 那样查「档案里有没有写密码」永远查得出来「没有」—— 测的是被清洗过的副本，不是磁盘。
         */
        audit(servers) {
            const haveVault = new Set((servers ?? []).map((s) => s.id));
            const summaries = api.summaries();
            const missingProfile = (servers ?? []).filter((s) => !summaries.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
            const orphanProfile = [...summaries.keys()].filter((id) => !haveVault.has(id));
            const leaks = [];
            for (const id of summaries.keys()) {
                let raw;
                try { raw = fs.readFileSync(profileFile(profileDir, id), 'utf8'); } catch { continue; }
                if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) leaks.push({ id, what: '私钥块' });
                if (/"password"\s*:/i.test(raw)) leaks.push({ id, what: 'password 字段' });
            }
            return { missingProfile, orphanProfile, leaks };
        },
    };
    return api;
}

/**
 * 把一次 patch 应用到档案上。
 * 列表字段一律「按 id upsert」而不是整体替换 —— 运维时会反复追加，
 * 替换语义一不小心就把上次记的东西抹掉，而档案的价值全在积累。
 */
function applyPatch(base, patch = {}, { server } = {}) {
    const next = { ...base };
    const p = patch ?? {};

    if (p.summary !== undefined) next.summary = str(p.summary, 1000);
    if (p.role !== undefined) next.role = str(p.role, 200);
    if (p.name !== undefined && str(p.name, 200)) next.name = str(p.name, 200);
    if (server?.host && !next.host) next.host = server.host;

    if (p.traits !== undefined) {
        const incoming = (Array.isArray(p.traits) ? p.traits : [p.traits]).map(normalizeTrait).filter(Boolean);
        next.traits = mergeItems(next.traits ?? [], incoming);
    }
    if (p.portMap !== undefined) {
        const incoming = (Array.isArray(p.portMap) ? p.portMap : [p.portMap]).map(normalizePortMapEntry).filter(Boolean);
        // 端口有两种「没变」：没提供、以及提供了 null（显式不知道）。两种都不该抹掉已记下的数字，
        // 所以先把 null 端口换成 undefined（mergeItems 会跳过），再放开「显式清空」的入口。
        next.portMap = mergeItems(
            (next.portMap ?? []).map((m) => ({ ...m, public: m.public ?? undefined, internal: m.internal ?? undefined })),
            incoming.map((m) => ({
                ...m,
                public: m.publicGiven ? (m.public ?? null) : undefined,
                internal: m.internalGiven ? (m.internal ?? null) : undefined,
            })),
        );
    }
    if (p.constraints !== undefined) {
        const incoming = (Array.isArray(p.constraints) ? p.constraints : [p.constraints]).map(normalizeConstraint).filter(Boolean);
        next.constraints = mergeItems(next.constraints ?? [], incoming);
    }
    if (p.runbooks !== undefined) {
        const incoming = (Array.isArray(p.runbooks) ? p.runbooks : [p.runbooks]).map(normalizeRunbook).filter(Boolean);
        next.runbooks = mergeItems(next.runbooks ?? [], incoming);
    }
    if (p.timeline !== undefined) {
        const incoming = (Array.isArray(p.timeline) ? p.timeline : [p.timeline]).map(normalizeTimelineEntry).filter(Boolean);
        next.timeline = normalizeTimeline([...(next.timeline ?? []), ...incoming.map(({ _i, ...r }) => r)]);
    }
    if (p.openQuestions !== undefined) {
        const incoming = (Array.isArray(p.openQuestions) ? p.openQuestions : [p.openQuestions]).map((q) => str(q, 1000)).filter(Boolean);
        // 待确认项是「问主人的问题」，去重追加即可
        next.openQuestions = [...new Set([...(next.openQuestions ?? []), ...incoming])];
    }

    // 删除只在明确给出 id 时发生
    const drop = (list, ids) => (Array.isArray(ids) && ids.length ? list.filter((e) => !ids.includes(e.id)) : list);
    if (p.removeTraitIds !== undefined) next.traits = drop(next.traits ?? [], p.removeTraitIds);
    if (p.removePortMapIds !== undefined) next.portMap = drop(next.portMap ?? [], p.removePortMapIds);
    if (p.removeConstraintIds !== undefined) next.constraints = drop(next.constraints ?? [], p.removeConstraintIds);
    if (p.removeRunbookIds !== undefined) next.runbooks = drop(next.runbooks ?? [], p.removeRunbookIds);
    if (p.resolveQuestions !== undefined) {
        const asked = Array.isArray(p.resolveQuestions) ? p.resolveQuestions : [p.resolveQuestions];
        next.openQuestions = (next.openQuestions ?? []).filter((q) => !asked.some((a) => String(q).includes(String(a))));
    }

    next.updatedAt = nowIso();
    return finalize(normalizeProfile(next, server ?? {}));
}

// ─── 渲染（给模型看的纯文本） ──────────────────────────────────────────────

const SEVERITY_MARK = { info: '·', note: '·', warn: '▲', critical: '‼' };
const SOURCE_MARK = { owner: '主人', probe: '实测', agent: '推断' };
const TIMELINE_MARK = { change: '改', incident: '故', note: '记', decision: '定' };

/** 摘要一行：给清单/探测结果附带用，控制在一行内。 */
export function renderProfileLine(summary) {
    if (!summary) return null;
    const bits = [];
    if (summary.traitCount) bits.push(`${summary.traitCount} 特征`);
    if (summary.portMapCount) bits.push(`${summary.portMapCount} 端口映射`);
    if (summary.constraintCount) bits.push(`${summary.constraintCount} 约束`);
    if (summary.openQuestionCount) bits.push(`${summary.openQuestionCount} 待确认`);
    return [summary.summary ?? summary.role ?? '', bits.length ? `（档案：${bits.join(' / ')}）` : '（档案）'].join('');
}

/**
 * 完整渲染。这是模型读档案的唯一形态 —— 刻意做成文本而不是 JSON：
 * 档案要能被「读懂」而不是「解析」，出问题时人和模型看的是同一段话。
 */
export function renderProfile(profile) {
    if (!profile) return '（这台服务器还没有档案）';
    const lines = [];
    const head = [profile.name ?? profile.serverId];
    if (profile.role) head.push(profile.role);
    lines.push(`▣ 档案 · ${head.join(' · ')}`);
    if (profile.host) lines.push(`  地址 ${profile.host}`);
    if (profile.summary) lines.push(`  ${profile.summary}`);
    lines.push(`  更新 ${profile.updatedAt ?? '—'}`);

    if (profile.traits.length) {
        lines.push('', `【专属特征】${profile.traits.length} 条`);
        for (const t of profile.traits) {
            lines.push(`  ${SEVERITY_MARK[t.severity] ?? '·'} [${t.kind}] ${t.title}  （${SOURCE_MARK[t.source] ?? t.source}${t.since ? ` · ${t.since}` : ''}）`);
            if (t.detail) lines.push(`      ${indent(t.detail)}`);
            if (t.impact) lines.push(`      运维含义：${indent(t.impact)}`);
            if (t.evidence) lines.push(`      依据：${indent(t.evidence)}`);
        }
    }

    if (profile.portMap.length) {
        lines.push('', '【对外端口 → 内部】');
        for (const m of profile.portMap) {
            const left = m.public ? `:${m.public}` : '—';
            const right = m.internal ? `:${m.internal}` : '—';
            lines.push(`  ${left} → ${right}  ${m.app ?? ''}${m.proto && m.proto !== 'http' ? ` (${m.proto})` : ''}${m.note ? `  — ${m.note}` : ''}`);
        }
    }

    if (profile.constraints.length) {
        lines.push('', '【硬约束 / 不要碰】');
        for (const c of profile.constraints) {
            lines.push(`  ${SEVERITY_MARK[c.severity] ?? '·'} ${c.text}  （${SOURCE_MARK[c.source] ?? c.source}）`);
        }
    }

    if (profile.runbooks.length) {
        lines.push('', '【常用处置】');
        for (const r of profile.runbooks) {
            lines.push(`  ▸ ${r.name}${r.when ? `（何时用：${r.when}）` : ''}${r.verifiedAt ? ` · 验证于 ${r.verifiedAt}` : ''}`);
            r.steps.forEach((s, i) => lines.push(`      ${i + 1}. ${indent(s)}`));
        }
    }

    if (profile.openQuestions.length) {
        lines.push('', '【待确认（问主人，不要猜）】');
        profile.openQuestions.forEach((q) => lines.push(`  ？ ${q}`));
    }

    if (profile.timeline.length) {
        const recent = profile.timeline.slice(-12);
        lines.push('', `【时间线】最近 ${recent.length} 条（共 ${profile.timeline.length} 条）`);
        for (const t of recent) {
            lines.push(`  ${String(t.at).slice(0, 16).replace('T', ' ')} [${TIMELINE_MARK[t.kind] ?? t.kind}] ${indent(t.text)}`);
        }
    }

    return lines.join('\n');
}

function indent(text) {
    return String(text ?? '').replace(/\r?\n/g, '\n      ');
}

export { emptyProfile, assertServerId, asPort };
