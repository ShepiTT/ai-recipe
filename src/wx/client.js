/**
 * 微信小程序服务端接口封装：登录换 openid + 内容安全检测。
 * AppID / AppSecret 从环境变量读，没配就明确报错，不要静默放行。
 */
require('dotenv').config();

const API = 'https://api.weixin.qq.com';

function appConfig() {
  const appid = (process.env.WX_APPID || '').trim();
  const secret = (process.env.WX_SECRET || '').trim();
  return { appid, secret, ready: Boolean(appid && secret) };
}

function isConfigured() {
  return appConfig().ready;
}

async function getJSON(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`微信接口 HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('微信接口超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 微信错误码翻译成能看懂的话 */
function wxError(data, fallback) {
  const code = data?.errcode;
  const map = {
    40013: 'AppID 不正确，请检查 WX_APPID',
    40125: 'AppSecret 不正确，请检查 WX_SECRET',
    40029: '登录凭证 code 无效或已被使用（code 只能用一次）',
    45011: '请求过于频繁，请稍后再试',
    40226: '该用户被判定为高风险，登录被拦截',
  };
  return new Error(map[code] || `${fallback}（errcode=${code}, ${data?.errmsg || '未知错误'}）`);
}

/* ================= 登录 ================= */

/**
 * 用小程序端 wx.login 拿到的 code 换 openid。
 * session_key 涉及用户数据解密，这里用不到就不返回，避免多存一份敏感信息。
 */
async function code2session(code) {
  const { appid, secret, ready } = appConfig();
  if (!ready) throw new Error('服务端未配置 WX_APPID / WX_SECRET，无法使用微信登录');
  if (!code) throw new Error('缺少登录凭证 code');

  const url = `${API}/sns/jscode2session?appid=${encodeURIComponent(appid)}`
    + `&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const data = await getJSON(url);
  if (!data.openid) throw wxError(data, '微信登录失败');
  return { openid: data.openid, unionid: data.unionid || '' };
}

/* ================= access_token ================= */

// access_token 有效期 7200 秒且有调用频次限制，必须缓存复用
let tokenCache = { value: '', expireAt: 0 };
let tokenPending = null;

async function getAccessToken(force = false) {
  const { appid, secret, ready } = appConfig();
  if (!ready) throw new Error('服务端未配置 WX_APPID / WX_SECRET');
  if (!force && tokenCache.value && Date.now() < tokenCache.expireAt) return tokenCache.value;
  // 并发请求时只发一次，其余等同一个 promise
  if (tokenPending) return tokenPending;

  tokenPending = (async () => {
    const url = `${API}/cgi-bin/token?grant_type=client_credential`
      + `&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
    const data = await getJSON(url);
    if (!data.access_token) throw wxError(data, '获取 access_token 失败');
    // 提前 5 分钟过期，避免边界上用到失效的 token
    tokenCache = { value: data.access_token, expireAt: Date.now() + (data.expires_in - 300) * 1000 };
    return tokenCache.value;
  })().finally(() => { tokenPending = null; });

  return tokenPending;
}

/* ================= 内容安全 ================= */

const SCENE = { PROFILE: 1, COMMENT: 2, FORUM: 3, SOCIAL: 4 };

/**
 * 文本内容安全检测（msgSecCheck v2）。
 * 微信要求有用户输入的小程序必须接，不接大概率审核驳回。
 * 返回 { pass, label, reason }；label 见微信文档（100 正常，其余为违规类型）。
 */
async function checkText(content, { openid, scene = SCENE.COMMENT, retried = false } = {}) {
  const text = String(content || '').trim();
  if (!text) return { pass: true, label: 100, reason: '' };
  // 微信限制单次 2500 字，超出就截断检测
  const body = {
    content: text.slice(0, 2500),
    version: 2,
    scene,
    openid,
  };

  const token = await getAccessToken();
  const data = await getJSON(`${API}/wxa/msg_sec_check?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // token 过期：刷新后重试一次
  if ((data.errcode === 40001 || data.errcode === 42001) && !retried) {
    await getAccessToken(true);
    return checkText(content, { openid, scene, retried: true });
  }
  if (data.errcode && data.errcode !== 0) throw wxError(data, '内容安全检测失败');

  const suggest = data.result?.suggest || 'pass';
  return {
    pass: suggest === 'pass',
    label: data.result?.label ?? 100,
    reason: suggest === 'risky' ? '内容涉嫌违规' : suggest === 'review' ? '内容需人工复审' : '',
  };
}

/**
 * 批量检测多段文本，任意一段不通过就整体不通过。
 * 用于「生成菜谱」这种一次提交多个字段（口味、额外要求、昵称）的场景。
 */
async function checkTexts(list, options) {
  for (const text of list.filter(Boolean)) {
    const result = await checkText(text, options);
    if (!result.pass) return result;
  }
  return { pass: true, label: 100, reason: '' };
}

module.exports = {
  SCENE,
  isConfigured, appConfig,
  code2session, getAccessToken,
  checkText, checkTexts,
};
