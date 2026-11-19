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

### 1.4 为什么档案是明文、且与凭证库分开（`lib/profile.js`）

凭证回答「怎么连」，探测回答「此刻有什么」，档案回答「这台机器有什么坑」。
第三类知识的特点是：**机器内部查不到**（共享 IP 的端口映射在接入侧、数据在网盘、
哪个服务是别人的），丢了就再也想不起来。

所以三条设计决定，改之前先理解：

| 决定 | 理由 | 别改成什么 |
|---|---|---|
| **明文存盘** | 出问题第一件事是 `grep` 档案，不是「解密再翻」 | 别顺手给它加密 —— 它不含密码，加密只会让排查变难 |
| **与 vault 分目录、按 serverId 解耦** | 改密码/换认证不该丢档案 | 别把档案塞进 `servers.json` 的条目里 |
| **每条事实带 `source`** | 分清「用户说的」「实测的」「模型推断的」，冲突时知道该信谁 | 别把 `source` 做成可选或默认 `owner` |

**`source` 的默认值是 `agent`，这是刻意的**：模型自己写的东西默认最低权威，
必须有明确依据（或用户明说）才能标 `probe` / `owner`。实现上分两段：

```js
// 归一化阶段：没提供的字段留 null（表示「本次没提供」），不是直接填默认值
source: oneOf(raw?.source, SOURCES, null),

// 落盘前 finalize：null 才补默认值
p.traits = p.traits.map((t) => ({ ...t, source: t.source ?? 'agent' }));
```

**为什么不能合成一步**：如果归一化时就填默认值，那么「只更新 impact 字段」的调用
会带着默认的 `source: 'agent'` 一起合并进去，把原有的 `source: 'owner'` 悄悄降级。
这是个很容易复发的 bug（本项目自测里就抓到过一次）。

同理还有 `mergeItems` 的三条规则（按 id 合并不整体替换、null 不覆盖已有值、
无 id 无标题的条目丢弃）—— 都是为了「只改一个字段不能弄坏别的字段」。
**档案的价值全在积累，一次误覆盖就把积累清零了。**

### 1.5 档案与探测冲突时不要自动改档案

`discoverApps` 会顺带做一次漂移检查（`profileDrift`），但**只报告、不写入**：

```js
const drift = profiles.exists(serverId) ? profileDrift(profiles.get(serverId), parsed) : null;
```

档案是**知识**，探测是**状态**。两者对不上时，「机器被别人动过」和「我们记错了」
的处理方式完全相反，必须让人判断。所以 `ssh_server_env` 的渲染里会写
「档案与实测有出入（不要自动改档案，先确认是谁动过这台机器）」。

**如果你想让某个自动发现行为顺手更新档案**：先问自己「这条差异有没有可能
是别人改的」，答案是「有可能」就不要自动写。

---

## 2. 代码地图

```
index.js            Host 半入口：注册工具、注入提示、挂 REST 面
client.js           Web 端（⚠️ 经典脚本，见 §3.1）
lib/
  paths.js          ★ 数据落点，唯一真源
  crypto.js         AES-256-GCM 封/解
  vault.js          凭证库（元信息明文 + secrets 密文）
  profile.js        ★ 服务器档案（每台机器独有的运维知识，明文）
  profile-html.js   档案的独立 HTML 页面（自包含，转义 + 安全头）
  redact.js         脱敏（已知值 + 模式兜底）
  journal.js        操作日志（环形缓冲 + NDJSON）
  ssh.js            Node → Python 桥（spawn + NDJSON 事件流）
  ssh_exec.py       paramiko 执行器
  probe.js          环境/应用探测脚本与解析
  service.js        编排层：exec / probe / discoverApps / appAction / 档案
  tools.js          9 只工具定义
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

### 3.3 面板只开了一个写口子：改名 / 改标签

**除「显示名」与「标签」之外，面板不能写任何东西。** 这是设计意图，不是还没做完。

原来的规矩是「面板全只读」，理由是「面板一能写，它就成了一个带 root 权限的 web 控制台」。
那句话针对的是**能触发远程操作**的面板。改名/改标签不碰服务器 —— 它只改本机凭证库里两个
给人看的字段，所以开了这个口子。**边界要守住：凡是会影响服务器状态的东西，一律不许进 REST 面。**

| 能改 | 怎么改 | 约束在哪 |
|---|---|---|
| 显示名、标签 | `PATCH /api/ssh-ops/servers/:id` | `vault.setIdentity()` + `service.renameServer()` |

写操作的路径很短，三层各自守一件事：

```js
// ① server-api.js：入口。除 name/tags 外的字段一律 400，不做「悄悄忽略」
if (req.method === 'PATCH') { body = await readJsonBody(req); ops.renameServer(id, body); }

