// lib/ansi.js —— ANSI 转义序列处理。
//
// 两个用途，别混：
//   · stripAnsi()：给**模型**看的结果要去掉颜色码（模型不需要 \x1b[32m 这种噪音，还白烧 token）；
//   · parseAnsi()：给**控制台**用，把 SGR 序列翻译成「文字 + 颜色」，面板才能真的五颜六色。
//
// 支持范围：SGR（30-37 / 90-97 / 40-47 / 100-107 / 1 / 2 / 3 / 4 / 7 / 22 / 39 / 49）+
// 256 色（38;5;n、48;5;n）+ 真彩色（38;2;r;g;b）。其余 CSI/OSC 序列（光标移动、标题设置、清屏）
// 直接丢弃 —— 终端控件不是真终端，画不了那些。

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[@-Z\\-_]/g;

/** 去掉所有 ANSI 控制序列与裸控制字符（保留 \n \t）。 */
export function stripAnsi(input) {
    if (typeof input !== 'string') return '';
    if (input.indexOf('\x1b') === -1) return sanitizeControls(input);
    return sanitizeControls(input.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, ''));
}

function sanitizeControls(text) {
    // 退格 / 响铃 / 其它 C0 控制字符一律去掉（\r 由调用方先处理）
    return text.replace(/[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f]/g, '');
}

/** 标准 16 色（xterm 调色板，深底上稍作提亮）。 */
const BASIC = [
    '#3b4048', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#dcdfe4',
    '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#7cc0ff', '#e29aef', '#6fd3df', '#ffffff',
];

/** 256 色表里 16-255 的值（xterm 标准公式）。 */
function color256(n) {
    if (n < 16) return BASIC[n];
    if (n < 232) {
        const i = n - 16;
        const r = Math.floor(i / 36);
        const g = Math.floor((i % 36) / 6);
        const b = i % 6;
        const level = (v) => (v === 0 ? 0 : 55 + v * 40);
        return `rgb(${level(r)},${level(g)},${level(b)})`;
    }
    const gray = 8 + (n - 232) * 10;
    return `rgb(${gray},${gray},${gray})`;
}

export const DEFAULT_STYLE = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });

/**
 * 把带 ANSI 的一行文本切成 [{text, fg, bg, bold, dim, italic, underline, inverse}]。
 * 起点是默认样式；跨行保持颜色时把上一行的 styleAtEnd() 传进 `initial`。
 */
export function parseAnsi(line, initial) {
    const text = String(line ?? '');
    if (text.indexOf('\x1b') === -1 && !initial) return [{ text: sanitizeControls(text), ...DEFAULT_STYLE }];

    const spans = [];
    let style = { ...(initial ?? DEFAULT_STYLE) };
    let buffer = '';

    const flush = () => {
        if (buffer) {
            spans.push({ text: buffer, ...style });
            buffer = '';
        }
    };

    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\x1b') {
            if (text[i + 1] === ']') {
                const end = text.indexOf('\x07', i + 2);
                const st = text.indexOf('\x1b\\', i + 2);
                i = end >= 0 ? end + 1 : (st >= 0 ? st + 2 : text.length);
                continue;
            }
            if (text[i + 1] === '[') {
                const match = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(text.slice(i));
                if (match) {
                    const [whole, params, , final] = match;
                    if (final === 'm') {
                        flush();
                        style = applySgr(style, params);
                    }
                    i += whole.length;
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

function applySgr(prev, params) {
    const style = { ...prev };
    const codes = (params === '' ? '0' : params)
        .split(';')
        .map((x) => (x === '' ? 0 : Number(x)))
        .filter((n) => Number.isInteger(n));

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
                const [r, g, b] = [codes[k + 2] ?? 0, codes[k + 3] ?? 0, codes[k + 4] ?? 0];
                style[target] = `rgb(${r},${g},${b})`;
                k += 4;
                continue;
            }
            k += 1;
        }
    }
    return style;
}

/** 一行的样式终态（下一行接着用时传回 parseAnsi 的 initial）。 */
export function styleAtEnd(spans) {
    const last = spans[spans.length - 1];
    if (!last) return { ...DEFAULT_STYLE };
    const { text: _text, ...style } = last;
    return style;
}
