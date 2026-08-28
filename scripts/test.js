/**
 * 零依赖自测：纯函数 + 真实 HTTP 接口。
 * 用法：npm test
 * 会在系统临时目录建一个独立的 db.json，不会碰你的真实数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-recipe-test-')), 'db.json');
process.env.AI_RECIPE_DB = TMP_DB;
process.env.MOCK_MODE = '1';
process.env.DEEPSEEK_API_KEY = '';
process.env.QWEN_API_KEY = '';
process.env.PORT = '0';

let passed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name + (extra ? ` → ${JSON.stringify(extra)}` : ''));
    console.log(`  ✗ ${name}${extra ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function group(title) {
  console.log(`\n${title}`);
}

async function main() {
  /* ===== 1. JSON 提取 ===== */
  const { extractJSON } = require('../src/llm/client');
  group('llm/client · extractJSON');
  eq('纯 JSON', extractJSON('{"a":1}'), { a: 1 });
  eq('markdown 代码块', extractJSON('```json\n{"a":1}\n```'), { a: 1 });
  eq('前后有解释文字', extractJSON('好的，结果：{"a":1}。以上。'), { a: 1 });
  eq('字符串里含括号', extractJSON('{"b":"}"}'), { b: '}' });
  eq('数组', extractJSON('```\n[1,2,3]\n```'), [1, 2, 3]);
  ok('非法 JSON 抛错', (() => { try { extractJSON('not json at all'); return false; } catch { return true; } })());

  /* ===== 2. 菜谱归一化 ===== */
  const recipe = require('../src/services/recipe');
  group('services/recipe · normalizePlan');
  const messy = {
    title: '  测试菜单  ',
    days: [
      { day: 5, meals: [{ type: '午餐', dishes: ['红烧肉', { name: '青菜', category: '素菜' }, { noName: 1 }] }] },
      { meals: [] },                       // 空餐次的一天应被丢弃
      { meals: [{ dishes: [{ name: '汤' }] }] },
    ],
    shoppingList: ['盐', { name: '米', amount: '2kg', category: '米面豆制品' }, null],
    tips: '提前腌制',
  };
  const plan = recipe.normalizePlan(messy, { people: 4, mealType: 'family' });
  eq('标题去空格', plan.title, '测试菜单');
  eq('丢弃空的一天并重排天数', plan.days.map((d) => d.day), [1, 2]);
  eq('字符串菜品被补全结构', plan.days[0].meals[0].dishes[0], { name: '红烧肉', category: '菜品', brief: '' });
  eq('无名菜品被丢弃', plan.days[0].meals[0].dishes.length, 2);
  eq('餐次缺 type 时按所选餐次补', plan.days[1].meals[0].type, '午餐');
  eq('采购项归一化', plan.shoppingList.length, 2);
  eq('tips 字符串转数组', plan.tips, ['提前腌制']);
  eq('meta 带上人数', plan.meta.people, 4);
  ok('全空菜单抛错', (() => { try { recipe.normalizePlan({}, {}); return false; } catch { return true; } })());

  group('services/recipe · 餐次自由组合');
  eq('默认午+晚', recipe.normalizeMeals(undefined), ['lunch', 'dinner']);
  eq('保持早→中→晚顺序', recipe.normalizeMeals(['dinner', 'breakfast']), ['breakfast', 'dinner']);
  eq('去重', recipe.normalizeMeals(['lunch', 'lunch']), ['lunch']);
  eq('全空时兜底', recipe.normalizeMeals([]), ['lunch', 'dinner']);
  eq('丢弃非法槽位', recipe.normalizeMeals(['brunch', 'dinner']), ['dinner']);
  eq('兼容旧的 all', recipe.normalizeMeals('all'), ['breakfast', 'lunch', 'dinner']);
  eq('兼容旧的 lunch-dinner', recipe.normalizeMeals('lunch-dinner'), ['lunch', 'dinner']);
  eq('只做晚餐', recipe.mockPlan({ days: 1, meals: ['dinner'] }).days[0].meals.map((m) => m.type), ['晚餐']);
  eq('早+晚跳过午餐', recipe.mockPlan({ days: 1, meals: ['breakfast', 'dinner'] }).days[0].meals.map((m) => m.type), ['早餐', '晚餐']);
  eq('只做午餐', recipe.mockPlan({ days: 1, meals: ['lunch'] }).days[0].meals.map((m) => m.type), ['午餐']);
  const oneMeal = recipe.normalizePlan(recipe.mockPlan({ days: 2, meals: ['dinner'] }), { meals: ['dinner'] });
  eq('归一化后每天只剩一餐', oneMeal.days.map((d) => d.meals.length), [1, 1]);
  eq('meta 记录所选餐次', oneMeal.meta.meals, ['dinner']);

  group('services/recipe · mockPlan');
  const mock = recipe.mockPlan({ people: 6, days: 3, mealType: 'banquet', meals: ['breakfast', 'lunch', 'dinner'] });
  eq('天数正确', mock.days.length, 3);
  eq('三餐模式', mock.days[0].meals.map((m) => m.type), ['早餐', '午餐', '晚餐']);
  ok('宴席菜品够丰盛', mock.days[0].meals[1].dishes.length >= 6, mock.days[0].meals[1].dishes.length);
  ok('简餐够精简', recipe.mockPlan({ people: 2, days: 1, mealType: 'simple' }).days[0].meals[0].dishes.length <= 3);
  ok('采购清单按人数换算', mock.shoppingList.some((i) => /kg|g|个|份/.test(i.amount)), mock.shoppingList[0]);
  ok('采购清单已分类', mock.shoppingList.every((i) => i.category), mock.shoppingList.find((i) => !i.category));
  const names = recipe.collectDishNames(mock);
  ok('菜名汇总去重', names.length === new Set(names).size);

  group('services/recipe · 提示词');
  const prompt = recipe.buildUserPrompt(
    { people: 8, days: 2, tastes: ['麻辣'], mealType: 'banquet', mealsPerDay: 'all', extra: '不要香菜' },
    { allergies: ['花生'], dislikedDishes: ['苦瓜'] }
  );
  ok('提示词含人数', prompt.includes('8 人'));
  ok('提示词含忌口', prompt.includes('花生'));
  ok('提示词含不喜欢的菜', prompt.includes('苦瓜'));
  ok('提示词含额外要求', prompt.includes('不要香菜'));

  /* ===== 2.6 按食材找菜 ===== */
  const pantry = require('../src/services/pantry');
  group('services/pantry · 按食材找菜');
  const ing = ['白菜', '鸡蛋', '豆腐', '猪肉'];
  const pr = pantry.normalizePantry(pantry.mockPantry({ ingredients: ing }), { ingredients: ing, people: 2 });
  ok('能推出菜', pr.dishes.length > 0, pr.dishes.length);
  ok('每道菜都用到了我的食材', pr.dishes.every((d) => d.uses.length > 0));
  ok('uses 只含我真有的', pr.dishes.every((d) => d.uses.every((u) => ing.includes(u))));
  ok('不用再买的排在前面', pr.dishes[0].ready);
  eq('unused 列出没用上的', pr.unused, []);

  group('services/pantry · normalizePantry 兜底');
  const messyPantry = pantry.normalizePantry({
    dishes: [
      { name: '番茄炒蛋', uses: ['鸡蛋', '番茄'], missing: ['盐', '食用油', '香油'] },
      { name: '白菜汤', uses: ['白菜', '高汤'], missing: [] },
      { noName: 1 },
    ],
  }, { ingredients: ['鸡蛋', '白菜'] });
  eq('无名菜品被丢弃', messyPantry.dishes.length, 2);
  const tomato = messyPantry.dishes.find((d) => d.name === '番茄炒蛋');
  eq('对不上的 uses 不算数（番茄我没有）', tomato.uses, ['鸡蛋']);
  ok('基础调料不算缺料', !tomato.missing.some((m) => m === '盐' || m === '食用油'), tomato.missing);
  ok('非基础的缺料保留', tomato.missing.includes('香油'));
  ok('模型瞎写的 uses 被挪进 missing', tomato.missing.includes('番茄'));
  const soup = messyPantry.dishes.find((d) => d.name === '白菜汤');
  ok('高汤不在我的食材里，挪到缺料', soup.missing.includes('高汤'));
  ok('因此它不算「现在就能做」', !soup.ready);

  group('services/pantry · 严格模式');
  const strictParams = { ingredients: ['鸡蛋', '番茄'], strict: true };
  const sp = pantry.normalizePantry(pantry.mockPantry(strictParams), strictParams);
  ok('严格模式下每道都不缺料', sp.dishes.every((d) => d.ready && d.missing.length === 0));
  ok('凑不出时明确报错', (() => {
    try {
      pantry.normalizePantry({ dishes: [{ name: 'X', uses: [], missing: ['牛肉'] }] }, { ingredients: ['盐'], strict: true });
      return false;
    } catch (e) { return e.message.includes('只用现有食材'); }
  })());

  /* ===== 2.5 模型解析与旧 ID 迁移 ===== */
  const config = require('../src/config');
  group('config · 模型解析');
  eq('现役 DeepSeek 模型原样返回', config.resolveModel('deepseek', 'deepseek-v4-pro'), 'deepseek-v4-pro');
  eq('已下线的 deepseek-chat 迁移到 V4-Flash', config.resolveModel('deepseek', 'deepseek-chat'), 'deepseek-v4-flash');
  eq('已下线的 deepseek-reasoner 迁移到 V4-Flash', config.resolveModel('deepseek', 'deepseek-reasoner'), 'deepseek-v4-flash');
  eq('旧 qwen-max 迁移到 3.8-Max', config.resolveModel('qwen', 'qwen-max'), 'qwen3.8-max');
  eq('旧 qwen-turbo 迁移到 3.7-Flash', config.resolveModel('qwen', 'qwen-turbo'), 'qwen3.7-flash');
  eq('跨服务商的旧 ID 不会串台', config.resolveModel('qwen', 'deepseek-chat'), 'qwen3.7-plus');
  eq('完全未知的 ID 回退推荐款', config.resolveModel('deepseek', 'gpt-9'), 'deepseek-v4-flash');
  eq('空值回退推荐款', config.resolveModel('qwen', ''), 'qwen3.7-plus');
  ok('现役模型都支持深度思考', config.supportsThinking('deepseek', 'deepseek-v4-pro') && config.supportsThinking('qwen', 'qwen3.8-max'));
  ok('未知模型不报支持思考', !config.supportsThinking('deepseek', 'deepseek-chat'));

  group('llm/client · 深度思考参数');
  const { thinkingParams } = require('../src/llm/client');
  eq('DeepSeek 开启', thinkingParams(config.PROVIDERS.deepseek, true), { thinking: { type: 'enabled' } });
  eq('DeepSeek 关闭需显式发出', thinkingParams(config.PROVIDERS.deepseek, false), { thinking: { type: 'disabled' } });
  eq('Qwen 开启', thinkingParams(config.PROVIDERS.qwen, true), { enable_thinking: true });
  eq('Qwen 默认开启，必须显式关掉', thinkingParams(config.PROVIDERS.qwen, false), { enable_thinking: false });

  /* ===== 3. 详情归一化 ===== */
  const detail = require('../src/services/detail');
  group('services/detail · normalizeDetail');
  const d = detail.normalizeDetail(
    { steps: '1. 洗菜\n2. 下锅', ingredients: ['盐 3g', { name: '油', amount: '10ml' }] },
    { dish: '青菜', people: 3 }
  );
  eq('缺名字时回退菜名', d.name, '青菜');
  eq('步骤去掉序号', d.steps, ['洗菜', '下锅']);
  eq('食材行拆成名称+用量', d.ingredients[0], { name: '盐', amount: '3g' });
  eq('缺人数时回退', d.servings, 3);

  /* ===== 3.5 微信小程序用户 ===== */
  const wx = require('../src/wx/client');
  group('wx · 未配置时的行为');
  ok('未配 AppID 时报未启用', !wx.isConfigured());
  ok('未配 AppID 调登录会明确报错', await (async () => {
    try { await wx.code2session('x'); return false; } catch (e) { return e.message.includes('WX_APPID'); }
  })());

  /* ===== 4. 存储层 ===== */
  const db = require('../src/store/db');
  group('store/db');
  const user = db.createUser({ username: 'TestUser', password: 'pw1234' });
  eq('用户名转小写', user.username, 'testuser');
  ok('对外信息不含密码哈希', !('passwordHash' in user));
  ok('重复注册被拒', (() => { try { db.createUser({ username: 'testuser', password: 'pw1234' }); return false; } catch { return true; } })());
  ok('弱密码被拒', (() => { try { db.createUser({ username: 'other', password: '1' }); return false; } catch { return true; } })());
  ok('非法用户名被拒', (() => { try { db.createUser({ username: 'a', password: 'pw1234' }); return false; } catch { return true; } })());
  ok('密码正确可验证', Boolean(db.verifyUser('testuser', 'pw1234')));
  ok('密码错误返回 null', db.verifyUser('testuser', 'wrong') === null);

  db.setKey('testuser', 'deepseek', 'sk-abcdefghijklmnop');
  eq('Key 明文只在服务端可取', db.getRawKey('testuser', 'deepseek'), 'sk-abcdefghijklmnop');
  eq('对外 Key 已打码', db.publicUser(db.getUser('testuser')).maskedKeys.deepseek, 'sk-a****mnop');
  ok('未知服务商被拒', (() => { try { db.setKey('testuser', 'nope', 'x'); return false; } catch { return true; } })());

  db.feedback({ dish: '宫保鸡丁', action: 'like' }, 'testuser');
  db.feedback({ dish: '宫保鸡丁', action: 'dislike' }, 'testuser');
  const p1 = db.getProfile('testuser');
  eq('点踩后从喜欢里移除', p1.likedDishes, []);
  eq('点踩已记录', p1.dislikedDishes, ['宫保鸡丁']);
  db.feedback({ dish: '宫保鸡丁', action: 'undislike' }, 'testuser');
  eq('取消反馈清空两边', db.getProfile('testuser').dislikedDishes, []);

  group('store/db · 微信用户');
  const wxUser = db.upsertWxUser('oABC-123_xyz', { nickname: '小明' });
  ok('openid 生成合法用户名', /^wx_[0-9a-f]{12}$/.test(wxUser.username), wxUser.username);
  eq('昵称已保存', wxUser.displayName, '小明');
  ok('对外不暴露 openid', !('openid' in wxUser));
  eq('同一 openid 不会重复建号', db.upsertWxUser('oABC-123_xyz').username, wxUser.username);
  ok('能按 openid 反查', db.findByOpenid('oABC-123_xyz')?.username === wxUser.username);
  ok('微信用户无法被口令登录', db.verifyUser(wxUser.username, '') === null);
  ok('不同 openid 是不同用户', db.upsertWxUser('oDEF-456').username !== wxUser.username);

  const { id } = db.addHistory({ title: '测试菜单', people: 4, days: 1, dishes: ['A', 'B', 'C'], plan: mock }, 'testuser');
  ok('历史可按 id 取回完整菜单', Boolean(db.getHistoryEntry(id, 'testuser').plan));
  eq('生成不写入「最近做过」', db.getProfile('testuser').recentDishes, []);
  eq('历史里 cooked 初始为空', db.getHistoryEntry(id, 'testuser').cooked, []);

  db.markCooked({ dishes: ['A', 'C'], historyId: id }, 'testuser');
  eq('只有勾选的菜进入「最近做过」', [...db.getProfile('testuser').recentDishes].sort(), ['A', 'C']);
  eq('没勾的菜不算做过', db.getProfile('testuser').recentDishes.includes('B'), false);
  eq('选择回写到历史条目', db.getHistoryEntry(id, 'testuser').cooked, ['A', 'C']);
  db.markCooked({ dishes: ['A'], historyId: id }, 'testuser');
  eq('重新确认会覆盖历史里的选择', db.getHistoryEntry(id, 'testuser').cooked, ['A']);
  ok('但已做过的记录不会被抹掉', db.getProfile('testuser').recentDishes.includes('C'));
  db.markCooked({ dishes: ['A', 'A', ''] }, 'testuser');
  eq('去重且忽略空值', db.getProfile('testuser').recentDishes.filter((x) => x === 'A').length, 1);
  ok('对外画像剥离菜单快照', db.publicProfile(db.getProfile('testuser')).history[0].plan === undefined);
  eq('对外画像标记 hasPlan', db.publicProfile(db.getProfile('testuser')).history[0].hasPlan, true);
  db.deleteHistory(id, 'testuser');
  eq('历史可删除', db.getProfile('testuser').history.length, 0);

  const token = db.createSession('testuser');
  ok('会话可校验', db.getSession(token)?.username === 'testuser');
  db.changePassword('testuser', 'pw1234', 'pw5678');
  ok('改密后旧会话失效', db.getSession(token) === null);
  ok('新密码可登录', Boolean(db.verifyUser('testuser', 'pw5678')));

  /* ===== 5. HTTP 接口 ===== */
  group('routes/api · HTTP');
  const app = require('../server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (p, { method = 'GET', body, token: tk } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  eq('健康检查', (await call('/api/health')).data.ok, true);
  eq('未登录访问被拒', (await call('/api/config')).status, 401);
  eq('不存在的接口回 JSON', (await call('/api/nope')).status, 404);

  const reg = await call('/api/auth/register', { method: 'POST', body: { username: 'apiuser', password: 'pw1234' } });
  eq('注册成功', reg.status, 200);
  const tk = reg.data.token;

  const cfg = (await call('/api/config', { token: tk })).data;
  eq('演示模式已开启', cfg.mockMode, true);
  eq('DeepSeek 模型列表已更新', cfg.providers.find((p) => p.key === 'deepseek').models.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  eq('Qwen 模型列表已更新', cfg.providers.find((p) => p.key === 'qwen').models.map((m) => m.id), ['qwen3.7-plus', 'qwen3.7-flash', 'qwen3.8-max']);
  ok('不再暴露已下线的模型', !JSON.stringify(cfg.providers).includes('deepseek-chat'));

  const gen = await call('/api/recipes/generate', {
    method: 'POST', token: tk,
    body: { people: 4, days: 2, mealType: 'family', mealsPerDay: 'all', tastes: ['麻辣'] },
  });
  eq('生成成功', gen.status, 200);
  eq('返回 2 天', gen.data.days.length, 2);
  eq('标记演示数据', gen.data.mock, true);
  ok('返回 historyId', Boolean(gen.data.historyId));
  eq('默认不开深度思考', gen.data.meta.thinking, false);

  const legacy = await call('/api/recipes/generate', {
    method: 'POST', token: tk,
    body: { people: 2, days: 1, provider: 'deepseek', model: 'deepseek-chat', useMemory: false },
  });
  eq('前端送来已下线的模型也能生成', legacy.status, 200);
  eq('并被迁移到现役模型', legacy.data.meta.model, 'deepseek-v4-flash');

  const over = await call('/api/recipes/generate', {
    method: 'POST', token: tk, body: { people: 999, days: 99, mealType: 'x' },
  });
  eq('人数被夹到上限', over.data.meta.people, 30);
  eq('天数被夹到上限', over.data.days.length, 7);
  eq('非法用餐类型回退家宴', over.data.meta.mealType, 'family');

  const cookRes = await call('/api/cook', {
    method: 'POST', token: tk,
    body: { dishes: gen.data.days[0].meals.flatMap((m) => m.dishes.map((d) => d.name)).slice(0, 2), historyId: gen.data.historyId },
  });
  eq('确认做过接口', cookRes.status, 200);
  eq('只记住勾选的两道', cookRes.data.recentDishes.length, 2);
  eq('回看能带回当时的选择', (await call('/api/history/' + gen.data.historyId, { token: tk })).data.cooked.length, 2);

  eq('起始日期已保存', (await call('/api/history/' + gen.data.historyId, { token: tk })).data.startDate, '');
  await call('/api/cook', {
    method: 'POST', token: tk,
    body: { dishes: ['甲', '乙'], historyId: gen.data.historyId, startDate: '2026-09-01' },
  });
  eq('回看带出起始日期', (await call('/api/history/' + gen.data.historyId, { token: tk })).data.startDate, '2026-09-01');
  eq('非法日期被拒', (await call('/api/cook', {
    method: 'POST', token: tk, body: { dishes: ['丙'], historyId: gen.data.historyId, startDate: '2026/09/01' },
  })).status, 400);
  eq('带时分的日期也被拒', (await call('/api/cook', {
    method: 'POST', token: tk, body: { dishes: ['丙'], historyId: gen.data.historyId, startDate: '2026-09-01T10:00' },
  })).status, 400);
  eq('不传日期不影响记菜', (await call('/api/cook', {
    method: 'POST', token: tk, body: { dishes: ['丁'] },
  })).status, 200);
  eq('原有起始日期不被覆盖掉', (await call('/api/history/' + gen.data.historyId, { token: tk })).data.startDate, '2026-09-01');

  await call('/api/cook', {
    method: 'POST', token: tk,
    body: { dishes: ['甲', '乙'], picks: ['0::甲', '1::甲', '0::乙'], historyId: gen.data.historyId, startDate: '2026-09-01' },
  });
  const withPicks = (await call('/api/history/' + gen.data.historyId, { token: tk })).data;
  eq('按天勾选被原样保存', withPicks.picks, ['0::甲', '1::甲', '0::乙']);
  eq('进记忆的仍是去重菜名', withPicks.cooked, ['甲', '乙']);

  const mealsRes = await call('/api/recipes/generate', {
    method: 'POST', token: tk, body: { people: 2, days: 1, meals: ['dinner'], useMemory: false },
  });
  eq('只点晚餐就只生成晚餐', mealsRes.data.days[0].meals.map((m) => m.type), ['晚餐']);
  eq('meta 带上餐次', mealsRes.data.meta.meals, ['dinner']);
  const legacyMeals = await call('/api/recipes/generate', {
    method: 'POST', token: tk, body: { people: 2, days: 1, mealsPerDay: 'all', useMemory: false },
  });
  eq('老前端的 mealsPerDay 仍可用', legacyMeals.data.meta.meals, ['breakfast', 'lunch', 'dinner']);

  const byIng = await call('/api/recipes/by-ingredients', {
    method: 'POST', token: tk, body: { ingredients: ['白菜', '鸡蛋', '豆腐'], people: 2 },
  });
  eq('按食材找菜', byIng.status, 200);
  ok('返回多道可做的菜', byIng.data.dishes.length > 0, byIng.data.dishes.length);
  ok('每道标了用哪几样', byIng.data.dishes.every((d) => Array.isArray(d.uses)));
  eq('没填食材被拒', (await call('/api/recipes/by-ingredients', { method: 'POST', token: tk, body: {} })).status, 400);
  eq('食材自动去重', (await call('/api/recipes/by-ingredients', {
    method: 'POST', token: tk, body: { ingredients: ['鸡蛋', '鸡蛋', ' 鸡蛋 '] },
  })).data.meta.ingredients.length, 1);

  const planFromPantry = await call('/api/recipes/generate', {
    method: 'POST', token: tk,
    body: { people: 2, days: 2, meals: ['lunch', 'dinner'], ingredients: ['鸡蛋', '豆腐', '龙虾'], useMemory: false },
  });
  eq('带食材排菜单', planFromPantry.status, 200);
  eq('仍是按天菜单结构', planFromPantry.data.days.length, 2);
  ok('如实报出用上了哪些', Array.isArray(planFromPantry.data.usedFromPantry));
  ok('菜库里没有的龙虾算没用上', planFromPantry.data.unusedFromPantry.includes('龙虾'));
  ok('采购清单不含已有食材', !planFromPantry.data.shoppingList.some((i) => i.name === '鸡蛋' || i.name === '豆腐'),
    planFromPantry.data.shoppingList.map((i) => i.name).slice(0, 5));
  eq('meta 记录了食材', planFromPantry.data.meta.ingredients.length, 3);

  const plainPlan = await call('/api/recipes/generate', {
    method: 'POST', token: tk, body: { people: 2, days: 1, useMemory: false },
  });
  ok('不带食材时没有这两个字段', !('usedFromPantry' in plainPlan.data));

  const hist = await call('/api/history', { token: tk });
  eq('历史列表有 2 条', hist.data.length, 2);
  ok('历史列表不含完整菜单', hist.data.every((h) => h.plan === undefined));
  const back = await call('/api/history/' + gen.data.historyId, { token: tk });
  eq('历史可回看', back.data.days.length, 2);
  eq('回看有标记', back.data.fromHistory, true);
  eq('回看不存在的记录', (await call('/api/history/nope', { token: tk })).status, 404);

  const det = await call('/api/recipes/detail', { method: 'POST', token: tk, body: { dish: '宫保鸡丁', people: 4 } });
  eq('详情成功', det.status, 200);
  ok('详情有步骤', det.data.steps.length > 0);
  eq('缺菜名被拒', (await call('/api/recipes/detail', { method: 'POST', token: tk, body: {} })).status, 400);

  eq('无痕生成不写历史',
    (await call('/api/recipes/generate', { method: 'POST', token: tk, body: { people: 2, days: 1, useMemory: false } })).data.historyId,
    undefined);
  eq('历史仍是 2 条', (await call('/api/history', { token: tk })).data.length, 2);

  eq('清空历史', (await call('/api/history', { method: 'DELETE', token: tk })).data.history.length, 0);

  eq('非法 Key 格式被拒', (await call('/api/keys', { method: 'POST', token: tk, body: { provider: 'deepseek', key: 'has space' } })).status, 400);
  eq('Key 可保存', (await call('/api/keys', { method: 'POST', token: tk, body: { provider: 'deepseek', key: 'sk-abcdefghijkl' } })).data.hasKeys.deepseek, true);
  eq('Key 只回打码值', (await call('/api/keys', { token: tk })).data.maskedKeys.deepseek, 'sk-a****ijkl');

  eq('登出后 token 失效',
    (await call('/api/auth/logout', { method: 'POST', token: tk })).status === 200
      && (await call('/api/auth/me', { token: tk })).status,
    401);

  server.close();

  /* ===== 结果 ===== */
  console.log(`\n${'─'.repeat(48)}`);
  if (failures.length) {
    console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
    failures.forEach((f) => console.log(`   · ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`✅ 全部 ${passed} 项断言通过`);
  }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* 忽略 */ }
}

main().catch((err) => {
  console.error('\n测试运行出错:', err);
  process.exit(1);
});
