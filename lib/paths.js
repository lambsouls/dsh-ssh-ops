// lib/paths.js —— 插件在本机落盘的位置。
//
// 核心原则：**代码目录永远不存用户数据**。
//   · 插件包（这个仓库）是可公开、可推送、可被别人 clone 的纯代码；
//   · 凭证与日志放在 `~/.dsh/ssh-ops/`，与代码目录彻底分离。
//
// 早期版本把日志写在代码目录的 `.runtime/logs` 下，导致「跑过就会有真实 IP 落在仓库里」。
// 现在日志也挪进用户目录；`vaultDir`/`logDir` 仍可由插件 Config 覆盖（各人各机可以不同）。

import path from 'node:path';
import os from 'node:os';

/** 用户数据根：`~/.dsh/ssh-ops`（Windows 上是 `C:\Users\<你>\.dsh\ssh-ops`）。 */
export function dataRoot() {
    return path.join(os.homedir(), '.dsh', 'ssh-ops');
}

/** 凭证库目录（默认 `~/.dsh/ssh-ops/vault`）。 */
export function defaultVaultDir() {
    return path.join(dataRoot(), 'vault');
}

/** 操作日志目录（默认 `~/.dsh/ssh-ops/logs`）。 */
export function defaultLogDir() {
    return path.join(dataRoot(), 'logs');
}

/** 只需要知道 vault 在不在，不读内容。 */
export function vaultFile(vaultDir) {
    return path.join(vaultDir, 'servers.json');
}

export function keyDir(vaultDir) {
    return path.join(vaultDir, 'keys');
}
