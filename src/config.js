require('dotenv').config();

/**
 * 模型服务商配置。
 *
 * 两家现在都走「一个模型 + 思考开关」的形态，不再用 chat / reasoner 这种
 * 分开的模型名，所以深度思考做成请求参数（见 llm/client.js），不占模型位。
 */
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // 思考开关参数：{"thinking": {"type": "enabled" | "disabled"}}
    thinkingStyle: 'deepseek',
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash（快速 · 推荐）', context: 1000000, thinking: true },
      { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro（最强）', context: 1000000, thinking: true },
    ],
  },
  qwen: {
    label: '通义千问 Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'QWEN_API_KEY',
    // 思考开关参数：{"enable_thinking": true | false}（百炼默认开启，必须显式关掉）
    thinkingStyle: 'qwen',
    models: [
      { id: 'qwen3.7-plus', label: 'Qwen3.7-Plus（均衡 · 推荐）', context: 1000000, thinking: true },
      { id: 'qwen3.7-flash', label: 'Qwen3.7-Flash（快速省钱）', context: 1000000, thinking: true },
      { id: 'qwen3.8-max', label: 'Qwen3.8-Max（旗舰）', context: 1000000, thinking: true },
    ],
  },
};

/**
 * 已下线 / 改名的旧模型 ID → 现役模型。
 * 用户浏览器里存着上次选的模型，直接丢给接口会 400，这里静默迁移。
 * deepseek-chat / deepseek-reasoner 已于 2026-07-24 完全停用。
 */
const LEGACY_MODELS = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
  'deepseek-v3': 'deepseek-v4-flash',
  'deepseek-v3.1': 'deepseek-v4-flash',
  'qwen-turbo': 'qwen3.7-flash',
  'qwen-plus': 'qwen3.7-plus',
  'qwen-max': 'qwen3.8-max',
  'qwen-max-latest': 'qwen3.8-max',
  'qwen3-max': 'qwen3.8-max',
};

const FALLBACK_PROVIDER = 'deepseek';

/** 解析服务商：请求指定的 → .env 默认的 → 兜底 deepseek */
function getProvider(name) {
  const requested = String(name || '').toLowerCase();
  if (PROVIDERS[requested]) return requested;
  const fromEnv = String(process.env.DEFAULT_PROVIDER || '').toLowerCase();
  return PROVIDERS[fromEnv] ? fromEnv : FALLBACK_PROVIDER;
}

/** 解析模型：现役 ID 原样返回；旧 ID 迁移到对应新模型；都不认就用该服务商的推荐款 */
function resolveModel(providerKey, modelId) {
  const p = PROVIDERS[providerKey];
  if (!p) throw new Error(`未知模型服务商: ${providerKey}`);
  const wanted = String(modelId || '').trim();
  if (p.models.some((m) => m.id === wanted)) return wanted;

  const migrated = LEGACY_MODELS[wanted.toLowerCase()];
  if (migrated && p.models.some((m) => m.id === migrated)) return migrated;

  return p.models[0].id;
}

/** 该模型是否支持深度思考开关 */
function supportsThinking(providerKey, modelId) {
  const model = PROVIDERS[providerKey]?.models.find((m) => m.id === modelId);
  return Boolean(model?.thinking);
}

function getApiKey(providerKey) {
  return (process.env[PROVIDERS[providerKey].apiKeyEnv] || '').trim();
}

function isMockMode() {
  return process.env.MOCK_MODE === '1';
}

module.exports = {
  PROVIDERS, LEGACY_MODELS,
  getProvider, resolveModel, supportsThinking, getApiKey, isMockMode,
};
