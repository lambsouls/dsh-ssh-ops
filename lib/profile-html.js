// lib/profile-html.js —— 把一份服务器档案渲染成**独立的 HTML 页面**。
//
// 为什么单独做一页，而不是在面板下拉里铺开：
//   档案是**给 DSH 自己看的**（它决定「动手前先读什么」），对用户来说绝大多数时候不需要。
//   把七个分区塞进服务器行的展开区，等于每次展开都糊一大坨，还占掉半屏。
//   所以：行里只留一个「档案 ↗」按钮，需要时点开新标签页慢慢看。
//
// 设计约束：
//   · **完全自包含**：没有外部 CSS/JS/字体请求，单个响应就能看。它可能在
//     没有网络的机器上被打开，也可能被另存下来看。
//   · **所有档案内容都要转义**：档案里的事实可能来自模型输出或用户输入，
//     直接插进 HTML 就是 XSS。宁可多转义，不要少转义。
//   · **颜色用主题令牌 + 兜底值**：在 DSH 里打开时跟随主题，独立打开时也有可读的兜底。
//     写法 `var(--dsw-alias-x, #fallback)` —— 兜底值是刻意的，不是硬编码偷懒。

/** HTML 转义。所有来自档案的文本都必须过这一道。 */
export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

const SEVERITY_LABEL = { info: '提示', note: '记录', warn: '注意', critical: '重要' };
const SOURCE_LABEL = { owner: '用户告知', probe: '实测', agent: '推断' };
const KIND_LABEL = {
    network: '网络', access: '访问', storage: '存储', runtime: '运行时',
    dependency: '依赖', behavior: '行为', ownership: '归属', other: '其他',
};
const TIMELINE_LABEL = { change: '改动', incident: '事故', note: '记录', decision: '决定' };

function sevClass(severity) {
    return ['info', 'note', 'warn', 'critical'].includes(severity) ? severity : 'note';
}

function traitsBlock(profile) {
    if (!profile.traits.length) return '';
    const rows = profile.traits.map((x) => `
      <li class="item sev-${sevClass(x.severity)}">
        <div class="item-head">
          <span class="dot" aria-hidden="true"></span>
          <span class="item-title">${esc(x.title)}</span>
          <span class="chip">${esc(KIND_LABEL[x.kind] ?? x.kind)}</span>
          <span class="chip chip-src">${esc(SOURCE_LABEL[x.source] ?? x.source)}</span>
          ${x.since ? `<span class="chip">${esc(x.since)}</span>` : ''}
        </div>
        ${x.detail ? `<p class="item-detail">${esc(x.detail)}</p>` : ''}
        ${x.impact ? `<p class="item-impact">运维含义：${esc(x.impact)}</p>` : ''}
        ${x.evidence ? `<p class="item-evidence">依据：${esc(x.evidence)}</p>` : ''}
      </li>`).join('');
    return `<section><h2>专属特征 <span class="count">${profile.traits.length}</span></h2><ul class="list">${rows}</ul></section>`;
}

function portMapBlock(profile) {
    if (!profile.portMap.length) return '';
    const rows = profile.portMap.map((m) => `
      <tr>
        <td class="mono">${m.public ? `:${m.public}` : '—'}</td>
        <td class="arrow">→</td>
        <td class="mono">${m.internal ? `:${m.internal}` : '—'}</td>
        <td>${esc(m.app ?? '')}</td>
        <td><span class="chip chip-src">${esc(SOURCE_LABEL[m.source] ?? m.source)}</span></td>
        <td class="note">${esc(m.note ?? '')}</td>
      </tr>`).join('');
    return `<section><h2>对外端口 → 内部 <span class="count">${profile.portMap.length}</span></h2>
      <table class="ports"><thead><tr><th>对外</th><th></th><th>内部</th><th>应用</th><th>来源</th><th>备注</th></tr></thead>
      <tbody>${rows}</tbody></table></section>`;
}

