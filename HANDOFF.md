# HANDOFF · 交接说明

> 这份文档给**下一个会话**（或未来的我）看：不用读整段对话也能接着干。
> 最后更新：2026-11-19

## 一句话现状

`dsh-ssh-ops`（服务器运维台）v0.3.0 已开发完成、装机运行、3 台真实服务器验收通过；
git 仓库已初始化并完成首次提交，**工作区干净、内容零敏感数据**；**尚未推送到 GitHub**（网络需要代理）。

## 代码在哪

| 项 | 值 |
|---|---|
| 本地仓库 | 本文件所在目录（git 分支 `main`，首次提交 `445a605`） |
| 安装方式 | desktop profile 里以 `link:` 指向本仓库目录（改代码 + 重载插件即生效） |
| 插件启用 | `include:dsh-ssh-ops`（用 `plugin_manager` 的 `set_plugin` 开关） |
| 重载方式 | `set_plugin enabled:false` 再 `true`（**不是**重启 DSH） |

## 数据在哪（与代码彻底分离）

```
~/.dsh/ssh-ops/
  vault/servers.json   凭证库（元信息明文 + secrets 密文）
  vault/master.key     AES-256-GCM 主密钥
  vault/keys/*.pem     私钥临时文件（仅密钥认证时）
  logs/ops-console.ndjson  操作日志（已脱敏，含真实 IP，所以不进仓库）
```

- 由 `lib/paths.js` 决定，可被插件 Config 的 `vaultDir` / `logDir` 覆盖。
- **不要**把这两个指向仓库内部 —— v0.2.x 就是这么把日志写进项目、差点连真实 IP 一起推上去的。

### 三道防线（按可靠性排序）

1. **结构上分开**（最强）：数据压根不在仓库目录里。这是唯一不依赖「人记得」的保障。
2. **钩子硬拦截**：`pre-commit` / `pre-push` 自动跑 `scripts/publish-gate.mjs`，跑不过就不许提交。
   换机器 / 新克隆后要跑一次 `node scripts/install-hooks.mjs`（钩子是本地文件，不随 git 分发）。
3. **`.gitignore`**（最弱）：只挡「手滑 git add」，挡不住「手工 tar 整个目录」。

## 推送流程（**卡在认证，需主人提供凭据**）

### 当前状态（2026-11-19 20:15）

| 项 | 结果 |
|---|---|
| 仓库 | ✅ 就绪：`main` 分支、7 个提交、36 个跟踪文件、工作区干净 |
| remote | ✅ 已设为 `https://github.com/lambsouls/dsh-ssh-ops.git` |
| GitHub 账号 | ✅ 确认存在（`lambsouls`，14 个公开仓库）；`dsh-ssh-ops` 名字可用 |
| 闸门 | ✅ `STATUS: OK`（全目录 + 已跟踪文件都过） |
| **认证** | ❌ **无任何 GitHub 凭据**：凭据管理器无 github 条目、无 `GITHUB_TOKEN`/`GH_TOKEN` 环境变量、工作区无相关凭证 |
| 网络 | ⚠️ 不稳定：`github.com:443` 约 5 次通 1 次；`api.github.com` 稳定；`ssh(22)` 通但本机无密钥 |

**结论：内容已完全就绪，只差凭据。** 一旦提供，一条命令即可推送。

### 主人需要做的（三选一）

**A. 提供 PAT（最快）**
在 https://github.com/settings/tokens 建一个 classic token，勾 `repo` 权限，然后告诉我。
我会用它推一次，推完立刻从 remote URL 里抹掉（不留在 `.git/config`）。

**B. 在这台机器上登录一次**
任意终端跑一次 `git push`，让 Windows 凭据管理器弹出登录窗口完成授权；
之后我在同一账号下推送就不需要再问。

**C. 装 gh 并登录**
```powershell
winget install GitHub.cli
gh auth login      # 浏览器授权
gh repo create dsh-ssh-ops --public --source=. --remote=origin --push
```

### 推送命令（凭据就位后）

```bash
cd <本仓库目录>
node scripts/publish-gate.mjs --all      # 必须 OK
git -c http.proxy= -c https.proxy= push -u origin main
```

> 为什么带 `-c http.proxy=`：全局 `~/.gitconfig` 配了 `http.proxy=127.0.0.1:7890`，
> 代理没开时 git 会去连一个不存在的端口。本仓库已清空 local 代理，但全局配置仍可能拦。
>
> 网络不稳，`push` 可能要重试几次。不要用 `--force`，`main` 是空仓库不需要。

