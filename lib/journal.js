// lib/journal.js —— 操作日志（控制台的唯一数据源）。
//
// 设计取舍：
//   · **内存环形缓冲 + NDJSON 追加落盘**。控制台要「实时」，所以订阅走内存事件；
//   · 落盘是为了刷新页面/重开窗口还能看见历史，且便于事后追责；
//   · 每条记录在**写盘前**就已脱敏（redactor.text），磁盘上不存在明文凭证；
//   · 只保留最近 MAX_ENTRIES 条，超出滚动丢弃（日志不是审计归档）。
//
// ── 为什么有「会话」（2026-11-20 用户反馈后重做）──────────────────────────────
// 旧版每次工具调用都打一遍「▶ 标题 / 连接 root@… / 已连接 / ■ 退出码 0」，
// 连续对同一台机器敲五条命令，屏幕上就是五段重复的蓝字和五条退出码 ——
// 用户原话：「终端会反复输出相同的链接服务器」「不要连续输出退出码，最后一次输出就行了」。
//
// 所以把「连续对同一台机器的操作」当成**一个 SSH 会话**：
//   · 会话头（蓝）：只在**切换机器**或**空闲超时**后打一次；
//   · 输入行（绿）：每条命令一行，带远端提示符（由 service 给出）；
//   · 会话尾（灰）：退出码 / 命令数 / 总耗时，**只在会话结束时打一次**。
// 单个命令失败（stream-fail）仍然逐条即时打红字 —— 失败不能被合并掉。

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 4000;
const MAX_BYTES = 24 * 1024 * 1024;

/**
 * 多久没有新命令就认为「这一轮连续操作」结束了。
 *
 * 取值理由：一次运维动作（看状态 → 改配置 → 重启 → 再确认）通常在这个窗口内完成；
 * 隔了更久再敲命令，用户自己也需要重新看到「我现在连的是哪台」。
 */
const SESSION_IDLE_MS = 180_000;

