const MEAL_TYPES = {
  banquet: '宴席（正式宴请，菜品丰盛讲究排场）',
  family: '家宴（家庭聚餐，丰盛但家常温馨）',
  simple: '简餐（快手简单，营养省时）',
};

const MEAL_TYPE_LABELS = { banquet: '宴席', family: '家宴', simple: '简餐' };

/** 可独立勾选的餐次槽位，顺序即一天内的先后 */
const MEAL_SLOTS = [
  { key: 'breakfast', label: '早餐', emoji: '🌅' },
  { key: 'lunch', label: '午餐', emoji: '☀️' },
  { key: 'dinner', label: '晚餐', emoji: '🌙' },
];
const MEAL_SLOT_KEYS = MEAL_SLOTS.map((s) => s.key);

/** 旧版的固定组合 → 新的槽位数组（历史记录与老前端仍可能送过来） */
const LEGACY_MEAL_COMBOS = {
  'lunch-dinner': ['lunch', 'dinner'],
  all: ['breakfast', 'lunch', 'dinner'],
};

/**
 * 把任意形态的餐次输入收敛成有序、去重、至少一项的槽位数组。
 * 接受 ['lunch','dinner'] 新格式，也兼容 'all' / 'lunch-dinner' 旧格式。
 */
function normalizeMeals(input) {
  let list = input;
  if (typeof list === 'string') list = LEGACY_MEAL_COMBOS[list] || [];
  if (!Array.isArray(list)) list = [];
  const picked = MEAL_SLOT_KEYS.filter((k) => list.includes(k));
  return picked.length ? picked : ['lunch', 'dinner'];
}

const mealLabels = (meals) => normalizeMeals(meals).map((k) => MEAL_SLOTS.find((s) => s.key === k).label);

/** 允许出现的菜品分类（用于结果归一化与前端配色） */
const CATEGORIES = ['凉菜', '荤菜', '素菜', '汤品', '蒸菜', '主食', '甜点'];

/** 采购清单分组 */
const SHOP_CATEGORIES = ['蔬菜', '肉禽蛋', '水产', '米面豆制品', '调料干货'];

/** 按用餐类型与人数推荐每餐菜品数量，写进提示词让模型有明确目标 */
function dishCountHint(mealType, people) {
  if (mealType === 'simple') return { min: 2, max: 3 };
  if (mealType === 'banquet') {
    const n = Math.min(Math.max(Math.round(people * 1.2) + 2, 6), 12);
    return { min: Math.max(6, n - 1), max: n + 1 };
  }
  const n = Math.min(Math.max(Math.ceil(people / 2) + 2, 3), 7);
  return { min: Math.max(3, n - 1), max: n + 1 };
}

function buildMemoryBlock(profile) {
  if (!profile) return '';
  const lines = [];
  if (profile.nickname) lines.push(`- 用户昵称：${profile.nickname}`);
  if (profile.tastePrefs?.length) lines.push(`- 喜欢的口味：${profile.tastePrefs.join('、')}`);
  if (profile.dislikedTastes?.length) lines.push(`- 不喜欢的口味：${profile.dislikedTastes.join('、')}（必须避免）`);
  if (profile.allergies?.length) lines.push(`- 过敏/忌口食材：${profile.allergies.join('、')}（绝对不能出现，含隐藏用法如高汤、酱料也要避免）`);
  if (profile.likedDishes?.length) lines.push(`- 曾点赞喜欢的菜（可适当再推荐类似风格）：${profile.likedDishes.slice(0, 15).join('、')}`);
  if (profile.dislikedDishes?.length) lines.push(`- 曾点踩不喜欢的菜（不要再推荐）：${profile.dislikedDishes.slice(0, 20).join('、')}`);
  if (profile.recentDishes?.length) lines.push(`- 最近已做过的菜（避免重复推荐）：${profile.recentDishes.slice(0, 40).join('、')}`);
  return lines.length ? `\n【用户记忆与偏好】\n${lines.join('\n')}\n` : '';
}

