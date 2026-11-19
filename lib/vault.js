// lib/vault.js —— 服务器凭证库。
//
// 结构：servers.json 里一份数组，明文只放「可以给用户看」的元信息
// （名字、地址、端口、用户名、认证方式、已装应用清单、备注），
// 密码 / 私钥 / passphrase 一律 seal() 成密文放 `secrets` 字段。
//
// 对外只暴露 view()（永远不含密文与明文），解密后的原始记录只在本模块与 ssh.js 之间流转。

import fs from 'node:fs';
import path from 'node:path';
import { seal, open, newId } from './crypto.js';
import { vaultFile, keyDir } from './paths.js';

const VERSION = 1;

function readRaw(vaultDir) {
    const file = vaultFile(vaultDir);
    if (!fs.existsSync(file)) return { version: VERSION, servers: [] };
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`凭证库 ${file} 不是合法 JSON：${error?.message ?? error}`);
    }
    if (!parsed || !Array.isArray(parsed.servers)) throw new Error(`凭证库 ${file} 结构异常（缺 servers 数组）`);
    return parsed;
}

function writeRaw(vaultDir, data) {
    fs.mkdirSync(vaultDir, { recursive: true });
    const file = vaultFile(vaultDir);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

/** 一条记录的公开视图：不含 secrets / 不含任何密钥材料。 */
export function view(entry) {
    const apps = Array.isArray(entry.apps) ? entry.apps : [];
    return {
        id: entry.id,
        name: entry.name ?? entry.host,
        host: entry.host,
        port: entry.port ?? 22,
        user: entry.user,
        auth: entry.authType === 'key' ? 'key' : 'password',
        hasSecret: Boolean(entry.secrets),
        keyPath: entry.keyPath ?? null,
        apps: apps.map((a) => ({
            name: a.name,
            kind: a.kind ?? 'generic',
            port: a.port ?? null,
            manager: a.manager ?? null,
            service: a.service ?? null,
            notes: a.notes ?? null,
        })),
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        notes: entry.notes ?? null,
        reachable: entry.reachable ?? null,
        reachableAt: entry.reachableAt ?? null,
        createdAt: entry.createdAt ?? null,
        updatedAt: entry.updatedAt ?? null,
        lastUsedAt: entry.lastUsedAt ?? null,
        os: entry.os ?? null,
    };
}

/**
 * 凭证库门面。
 * @param {{ vaultDir: string, redactor: ReturnType<import('./redact.js').createRedactor> }} options
 */
export function createVault({ vaultDir, redactor }) {
    /** 把一条记录的敏感字段登记给脱敏器（只进内存）。 */
    function registerSecrets(entry) {
        if (!entry?.secrets) return;
        let secrets;
        try { secrets = open(vaultDir, entry.secrets); } catch { return; }
        redactor.addAll([secrets.password, secrets.privateKey, secrets.passphrase].filter(Boolean));
    }

    /** 私钥单独落盘（部分工具需要文件路径），返回路径。 */
    function materializeKey(id, privateKey) {
        const dir = keyDir(vaultDir);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.pem`);
        fs.writeFileSync(file, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch { /* Windows 忽略 */ }
        return file;
    }

    const api = {
        list() {
            const data = readRaw(vaultDir);
            return data.servers.map(view).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
        },

        /** 供工具/日志用：不含密钥的公开视图；未找到返回 undefined。 */
        peek(id) {
            const data = readRaw(vaultDir);
            const found = data.servers.find((s) => s.id === id);
            if (!found) return undefined;
            registerSecrets(found);
            return view(found);
        },

        /**
         * 取出带明文的完整记录（只给 ssh.js）。
         * `keyFile` 是私钥临时落盘路径（authType=key 时）。
         */
        secretsFor(id) {
            const data = readRaw(vaultDir);
            const found = data.servers.find((s) => s.id === id);
            if (!found) throw new Error(`没有这台服务器：${id}`);
            if (!found.secrets) throw new Error(`「${found.name ?? found.host}」没有可用凭证（先登记密码或私钥）`);
            const secrets = open(vaultDir, found.secrets);
            redactor.addAll([secrets.password, secrets.privateKey, secrets.passphrase].filter(Boolean));
            let keyFile = found.keyPath ?? null;
            if (!keyFile && secrets.privateKey) keyFile = materializeKey(found.id, secrets.privateKey);
            return {
                host: found.host,
                port: found.port ?? 22,
                user: found.user,
                authType: found.authType === 'key' ? 'key' : 'password',
                password: secrets.password ?? null,
                privateKey: secrets.privateKey ?? null,
                passphrase: secrets.passphrase ?? null,
                keyFile,
                hostKeyPolicy: found.hostKeyPolicy ?? 'accept-new',
                timeoutMs: found.timeoutMs ?? null,
            };
        },

        /**
         * 新增或更新。`input.secrets` 给了才替换密文（不传＝保持原凭证）。
         * 返回公开视图。
         */
        upsert(input) {
            const data = readRaw(vaultDir);
            const now = new Date().toISOString();
            const host = String(input.host ?? '').trim();
            if (!host) throw new Error('host 必填');
            const user = String(input.user ?? '').trim();
            if (!user) throw new Error('user 必填');
            const existing = input.id ? data.servers.find((s) => s.id === input.id) : data.servers.find((s) => s.host === host && (s.port ?? 22) === (input.port ?? 22));
            const target = existing ?? { id: input.id ?? newId(input.name || host), createdAt: now, apps: [] };

            target.name = String(input.name ?? target.name ?? host).trim() || host;
            target.host = host;
            target.port = Number(input.port ?? target.port ?? 22);
            if (!Number.isInteger(target.port) || target.port <= 0 || target.port > 65535) throw new Error(`端口非法：${input.port}`);
            target.user = user;
            target.authType = input.authType === 'key' ? 'key' : 'password';
            if (input.hostKeyPolicy) target.hostKeyPolicy = input.hostKeyPolicy;
            if (input.keyPath) target.keyPath = input.keyPath;
            if (input.os) target.os = input.os;
            if (input.notes !== undefined) target.notes = input.notes ? String(input.notes) : null;
            if (input.tags !== undefined) target.tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
            if (input.apps !== undefined) target.apps = normalizeApps(input.apps);
            if (input.secrets && (input.secrets.password || input.secrets.privateKey || input.secrets.passphrase)) {
                target.secrets = seal(vaultDir, {
                    password: input.secrets.password ?? null,
                    privateKey: input.secrets.privateKey ?? null,
                    passphrase: input.secrets.passphrase ?? null,
                });
                // 私钥落成上次留下的文件要清掉，避免旧钥匙还在盘上
                if (target.authType === 'password' && target.keyPath) {
                    try { fs.unlinkSync(target.keyPath); } catch { /* 不存在就算了 */ }
                    delete target.keyPath;
                }
                registerSecrets(target);
            }
            target.updatedAt = now;

            if (existing) data.servers = data.servers.map((s) => (s.id === existing.id ? target : s));
            else data.servers.push(target);
            writeRaw(vaultDir, data);
            return view(target);
        },

        /**
         * 用一次应用发现的结果更新清单。
         * 口径：自动发现的（systemd / docker / docker-compose）**整体替换** —— 服务装了就出现、卸了就消失；
         * 手工登记的（generic 或没有 manager 的）保留，那是用户自己填的说明。
         */
        replaceDiscoveredApps(id, apps) {
            const data = readRaw(vaultDir);
            const target = data.servers.find((s) => s.id === id);
            if (!target) throw new Error(`没有这台服务器：${id}`);
            const AUTO = new Set(['systemd', 'docker', 'docker-compose']);
            const manual = (target.apps ?? []).filter((a) => !AUTO.has(a.manager));
            target.apps = normalizeApps([...manual, ...apps]);
            target.updatedAt = new Date().toISOString();
            writeRaw(vaultDir, data);
            return view(target);
        },

        /** 追加/合并应用清单（不想覆盖时用）。 */
        mergeApps(id, apps) {
            const data = readRaw(vaultDir);
            const target = data.servers.find((s) => s.id === id);
            if (!target) throw new Error(`没有这台服务器：${id}`);
            const merged = normalizeApps([...(target.apps ?? []), ...apps]);
            target.apps = merged;
            target.updatedAt = new Date().toISOString();
            writeRaw(vaultDir, data);
            return view(target);
        },

        markReachable(id, reachable, os = undefined) {
            const data = readRaw(vaultDir);
            const target = data.servers.find((s) => s.id === id);
            if (!target) return;
            target.reachable = Boolean(reachable);
            target.reachableAt = new Date().toISOString();
            if (os) target.os = os;
            writeRaw(vaultDir, data);
        },

        markUsed(id) {
            const data = readRaw(vaultDir);
            const target = data.servers.find((s) => s.id === id);
            if (!target) return;
            target.lastUsedAt = new Date().toISOString();
            writeRaw(vaultDir, data);
        },

        remove(id) {
            const data = readRaw(vaultDir);
            const before = data.servers.length;
            data.servers = data.servers.filter((s) => s.id !== id);
            if (data.servers.length === before) return false;
            writeRaw(vaultDir, data);
            try { fs.unlinkSync(path.join(keyDir(vaultDir), `${id}.pem`)); } catch { /* 没有就算了 */ }
            return true;
        },

        /** 启动时把所有密文里的敏感值登记给脱敏器。 */
        warm() {
            const data = readRaw(vaultDir);
            for (const entry of data.servers) registerSecrets(entry);
            return data.servers.length;
        },
    };
    return api;
}

/** 应用清单归一：去重（按 name+service）、补默认 kind。 */
function normalizeApps(list) {
    const out = [];
    const seen = new Set();
    for (const raw of list ?? []) {
        if (!raw) continue;
        const name = String(raw.name ?? '').trim();
        if (!name) continue;
        const app = {
            name,
            kind: raw.kind ? String(raw.kind) : 'generic',
            port: raw.port === undefined || raw.port === null || raw.port === '' ? null : Number(raw.port),
            manager: raw.manager ? String(raw.manager) : null,
            service: raw.service ? String(raw.service) : null,
            notes: raw.notes ? String(raw.notes) : null,
        };
        const key = `${app.name}::${app.service ?? ''}::${app.port ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(app);
    }
    return out;
}
