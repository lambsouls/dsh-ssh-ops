# 维护手册 · dsh-ssh-ops（服务器运维台）

> **给新会话的我：先读完这一页再动手。**
> 这份文件是为「原对话已归档 / 被删除，你完全没有上下文」这种情况写的。
> 它不讲客套，只讲：这是什么、在哪儿、怎么改、**哪些事必须先问主人**。
>
> 最后更新：2026-11-19（首次建档）

---

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 这是什么 | DSH 插件。保管 Linux 服务器凭证、走 SSH 执行命令与管理应用、提供只读总览 + 实时彩色终端 |
| 代码在哪 | 本文件所在目录（仓库根） |
| 远端仓库 | https://github.com/lambsouls/dsh-ssh-ops （**公开**） |
| 安装形态 | desktop profile 里 `link:` 指向本仓库；改代码 + 重载插件即生效 |
| **用户数据在哪** | `~/.dsh/ssh-ops/`（**不在仓库里**，也**不许**进仓库） |
| 当前状态 | v0.3.0，运行中，3 台服务器 / 86 个应用，76 项自测全过 |

---

## 1. 第一件事：确认你还认得这台机器

新会话开场，按顺序跑（都是只读）：

```powershell
# 1) 插件还活着吗
Invoke-WebRequest -Uri 'http://127.0.0.1:10162/api/ssh-ops/health' -Headers @{'x-ssh-ops'='1'} -UseBasicParsing

# 2) 仓库干净吗
cd <仓库根>; git status --short; git log --oneline -3

# 3) 自测还绿吗（76 项）
node test-host.mjs; node test-ansi.mjs; node test-client.mjs; node scripts\gate-selftest.mjs

# 4) 本地闸门
node scripts\publish-gate.mjs --all
```

四项都正常 → 环境健康，可以进入「要做什么」的判断。
有任何一项失败 → **先修环境，别动功能**。

---

## 2. 主人交代过的事（按优先级）

### 🔴 红线级（违反＝事故）

1. **Issues 不许自己回、不许自己改代码。**
   主人原话：「Issues 你最好还是先问问我，不要自己直接决定回复和修改」。
   ⇒ 发现 Issue → **先汇总给我看，等指示**。哪怕问题很明显、改起来只有一行，也不许先动手。
   详见第 4 节。

2. **凭证与用户数据绝不许进仓库。**
   数据在 `~/.dsh/ssh-ops/`。仓库目录里出现 `vault/`、`keys/`、`.runtime/`、`*.ndjson`、`*.pem`、`master.key`
   就是事故，立即停止并报告。

3. **不许在回复、日志、命令回显里出现密码 / 私钥 / passphrase。**
   一律写 `******`。

4. **破坏性操作先问主人**：删数据、停机、改网络/防火墙、动数据库、升级系统、清理容器。

### 🟡 每次推送都必须做（主人明确要求）

> 主人原话：「每次推完，需要在 GitHub 上浏览审查一遍敏感信息，复测有没有意外泄露」

```powershell
node scripts\publish-gate.mjs --all   # ① push 前
git push                              # ② 推
node scripts\verify-remote.mjs        # ③ push 后 ← 必须手动，钩子触发不了这个时机
```

**第 ③ 步不做 ＝ 没检查过。** 原因见第 6 节「为什么推完还要查」。

### 🟢 主人的项目偏好

- **面板只读**：服务器总览与控制台**不能有任何能改服务器的控件**。写操作只走对话工具。
  这是主人 2026-11-19 明确要求的（「不该让用户能直接操作，只能看」）。
- **控制台开在对话框右侧**（右侧栏 tab），不是只放插件页。会话开始自动打开。
- **终端黑底 + ANSI 真彩**：终端是全页唯一不跟随主题的区域。飞书、GitHub 的绿、目录的蓝都要显示。
- 系统自带服务要**折叠**，不能混在用户应用里（NAS 上有 63 个系统服务）。
- 中文交流。代码/命令/文件名保留原文。

---

## 3. 代码结构（改哪里）

```
index.js              Host 半：注册 6 只工具、注入运维纪律、挂 REST 面
client.js             Web 端：右侧栏 tab + 主面板（**经典脚本，无 import/export**）
lib/
  paths.js            ★ 数据落点（唯一真源）：~/.dsh/ssh-ops
  crypto.js           AES-256-GCM
  vault.js            凭证库（元信息 + 密文）
  redact.js           双保险脱敏
  journal.js          操作日志（环形缓冲 + NDJSON，写盘前脱敏）
  ssh.js              Node → Python 桥（凭证走 stdin）
  ssh_exec.py         paramiko 执行器（PTY + NDJSON 事件流）
  probe.js            环境/应用探测脚本与解析
  service.js          编排：执行、探测、应用控制
  tools.js            6 只工具定义
  ansi.js             ANSI 解析（模型侧去色 / 面板侧上色）
  gate-rules.mjs      ★ 闸门判据（本地与远端共用，唯一真源）
  http.js             小工具
  server-api.js       只读 REST + SSE
scripts/
  publish-gate.mjs        本地闸门
  verify-remote.mjs       远端复查（push 后）
  gate-selftest.mjs       闸门对抗性自测（证明它真能拦）
  install-hooks.mjs       装 pre-commit / pre-push 钩子
  verify-no-plaintext.mjs 凭证明文闸门
  import-credentials.mjs  从外部 JSON 导入
  migrate-data-dir.mjs    搬数据目录
  check-issues.mjs        ★ Issues 检查（**只读**，见第 4 节）
```

