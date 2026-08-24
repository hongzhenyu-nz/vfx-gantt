/**
 * VFX Gantt 企微 OAuth 身份认证云函数
 *
 * 部署平台：腾讯云 SCF（Serverless Cloud Function）+ API 网关触发器
 * 兼容：任何支持 Node.js 18+ 的 HTTP 函数计算平台（Vercel/Cloudflare Workers/Railway 等）
 *
 * ====== 流程 ======
 * 1. 前端跳转 → 企微OAuth授权URL（redirect_uri = 本函数地址/auth/callback）
 * 2. 用户在企微中确认 → 企微重定向到本函数 ?code=xxx&state=xxx
 * 3. 本函数用 code 换 access_token → 用 access_token + code 换 userid
 * 4. 用 userid 查姓名 → 重定向回前端 #wecom_auth=...（hash不经过服务器）
 *
 * ====== 环境变量（部署时配置）======
 * WECOM_CORP_ID     - 企业ID（企微管理后台 → 我的企业 → 企业信息）
 * WECOM_AGENT_ID    - 自建应用AgentId（应用管理 → 选择应用 → AgentId）
 * WECOM_AGENT_SECRET- 自建应用Secret（同上页面 → Secret）
 * FRONTEND_URL      - 前端地址，如 https://hongzhenyu-nz.github.io/vfx-gantt/
 *
 * ====== 企微管理后台配置 ======
 * 1. 创建「自建应用」（应用管理 → 创建应用）
 * 2. 设置「网页授权及JS-SDK」→ 可信域名填云函数的域名
 * 3. 权限开启「通讯录基本信息」
 * 4. 记下 CorpID / AgentId / Secret
 */

const https = require('https');

// ===== 工具函数 =====

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

/**
 * 企微 API：获取 access_token
 * GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=CORP_ID&corpsecret=SECRET
 */
async function getAccessToken(corpId, secret) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
  const json = await httpGet(url);
  if (json.errcode !== 0) {
    throw new Error(`gettoken failed: errcode=${json.errcode} errmsg=${json.errmsg}`);
  }
  return json.access_token;
}

/**
 * 企微 API：用 code 换 userid
 * GET https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?access_token=TOKEN&code=CODE
 */
async function getUserId(accessToken, code) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?access_token=${encodeURIComponent(accessToken)}&code=${encodeURIComponent(code)}`;
  const json = await httpGet(url);
  if (json.errcode !== 0) {
    throw new Error(`getuserinfo failed: errcode=${json.errcode} errmsg=${json.errmsg}`);
  }
  return json; // { userid: "xxx", ... }
}

/**
 * 企微 API：读取成员详情（拿中文姓名）
 * GET https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=TOKEN&userid=USERID
 */
async function getUserDetail(accessToken, userId) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${encodeURIComponent(accessToken)}&userid=${encodeURIComponent(userId)}`;
  const json = await httpGet(url);
  if (json.errcode !== 0) {
    throw new Error(`getuser failed: errcode=${json.errcode} errmsg=${json.errmsg}`);
  }
  return json; // { userid, name, department, mobile, ... }
}

// ===== 主入口（SCF / 通用 HTTP 函数）=====

exports.main_handler = async (event, context) => {
  // 兼容不同平台的入参格式
  const path = event.path || (event.requestContext && event.requestContext.path) || '';
  const method = event.httpMethod || (event.requestContext && event.requestContext.httpMethod) || 'GET';
  const query = event.queryStringParameters || event.query || {};

  // 根路径：健康检查 / 说明
  if (path === '/' || path === '') {
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'VFX Gantt Auth Service OK' };
  }

  // OAuth 回调入口
  if (path === '/auth/callback' && method === 'GET') {
    return handleCallback(query);
  }

  return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'not_found' }) };
};

// 也导出一个纯 Express/Koa 兼容的中间件函数
exports.handleCallback = handleCallback;

async function handleCallback(query) {
  const corpId = process.env.WECOM_CORP_ID || '';
  const secret = process.env.WECOM_AGENT_SECRET || '';
  const frontendUrl = process.env.FRONTEND_URL || 'https://hongzhenyu-nz.github.io/vfx-gantt/';

  // 校验必要配置
  if (!corpId || !secret) {
    return redirectWithError(frontendUrl, 'SERVER_MISCONFIGURED', '云函数缺少企微凭证配置（WECOM_CORP_ID / WECOM_AGENT_SECRET）');
  }

  const code = query.code;
  if (!code) {
    return redirectWithError(frontendUrl, 'NO_CODE', '企微授权回调缺少 code 参数');
  }

  try {
    // Step 1: 获取 access_token
    const accessToken = await getAccessToken(corpId, secret);

    // Step 2: 用 code 换 userid
    const userInfo = await getUserId(accessToken, code);
    const userId = userInfo.userid;

    if (!userId) {
      return redirectWithError(frontendUrl, 'NO_USERID', '未能获取你的企微账号');
    }

    // Step 3: 查成员详情（获取中文姓名）
    let userName = userId;
    try {
      const detail = await getUserDetail(accessToken, userId);
      userName = detail.name || userId;
    } catch (e) {
      // 获取详情失败时用 userid 作为显示名，不阻断流程
      console.warn('getUserDetail failed, using userid as name:', e.message);
    }

    // Step 4: 构造认证结果，通过 URL hash 传回前端（hash 不发送到服务器，安全）
    const authResult = {
      ok: true,
      userid: userId,
      name: userName,
      ts: Date.now()
    };
    const hashPayload = Buffer.from(JSON.stringify(authResult)).toString('base64url');

    // 重定向回前端，认证结果在 hash 中
    return {
      statusCode: 302,
      headers: {
        'Location': `${frontendUrl}#wecom_auth=${hashPayload}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      },
      body: ''
    };

  } catch (err) {
    console.error('wecom auth error:', err);
    return redirectWithError(frontendUrl, 'AUTH_FAILED', err.message);
  }
}

function redirectWithError(frontendUrl, code, message) {
  const errorPayload = Buffer.from(JSON.stringify({ ok: false, error: code, message })).toString('base64url');
  return {
    statusCode: 302,
    headers: {
      'Location': `${frontendUrl}#wecom_auth=${errorPayload}`,
      'Cache-Control': 'no-store'
    },
    body: ''
  };
}