function buildSystemPrompt(hasPantry) {
  const pantryRules = hasPantry ? `
【用户已有食材，这是本次的核心约束】
A. 尽最大可能把用户列出的食材用完、用尽，这是首要目标，不要让食材剩着浪费；
B. 同一样食材可以在不同天用不同做法，但别每天重样；
C. shoppingList 里**只列还需要补买的**，用户已有的不要再列进去；
D. usedFromPantry 如实填写你实际用到了用户现有食材里的哪几样（必须是用户原词）；
E. 确实用不上的，如实放进 unusedFromPantry，不要硬塞。
` : '';
  return `你是一位经验丰富的中式营养配餐师兼宴席设计师。你需要根据用户需求设计菜谱。
${pantryRules}要求：
1. 菜品搭配合理：荤素平衡、冷热搭配、有汤有菜、口味层次丰富、颜色好看；
2. 同一天内菜品口味和食材尽量不重复；不同天之间也尽量避免重复菜品；
3. 尊重用户人数（按人数给出采购量参考）、口味与用餐类型；
4. 采购清单要覆盖菜单中出现的主要食材，给出可直接照着买的总量，并标注分类；
5. 严格只输出一个 JSON 对象，不要输出任何其他文字、注释或代码块标记。

输出 JSON 结构：
{
  "title": "菜单标题",
  "summary": "一句话说明这份菜单的设计思路",
  "days": [
    {
      "day": 1,
      "meals": [
        {
          "type": "午餐",
          "theme": "本餐主题一句话",
          "staple": "主食名称",
          "dishes": [
            { "name": "菜名", "category": "${CATEGORIES.join('|')}", "brief": "一句话介绍风味特点" }
          ]
        }
      ]
    }
  ],
  "shoppingList": [
    { "name": "食材名", "amount": "总量参考（按给定人数与天数）", "category": "${SHOP_CATEGORIES.join('|')}" }
  ],${hasPantry ? `
  "usedFromPantry": ["用到的用户现有食材"],
  "unusedFromPantry": ["没用上的用户现有食材"],` : ''}
  "tips": ["1-3 条备餐/采买建议，例如提前腌制、可分批采买等"]
}`;
}

function buildUserPrompt({ people, days, tastes, mealType, meals, extra, ingredients }, profile) {
  const memory = buildMemoryBlock(profile);
  const mealDesc = MEAL_TYPES[mealType] || mealType || MEAL_TYPES.family;
  const tasteStr = tastes?.length ? tastes.join('、') : '不限';
  const { min, max } = dishCountHint(mealType, people);
  const labels = mealLabels(meals);
  const mealsDesc = labels.join(' + ');
  return `请为我定制一份菜谱：
- 用餐人数：${people} 人
- 天数：${days} 天
- 每天餐次：${mealsDesc}
- 口味偏好：${tasteStr}
- 用餐类型：${mealDesc}
- 每餐菜品数量：正餐各 ${min}-${max} 道（早餐从简，1-2 项即可）
- 只需要输出上面列出的餐次，不要自作主张增减餐次
${ingredients?.length ? `
【我现在已有这些食材】${ingredients.join('、')}
请优先围绕它们设计，尽量用完；采购清单里只写还需补买的，已有的别再列。
盐、油、酱油、醋、糖、葱姜蒜等基础调料默认我都有。` : ''}
${extra ? `- 其他要求：${extra}` : ''}${memory}

请务必输出完整的 ${days} 天，每天都只包含「${labels.join('、')}」这几餐；结合用户记忆做个性化推荐。`;
}

/* ================= 结果归一化 ================= */

const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

function normalizeDish(dish) {
  if (typeof dish === 'string') return { name: str(dish, 40), category: '菜品', brief: '' };
  if (!dish || typeof dish !== 'object') return null;
  const name = str(dish.name || dish.dish || dish.title, 40);
  if (!name) return null;
  const category = str(dish.category || dish.type, 10) || '菜品';
  return { name, category, brief: str(dish.brief || dish.desc || dish.description, 120) };
}

function normalizeMeal(meal, index, slotLabels) {
  if (!meal || typeof meal !== 'object') return null;
  const dishes = (Array.isArray(meal.dishes) ? meal.dishes : []).map(normalizeDish).filter(Boolean).slice(0, 16);
  const type = str(meal.type || meal.name, 12) || slotLabels[index] || '正餐';
  if (!dishes.length && !meal.staple) return null;
  return {
    type,
    theme: str(meal.theme || meal.title, 60),
    staple: str(meal.staple || meal.stapleFood, 40),
    dishes,
  };
}

function normalizeDay(day, index, slotLabels) {
  if (!day || typeof day !== 'object') return null;
  const rawMeals = Array.isArray(day.meals) ? day.meals : [];
  const meals = rawMeals.map((m, i) => normalizeMeal(m, i, slotLabels)).filter(Boolean);
  if (!meals.length) return null;
  const num = parseInt(day.day) || index + 1;
  return { day: num, label: str(day.label, 20) || '', meals };
}