**6 只工具**（名字即契约，改名会破坏主人的使用习惯）：
`ssh_server_list` / `ssh_server_register` / `ssh_server_env` / `ssh_server_exec` /
`ssh_app_control` / `ssh_server_forget`

---

## 4. 处理 Issues 的正确姿势（重点）

### 主人明确要求

> 「Issues 你最好还是先问问我，不要自己直接决定回复和修改」

### 所以你该做的

```powershell
# 只读检查，列出新 Issue（不回复、不打标签、不改代码）
node scripts\check-issues.mjs
```

然后**把结果整理成人话汇报给主人**，格式建议：

```
本地的新 Issue（共 N 条）：

#3  [bug] 连不上 Ubuntu 24.04 的机器
    提交者：someone · 2 天前
    摘要：（两三句说清楚他遇到什么）
    我的判断：可能是 xxx 原因，改起来大概涉及 lib/xxx.js
    需要你定：要不要回？要不要改？改到什么程度？
```

### 你绝对不能做的

- ❌ 直接 `gh issue comment` / API 回复
- ❌ 直接开分支改代码然后说「已修复」
- ❌ 给 Issue 打标签、关闭、assign
- ❌ 自作主张判断「这是用户误用，不用管」然后跳过不报

### 例外情况

**只有主人明确说「这条你处理吧」/「去回他」/「按他说的改」之后**，才可以动手。
即便那时，也要：
1. 先在本地改 + 自测通过 + 闸门过了
2. 把「准备怎么回、改了什么」给主人看一眼
3. 主人点头后才推 + 回复

> 如果 `check-issues.mjs` 需要 token 才能看私有信息也别慌 —— 本仓库是**公开**的，
> 公开仓库的 Issue 列表匿名可读。限流了就等一会儿，或用第 6 节说的 git 思路绕。

---

## 5. 改完代码的验收清单

```powershell
# 1) 自测（76 项，必须全绿）
node test-host.mjs        # 25 项
node test-ansi.mjs        # 14 项
node test-client.mjs      # 11 项
node scripts\gate-selftest.mjs  # 9 项（闸门对抗性自测）
node --check client.js; node --check index.js
python -c "import py_compile; py_compile.compile(r'lib\ssh_exec.py', doraise=True)"

# 2) 闸门
node scripts\publish-gate.mjs --all     # 必须 STATUS: OK

# 3) 重载插件（改 client.js 或 index.js 后必须做）
#    用 plugin_manager: set_plugin include:dsh-ssh-ops → enabled:false，再 → true
#    （不是重启 DSH）

# 4) 真机验证（改了 SSH/探测/应用控制相关时）
#    用 ssh_server_list 拿 ID，跑 ssh_server_env / ssh_server_exec 看真实输出

# 5) 推 + 推后复查
git add -A; git commit; git push
node scripts\verify-remote.mjs          # 必须 STATUS: OK
```

### 重载插件的坑

`plugin_manager` 的 `set_plugin` 需要**精确的 entryId**：`include:dsh-ssh-ops`（不是 `dsh-ssh-ops`）。
传错会报 `unknown-plugin`。

---

## 6. 为什么推完还要查一遍（别省这步）

本地闸门只查「它知道的模式」。**判据本身有洞时，本地永远显示 OK。**

这不是假设 —— 真实发生过：闸门的工作区路径判据只查 `projects`/`credentials` 两个子目录，
于是一条指向临时目录的路径绕过去了，**在首次推送时真的进了 GitHub 上的 `HANDOFF.md`**。
事后靠「拿远端真实内容再扫一遍」才发现。

规矩：**推完不复查 ＝ 没检查过。**

`verify-remote.mjs` 还额外查三件：
1. 本地/远端 HEAD 一致（防「本地改好了但没推上去」，那时扫的是旧代码）
2. commit message（**提交历史也是公开面**）
3. 扫描完整性（有文件没读到 → `INCOMPLETE_SCAN`，判定不通过）

**退出码三档**：`0` 干净 / `1` 有问题 / `2` 没查成。**`2` 不算通过。**

---

## 7. 已验证过的事实（别重复踩）

