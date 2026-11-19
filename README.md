# dsh-ssh-ops · 服务器运维台

> DSH（DeepSeek Harness）插件。集中保管 Linux 服务器凭证，按对话指令走 SSH 执行命令、巡检环境、
> 管理已装应用；同时在 Web 端提供**只读**的服务器总览与**实时彩色终端**。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 它解决什么

把「一堆零散的 SSH 密码 + 每次都要手工敲 bash」变成一个托管能力：

| 你以前怎么干 | 现在 |
|---|---|
| 到处翻密码本、`ssh root@x.x.x.x -p yyyy` | `ssh_server_list` 拿 ID，直接说话 |
| 猜这台机器装了什么 | `ssh_server_env` 一次探完（系统/资源/服务/端口/应用） |
| 记不住 systemd 单元名、容器名 | 先探测，工具只对「已发现的应用」生效，不让你猜 |
| 改完不知道干了什么 | 每条命令的输入输出实时进终端，留痕可查 |

## 安装

```bash
# 在插件目录里
dsh plugin --profile <你的 profile> add /绝对路径/到/dsh-ssh-ops

# 或按 DSH 的方式，在 profile 的 package.json 用 link:
# "dsh-ssh-ops": "link:/path/to/dsh-ssh-ops"
```

依赖：
- **Node ≥ 20**（用到 `node:fs` 的 `cpSync`、ESM）
- **Python 3 + paramiko**（远端执行走 Python 子进程）：`pip install paramiko`
- 想固定解释器，就在插件 Config 里写 `pythonPath`；否则依次用 `$SSH_OPS_PYTHON` / `$PYTHON` / PATH 里的 `python`。

## 工具

| 工具 | 作用 | 副作用 |
|---|---|---|
| `ssh_server_list` | 列出托管的服务器（不含任何凭证） | 无 |
| `ssh_server_register` | 登记/更新凭证（密码或私钥，AES-256-GCM 加密入库） | 写凭证库 |
| `ssh_server_env` | 一次连接拿环境画像 + 应用发现，结果回写 | 写凭证库（应用清单） |
| `ssh_server_exec` | 执行一条 `bash -lc` 命令 | **有**，命令实时上终端 |
| `ssh_app_control` | 对已发现应用做 status/start/stop/restart/reload/logs | **有** |
| `ssh_server_forget` | 删除服务器凭证（需 `confirm: true`） | 删除，不可撤销 |

## 界面

**两个入口，同一份数据**：

| 入口 | 说明 |
|---|---|
| **右侧栏 tab「🖧 运维」** | 贴在对话右边，边聊边看。会话开始后自动打开（可关） |
| **主面板「服务器运维台」** | 侧栏图标点进去，占满中央区域 |

两个页面都有「终端 / 服务器」两个页签：

- **终端**：**黑底**（`#0d1117`，全页唯一不跟随主题的区域 —— 终端就该是黑的）+ ANSI 真彩。
  `systemctl status` / `docker ps` / `ls --color` / `git diff` 的红绿蓝黄、256 色、真彩全部原样显示；
  输入行绿字加粗、stderr 橙、失败红、连接信息蓝。可过滤、可清空视图、开关折行、开关自动跟随。
- **服务器**：每台一行，`用户@地址:端口`、可达状态、应用数量（`5 个应用 +63` 的 +63 是系统服务数）。
  展开看认证方式、系统、最近使用、标签、备注，以及应用清单（**用户应用平铺，系统自带服务折叠**）。

**页面全只读**：没有任何能改服务器的控件。写操作只有一条路——在对话里说。

## 数据与代码的边界（重要）

这个仓库**只放代码**。用户数据一律在 `~/.dsh/ssh-ops/`，与代码目录彻底分离：

| 位置 | 内容 | 会进 git 吗 |
|---|---|---|
| `~/.dsh/ssh-ops/vault/servers.json` | 凭证库（元信息明文 + secrets 密文） | ❌ 不在仓库内 |
| `~/.dsh/ssh-ops/vault/master.key` | AES-256-GCM 主密钥 | ❌ 不在仓库内 |
| `~/.dsh/ssh-ops/vault/keys/*.pem` | 私钥临时落盘（仅密钥认证时） | ❌ 不在仓库内 |
| `~/.dsh/ssh-ops/logs/ops-console.ndjson` | 操作日志（已脱敏） | ❌ 不在仓库内 |
| 仓库目录 | 只有 `.js` / `.py` / `.md` / `.json` / 图标 | ✅ |

两处路径都可由插件 Config 覆盖（`vaultDir` / `logDir`），**但不要指向仓库内部**。

发布前跑一次闸门：

```bash
node scripts/publish-gate.mjs        # 有 .git 时检查「已跟踪文件」
node scripts/publish-gate.mjs --all  # 不管 git，扫全目录
```

它检查五项：敏感路径被跟踪、真实公网 IP、本机绝对路径、私钥块/密码字面量/token 形状、
仓库目录里存在运行时数据。**任何一条命中就 `STATUS: BLOCK` 并非零退出。**

> `.gitignore` 只是最后一道网，不是保障。真正的保障是数据根本不在仓库目录里。

## 安全模型

