// lib/crypto.js —— 凭证的静态加密（AES-256-GCM）。
//
// 边界说明（别夸大）：主密钥和密文在同一个目录里，抵挡的是「翻到密文也读不出明文」
// 和「误把密文贴给别人」，不是抵挡能读你用户目录的本机攻击者。真正的隔离靠操作系统账户。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'master.key';
const ALGO = 'aes-256-gcm';

/** 取（或首次生成）主密钥。文件不存在时创建 32 字节随机密钥。 */
function masterKey(vaultDir) {
    const file = path.join(vaultDir, KEY_FILE);
    if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8').trim();
        const key = Buffer.from(raw, 'base64');
        if (key.length !== 32) throw new Error(`主密钥长度异常（${key.length} 字节），请检查 ${file}`);
        return key;
    }
    fs.mkdirSync(vaultDir, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 上 chmod 只影响只读位，忽略 */ }
    return key;
}

/** 加密一个 JSON 值 → { v: 1, iv, tag, data }（全部 base64）。 */
export function seal(vaultDir, plain) {
    const key = masterKey(vaultDir);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
    return {
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
    };
}

/** 解密 seal() 的产物；密文被改动会抛错（GCM 认证失败）。 */
export function open(vaultDir, sealed) {
    if (!sealed || sealed.v !== 1) throw new Error('密文格式不支持');
    const key = masterKey(vaultDir);
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

/** 生成对外可见的稳定标识。 */
export function newId(seed) {
    const base = String(seed ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    const rand = crypto.randomBytes(3).toString('hex');
    return `${base || 'srv'}-${rand}`;
}
