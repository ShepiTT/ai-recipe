const { buildMemoryBlock } = require('./recipe');

/**
 * 「我有这些食材，能做什么菜」。
 * 和 recipe.js 的区别：那边从需求出发（几人几天什么场合）排一份菜单，
 * 这边从库存出发，列出一堆可选的菜，重点是标清楚「用了你的哪几样、还缺什么」。
 */

/** 几乎家家都有，不该算进「还缺什么」里，否则每道菜都缺一堆 */
const BASIC_SEASONINGS = ['盐', '食用油', '生抽', '老抽', '醋', '糖', '葱', '姜', '蒜', '料酒', '淀粉', '胡椒粉'];

function buildSystemPrompt(strict) {
  return `你是一位经验丰富的中餐厨师。用户会告诉你冰箱/厨房里现有的食材，你要推荐这些食材能做的菜。

规则：
1. 优先推荐**能最大化利用现有食材**的菜，尽量让用户的食材都被用上；
2. 这些基础调料默认用户都有，**不要算进缺料**：${BASIC_SEASONINGS.join('、')}；
3. ${strict
    ? '**严格模式**：只能用用户列出的食材（加基础调料），missing 必须是空数组。做不出来就少推荐几道，不要硬凑。'
    : '**宽松模式**：允许每道菜再补 1-2 样容易买到的常见食材，但必须在 missing 里如实列出。'}
4. 每道菜必须如实填写 uses（用到了用户的哪些食材，必须是用户列表里的原词）和 missing（还需要额外买的）；
5. 推荐 6-10 道，家常为主、做法可行；同样的主料不要重复出现太多次；
6. 尊重用户的忌口与过敏食材，绝对不能出现；
7. 严格只输出一个 JSON 对象，不要任何其他文字或代码块标记。

输出 JSON 结构：
{
  "title": "一句话标题",
  "summary": "一句话说明这批菜的思路",
  "dishes": [
    {
      "name": "菜名",
      "category": "凉菜|荤菜|素菜|汤品|蒸菜|主食|甜点",
      "brief": "一句话风味特点",
      "uses": ["用到的用户食材1", "用到的用户食材2"],
      "missing": ["还缺的食材"],
      "difficulty": "简单|中等|进阶",
      "time": "预计耗时，如 20 分钟"
    }
  ],
  "tips": ["1-3 条建议，例如某样食材快坏了建议先用、某两样可以一起处理"]
}`;
}

function buildUserPrompt({ ingredients, people, tastes, extra, strict }, profile) {
  return `我现在有这些食材：${ingredients.join('、')}

- 用餐人数：${people} 人
${tastes?.length ? `- 口味偏好：${tastes.join('、')}` : ''}
${extra ? `- 其他要求：${extra}` : ''}${buildMemoryBlock(profile)}

请推荐我用这些食材能做的菜${strict ? '（只能用我列出的食材，不要让我再去买东西）' : '（可以补少量常见食材，但要标出来）'}。`;
}

/* ================= 归一化 ================= */

const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const list = (v, max = 12) => (Array.isArray(v) ? v.map((x) => str(x, 30)).filter(Boolean).slice(0, max) : []);

/**
 * 模型很爱在 uses 里写用户没提过的东西（比如把「葱花」算成用户的食材）。
 * 这里只保留能对上用户原始输入的项，对不上的挪到 missing，保证「用了你的哪几样」是可信的。
 */
function normalizeDish(dish, owned) {
  if (!dish || typeof dish !== 'object') return null;
  const name = str(dish.name, 40);
  if (!name) return null;

  const ownedSet = new Set(owned);
  const rawUses = list(dish.uses);
  const uses = [];
  const strayUses = [];
  for (const u of rawUses) {
    // 允许「白菜」对上用户写的「大白菜」这类包含关系
    const hit = ownedSet.has(u) ? u : owned.find((o) => o.includes(u) || u.includes(o));
    if (hit) { if (!uses.includes(hit)) uses.push(hit); } else strayUses.push(u);
  }

  const missing = [...new Set([...list(dish.missing), ...strayUses])]
    // 基础调料不该出现在缺料里
    .filter((m) => !BASIC_SEASONINGS.some((b) => m.includes(b)))
    .slice(0, 8);

  return {
    name,
    category: str(dish.category, 10) || '菜品',
    brief: str(dish.brief || dish.desc, 120),
    uses,
    missing,
    difficulty: str(dish.difficulty, 10),
    time: str(dish.time, 20),
    match: uses.length,
    ready: missing.length === 0,
  };
}

function normalizePantry(raw, params = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const owned = params.ingredients || [];
  const dishes = (Array.isArray(src.dishes) ? src.dishes : [])
    .map((d) => normalizeDish(d, owned))
    .filter(Boolean)
    .slice(0, 12);
  if (!dishes.length) throw new Error('没能根据这些食材想出菜，换几样试试或者多加一点');

  // 严格模式下把还缺料的直接剔掉，用户要的就是「不用再买」
  const kept = params.strict ? dishes.filter((d) => d.ready) : dishes;
  if (!kept.length) throw new Error('这些食材凑不出完整的菜，关掉「只用现有食材」再试试');

  // 能直接做的排前面，其次按用上的食材多少
  kept.sort((a, b) => (b.ready - a.ready) || (b.match - a.match));

  const used = new Set(kept.flatMap((d) => d.uses));
  const tipsSrc = Array.isArray(src.tips) ? src.tips : src.tips ? [src.tips] : [];

  return {
    title: str(src.title, 60) || `用这 ${owned.length} 样能做的菜`,
    summary: str(src.summary, 300),
    dishes: kept,
    unused: owned.filter((o) => !used.has(o)),
    tips: tipsSrc.map((t) => str(t, 120)).filter(Boolean).slice(0, 5),
    meta: {
      ingredients: owned,
      people: params.people,
      strict: Boolean(params.strict),
      tastes: params.tastes || [],
      generatedAt: new Date().toISOString(),
    },
  };
}

