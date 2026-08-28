const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
require('dotenv').config();

const api = require('./src/routes/api');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// 基础安全响应头（无第三方依赖）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// 用 ETag 协商缓存而不是 max-age：命中就回 304，几乎没开销，
// 但改完前端刷新一下就能看到新版本，不会被浏览器缓存卡住。
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * 首页单独处理：把 __ASSET_V__ 换成由 app.js / style.css 的修改时间算出的版本号。
 * 这样 HTML 一变，资源 URL 也跟着变，浏览器不可能拿到「新 HTML + 旧 JS」的错配组合
 * （那会让 initForm 抛错、登录表单退化成原生提交，页面被刷成 /?）。
 */
function assetVersion() {
  try {
    const stamp = ['app.js', 'style.css']
      .map((f) => fs.statSync(path.join(PUBLIC_DIR, f)))
      .map((st) => `${st.mtimeMs}-${st.size}`)
      .join('|');
    return crypto.createHash('sha1').update(stamp).digest('hex').slice(0, 8);
  } catch {
    return 'dev';
  }
}

function sendIndex(req, res, next) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf-8', (err, html) => {
    if (err) return next(err);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html.replaceAll('__ASSET_V__', assetVersion()));
  });
}

app.get('/', sendIndex);
app.get('/index.html', sendIndex);

app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: 0 }));

app.use('/api', api);

// 未匹配的 API 一律返回 JSON，避免前端拿到 HTML 解析失败
app.use('/api', (req, res) => res.status(404).json({ error: `接口不存在: ${req.method} ${req.originalUrl}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: err?.message || '服务器内部错误' });
});

// 被 require 时（如测试）只导出 app，由调用方决定何时监听
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`\n  🍳 AI 菜谱已启动: http://localhost:${PORT}\n`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n  正在关闭服务…');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = app;
