# CONTRIBUTING / 维护须知

## 铁律：代码与数据必须分离

这个仓库是**公开的**。任何「跑起来才会产生」的东西都不许进来。

| 允许 | 禁止 |
|---|---|
| `.js` / `.mjs` / `.py` / `.json`（配置模板）/ `.md` / `.yml` / `.svg` | 凭证库、`master.key`、`.pem` |
| 示例地址（`192.168.1.10`、`example.com`、`0.0.0.0`） | 真实公网 IP、真实 SSH 端口、真实主机名 |
| 抽象路径（`~/.dsh/ssh-ops/`、`/path/to/repo`） | 任何人的本机绝对路径（`C:\Users\xxx`、`/home/xxx`） |
| 截图里的模糊示意 | 含真实 IP / 端口 / 主机名的截图 |

数据落点永远是 `~/.dsh/ssh-ops/`（见 `lib/paths.js`）。**不要**为了「方便调试」把
`vaultDir` / `logDir` 指到仓库目录里——那正是 v0.2.x 犯过的错。

## 提交前必做

```bash
node scripts/publish-gate.mjs --all   # 必须 STATUS: OK
node test-host.mjs && node test-ansi.mjs && node test-client.mjs
node scripts/verify-no-plaintext.mjs  # 有真实凭证数据时才有意义
```

`publish-gate` 非零退出就是**不许提交**，不是「警告一下」。

## 测试夹具的写法

自测里需要假密码、假私钥时，**运行时拼出来**，不要写字面量：

```js
// ✅ 闸门不会拦
const FIXTURE_PW = ['Pa55', 'word', '!'].join('');
const pem = [['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' '), 'body', ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')].join('\n');

// ❌ 闸门会拦（而且可能是真密码）
const FIXTURE_PW = 'Pa55word!';
const pem = ['-----BEGIN','OPENSSH','PRIVATE','KEY-----'].join(' ') + ...;  // 拼出来
```

这不是形式主义：闸门如果为「假的」开口子，就没法保证它抓得住「真的」。

## 改了数据落点要同步三处

1. `lib/paths.js`（唯一真源）
2. `README.md` 的「数据与代码的边界」表
3. `scripts/migrate-data-dir.mjs` 的迁移逻辑

## 版本

语义化版本。数据落点变了就是 **minor + 迁移脚本**（因为对用户可见）。