function normalizeShopItem(item) {
  if (typeof item === 'string') return { name: str(item, 40), amount: '', category: '' };
  if (!item || typeof item !== 'object') return null;
  const name = str(item.name || item.ingredient, 40);
  if (!name) return null;
  return { name, amount: str(item.amount || item.qty || item.quantity, 40), category: str(item.category, 12) };
}

/**
 * 把模型返回的任意形状收敛成前端可以安全渲染的结构。
 * 大模型偶尔会漏字段、把 dishes 写成字符串数组、或少给一天，这里统一兜住。
 */
function normalizePlan(plan, params = {}) {
  const src = plan && typeof plan === 'object' ? plan : {};
  const daysSrc = Array.isArray(src.days) ? src.days : Array.isArray(src.menu) ? src.menu : [];
  const slotLabels = mealLabels(params.meals);
  const days = daysSrc.map((d, i) => normalizeDay(d, i, slotLabels)).filter(Boolean).slice(0, 7);
  if (!days.length) throw new Error('模型返回的菜单为空，请重试或换一个模型');
  days.forEach((d, i) => { d.day = i + 1; });

  const shoppingList = (Array.isArray(src.shoppingList) ? src.shoppingList : [])
    .map(normalizeShopItem).filter(Boolean).slice(0, 80);

  const tipsSrc = Array.isArray(src.tips) ? src.tips : src.tips ? [src.tips] : [];
  const typeLabel = MEAL_TYPE_LABELS[params.mealType] || '定制';

  // 带了现有食材时，核对模型报的「用了哪些」——它很爱把用户没提过的算进去
  const owned = params.ingredients || [];
  let usedFromPantry = [];
  let unusedFromPantry = [];
  if (owned.length) {
    const claimed = Array.isArray(src.usedFromPantry) ? src.usedFromPantry.map((x) => str(x, 30)) : [];
    for (const c of claimed) {
      const hit = owned.includes(c) ? c : owned.find((o) => o.includes(c) || c.includes(o));
      if (hit && !usedFromPantry.includes(hit)) usedFromPantry.push(hit);
    }
    // 模型漏报时兜底：菜名或采购项里出现过的也算用上了
    const haystack = JSON.stringify(days);
    for (const o of owned) {
      if (!usedFromPantry.includes(o) && haystack.includes(o)) usedFromPantry.push(o);
    }
    unusedFromPantry = owned.filter((o) => !usedFromPantry.includes(o));
  }

  return {
    title: str(src.title, 60) || `${typeLabel}${days.length}天菜单`,
    summary: str(src.summary || src.description, 300),
    days,
    shoppingList,
    ...(owned.length ? { usedFromPantry, unusedFromPantry } : {}),
    tips: tipsSrc.map((t) => str(t, 120)).filter(Boolean).slice(0, 5),
    meta: {
      people: params.people,
      days: days.length,
      mealType: params.mealType,
      mealTypeLabel: typeLabel,
      meals: normalizeMeals(params.meals),
      tastes: params.tastes || [],
      ingredients: owned,
      generatedAt: new Date().toISOString(),
    },
  };
}

/** 汇总菜单里所有菜名，用于写入「最近做过」 */
function collectDishNames(plan) {
  const names = [];
  for (const d of plan?.days || []) {
    for (const m of d.meals || []) {
      for (const x of m.dishes || []) if (x?.name) names.push(x.name);
    }
  }
  return [...new Set(names)];
}

/* ================= 演示数据 ================= */

