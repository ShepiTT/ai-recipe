const db = require('./store/db');

/**
 * 从请求头解析 Bearer token。
 * 只认 Authorization 头，不接受 URL query —— query 会被浏览器历史、
 * 代理和访问日志记录下来，等于把会话凭证到处散播。
 */
function tokenOf(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** 获取当前登录用户（未登录返回 null） */
function currentUser(req) {
  return db.getSession(tokenOf(req));
}

/** 鉴权中间件：要求已登录，挂载 req.auth = { token, username, user } */
function requireAuth(req, res, next) {
  const session = currentUser(req);
  if (!session) return res.status(401).json({ error: '请先登录' });
  req.auth = session;
  next();
}

module.exports = { tokenOf, currentUser, requireAuth };
