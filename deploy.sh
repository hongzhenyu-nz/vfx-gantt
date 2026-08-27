#!/usr/bin/env bash
#
# vfx-gantt 自动部署脚本
# ---------------------------------------------------------------------------
# 用法:
#   ./deploy.sh "说明文字"                完整部署（自动递增次版本号 vX.(Y+1)）
#   ./deploy.sh v7.99 "说明文字"          指定版本号部署
#   ./deploy.sh --check                   仅校验环境 / 读取网页规则 / 计算下一版本，不提交不推送
#
# 部署凭据（按优先级）:
#   1) SSH 部署密钥  git@github-vfx:hongzhenyu-nz/vfx-gantt.git   （优先）
#   2) 资产库「部署专用Token（保密）.md」的 Fine-grained PAT
#      → 写入环境变量 VFX_DEPLOY_TOKEN，或写入仓库根 .deploy_token（已被 .gitignore）
#      → 推完立即还原 SSH remote，token 不残留、不进 commit
#
# ⚠️ 工作日 / 节假日口径（关键约束）
#   该口径的唯一事实来源是 app.js 中的 HOLIDAYS / WORKMAKEUP / shadeType，
#   本脚本【不重复实现】任何工作日/节假日判定逻辑，仅在生产部署时从 app.js 读取并回显，
#   确保上线版本直接携带网页已配置好的口径，避免口径漂移或双份定义。
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

DATE_NOW="$(date '+%Y-%m-%d %H:%M')"

# —— 0. git 身份（沙箱默认无，缺失则补 ——
if [ -z "$(git config user.email 2>/dev/null)" ]; then
  git config user.email "ai@vfx-gantt.local"
  git config user.name "WorkBuddy"
fi

# —— 1. 读取当前版本号 ——
cur_v="$(grep -oE 'app\.js\?v=[0-9]+\.[0-9]+' index.html | head -1 | grep -oE '[0-9]+\.[0-9]+')"
if [ -z "${cur_v:-}" ]; then echo "✗ 无法从 index.html 读取 ?v= 版本号"; exit 1; fi
cur_v_esc="$(printf '%s' "$cur_v" | sed 's/\./\\./g')"

# —— 2. 读取工作日/节假日口径（单一事实来源 = app.js，本脚本不重复定义）——
read_rules() {
  local hol makeup shade
  hol="$(sed -n '/const HOLIDAYS = new Set/,/]);/p' app.js | grep -cE "'[0-9]{4}-" || true)"
  makeup="$(sed -n '/const WORKMAKEUP = new Set/,/]);/p' app.js | grep -cE "'[0-9]{4}-" || true)"
  shade="$(grep -c 'const shadeType' app.js || true)"
  echo "$hol|$makeup|$shade"
}
RULES="$(read_rules)"
IFS='|' read -r hol_n makeup_n shade_n <<< "$RULES"
echo "• 工作日口径来源: app.js  (shadeType 定义 ${shade_n} 处)"
echo "• 已配置法定节假日: ${hol_n} 条 ｜ 调休上班日: ${makeup_n} 条"
echo "• 本脚本不重复定义该逻辑 —— 部署即上线含此口径的 app.js"

# —— 3. 计算下一版本 ——
if [ "${1:-}" != "--check" ] && [[ "${1:-}" == v[0-9]* ]]; then
  next_v="${1#v}"; shift
else
  major="${cur_v%%.*}"; minor="${cur_v##*.}"
  next_v="${major}.$(( 10#$minor + 1 ))"
fi

# —— check 模式 ——
if [ "${1:---check}" = "--check" ] || [ "${1:-}" = "--check" ]; then
  echo "• 当前版本 v${cur_v} → 下一版本 v${next_v}"
  echo "• remote: $(git remote get-url origin 2>/dev/null || echo '(未设置)')"
  echo "• 工作区状态: $(git status --porcelain | wc -l) 个文件有改动"
  echo "✓ --check 完成（未提交 / 未推送）"
  exit 0
fi

msg="${1:-}"
if [ -z "$msg" ]; then echo "用法: ./deploy.sh \"说明文字\"  或  ./deploy.sh v7.99 \"说明文字\""; exit 1; fi

# —— 4. 三处版本号同步 （铁律 2）——
sed -i "s#styles.css?v=${cur_v_esc}#styles.css?v=${next_v}#" index.html
sed -i "s#app.js?v=${cur_v_esc}#app.js?v=${next_v}#" index.html
sed -i "s#v${cur_v_esc} · build [0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\} [0-9]\{2\}:[0-9]\{2\}#v${next_v} · build ${DATE_NOW}#" index.html

# —— 5. 双入口同步 + 语法校验 ——
cp index.html team_gantt.html
if cmp -s index.html team_gantt.html; then echo "✓ index.html 与 team_gantt.html 逐字节一致"; else echo "✗ 双入口不一致"; exit 1; fi
node --check app.js && echo "✓ app.js 语法 OK"

# —— 6. 提交 + 推送 ——
git add app.js styles.css index.html team_gantt.html deploy.sh .gitignore
if git diff --cached --quiet; then echo "✗ 暂存区无改动，未提交（请先 git add 你的改动）"; exit 1; fi
git commit -m "v${next_v}: ${msg}"

git remote set-url origin "git@github-vfx:hongzhenyu-nz/vfx-gantt.git"
if git push origin main 2>/dev/null; then
  echo "✓ SSH 部署密钥推送成功"
else
  echo "• SSH 不可用，回退到 VFX_DEPLOY_TOKEN（资产库部署专用 Token）"
  if [ -z "${VFX_DEPLOY_TOKEN:-}" ] && [ -f .deploy_token ]; then VFX_DEPLOY_TOKEN="$(cat .deploy_token)"; fi
  if [ -z "${VFX_DEPLOY_TOKEN:-}" ]; then
    echo "✗ 缺少部署 Token：请从资产库「vfx-gantt-v7.10/部署专用Token（保密）.md」取得 PAT，"
    echo "  然后  export VFX_DEPLOY_TOKEN=xxx  或写入 .deploy_token（已被 .gitignore），再重跑本脚本。"
    exit 1
  fi
  # 瞬时使用 token，推完立即还原 SSH remote
  git remote set-url origin "https://${VFX_DEPLOY_TOKEN}@github.com/hongzhenyu-nz/vfx-gantt.git"
  git push origin main
  git remote set-url origin "git@github-vfx:hongzhenyu-nz/vfx-gantt.git"
  echo "✓ Token 推送成功，remote 已还原为 SSH（token 零残留）"
fi

# —— 7. 线上核验（CDN 1–2 分钟生效）——
sleep 60
online="$(curl -sL "https://hongzhenyu-nz.github.io/vfx-gantt/?nocache=$(date +%s)" | grep -oE "v${next_v} · build [0-9: -]+" | head -1)"
echo "• 线上构建戳: ${online:-（未检测到，可能 CDN 仍在缓存，稍后 Ctrl+Shift+R 复验）}"
echo "✓ 部署完成: v${next_v}"
echo "  提示: 部署成功后请按项目约定发布「更新动态」（fix/feat/opt/docs，@所有人）"