// ② service.js：准入。白名单校验 + 留痕（改动进控制台日志）
const allowed = new Set(['name', 'tags']);
const unknown = Object.keys(input).filter((k) => !allowed.has(k));
if (unknown.length > 0) throw new Error(`只允许改 name / tags，拒绝了：${unknown.join('、')}`);

// ③ vault.js：落盘。只写 name/tags，不碰 id/host/port/user/secrets
```

**为什么不让前端直接调 `vault.upsert()`**：`upsert` 要求 host/user 必填，用它改名会把连接信息
一起回传；一旦某处传错就可能**改掉地址**，而改错地址的后果是「你以为在操作 A 机，其实连到 B 机」。
写入口的参数必须窄到「窄到传错了也不会出事」。

**三条硬约束（改 `setIdentity` 前先读）**：

1. **不改 id** —— id 是档案（`profiles/<id>.json`）的键，改了档案就成孤儿；
2. **不碰 secrets / host / port / user / authType** —— 凭证改动只走 `ssh_server_register`；
3. **名称为空时退回 host** —— 列表里空名字无法点击，等于把机器藏起来。

**`readJsonBody`（`lib/http.js`）的三道限制都是必须的**：大小上限（8 KB，否则给本机任何进程
一个往内存灌数据的入口）、读取超时（半开连接会永久占住 handler）、只接受 `application/json`
（挡表单跨站提交，与 Origin 校验是两道独立的墙）。

**想再加一个面板写操作？** 先回答：它会不会影响服务器状态？会 → 不许进 REST 面，走对话工具。
不会（只改本机元信息）→ 照 `setIdentity` 的样子开一个**参数极窄**的专用方法，
不要做成「通用 update」。

### 3.3.1 档案不铺在面板里，只给一个跳到新标签页的入口

**档案是给 DSH 自己看的**（它决定「动手前先读什么」），对使用者多数时候不需要。
把特征/端口映射/约束/处置/待确认/时间线六个分区铺进服务器行的展开区，代价是：

- 每次展开都在挤占真正要看的东西（连接信息、应用清单）；
- 六七个分区的信息密度对「只是想看一眼这台机器装了什么」的人是纯噪音。

所以：**行里只留一个 `档案 ↗` 按钮**，点开新标签页看完整档案（`lib/profile-html.js`）。
改这个设计前请先回答：用户打开面板时，**第一眼想看到的是机器清单，还是这台机器的运维知识？**

页面实现的三条约束：

| 约束 | 为什么 |
|---|---|
| **完全自包含**（无外链 CSS/JS/图片） | 可能在没网络的机器上打开，也可能被另存下来看 |
| **所有档案文本必须 `esc()`** | 档案内容可能来自模型输出或用户输入，直接插进 HTML 就是 XSS。`test-profile-page.mjs` 有对抗用例守着 |
| **带 `?fence=1` 放行 + 安全头** | 浏览器直接导航带不上自定义头（同 SSE）；页面还给了 `X-Frame-Options: DENY` / CSP / no-referrer —— 它是把本机档案摊开成网页，不该被嵌进别人的 frame |

> `?fence=1` 只放行**无副作用**的只读端点（SSE、档案页）。**写端点绝不能用查询参数放行** ——
> 否则跨站页面一个链接就能改你的数据。
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
# 单元与集成（197 项）
node test-host.mjs                # 32 项：加密/脱敏/凭证库/日志/探测解析/工具契约/参数校验
node test-profile.mjs             # 25 项：档案归一化/增量合并/删除/一致性/渲染/文件边界
node test-identity.mjs            # 35 项：改名/标签的改动面（重点测「除此之外什么都没变」）
node test-reassign.mjs            # 19 项：换 serverId 后凭证库与档案是否仍对得上
node test-profile-page.mjs         # 31 项：档案页面内容完整 + HTML 转义（防 XSS）
node test-ansi.mjs                # 14 项：ANSI 解析（16/256/真彩、跨行继承、SGR 关闭码）
node test-client.mjs              # 25 项：客户端静态闸门 + 真渲染（假 React + vm 跑组件）
node scripts/gate-selftest.mjs    # 16 项：闸门对抗性自测（含真实泄漏样本）

# 语法
node --check client.js && node --check index.js
python -m py_compile lib/ssh_exec.py
```

**`test-identity.mjs` 的重点不是「改成功了」，是「除此之外什么都没变」**：
地址、端口、用户名、`secrets` 密文、`notes`、`apps`、id 全部逐一断言没被动过。
写入口的测试价值就在这里 —— 「能改」本来就成立，「不能改别的」才是要守住的东西。

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

### ⚠️ 闸门 `STATUS: OK` ≠ 没泄漏（2026-11-19 的教训）

闸门只查**它已知的那几个模式**（公网 IP / 本机路径 / 私钥 / 密码 / token / SSH 端口 / 敏感目录）。
**它查不出「你这次改动引入的问题」这个层级。** 当天加完两个功能后闸门两次 OK，
人工复审仍发现三类真问题：

