# dsh-ssh-ops · 服务器运维台

> DSH（DeepSeek Harness）插件。集中保管 Linux 服务器凭证，按对话指令走 SSH 执行命令、巡检环境、
> 管理已装应用；同时在 Web 端提供**只读**的服务器总览与**实时彩色终端**。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![GitHub](https://img.shields.io/badge/GitHub-lambsouls%2Fdsh--ssh--ops-181717?logo=github)](https://github.com/lambsouls/dsh-ssh-ops)

## 它解决什么

把「一堆零散的 SSH 密码 + 每次都要手工敲 bash」变成一个托管能力：

| 你以前怎么干 | 现在 |
|---|---|
| 到处翻密码本、`ssh root@x.x.x.x -p yyyy` | `ssh_server_list` 拿 ID，直接说话 |
| 猜这台机器装了什么 | `ssh_server_env` 一次探完（系统/资源/服务/端口/应用） |
| 记不住 systemd 单元名、容器名 | 先探测，工具只对「已发现的应用」生效，不让你猜 |
| 改完不知道干了什么 | 每条命令的输入输出实时进终端，留痕可查 |
| 每次都要重新想「这台机器有什么坑」 | **每台机器一份档案**，共享 IP / 端口不对应 / 出网受限 / 什么不能碰都在里面 |

### 为什么要有「档案」

凭证记的是**怎么连**，探测记的是**此刻有什么**。但运维真正踩的坑往往不在这两者里：

- 这台机器和别人的机器**共享一个公网 IP**，我们只租到其中一段端口 → 对外端口和内部端口对不上，
  而这层映射在机器内部 `ss` 看不见（是接入侧转发的），**不问就永远推不出来**；
- 数据不在本地盘，在**网盘挂载**上 → 清缓存和清数据是两件事；
- 这台机器**出网被限**，拉不了 Docker Hub → 任何 `docker pull` 的想法都是错的；
- 某个服务是**别人在用的**，重启会把别人的东西一起打掉。

这些是**知识**，不是**状态**。状态每次探测都能重新得到，知识丢了就再也想不起来。
所以每台服务器有一份独立档案，出问题第一件事是翻它。

**一条硬规则**：档案里每条事实都带 `source` ——
`owner`（你亲口说的，最高权威，工具不会自动推翻）/ `probe`（工具实测，会随环境漂移）/
`agent`（模型推断，最低权威，被推翻就改）。模型自己写的一律标 `agent`，**不许冒充 `owner`**。

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
| `ssh_server_list` | 列出托管的服务器（不含任何凭证），附带档案摘要 | 无 |
| `ssh_server_register` | 登记/更新凭证（密码或私钥，AES-256-GCM 加密入库） | 写凭证库 |
| `ssh_server_env` | 一次连接拿环境画像 + 应用发现，结果回写 | 写凭证库（应用清单） |
| `ssh_server_profile` | **读这台机器的档案**（专属特征 / 端口映射 / 约束 / 处置 / 时间线 / 待确认） | 无 |
| `ssh_server_profile_save` | **建立或增量更新档案** | 写档案 |
| `ssh_server_profile_audit` | 体检：哪台没档案、哪份是孤儿、哪份写了凭证 | 无 |
| `ssh_server_exec` | 执行一条 `bash -lc` 命令 | **有**，命令实时上终端 |
| `ssh_app_control` | 对已发现应用做 status/start/stop/restart/reload/logs | **有** |
| `ssh_server_forget` | 删除服务器凭证（需 `confirm: true`） | 删除，不可撤销 |

面板侧还有一条 `PATCH /api/ssh-ops/servers/:id`，**只能改名字和标签**（见「界面」一节）。

### 档案里记什么

| 字段 | 记什么 | 例子 |
|---|---|---|
| `summary` / `role` | 这台机器是什么、要注意什么 | 「共享公网 IP，只租到部分端口」 |
| `traits` | 专属特征（network / storage / runtime / dependency / ownership…） | 「与别人共享 IP」「数据在网盘挂载」 |
| `portMap` | **只记对外端口与内部端口不一致的** | `:10207 → :5244 (openlist)` |
| `constraints` | 硬约束 / 不要碰的事 | 「不要 docker pull，拉不到镜像」 |
| `runbooks` | 出这个毛病时按这几步做 | 「离线更新镜像的完整步骤」 |
| `timeline` | 改动 / 事故 / 决定 | 「2026-11-19 升级 OpenList 到 v4.2.6」 |
| `openQuestions` | 还没确认、要问你的问题 | 「navidrome 的对外端口是多少？」 |

**写档案的口径**：只记确实知道的。不知道的写进 `openQuestions` 去问你，不要用「大概/可能」把档案污染成噪音。
列表项按 `id` 增量合并，同 `id` 传新值就是更新，所以可以一条一条补，不会覆盖已有内容。

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
  有档案的机器多一个 **`档案 ↗`** 按钮。
  展开看**名字/标签编辑区**、连接信息、标签胶囊、备注，以及应用清单
  （**用户应用平铺，系统自带服务折叠**）。

#### 档案为什么不在面板里铺开

档案记录的是「这台机器有什么脾气」——它是 **DSH 自己运维时读的知识**，对使用者多数时候不需要。
把特征、端口映射、约束、处置、待确认、时间线六七个分区塞进服务器行，视觉上就是一大坨，
而且每次展开都在挤占真正要看的东西（连接信息、应用清单）。

所以：行里只留一个 **`档案 ↗`** 按钮，点开在**新标签页**里看完整档案（独立页面，自包含、
深浅色自适应、带安全头）。**需要时看一眼，不需要时不占地方。**

> 页面地址是 `/api/ssh-ops/servers/<id>/profile`，只在**本机**可访问（Host/Origin 白名单 + fence），
> 返回的是 `text/html`，不联网、不加载任何外部资源。

**页面只读**：没有任何能改**服务器**的控件。写操作走对话；唯一例外是**名字与标签**
（见下），因为它们只影响本机显示。

### 名字与标签（面板上唯一能改的两样）

在服务器列表展开后点「编辑」，可以改：

- **名字** —— 面板与清单里显示的名字。留空会退回用地址显示。
- **标签** —— 逗号分隔（中英文逗号都认），会去重（大小写不同视为同一个）、最多 12 个、每个≤24 字。
  渲染成胶囊，用来分类和快速扫视。

它们**只改本机凭证库里的显示信息，不碰服务器**：地址、端口、用户名、凭证、id 全都不会变。
改了名字也不会动档案里的「角色定位」（那回答的是「这台机器是干什么的」，是另一回事）。

> 想改连接信息或凭证？那必须走对话里的 `ssh_server_register`。
> 面板能触发远程操作的控件一个都不会有 —— 这条边界是刻意的。

## 数据与代码的边界（重要）

这个仓库**只放代码**。用户数据一律在 `~/.dsh/ssh-ops/`，与代码目录彻底分离：

| 位置 | 内容 | 会进 git 吗 |
|---|---|---|
| `~/.dsh/ssh-ops/vault/servers.json` | 凭证库（元信息明文 + secrets 密文） | ❌ 不在仓库内 |
| `~/.dsh/ssh-ops/vault/master.key` | AES-256-GCM 主密钥 | ❌ 不在仓库内 |
| `~/.dsh/ssh-ops/vault/keys/*.pem` | 私钥临时落盘（仅密钥认证时） | ❌ 不在仓库内 |
| `~/.dsh/ssh-ops/profiles/<serverId>.json` | **服务器档案**（明文：这台机器独有的脾气、端口映射、约束） | ❌ 不在仓库内 |
| `~/.dsh/ssh-ops/logs/ops-console.ndjson` | 操作日志（已脱敏） | ❌ 不在仓库内 |
| 仓库目录 | 只有 `.js` / `.py` / `.md` / `.json` / 图标 | ✅ |

三处路径都可由插件 Config 覆盖（`vaultDir` / `logDir` / `profileDir`），**但不要指向仓库内部**。

**档案为什么明文、而且与凭证分开放**：凭证要加密、要谨慎；档案要**能直接读**——
出问题时第一件事是「翻档案」，不是「解密再翻」。它同样含真实 IP 与端口，所以照旧不进仓库。
两者以 `serverId` 为键解耦：改密码、换认证方式都不会丢档案。

### 三道检查，一道都不能省

```bash
node scripts/publish-gate.mjs --all   # ① push 前（钩子会自动跑）
git push                              # ② 推
node scripts/verify-remote.mjs        # ③ push 后 —— 扫 GitHub 上的真实内容，必须手动
```

`publish-gate` 检查：敏感路径被跟踪、真实公网 IP、本机绝对路径、私钥块、密码字面量、
token 形状、SSH 端口、**真实 serverId**、仓库目录里存在运行时数据。
**任何一条命中就 `STATUS: BLOCK` 并非零退出。**

> ⚠️ **闸门 `STATUS: OK` 不等于没泄漏。** 它只查已知的几个模式，查不出「你这次改动引入的问题」。
> 真实案例：加完功能后闸门两次 OK，人工复审仍发现三类问题（公开面写回私人称呼、
> 公开文档写进真实 serverId、locale 文案没跟上新功能）。
> 所以推送前还要做一步人级复审 —— 判据一句话：**闸门守「字符串长什么样」，人守「这句话该不该公开」。**

> **serverId 已经泄露出去了？** `force-push` 消不掉（GitHub 保留不可达对象，用 SHA 仍能访问）。
> 用 `scripts/reassign-id.mjs` 作废它 —— 旧标识从此不指向任何真实数据。见 `MAINTAINING.md` §6.2。

`verify-remote` 走 GitHub API 把远端文件逐个下载回来，用**同一套判据**（`lib/gate-rules.mjs`）再扫一遍；
另外核对本地与远端 HEAD 是否一致、扫 commit message、并在有文件没读到时判定「复查不完整」。
退出码 `0` 干净 / `1` 有问题 / `2` 没查成 —— **`2` 不算通过。**

> **为什么推完还要查：** 本地闸门只查它知道的模式。判据有洞时本地永远 OK ——
> 首次推送时真实发生过一次（判据只查两个子目录，一条临时目录路径漏网并进了远端）。
> **推完不复查 ＝ 没检查过。**

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
# 合计 197 项
node test-host.mjs       # 32 项：加密/脱敏/凭证库/日志/探测解析/工具契约/参数校验
node test-profile.mjs    # 25 项：档案归一化/增量合并/删除/一致性/渲染/文件边界
node test-identity.mjs   # 35 项：改名/标签的改动面（重点测「除此之外什么都没变」）
node test-reassign.mjs   # 19 项：换 serverId 后凭证库与档案是否仍对得上
node test-profile-page.mjs # 31 项：档案页面内容完整 + HTML 转义（防 XSS）
node test-ansi.mjs       # 14 项：ANSI 解析（颜色/256色/真彩/跨行继承）
node test-client.mjs     # 25 项：客户端静态闸门 + 真渲染（假 React + vm 跑组件）
node scripts/gate-selftest.mjs  # 16 项：证明发布闸门真能拦、且不误伤合法代码

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
  profile.js        ★ 服务器档案（每台机器独有的运维知识，明文）
  redact.js         双保险脱敏
  journal.js        操作日志（环形缓冲 + NDJSON，写盘前脱敏）
  ssh.js            Node → Python 桥（凭证走 stdin）
  ssh_exec.py       paramiko 执行器（PTY + NDJSON 事件流）
  probe.js          环境/应用探测脚本与解析
  service.js        编排：执行、探测、应用控制、档案读写
  tools.js          9 只工具定义
  ansi.js           ANSI 解析（模型侧去色 / 面板侧上色）
  gate-rules.mjs    闸门判据（本地与远端共用唯一真源）
  http.js           小工具
  server-api.js     只读 REST + SSE
scripts/
  publish-gate.mjs        发布闸门（本地：IP / 本机路径 / 私钥 / 密码 / token / SSH 端口）
  verify-remote.mjs       远端复查（push 后扫 GitHub 上的真实内容，同一套判据）
  gate-selftest.mjs       闸门的对抗性自测（证明它真能拦）
  install-hooks.mjs       装 pre-commit / pre-push 钩子（闸门变硬拦截）
  verify-no-plaintext.mjs 凭证明文闸门
  import-credentials.mjs  从外部 JSON 批量导入
  migrate-data-dir.mjs    把旧位置数据搬进 ~/.dsh/ssh-ops
  reassign-id.mjs         给一台服务器换 serverId（旧标识已泄露时作废它）
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









