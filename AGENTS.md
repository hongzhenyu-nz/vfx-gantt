# 项目指令 · VFX 团队甘特看板（vfx-gantt）

> 本文件是本项目的强制约定。动手前先读完，不要凭通用经验操作。

## 一、项目身份

| 项 | 值 |
|---|---|
| 项目 | 逆战商业化角色特效 · 排期协同甘特看板 |
| 本地仓库 | `C:\Users\hongzhenyu\WorkBuddy\2026-08-25-13-28-52\vfx-gantt` |
| GitHub 仓库 | `hongzhenyu-nz/vfx-gantt`，分支 `main` |
| 线上地址 | https://hongzhenyu-nz.github.io/vfx-gantt/ |
| 托管 | GitHub Pages（push 后自动构建，CDN 缓存 1–2 分钟） |
| 云端数据 | Supabase 表 `board_state`，单行 `vfx-gantt-main` |

**同一仓库在本机存在多个 clone**（如旧副本 `2026-06-20-16-52-57`）。不要假设当前目录，先 `git remote -v` 确认。

## 二、文件结构（v7.11 起已模块化，勿当单文件处理）

```
index.html       骨架 + 版本戳 + 资源引用
app.js           全部渲染与交互逻辑（约 490KB）
styles.css       全部样式（约 160KB）
team_gantt.html  index.html 的同步副本，必须逐字节一致
```

- 主文件是 `index.html`，**同步方向固定 `index.html → team_gantt.html`**，反向复制会覆盖最新修改。
- Supabase 连接信息（`SB_URL`/`SB_KEY`/`SB_TABLE`/`SB_ROW`）在 **`app.js`**（不在 index.html）。
- `app.js` 约 490KB，**不要整文件读取**（会超 token 上限）。用 Grep 定位后 Read 指定行段。

## 三、铁律：部署

**部署走仓库专用 SSH Deploy Key，不需要任何 token。**

```bash
git remote -v   # 必须是 git@github-vfx:hongzhenyu-nz/vfx-gantt.git
git add app.js styles.css index.html team_gantt.html
git commit -m "vX.XX: 说明"
git push origin main
```

### ⚠️ push 失败时的头号原因（已踩过，别再踩）

本机**没有**任何 GitHub 用户名/密码/PAT（凭据管理器无 github.com 条目、无 `~/.git-credentials`、无 `gh` CLI）。
若某个 clone 的 remote 是 HTTPS，push 必然失败并报：

```
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

更坑的是某些环境下它表现为 `Exit Code 1 / Signal SIGTERM`，**极易误判成"执行环境杀进程"**。

**正确处置**（一行解决）：
```bash
git remote set-url origin git@github-vfx:hongzhenyu-nz/vfx-gantt.git
```

验证密钥可用：`ssh -o StrictHostKeyChecking=no -T git@github-vfx`
→ 应返回 `Hi hongzhenyu-nz/vfx-gantt! You've successfully authenticated`

**禁止**：索要 token、改用 PAT、让用户手动 push、运行已废弃的 `scripts/deploy.py`。
**禁止**：用 GitHub MCP 连接器推送本项目（`push_files` 需完整文件内容，app.js/styles.css 体积超限）。

已有专用技能 `vfx-gantt-deploy`，部署任务应先读它。

## 四、铁律：改了 app.js 或 styles.css，必须同步三处版本号

Pages 对三个文件独立缓存，漏改会导致「HTML 已更新、JS/CSS 仍是旧缓存」的版本错配 → 视图崩坏（左栏空白 / 任务条不渲染）。

1. `index.html` 里 `styles.css?v=X.XX`
2. `index.html` 里 `app.js?v=X.XX`
3. 可见构建戳 `<span class="build-stamp">vX.XX · build YYYY-MM-DD HH:MM</span>`

构建时间用 `date "+%Y-%m-%d %H:%M"` 取，**不要手算**。改完 `cp index.html team_gantt.html`。

## 五、铁律：视觉改动必须真实浏览器验证，不能只看代码

本项目已多次出现「代码看着对、界面却没生效」（CSS 特异性覆盖、z-index 穿透、标签重叠），**只做静态检查会误报完成**。

标准验证流程：
```bash
# 起本地服务（file:// 下 app.js 不执行，页面为空，必须走 http）
python -m http.server 8899

# 真实 Chromium 验证（open 与 eval 必须串在同一条命令里，否则丢页面上下文）
agent-browser open "http://127.0.0.1:8899/index.html?nocache=$(date +%s)" && agent-browser eval "..."
```

