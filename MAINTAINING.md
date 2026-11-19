# 开发与维护指南 · dsh-ssh-ops

> 面向：**fork 这个项目的人**、**想改着用的人**、**接手维护的开发者**。
> 讲清楚：架构为什么这样、改哪里、怎么验证、有哪些坑。
>
> 只想装来用？看 [README.md](README.md) 就够了，不用读这篇。

---

## 1. 先理解设计取舍（改之前必须知道）

这个插件有三个「看起来可以更简单，但故意没那样做」的地方。**改代码前先理解为什么**，
否则很容易顺手改掉，然后踩回同一个坑。

### 1.1 为什么凭证走子进程 stdin，而不是直接调 SSH 库

Node 生态里没有成熟到可以放心用的纯 JS SSH 实现（密钥格式、算法协商、老服务器兼容都要自己扛）。
本项目走 **Python + paramiko**，通过子进程调用。

由此带来一条硬约束：**凭证只从 stdin 传，绝不进命令行参数**。

```js
// ✅ 现在的做法：凭证在 stdin 里，ps / 进程列表看不到
child.stdin.end(JSON.stringify({ host, user, password, command }));

// ❌ 不要改成这样：密码会出现在 `ps aux` 里，也会进崩溃转储
spawn(python, [script, '--password', password]);
```

**如果你想换掉 Python 依赖**（比如打包成纯 Node），必须保留这条：凭证永远不经过
`argv`、不写临时文件、不进日志。可以考虑 `ssh2` 库，但要注意它不支持所有服务端算法。

### 1.2 为什么申请 PTY（以及为什么必须配 PAGER）

要让远端程序输出颜色，唯一办法是给它一个**伪终端**。程序检测到 `isatty()` 才会上色。

```python
stdin, stdout, stderr = client.exec_command(cmd, get_pty=True)
```

代价有两个，都必须处理：

| 代价 | 说明 | 应对 |
|---|---|---|
| **stderr 并入 stdout** | 终端只有一个流。这是终端语义，不是 bug | 接受它；靠 ANSI 颜色区分，或改用不带 PTY 的模式 |
| **程序以为自己在交互** | `less`/`more` 会跳出来等按键，非交互场景直接卡死 | **必须**内联设置 `PAGER=cat`、`SYSTEMD_PAGER=cat`、`GIT_PAGER=cat` 等 |

```python
# ✅ 环境变量内联进命令
wrapped = (
    "export TERM=xterm-256color COLORTERM=truecolor "
    "PAGER=cat SYSTEMD_PAGER=cat GIT_PAGER=cat LESS=FRX; " + command
)

# ❌ 不要用 exec_command(environment=...)：依赖服务端 AcceptEnv 白名单，
#    绝大多数机器的 sshd_config 默认拒收，会静默失效（你调试半天也找不到原因）
```

**如果 fork 后要提供「不要颜色」的选项**：传 `color: false` 即可，`runRemote` 已经支持，
它会关掉 PTY。但注意关掉后 stderr 会回到独立流、颜色也没了。

### 1.3 为什么颜色保留在日志里、却在返回给模型前去掉

同一份输出有两个消费者，需求相反：

| 消费者 | 需求 | 处理 |
|---|---|---|
| 面板控制台 | 要五颜六色 | **保留** ANSI 码 |
| LLM（模型） | 要干净文本 | `stripAnsi()` 去掉 |

```js
// lib/service.js：抓取时原样保存，出口处分叉
journal.output(streamId, 'out', rawChunk);          // 日志：保留
return { stdout: redact(stripAnsi(stdout)) };       // 模型：去色
```

**顺序很重要**：如果抓取时就 strip 掉，面板就再也没法显示颜色了。**分叉点必须尽量靠后。**

---

## 2. 代码地图

```
index.js            Host 半入口：注册工具、注入提示、挂 REST 面
client.js           Web 端（⚠️ 经典脚本，见 §3.1）
lib/
  paths.js          ★ 数据落点，唯一真源
  crypto.js         AES-256-GCM 封/解
  vault.js          凭证库（元信息明文 + secrets 密文）
  redact.js         脱敏（已知值 + 模式兜底）
  journal.js        操作日志（环形缓冲 + NDJSON）
  ssh.js            Node → Python 桥（spawn + NDJSON 事件流）
  ssh_exec.py       paramiko 执行器
  probe.js          环境/应用探测脚本与解析
  service.js        编排层：exec / probe / discoverApps / appAction
  tools.js          6 只工具定义
  ansi.js           ANSI 解析（模型侧 strip / 面板侧 parse）
  gate-rules.mjs    ★ 闸门判据，本地与远端共用
  http.js           REST 小工具
  server-api.js     只读 REST + SSE
scripts/
  publish-gate.mjs       本地闸门
  verify-remote.mjs      推送后远端复查
  gate-selftest.mjs      闸门对抗性自测
  install-hooks.mjs      安装 git 钩子
  check-issues.mjs       Issues 只读检查
  verify-no-plaintext.mjs 凭证明文闸门
  import-credentials.mjs 从外部 JSON 导入
  migrate-data-dir.mjs   迁移数据目录
```