// name / cat / brief / ing: [[食材, 每人克数或数量描述]]
const DISH_LIB = [
  { name: '蒜蓉粉丝虾', cat: '荤菜', brief: '蒜香浓郁，虾肉弹嫩', ing: [['基围虾', 80], ['龙口粉丝', 15]] },
  { name: '糖醋里脊', cat: '荤菜', brief: '外酥里嫩，酸甜开胃', ing: [['猪里脊', 90], ['番茄酱', 10]] },
  { name: '宫保鸡丁', cat: '荤菜', brief: '荔枝口微辣，花生脆香', ing: [['鸡胸肉', 90], ['花生米', 15]] },
  { name: '红烧排骨', cat: '荤菜', brief: '酱色红亮，软糯脱骨', ing: [['猪肋排', 120]] },
  { name: '清蒸鲈鱼', cat: '蒸菜', brief: '原汁原味，鲜嫩清甜', ing: [['鲈鱼', 130], ['小葱', 5]] },
  { name: '干煸四季豆', cat: '素菜', brief: '干香微辣，越嚼越香', ing: [['四季豆', 100]] },
  { name: '麻婆豆腐', cat: '荤菜', brief: '麻辣鲜烫，下饭一绝', ing: [['嫩豆腐', 100], ['牛肉末', 30]] },
  { name: '蒜蓉西兰花', cat: '素菜', brief: '清爽脆嫩，配色亮眼', ing: [['西兰花', 100]] },
  { name: '手撕包菜', cat: '素菜', brief: '锅气十足，酸辣爽口', ing: [['包菜', 100]] },
  { name: '白灼菜心', cat: '素菜', brief: '清甜本味，解腻首选', ing: [['菜心', 100]] },
  { name: '凉拌黄瓜', cat: '凉菜', brief: '清脆蒜香，一秒开胃', ing: [['黄瓜', 80], ['大蒜', 5]] },
  { name: '皮蛋豆腐', cat: '凉菜', brief: '滑嫩咸鲜，零难度', ing: [['内酯豆腐', 80], ['皮蛋', 0.5]] },
  { name: '口水鸡', cat: '凉菜', brief: '红油麻辣，鸡肉滑嫩', ing: [['鸡腿肉', 80]] },
  { name: '拍黄瓜金针菇', cat: '凉菜', brief: '酸辣爽脆，冰镇更佳', ing: [['金针菇', 60], ['黄瓜', 50]] },
  { name: '番茄蛋汤', cat: '汤品', brief: '酸甜暖胃，人人爱喝', ing: [['番茄', 80], ['鸡蛋', 1]] },
  { name: '紫菜虾皮汤', cat: '汤品', brief: '清鲜低脂，三分钟出锅', ing: [['紫菜', 5], ['虾皮', 5]] },
  { name: '冬瓜丸子汤', cat: '汤品', brief: '清润解腻，汤鲜肉滑', ing: [['冬瓜', 100], ['猪肉末', 40]] },
  { name: '玉米排骨汤', cat: '汤品', brief: '甜润滋补，小火慢炖', ing: [['猪肋排', 80], ['甜玉米', 0.5]] },
  { name: '鱼香茄子', cat: '素菜', brief: '咸甜微酸，茄子软糯', ing: [['长茄子', 100]] },
  { name: '香菇滑鸡', cat: '蒸菜', brief: '菌香入味，嫩滑多汁', ing: [['鸡腿肉', 100], ['干香菇', 8]] },
  { name: '梅菜扣肉', cat: '蒸菜', brief: '肥而不腻，酱香浓郁', ing: [['五花肉', 110], ['梅干菜', 15]] },
  { name: '孜然羊肉', cat: '荤菜', brief: '孜然浓香，微辣够味', ing: [['羊腿肉', 100], ['孜然粒', 3]] },
  { name: '酸辣土豆丝', cat: '素菜', brief: '爽脆酸辣，快手下饭', ing: [['土豆', 100]] },
  { name: '香煎豆腐', cat: '素菜', brief: '外焦里嫩，酱汁咸香', ing: [['老豆腐', 100]] },
  { name: '冰糖银耳羹', cat: '甜点', brief: '胶质浓稠，清甜润燥', ing: [['干银耳', 8], ['红枣', 10]] },
  { name: '桂花酒酿小圆子', cat: '甜点', brief: '桂花清香，收尾清爽', ing: [['酒酿', 40], ['小圆子', 30]] },
  { name: '可乐鸡翅', cat: '荤菜', brief: '咸甜挂汁，小孩最爱', ing: [['鸡中翅', 100]] },
  { name: '黑椒牛柳', cat: '荤菜', brief: '黑椒浓香，牛肉嫩滑', ing: [['牛里脊', 100], ['彩椒', 40]] },
  { name: '虾仁滑蛋', cat: '荤菜', brief: '蛋嫩虾弹，入口即化', ing: [['虾仁', 60], ['鸡蛋', 1]] },
  { name: '豉汁蒸排骨', cat: '蒸菜', brief: '豉香浓郁，肉质软嫩', ing: [['猪肋排', 100], ['豆豉', 6]] },
  { name: '剁椒蒸鱼头', cat: '蒸菜', brief: '鲜辣开胃，宴客有面', ing: [['鳙鱼头', 140], ['剁椒', 20]] },
  { name: '蒜蓉蒸茄子', cat: '蒸菜', brief: '少油清爽，蒜香扑鼻', ing: [['长茄子', 100], ['大蒜', 6]] },
  { name: '上汤娃娃菜', cat: '素菜', brief: '汤鲜菜甜，清口解腻', ing: [['娃娃菜', 100], ['皮蛋', 0.5]] },
  { name: '清炒荷兰豆', cat: '素菜', brief: '碧绿爽脆，锁住清甜', ing: [['荷兰豆', 100]] },
  { name: '地三鲜', cat: '素菜', brief: '东北名菜，油润下饭', ing: [['土豆', 60], ['长茄子', 60], ['青椒', 30]] },
  { name: '凉拌手撕鸡', cat: '凉菜', brief: '麻辣鲜香，越拌越入味', ing: [['鸡胸肉', 80]] },
  { name: '姜汁菠菜', cat: '凉菜', brief: '姜香微酸，补铁清口', ing: [['菠菜', 90]] },
  { name: '蜜汁莲藕', cat: '凉菜', brief: '糯甜爽脆，颜值担当', ing: [['莲藕', 80], ['糯米', 20]] },
  { name: '酸菜鱼片汤', cat: '汤品', brief: '酸爽开胃，鱼片滑嫩', ing: [['黑鱼片', 90], ['酸菜', 30]] },
  { name: '菌菇豆腐汤', cat: '汤品', brief: '菌香清鲜，低脂暖身', ing: [['杂菌菇', 60], ['嫩豆腐', 60]] },
  { name: '山药枸杞排骨汤', cat: '汤品', brief: '温润滋补，老少皆宜', ing: [['猪肋排', 80], ['山药', 60]] },
  { name: '红豆沙汤圆', cat: '甜点', brief: '绵密香甜，圆满收尾', ing: [['红豆', 30], ['汤圆', 40]] },
];