| 问题 | 为什么闸门当时查不出 |
|---|---|
| 公开面又写回了私人称呼（23 处），违反之前立过的规矩 | 它不是敏感词表里的模式 |
| 公开文档里写进真实 serverId + 拓扑特征 | 当时没有这条判据（现已补 `SERVER_ID`） |
| `locale/*.json` 文案没跟上新功能（仍写「只读」） | 文案过时不触发任何检查 |

**所以推送前要多做一步「人级复审」**，闸门不能替代：

```bash
# ① 我这次加的每句话，是不是「对任何 clone 的人都成立」？本机事实一律迁去私密文档
# ② 有没有真实标识混进文档或测试夹具
git grep -n -E '\b[a-z][a-z0-9-]*-[0-9a-f]{6}\b' -- .      # serverId 形状
git grep -n -E '[0-9]{1,3}(\.[0-9]{1,3}){3}' -- .          # IP
# ③ 新功能的文案在所有暴露面都同步了吗（client.js / locale / README / 工具描述）
# ④ 提交历史也是公开面（verify-remote 会扫 commit message —— 它真的抓到过）
```

**判据一句话**：闸门守「字符串长什么样」，人守「这句话该不该公开」。两件事不能互相替代。

### 6.2 万一 serverId 已经泄露了

`force-push` **消不掉**它：GitHub 保留不可达对象，用 SHA 仍能直接访问（实测 200）。
`verify-remote` 也会把含泄露的旧 commit message 报出来 —— 那不是误报，是真的还能读到。

唯一能立即生效的动作是**作废这个标识**：

```bash
node scripts/reassign-id.mjs --old <旧 id> --reason "为什么作废" --dry   # 先看计划
node scripts/reassign-id.mjs --old <旧 id> --reason "..."
```

它同时改两处（任一漏改都会变成「凭证在、档案在，但两者对不上」）：

1. **凭证库**：该条记录换到新 id，**其余字段逐字节不动**；
2. **档案文件**：改名 + 改 `serverId`，并在时间线插一条 `incident`「旧 id 因泄漏作废」。

之后旧字符串在库里、在文件系统里都找不到任何东西，只在时间线里作为审计痕迹存在。
**这才是「旧标识不再指向真实数据」的实现方式。**

> 如果泄露的是**凭证**（密码/私钥），那是另一回事：立刻轮换凭证并在档案里记 incident。
> `reassign-id` 只处理「标识」层，不替代轮换。

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

> 这条不是理论：写档案模块的自测时，泄漏检测用例里写了个字面量假密码，
> `gate-selftest` 当场变红。**闸门是对的，测试是错的** —— 改成运行时拼接即可。

---

## 7. 踩过的坑

这些都是实际调试出来的，不是从文档抄的。

### SSH / 认证

| 现象 | 真正的原因 | 正确做法 |
|---|---|---|
| `Server accepts key` 之后仍然 `Permission denied`，GitHub 网页显示 key `Never used` | **私钥带密码短语**，非交互场景没人能输入签名 | `ssh-keygen -y -f <key>`，**5 秒内返回**才说明无密码。生成时 `-N` 传空**变量**：`$empty = ''; ssh-keygen -t ed25519 -f <file> -N $empty` |
| PowerShell 里 `-N '""'` 生成的私钥带密码 | PowerShell 把**引号本身**当成了密码短语 | 同上。这个坑极隐蔽，因为现象指向「key 没加上」 |
| HTTPS 推送经常 `Connection was reset` | 特定网络环境下 HTTPS 被干扰，非权限问题 | 改用 SSH（`git@github.com:...`）。*注：这是作者在某网络环境下的观测，你的环境未必相同 —— 先判断是网络还是权限* |
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
  profiles/<id>.json   服务器档案（**明文**，不含任何凭证）
  logs/ops-console.ndjson  操作日志（已脱敏但含真实 IP，故不进仓库）