### 数据流（一次 `ssh_server_exec`）

```
工具层 tools.js
  └─ service.exec()
       ├─ vault.secretsFor()      解出凭证，登记给 redactor
       ├─ journal.openStream()    控制台开一条流
       ├─ ssh.runRemote()         spawn python，凭证走 stdin
       │    └─ ssh_exec.py        paramiko 连接、跑命令、发 NDJSON 事件
       ├─ journal.output()        每行实时入日志（保留 ANSI）
       └─ 返回 { stdout: stripAnsi(...), code, ... }
```

---

## 3. 改代码时的硬约束

### 3.1 `client.js` 必须是「经典脚本」

它由 DSH 的 client-modules 当作 **CJS factory** 执行，不是 ES module：

```js
// ✅ 现在的写法
window.__ModuleLoader__.load({
  id: 'dsh-ssh-ops',
  factory(require) { const React = require('react'); /* ... */ return { inject, apply }; }
});

// ❌ 不要写成 import / export —— 会直接加载失败
```

有静态测试守着：`test-client.mjs` 会检查文件里没有顶层 `import`/`export`。

### 3.2 样式只用主题令牌，除了终端

全站跟随宿主的 `--dsw-alias-*` 令牌，**唯一例外是终端区域**（固定 `#0d1117` 黑底）。
这是刻意的：终端就该是黑的，跟随主题反而怪。

```css
/* ✅ */
.so-srv { background: var(--dsw-alias-bg-layer-1); }
.so-term { background: #0d1117; }   /* 终端例外 */

/* ❌ 不要在别处写死颜色 */
.so-head { background: #f5f5f5; }
```

`test-client.mjs` 会验证：所有 `var(--...)` 要么是 `--dsw-alias-*`，要么是本插件前缀 `--so-*`。

### 3.3 面板只读

服务器总览与控制台**不能有任何能改服务器状态的控件**。这是设计意图，不是还没做完。

写操作只走对话工具（`ssh_server_exec` / `ssh_app_control`）。如果 fork 后想加按钮，
要想清楚：**面板一能写，它就成了一个带 root 权限的 web 控制台**，安全模型完全不同。

### 3.4 数据绝不进仓库

`lib/paths.js` 是唯一真源，默认 `~/.dsh/ssh-ops/`。**不要为了调试方便把它指向仓库目录。**

```js
// ✅
return path.join(os.homedir(), '.dsh', 'ssh-ops');

// ❌ 曾经踩过：日志写在项目内，跑一次就把真实服务器 IP 写进了仓库
```

有钩子硬拦截（`pre-commit` / `pre-push`），跑不过就提交不了。

---

## 4. 安装（开发者模式）

```bash
git clone https://github.com/lambsouls/dsh-ssh-ops.git
cd dsh-ssh-ops

# 依赖：Python 3 + paramiko
pip install paramiko

# 装 git 钩子（不随仓库分发，每个克隆都要跑一次）
node scripts/install-hooks.mjs

# 装进 DSH profile（用 link: 方式，改代码后重载即生效）
dsh plugin --profile <你的profile> add "$(pwd)"
```

要求 **Node ≥ 20**（用到 `cpSync` 等）。

### 重载插件

改完 `index.js` 或 `client.js` 后必须重载，**不是重启 DSH**：

```
plugin_manager set_plugin target="include:dsh-ssh-ops" enabled=false
plugin_manager set_plugin target="include:dsh-ssh-ops" enabled=true
```

⚠️ entryId 是 **`include:dsh-ssh-ops`**（带 `include:` 前缀），传短名会报 `unknown-plugin`。

---

## 5. 验证

```bash
# 单元与集成（76 项）
node test-host.mjs                # 25 项：加密/脱敏/凭证库/日志/探测解析/工具契约/参数校验
node test-ansi.mjs                # 14 项：ANSI 解析（16/256/真彩、跨行继承、SGR 关闭码）
node test-client.mjs              # 11 项：客户端静态闸门（经典脚本/黑底/主题令牌）
node scripts/gate-selftest.mjs    #  9 项：闸门对抗性自测

# 语法
node --check client.js && node --check index.js
python -m py_compile lib/ssh_exec.py
```