### 存储
- 元信息（名字/地址/端口/用户名/认证方式/应用清单/备注）明文；**密码、私钥、passphrase 是 AES-256-GCM 密文**。
- ⚠️ **别夸大这条边界**：主密钥和密文在同一个目录，它挡的是「翻到密文也读不出明文」和
  「误把密文贴给别人」，**不挡能读你用户目录的本机攻击者**。真正的隔离靠操作系统账户。
  要更强就接 DPAPI / 系统密钥库。

### 传输
- 凭证**只走子进程 stdin**，不出现在命令行参数里（`ps` / 进程列表看不到）、不进任何日志。
- 每次操作是一条独立 SSH 会话，用完即关，不留后台连接。

### 脱敏（落盘前完成）
`lib/redact.js` 两层：
1. 已知凭证值精确替换（密码 / 私钥全文 / passphrase / 私钥的每一行）；
2. 模式兜底：PEM 私钥块整段、`sshpass -p`、`password=`/`passwd:`/`pwd=`、`Bearer`、`sk-*`、`ghp_*`、`AKIA*`。

`ops-console.ndjson` 里不存在明文凭证。

### 颜色通道（两条出口，一个源头）
远端输出只抓一次，然后分成两路：

| 去处 | 处理 | 理由 |
|---|---|---|
| **控制台日志**（面板用） | **保留** ANSI 码 | 面板要真的五颜六色 |
| **返回给模型** | `stripAnsi()` 去掉 | 模型不需要 `\x1b[32m`，留着纯噪音还烧 token |

怎么让远端吐颜色：SSH 申请 **PTY**（`get_pty=True`），并内联 `TERM=xterm-256color`、
`COLORTERM=truecolor`、`PAGER=cat`、`SYSTEMD_PAGER=cat`、`GIT_PAGER=cat`、`SYSTEMD_COLORS=1`。

⚠️ **PTY 的两个副作用，必须知道**：
1. **stderr 会并进 stdout**（终端只有一个流），所以控制台里分不出「stderr 通道」，只能靠颜色；
2. **命令会以为自己在交互式终端** → 分页器（less/more）会跳出来等按键，非交互场景等于卡死。
   所以上面那串 `PAGER=cat` 是**必须的**，不是可选优化。

`exec_command(environment=...)` 不能用：它依赖服务端 `AcceptEnv` 白名单，绝大多数机器默认拒收，会静默失效。

**ANSI 支持范围**：SGR 30-37 / 90-97 / 40-47 / 100-107、1/2/3/4/7 与对应的关闭码、256 色（`38;5;n`）、
真彩（`38;2;r;g;b`）。光标移动、清屏、OSC 标题等序列直接丢弃 —— 控件不是真终端。

## 自测

```bash
node test-host.mjs       # 25 项：加密/脱敏/凭证库/日志/探测解析/工具契约/参数校验
node test-ansi.mjs       # 14 项：ANSI 解析（颜色/256色/真彩/跨行继承）
node test-client.mjs     # 11 项：客户端静态闸门（必须经典脚本/终端必须黑底/只用主题令牌）
node scripts/gate-selftest.mjs  # 8 项：证明发布闸门真能拦、且不误伤合法代码

# 真连一台（会读你给的凭证文件，但只取 host/port/user/password，不打印）
node test-live.mjs --cred /path/to/cred.json
```

## 目录

```
index.js            Host 半：注册工具、注入运维纪律、挂 REST 面
client.js           Web 端：右侧栏 tab + 主面板（经典脚本，CJS factory）
lib/
  paths.js          数据落点（~/.dsh/ssh-ops）
  crypto.js         AES-256-GCM 封/envelope
  vault.js          凭证库（元信息 + 密文）
  redact.js         双保险脱敏
  journal.js        操作日志（环形缓冲 + NDJSON，写盘前脱敏）
  ssh.js            Node → Python 桥（凭证走 stdin）
  ssh_exec.py       paramiko 执行器（PTY + NDJSON 事件流）
  probe.js          环境/应用探测脚本与解析
  service.js        编排：执行、探测、应用控制
  tools.js          6 只工具定义
  ansi.js           ANSI 解析（模型侧去色 / 面板侧上色）
  http.js           小工具
  server-api.js     只读 REST + SSE
scripts/
  publish-gate.mjs        发布闸门（IP / 本机路径 / 私钥 / 密码 / token / SSH 端口）
  gate-selftest.mjs       闸门的对抗性自测（证明它真能拦）
  install-hooks.mjs       装 pre-commit / pre-push 钩子（闸门变硬拦截）
  verify-no-plaintext.mjs 凭证明文闸门
  import-credentials.mjs  从外部 JSON 批量导入
  migrate-data-dir.mjs    把旧位置数据搬进 ~/.dsh/ssh-ops
```

## 已知限制

- **应用控制只对已登记的应用生效**：先 `ssh_server_env` 让它被发现，否则工具会报「没登记应用」并列出已知的。
  这是故意的——不让模型猜服务名去启停。
- **docker-compose 动作需要 `composeDir`**：容器名与项目名同名的单容器栈，探测时已把 manager 标成
  `docker-compose`，但目录仍需显式给（探测脚本不推断目录）。
- **systemd 归类靠启发式**：常见应用认得出，认不出的归「系统自带服务」。只影响显示分组，不影响能不能管。
- **PTY 下 stderr 并入 stdout**：见上，是终端语义限制，不是 bug。
- **控制台不是交互式 shell**：只回放已执行过的操作，不能在里面敲命令。

## License

MIT



