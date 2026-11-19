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

## 推送：已完成 ✅

| 项 | 结果 |
|---|---|
| 仓库 | https://github.com/lambsouls/dsh-ssh-ops （公开） |
| 分支 | `main`，跟踪 `origin/main` |
| 认证 | **SSH 密钥**（`~/.ssh/id_ed25519_github`，无密码短语，已加到 GitHub 账号） |
| remote | `git@github.com:lambsouls/dsh-ssh-ops.git` |
| 钩子 | `pre-commit` + `pre-push` 自动跑闸门，已在真实推送时生效过一次 |
| 内容 | 36 个文件，远端逐文件扫描确认零敏感信息 |

### 日常推送

```bash
git add -A
git commit -m "..."
git push          # 钩子会自动跑 publish-gate，不过就推不出去
```

### 换机器 / 新克隆后

```bash
node scripts/install-hooks.mjs    # 钩子是本地文件，不随仓库分发
```

### ⚠️ 这次踩过的坑（记下来别再犯）

1. **`ssh-keygen -N '""'` 在 PowerShell 里会把引号当成密码** —— 生成出来的私钥带 passphrase，
   表现为「GitHub 说 Server accepts key，但最终 Permission denied」，非常难查。
   正确写法：`$empty = ''; ssh-keygen -t ed25519 -f <file> -N $empty`。
   自查方法：`ssh-keygen -y -f <key>`，**5 秒内返回**才算无密码。
2. **GCM 的两个登录方式在这台机器上都不可用**：内嵌 WebView2 白屏（官网能上，是内嵌控件的问题）、
   `github login --device --no-ui` 不输出码直接挂住。**SSH 密钥是唯一走通的路。**
3. **HTTPS 直连极不稳定**（`github.com:443` 约五次通一次），但 **SSH 通道 3/3 稳定**。
   另外代理 `127.0.0.1:7890` 开着时 HTTPS 反而正常 —— 注意区分「直连被重置」和「有权限问题」。
4. **闸门漏过一条本机路径并真的推到了 GitHub**（首次推送后靠 API 复查才发现）：
   旧判据只查 `projects`/`credentials` 两个子目录，指向工作区临时目录的路径绕过了。
   已改成工作区路径**无条件拦**，并加回归用例。**教训：推送后仍要用 API 复查远端内容，别只信本地闸门。**
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

