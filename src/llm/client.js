const { PROVIDERS, getApiKey } = require('../config');

/** 把服务商返回的 HTTP 状态翻译成用户能看懂的提示 */
function describeHttpError(label, status, body) {
  const brief = String(body || '').replace(/\s+/g, ' ').slice(0, 200);
  if (status === 401 || status === 403) return `${label} 鉴权失败：API Key 无效或已被禁用，请在「🔑 我的密钥」中更新。`;
  if (status === 402) return `${label} 账户余额不足，请前往服务商控制台充值后重试。`;
  if (status === 429) return `${label} 请求过于频繁或已达配额上限，请稍后再试。`;
  if (status >= 500) return `${label} 服务端暂时不可用（${status}），请稍后重试。`;
  return `${label} 接口错误 ${status}${brief ? `：${brief}` : ''}`;
}

/**
 * 深度思考开关：两家参数名不一样，这里按服务商翻译。
 * 注意百炼默认开启思考，所以 false 也必须显式发出去，否则每次生成都会又慢又贵。
 */
function thinkingParams(conf, thinking) {
  if (conf.thinkingStyle === 'deepseek') {
    return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
  }
  if (conf.thinkingStyle === 'qwen') {
    return { enable_thinking: Boolean(thinking) };
  }
  return {};
}

/**
 * 统一的 OpenAI 兼容聊天调用（DeepSeek / Qwen DashScope 均兼容）
 * apiKey 可选：优先使用用户在页面里配置的 Key，否则回退到 .env 全局 Key
 * thinking：是否开启深度思考（默认关闭 —— 配菜任务用不上，开了只是更慢更贵）
 */
async function chat({
  provider, model, messages,
  temperature = 0.8, maxTokens = 8192, timeoutMs = 180000, apiKey, thinking = false,
}) {
  const conf = PROVIDERS[provider];
  if (!conf) throw new Error(`未知模型服务商: ${provider}`);
  const key = (apiKey || '').trim() || getApiKey(provider);
  if (!key) throw new Error(`${conf.label} 未配置 API Key，请点击右上角「🔑 我的密钥」填写 ${conf.label} Key`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(conf.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...thinkingParams(conf, thinking),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(describeHttpError(conf.label, res.status, text));
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${conf.label} 返回内容为空，请稍后重试或更换模型`);
    return content;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`${conf.label} 响应超时（${Math.round(timeoutMs / 1000)} 秒），可换用更快的模型后重试`);
    }
    if (err instanceof TypeError) {
      // fetch 层的网络错误（DNS / 代理 / 断网）
      throw new Error(`无法连接 ${conf.label} 服务（${err.message}），请检查网络或代理设置`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型回复中稳健提取 JSON（容忍 markdown 代码块、前后缀说明文字等包裹） */
function extractJSON(text) {
  if (!text) throw new Error('模型返回为空');
  let t = String(text).trim();

  // 1) 优先取 ```json ... ``` 代码块
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // 2) 去掉 JSON 之前的说明文字
  const start = t.search(/[[{]/);
  if (start > 0) t = t.slice(start);

  // 3) 直接尝试
  try {
    return JSON.parse(t);
  } catch { /* 继续兜底 */ }

  // 4) 截到最后一个闭合括号（模型常在结尾多写一句话）
  const lastObj = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (lastObj !== -1) {
    const sliced = t.slice(0, lastObj + 1);
    try {
      return JSON.parse(sliced);
    } catch { /* 继续兜底 */ }
  }

  // 5) 按括号配平扫描出第一个完整的 JSON 值（忽略字符串内的括号）
  const balanced = sliceBalanced(t);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch { /* 落到最后的报错 */ }
  }

  throw new Error('模型没有返回合法的 JSON，请重试或换一个模型');
}

/** 从字符串开头扫描出括号配平的第一段 JSON */
function sliceBalanced(text) {
  const open = text[0];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(0, i + 1);
  }
  return null;
}

/**
 * 要求模型返回 JSON：解析失败时自动补一轮「只输出 JSON」的修复请求。
 * 大模型偶尔会输出解释文字或截断的 JSON，这里做一次自愈重试。
 */
async function chatJSON(options) {
  const raw = await chat(options);
  try {
    return extractJSON(raw);
  } catch (err) {
    const repaired = await chat({
      ...options,
      temperature: 0.2,
      thinking: false, // 只是重新排版一遍 JSON，不需要思考
      messages: [
        ...options.messages,
        { role: 'assistant', content: String(raw).slice(0, 4000) },
        { role: 'user', content: '上面的内容不是合法 JSON。请只重新输出一个完整、合法的 JSON 对象，不要代码块标记，不要任何解释文字。' },
      ],
    });
    try {
      return extractJSON(repaired);
    } catch {
      throw err;
    }
  }
}

module.exports = { chat, chatJSON, extractJSON, sliceBalanced, describeHttpError, thinkingParams };
