// scripts/install-hooks.mjs —— 安装 git 钩子。
//
// 为什么要它：闸门脚本只有「记得跑」才有用。人（包括我）会忘，于是要让它变成
// **提交动作本身的一部分** —— 跑不过就提交不了。这比写在文档里叮嘱一万遍可靠。
//
// 用法：node scripts/install-hooks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let hooksDir;
try {
    hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
    console.log('✗ 这不是一个 git 仓库，先 git init');
    process.exit(2);
}
const target = path.resolve(ROOT, hooksDir);
fs.mkdirSync(target, { recursive: true });

const preCommit = `#!/bin/sh
# 由 scripts/install-hooks.mjs 生成 —— 别手改，改脚本再重跑。
# 提交前强制跑发布闸门：真实 IP / 本机路径 / 私钥 / 密码字面量 / 敏感路径被跟踪，
# 任何一条命中都不许提交。
echo "[publish-gate] 检查将要提交的内容…"
node scripts/publish-gate.mjs
if [ $? -ne 0 ]; then
    echo ""
    echo "✗ publish-gate 未通过 —— 提交已中止。"
    echo "  修好上面的问题再 git add。确实要绕过：git commit --no-verify（不推荐）"
    exit 1
fi
exit 0
`;

const prePush = `#!/bin/sh
# 由 scripts/install-hooks.mjs 生成。
# 推送前再查一次「全目录」（不只是已跟踪文件），防的是「万一有数据落在仓库里但被 ignore 了」。
echo "[publish-gate] 推送前全目录复查…"
node scripts/publish-gate.mjs --all --strict-data
if [ $? -ne 0 ]; then
    echo ""
    echo "✗ 全目录复查找出隐患 —— 推送已中止。"
    exit 1
fi
exit 0
`;

for (const [name, body] of [['pre-commit', preCommit], ['pre-push', prePush]]) {
    const file = path.join(target, name);
    fs.writeFileSync(file, body, 'utf8');
    try { fs.chmodSync(file, 0o755); } catch { /* Windows 忽略 */ }
    console.log(`✓ ${path.relative(ROOT, file)}`);
}

console.log('\n钩子已安装。之后每次 git commit / git push 都会自动跑闸门。');
