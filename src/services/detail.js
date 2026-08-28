const { buildMemoryBlock } = require('./recipe');

function buildDetailSystemPrompt() {
  return `你是一位专业中餐厨师。请针对用户指定的菜品，输出详细可执行的菜谱。
要求：
1. 所有用量按指定人数换算，写清具体克数/勺数，不要只写「适量」；
2. 步骤清晰可跟做，包含刀工、火候、时间与判断标准（如「炒至微黄约 2 分钟」）；
3. 如果用户有忌口或过敏食材，必须替换掉，并在 tips 里说明替换方案；
4. 严格只输出一个 JSON 对象，不要任何其他文字或代码块标记。

JSON 结构：
{
  "name": "菜名",
  "intro": "一句话简介",
  "difficulty": "简单|中等|进阶",
  "time": "预计耗时，如 30 分钟",
  "servings": 人数数字,
  "ingredients": [{ "name": "主料名", "amount": "用量" }],
  "seasoning": [{ "name": "调料名", "amount": "用量" }],
  "steps": ["步骤1", "步骤2"],
  "tips": "烹饪小贴士",
  "nutrition": "一句话营养提示，如热量区间与主要营养素"
}`;
}

const str = (v, max = 300) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

function normalizeItems(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((it) => {
      if (typeof it === 'string') {
        // 兼容「盐 3g」这种一整行的写法
        const m = it.match(/^(.+?)[\s:：]+([\d.]+.*)$/);
        return m ? { name: str(m[1], 30), amount: str(m[2], 30) } : { name: str(it, 30), amount: '' };
      }
      if (!it || typeof it !== 'object') return null;
      const name = str(it.name || it.ingredient, 30);
      return name ? { name, amount: str(it.amount || it.qty || it.quantity, 30) } : null;
    })
    .filter(Boolean)
    .slice(0, 30);
}

/** 把模型返回收敛成前端可安全渲染的结构 */
function normalizeDetail(raw, { dish, people }) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const steps = (Array.isArray(d.steps) ? d.steps : typeof d.steps === 'string' ? d.steps.split(/\n+/) : [])
    .map((s) => str(s, 300).replace(/^\d+[.、)]\s*/, ''))
    .filter(Boolean)
    .slice(0, 20);
  return {
    name: str(d.name, 40) || dish,
    intro: str(d.intro || d.description, 200),
    difficulty: str(d.difficulty, 10),
    time: str(d.time || d.duration, 20),
    servings: parseInt(d.servings) || people,
    ingredients: normalizeItems(d.ingredients),
    seasoning: normalizeItems(d.seasoning || d.seasonings),
    steps,
    tips: str(d.tips, 400),
    nutrition: str(d.nutrition, 200),
  };
}

async function generateDishDetail({ dish, people, tastes, mealType, context, provider, model, apiKey, thinking }, { chatJSON }, profile) {
  const user = `请给出「${dish}」的详细菜谱：
- 人数：${people} 人
${tastes?.length ? `- 口味偏好：${tastes.join('、')}` : ''}
${mealType ? `- 用餐场景：${mealType}` : ''}
${context ? `- 所在菜单背景：${context}` : ''}${buildMemoryBlock(profile)}
请确保口味符合上述偏好（如有），并严格避开忌口与过敏食材。`;
  const raw = await chatJSON({
    provider,
    model,
    apiKey,
    thinking,
    messages: [
      { role: 'system', content: buildDetailSystemPrompt() },
      { role: 'user', content: user },
    ],
    temperature: 0.7,
    maxTokens: 3000,
  });
  return normalizeDetail(raw, { dish, people });
}

function mockDetail({ dish, people }) {
  const g = (per) => `${per * people} g`;
  return {
    name: dish,
    intro: '经典家常做法，新手也能一次成功（演示数据）',
    difficulty: '简单',
    time: '30 分钟',
    servings: people,
    ingredients: [
      { name: '主料', amount: g(200) },
      { name: '配菜', amount: g(100) },
      { name: '小葱', amount: g(5) },
    ],
    seasoning: [
      { name: '生抽', amount: `${Math.max(1, Math.round(people / 2))} 汤匙` },
      { name: '盐', amount: `${people} g` },
      { name: '蒜', amount: `${people * 2} 瓣` },
      { name: '食用油', amount: `${people * 8} ml` },
    ],
    steps: [
      '主料洗净改刀成均匀小块，配菜切段，蒜切末备用。',
      '锅烧热后倒油，五成油温下蒜末，小火爆香约 20 秒至微黄。',
      '转大火下主料快速翻炒 2 分钟，至表面变色断生。',
      '沿锅边淋入生抽，加盐调味，翻炒均匀让每块都裹上酱汁。',
      '下配菜再炒 1 分钟，收汁至略微挂芡即可出锅装盘。',
    ],
    tips: '这是演示数据。热锅冷油可防粘；配置真实 API Key 后将生成由大模型撰写的完整菜谱。',
    nutrition: '演示数据：每份约 300-400 kcal，蛋白质与膳食纤维搭配均衡。',
  };
}

module.exports = { buildDetailSystemPrompt, normalizeDetail, generateDishDetail, mockDetail };
