# vfx-gantt 项目指令

**仓库** `hongzhenyu-nz/vfx-gantt` (main) ｜ **线上** https://hongzhenyu-nz.github.io/vfx-gantt/ ｜ GitHub Pages，CDN 缓存 1–2 分钟

## 文件结构（v7.11 起模块化）
`index.html` 骨架 ｜ `app.js` 全部逻辑(490KB) ｜ `styles.css` 样式(160KB) ｜ `team_gantt.html` = index.html 的逐字节副本
- 主文件是 index.html，同步方向固定 `index.html → team_gantt.html`，勿反向覆盖
- **app.js 禁止整文件读取**（超 token 上限），先 Grep 定位再 Read 行段
- Supabase 连接信息在 app.js，不在 index.html

## 铁律 1：部署走 SSH Deploy Key，不需要 token
```bash
git remote -v   # 必须是 git@github-vfx:hongzhenyu-nz/vfx-gantt.git
git add app.js styles.css index.html team_gantt.html && git commit -m "vX.XX: 说明" && git push origin main
```
**push 失败头号原因**：某些 clone 的 remote 是 HTTPS，而本机无任何 GitHub 账密/PAT，必然报 `could not read Username`（某些环境下伪装成 `SIGTERM`，极易误判为环境问题）。
→ 一行解决：`git remote set-url origin git@github-vfx:hongzhenyu-nz/vfx-gantt.git`
→ **禁止**索要 token、改用 PAT、让用户手动 push、用 GitHub MCP 推送（文件过大）
→ 部署任务先读技能 `vfx-gantt-deploy`

## 铁律 2：改了 app.js 或 styles.css，必须同步三处版本号
`index.html` 里 `styles.css?v=X.XX`、`app.js?v=X.XX`、可见构建戳 `vX.XX · build YYYY-MM-DD HH:MM`
漏改 → 三文件独立缓存错配 → 视图崩坏（左栏空白/任务条不渲染）。时间用 `date` 取，勿手算。改完 `cp index.html team_gantt.html`。

## 铁律 3：视觉改动必须真实浏览器验证
本项目多次出现「代码对但界面没生效」（CSS 特异性覆盖、z-index 穿透、标签重叠），**静态检查会误报完成**。
```bash
python -m http.server 8899   # file:// 下 app.js 不执行，必须走 http
agent-browser open "http://127.0.0.1:8899/index.html?nocache=$(date +%s)" && agent-browser eval "..."
```
- open 与 eval 必须串在同一条命令（否则丢页面上下文）
- 先关身份弹窗：`document.querySelector('.idn-skip-btn')?.click()`
- 用 `getBoundingClientRect()` 量坐标判定重叠/溢出，别靠肉眼看截图
- 部署后还要打开**线上** URL 复验

## UI 既有设计语言（勿破坏）
- **「超期」有两种标签**，用户提到时先量坐标确认是哪个：橙 `.rt-late`「⚠逾期未完」(超排期未确认完成) ｜ 紫 `.ovr-tag`「超N周」(超标准工期)
- **占位条右侧上下双轨**：上轨 `top:2px` = `.vacant-badge` 缺人徽标；下轨 `bottom:2px` = `.ovr-tag`/`.rt-late` 工期风险。仅对 `.vacant-bar`，普通条 `.ovr-tag` 保持垂直居中
- **今天红线**靠 `syncTodayLabel()` 按 scrollLeft 施加 `clip-path: inset(0 0 0 Npx)` 裁剪防穿透冻结栏，**勿改回单纯抬 z-index**（透明空隙仍漏红线）
- **负载热力带** 32px，色段 y3..25 厚 22px。逐周「人数·占比」数字已于 v7.20 移除（改走 hover），勿加回
- 竖线层与 `.drop-guide`/`.drop-band` 的 top = 54(表头)+32(热力带) = **86px**，改带高必须同步三处

## 云端数据
代码/UI/统计逻辑改动 → 只改 app.js/styles.css，运行时自动作用于云端数据，**无需写云端**
真实成员/需求记录改动 → 走技能 `vfx-gantt-cloud-sync`，推前必须展示 diff 并取得确认；`cloud_snap*.json` 含真实数据禁止提交
运行时：本地 seed → `applySnap()` 云端覆盖 → 渲染（**云端优先**）

## 工作方式
1. Grep/Read 定位 → Edit → `node --check app.js` → `cp` 双入口 + `cmp` → 同步版本号 → 浏览器验证 → commit/push → 线上核验
2. **失败连续 2 次立即停止重试**，回头查项目既有约定（本文件/技能/历史日志），勿换工具反复试错
3. 穷尽项目内既有方案前，**不得输出**「没权限/需要你手动执行/请提供 token」——那属于任务未完成
4. **先给结论**再给证据，不复述过程；表格汇总改动；方案对比给推荐项；UI 变更以截图校验后才算完成
