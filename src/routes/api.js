const express = require('express');
const { PROVIDERS, getProvider, resolveModel, supportsThinking, getApiKey, isMockMode } = require('../config');
const { requireAuth, tokenOf } = require('../auth');
const db = require('../store/db');
const { chatJSON } = require('../llm/client');
const recipe = require('../services/recipe');
const detail = require('../services/detail');
const pantry = require('../services/pantry');
const wx = require('../wx/client');

const router = express.Router();

/* ================= 通用工具 ================= */

/** 把 async 路由的异常统一转成 JSON 错误响应 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

/** 简易登录失败节流：同一用户名 10 分钟内最多 8 次失败 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const loginFails = new Map(); // username -> { count, first }

function loginBlocked(name) {
  const rec = loginFails.get(name);
  if (!rec) return 0;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginFails.delete(name);
    return 0;
  }
  if (rec.count < LOGIN_MAX_FAILS) return 0;
  return Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rec.first)) / 60000);
}

function noteLoginFail(name) {
  const rec = loginFails.get(name);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) loginFails.set(name, { count: 1, first: Date.now() });
  else rec.count += 1;
}

/* ================= 健康检查 ================= */

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    mockMode: isMockMode(),
    providers: Object.keys(PROVIDERS),
    version: require('../../package.json').version,
  });
});

/* ================= 账号 ================= */

router.post('/auth/register', (req, res) => {
  try {
    const user = db.createUser({ username: req.body?.username, password: req.body?.password });
    const token = db.createSession(user.username);
    res.json({ token, user });
  } catch (err) {
    fail(res, 400, err.message || '注册失败');
  }
});

router.post('/auth/login', (req, res) => {
  try {
    const name = String(req.body?.username || '').trim().toLowerCase();
    const wait = loginBlocked(name);
    if (wait) return fail(res, 429, `登录失败次数过多，请 ${wait} 分钟后再试`);

    const user = db.verifyUser(name, req.body?.password);
    if (!user) {
      noteLoginFail(name);
      return fail(res, 401, '用户名或密码错误');
    }
    loginFails.delete(name);
    const token = db.createSession(user.username);
    res.json({ token, user });
  } catch (err) {
    fail(res, 400, err.message || '登录失败');
  }
});

router.post('/auth/logout', (req, res) => {
  db.deleteSession(tokenOf(req));
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  const session = db.getSession(tokenOf(req));
  if (!session) return fail(res, 401, '未登录');
  res.json({ user: db.publicUser(session.user) });
});

/**
 * 微信小程序登录：小程序端 wx.login 拿 code，这里换 openid 并建/取用户。
 * 返回结构与账号密码登录一致，后续接口共用同一套 Bearer token。
 */
router.post('/auth/wx-login', wrap(async (req, res) => {
  if (!wx.isConfigured()) return fail(res, 503, '服务端未配置微信小程序 AppID / AppSecret');
  try {
    const { openid } = await wx.code2session(req.body?.code);
    const nickname = String(req.body?.nickname || '').slice(0, 24);
    const user = db.upsertWxUser(openid, { nickname });
    const token = db.createSession(user.username);
    res.json({ token, user });
  } catch (err) {
    fail(res, 401, err.message || '微信登录失败');
  }
}));

// 修改密码：成功后所有旧会话失效，需要重新登录
router.post('/auth/password', requireAuth, (req, res) => {
  try {
    db.changePassword(req.auth.username, req.body?.oldPassword, req.body?.newPassword);
    res.json({ ok: true });
  } catch (err) {
    fail(res, 400, err.message || '修改密码失败');
  }
});

/* ================= 每用户 API Key ================= */

router.get('/keys', requireAuth, (req, res) => {
  const pub = db.publicUser(db.getUser(req.auth.username));
  res.json({ hasKeys: pub.hasKeys, maskedKeys: pub.maskedKeys });
});