```

**档案为什么可以明文**：它记的是「这台机器有什么脾气」，不含密码/私钥。
加密它只会让「出问题时翻档案」这一步变难，换不来实质安全 ——
能读你用户目录的攻击者本来就能读 `master.key`。

**但要守住一条**：档案里**永远不写密码、私钥、passphrase**。
`ssh_server_profile_audit` 会扫档案原文，发现 `password` 字段或 PEM 块就报出来。

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

### 想加档案字段

档案的字段分两层：**标量**（`summary` / `role`）和**列表**（`traits` / `portMap` / `constraints` / `runbooks` / `timeline` / `openQuestions`）。
加一个**列表**字段要改四处：

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `lib/profile.js` `normalizeProfile` | 加归一化（宽进：坏数据丢弃而不是抛错） |
| 2 | `lib/profile.js` `applyPatch` + `finalize` | 加合并规则 + 默认值（默认值一定要在 finalize 里补，理由见 §1.4） |
| 3 | `lib/profile.js` `renderProfile` | 加渲染（模型和面板看到的是同一段话） |
| 4 | `lib/tools.js` `PROFILE_ITEM_SCHEMA` + 工具 `parameters` | 加参数形状，否则 `makeExecutor` 会拒绝该字段 |

加**标量**字段只需 1–4 中除合并外的部分（`applyPatch` 里一行 `if (p.x !== undefined) next.x = str(...)`）。

**不要**给列表字段用「整体替换」语义：档案靠反复追加积累，一次替换就把历史清了。
用 `mergeItems`，它已经处理好了「按 id 合并 / null 不覆盖 / 空条目丢弃」。

### 想加工具

在 `lib/tools.js` 里加一项，`index.js` 会自动注册。注意：

- `parameters` 用**原始 JSON Schema**（不是 zod）
- `render` 决定模型看到什么；`execute` 的返回值才是真实数据
- 有副作用的工具要在 `description` 里写清楚后果

### 想给**已有**工具加参数（容易漏的一步）

加一个参数要改**三处**，少一处就会报「无效参数（未知字段）」：

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `lib/tools.js` | `parameters` 里加字段定义 |
| 2 | `lib/tools.js` | `execute(args)` 里把它透传给下层 |
| 3 | `lib/service.js` | `exec({ ... })` 的解构参数里接收它 |

很多参数还要在 `lib/ssh.js` → `lib/ssh_exec.py` 里落地（如果最终要影响远端行为）。

第 3 处最容易漏，因为前两处都在同一个文件里，改完看起来「好了」。
`index.js` 的 `makeExecutor` 会按 `parameters` 的键名做白名单校验，
**未声明的字段会被直接拒绝**，所以第 1 处漏了会立刻报错，但第 3 处漏了只会静默失效。

**以加 `dryRun` 为例（只回显命令不执行）：**

```js
// 1) lib/tools.js —— 声明
parameters: {
  serverId: { ...SERVER_ID_SCHEMA, required: true },
  command: { type: 'string', required: true },
  dryRun: { type: 'boolean', description: '只显示将要执行的命令，不实际执行。' },
},
// 2) lib/tools.js —— 透传
async execute(args) {
  return ops.exec({ serverId: args.serverId, command: args.command, dryRun: args.dryRun === true });
},

// 3) lib/service.js —— 接收
async function exec({ serverId, command, dryRun = false, ... }) {
  if (dryRun) {
    // 不发 SSH，只记一条日志，返回将要执行的命令
    return { dryRun: true, command, code: 0, stdout: '', stderr: '' };
  }
  // ...原有逻辑
}
```

### 怎么测「不产生副作用的分支」

`dryRun` 这类分支的测试重点不是「命令跑对了」，而是**「确认它真的没跑」**：

```js
// test-host.mjs
ok('dryRun 不发 SSH', async () => {
  const result = await ops.exec({ serverId, command: 'echo hi', dryRun: true });
  assert.strictEqual(result.dryRun, true);
  // 关键：断言 journal 里没有 stream-open（没有真的连过）
  const streams = ops.journal.snapshot({ limit: 50 }).filter((e) => e.kind === 'stream-open');
  assert.strictEqual(streams.length, 0, 'dryRun 不该产生连接记录');
});
```

**断言「没发生什么」比断言「发生了什么」更能抓住 bug。**

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
5. **档案模板**：新机器建档全空，可以按「玩家家用机 / 共享 IP 云机 / 内网 NAS」给几套骨架
6. **档案导出/导入**：换机器时档案要能整体搬走（目前是文件，手工拷也行）

---

## 11. 关于同名仓库（仅原作者维护本仓库时需要）

> **fork 之后可以整节删掉。** 这节是维护 `lambsouls/dsh-ssh-ops` 这个**特定仓库**的注意事项，
> 与代码本身无关。

GitHub 上另有一个同名项目 `caoyiwei850/dsh-ssh-ops`（更早、star 更多、工具集不同）：

| | 本仓库 | 那个项目 |
|---|---|---|
| 路径 | `lambsouls/dsh-ssh-ops` | `caoyiwei850/dsh-ssh-ops` |
| 工具 | `ssh_server_*` / `ssh_app_control` | 含 `sftp_delete` / `ssh_terminal_*` |

**为什么写在这里**：`scripts/check-issues.mjs` 会校验 owner，防止维护者看错仓库的 issue。
如果你 fork 后继续用这个脚本，把脚本里的 `EXPECTED_OWNER` 改成你自己的账号即可。

**如果你只是使用者**：忽略这节。
## License

MIT。改了随意，出问题自负（见 [LICENSE](LICENSE)）。