**对抗性测试**比单元测试更值得写：`gate-selftest.mjs` 造了一批「应该被拦」的样本
（真实 IP、本机路径、私钥块、强密码、SSH 端口），以及一批「不该误伤」的样本
（回环地址、私有网段、占位符、变量取值、模板插值）。**一个没被证伪过的检查不值得信任。**

### 真机测试（改了 SSH / 探测 / 应用控制时）

```bash
node test-live.mjs --cred /path/to/cred.json   # 会真连，只取 host/port/user/password，不打印
```

---

## 6. 发布：三道检查

```bash
node scripts/publish-gate.mjs --all   # ① 本地闸门
git push                              # ②（pre-push 钩子会自动再跑一次）
node scripts/verify-remote.mjs        # ③ 远端复查 —— 必须手动
```

### 为什么推送后还要查一遍

**本地闸门只能查「它已知的模式」。判据本身有漏洞时，本地永远显示 OK。**

这不是理论担忧。开发过程中真实发生过：闸门的工作区路径判据当时只检查
`projects/` 和 `credentials/` 两个子目录，于是一条指向临时目录的路径绕过了检查，
**在首次发布时真的进了远端的文档文件**。事后靠「拿远端真实内容再扫一遍」才发现。

**所以：推完不复查 ＝ 没检查过。**

### 两个脚本共用一套判据

判据在 `lib/gate-rules.mjs`，`publish-gate`（本地）与 `verify-remote`（远端）都调它。

**不要在两处各写一份**——一旦漂移，就会出现「本地说干净、远端其实有」这种最难查的状态。

### `verify-remote` 额外做三件事

1. **核对本地/远端 HEAD 是否一致** —— 防「本地改好了但没推上去」，那时扫的是旧代码
2. **扫 commit message** —— 提交历史同样是公开面
3. **检查扫描完整性** —— 有文件没读到会报 `INCOMPLETE_SCAN` 并判定不通过

**退出码分三档**：`0` 干净 / `1` 有问题 / `2` 没查成。**`2` 不算通过** ——
在 API 限流时它报 `2` 而不是 `OK`，这一档是整个机制里最重要的设计。

### 闸门检查什么

| 代码 | 检查 |
|---|---|
| `SENSITIVE_PATH` | 凭证库、日志、私钥、截图被 git 跟踪 |
| `PUBLIC_IP` | 真实公网 IP（白名单放过回环/私有段/RFC 5737 文档保留段） |
| `LOCAL_PATH` | 本机绝对路径（Windows 家目录、POSIX 家目录、工作区路径） |
| `PRIVATE_KEY` | PEM 私钥块 |
| `PLAIN_PASSWORD` | 密码字面量（只抓带引号、像真密码的；变量取值是正常代码） |
| `TOKEN` | `sk-*` / `ghp_*` / `AKIA*` |
| `SSH_PORT` | 公网 IP + 非默认端口 |
| `DATA_IN_REPO` | 仓库目录里存在运行时数据 |

### 写测试夹具的注意事项

自测里需要假密码、假私钥时，**运行时拼出来**，不要写字面量：

```js
// ✅ 闸门不会拦
const FIXTURE_PW = ['Pa55', 'word', '!'].join('');
const pem = [['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' '), 'body',
             ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')].join('\n');

// ❌ 闸门会拦（而且它可能真是密码）
const FIXTURE_PW = 'Pa55word!';
```

**不要为了让测试通过而给闸门加白名单。** 给「假的」开口子，它也就抓不住「真的」了。

---

## 7. 踩过的坑

这些都是实际调试出来的，不是从文档抄的。

### SSH / 认证

| 现象 | 真正的原因 | 正确做法 |
|---|---|---|
| `Server accepts key` 之后仍然 `Permission denied`，GitHub 网页显示 key `Never used` | **私钥带密码短语**，非交互场景没人能输入签名 | `ssh-keygen -y -f <key>`，**5 秒内返回**才说明无密码。生成时 `-N` 传空**变量**：`$empty = ''; ssh-keygen -t ed25519 -f <file> -N $empty` |
| PowerShell 里 `-N '""'` 生成的私钥带密码 | PowerShell 把**引号本身**当成了密码短语 | 同上。这个坑极隐蔽，因为现象指向「key 没加上」 |
| HTTPS 推送经常 `Connection was reset` | 网络干扰，非权限问题 | 用 SSH（`git@github.com:...`）。实测 SSH 3/3 通，HTTPS 约 1/5 |
| GitHub API 匿名扫一遍就 403 | 匿名限额 60 次/小时 | `verify-remote` 改用 `git fetch` + `git show` 读本地对象，**零配额** |

### 远端命令

