# HANDOFF · 交接说明

> 这份文档给**下一个会话**（或未来的我）看：不用读整段对话也能接着干。
> 最后更新：2026-11-19

## 一句话现状

`dsh-ssh-ops`（服务器运维台）**v0.5.0**：开发完成，已用真实服务器验收过 SSH 执行、应用发现、
应用控制与档案落盘；本版新增 **每台服务器独立档案**（共享 IP / 端口不对应 / 出网受限 / 什么不能碰这类
「机器内部查不到、丢了想不起来」的知识），工具从 6 只增到 9 只；并给面板开了
**唯一一个写入口：改名 / 改标签**（只碰本机元信息，不碰服务器）。
git 仓库已初始化并完成首次提交，工作区干净、内容零敏感数据；仓库已推送到 GitHub。

> **本文件是公开面的一部分**（随仓库推到 GitHub）。所以这里只写「对任何 clone 的人都成立」的内容：
> 架构为什么这样、改哪里、怎么验证、有哪些坑。
> **本机环境事实（哪几台机器、真实 ID、本机路径、维护者偏好）不放这里**——
> 那些在维护者本地的私密交接里，不随仓库分发。

## v0.5.0 做了什么（名字 / 标签可自定义）

起因：用户指出「用户可以自定义服务器名称和 Tags，这些对模型不重要，但会影响使用体验」。
原设计是面板全只读，理由是「面板一能写 = 带 root 权限的 web 控制台」——
那句话针对的是**能触发远程操作**的面板。改名/改标签只改本机凭证库，所以开了这个口子。

| 层 | 做什么 | 守什么 |
|---|---|---|
| `client.js` `IdentityEditor` | 面板上两个输入框，Enter 保存 / Esc 取消 | 只提交 name + tags 两个键 |
| `server-api.js` `PATCH /servers/:id` | 唯一的写端点 | 多传字段 → 400；其它动词 → 405；缺 fence → 403 |
| `service.js` `renameServer` | 白名单准入 + 写日志留痕 | `new Set(['name','tags'])`，多一个就报错 |
| `vault.js` `setIdentity` | 只写 name/tags | **不碰 id/host/port/user/secrets**；空名字退回 host |

**为什么不复用 `upsert`**：它要求 host/user 必填，用它改名会把连接信息一起回传，
一旦传错就可能**改掉地址**（后果是「你以为在操作 A 机，其实连到 B 机」）。
写入口的参数要窄到「传错了也不会出事」。

**改名不碰档案里的 `role`**：名字是「它叫什么」，role 是「它是干什么的」，两回事。

**测试重点**（`test-identity.mjs` 35 项）：不是「改成功了」，是「除此之外什么都没变」——
地址、端口、用户名、`secrets` 密文、notes、apps、id 逐项断言未被改动。

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
  profiles/<id>.json   ★ 服务器档案（明文；每台机器的独有脾气，不含凭证）
  logs/ops-console.ndjson  操作日志（已脱敏，含真实 IP，所以不进仓库）
```

- 由 `lib/paths.js` 决定，可被插件 Config 的 `vaultDir` / `logDir` / `profileDir` 覆盖。
- **不要**把这些指向仓库内部 —— v0.2.x 就是这么把日志写进项目、差点连真实 IP 一起推上去的。
- **档案是明文且不加密**（故意的）：出问题时第一步是 `grep` 档案，不是解密。理由见 MAINTAINING §1.4。

## v0.4.0 做了什么（服务器档案）

起因：用户指出「每台服务器可能都有类似共享 ip、端口不对应这种专属特点，需要给每台服务器自己的档案」。
设计要点：

| 点 | 做法 | 为什么 |
|---|---|---|
| 独立文件 | `profiles/<serverId>.json`，按 serverId 与凭证解耦 | 改密码/换认证方式不该丢档案 |
| 明文 | 不加密 | 排查时要能直接读；它本就不含密码 |
| 每条事实带 `source` | `owner` / `probe` / `agent`，默认 **agent** | 分清「用户说的 / 实测的 / 我推断的」；模型不许冒充 owner |
| 只报告不自动改 | 探测到漂移只提示，不写档案 | 档案是知识、探测是状态；「别人动过」和「记错了」处理方式相反 |
| 增量合并 | 按 id upsert，null 不覆盖，替换语义禁用 | 档案的价值全在积累，一次误覆盖就清零 |

工具：`ssh_server_profile`（读）/ `ssh_server_profile_save`（写）/ `ssh_server_profile_audit`（体检）。

档案的价值要靠**真实使用**才显现出来：给一台「共享公网 IP、对外端口与内部端口不对应」的机器建档后，
后续会话不用再靠扫描或猜测去确认对外地址——档案里直接写着答案，以及「不要扫」这条约束。
`_audit` 能一次查出三类问题：有凭证没档案、有档案没凭证（孤儿）、档案里居然写了凭证。

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
git push                     # 钩子自动跑 publish-gate，不过就推不出去
node scripts/verify-remote.mjs   # ← 推完必须跑！扫 GitHub 上的真实内容
```

**为什么推完要再查一遍：** 本地闸门只查「它知道的模式」。判据有洞时本地永远 OK —— 首次推送时
就发生过（工作区路径判据只查两个子目录，一条临时目录路径漏网并真的推了上去）。
**推完不复查 ＝ 没检查过。**

`verify-remote` 退出码三档：`0` 干净 / `1` 发现问题 / `2` 没查成。**`2` 不算通过。**

### 换机器 / 新克隆后

```bash
node scripts/install-hooks.mjs    # 钩子是本地文件，不随仓库分发
```

### ⚠️ 这次踩过的坑（记下来别再犯）

1. **`ssh-keygen -N '""'` 在 PowerShell 里会把引号当成密码** —— 生成出来的私钥带 passphrase，
   表现为「GitHub 说 Server accepts key，但最终 Permission denied」，非常难查。
   正确写法：`$empty = ''; ssh-keygen -t ed25519 -f <file> -N $empty`。
   自查方法：`ssh-keygen -y -f <key>`，**5 秒内返回**才算无密码。
2. **Git Credential Manager 的两条图形登录路不一定可用**：内嵌 WebView2 可能白屏（官网能上、
   是内嵌控件的问题）；`github login --device --no-ui` 在某些版本上不输出码直接挂住。
   遇到这种情况，**SSH 密钥是最稳的一条路**（见下条的经验）。
3. **HTTPS 直连可能极不稳定**（`github.com:443` 时通时不通），而 **SSH 通道通常稳定**。
   另外如果本机开着代理，HTTPS 反而可能正常 —— 注意区分「直连被重置」和「有权限问题」。
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


## 遗留：旧凭证副本（维护者要求保留，待其自行确认）

迁移前的副本仍在工作区的 `credentials\ssh-ops\`（`servers.json` + `master.key`，与新位置内容相同）。
**维护者 2026-11-19 明确要求先保留**。注意：两份主密钥都能解密同一批凭证，多一个可被翻到的面；
确认新位置稳定后可删除。**不要自动删除它。**