function constraintsBlock(profile) {
    if (!profile.constraints.length) return '';
    const rows = profile.constraints.map((c) => `
      <li class="item sev-${sevClass(c.severity)}">
        <div class="item-head">
          <span class="dot" aria-hidden="true"></span>
          <span class="item-title">${esc(c.text)}</span>
          <span class="chip chip-src">${esc(SOURCE_LABEL[c.source] ?? c.source)}</span>
        </div>
      </li>`).join('');
    return `<section><h2>硬约束 / 不要碰 <span class="count">${profile.constraints.length}</span></h2><ul class="list">${rows}</ul></section>`;
}

function runbooksBlock(profile) {
    if (!profile.runbooks.length) return '';
    const rows = profile.runbooks.map((r) => `
      <li class="item">
        <div class="item-head">
          <span class="item-title">${esc(r.name)}</span>
          ${r.verifiedAt ? `<span class="chip">验证于 ${esc(r.verifiedAt)}</span>` : ''}
          <span class="chip chip-src">${esc(SOURCE_LABEL[r.source] ?? r.source)}</span>
        </div>
        ${r.when ? `<p class="item-detail">何时用：${esc(r.when)}</p>` : ''}
        ${r.steps.length ? `<ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
      </li>`).join('');
    return `<section><h2>常用处置 <span class="count">${profile.runbooks.length}</span></h2><ul class="list">${rows}</ul></section>`;
}

function questionsBlock(profile) {
    if (!profile.openQuestions.length) return '';
    return `<section><h2>待确认（问用户，不要猜） <span class="count">${profile.openQuestions.length}</span></h2>
      <ul class="list questions">${profile.openQuestions.map((q) => `<li>？ ${esc(q)}</li>`).join('')}</ul></section>`;
}

function timelineBlock(profile) {
    if (!profile.timeline.length) return '';
    const rows = profile.timeline.slice().reverse().map((t) => `
      <li class="tl-row">
        <span class="tl-at mono">${esc(String(t.at).slice(0, 16).replace('T', ' '))}</span>
        <span class="chip chip-${esc(t.kind)}">${esc(TIMELINE_LABEL[t.kind] ?? t.kind)}</span>
        <span class="tl-text">${esc(t.text)}</span>
      </li>`).join('');
    return `<section><h2>时间线 <span class="count">${profile.timeline.length}</span></h2><ul class="list timeline">${rows}</ul></section>`;
}

/**
 * 渲染整页。
 * @param {object} server  凭证库的公开视图（含 user/host/port）
 * @param {object} profile 档案
 * @returns {string} 完整的 HTML 文档
 */
export function renderProfilePage(server, profile) {
    const title = `${server?.name ?? profile?.name ?? '服务器'} · 档案`;
    const body = profile ? [
        traitsBlock(profile),
        portMapBlock(profile),
        constraintsBlock(profile),
        runbooksBlock(profile),
        questionsBlock(profile),
        timelineBlock(profile),
    ].filter(Boolean).join('\n') : '';

    const meta = [
        server?.user && server?.host ? `${server.user}@${server.host}:${server.port ?? 22}` : null,
        profile?.role,
    ].filter(Boolean).map(esc).join(' · ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--dsw-alias-bg-base, #ffffff);
    --surface: var(--dsw-alias-bg-layer-1, #f7f8fa);
    --surface2: var(--dsw-alias-bg-layer-2, #eef0f4);
    --line: var(--dsw-alias-border-l1, #e2e5ea);
    --line2: var(--dsw-alias-border-l2, #cdd2da);
    --text: var(--dsw-alias-label-primary, #1a1d21);
    --dim: var(--dsw-alias-label-secondary, #6b7280);
    --accent: var(--dsw-alias-brand-primary, #2563eb);
    --warn: var(--dsw-alias-state-warn-primary, #d97706);
    --bad: var(--dsw-alias-state-error-primary, #dc2626);
    --idle: var(--dsw-alias-state-idle-primary, #9ca3af);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: var(--dsw-alias-bg-base, #17191c);
      --surface: var(--dsw-alias-bg-layer-1, #1f2226);
      --surface2: var(--dsw-alias-bg-layer-2, #26292e);
      --line: var(--dsw-alias-border-l1, #2f3338);
      --line2: var(--dsw-alias-border-l2, #3d4248);
      --text: var(--dsw-alias-label-primary, #e6e8eb);
      --dim: var(--dsw-alias-label-secondary, #9aa1a9);
      --accent: var(--dsw-alias-brand-primary, #6ba3ff);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 60px; background: var(--bg); color: var(--text);
    font: 14px/1.65 -apple-system, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 820px; margin: 0 auto; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 22px; }
  h1 { font-size: 19px; margin: 0 0 4px; font-weight: 650; }
  .meta { color: var(--dim); font-size: 12.5px; }
  .hint { color: var(--dim); font-size: 11.5px; margin-top: 8px; line-height: 1.6;
    border-left: 2px solid var(--line2); padding-left: 9px; }
  section { margin: 0 0 26px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim);
    margin: 0 0 9px; font-weight: 600; display: flex; align-items: center; gap: 7px; }
  .count { font-size: 10.5px; background: var(--surface2); border-radius: 999px;
    padding: 1px 7px; letter-spacing: 0; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
  .item { border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
    padding: 9px 11px; }
  .item-head { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
  .item-title { font-weight: 600; font-size: 13px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--idle); flex: none;
    align-self: center; }
  .sev-warn .dot { background: var(--warn); }
  .sev-critical .dot { background: var(--bad);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad) 18%, transparent); }
  .item-detail { margin: 5px 0 0; color: var(--text); font-size: 12.5px; }
  .item-impact { margin: 5px 0 0; color: var(--dim); font-size: 12px; font-style: italic; }
  .item-evidence { margin: 4px 0 0; color: var(--dim); font-size: 11.5px; }
  .chip { font-size: 10.5px; border: 1px solid var(--line2); border-radius: 999px;
    padding: 0 6px; color: var(--dim); white-space: nowrap; }
  .chip-src { border-style: dashed; }
  .chip-incident, .chip-change { color: var(--warn); border-color: var(--warn); }
  .chip-decision { color: var(--accent); border-color: var(--accent); }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  table.ports { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  table.ports th { text-align: left; font-weight: 500; color: var(--dim); font-size: 11px;
    padding: 0 8px 5px 0; border-bottom: 1px solid var(--line); }
  table.ports td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.ports td.arrow { color: var(--dim); }
  table.ports td.note { color: var(--dim); font-size: 11.5px; }
  .steps { margin: 6px 0 0; padding-left: 20px; color: var(--dim); font-size: 12.5px; }
  .steps li { margin: 2px 0; }
  .questions li { border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
    padding: 7px 11px; color: var(--warn); font-size: 12.5px; }
  .timeline .tl-row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
    font-size: 12px; padding: 3px 0; border-bottom: 1px dashed var(--line); }
  .tl-at { color: var(--dim); font-size: 11px; flex: none; }
  .tl-text { flex: 1 1 240px; }
  footer { margin-top: 34px; padding-top: 12px; border-top: 1px solid var(--line);
    color: var(--dim); font-size: 11px; line-height: 1.7; }
  .empty { color: var(--dim); font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(server?.name ?? profile?.name ?? '服务器档案')}</h1>
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    ${profile?.summary ? `<div class="hint">${esc(profile.summary)}</div>` : ''}
  </header>
  ${body || '<p class="empty">这台服务器还没有档案。在对话里让 DSH 记录它的独有特征即可。</p>'}
  <footer>
    ${profile ? `档案更新于 ${esc(String(profile.updatedAt ?? '').slice(0, 16).replace('T', ' '))} · ` : ''}
    这份档案是 DSH 运维时读的知识，不是服务器状态快照。<br>
    每页数据只来自本机凭证库与档案文件，不联网。
  </footer>
</div>
</body>
</html>`;
}
