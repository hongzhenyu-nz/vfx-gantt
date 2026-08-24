/**
 * 本地测试服务器（开发调试用，不要用于生产）
 *
 * 用法：
 *   1. 复制 .env.example 为 .env 并填入企微凭证
 *   2. node test-local.js
 *   3. 访问 http://localhost:3456/ 确认服务正常
 *   4. 前端 index.html 里把 WECOM_AUTH_URL 改为 http://localhost:3456/auth/callback
 *
 * 注意：企微回调域名必须是 HTTPS 或公网可访问的地址。
 * 本地测试需要用 ngrok/frp 等工具做内网穿透。
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const { handleCallback } = require('./function');

const PORT = process.env.PORT || 3456;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS（本地开发用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // 模拟 SCF event 格式
    const event = {
      path: url.pathname,
      httpMethod: req.method,
      queryStringParameters: Object.fromEntries(url.searchParams)
    };

    if (url.pathname === '/' || url.pathname === '') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('VFX Gantt Auth Local Server OK');
      return;
    }

    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      const result = await handleCallback(event);
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🔐 VFX Gantt Auth 本地测试服务器`);
  console.log(`   地址：http://localhost:${PORT}`);
  console.log(`   回调：http://localhost:${PORT}/auth/callback?code=TEST_CODE`);
  console.log(`\n   按 Ctrl+C 停止\n`);

  // 环境变量检查
  const required = ['WECOM_CORP_ID', 'WECOM_AGENT_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.warn(`⚠️ 缺少环境变量: ${missing.join(', ')}`);
    console.warn(`   请创建 .env 文件并填入企微凭证（参考 .env.example）\n`);
  }
});