router.post('/keys', requireAuth, (req, res) => {
  try {
    const provider = getProvider(req.body?.provider);
    const key = String(req.body?.key ?? '');
    // 允许空串（表示清除），否则要求是不含空格的可见 ASCII 字符串
    if (key && !/^[\x21-\x7e]{8,200}$/.test(key)) {
      return fail(res, 400, 'Key 格式不正确（应为 8-200 位不含空格的字符串）');
    }
    const pub = db.setKey(req.auth.username, provider, key);
    res.json({ ok: true, provider, hasKeys: pub.hasKeys, maskedKeys: pub.maskedKeys });
  } catch (err) {
    fail(res, 400, err.message || '保存失败');
  }
});

/* ================= 配置 ================= */

const TASTE_OPTIONS = ['麻辣', '香辣', '清淡', '咸鲜', '偏甜', '酸辣', '蒜香', '酱香', '清蒸原味', '孜然', '咖喱', '酸甜'];

function userHasKey(username, provider) {
  return Boolean(db.getRawKey(username, provider)) || Boolean(getApiKey(provider));
}

router.get('/config', requireAuth, (req, res) => {
  const username = req.auth.username;
  const providers = Object.entries(PROVIDERS).map(([key, p]) => ({
    key,
    label: p.label,
    models: p.models.map((m) => ({ id: m.id, label: m.label, context: m.context, thinking: Boolean(m.thinking) })),
    hasKey: userHasKey(username, key),
  }));
  res.json({
    providers,
    defaultProvider: getProvider(),
    mockMode: isMockMode() && !providers.some((p) => p.hasKey),
    tastes: TASTE_OPTIONS,
    mealTypes: Object.entries(recipe.MEAL_TYPE_LABELS).map(([key, label]) => ({ key, label })),
    mealSlots: recipe.MEAL_SLOTS,
    wxLogin: wx.isConfigured(),
  });
});

// 演示模式判定：该服务商完全没有可用 Key，且显式开启 MOCK_MODE
function isDemo(provider, apiKey) {
  return !apiKey && !getApiKey(provider) && isMockMode();
}

/**
 * 用户输入的内容安全检测。
 * 只对微信用户生效（网页版没有 openid，微信接口也要求传 openid）；
 * 未配置 AppID 时直接放行，方便本地开发。
 */
async function guardText(req, texts) {
  if (!wx.isConfigured()) return null;
  const user = db.getUser(req.auth.username);
  if (!user?.openid) return null;
  const result = await wx.checkTexts(texts, { openid: user.openid });
  return result.pass ? null : (result.reason || '内容不合规');
}

/** 归一化并校验生成参数 */
function readPlanParams(body) {
  return {
    people: Math.min(Math.max(parseInt(body.people) || 2, 1), 30),
    days: Math.min(Math.max(parseInt(body.days) || 1, 1), 7),
    tastes: Array.isArray(body.tastes) ? body.tastes.filter(Boolean).map((t) => String(t).slice(0, 20)).slice(0, 6) : [],
    mealType: ['banquet', 'family', 'simple'].includes(body.mealType) ? body.mealType : 'family',
    meals: recipe.normalizeMeals(body.meals ?? body.mealsPerDay),
    extra: String(body.extra || '').slice(0, 300),
    // 可选：带上现有食材，菜单会围绕它们设计，采购清单只列还需补买的
    ingredients: [...new Set(
      (Array.isArray(body.ingredients) ? body.ingredients : [])
        .map((x) => String(x).trim().slice(0, 20)).filter(Boolean)
    )].slice(0, 30),
  };
}

/* ================= 菜谱生成 ================= */

