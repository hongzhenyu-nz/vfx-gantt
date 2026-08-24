# VFX Gantt 企微 OAuth 认证 - 部署指南

## 一、获取企微凭证（5 分钟）

### 1. 获取企业ID (CorpID)
1. 登录 [企微管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 左侧菜单 → **我的企业** → 滑到最底部 → **企业信息** → 点「企业信息」
3. 看到 **企业ID**（以 `ww` 开头）→ 复制

### 2. 创建自建应用 & 获取 AgentId / Secret
1. 左侧菜单 → **应用管理** → **自建** 标签 → **创建应用**
2. 填写：
   - 应用名称：`VFX甘特看板`（或你喜欢的名字）
   - 可见范围：选择你的团队/部门
   - 上传图标（可选）
3. 创建完成后进入应用详情页，记录：
   - **AgentId**（页面顶部显示）
   - **Secret** → 点「查看」→ 企微扫码验证后显示 → 复制

### 3. 配置网页授权域名
1. 在同一应用详情页 → 找到 **网页授权及JS-SDK**
2. 设置 **可信域名**：填你的云函数域名
   - 腾讯云 SCF 格式：`xxx.ap-guangzhou.app.tcloudbase.com` 或你的自定义域名
   - 需要配置 API 网关并绑定自定义域名，或使用云函数的默认访问地址
3. **重要**：企微要求域名必须通过 ICP 备案（国内）

### 4. 开启通讯录权限
1. 同一应用页 → **API权限** → 搜索「通讯录」
2. 开启 **「通讯录基本信息」** 权限（读取成员姓名、部门等）
3. 如果需要手机号，也开启「个人信息」相关权限

---

## 二、部署云函数

### 方案 A：腾讯云 SCF（推荐，同公司内网友好）

#### 2A-1. 创建云函数
1. 登录 [腾讯云 SCF 控制台](https://console.cloud.tencent.com/scf)
2. **新建函数** → 选择 **从模板创建** 或 **自定义创建**
3. 运行环境：**Node.js 18.x** 或更高
4. 函数代码：上传 `cloud-auth/function.js`
5. 入口函数：`main_handler`
6. 执行方法：**事件函数**

#### 2A-2. 配置环境变量
在函数配置 → 环境变量中添加：
| 变量名 | 值 |
|--------|-----|
| `WECOM_CORP_ID` | `wwxxxxxxxxx` |
| `WECOM_AGENT_SECRET` | `xxxxxxxxxxxxxxxxxxxx` |
| `FRONTEND_URL` | `https://hongzhenyu-nz.github.io/vfx-gantt/` |

#### 2A-3. 配置触发器（API 网关）
1. 触发器管理 → **创建触发器** → **API 网关触发器**
2. 方法：**GET**
3. 路径：`/auth/callback`
4. 部署后获得一个访问地址，如：
   `https://service-xxx.gz.apigw.tencentcs.com/release/auth/callback`

#### 2A-4. 回到企微管理后台
把上面获得的域名填入应用的 **网页授权可信域名**

### 方案 B：Vercel / Railway（海外平台，无需备案）

```bash
# Vercel
npm i -g vercel
cd cloud-auth
vercel

# Railway
# 在 railway.app 创建新项目，连接此 repo，设置环境变量即可
```

### 方案 C：任意 Node.js 服务器

```bash
cd cloud-auth
npm install dotenv
cp .env.example .env   # 编辑 .env 填入凭证
node test-local.js      # 本地测试（需 ngrok 穿透给企微回调）
```

---

## 三、前端配置

部署完云函数、拿到回调 URL 后，编辑 `index.html`：

```javascript
// 找到 WECOM_AUTH_CONFIG 对象（约第 6890 行附近），填入：

const WECOM_AUTH_CONFIG = {
  // 企微 OAuth 授权URL参数
  corpId: 'wwxxxxxxxxx',           // 企业ID（与云函数的一致）
  agentId: '100000x',              // 应用AgentId
  redirectUri: 'https://你的云函数域名/auth/callback',  // 云函数回调地址
  scope: 'snsapi_base',            // snsapi_base=静默(只有userid) / snsapi_userinfo=弹出授权(有姓名)
  state: 'vfxgantt-auth',          // 防CSRF状态码

  // 云函数地址（用于前端直接调用辅助接口，可选）
  authEndpoint: 'https://你的云函数域名'
};
```

> **提示**：如果用 `snsapi_base`（静默授权），用户无感知自动跳转，但只能拿到 userid；
> 用 `snsapi_userinfo` 会弹一次授权窗，能直接拿到姓名。推荐先用 `snsapi_base`，
> 姓名由云函数通过 access_token + userid 二次查询获取。

---

## 四、安全注意事项

1. **Secret 保密**：不要提交到 Git 仓库，通过环境变量注入
2. **HTTPS 必须**：企微回调只接受 HTTPS（本地开发需内网穿透+HTTPS）
3. **Token 缓存**：生产环境应缓存 access_token（7200秒有效期），避免频繁调用
4. **State 校验**：生产环境应生成随机 state 并校验回调中的 state，防 CSRF
5. **Hash 传输**：认证结果通过 URL hash（#）传回前端，不会发送到服务器

---

## 五、故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 回调报 `redirect_uri_mismatch` | 可信域名没配对 | 检查企微后台填的域名与实际回调 URL 的域名是否完全一致 |
| 报 `invalid code` | code 已使用或过期 | code 只能用一次，且 5 分钟过期 |
| 报 `errcode=40013` | CorpID 不对 | 检查环境变量 WECOM_CORP_ID |
| 报 `errcode=60020` | access_token 不对 | 检查 AgentSecret 是否正确 |
| 能跳转但前端没反应 | hash 没被解析 | 检查浏览器控制台是否有 `wecom_auth` 相关日志 |