| 现象 | 原因 | 解决 |
|---|---|---|
| 命令卡住不返回 | PTY 下 `systemctl`/`git` 进了分页器 | 内联 `PAGER=cat SYSTEMD_PAGER=cat GIT_PAGER=cat` |
| 设置了环境变量但远端读不到 | `exec_command(environment=)` 依赖服务端 `AcceptEnv` | 内联进命令字符串 |
| `systemctl list-units` 解析出奇怪的服务名 | 失败单元前面的 `●` 让 `awk` 列号整体偏移 | 加 `--plain`，并且只取第一列 |
| NAS 上同一个应用出现两行 | compose 项目与容器各占一行 | 有同名容器就不另立项目行 |

### 前端

| 现象 | 原因 | 解决 |
|---|---|---|
| 面板里机器名挤成 `云服务...` | 右侧栏窄，gutter 占了太多宽度 | 只在流边界（连接/结束/失败）显示机器名 |
| 长备注把下拉撑散 | 备注可能是几百字的运维史 | 截断两行 + `title` 存全文 |

### 开发环境

| 现象 | 原因 | 解决 |
|---|---|---|
| 用 PowerShell 改 JS 后代码坏了 | PowerShell 会展开 `${...}`，吃掉模板字符串 | **改代码用编辑器/文件工具，别用 shell 字符串替换** |
| `plugin_manager` 报 `unknown-plugin` | entryId 必须带前缀 | 用 `include:dsh-ssh-ops` |

---

## 8. 数据与安全模型

### 存储

```
~/.dsh/ssh-ops/
  vault/servers.json   元信息明文 + secrets 密文（AES-256-GCM）
  vault/master.key     32 字节主密钥
  vault/keys/*.pem     私钥临时文件（仅密钥认证时）
  logs/ops-console.ndjson  操作日志（已脱敏但含真实 IP，故不进仓库）
```

### 别夸大这条边界

主密钥与密文在**同一个目录**。它挡的是：

- ✅ 翻到密文也读不出明文
- ✅ 误把密文贴给别人
- ❌ **不挡**能读你用户目录的本机攻击者

真正的隔离靠操作系统账户。要更强就接 DPAPI（Windows）或系统密钥库。这是已知待办。

### 脱敏

两层，都在**写盘之前**完成：

1. 已知凭证值精确替换（密码 / 私钥全文 / passphrase / 私钥的每一行）
2. 模式兜底：PEM 块、`sshpass`、密码类参数、`Bearer`、各家 token 前缀

---

## 9. 二次开发方向

### 想加工具

在 `lib/tools.js` 里加一项，`index.js` 会自动注册。注意：

- `parameters` 用**原始 JSON Schema**（不是 zod）
- `render` 决定模型看到什么；`execute` 的返回值才是真实数据
- 有副作用的工具要在 `description` 里写清楚后果

### 想换 SSH 后端

`lib/ssh.js` 是唯一的桥。只要保住这个契约：

```js
runRemote({ vaultSecrets, command, timeoutMs, loginShell, color, onEvent })
  → { code, stdout, stderr, durationMs, failure? }
```

`onEvent` 会收到 `{type: 'out'|'err'|'begin'|'end'|'fail', ...}`，控制台靠它实时刷新。

### 想做 CI

钩子不随仓库分发，别人 clone 下来是没有的。要在 GitHub Actions 里跑：

```yaml
- run: node scripts/publish-gate.mjs --all
- run: node test-host.mjs && node test-ansi.mjs && node test-client.mjs
      && node scripts/gate-selftest.mjs
```

`verify-remote` 需要仓库上下文（要能 `git fetch`），CI 里可以用
`actions/checkout` 的 `fetch-depth: 0` 配合。

---

## 10. 已知待办

1. **CI**：push 时自动跑闸门 + 自测（防别人 clone 后没有本地钩子）
2. **密钥认证端到端**：目前只测了「假私钥能入库+能脱敏」，没真用密钥连过一台机器
3. **DPAPI / 系统密钥库**：把主密钥保护提升到「同机其他账户也读不出」
4. **composeDir 自动推断**：`ssh_app_control` 对 compose 项目目前需要显式传目录

---

## 11. 关于同名仓库

GitHub 上另有一个同名项目 `caoyiwei850/dsh-ssh-ops`（更早、star 更多、工具集不同）。
如果你是从搜索找到这个页面的，注意区分：

| | 本项目 | 那个项目 |
|---|---|---|
| 仓库 | `lambsouls/dsh-ssh-ops` | `caoyiwei850/dsh-ssh-ops` |
| 工具 | `ssh_server_*` / `ssh_app_control` | 含 `sftp_delete` / `ssh_terminal_*` |

`scripts/check-issues.mjs` 会校验 owner，防止看错仓库的 issue。

---

## License

MIT。改了随意，出问题自负（见 [LICENSE](LICENSE)）。