要点：
- 页面启动有身份验证弹窗，先 `document.querySelector('.idn-skip-btn')?.click()`
- 用 `getBoundingClientRect()` **量坐标**判断重叠/溢出/对齐，不要靠肉眼估截图
- 部署后还要打开**线上** URL 复验一遍，别只验本地

## 六、UI 既有设计语言（改动时不要破坏）

- **占位条右侧上下双轨**：上轨 `top:2px` = 缺人徽标（`.vacant-badge`）；下轨 `bottom:2px` = 工期风险（`.ovr-tag` 超N周 / `.rt-late` 逾期未完，二者互斥共用下轨）。仅作用于 `.vacant-bar`，普通任务条的 `.ovr-tag` 保持垂直居中。
- **「超期」有两种标签**，别混淆：橙色 `.rt-late`「⚠ 逾期未完」（超排期未确认完成）、紫色 `.ovr-tag`「超N周」（超标准工期）。用户提「超期」时先量坐标确认是哪一个。
- **今天红线**：`.today-layer` 覆盖整个滚动画布，靠 `syncTodayLabel()` 里按 `scrollLeft` 施加 `clip-path: inset(0 0 0 Npx)` 裁剪，防止穿透冻结左栏。**不要改回单纯抬 z-index 的做法**（透明空隙仍会漏红线）。
- **负载热力带**：高 32px，色段 y 3..25 厚 22px，空隙标记贴底 1px。逐周「人数·占比」数字已于 v7.20 移除（改走 hover 提示），不要加回逐格数字。相关的 `.load-seg-note` / `.ll-cnt` / `.ll-sub` 样式保留但已无 DOM。
- **行关联**：左栏右缘蓝色锚线 + 时间轴左侧 42px 渐隐导轨，用于建立「左侧人名 ↔ 同行时间条」的视觉联系。
- 时间轴竖线层与 `.drop-guide`/`.drop-band` 的 `top` = 表头 54px + 热力带 32px = **86px**。改带高必须同步这三处。

## 七、云端数据（Supabase）

区分两类改动，**不要混做**：

| 改动类型 | 涉及 | 是否需要写云端 |
|---|---|---|
| 代码 / UI / 统计逻辑 | app.js、styles.css | ❌ 不需要，运行时自动作用于云端数据 |
| 真实成员/需求记录 | Supabase `snap` | ✅ 需要，走 `vfx-gantt-cloud-sync` 技能 |

运行时优先级：本地 seed → `applySnap()` 用云端覆盖 → 渲染。**云端优先于 seed。**
写云端前必须向用户展示确切 diff 并取得确认；`cloud_snap*.json` 含真实团队数据，禁止提交。

## 八、标准工作流

1. Grep/Read 定位（勿整读 app.js）
2. Edit 修改
3. `node --check app.js` + `git diff --check`
4. `cp index.html team_gantt.html` + `cmp -s` 确认一致
5. 同步三处版本号与构建戳
6. 真实浏览器几何验证（本地）
7. `git remote -v` 确认 SSH → commit → push
8. 线上核验：三处版本号 + 本轮特征字符串 + 浏览器几何复验
9. 追加工作日志到 `.workbuddy/memory/YYYY-MM-DD.md`

## 九、沟通与交付约定

- **先给结论**，再给必要证据；不复述过程、不铺垫。用户重视 token 成本。
- 表格汇总改动；方案对比给「方案1 vs 方案2 + 推荐项」。
- UI 变更以截图校验后才算完成。
- 失败连续 2 次立即停止重试，回头查项目既有约定（skill / 本文件 / 历史日志），**不要换工具反复试错**。
- 在穷尽项目内既有方案前，**不得输出**「没权限 / 需要你手动执行 / 请提供 token」这类结论——那属于任务未完成。

## 十、相关技能（动手前先读）

| 技能 | 用途 |
|---|---|
| `vfx-gantt-deploy` | 部署发布（SSH key、版本号、线上验收） |
| `vfx-gantt-cloud-sync` | 读写 Supabase 真实排期数据 |
| `web-visual-bug-hunt` | 排查「代码对但界面没生效」类视觉 bug |
| `agent-browser` | 真实浏览器验证 |