/* ================= 演示数据 ================= */

// 每条：菜名 / 分类 / 简介 / 需要的主料 / 难度 / 耗时
const MOCK_LIB = [
  { name: '番茄炒蛋', cat: '荤菜', brief: '酸甜下饭，五分钟上桌', need: ['番茄', '鸡蛋'], diff: '简单', time: '10 分钟' },
  { name: '白菜炖豆腐', cat: '素菜', brief: '清淡暖身，汤汁泡饭一绝', need: ['白菜', '豆腐'], diff: '简单', time: '20 分钟' },
  { name: '青椒肉丝', cat: '荤菜', brief: '咸鲜微辣，经典家常', need: ['青椒', '猪肉'], diff: '简单', time: '15 分钟' },
  { name: '土豆炖牛肉', cat: '荤菜', brief: '软烂入味，一锅出', need: ['土豆', '牛肉'], diff: '中等', time: '60 分钟' },
  { name: '蒜蓉西兰花', cat: '素菜', brief: '清爽脆嫩，配色好看', need: ['西兰花'], diff: '简单', time: '10 分钟' },
  { name: '紫菜蛋花汤', cat: '汤品', brief: '三分钟出锅的快手汤', need: ['紫菜', '鸡蛋'], diff: '简单', time: '5 分钟' },
  { name: '肉末茄子', cat: '荤菜', brief: '茄子软糯，肉末喷香', need: ['茄子', '猪肉'], diff: '简单', time: '20 分钟' },
  { name: '手撕包菜', cat: '素菜', brief: '锅气十足，酸辣爽口', need: ['白菜'], diff: '简单', time: '10 分钟' },
  { name: '香菇滑鸡', cat: '蒸菜', brief: '菌香入味，嫩滑多汁', need: ['香菇', '鸡肉'], diff: '中等', time: '30 分钟' },
  { name: '凉拌黄瓜', cat: '凉菜', brief: '清脆蒜香，一秒开胃', need: ['黄瓜'], diff: '简单', time: '5 分钟' },
  { name: '豆腐煲', cat: '素菜', brief: '外焦里嫩，酱汁浓郁', need: ['豆腐'], diff: '简单', time: '20 分钟' },
  { name: '洋葱炒蛋', cat: '荤菜', brief: '洋葱回甜，蛋香浓', need: ['洋葱', '鸡蛋'], diff: '简单', time: '10 分钟' },
  { name: '土豆丝', cat: '素菜', brief: '爽脆酸辣，快手下饭', need: ['土豆'], diff: '简单', time: '15 分钟' },
  { name: '冬瓜排骨汤', cat: '汤品', brief: '清润解腻，小火慢炖', need: ['冬瓜', '排骨'], diff: '中等', time: '50 分钟' },
];

/** 演示数据：按关键词匹配，结构与真实生成一致 */
function mockPantry({ ingredients = [], strict = false }) {
  const hit = (need) => need.filter((n) => ingredients.some((o) => o.includes(n) || n.includes(o)));

  const dishes = MOCK_LIB
    .map((d) => {
      const uses = hit(d.need);
      const missing = d.need.filter((n) => !uses.some((u) => u.includes(n) || n.includes(u)));
      return uses.length
        ? {
          name: d.name, category: d.cat, brief: d.brief,
          uses: ingredients.filter((o) => d.need.some((n) => o.includes(n) || n.includes(o))),
          missing,
          difficulty: d.diff, time: d.time,
        }
        : null;
    })
    .filter(Boolean)
    .filter((d) => (strict ? !d.missing.length : true))
    .slice(0, 10);

  return {
    title: `用这 ${ingredients.length} 样能做的菜（演示数据）`,
    summary: `根据你现有的${ingredients.join('、')}匹配出的家常菜。配置真实 API Key 后由大模型给出更贴合的推荐。`,
    dishes,
    tips: [
      '演示数据按固定菜库关键词匹配，真实模式下会考虑搭配与口味。',
      '叶菜类不耐放，建议先用掉。',
    ],
  };
}

async function generateByIngredients(params, { provider, model, apiKey, thinking, chatJSON }, profile) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(params.strict) },
    { role: 'user', content: buildUserPrompt(params, profile) },
  ];
  const raw = await chatJSON({ provider, model, apiKey, thinking, messages, temperature: 0.8, maxTokens: 4000 });
  return normalizePantry(raw, params);
}

module.exports = {
  BASIC_SEASONINGS,
  buildSystemPrompt, buildUserPrompt,
  normalizePantry, normalizeDish,
  mockPantry, generateByIngredients,
};