router.post('/recipes/generate', requireAuth, wrap(async (req, res) => {
  const username = req.auth.username;
  const useMemory = req.body.useMemory !== false;
  const provider = getProvider(req.body.provider);
  const model = resolveModel(provider, req.body.model);
  const apiKey = db.getRawKey(username, provider);
  // 深度思考默认关闭：配菜任务用不上链式推理，开了只是更慢更贵
  const thinking = req.body.thinking === true && supportsThinking(provider, model);
  const profile = useMemory ? db.getProfile(username) : null;

  const base = readPlanParams(req.body);
  const blocked = await guardText(req, [base.extra, ...base.tastes, ...base.ingredients]);
  if (blocked) return fail(res, 400, blocked);

  // 未手动勾选口味时，沿用记忆里的偏好
  const params = { ...base, tastes: base.tastes.length ? base.tastes : (profile?.tastePrefs || []) };

  const startedAt = Date.now();
  let plan;
  try {
    plan = isDemo(provider, apiKey)
      ? Object.assign(recipe.normalizePlan(recipe.mockPlan(params), params), { mock: true })
      : await recipe.generatePlan(params, { provider, model, apiKey, thinking, chatJSON }, profile);
  } catch (err) {
    return fail(res, 502, err.message || '生成失败');
  }
  plan.meta = { ...plan.meta, provider, model, thinking, elapsedMs: Date.now() - startedAt };

  // 关闭记忆时不写入历史，保持「无痕生成」
  if (!useMemory) return res.json(plan);

  const { id } = db.addHistory({
    title: plan.title,
    people: params.people,
    days: plan.days.length,
    mealType: recipe.MEAL_TYPE_LABELS[params.mealType],
    mealTypeKey: params.mealType,
    tastes: params.tastes,
    meals: params.meals,
    dishes: recipe.collectDishNames(plan),
    plan,
  }, username);

  res.json({ ...plan, historyId: id });
}));

/* ================= 按食材找菜 ================= */

/**
 * 「我有这些食材，能做什么」。
 * 与 /recipes/generate 的区别：那个从需求出发排菜单，这个从库存出发列可选的菜。
 */
router.post('/recipes/by-ingredients', requireAuth, wrap(async (req, res) => {
  const username = req.auth.username;
  const ingredients = [...new Set(
    (Array.isArray(req.body.ingredients) ? req.body.ingredients : [])
      .map((x) => String(x).trim().slice(0, 20))
      .filter(Boolean)
  )].slice(0, 30);
  if (!ingredients.length) return fail(res, 400, '至少填一样食材');

  const blocked = await guardText(req, ingredients.concat(String(req.body.extra || '')));
  if (blocked) return fail(res, 400, blocked);

  const useMemory = req.body.useMemory !== false;
  const provider = getProvider(req.body.provider);
  const model = resolveModel(provider, req.body.model);
  const apiKey = db.getRawKey(username, provider);
  const thinking = req.body.thinking === true && supportsThinking(provider, model);
  const profile = useMemory ? db.getProfile(username) : null;

  const params = {
    ingredients,
    people: Math.min(Math.max(parseInt(req.body.people) || 2, 1), 30),
    strict: req.body.strict === true,
    tastes: Array.isArray(req.body.tastes) ? req.body.tastes.slice(0, 6) : [],
    extra: String(req.body.extra || '').slice(0, 300),
  };

  const startedAt = Date.now();
  try {
    const result = isDemo(provider, apiKey)
      ? Object.assign(pantry.normalizePantry(pantry.mockPantry(params), params), { mock: true })
      : await pantry.generateByIngredients(params, { provider, model, apiKey, thinking, chatJSON }, profile);
    result.meta = { ...result.meta, provider, model, elapsedMs: Date.now() - startedAt };
    res.json(result);
  } catch (err) {
    return fail(res, 502, err.message || '推荐失败');
  }
}));

/* ================= 菜品详情 ================= */

router.post('/recipes/detail', requireAuth, wrap(async (req, res) => {
  const username = req.auth.username;
  const dish = String(req.body.dish || '').slice(0, 50).trim();
  if (!dish) return fail(res, 400, '缺少菜名');

  const people = Math.min(Math.max(parseInt(req.body.people) || 2, 1), 30);
  const provider = getProvider(req.body.provider);
  const model = resolveModel(provider, req.body.model);
  const apiKey = db.getRawKey(username, provider);
  const thinking = req.body.thinking === true && supportsThinking(provider, model);

  if (isDemo(provider, apiKey)) {
    return res.json({ ...detail.mockDetail({ dish, people }), mock: true });
  }
  try {
    const result = await detail.generateDishDetail(
      {
        dish,
        people,
        tastes: Array.isArray(req.body.tastes) ? req.body.tastes.slice(0, 6) : [],
        mealType: recipe.MEAL_TYPE_LABELS[req.body.mealType] || '',
        context: String(req.body.context || '').slice(0, 200),
        provider, model, apiKey, thinking,
      },
      { chatJSON },
      db.getProfile(username)
    );
    res.json(result);
  } catch (err) {
    fail(res, 502, err.message || '获取详情失败');
  }
}));