export function createJournal({ dir, redactor, streamIdFactory, sessionIdleMs = SESSION_IDLE_MS }) {
    const file = path.join(dir, 'ops-console.ndjson');
    const entries = [];
    let seq = 0;
    const listeners = new Set();
    /** 正在进行的流：streamId → { serverId, serverName, startedAt } */
    const activeStreams = new Map();
    /** 当前会话：连续对同一台机器的操作归到这里。 */
    let session = null;

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
        // 输入行的提示符单独存一份：面板要把它和命令分开着色（真终端的 prompt / 命令两段）。
        if (fields.prompt) entry.prompt = redactor.text(String(fields.prompt));
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

    function stopTimer() {
        if (session?.timer) {
            clearTimeout(session.timer);
            session.timer = null;
        }
    }

    /**
     * 会话结束时的那一行，**一台机器一次**。
     *
     * 用户要求「不要连续输出退出码…或者干脆不显示也行，更精简」。所以：
     *   · 全部成功（退出码 0、无失败）→ **不打退出码**，只报「N 条命令 · x.xs」；
     *   · 有失败或最后一条非 0 → 才把退出码摆出来，这是要人注意的信息。
     * 一条都没跑成（streams=0）就不打 —— 空会话不值得占一行。
     */
    function endSession() {
        if (!session) return;
        stopTimer();
        const s = session;
        session = null;
        if (s.streams === 0) return;
        const failed = s.fails > 0 || (s.lastCode ?? 0) !== 0;
        const bits = [];
        // 退出码只在两种情况下有意义：非 0（要人看），或会话里有过失败。
        // 全成功时不摆「退出码 0」—— 那是噪音，用户明确要求精简掉。
        if ((s.lastCode ?? 0) !== 0) bits.push(`退出码 ${s.lastCode}`);
        else if (s.fails > 0) bits.push('退出码 0');
        if (s.streams > 1) bits.push(`${s.streams} 条命令`);
        if (s.fails > 0) bits.push(s.fails === 1 ? '含 1 次失败' : `含 ${s.fails} 次失败`);
        bits.push(`${((Date.now() - s.startedAt) / 1000).toFixed(1)}s`);
        push({
            kind: 'stream-close',
            level: failed ? 'warn' : 'meta',
            serverId: s.serverId, serverName: s.serverName, streamId: s.lastStreamId,
            // 机器名始终保留：收尾行经常紧跟着下一台的会话头，不写名字就分不清是谁的尾巴。
            text: `■ ${s.serverName} · ${bits.join(' · ')}`,
        });
    }

    /** 空闲计时只在**没有命令在跑**的时候走：长命令不该被自己超时切断。 */
    function armTimer() {
        stopTimer();
        if (!session) return;
        session.timer = setTimeout(() => endSession(), sessionIdleMs);
        session.timer.unref?.();
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
        /** 一条说明性提示（灰字，非连接、非输入）。 */
        hint(fields) { return push({ ...fields, kind: fields?.kind ?? 'note', level: fields?.level ?? 'meta' }); },

        /**
         * 开一条「流」：一次工具调用/一次连接的所有输入输出都挂在同一个 streamId 下。
         *
         * 返回 `{ streamId, opened }`：`opened=true` 表示这一条命令开创了一个**新会话**
         * （会话头已经打出去了）。调用方据此决定要不要再打连接信息 —— 同一台上连续操作时
         * 不该重复。
         */
        openStream({ serverId, serverName, where, title }) {
            const streamId = streamIdFactory();
            const continuing = Boolean(session) && session.serverId === serverId;
            if (!continuing) {
                endSession();
                session = {
                    serverId, serverName,
                    startedAt: Date.now(),
                    streams: 0, fails: 0,
                    lastCode: null, lastStreamId: null, timer: null,
                };
                // 会话头：一眼能认出「现在连的是哪台、连到哪个地址」
                push({
                    kind: 'stream-open', level: 'meta', serverId, serverName, streamId,
                    text: `● ${serverName}${where ? ` · ${where}` : ''}${title ? ` · ${title}` : ''}`,
                });
            }
            session.streams += 1;
            session.lastStreamId = streamId;
            stopTimer();
            activeStreams.set(streamId, { serverId, serverName, title, startedAt: Date.now() });
            return { streamId, opened: !continuing };
        },

        /**
         * 输入行：真终端里的「提示符 + 命令」。
         * 这一行**在连接成功后才打**，所以能带上远端真实主机名与工作目录。
         */
        input(streamId, { prompt, command }) {
            const ctx = activeStreams.get(streamId);
            const text = String(command ?? '');
            if (!text) return;
            push({
                kind: 'input', level: 'meta',
                serverId: ctx?.serverId, serverName: ctx?.serverName, streamId,
                prompt: prompt ? String(prompt) : null,
                text,
            });
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
        /**
         * 收一条流。**不打退出码行**：退出码归会话，会话结束（切机 / 空闲 3 分钟）时统一打一次。
         * 失败仍然当场打红字 —— 失败不能被合并进下一台机器的会话里。
         */
        closeStream(streamId, { code = 0, durationMs = 0, failure = null } = {}) {
            const ctx = activeStreams.get(streamId);
            activeStreams.delete(streamId);
            const sameSession = Boolean(session) && session.serverId === (ctx?.serverId ?? session.serverId);
            if (failure) {
                if (sameSession) session.fails += 1;
                push({ kind: 'stream-fail', level: 'error', serverId: ctx?.serverId, serverName: ctx?.serverName, streamId, text: `■ 失败（${failure.kind}）：${failure.message}` });
            }
            if (sameSession) {
                // 记真实退出码：失败时把 127 / 124 这类有信息量的值留下。
                // （连不上时 code 是 0，那就只报失败次数，不报一个「退出码 0」误导人。）
                session.lastCode = code;
                session.lastStreamId = streamId;
                armTimer();
            } else if (!failure) {
                // 会话已被空闲计时关掉（超长命令）或压根没建起来：单独补一条，别把退出码吞掉。
                push({ kind: 'stream-close', level: code === 0 ? 'meta' : 'warn', serverId: ctx?.serverId, serverName: ctx?.serverName, streamId, text: `■ 结束：退出码 ${code} · ${(durationMs / 1000).toFixed(1)}s` });
            }
        },
        /** 面板清空视图（只清内存，不动落盘历史）。会话也一并收尾，下条命令重新打会话头。 */
        clearView() {
            endSession();
            entries.length = 0;
            return true;
        },
        /** 进程退出/测试收尾：把当前会话的尾巴补上。 */
        flushSessions() {
            endSession();
            return true;
        },
        streamCount() { return activeStreams.size; },
    };
    return api;
}
