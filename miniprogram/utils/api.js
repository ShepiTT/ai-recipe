const { BASE_URL, STORAGE } = require('./config');

/** wx.request 的 Promise 封装，统一带 token 与错误处理 */
function request(path, { method = 'GET', data, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync(STORAGE.TOKEN) || '';
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 180000, // 生成菜谱可能要一两分钟，别用默认的 60s
      success(res) {
        // 会话失效：清掉 token，让调用方决定是否重新登录
        if (res.statusCode === 401 && !path.startsWith('/api/auth')) {
          wx.removeStorageSync(STORAGE.TOKEN);
          return reject(new Error('登录已过期，请重新登录'));
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        reject(new Error((res.data && res.data.error) || `请求失败 (${res.statusCode})`));
      },
      fail(err) {
        // 最常见的两种：没开「不校验合法域名」、或后端没起来
        const msg = /url not in domain list/i.test(err.errMsg || '')
          ? '域名未配置：开发者工具里勾上「不校验合法域名」，或在小程序后台配置服务器域名'
          : `连不上服务器（${err.errMsg || '未知错误'}），检查 utils/config.js 里的 BASE_URL`;
        reject(new Error(msg));
      },
    });
  });
}

/* ---------- 登录 ---------- */

/** wx.login 拿 code */
function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error('微信登录失败：没拿到 code'))),
      fail: () => reject(new Error('微信登录失败')),
    });
  });
}

/**
 * 微信一键登录。服务端没配 AppID/AppSecret 时会返回 503，
 * 调用方据此回退到账号密码登录（开发阶段用）。
 */
async function loginByWeixin(nickname) {
  const code = await wxLoginCode();
  const data = await request('/api/auth/wx-login', {
    method: 'POST',
    data: { code, nickname },
    auth: false,
  });
  wx.setStorageSync(STORAGE.TOKEN, data.token);
  return data.user;
}

/** 账号密码登录 / 注册，开发阶段与网页版共用一套账号 */
async function loginByPassword(username, password, mode = 'login') {
  const data = await request(`/api/auth/${mode}`, {
    method: 'POST',
    data: { username, password },
    auth: false,
  });
  wx.setStorageSync(STORAGE.TOKEN, data.token);
  return data.user;
}

function logout() {
  request('/api/auth/logout', { method: 'POST', data: {} }).catch(() => {});
  wx.removeStorageSync(STORAGE.TOKEN);
}

/** 当前登录用户；未登录返回 null（不抛错，方便页面里判断） */
async function me() {
  if (!wx.getStorageSync(STORAGE.TOKEN)) return null;
  try {
    const { user } = await request('/api/auth/me');
    return user;
  } catch {
    return null;
  }
}

/* ---------- 业务接口 ---------- */

const api = {
  request,
  loginByWeixin,
  loginByPassword,
  logout,
  me,

  config: () => request('/api/config'),
  generate: (params) => request('/api/recipes/generate', { method: 'POST', data: params }),
  detail: (params) => request('/api/recipes/detail', { method: 'POST', data: params }),

  memory: () => request('/api/memory'),
  saveMemory: (patch) => request('/api/memory', { method: 'POST', data: patch }),
  feedback: (dish, action) => request('/api/feedback', { method: 'POST', data: { dish, action } }),

  cook: (payload) => request('/api/cook', { method: 'POST', data: payload }),
  history: () => request('/api/history'),
  historyDetail: (id) => request(`/api/history/${id}`),
  deleteHistory: (id) => request(`/api/history/${id}`, { method: 'DELETE' }),
  clearHistory: () => request('/api/history', { method: 'DELETE' }),

  keys: () => request('/api/keys'),
  saveKey: (provider, key) => request('/api/keys', { method: 'POST', data: { provider, key } }),
};

module.exports = api;