### 离线备份

无凭据时也留了完整仓库快照：`D:\codex\.tmp\dsh-ssh-ops.bundle`（88.8 KB，含全部 7 个提交）。
在有凭据的机器上 `git clone <bundle文件> dsh-ssh-ops` 即可还原。

### 待确认
- **GitHub 账号名**：全局 git 身份是 `lambsouls` / `lambsouls@nerveplexus.cn`，
  但 GitHub 用户名未核实（公开仓库探测因代理未开而失败）。
- **认证方式**：`credential.helper = manager`（来自 `C:/Program Files/Git/etc/gitconfig`），
  Windows 凭据管理器里**可能已有**旧凭据。推送时如果直接成功就不用管；要手动配就用 PAT。
- **代理**：~~127.0.0.1:7890 不通~~ → **已实测：GitHub 直连可用**（`api.github.com` 返回 200）。
  全局 `~/.gitconfig` 里配了 `http.proxy=127.0.0.1:7890`，代理没开时 git 会失败。
  本仓库已 `git config --local` 清空代理；若全局仍拦，用 `git -c http.proxy= push`。

### 已修（子代理审查发现，v0.3.0 收尾时）
1. `/servers/:id` 详情端点曾因路由顺序**永远不可达**（列表分支无条件 return）→ 已把详情分支移到列表之前。
2. `test-host.mjs` 里有两条**假测试**（`async () => {}` 空跑、断言依赖前序副作用）→ 已重写成
   真跑 `index.js` 的 `makeExecutor`（缺字段 / 未知字段），并用同一 service 实例断言。
3. 闸门三个盲区（正斜杠 Windows 路径、纯字母数字密码、SSH 端口）→ 已补，并加 `scripts/gate-selftest.mjs`
   做对抗性自测（8 项：7 个应拦 + 7 个不该误伤）。
4. 版本号 0.2.0 → 0.3.0（package.json 与 client.js 之前没跟上）。
5. `package.json` 的 `files` 里删掉了不存在的 `docs`。

## 后续可做的事（按价值排序）

1. **推送仓库**（阻塞在代理 + 账号确认）
2. **补 GitHub Actions**：push 时自动跑 `publish-gate` + 三套自测（防止以后又把敏感东西带进来）
3. **截图脱敏后放回 README**：当前截图里有真实 IP/端口/主机名，已移出仓库（存到本地临时目录）。要做文档图就得先遮掉。
4. **密钥认证的端到端测试**：目前只测了「假私钥能入库+能脱敏」，没真用密钥连过一台。
5. **Windows DPAPI 支持**：现在主密钥和密文同目录，加上 DPAPI 能提升到「同机其他账户也读不出」。

## 关键约束（改代码前必读）

- `CONTRIBUTING.md` 的「铁律」：代码与数据分离、提交前必跑闸门、测试夹具必须运行时拼字符串。
- `client.js` **必须是经典脚本**（无 import/export），`test-client.mjs` 有一条静态闸门守着。
- 终端**必须黑底**，也是静态闸门守着的（`grep` `#0d1117`）。
- 样式只用 `--dsw-alias-*` 主题令牌（终端区例外）。

## 踩过的坑（别重犯）

| 坑 | 现象 | 解法 |
|---|---|---|
| 日志写在项目内 | 真实 IP 会跟着代码一起进仓库 | 数据统一放 `~/.dsh/ssh-ops/` |
| `exec_command(environment=...)` | 环境变量静默失效 | 内联进命令字符串 |
| PTY 不加 `PAGER=cat` | systemctl/git 跳分页器，命令卡死 | 必须配套设置一串 PAGER |
| `systemctl list-units` 字段错位 | 把 "running" 当服务名 | 加 `--plain` + 只取单字段 |
| compose 项目与容器重复 | 面板出现两行同名 | 有同名容器就不再另立项目行 |
| NAS 的 `lan` 字段是网段 | `192.168.0.0/24` 当 host 连不上 | 优先 `host`，否则从 `webui` 解析 |
| PowerShell 展开 `${}` | `Set-Content` 把 JS 模板字符串吃掉 | 用文件读写工具改代码，别用 PS 替换 |


## 遗留：旧凭证副本（主人要求保留，待其自行确认）

迁移前的副本仍在工作区的 `credentials\ssh-ops\`（`servers.json` + `master.key`，与新位置内容相同）。
**主人 2026-11-19 明确要求先保留**。注意：两份主密钥都能解密同一批凭证，多一个可被翻到的面；
确认新位置稳定后可删除。**不要自动删除它。**