const STAPLES = ['米饭', '杂粮饭', '手工馒头', '荞麦面', '葱油拌面', '小米南瓜饭'];
const BREAKFASTS = [
  { staple: '小米粥 + 鸡蛋饼', dish: { name: '水煮蛋', cat: '素菜', brief: '优质蛋白，快手省事', ing: [['鸡蛋', 1]] } },
  { staple: '豆浆 + 小笼包', dish: { name: '拌豆干丝', cat: '凉菜', brief: '咸香开胃，配粥正好', ing: [['豆干', 40]] } },
  { staple: '牛奶 + 全麦三明治', dish: { name: '果蔬沙拉', cat: '凉菜', brief: '清爽补充维生素', ing: [['生菜', 40], ['圣女果', 30]] } },
  { staple: '南瓜粥 + 葱油饼', dish: { name: '凉拌木耳', cat: '凉菜', brief: '爽脆解腻，补铁佳品', ing: [['干木耳', 6]] } },
];

const SHOP_CATEGORY_OF = (name) => {
  if (/虾|鱼|蟹|贝|紫菜/.test(name)) return '水产';
  if (/肉|排|脊|鸡|鸭|牛|羊|猪|蛋/.test(name)) return '肉禽蛋';
  if (/豆腐|豆干|粉丝|面|米|馒头|圆子|酒酿/.test(name)) return '米面豆制品';
  if (/蒜|葱|姜|孜然|酱|木耳|香菇|银耳|红枣|花生/.test(name)) return '调料干货';
  return '蔬菜';
};

function formatAmount(name, perPerson, totalPeople) {
  const total = perPerson * totalPeople;
  if (perPerson < 3) {
    // 论个买的食材（鸡蛋、玉米、皮蛋…）
    const n = Math.max(1, Math.round(total));
    return `${n} ${/蛋|玉米/.test(name) ? '个' : '份'}`;
  }
  return total >= 1000 ? `${(total / 1000).toFixed(1)} kg` : `${Math.round(total / 10) * 10} g`;
}

/** 每餐的分类构成：不同用餐类型丰盛度不同 */
function mealComposition(mealType) {
  if (mealType === 'simple') return ['荤菜', '素菜'];
  if (mealType === 'banquet') return ['凉菜', '凉菜', '荤菜', '荤菜', '蒸菜', '素菜', '素菜', '汤品', '甜点'];
  return ['凉菜', '荤菜', '荤菜', '素菜', '汤品'];
}