| 事实 | 说明 |
|---|---|
| **HTTPS 直连 github.com:443 极不稳** | 约五次通一次（`Recv failure: Connection was reset`） |
| **SSH 通道稳** | `github.com:22` 与 `ssh.github.com:443` 各 3/3 通 |
| **推送走 SSH** | remote 是 `git@github.com:lambsouls/dsh-ssh-ops.git`，密钥 `~/.ssh/id_ed25519_github` |
| **GitHub API 匿名限流 60 次/小时** | 扫一次仓库就见底。`verify-remote` 默认走 `git fetch`+`git show`，零配额 |
| **GCM 图形登录在这台机器不可用** | 内嵌 WebView2 白屏；`--device --no-ui` 挂住。**别再去试**，SSH 密钥是唯一路 |
| **`ssh-keygen -N '""'` 在 PowerShell 会生成带密码的私钥** | 现象是「Server accepts key 但 Permission denied」。自查：`ssh-keygen -y -f <key>` 5 秒内返回才算无密码 |
| **PTY 必须配 `PAGER=cat` 系列** | 否则 systemctl/git 跳分页器，命令卡死 |
| **`exec_command(environment=...)` 无效** | 依赖服务端 `AcceptEnv`，多数机器静默丢弃。环境变量要内联进命令 |
| **PTY 下 stderr 并入 stdout** | 终端语义限制，不是 bug |
| **PowerShell 会展开 `${}`** | 用 `Set-Content` 改 JS 模板字符串会把内容吃掉。**改代码用 read/write/edit 工具，别用 PS 替换** |

---

## 8. 数据与凭证

### 位置（不在仓库里）

```
~/.dsh/ssh-ops/
  vault/servers.json   凭证库（元信息明文 + secrets 密文）
  vault/master.key     AES-256-GCM 主密钥
  vault/keys/*.pem     私钥临时文件（仅密钥认证时）
  logs/ops-console.ndjson  操作日志（已脱敏，但**含真实服务器 IP**）
```

### 已知遗留

**工作区的 `credentials\ssh-ops\` 还有一份旧副本**（迁移前的位置）。
主人 2026-11-19 明确说**先保留、自己确认后再删**。**不许自动删除。**

### 安全边界（别夸大）

主密钥和密文同目录。它挡的是「翻到密文也读不出明文」「误把密文贴给别人」，
**不挡**能读你用户目录的本机攻击者。真正的隔离靠操作系统账户。
要更强就接 DPAPI / 系统密钥库（待办里有）。

---

## 9. 待办（按价值排序）

1. **GitHub Actions**：push 时自动跑闸门 + 自测 + **`verify-remote`**，
   防的是「有人绕过本地钩子」（钩子不随仓库分发，别人 clone 下来是没有的）
2. **密钥认证端到端测试**：目前只测了「假私钥能入库 + 能脱敏」，没真用密钥连过一台机器
3. **Windows DPAPI 支持**：把主密钥保护提升到「同机其他账户也读不出」
4. **截图脱敏回 README**：当前截图含真实 IP/端口，已移出仓库。要做文档图得先遮掉

---

## 10. 遇到不确定的事怎么办

**问主人。** 这不是偷懒，是这些场景里唯一正确的动作：

- Issue 要不要回、要不要改 → **必须问**（主人明确要求）
- 要不要动 `credentials\ssh-ops\` 那份旧副本 → **必须问**
- 某个操作有没有破坏性 → 拿不准就问
- 想加一个主人没要求的功能 → 先提方案，别直接做

**主人不喜欢的事**（历史教训）：
- 说「接受现状」「这是上游限制，没办法」（规矩 43：必须给出下一步能动的动作）
- 长任务「汇报完就停」（规矩 36：保持有 in_progress，除非真的完成或需要决策）
- 编造数据、谎报完成

---

## 附：这份文件在哪

仓库根的 `MAINTAINING.md`

它**会随仓库推送到 GitHub**（内容是通用的维护知识，不含任何敏感信息）。
如果你在别的机器 clone 下来，照样能照着做 —— 只是那台机器上没有主人的服务器数据。


---

## ⚠️ 认准仓库：GitHub 上有**另一个同名仓库**

`caoyiwei850/dsh-ssh-ops` 与本项目**同名但不是本项目**（2026-08-15 建，59 star，4 个开放 issue）。
描述也几乎一样（「DeepSeek Harness SSH 运维插件」），极易认错。

### 怎么确认是「我们」

| 判据 | 我们 | 别人 |
|---|---|---|
| 全名 | `lambsouls/dsh-ssh-ops` | `caoyiwei850/dsh-ssh-ops` |
| git remote | `git@github.com:lambsouls/dsh-ssh-ops.git` | — |
| 创建时间 | 2026-11-19 | 2026-08-15 |
| 工具集 | **6 只**：`ssh_server_list` / `ssh_server_register` / `ssh_server_env` / `ssh_server_exec` / `ssh_app_control` / `ssh_server_forget` | 有 `sftp_delete` / `ssh_terminal_*` / `ssh_session_log_read` 等，**不是我们的** |
| 版本线 | 0.3.x | 0.4.5+ |

### 铁律

**先 `git remote get-url origin` 确认 owner 是 `lambsouls`，再动任何 Issue。**
看到 `sftp_delete`、`ssh_terminal_sessions` 这类工具名 → **不是我们的项目，立刻停手并报告主人**。

另外 DSH 本体仓库（`deepseek-ai/dsh-desktop`）里提到 `dsh-ssh-ops` 的 issue 也不是本项目的 issue。

> 这条是 2026-11-19 由一次无上下文接手的验证中发现的。当时子代理正确识别出了这个陷阱 ——
> 说明写清楚「怎么认准自己」和写清楚「该做什么」一样重要。
