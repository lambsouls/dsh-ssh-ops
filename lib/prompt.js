// lib/prompt.js —— 给控制台的输入行造一个「真终端提示符」。
//
// 为什么需要它：用户反馈「输入输出分不出来」。真实 SSH 会话里这件事从来不需要猜 ——
// 因为命令前面永远有 `用户@主机名:~$` 这样的提示符，而输出没有。
// 所以控制台也照抄这个视觉契约：绿字、带提示符的是输入，其余是输出。
//
// 三条口径：
//   ① **提示符必须看起来像真的**（`用户名@主机名:cwd#`），不能编一个假主机名；
//      远端没给回主机名时退回地址，宁可丑也不骗人。
//   ② **登录用户不一定是 root**：`#` 只给 root，其余用户用 `$` —— 和真 shell 一致，
//      这条区分本身就是用户能立刻读懂的信息（我现在是不是特权身份）。
//      文案与示例里不要假设 root，用「用户名@主机」泛指。
//   ③ 这里**不做脱敏**：prompt 会走 journal.push 的统一出口，密码在那一层被替换。

/**
 * 远端回的主机名可能是各种脏数据。
 * **整段**校验，不做「取第一个 token」式的容错 —— `a b/c` 里取出的 `a` 是碰巧合法、
 * 但根本不是主机名，画到提示符上就是在骗人。宁可退回地址。
 */
function cleanHost(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    return /^[A-Za-z0-9._-]{1,63}$/.test(text) ? text : '';
}

/**
 * 造提示符。
 *
 * @param {{ user?:string, hostname?:string, host?:string, cwd?:string }} info
 * @returns {string} 例如 `user@fileserver:~$`
 */
export function shellPrompt({ user, hostname, host, cwd } = {}) {
    // 用户名缺失时**不留空、也不冒充 root**：凭证里 user 是必填，走不到这里；
    // 真走到了说明上游有 bug，显示 `user@` 比显示 `root@` 安全（后者是在断言特权身份）。
    const who = String(user ?? '').trim() || 'user';
    // 主机名拿不到就退回地址：这是唯一「确定是真」的替代信息。
    const where = cleanHost(hostname) || cleanHost(host) || 'localhost';
    const dir = String(cwd ?? '').trim() || '~';
    // root 用 #，其他用户用 $ —— 与真实 bash 一致。
    const sigil = who === 'root' ? '#' : '$';
    return `${who}@${where}:${dir}${sigil}`;
}

/**
 * 一条命令很可能自带工作目录切换（`cd /x && ...`）时，提示符里的 `~` 就不准了。
 * 这里不追求精确（那要真跑一遍 shell），只做一件保守的事：
 * 命令开头有明显的绝对路径 cd，就把那个目录显示出来。
 */
export function promptForCommand(info, command) {
    const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(String(command ?? ''));
    const target = m ? (m[1] ?? m[2] ?? m[3]) : '';
    const cwd = target && target.startsWith('/') ? target : undefined;
    return shellPrompt({ ...info, cwd });
}
