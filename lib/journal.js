// lib/journal.js —— 操作日志（控制台的唯一数据源）。
//
// 设计取舍：
//   · **内存环形缓冲 + NDJSON 追加落盘**。控制台要「实时」，所以订阅走内存事件；
//   · 落盘是为了刷新页面/重开窗口还能看见历史，且便于事后追责；
//   · 每条记录在**写盘前**就已脱敏（redactor.text），磁盘上不存在明文凭证；
//   · 只保留最近 MAX_ENTRIES 条，超出滚动丢弃（日志不是审计归档）。

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 4000;
const MAX_BYTES = 24 * 1024 * 1024;

export function createJournal({ dir, redactor, streamIdFactory }) {
    const file = path.join(dir, 'ops-console.ndjson');
    const entries = [];
    let seq = 0;
    const listeners = new Set();
    /** 正在进行的流：streamId → { serverId, serverName, startedAt } */
    const activeStreams = new Map();

    fs.mkdirSync(dir, { recursive: true });

    /** 启动时回放最近一段历史（脱敏后），让面板有上下文。 */
    function warm() {
        if (!fs.existsSync(file)) return 0;
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
        const lines = text.split('\n').filter(Boolean).slice(-MAX_ENTRIES);
        for (const line of lines) {
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (!entry || typeof entry !== 'object') continue;
            entries.push(entry);
            if (typeof entry.seq === 'number' && entry.seq > seq) seq = entry.seq;
        }
        return entries.length;
    }

    function push(fields) {
        const entry = {
            seq: ++seq,
            at: new Date().toISOString(),
            kind: fields.kind ?? 'op',
            level: fields.level ?? 'info',
            serverId: fields.serverId ?? null,
            serverName: fields.serverName ?? null,
            streamId: fields.streamId ?? null,
            text: redactor.text(String(fields.text ?? '')),
        };
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
        try {
            const line = JSON.stringify(entry) + '\n';
            fs.appendFileSync(file, line, 'utf8');
            const stat = fs.statSync(file);
            if (stat.size > MAX_BYTES) rotate();
        } catch { /* 磁盘满/占用不该打断运维操作 */ }
        for (const listener of listeners) {
            try { listener(entry); } catch { /* 单个订阅者出错不影响别人 */ }
        }
        return entry;
    }

    function rotate() {
        try {
            const keep = entries.slice(-1000).map((e) => JSON.stringify(e)).join('\n') + '\n';
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, keep, 'utf8');
            fs.renameSync(tmp, file);
        } catch { /* 忽略 */ }
    }

    const api = {
        warm,
        /** 订阅新条目（Host 内部用）。 */
        onEntry(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        /** 面板初始快照。 */
        snapshot({ limit = 400, sinceSeq = 0 } = {}) {
            const filtered = sinceSeq > 0 ? entries.filter((e) => e.seq > sinceSeq) : entries;
            return filtered.slice(-limit);
        },
        /** 一条普通日志（不含流式输出）。 */
        note(fields) { return push(fields); },
        /** 开一条「流」：一次工具调用/一次连接的所有输入输出都挂在同一个 streamId 下。 */
        openStream({ serverId, serverName, title, input }) {
            const streamId = streamIdFactory();
            activeStreams.set(streamId, { serverId, serverName, title, startedAt: Date.now() });
            push({ kind: 'stream-open', level: 'meta', serverId, serverName, streamId, text: `▶ ${title}` });
            if (input !== undefined && input !== null && String(input) !== '') {
                push({ kind: 'input', level: 'meta', serverId, serverName, streamId, text: `$ ${input}` });
            }
            return streamId;
        },
        /** 流内的输出：out / err 分开标记，方便面板着色。 */
        output(streamId, channel, text) {
            if (!text) return;
            const ctx = activeStreams.get(streamId);
            // PTY 下换行是 CRLF：先去掉 \r，否则面板每行末尾会多一个回车方块。
            // 这里**保留 ANSI 色码**——控制台要显色；给模型的文本在 service.exec 里另行 stripAnsi。
            const cleaned = String(text).replace(/\r\n?/g, '\n');
            const lines = cleaned.split('\n');
            for (const line of lines) {
                if (line === '') continue;
                push({ kind: channel === 'err' ? 'stderr' : 'stdout', level: channel === 'err' ? 'warn' : 'info', serverId: ctx?.serverId, serverName: ctx?.serverName, streamId, text: line });
            }
        },
        /** 流内的一条元信息（例如「连接已建立」）。 */
        meta(streamId, text) {
            const ctx = activeStreams.get(streamId);
            push({ kind: 'meta', level: 'meta', serverId: ctx?.serverId, serverName: ctx?.serverName, streamId, text });
        },
        closeStream(streamId, { code = 0, durationMs = 0, failure = null } = {}) {
            const ctx = activeStreams.get(streamId);
            activeStreams.delete(streamId);
            if (failure) {
                push({ kind: 'stream-fail', level: 'error', serverId: ctx?.serverId, serverName: ctx?.serverName, streamId, text: `■ 失败（${failure.kind}）：${failure.message}` });
            } else {
                push({ kind: 'stream-close', level: code === 0 ? 'meta' : 'warn', serverId: ctx?.serverId, serverName: ctx?.serverName, streamId, text: `■ 结束：退出码 ${code} · ${(durationMs / 1000).toFixed(1)}s` });
            }
        },
        /** 面板清空视图（只清内存，不动落盘历史）。 */
        clearView() {
            entries.length = 0;
            return true;
        },
        streamCount() { return activeStreams.size; },
    };
    return api;
}