/* ================= 记忆 / 反馈 / 历史（按用户隔离） ================= */

router.get('/memory', requireAuth, (req, res) => res.json(db.publicProfile(db.getProfile(req.auth.username))));

router.post('/memory', requireAuth, wrap(async (req, res) => {
  const body = req.body || {};
  const blocked = await guardText(req, [
    body.nickname,
    ...(Array.isArray(body.allergies) ? body.allergies : []),
    ...(Array.isArray(body.tastePrefs) ? body.tastePrefs : []),
    ...(Array.isArray(body.dislikedTastes) ? body.dislikedTastes : []),
  ]);
  if (blocked) return fail(res, 400, blocked);
  try {
    res.json(db.publicProfile(db.updateProfile(body, req.auth.username)));
  } catch (err) {
    fail(res, 400, err.message || '保存失败');
  }
}));

router.post('/feedback', requireAuth, (req, res) => {
  try {
    const dish = String(req.body.dish || '').trim().slice(0, 40);
    const action = String(req.body.action || '');
    if (!dish) return fail(res, 400, '缺少菜名');
    res.json(db.publicProfile(db.feedback({ dish, action }, req.auth.username)));
  } catch (err) {
    fail(res, 400, err.message || '操作失败');
  }
});

/**
 * 记录本次真正做了哪些菜。
 * 生成菜单只是「看过」，用户在结果里勾选确认的才写进「最近做过」，
 * 后续生成据此避重，不会被一堆没做过的菜污染。
 */
router.post('/cook', requireAuth, (req, res) => {
  try {
    const dishes = Array.isArray(req.body?.dishes) ? req.body.dishes : [];
    const historyId = req.body?.historyId ? String(req.body.historyId).slice(0, 40) : '';
    // 先校验再截断，避免把 '2026-09-01T10:00' 悄悄削成合法值
    const startDate = String(req.body?.startDate || '').slice(0, 32);
    if (startDate && !db.isDateOnly(startDate)) return fail(res, 400, '开始日期格式应为 YYYY-MM-DD');
    const picks = Array.isArray(req.body?.picks) ? req.body.picks : null;
    res.json(db.publicProfile(db.markCooked({ dishes, picks, historyId, startDate }, req.auth.username)));
  } catch (err) {
    fail(res, 400, err.message || '保存失败');
  }
});

// 历史列表（默认不带完整菜单快照，减小传输体积）
router.get('/history', requireAuth, (req, res) => {
  res.json(db.publicProfile(db.getProfile(req.auth.username)).history);
});

// 回看某次生成的完整菜单
router.get('/history/:id', requireAuth, (req, res) => {
  const entry = db.getHistoryEntry(req.params.id, req.auth.username);
  if (!entry) return fail(res, 404, '记录不存在');
  if (!entry.plan) return fail(res, 410, '这条记录太久远，完整菜单已归档，仅保留菜名摘要');
  res.json({
    ...entry.plan,
    historyId: entry.id,
    fromHistory: true,
    cooked: entry.cooked || [],
    picks: entry.picks || [],
    startDate: entry.startDate || '',
  });
});

router.delete('/history/:id', requireAuth, (req, res) => {
  try {
    res.json(db.publicProfile(db.deleteHistory(req.params.id, req.auth.username)));
  } catch (err) {
    fail(res, 404, err.message || '删除失败');
  }
});

router.delete('/history', requireAuth, (req, res) => {
  try {
    res.json(db.publicProfile(db.clearHistory(req.auth.username)));
  } catch (err) {
    fail(res, 400, err.message || '清空失败');
  }
});

module.exports = router;
