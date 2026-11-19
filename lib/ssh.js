// lib/ssh.js —— 调用 ssh_exec.py 的 Node 侧。
//
// 三条硬规矩：
//   ① 凭证只走 stdin（不出现在进程命令行、不进任何日志）；
//   ② 输出边收边脱敏边广播（控制台要「实时」，就不能等命令结束才处理）；
//   ③ 每次连接都是一条独立 SSH 会话，用完即关，不留后台连接。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'ssh_exec.py');

/**
 * 找可用的 Python。刻意**不写死任何人的安装路径**：
 * 配置值 → `PYTHON` 环境变量 → PATH 里的 python3 / python → Windows 的 py 启动器。
 * 想固定解释器就在插件 Config 里写 `pythonPath`（各人各机不同，不该进仓库）。
 */
export function resolvePython(configured) {
    if (configured && fs.existsSync(configured)) return configured;
    const fromEnv = process.env.SSH_OPS_PYTHON || process.env.PYTHON;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * 跑一条远程命令，边跑边把事件交给 onEvent。
 * @returns {Promise<{code:number, stdout:string, stderr:string, durationMs:number, failure?:{kind:string,message:string}}>}
 */
export function runRemote({ python, vaultSecrets, command, timeoutMs, loginShell = true, color = true, onEvent = () => {} }) {
    return new Promise((resolve) => {
        const request = {
            host: vaultSecrets.host,
            port: vaultSecrets.port,
            user: vaultSecrets.user,
            authType: vaultSecrets.authType,
            password: vaultSecrets.password,
            privateKey: vaultSecrets.privateKey,
            keyFile: vaultSecrets.keyFile,
            passphrase: vaultSecrets.passphrase,
            hostKeyPolicy: vaultSecrets.hostKeyPolicy,
            command,
            timeoutMs,
            loginShell,
            color,
        };
        const child = spawn(python, ['-u', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        let buffered = '';
        let settled = false;
        let failure;
        let endedCode = 0;
        let durationMs = 0;

        const finish = (extra) => {
            if (settled) return;
            settled = true;
            resolve({
                code: endedCode,
                stdout,
                stderr,
                durationMs,
                ...(failure ? { failure } : {}),
                ...(extra ?? {}),
            });
        };

        child.on('error', (error) => {
            failure = { kind: 'spawn', message: `无法启动 SSH 助手（${python}）：${error?.message ?? error}` };
            finish();
        });

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            buffered += chunk;
            let idx;
            while ((idx = buffered.indexOf('\n')) >= 0) {
                const line = buffered.slice(0, idx).trim();
                buffered = buffered.slice(idx + 1);
                if (!line) continue;
                let event;
                try { event = JSON.parse(line); } catch { continue; }
                if (event.t === 'out') { stdout += event.d ?? ''; onEvent({ type: 'out', text: event.d ?? '' }); }
                else if (event.t === 'err') { stderr += event.d ?? ''; onEvent({ type: 'err', text: event.d ?? '' }); }
                else if (event.t === 'begin') { onEvent({ type: 'begin', host: event.host, port: event.port, user: event.user }); }
                else if (event.t === 'end') { endedCode = Number(event.code ?? 0); durationMs = Number(event.durationMs ?? 0); onEvent({ type: 'end', code: endedCode, durationMs }); }
                else if (event.t === 'fail') { failure = { kind: String(event.kind ?? 'unknown'), message: String(event.message ?? '') }; onEvent({ type: 'fail', kind: failure.kind, message: failure.message }); }
            }
        });

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        child.on('close', (code) => {
            // Python 非零退出但没有 fail 事件（例如 import 崩了）：把 stderr 当失败原因
            if (!failure && code !== 0 && code !== null) {
                failure = { kind: code === 3 ? 'env' : 'exit', message: stderr.trim().slice(0, 800) || `SSH 助手退出码 ${code}` };
            }
            if (!durationMs) durationMs = 0;
            finish();
        });

        // 凭证整段写进 stdin 后立刻关闭，任何日志都看不到它
        try {
            child.stdin.end(JSON.stringify(request));
        } catch (error) {
            failure = { kind: 'spawn', message: `无法向 SSH 助手写入请求：${error?.message ?? error}` };
            finish();
        }
    });
}

export { SCRIPT };