/** 无 Key 时的演示数据：结构与真实生成结果完全一致 */
function mockPlan({ people = 2, days = 1, tastes = [], mealType = 'family', meals: mealsInput, mealsPerDay, ingredients = [] }) {
  const typeLabel = MEAL_TYPE_LABELS[mealType] || '家常';
  const cursor = new Map(); // 分类 -> 已取到第几个，保证整期菜单尽量不重样
  const used = new Set();
  const pick = (cat) => {
    let pool = DISH_LIB.filter((d) => d.cat === cat);
    // 带了现有食材时，优先挑能用上它们的菜
    if (ingredients.length) {
      const matched = pool.filter((d) => (d.ing || []).some(([n]) => ingredients.some((o) => o.includes(n) || n.includes(o))));
      if (matched.length) pool = matched;
    }
    if (!pool.length) return null;
    const start = cursor.get(cat) || 0;
    for (let i = 0; i < pool.length; i++) {
      const d = pool[(start + i) % pool.length];
      if (!used.has(d.name)) {
        cursor.set(cat, (start + i + 1) % pool.length);
        used.add(d.name);
        return d;
      }
    }
    cursor.set(cat, (start + 1) % pool.length);
    return pool[start % pool.length];
  };

  const shop = new Map();
  const hitPantry = new Set();   // 实际用到了用户现有食材里的哪几样
  const addShop = (dish) => {
    for (const [name, per] of dish.ing || []) {
      shop.set(name, (shop.get(name) || 0) + per);
      const owned = ingredients.find((o) => o.includes(name) || name.includes(o));
      if (owned) hitPantry.add(owned);
    }
  };

  const composition = mealComposition(mealType);
  const slots = normalizeMeals(mealsInput ?? mealsPerDay);
  const THEMES = {
    lunch: '荤素搭配，吃饱有劲',
    dinner: '清爽收尾，好消化不积食',
  };
  const daysOut = [];
  let stapleIdx = 0;

  for (let d = 1; d <= days; d++) {
    const meals = [];
    for (const slot of slots) {
      if (slot === 'breakfast') {
        const b = BREAKFASTS[(d - 1) % BREAKFASTS.length];
        addShop(b.dish);
        meals.push({
          type: '早餐',
          theme: '元气开场，简单不将就',
          staple: b.staple,
          dishes: [{ name: b.dish.name, category: b.dish.cat, brief: b.dish.brief }],
        });
        continue;
      }
      const dishes = [];
      for (const cat of composition) {
        const dish = pick(cat);
        if (!dish) continue;
        addShop(dish);
        dishes.push({ name: dish.name, category: dish.cat, brief: dish.brief });
      }
      meals.push({
        type: slot === 'lunch' ? '午餐' : '晚餐',
        theme: THEMES[slot],
        staple: STAPLES[stapleIdx++ % STAPLES.length],
        dishes,
      });
    }
    daysOut.push({ day: d, meals });
  }

  const shoppingList = [...shop.entries()]
    // 用户已有的不再列进采购清单，那是「还需补买」的清单
    .filter(([name]) => !ingredients.some((o) => o.includes(name) || name.includes(o)))
    .map(([name, per]) => ({
      name,
      amount: formatAmount(name, per, people),
      category: SHOP_CATEGORY_OF(name),
    }));

  return {
    ...(ingredients.length ? {
      usedFromPantry: [...hitPantry],
      unusedFromPantry: ingredients.filter((o) => !hitPantry.has(o)),
    } : {}),
    title: `${typeLabel} · ${days} 天定制菜单（演示数据）`,
    summary: `为 ${people} 人设计的${typeLabel}菜单${tastes?.length ? `，偏${tastes.join('/')}` : ''}，荤素冷热均衡搭配。配置真实 API Key 后将由大模型生成完全个性化的结果。`,
    days: daysOut,
    shoppingList,
    tips: [
      '演示数据用固定菜库拼装，采购量已按人数换算。',
      '肉类可提前一晚腌制，第二天下锅更入味。',
      '叶菜建议分两次采买，保证新鲜度。',
    ],
  };
}

async function generatePlan(params, { provider, model, apiKey, thinking, chatJSON }, profile) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(Boolean(params.ingredients?.length)) },
    { role: 'user', content: buildUserPrompt(params, profile) },
  ];
  const raw = await chatJSON({ provider, model, apiKey, thinking, messages, temperature: 0.85, maxTokens: 8000 });
  return normalizePlan(raw, params);
}

module.exports = {
  MEAL_TYPES, MEAL_TYPE_LABELS, CATEGORIES, SHOP_CATEGORIES,
  MEAL_SLOTS, MEAL_SLOT_KEYS, normalizeMeals, mealLabels,
  buildMemoryBlock, buildSystemPrompt, buildUserPrompt, dishCountHint,
  normalizePlan, normalizeDish, collectDishNames,
  mockPlan, generatePlan,
};
