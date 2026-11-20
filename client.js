// client.js —— 服务器运维台面板（Web 端）。
//
// 两个去处，同一套数据：
//   ① **右侧栏 tab**（主要入口）：贴在对话右侧，边聊边看 —— 终端式控制台（黑底 + ANSI 真彩）
//      和服务器总览两个分段。
//   ② **主面板**（`main` 槽）：整页版，信息更宽裕，侧栏「🖧 服务器运维」点进来。
//
// 全部只读：能看不能改。所有写操作只走对话里的工具（这是结构上的保证，不是按钮变灰）。
//
// 本文件是经典脚本，由 client-modules 当 CJS factory 执行：
//   · 不写 import/export；React 用 require('react')；
//   · 样式放组件内 <style>，随卸载消失；
//   · 只引用宿主主题令牌 --dsw-alias-*；终端区域例外——终端就该是黑的。

window.__ModuleLoader__.load({
    id: 'dsh-ssh-ops',
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        const { useState, useEffect, useMemo, useRef, useCallback } = React;

        const API = '/api/ssh-ops';
        const FENCE = 'x-ssh-ops';
        const PANEL_ID = 'dsh-ssh-ops';
        const TAB_ID = 'dsh-ssh-ops';
        const TAB_KIND = 'ssh-ops';
        const PLUGIN_VERSION = '0.7.0';

        // ── 文案 ─────────────────────────────────────────────────────────
        const COPY = {
            zh: {
                title: '服务器运维台',
                subtitle: '只读总览 · 实时终端',
                tabConsole: '终端',
                tabServers: '服务器',
                refresh: '刷新',
                inventoryHint: '展开一行可看这台机器上能管什么。名字和标签可直接改；档案点 ↗ 新标签页看；动服务器本身在对话里说。',
                noServers: '还没有登记服务器。在对话里让我加一台即可。',
                consoleHint: '蓝＝连上了哪台；绿＝这次要跑的命令（带 用户名@主机:~# 提示符，普通用户是 $）；其余是远端输出。同一台机器连续操作只报一次连接。凭证显示为 ******。',
                consoleEmpty: '还没有任何操作。',
                filter: '过滤…',
                clear: '清空视图',
                apps: '个应用',
                lastUsed: '最近使用',
                never: '从未',
                authKey: '密钥',
                authPassword: '密码',
                unknown: '未探测',
                loading: '加载中…',
                failed: '加载失败',
                noUserApps: '（这台机器上没发现额外的用户应用）',
                systemApps: '系统自带服务',
                follow: '跟随',
                following: '跟随中',
                wrap: '折行',
                profile: '档案',
                openProfile: '查看档案',
                close: '关闭',
                profileCopy: '复制地址',
                profileCopyHint: '复制档案页地址（可粘到浏览器打开）',
                profileRole: '角色',
                profileTraits: '专属特征',
                profilePortMap: '对外端口 → 内部',
                profileConstraints: '硬约束 / 不要碰',
                profileRunbooks: '常用处置',
                profileTimeline: '时间线',
                profileQuestions: '待确认',
                profileImpact: '影响',
                profileEvidence: '依据',
                profileNone: '（无）',
                profileMissing: '这台服务器还没有档案。在对话里让 DSH 记录它的独有特征即可。',
                traits: '专属特征',
                portMap: '对外端口 → 内部',
                constraints: '硬约束',
                runbooks: '常用处置',
                timeline: '时间线',
                openQuestions: '待确认',
                profileUpdated: '档案更新',
                fromOwner: '用户',
                fromProbe: '实测',
                fromAgent: '推断',
                timelineKind: { change: '改', incident: '故', note: '记', decision: '定' },
                edit: '编辑',
                rename: '名字',
                tags: '标签',
                save: '保存',
                cancel: '取消',
                saving: '保存中…',
                saved: '已保存',
                namePlaceholder: '给这台机器起个名字',
                tagsPlaceholder: '逗号分隔，例如：生产, 国内, 音乐',
                editHint: '只能改名字和标签——它们只影响本机显示，不碰服务器。',
                editNameEmpty: '名字留空会退回用地址显示。',
            },
            en: {
                title: 'Server ops console',
                subtitle: 'Read-only inventory · live terminal',
                tabConsole: 'Terminal',
                tabServers: 'Servers',
                refresh: 'Refresh',
                inventoryHint: 'Expand a row to see what this agent can manage. Name and tags are editable here; ↗ opens the profile in a new tab; ask in chat to change anything on the server.',
                noServers: 'No servers registered yet. Ask the agent in chat to add one.',
                consoleHint: 'Blue = which host is connected; green = the command being run (with a user@host:~# prompt, $ for non-root); everything else is remote output. Reconnecting to the same host is reported once. Credentials appear as ******.',
                consoleEmpty: 'No operations yet.',
                filter: 'Filter…',
                clear: 'Clear view',
                apps: 'apps',
                lastUsed: 'Last used',
                never: 'never',
                authKey: 'Key',
                authPassword: 'Password',
                unknown: 'not probed',
                loading: 'Loading…',
                failed: 'Failed',
                noUserApps: '(no extra user applications found on this host)',
                systemApps: 'System services',
                follow: 'Follow',
                following: 'Following',
                wrap: 'Wrap',
                profile: 'Profile',
                openProfile: 'View profile',
                close: 'Close',
                profileCopy: 'Copy URL',
                profileCopyHint: 'Copy the profile page URL (paste into a browser)',
                profileRole: 'Role',
                profileTraits: 'Traits',
                profilePortMap: 'Public → internal port',
                profileConstraints: 'Hard constraints',
                profileRunbooks: 'Runbooks',
                profileTimeline: 'Timeline',
                profileQuestions: 'Open questions',
                profileImpact: 'Impact',
                profileEvidence: 'Evidence',
                profileNone: '(none)',
                profileMissing: 'No profile for this server yet. Ask the agent to record its traits.',
                traits: 'Traits',
                portMap: 'Public → internal',
                constraints: 'Constraints',
                runbooks: 'Runbooks',
                timeline: 'Timeline',
                openQuestions: 'Open questions',
                profileUpdated: 'Profile updated',
                fromOwner: 'owner',
                fromProbe: 'probed',
                fromAgent: 'inferred',
                timelineKind: { change: 'chg', incident: 'inc', note: 'note', decision: 'dec' },
                edit: 'Edit',
                rename: 'Name',
                tags: 'Tags',
                save: 'Save',
                cancel: 'Cancel',
                saving: 'Saving…',
                saved: 'Saved',
                namePlaceholder: 'Give this host a name',
                tagsPlaceholder: 'Comma separated, e.g. prod, eu, music',
                editHint: 'Name and tags only — they affect local display, never the server.',
                editNameEmpty: 'Empty name falls back to the address.',
            },
        };

        function pickLocale() {
            try {
                const lang = (document.documentElement.lang || navigator.language || 'zh').toLowerCase();
                return lang.startsWith('en') ? 'en' : 'zh';
            } catch { return 'zh'; }
        }

        // ── ANSI 解析（与 Host 的 lib/ansi.js 同一口径；浏览器端单独一份，避免跨包引用） ──
        const BASIC = [
            '#3b4048', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#dcdfe4',
            '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#7cc0ff', '#e29aef', '#6fd3df', '#ffffff',
        ];
        const DEFAULT_STYLE = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };

        function color256(n) {
            if (n < 16) return BASIC[n];
            if (n < 232) {
                const i = n - 16;
                const to = (v) => (v === 0 ? 0 : 55 + v * 40);
                return `rgb(${to(Math.floor(i / 36))},${to(Math.floor((i % 36) / 6))},${to(i % 6)})`;
            }
            const g = 8 + (n - 232) * 10;
            return `rgb(${g},${g},${g})`;
        }

        function applySgr(prev, params) {
            const style = { ...prev };
            const codes = (params === '' ? '0' : params).split(';').map((x) => (x === '' ? 0 : Number(x))).filter(Number.isInteger);
            for (let k = 0; k < codes.length; k += 1) {
                const c = codes[k];
                if (c === 0) { Object.assign(style, DEFAULT_STYLE); continue; }
                if (c === 1) { style.bold = true; continue; }
                if (c === 2) { style.dim = true; continue; }
                if (c === 3) { style.italic = true; continue; }
                if (c === 4) { style.underline = true; continue; }
                if (c === 7) { style.inverse = true; continue; }
                if (c === 21 || c === 22) { style.bold = false; style.dim = false; continue; }
                if (c === 23) { style.italic = false; continue; }
                if (c === 24) { style.underline = false; continue; }
                if (c === 27) { style.inverse = false; continue; }
                if (c >= 30 && c <= 37) { style.fg = BASIC[c - 30]; continue; }
                if (c === 39) { style.fg = null; continue; }
                if (c >= 40 && c <= 47) { style.bg = BASIC[c - 40]; continue; }
                if (c === 49) { style.bg = null; continue; }
                if (c >= 90 && c <= 97) { style.fg = BASIC[c - 90 + 8]; continue; }
                if (c >= 100 && c <= 107) { style.bg = BASIC[c - 100 + 8]; continue; }
                if (c === 38 || c === 48) {
                    const target = c === 38 ? 'fg' : 'bg';
                    const mode = codes[k + 1];
                    if (mode === 5) { style[target] = color256(codes[k + 2] ?? 7); k += 2; continue; }
                    if (mode === 2) {
                        style[target] = `rgb(${codes[k + 2] ?? 0},${codes[k + 3] ?? 0},${codes[k + 4] ?? 0})`;
                        k += 4;
                        continue;
                    }
                    k += 1;
                }
            }
            return style;
        }

        /** 一行 → spans（跨行继承样式靠 initial）。 */
        function parseAnsi(line, initial) {
            const text = String(line ?? '');
            if (text.indexOf('\x1b') === -1 && !initial) return [{ text, ...DEFAULT_STYLE }];
            const spans = [];
            let style = { ...(initial || DEFAULT_STYLE) };
            let buffer = '';
            const flush = () => { if (buffer) { spans.push({ text: buffer, ...style }); buffer = ''; } };
            let i = 0;
            while (i < text.length) {
                const ch = text[i];
                if (ch === '\x1b') {
                    if (text[i + 1] === ']') {
                        const bel = text.indexOf('\x07', i + 2);
                        const st = text.indexOf('\x1b\\', i + 2);
                        i = bel >= 0 ? bel + 1 : (st >= 0 ? st + 2 : text.length);
                        continue;
                    }
                    if (text[i + 1] === '[') {
                        const m = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(text.slice(i));
                        if (m) {
                            if (m[3] === 'm') { flush(); style = applySgr(style, m[1]); }
                            i += m[0].length;
                            continue;
                        }
                        i += 2;
                        continue;
                    }
                    i += 2;
                    continue;
                }
                if (ch === '\r' || ch === '\x07' || ch === '\x00') { i += 1; continue; }
                buffer += ch;
                i += 1;
            }
            flush();
            return spans.length ? spans : [{ text: '', ...style }];
        }

        /** spans → React 元素：真彩 + 粗体/斜体/下划线/反显。 */
        function renderSpans(spans, keyPrefix) {
            return spans.map((s, idx) => {
                if (s.text === '') return null;
                const fg = s.inverse ? (s.bg || '#101418') : s.fg;
                const bg = s.inverse ? (s.fg || '#dcdfe4') : s.bg;
                const style = {};
                if (fg) style.color = fg;
                if (bg) style.background = bg;
                if (s.bold) style.fontWeight = 700;
                if (s.dim) style.opacity = 0.62;
                if (s.italic) style.fontStyle = 'italic';
                if (s.underline) style.textDecoration = 'underline';
                return h('span', { key: `${keyPrefix}-${idx}`, style }, s.text);
            });
        }

        // ── 网络层 ────────────────────────────────────────────────────────
        async function api(path, { timeoutMs = 15000, method = 'GET', body = undefined } = {}) {
            const ac = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
            let response;
            const headers = { [FENCE]: '1' };
            const init = { method, signal: ac?.signal, headers };
            if (body !== undefined) {
                headers['content-type'] = 'application/json';
                init.body = JSON.stringify(body);
            }
            try {
                response = await fetch(`${API}${path}`, init);
            } catch (error) {
                const aborted = error?.name === 'AbortError';
                throw new Error(aborted ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : `网络错误：${String(error?.message ?? error)}`);
            } finally {
                if (timer) clearTimeout(timer);
            }
            let payload;
            try { payload = await response.json(); } catch { throw new Error(`响应不是 JSON（HTTP ${response.status}）`); }
            if (!payload.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
            return payload.value;
        }

        // ── 样式 ─────────────────────────────────────────────────────────
        const CSS = `
.so-root {
  --so-bg: var(--dsw-alias-bg-base);
  --so-surface: var(--dsw-alias-bg-layer-1);
  --so-surface2: var(--dsw-alias-bg-layer-2);
  --so-line: var(--dsw-alias-border-l1);
  --so-line2: var(--dsw-alias-border-l2);
  --so-text: var(--dsw-alias-label-primary);
  --so-dim: var(--dsw-alias-label-secondary);
  --so-accent: var(--dsw-alias-brand-primary);
  --so-ok: var(--dsw-alias-state-success-primary);
  --so-warn: var(--dsw-alias-state-warn-primary);
  --so-bad: var(--dsw-alias-state-error-primary);
  --so-idle: var(--dsw-alias-state-idle-primary);
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--so-text); font-size: 13px; background: var(--so-bg);
}
.so-root--right { font-size: 12px; }
.so-head { display: flex; align-items: center; gap: 9px; padding: 10px 12px 8px; border-bottom: 1px solid var(--so-line); flex: none; }
.so-head-mark { width: 20px; height: 20px; flex: none; }
.so-head-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.so-head-title { font-weight: 600; font-size: 13.5px; white-space: nowrap; }
.so-head-sub { font-size: 10.5px; color: var(--so-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.so-head-spacer { flex: 1 1 auto; }
.so-btn {
  border: 1px solid var(--so-line2); background: var(--so-surface); color: var(--so-text);
  border-radius: 6px; padding: 3px 8px; font-size: 11.5px; cursor: pointer; white-space: nowrap;
}
.so-btn:hover { background: var(--so-surface2); }
.so-btn:disabled { opacity: .5; cursor: default; }
.so-btn[data-on="true"] { border-color: var(--so-accent); color: var(--so-accent); }
.so-tabs { display: flex; gap: 2px; padding: 7px 12px 0; flex: none; }
.so-tab {
  border: 1px solid transparent; border-bottom: none; background: transparent; color: var(--so-dim);
  border-radius: 7px 7px 0 0; padding: 4px 11px; font-size: 11.5px; cursor: pointer;
}
.so-tab[aria-selected="true"] { color: var(--so-text); background: var(--so-surface); border-color: var(--so-line); }
.so-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px 12px 22px; display: flex; flex-direction: column; }
.so-hint { font-size: 11px; color: var(--so-dim); line-height: 1.55; margin-bottom: 8px; flex: none; }
.so-error { border: 1px solid var(--so-bad); color: var(--so-bad); border-radius: 7px; padding: 7px 10px; font-size: 11.5px; margin-bottom: 8px; flex: none; }
.so-empty { color: #5c6370; font-size: 11.5px; text-align: center; padding: 34px 12px; line-height: 1.8; }
.so-loading { color: var(--so-dim); font-size: 11.5px; padding: 14px 2px; }

/* 服务器行 */
.so-srv { border: 1px solid var(--so-line); border-radius: 9px; background: var(--so-surface); margin-bottom: 7px; overflow: hidden; }
.so-srv-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; user-select: none; }
.so-srv-head:hover { background: var(--so-surface2); }
.so-caret { width: 11px; flex: none; color: var(--so-dim); font-size: 9px; transition: transform .12s ease; }
.so-caret--open { transform: rotate(90deg); }
.so-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--so-idle); }
.so-dot--up { background: var(--so-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--so-ok) 18%, transparent); }
.so-dot--down { background: var(--so-bad); }
.so-srv-main { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; }
.so-srv-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.so-srv-addr { font-size: 10.5px; color: var(--so-dim); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.so-badge {
  font-size: 10px; border: 1px solid var(--so-line); border-radius: 999px;
  padding: 0 6px; color: var(--so-dim); white-space: nowrap; flex: none;
}
.so-badge--accent { border-color: var(--so-accent); color: var(--so-accent); }
/* 档案按钮：一行小入口，不是一坨内容。视觉上要轻，别抢服务器的注意力。 */
.so-btn--ghost { border-style: dashed; color: var(--so-dim); }
.so-btn--ghost:hover { color: var(--so-accent); border-color: var(--so-accent); border-style: solid; }
.so-srv-body { border-top: 1px solid var(--so-line); padding: 8px 10px 10px; background: var(--so-bg); }


/* 名字 / 标签（可编辑） */
.so-idbar { display: flex; align-items: center; gap: 6px; padding: 5px 7px; margin-bottom: 7px;
  border: 1px dashed var(--so-line2); border-radius: 6px; background: var(--so-surface); }
.so-idbar-name { font-size: 11px; color: var(--so-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.so-idbar-spacer { flex: 1 1 auto; }
.so-btn--mini { padding: 1px 6px; font-size: 10.5px; }
.so-btn--primary { border-color: var(--so-accent); color: var(--so-accent); }
.so-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.so-tag { font-size: 10px; border: 1px solid var(--so-line2); border-radius: 999px; padding: 0 6px;
  color: var(--so-dim); white-space: nowrap; }
.so-edit { border: 1px solid var(--so-accent); border-radius: 7px; background: var(--so-surface);
  padding: 8px 9px; margin-bottom: 8px; }
.so-edit-hint { font-size: 10px; color: var(--so-dim); line-height: 1.5; margin-bottom: 6px; }
.so-edit-row { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.so-edit-label { font-size: 10.5px; color: var(--so-dim); flex: none; width: 34px; }
/* 编辑器底色是 surface，输入框必须比它更亮/更暗一档并把边框画出来，
   否则看起来像一段静态文本，用户不会意识到那里能点。 */
.so-edit-input {
  flex: 1 1 auto; background: var(--so-bg); border: 1px solid var(--so-line2);
  padding: 3px 7px; border-radius: 5px;
}
.so-edit-input:hover:not(:disabled) { border-color: var(--so-accent); }
.so-edit-input:focus {
  outline: none; border-color: var(--so-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--so-accent) 20%, transparent);
}
.so-edit-input:disabled { opacity: .6; }
.so-edit-foot { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.so-edit-note { font-size: 9.5px; color: var(--so-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.so-edit-spacer { flex: 1 1 auto; }
.so-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 11px; margin: 0 0 8px; }
.so-kv dt { color: var(--so-dim); }
.so-kv dd { margin: 0; word-break: break-all; }
.so-notes { color: var(--so-dim); font-size: 10.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.so-apps { display: flex; flex-direction: column; gap: 3px; }
.so-app { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 3px 6px; border-radius: 5px; background: var(--so-surface); border: 1px solid var(--so-line); }
.so-app-name { font-weight: 600; white-space: nowrap; }
.so-app-meta { color: var(--so-dim); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.so-app-spacer { flex: 1 1 auto; }
.so-fold {
  border: 1px dashed var(--so-line2); background: transparent; color: var(--so-dim);
  border-radius: 5px; padding: 2px 7px; font-size: 10.5px; cursor: pointer; margin: 5px 0 3px; width: 100%; text-align: left;
}
.so-fold:hover { color: var(--so-text); border-color: var(--so-accent); }
.so-none { font-size: 11px; color: var(--so-dim); }

/* 终端 */
.so-console { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.so-console-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex: none; flex-wrap: wrap; }
.so-input {
  background: var(--so-surface); color: var(--so-text); border: 1px solid var(--so-line);
  border-radius: 6px; padding: 3px 7px; font-size: 11.5px; min-width: 0; flex: 1 1 110px;
}
.so-input::placeholder { color: var(--so-dim); }
.so-chip { font-size: 10px; border: 1px solid var(--so-line); border-radius: 999px; padding: 0 6px; color: var(--so-dim); }
.so-chip--live { border-color: var(--so-ok); color: var(--so-ok); }

/* 黑底终端：这是唯一不跟随主题的区域 —— 终端就该是黑的 */
.so-term {
  background: #0d1117; border: 1px solid #21262d; border-radius: 8px;
  padding: 7px 0; font-family: "Cascadia Mono", ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
  font-size: 11.5px; line-height: 1.55; overflow: auto; flex: 1 1 auto; min-height: 180px;
  color: #dcdfe4; tab-size: 4;
}
.so-term--wrap .so-line-text { white-space: pre-wrap; word-break: break-word; }
.so-term:not(.so-term--wrap) .so-line-text { white-space: pre; }
.so-line { display: flex; gap: 7px; padding: 0 9px; }
.so-line:hover { background: #161b22; }
.so-line-gutter { flex: none; user-select: none; display: flex; gap: 5px; opacity: .75; }
.so-line-time { color: #484f58; font-size: 10px; line-height: 1.55; }
.so-line-srv { color: #6e7681; font-size: 10px; line-height: 1.55; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 右侧栏窄：机器名挤成「云服务...」反而没信息量，收起来，靠 hover 看全名 */
.so-line-srv--tight { max-width: 34px; }
.so-root--right .so-line-gutter { gap: 4px; }
.so-root--right .so-line-time { font-size: 9.5px; }
.so-line-text { flex: 1 1 auto; min-width: 0; }
.so-line--meta .so-line-text { color: #58a6ff; }
/* 输入行：照真终端 —— 提示符是「环境信息」用暗青，命令是本轮要执行的东西用亮绿加粗。
   两者分开着色，用户扫一眼就知道哪半句是自己（或模型）要跑的命令。 */
.so-line--input .so-line-text { color: #7ee787; font-weight: 700; }
.so-line--input .so-line-prompt { color: #56d4dd; font-weight: 400; margin-right: 6px; user-select: none; }
.so-line--input .so-cmd { color: #7ee787; font-weight: 700; }
.so-line--note .so-line-text { color: #6e7681; font-style: italic; }
.so-line--stderr .so-line-text { color: #ffa657; }
.so-line--stream-fail .so-line-text, .so-line--error .so-line-text { color: #ff7b72; }
.so-line--stream-close .so-line-text { color: #6e7681; }
/* 会话头：一次连续操作只出现一次，用稍亮的蓝 + 分隔感，避免与普通提示混在一起 */
.so-line--stream-open { margin-top: 6px; }
.so-line--stream-open .so-line-text { color: #58a6ff; }
.so-cursor { display: inline-block; width: 6px; height: 12px; background: #7ee787; vertical-align: -1px; animation: so-blink 1.1s steps(1) infinite; }
@keyframes so-blink { 50% { opacity: 0; } }

/* ── 档案抽屉 ──
   渲染在 shell.overlay（框架级浮层），不在面板内部：面板是带 transform 的滚动容器，
   position:fixed 在里面会被限制在容器内，遮罩盖不满整个窗口。 */
.so-pf-host {
  /* 主题变量必须在这一层重新声明：overlay 渲染在 .so-root 之外，
     继承不到 --so-* ，面板会变成「有边框没底色」甚至整块透明。 */
  --so-bg: var(--dsw-alias-bg-base);
  --so-surface: var(--dsw-alias-bg-layer-1);
  --so-surface2: var(--dsw-alias-bg-layer-2);
  --so-line: var(--dsw-alias-border-l1);
  --so-line2: var(--dsw-alias-border-l2);
  --so-text: var(--dsw-alias-label-primary);
  --so-dim: var(--dsw-alias-label-secondary);
  --so-accent: var(--dsw-alias-brand-primary);
  --so-ok: var(--dsw-alias-state-success-primary);
  --so-warn: var(--dsw-alias-state-warn-primary);
  --so-bad: var(--dsw-alias-state-error-primary);
  --so-idle: var(--dsw-alias-state-idle-primary);
  /* 遮罩与内容放在同一个节点上：shell.overlay 的容器本身可能是零尺寸，
     把背景铺在容器里不会显示（第一版就是这样：抽屉居中、背景没变暗）。
     所以背景必须由这一层自己画，并用视口单位撑满。 */
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  z-index: 200;
  /* 半透明遮罩：模态框的标准做法 —— 能看见底下界面但明显变暗。
     ⚠️ 曾经因为「截图里看不到」而改成不透明纯黑，结果整屏发黑、体验更差。
     那是 PrintWindow 不合成半透明层的限制，不是真实显示问题。
     要看真实效果必须用屏幕级截图（Graphics.CopyFromScreen），不能用 PrintWindow。 */
  background: rgba(8, 10, 14, .55);
  color: var(--so-text);
  font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  /* shell.overlay 本身是 click-through 的，条目要自己 opt-in */
  pointer-events: auto;
}
.so-pf-overlay { display: contents; }
.so-pf-panel {
  /* 面板底要明确：继承来的 --so-bg 在部分主题下是半透明层，
     叠在深色遮罩上会让整张面板看起来发灰。这里直接给不透明面。 */
  background: var(--so-surface);
  border: 1px solid var(--so-line2);
  border-radius: 11px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .34);
  width: min(760px, 100%); max-height: min(80vh, 100%);
  display: flex; flex-direction: column; min-height: 0;
  color: var(--so-text);
}
.so-pf-head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 14px; border-bottom: 1px solid var(--so-line); flex: none;
}
.so-pf-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.so-pf-title { font-size: 14px; font-weight: 600; }
.so-pf-sub { font-size: 11px; color: var(--so-dim); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.so-pf-body { padding: 12px 14px 18px; overflow: auto; min-height: 0; }
.so-pf-summary {
  border: 1px solid var(--so-line); border-radius: 8px;
  background: var(--so-surface); padding: 9px 11px; margin-bottom: 12px;
}
.so-pf-summary-text { font-size: 12px; line-height: 1.6; }
.so-pf-section { margin-bottom: 15px; }
.so-pf-h2 {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; font-weight: 600; letter-spacing: .05em;
  color: var(--so-dim); text-transform: uppercase;
  margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--so-line);
}
.so-pf-count {
  font-size: 10px; border: 1px solid var(--so-line); border-radius: 999px;
  padding: 0 5px; color: var(--so-dim); font-weight: 400; letter-spacing: 0;
}
.so-pf-list { display: flex; flex-direction: column; gap: 6px; }
.so-pf-item {
  border: 1px solid var(--so-line); border-radius: 7px;
  background: var(--so-surface); padding: 7px 9px;
}
.so-pf-item--tight { padding: 5px 9px; }
.so-pf-item-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 3px; }
.so-pf-item-title { font-size: 12px; font-weight: 600; }
.so-pf-text { font-size: 11.5px; line-height: 1.6; color: var(--so-text); }
.so-pf-meta { font-size: 10.5px; color: var(--so-dim); line-height: 1.55; margin-top: 3px; }
.so-pf-src {
  font-size: 9.5px; color: var(--so-dim);
  border: 1px solid var(--so-line); border-radius: 4px; padding: 0 4px;
}
.so-pf-sev {
  font-size: 9.5px; border-radius: 4px; padding: 0 5px;
  border: 1px solid currentColor; text-transform: uppercase; letter-spacing: .03em;
}
.so-pf-sev--info { color: var(--so-accent); }
.so-pf-sev--note { color: var(--so-dim); }
.so-pf-sev--warn { color: var(--so-warn); }
.so-pf-sev--critical { color: var(--so-bad); }
.so-pf-sev--change { color: var(--so-accent); }
.so-pf-sev--incident { color: var(--so-bad); }
.so-pf-sev--decision { color: var(--so-ok); }
.so-pf-port {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px; color: var(--so-accent);
}
.so-pf-steps { margin: 4px 0 0; padding-left: 18px; font-size: 11.5px; line-height: 1.65; }
.so-pf-steps li { margin-bottom: 2px; }
.so-pf-empty { font-size: 11px; color: var(--so-dim); padding: 3px 0; }
`;

        // ── 小组件 ───────────────────────────────────────────────────────
        function Mark() {
            return h('svg', { className: 'so-head-mark', viewBox: '0 0 64 64', 'aria-hidden': true },
                h('rect', { x: 10, y: 6, width: 44, height: 52, rx: 8, fill: 'var(--so-accent)' }),
                h('rect', { x: 16, y: 13, width: 32, height: 10, rx: 3, fill: '#eef4ff', opacity: 0.94 }),
                h('rect', { x: 16, y: 27, width: 32, height: 10, rx: 3, fill: '#eef4ff', opacity: 0.7 }),
                h('rect', { x: 16, y: 41, width: 32, height: 10, rx: 3, fill: '#eef4ff', opacity: 0.5 }),
                h('circle', { cx: 21, cy: 18, r: 2, fill: '#18c07a' }),
                h('circle', { cx: 21, cy: 32, r: 2, fill: '#18c07a' }),
                h('circle', { cx: 21, cy: 46, r: 2, fill: '#ffb020' }));
        }

        function timeText(iso) {
            if (!iso) return '';
            try {
                const d = new Date(iso);
                return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
            } catch { return ''; }
        }

        function agoText(iso, t) {
            if (!iso) return t.never;
            const ms = Date.now() - new Date(iso).getTime();
            if (!Number.isFinite(ms) || ms < 0) return t.never;
            const min = Math.floor(ms / 60000);
            if (min < 1) return '<1m';
            if (min < 60) return `${min}m`;
            const hour = Math.floor(min / 60);
            if (hour < 24) return `${hour}h`;
            return `${Math.floor(hour / 24)}d`;
        }

        // ── 服务器总览 ───────────────────────────────────────────────────
        function AppList({ apps, t }) {
            const [showSystem, setShowSystem] = useState(false);
            const user = (apps || []).filter((a) => a.kind !== 'system');
            const system = (apps || []).filter((a) => a.kind === 'system');
            const row = (a) => h('div', { className: 'so-app', key: `${a.name}:${a.service || ''}` },
                h('span', { className: 'so-app-name' }, a.name),
                h('span', { className: 'so-app-meta' }, [a.manager, a.port ? `:${a.port}` : null].filter(Boolean).join(' ')),
                h('span', { className: 'so-app-spacer' }),
                a.notes ? h('span', { className: 'so-app-meta' }, a.notes) : null);
            return h('div', { className: 'so-apps' },
                user.length ? user.map(row) : h('div', { className: 'so-none' }, t.noUserApps),
                system.length
                    ? h('div', null,
                        h('button', {
                            className: 'so-fold', type: 'button',
                            onClick: () => setShowSystem((v) => !v),
                            'aria-expanded': showSystem,
                        }, `${showSystem ? '▾' : '▸'} ${t.systemApps} · ${system.length}`),
                        showSystem ? system.map(row) : null)
                    : null);
        }

        /**
         * 名字/标签编辑器 —— 面板上**唯一**能写的地方。
         *
         * 设计要点：
         *   · 只提交 name 与 tags 两个键，后端也是这么校验的（多传会被拒）；
         *   · 保存成功后把新值回传给父组件，**不重拉整个清单**（改了名字却要等一整轮刷新，体验很差）；
         *   · 失败时保留用户输入（不能因为网络抖一下就让人白打一遍字）；
         *   · Enter 保存 / Esc 取消 —— 这两件事用户会下意识去按。
         */
        function IdentityEditor({ server, t, onSaved, onCancel }) {
            const [name, setName] = useState(server.name ?? '');
            const [tagsText, setTagsText] = useState((server.tags || []).join(', '));
            const [busy, setBusy] = useState(false);
            const [error, setError] = useState(null);

            const save = useCallback(async () => {
                setBusy(true);
                setError(null);
                // 逗号（中英文都认）分隔；后端还会再做一次归一与去重
                const tags = tagsText.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
                try {
                    const value = await api(`/servers/${encodeURIComponent(server.id)}`, {
                        method: 'PATCH',
                        body: { name: name.trim(), tags },
                    });
                    onSaved(value.server);
                } catch (e) {
                    setError(String(e?.message ?? e));
                } finally {
                    setBusy(false);
                }
            }, [name, tagsText, server.id, onSaved]);

            const onKeyDown = (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) save(); }
                else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            };

            return h('div', { className: 'so-edit' },
                h('div', { className: 'so-edit-hint' }, t.editHint),
                error ? h('div', { className: 'so-error' }, error) : null,
                h('label', { className: 'so-edit-row' },
                    h('span', { className: 'so-edit-label' }, t.rename),
                    h('input', {
                        className: 'so-edit-input', value: name, disabled: busy,
                        placeholder: t.namePlaceholder, maxLength: 64,
                        onChange: (e) => setName(e.target.value), onKeyDown,
                        'aria-label': t.rename,
                    })),
                h('label', { className: 'so-edit-row' },
                    h('span', { className: 'so-edit-label' }, t.tags),
                    h('input', {
                        className: 'so-edit-input', value: tagsText, disabled: busy,
                        placeholder: t.tagsPlaceholder,
                        onChange: (e) => setTagsText(e.target.value), onKeyDown,
                        'aria-label': t.tags,
                    })),
                h('div', { className: 'so-edit-foot' },
                    h('span', { className: 'so-edit-note' }, name.trim() ? '' : t.editNameEmpty),
                    h('span', { className: 'so-edit-spacer' }),
                    h('button', {
                        className: 'so-btn', type: 'button', disabled: busy,
                        onClick: onCancel,
                    }, t.cancel),
                    h('button', {
                        className: 'so-btn so-btn--primary', type: 'button', disabled: busy,
                        onClick: save,
                    }, busy ? t.saving : t.save)));
        }

        function ServerRow({ s, t, onRenamed, onOpenProfile }) {
            const [open, setOpen] = useState(false);
            const [editing, setEditing] = useState(false);
            const toggle = () => setOpen((v) => !v);
            const stateClass = s.reachable === true ? 'so-dot so-dot--up' : s.reachable === false ? 'so-dot so-dot--down' : 'so-dot';
            const stateTitle = s.reachable === true ? 'reachable' : s.reachable === false ? 'unreachable' : t.unknown;

            /**
             * 打开档案。**在面板内开抽屉，不用 window.open。**
             *
             * 历史：最早这里是 `window.open(url, '_blank')`，结果是**点了完全没反应** ——
             * 按钮有焦点框、窗口列表毫无变化、console 也没有报错。原因是 Electron 对未配
             * `setWindowOpenHandler` 的新窗口一律静默拒绝，而 `window.open` 被拒时**不抛异常**，
             * 所以 try/catch 也兜不住。改成面板内抽屉后不再依赖宿主的新窗口策略。
             */
            const openProfile = (e) => {
                e.stopPropagation();
                onOpenProfile?.(s);
            };

            const head = h('div', {
                className: 'so-srv-head',
                role: 'button', tabIndex: 0, 'aria-expanded': open,
                onClick: toggle,
                onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
            },
                h('span', { className: `so-caret${open ? ' so-caret--open' : ''}` }, '▶'),
                h('span', { className: stateClass, title: stateTitle }),
                h('div', { className: 'so-srv-main' },
                    h('div', { className: 'so-srv-name' }, s.name),
                    h('div', { className: 'so-srv-addr' }, `${s.user}@${s.host}:${s.port}`)),
                // 档案只是**一个入口**：一行小按钮，点开新标签页看。
                // 之前把七个分区铺在这里，视觉上是一大坨，而且用户多数时候并不需要它。
                s.profile
                    ? h('button', {
                        className: 'so-btn so-btn--mini so-btn--ghost', type: 'button',
                        title: `${t.openProfile}（${t.profile}）`,
                        onClick: openProfile,
                        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); } },
                    }, `${t.profile} ↗`)
                    : null,
                h('span', { className: 'so-badge so-badge--accent' }, `${s.appCount} ${t.apps}`));

            if (!open) return h('div', { className: 'so-srv' }, head);

            const notes = s.notes ?? '';
            const NOTES_MAX = 160;
            const kv = h('dl', { className: 'so-kv' },
                h('dt', null, 'Endpoint'), h('dd', null, `${s.user}@${s.host}:${s.port}`),
                h('dt', null, 'Auth'), h('dd', null, s.auth === 'key' ? t.authKey : t.authPassword),
                s.os ? h('dt', null, 'OS') : null, s.os ? h('dd', null, s.os) : null,
                h('dt', null, t.lastUsed), h('dd', null, agoText(s.lastUsedAt, t)),
                s.tags && s.tags.length ? h('dt', null, t.tags) : null,
                s.tags && s.tags.length
                    ? h('dd', null, h('span', { className: 'so-tags' },
                        s.tags.map((tag) => h('span', { className: 'so-tag', key: tag }, tag))))
                    : null,
                notes ? h('dt', null, 'Notes') : null,
                // 备注常是用户自己写的一长串运维史：截断到两行高度，全貌放 title
                notes ? h('dd', { className: 'so-notes', title: notes }, notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX)}…` : notes) : null);

            // 展开区只留「跟用户有关」的东西：标识（名字/标签）、连接信息、应用清单。
            // 档案不在这里 —— 它有一个独立页面。
            return h('div', { className: 'so-srv' }, head,
                h('div', { className: 'so-srv-body' },
                    editing
                        ? h(IdentityEditor, {
                            server: s, t,
                            onCancel: () => setEditing(false),
                            onSaved: (updated) => {
                                setEditing(false);
                                if (onRenamed) onRenamed(updated);
                            },
                        })
                        : h('div', { className: 'so-idbar' },
                            h('span', { className: 'so-idbar-name', title: s.name }, `✎ ${t.rename}：${s.name}`),
                            h('span', { className: 'so-idbar-spacer' }),
                            h('button', {
                                className: 'so-btn so-btn--mini', type: 'button',
                                onClick: () => setEditing(true),
                            }, t.edit)),
                    kv,
                    h(AppList, { apps: s.apps, t })));
        }

        // ── 档案抽屉的跨槽位状态 ──────────────────────────────────────────
        /**
         * 为什么需要这个 store：抽屉必须渲染在 **`shell.overlay`** 里，不能渲染在面板内部。
         *
         * 面板位于右侧栏，那是一个带 `transform` / `overflow` 的滚动容器 ——
         * `position: fixed` 在里面会被限制成「相对容器定位」，于是遮罩盖不满、弹窗偏在一边。
         * （第一版就是这么错的：截图里抽屉只占右栏那一块，左上和右边都露着底色。）
         *
         * 而打开抽屉的按钮在面板里、抽屉本体要在 overlay 里，两者是不同的槽位，
         * 没法直接用 React 的父子 props 传递。所以用一个极小的发布订阅把「当前要看哪台」
         * 从面板传给 overlay 条目。
         */
        const profileStore = (() => {
            let current = null;              // 当前要展示的 server，null = 关闭
            const listeners = new Set();
            const emit = () => { for (const fn of listeners) { try { fn(current); } catch { /* ignore */ } } };
            return {
                get: () => current,
                subscribe(fn) {
                    listeners.add(fn);
                    return () => listeners.delete(fn);
                },
                open(server) { current = server; emit(); },
                close() { current = null; emit(); },
            };
        })();

        // ── 档案抽屉 ─────────────────────────────────────────────────────
        /**
         * 在面板内展示一台服务器的档案（覆盖层，不离开当前界面）。
         *
         * 为什么不用 `window.open`：**Electron 会静默拦掉它**。
         * 实测点「档案 ↗」→ 按钮出现焦点框、但窗口列表毫无变化、也没有任何报错。
         * 原因是宿主没有为这个 URL 配 `setWindowOpenHandler`，Electron 默认拒绝新建窗口。
         * 而 `window.open` 被拒时**不会抛异常**，所以 `try/catch` 也兜不住 —— 只能换方案。
         *
         * 所以改成：面板内原生渲染档案数据（走 `/servers/:id` 的 JSON，不是那份独立 HTML 页），
         * 这样不依赖新窗口、不依赖 iframe、还能直接用宿主的主题令牌。
         * 独立 HTML 页仍然保留（`/servers/:id/profile`），供用户手动复制地址或在浏览器里打开。
         */
        function ProfileDrawer({ server, t, onClose }) {
            const [data, setData] = useState(null);
            const [loading, setLoading] = useState(true);
            const [error, setError] = useState(null);

            useEffect(() => {
                let alive = true;
                setLoading(true);
                setError(null);
                api(`/servers/${encodeURIComponent(server.id)}`)
                    .then((value) => { if (alive) { setData(value); setLoading(false); } })
                    .catch((e) => { if (alive) { setError(String(e?.message ?? e)); setLoading(false); } });
                return () => { alive = false; };
            }, [server.id]);

            // Esc 关闭
            useEffect(() => {
                const onKey = (e) => { if (e.key === 'Escape') onClose(); };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, [onClose]);

            const p = data?.profile ?? null;
            const profileUrl = `${API}/servers/${encodeURIComponent(server.id)}/profile?fence=1`;

            const section = (title, count, body) => h('section', { className: 'so-pf-section' },
                h('div', { className: 'so-pf-h2' },
                    title,
                    typeof count === 'number' ? h('span', { className: 'so-pf-count' }, String(count)) : null),
                body);

            const empty = (msg) => h('div', { className: 'so-pf-empty' }, msg);

            const renderTraits = (traits) => (traits.length === 0 ? empty(t.profileNone)
                : h('div', { className: 'so-pf-list' }, traits.map((tr, i) => h('div', {
                    className: 'so-pf-item', key: tr.id ?? i,
                },
                    h('div', { className: 'so-pf-item-head' },
                        h('span', { className: `so-pf-sev so-pf-sev--${tr.severity ?? 'note'}` }, tr.severity ?? 'note'),
                        h('span', { className: 'so-pf-item-title' }, tr.title ?? ''),
                        tr.source ? h('span', { className: 'so-pf-src' }, tr.source) : null),
                    tr.detail ? h('div', { className: 'so-pf-text' }, tr.detail) : null,
                    tr.impact ? h('div', { className: 'so-pf-meta' }, `${t.profileImpact}：${tr.impact}`) : null,
                    tr.evidence ? h('div', { className: 'so-pf-meta' }, `${t.profileEvidence}：${tr.evidence}`) : null))));

            const renderPortMap = (rows) => (rows.length === 0 ? empty(t.profileNone)
                : h('div', { className: 'so-pf-list' }, rows.map((r, i) => h('div', {
                    className: 'so-pf-item', key: r.id ?? i,
                },
                    h('div', { className: 'so-pf-item-head' },
                        h('span', { className: 'so-pf-port' }, `${r.public ?? '?'} → ${r.internal ?? '?'}`),
                        h('span', { className: 'so-pf-item-title' }, r.app ?? ''),
                        r.proto ? h('span', { className: 'so-pf-src' }, r.proto) : null),
                    r.note ? h('div', { className: 'so-pf-text' }, r.note) : null))));

            const renderConstraints = (rows) => (rows.length === 0 ? empty(t.profileNone)
                : h('div', { className: 'so-pf-list' }, rows.map((c, i) => h('div', {
                    className: 'so-pf-item', key: c.id ?? i,
                },
                    h('div', { className: 'so-pf-item-head' },
                        h('span', { className: `so-pf-sev so-pf-sev--${c.severity ?? 'warn'}` }, c.severity ?? 'warn'),
                        c.source ? h('span', { className: 'so-pf-src' }, c.source) : null),
                    h('div', { className: 'so-pf-text' }, c.text ?? '')))));

            const renderRunbooks = (rows) => (rows.length === 0 ? empty(t.profileNone)
                : h('div', { className: 'so-pf-list' }, rows.map((r, i) => h('div', {
                    className: 'so-pf-item', key: r.id ?? i,
                },
                    h('div', { className: 'so-pf-item-head' },
                        h('span', { className: 'so-pf-item-title' }, r.name ?? ''),
                        r.verifiedAt ? h('span', { className: 'so-pf-src' }, r.verifiedAt) : null),
                    r.when ? h('div', { className: 'so-pf-text' }, r.when) : null,
                    (r.steps ?? []).length
                        ? h('ol', { className: 'so-pf-steps' }, (r.steps ?? []).map((st, j) => h('li', { key: j }, st)))
                        : null))));

            const renderTimeline = (rows) => (rows.length === 0 ? empty(t.profileNone)
                : h('div', { className: 'so-pf-list' }, rows.map((e, i) => h('div', {
                    className: 'so-pf-item so-pf-item--tight', key: i,
                },
                    h('div', { className: 'so-pf-item-head' },
                        h('span', { className: 'so-pf-src' }, String(e.at ?? '').slice(0, 10)),
                        h('span', { className: `so-pf-sev so-pf-sev--${e.kind ?? 'note'}` }, e.kind ?? 'note')),
                    h('div', { className: 'so-pf-text' }, e.text ?? '')))));

            const body = loading
                ? h('div', { className: 'so-loading' }, t.loading)
                : error
                    ? h('div', { className: 'so-error' }, `${t.failed}：${error}`)
                    : h('div', { className: 'so-pf-body' },
                        // 概要
                        p?.summary || p?.role
                            ? h('div', { className: 'so-pf-summary' },
                                p.summary ? h('div', { className: 'so-pf-summary-text' }, p.summary) : null,
                                p.role ? h('div', { className: 'so-pf-meta' }, `${t.profileRole}：${p.role}`) : null)
                            : null,
                        p
                            ? h('div', null,
                                // 空分区不渲染：一个「对外端口 → 内部 0 /（无）」的空壳只是噪音。
                                // 只有 traits 例外 —— 一台全新服务器「还没有特征」本身是有信息量的。
                                section(t.profileTraits, (p.traits ?? []).length, renderTraits(p.traits ?? [])),
                                (p.portMap ?? []).length
                                    ? section(t.profilePortMap, p.portMap.length, renderPortMap(p.portMap))
                                    : null,
                                (p.constraints ?? []).length
                                    ? section(t.profileConstraints, p.constraints.length, renderConstraints(p.constraints))
                                    : null,
                                (p.runbooks ?? []).length
                                    ? section(t.profileRunbooks, p.runbooks.length, renderRunbooks(p.runbooks))
                                    : null,
                                (p.timeline ?? []).length
                                    ? section(t.profileTimeline, p.timeline.length, renderTimeline(p.timeline))
                                    : null,
                                (p.openQuestions ?? []).length
                                    ? section(t.profileQuestions, p.openQuestions.length,
                                        h('ul', { className: 'so-pf-steps' }, p.openQuestions.map((q, i) => h('li', { key: i }, q))))
                                    : null,
                                p.updatedAt ? h('div', { className: 'so-pf-meta' }, `${t.profileUpdated}：${String(p.updatedAt).slice(0, 16).replace('T', ' ')}`) : null,
                            )
                            : empty(t.profileMissing));

            return h('div', {
                className: 'so-pf-overlay',
                role: 'dialog', 'aria-modal': 'true', 'aria-label': `${server.name} ${t.profile}`,
                onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
            },
                h('div', { className: 'so-pf-panel' },
                    h('div', { className: 'so-pf-head' },
                        h('div', { className: 'so-pf-head-text' },
                            h('div', { className: 'so-pf-title' }, `${server.name}`),
                            h('div', { className: 'so-pf-sub' }, `${t.profile} · ${server.user}@${server.host}:${server.port}`)),
                        h('span', { className: 'so-head-spacer' }),
                        h('button', {
                            className: 'so-btn so-btn--mini', type: 'button',
                            title: t.profileCopyHint,
                            onClick: (e) => {
                                e.stopPropagation();
                                try {
                                    // 独立页面地址：可以粘到浏览器里看（那里不受 Electron 新窗口限制）
                                    navigator.clipboard?.writeText(new URL(profileUrl, location.origin).href);
                                } catch { /* 剪贴板不可用就忽略 */ }
                            },
                        }, t.profileCopy),
                        h('button', { className: 'so-btn so-btn--mini', type: 'button', onClick: onClose }, t.close)),
                    body));
        }

        function ServersView({ data, loading, error, t, onRenamed }) {
            if (loading && !data) return h('div', { className: 'so-loading' }, t.loading);
            return h('div', null,
                error ? h('div', { className: 'so-error' }, `${t.failed}：${error}`) : null,
                h('div', { className: 'so-hint' }, t.inventoryHint),
                (!data || data.count === 0)
                    ? h('div', { className: 'so-empty' }, t.noServers)
                    : data.servers.map((s) => h(ServerRow, {
                        key: s.id, s, t, onRenamed,
                        // 抽屉渲染在 shell.overlay 里，这里只负责「说要看哪台」
                        onOpenProfile: (server) => profileStore.open(server),
                    })));
        }

        /**
         * overlay 条目：真正渲染抽屉的地方。
         * 订阅 profileStore，面板里点「档案」→ 这里收到通知 → 在整个 frame 上盖一层。
         */
        function ProfileOverlay() {
            const t = COPY[pickLocale()];
            const [server, setServer] = useState(() => profileStore.get());
            useEffect(() => profileStore.subscribe(setServer), []);
            if (!server) return null;
            return h('div', { className: 'so-pf-host' },
                h('style', null, CSS),
                h(ProfileDrawer, { server, t, onClose: () => profileStore.close() }));
        }

        // ── 终端 ─────────────────────────────────────────────────────────
        function TerminalLine({ entry, wrap, compact }) {
            // 同一条流里跨行的颜色要延续：用「远程输出」统一从默认样式起算，
            // 简单且在真实输出里几乎无感（大多数行自带重置码）。
            const spans = useMemo(() => parseAnsi(entry.text), [entry.text]);
            const kind = entry.kind || 'stdout';
            const kindClass = `so-line so-line--${kind}`;
            // 输入行照真终端的样子画：`用户名@主机:~$` 在前、命令在后。
            // 提示符单独一段并弱化，命令保持亮绿加粗 —— 这样「哪行是我发的」不用猜。
            if (kind === 'input') {
                return h('div', { className: kindClass },
                    h('span', { className: 'so-line-gutter' },
                        h('span', { className: 'so-line-time' }, timeText(entry.at))),
                    h('span', { className: 'so-line-text' },
                        entry.prompt ? h('span', { className: 'so-line-prompt' }, entry.prompt) : null,
                        h('span', { className: 'so-cmd' }, renderSpans(spans, entry.seq))));
            }
            // 流边界（开/关/失败）才显示机器名：普通输出行省掉这段宽度。
            // 会话头自己已经带机器名了，不再重复。
            const boundary = kind === 'stream-fail';
            const showServer = entry.serverName && (!compact || boundary) && kind !== 'stream-open';
            return h('div', { className: kindClass },
                h('span', { className: 'so-line-gutter' },
                    h('span', { className: 'so-line-time' }, timeText(entry.at)),
                    showServer ? h('span', { className: 'so-line-srv', title: entry.serverName }, entry.serverName) : null),
                h('span', { className: 'so-line-text' }, renderSpans(spans, entry.seq)));
        }

        function ConsoleView({ t, compact }) {
            const [lines, setLines] = useState([]);
            const [filter, setFilter] = useState('');
            const [live, setLive] = useState(false);
            const [error, setError] = useState(null);
            const [wrap, setWrap] = useState(true);
            const [stuck, setStuck] = useState(true);
            const termRef = useRef(null);

            useEffect(() => {
                let source = null;
                let closed = false;
                try {
                    source = new EventSource(`${API}/console/stream?since=0&fence=1`);
                } catch (e) {
                    setError(String(e?.message ?? e));
                    return () => {};
                }
                source.addEventListener('snapshot', (event) => {
                    if (closed) return;
                    try {
                        setLines(JSON.parse(event.data));
                        setLive(true);
                        setError(null);
                    } catch { /* 忽略畸形帧 */ }
                });
                source.addEventListener('entry', (event) => {
                    if (closed) return;
                    try {
                        const entry = JSON.parse(event.data);
                        setLines((prev) => {
                            const next = prev.length > 3000 ? prev.slice(-2500) : prev.slice();
                            next.push(entry);
                            return next;
                        });
                    } catch { /* 忽略 */ }
                });
                source.onerror = () => {
                    if (closed) return;
                    setLive(false);
                    setError('SSE 断开，正在重连…');
                };
                return () => {
                    closed = true;
                    try { source.close(); } catch { /* ignore */ }
                };
            }, []);

            // 自动跟随：用户手动上滚时暂停，回到底部自动恢复
            useEffect(() => {
                const el = termRef.current;
                if (!el || !stuck) return;
                el.scrollTop = el.scrollHeight;
            }, [lines, stuck]);

            const onScroll = useCallback(() => {
                const el = termRef.current;
                if (!el) return;
                setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
            }, []);

            const shown = useMemo(() => {
                const q = filter.trim().toLowerCase();
                if (!q) return lines;
                return lines.filter((l) => `${l.text || ''} ${l.serverName || ''} ${l.kind || ''}`.toLowerCase().includes(q));
            }, [lines, filter]);

            const clearView = useCallback(async () => {
                try {
                    await api('/console/clear', { method: 'POST' });
                    setLines([]);
                } catch (e) { setError(String(e?.message ?? e)); }
            }, []);

            const jumpToEnd = useCallback(() => {
                const el = termRef.current;
                if (!el) return;
                el.scrollTop = el.scrollHeight;
                setStuck(true);
            }, []);

            return h('div', { className: 'so-console' },
                h('div', { className: 'so-hint' }, t.consoleHint),
                error ? h('div', { className: 'so-error' }, error) : null,
                h('div', { className: 'so-console-bar' },
                    h('input', {
                        className: 'so-input', placeholder: t.filter, value: filter,
                        onChange: (e) => setFilter(e.target.value),
                    }),
                    h('span', { className: `so-chip${live ? ' so-chip--live' : ''}` }, live ? 'LIVE' : 'offline'),
                    h('span', { className: 'so-chip' }, String(shown.length)),
                    h('button', {
                        className: 'so-btn', type: 'button', 'data-on': String(wrap),
                        onClick: () => setWrap((v) => !v), title: t.wrap,
                    }, t.wrap),
                    h('button', {
                        className: 'so-btn', type: 'button', 'data-on': String(stuck),
                        onClick: jumpToEnd, title: t.follow,
                    }, stuck ? t.following : t.follow),
                    h('button', { className: 'so-btn', type: 'button', onClick: clearView }, t.clear)),
                h('div', { className: `so-term${wrap ? ' so-term--wrap' : ''}`, ref: termRef, onScroll },
                    shown.length === 0
                        ? h('div', { className: 'so-empty' }, t.consoleEmpty)
                        : shown.map((l) => h(TerminalLine, { key: l.seq, entry: l, wrap, compact })),
                    h('div', { className: 'so-line' },
                        h('span', { className: 'so-line-gutter' }, h('span', { className: 'so-line-time' }, '$')),
                        h('span', { className: 'so-line-text' }, h('span', { className: 'so-cursor' })))));
        }

        // ── 主体（两种容器共用） ─────────────────────────────────────────
        function OpsBody({ surface }) {
            const t = COPY[pickLocale()];
            const compact = surface === 'right';
            const [tab, setTab] = useState('console');
            const [data, setData] = useState(null);
            const [loading, setLoading] = useState(false);
            const [error, setError] = useState(null);

            const load = useCallback(async () => {
                setLoading(true);
                try {
                    const value = await api('/servers');
                    setData(value);
                    setError(null);
                } catch (e) {
                    setError(String(e?.message ?? e));
                } finally {
                    setLoading(false);
                }
            }, []);

            useEffect(() => { load(); }, [load]);

            /**
             * 改名/改标签成功后**就地更新这一行**，不重拉整个清单。
             * 理由：重拉会让整张列表闪一下、展开的行也会塌回去——用户只是改了个名字，
             * 不该为此付出「重新找到刚才那台机器」的代价。
             */
            const handleRenamed = useCallback((updated) => {
                setData((prev) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        servers: prev.servers.map((x) => (x.id === updated.id
                            ? { ...x, name: updated.name, tags: updated.tags }
                            : x)),
                    };
                });
            }, []);

            return h('div', { className: `so-root${compact ? ' so-root--right' : ''}` },
                h('style', null, CSS),
                h('div', { className: 'so-head' },
                    h(Mark),
                    h('div', { className: 'so-head-text' },
                        h('div', { className: 'so-head-title' }, t.title),
                        h('div', { className: 'so-head-sub' }, t.subtitle)),
                    h('span', { className: 'so-head-spacer' }),
                    h('button', { className: 'so-btn', onClick: load, disabled: loading, type: 'button' }, t.refresh)),
                h('div', { className: 'so-tabs', role: 'tablist' },
                    h('button', {
                        className: 'so-tab', role: 'tab', type: 'button',
                        'aria-selected': tab === 'console',
                        onClick: () => setTab('console'),
                    }, t.tabConsole),
                    h('button', {
                        className: 'so-tab', role: 'tab', type: 'button',
                        'aria-selected': tab === 'servers',
                        onClick: () => setTab('servers'),
                    }, `${t.tabServers}${data ? ` · ${data.count}` : ''}`)),
                h('div', { className: 'so-body' },
                    tab === 'servers'
                        ? h(ServersView, { data, loading, error, t, onRenamed: handleRenamed })
                        : h(ConsoleView, { t, compact })));
        }

        /** 主面板（整页）。 */
        function Panel() {
            return h(OpsBody, { surface: 'main' });
        }

        /** 右侧栏 tab（贴在对话框右边）。 */
        function RightTab() {
            return h(OpsBody, { surface: 'right' });
        }

        // ── 注册 ─────────────────────────────────────────────────────────
        const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

        /** 右侧栏 tab 类型：id 与 sidebar.right.pane.tab 的 key 一致。 */
        function tabDefinition() {
            return {
                id: TAB_ID,
                kind: TAB_KIND,
                priority: 'extension',
                title: () => '🖧 运维',
                guide: [{ order: 95, title: () => '服务器运维台', description: () => '服务器总览与实时操作终端' }],
            };
        }

        function apply(ctx) {
            console.info(`[dsh-ssh-ops] client apply v${PLUGIN_VERSION}`);

            // ① 档案抽屉：渲染在框架级浮层 shell.overlay 里（面板内 fixed 会被容器限制）
            try {
                ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                    name: 'shell.overlay',
                    id: 'dsh-ssh-ops.profile',
                    order: 40,
                }, ProfileOverlay)), 'dsh-ssh-ops: 档案浮层');
            } catch (error) {
                console.warn('[dsh-ssh-ops] 档案浮层注册失败', error);
            }

            // ① 右侧栏 tab：类型声明 + 内容
            try {
                if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
                    ctx.effect(() => ctx.sidebarRightTabs.register(tabDefinition()), 'dsh-ssh-ops: 右侧栏 tab 类型');
                }
            } catch (error) {
                console.warn('[dsh-ssh-ops] 右侧栏 tab 类型注册失败（主面板仍可用）', error);
            }
            try {
                ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
                    name: 'sidebar.right.pane.tab',
                    key: TAB_ID,
                }, RightTab)), 'dsh-ssh-ops: 右侧栏 tab 内容');
            } catch (error) {
                console.warn('[dsh-ssh-ops] 右侧栏内容注册失败（主面板仍可用）', error);
            }

            // ② 主面板 + 侧栏入口
            try {
                ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
                    name: 'sidebar.panellist',
                    id: PANEL_ID,
                    order: 20,
                    label: () => '🖧 服务器运维',
                }, () => h(Mark))), 'dsh-ssh-ops: sidebar entry');
                ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
                    name: 'main',
                    key: PANEL_ID,
                }, Panel)), 'dsh-ssh-ops: main panel');
            } catch (error) {
                console.error('[dsh-ssh-ops] 主面板注册失败', error);
            }

            // ③ 会话开始后自动把右侧栏 tab 打开（可关；失败不报错，用户可从 guide 手动进）
            const tryOpen = () => {
                try {
                    if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
                        ctx.sidebarRight.openTab(TAB_KIND);
                        return true;
                    }
                } catch { /* 还没就绪 */ }
                return false;
            };
            const timer = setTimeout(() => {
                if (tryOpen()) return;
                let tries = 0;
                const retry = setInterval(() => {
                    tries += 1;
                    if (tryOpen() || tries > 20) clearInterval(retry);
                }, 400);
                ctx.effect(() => () => clearInterval(retry), 'dsh-ssh-ops: open retry');
            }, 600);
            ctx.effect(() => () => clearTimeout(timer), 'dsh-ssh-ops: open timer');

            if (typeof window !== 'undefined') {
                window.__dshSshOps = {
                    version: PLUGIN_VERSION,
                    kind: TAB_KIND,
                    open: () => { try { ctx.sidebarRight.openTab(TAB_KIND); return true; } catch { return false; } },
                };
            }
        }

        return { inject, apply, __internals: { OpsBody, Panel, RightTab, ServersView, ConsoleView, TerminalLine, ServerRow, IdentityEditor, AppList, ProfileDrawer, ProfileOverlay, profileStore, CSS, PANEL_ID, TAB_ID, TAB_KIND, parseAnsi } };
    },
});

