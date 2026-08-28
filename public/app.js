/* ===== AI 智能菜谱 · 前端逻辑（账号 / 密钥 / 记忆 / 历史回看 / 导出） ===== */
'use strict';

const $ = (id) => document.getElementById(id);

const TOKEN_KEY = 'ai_recipe_token';
const PREFS_KEY = 'ai_recipe_prefs';
const THEME_KEY = 'ai_recipe_theme';
const planKeyOf = (user) => `ai_recipe_plan_${user || 'anon'}`;
const shopKeyOf = (user, plan) => `ai_recipe_shop_${user || 'anon'}_${plan?.historyId || 'adhoc'}`;
const cookKeyOf = (user, plan) => `ai_recipe_cook_${user || 'anon'}_${plan?.historyId || 'adhoc'}`;
const doneKeyOf = (user, plan) => `ai_recipe_done_${user || 'anon'}_${plan?.historyId || 'adhoc'}`;

const DEFAULT_TASTES = ['麻辣', '香辣', '清淡', '咸鲜', '偏甜', '酸辣', '蒜香', '酱香', '清蒸原味', '孜然', '咖喱', '酸甜'];

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  config: null,
  plan: null,
  lastParams: null,
  dayIndex: 0,
  feedback: new Map(),   // 菜名 -> 'like' | 'dislike'
  detailCache: new Map(),// 缓存键 -> 详情对象
  checkedItems: new Set(),
  cooked: new Set(),      // 勾选「要做」的项，键是「第几天::菜名」——同一道菜在不同天算不同次
  startDate: '',          // 「第 1 天」对应的真实日期 YYYY-MM-DD
  cookDay: 0,             // 做菜界面正在看第几天（0 基）
  done: new Set(),        // 做菜界面里已完成的菜
  mode: 'plan',           // plan = 配菜单 / pantry = 按食材找菜
  ingredients: [],        // 按食材模式下手里的食材
  pantry: null,           // 按食材找菜的结果
  loading: false,
};

/* ---------- 小工具 ---------- */
function toast(msg, type = 'info', ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast toast-${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 隐私模式或超出配额时静默忽略 */ }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    ...options,
  });
  // 会话失效 → 回到登录页
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    clearSession();
    throw new Error('登录已过期，请重新登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

const LOADING_TIPS = [
  '正在平衡荤素与冷热搭配…',
  '正在避开你不喜欢和忌口的食材…',
  '正在按人数换算采购量…',
  '正在检查这几天有没有重样的菜…',
];

let loadingTimer = null;
function setLoading(on, text) {
  state.loading = on;
  $('loading').classList.toggle('hidden', !on);
  if (text) $('loadingText').textContent = text;
  $('generateBtn').disabled = on;
  clearInterval(loadingTimer);
  if (on) {
    let i = 0;
    const started = Date.now();
    $('loadingSub').textContent = LOADING_TIPS[0];
    loadingTimer = setInterval(() => {
      i += 1;
      const sec = Math.round((Date.now() - started) / 1000);
      $('loadingSub').textContent = `${LOADING_TIPS[i % LOADING_TIPS.length]}（已用时 ${sec}s）`;
    }, 2500);
  } else {
    $('loadingSub').textContent = '';
  }
}

function setAuthError(msg) {
  const el = $('authError');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

function closeAllModals() {
  ['detailModal', 'memoryModal', 'keysModal', 'startDateModal'].forEach((id) => $(id).classList.add('hidden'));
}

/* ---------- 选菜键 ---------- */
/** 同一道菜可能出现在多天，勾选必须按天归属，否则勾第 1 天会让第 3 天也亮 */
const pickKey = (day, name) => `${day}::${name}`;
const pickedNames = () => [...new Set([...state.cooked].map((k) => k.slice(k.indexOf('::') + 2)))];

/* ---------- 日期 ---------- */
/** 本地时区的 YYYY-MM-DD（不要用 toISOString，那是 UTC，会差一天） */
function toDateKey(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayKey() {
  return toDateKey(new Date());
}

function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return toDateKey(dt);
}

/** 只显示日期，不显示时分 */
function formatDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
}

function relativeDay(dateKey) {
  const diff = Math.round((new Date(dateKey + 'T00:00:00') - new Date(todayKey() + 'T00:00:00')) / 86400000);
  return { '-1': '昨天', 0: '今天', 1: '明天', 2: '后天' }[diff] || '';
}

/* ---------- 主题 ---------- */
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');
  const dark = mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('themeBtn').textContent = dark ? '☀️' : '🌙';
  $('themeBtn').title = `当前：${{ auto: '跟随系统', light: '浅色', dark: '深色' }[mode]}（点击切换）`;
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = localStorage.getItem(THEME_KEY) || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  toast(`主题：${{ auto: '跟随系统', light: '浅色', dark: '深色' }[next]}`);
}

/* ---------- 会话 ---------- */
async function enterApp(user) {
  state.user = user;
  $('authScreen').classList.add('hidden');

  const chip = $('userChip');
  chip.classList.remove('hidden');
  const name = user.displayName || user.username;
  chip.querySelector('.uname').textContent = name;
  chip.querySelector('.uname').title = name;
  chip.querySelector('.avatar').textContent = name.slice(0, 1).toUpperCase();

  await initConfig();
  await syncFeedbackFromProfile();
  state.ingredients = readJSON(ING_KEY(), []);
  renderIngredients();
  restorePlan();
  switchMode(readJSON(PREFS_KEY, {}).mode || 'plan');
}

function clearSession() {
  state.token = '';
  state.user = null;
  state.plan = null;
  state.feedback.clear();
  state.detailCache.clear();
  state.cooked.clear();
  state.done.clear();
  state.pantry = null;
  state.ingredients = [];
  state.startDate = '';
  exitCookMode();
  localStorage.removeItem(TOKEN_KEY);
  $('userChip').classList.add('hidden');
  $('resultWrap').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  document.title = 'AI 智能菜谱 · 定制你的餐桌';
  closeAllModals();
  $('authScreen').classList.remove('hidden');
}

async function boot() {
  bindAuthUI(); // 最优先，保证登录永远可用
  try {
    applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
    });
    initForm();
  } catch (err) {
    // 初始化出问题时明确报出来，而不是让页面「点了没反应」
    console.error('[initForm]', err);
    toast('页面初始化异常，请强制刷新（Ctrl/⌘ + Shift + R）：' + err.message, 'err', 8000);
  }
  if (!state.token) return; // 停留在登录页
  try {
    const { user } = await api('/api/auth/me');
    await enterApp(user);
  } catch {
    clearSession(); // token 失效
  }
}

/* ---------- 登录 / 注册 ---------- */
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('authSubmit').textContent = mode === 'login' ? '登 录' : '注 册';
  $('authPassword').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  setAuthError('');
}

async function submitAuth(e) {
  e.preventDefault();
  setAuthError('');
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  if (!username || !password) return setAuthError('请填写用户名和密码');

  const btn = $('authSubmit');
  btn.disabled = true;
  btn.textContent = authMode === 'login' ? '登录中…' : '注册中…';
  try {
    const data = await api(`/api/auth/${authMode}`, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    $('authForm').reset();
    await enterApp(data.user);
    toast(authMode === 'login' ? `欢迎回来，${data.user.displayName || data.user.username}！` : '注册成功，开始做菜吧 🎉', 'ok');
  } catch (err) {
    setAuthError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? '登 录' : '注 册';
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* 忽略 */ }
  clearSession();
  toast('已退出登录');
}

/* ---------- 配置 ---------- */
async function initConfig() {
  try {
    const cfg = await api('/api/config');
    state.config = cfg;
    const prefs = readJSON(PREFS_KEY, {});
    const provSel = $('providerSelect');
    provSel.innerHTML = '';
    for (const p of cfg.providers) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = `${p.label}${p.hasKey ? '' : '（未配 Key）'}`;
      provSel.appendChild(opt);
    }
    provSel.value = cfg.providers.some((p) => p.key === prefs.provider) ? prefs.provider : cfg.defaultProvider;
    fillModels(prefs.model);
    renderTasteChips(cfg.tastes);
    $('mockBadge').classList.toggle('hidden', !cfg.mockMode);
  } catch (e) {
    toast('加载模型配置失败：' + e.message, 'err');
    renderTasteChips();
  }
}

function fillModels(preferred) {
  const key = $('providerSelect').value;
  const provider = state.config?.providers.find((p) => p.key === key);
  const sel = $('modelSelect');
  sel.innerHTML = '';
  for (const m of provider?.models || []) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    sel.appendChild(opt);
  }
  if (preferred && [...sel.options].some((o) => o.value === preferred)) sel.value = preferred;
  syncThinkingRow();
}

/** 只有支持深度思考的模型才显示这个开关 */
function syncThinkingRow() {
  const provider = state.config?.providers.find((p) => p.key === $('providerSelect').value);
  const model = provider?.models.find((m) => m.id === $('modelSelect').value);
  $('thinkingRow').classList.toggle('hidden', !model?.thinking);
}

/* ---------- 表单 ---------- */
function renderTasteChips(list) {
  const chipBox = $('tasteChips');
  const fromServer = Array.isArray(list) && list.length;
  // 先用内置列表渲染保证首屏可用，拿到服务端列表后再替换一次
  if (chipBox.dataset.source === 'server' || (chipBox.dataset.source === 'default' && !fromServer)) return;
  const prefs = readJSON(PREFS_KEY, {});
  const on = new Set([
    ...(prefs.tastes || []),
    ...[...chipBox.querySelectorAll('.chip.on')].map((c) => c.textContent),
  ]);
  chipBox.dataset.source = fromServer ? 'server' : 'default';
  chipBox.innerHTML = '';
  for (const t of (fromServer ? list : DEFAULT_TASTES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (on.has(t) ? ' on' : '');
    b.textContent = t;
    b.setAttribute('aria-pressed', on.has(t) ? 'true' : 'false');
    b.addEventListener('click', () => {
      b.classList.toggle('on');
      b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
      savePrefs();
    });
    chipBox.appendChild(b);
  }
}

function savePrefs() {
  writeJSON(PREFS_KEY, {
    people: parseInt($('peopleInput').value) || 2,
    days: parseInt($('daysRange').value) || 1,
    mealType: document.querySelector('.type-card.active')?.dataset.type || 'family',
    meals: selectedMeals(),
    tastes: [...document.querySelectorAll('#tasteChips .chip.on')].map((c) => c.textContent),
    useMemory: $('useMemory').checked,
    thinking: $('deepThinking').checked,
    provider: $('providerSelect').value,
    model: $('modelSelect').value,
  });
}

function restorePrefs() {
  const p = readJSON(PREFS_KEY, null);
  if (!p) return;
  if (p.people) $('peopleInput').value = Math.min(Math.max(p.people, 1), 30);
  if (p.days) $('daysRange').value = Math.min(Math.max(p.days, 1), 7);
  if (Array.isArray(p.meals) && p.meals.length) setMeals(p.meals);
  else if (p.mealsPerDay) setMeals(p.mealsPerDay === 'all' ? ['breakfast', 'lunch', 'dinner'] : ['lunch', 'dinner']);
  if (typeof p.useMemory === 'boolean') $('useMemory').checked = p.useMemory;
  if (typeof p.thinking === 'boolean') $('deepThinking').checked = p.thinking;
  if (p.mealType) selectType(p.mealType);
}

/** 当前勾选的餐次，按早→中→晚的固定顺序返回 */
function selectedMeals() {
  return [...document.querySelectorAll('#mealSlots .slot-btn.on')].map((b) => b.dataset.slot);
}

function setMeals(list) {
  const want = new Set(list);
  document.querySelectorAll('#mealSlots .slot-btn').forEach((b) => {
    const on = want.has(b.dataset.slot);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function selectType(type) {
  document.querySelectorAll('.type-card').forEach((c) => {
    const on = c.dataset.type === type;
    c.classList.toggle('active', on);
    c.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

/**
 * 登录相关的绑定单独拎出来最先执行：
 * 表单没有 action，一旦 submit 没被拦住，浏览器就会原生 GET 当前地址，
 * 页面被刷成 /? 且看起来像「登不上」。所以这几行必须在任何可能抛错的代码之前跑完。
 */
function bindAuthUI() {
  document.querySelectorAll('.auth-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  $('authForm').addEventListener('submit', submitAuth);
  $('logoutBtn').addEventListener('click', logout);
}

function initForm() {
  // 人数步进
  const peopleInput = $('peopleInput');
  const clampPeople = () => {
    peopleInput.value = Math.min(Math.max(parseInt(peopleInput.value) || 1, 1), 30);
    savePrefs();
  };
  $('peopleMinus').addEventListener('click', () => { peopleInput.stepDown(); clampPeople(); });
  $('peoplePlus').addEventListener('click', () => { peopleInput.stepUp(); clampPeople(); });
  peopleInput.addEventListener('change', clampPeople);

  // 天数滑杆
  const range = $('daysRange');
  const syncRange = () => {
    $('daysLabel').textContent = range.value;
    const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
    range.style.setProperty('--fill', pct + '%');
  };
  range.addEventListener('input', syncRange);
  range.addEventListener('change', savePrefs);

  // 用餐类型卡片
  document.querySelectorAll('.type-card').forEach((card) => {
    card.addEventListener('click', () => { selectType(card.dataset.type); savePrefs(); });
  });
  document.querySelectorAll('#mealSlots .slot-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const on = btn.classList.contains('on');
      // 至少保留一餐，否则生成出来是空的
      if (on && selectedMeals().length === 1) return toast('至少要选一餐', 'warn');
      btn.classList.toggle('on', !on);
      btn.setAttribute('aria-pressed', String(!on));
      savePrefs();
    });
  });
  $('useMemory').addEventListener('change', savePrefs);
  $('deepThinking').addEventListener('change', savePrefs);

  restorePrefs();
  syncRange();
  renderTasteChips();

  // 顶栏
  $('themeBtn').addEventListener('click', cycleTheme);
  $('navToggle').addEventListener('click', () => {
    const open = $('topbarRight').classList.toggle('open');
    $('navToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $('providerSelect').addEventListener('change', () => { fillModels(); savePrefs(); });
  $('modelSelect').addEventListener('change', () => { syncThinkingRow(); savePrefs(); });

  // 密钥弹窗
  $('keysBtn').addEventListener('click', openKeys);
  $('keysClose').addEventListener('click', () => $('keysModal').classList.add('hidden'));
  $('keysSaveBtn').addEventListener('click', saveKeys);
  document.querySelectorAll('.toggle-vis').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });
  document.querySelectorAll('.clear-key').forEach((btn) => {
    btn.addEventListener('click', () => clearKey(btn.dataset.provider));
  });

  // 结果操作
  $('generateBtn').addEventListener('click', () => generate());
  $('regenBtn').addEventListener('click', () => generate(state.lastParams));
  $('copyBtn').addEventListener('click', copyPlan);
  $('exportBtn').addEventListener('click', exportPlan);
  $('printBtn').addEventListener('click', () => window.print());
  $('cookAllBtn').addEventListener('click', toggleWholeDay);
  $('cookConfirmBtn').addEventListener('click', openStartDatePicker);

  // 做菜界面
  $('cookModeBtn').addEventListener('click', enterCookMode);
  $('cookBackBtn').addEventListener('click', exitCookMode);
  $('cookPrevDay').addEventListener('click', () => { state.cookDay = Math.max(0, state.cookDay - 1); renderCookView(); });
  $('cookNextDay').addEventListener('click', () => {
    state.cookDay = Math.min((state.plan?.days?.length || 1) - 1, state.cookDay + 1);
    renderCookView();
  });
  $('cookTodayBtn').addEventListener('click', () => {
    const offset = Math.round((new Date(todayKey() + 'T00:00:00') - new Date(state.startDate + 'T00:00:00')) / 86400000);
    const total = state.plan?.days?.length || 1;
    if (offset < 0 || offset >= total) return toast('今天不在这份菜单的日期范围内', 'warn');
    state.cookDay = offset;
    renderCookView();
  });
  $('cookIngBtn').addEventListener('click', summarizeIngredients);

  // 开始日期弹窗
  $('startDateClose').addEventListener('click', () => $('startDateModal').classList.add('hidden'));
  $('startDateConfirm').addEventListener('click', confirmStartDate);
  $('startDateInput').addEventListener('change', updateStartDatePreview);
  document.querySelectorAll('.quick-dates [data-offset]').forEach((b) => {
    b.addEventListener('click', () => {
      $('startDateInput').value = addDays(todayKey(), Number(b.dataset.offset));
      updateStartDatePreview();
    });
  });
  $('startDateModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  $('shopResetBtn').addEventListener('click', () => {
    state.checkedItems.clear();
    persistChecked();
    renderShopping();
  });

  // 弹窗
  $('detailClose').addEventListener('click', () => $('detailModal').classList.add('hidden'));
  $('memoryBtn').addEventListener('click', openMemory);
  $('memoryClose').addEventListener('click', () => $('memoryModal').classList.add('hidden'));
  $('memSaveBtn').addEventListener('click', () => saveMemory());
  $('histClearBtn').addEventListener('click', clearHistory);
  $('pwSaveBtn').addEventListener('click', changePassword);
  ['detailModal', 'memoryModal', 'keysModal'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); });
  });

  initPantry();

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.user && !state.loading) {
      if (state.mode === 'pantry') findByIngredients(); else generate();
    }
  });
}

function collectParams() {
  return {
    people: parseInt($('peopleInput').value) || 2,
    days: parseInt($('daysRange').value) || 1,
    mealType: document.querySelector('.type-card.active')?.dataset.type || 'family',
    meals: selectedMeals(),
    tastes: [...document.querySelectorAll('#tasteChips .chip.on')].map((c) => c.textContent),
    extra: $('extraInput').value.trim(),
    useMemory: $('useMemory').checked,
    thinking: $('deepThinking').checked,
    provider: $('providerSelect').value,
    model: $('modelSelect').value,
  };
}

/* ---------- 密钥管理 ---------- */
async function openKeys() {
  try {
    const { hasKeys, maskedKeys } = await api('/api/keys');
    renderKeyState('deepseek', hasKeys.deepseek, maskedKeys.deepseek);
    renderKeyState('qwen', hasKeys.qwen, maskedKeys.qwen);
    $('deepseekKeyInput').value = '';
    $('qwenKeyInput').value = '';
    $('keysModal').classList.remove('hidden');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderKeyState(provider, has, masked) {
  const el = $(provider + 'State');
  el.textContent = has ? `已保存 ${masked}` : '未配置';
  el.className = `key-state ${has ? 'ok' : 'no'}`;
}

async function refreshKeyStates() {
  const fresh = await api('/api/keys');
  renderKeyState('deepseek', fresh.hasKeys.deepseek, fresh.maskedKeys.deepseek);
  renderKeyState('qwen', fresh.hasKeys.qwen, fresh.maskedKeys.qwen);
}

async function saveKeys() {
  const ds = $('deepseekKeyInput').value.trim();
  const qw = $('qwenKeyInput').value.trim();
  if (!ds && !qw) return toast('请填写至少一个 Key（清除已有 Key 请点「清除」）', 'warn');
  try {
    if (ds) await api('/api/keys', { method: 'POST', body: JSON.stringify({ provider: 'deepseek', key: ds }) });
    if (qw) await api('/api/keys', { method: 'POST', body: JSON.stringify({ provider: 'qwen', key: qw }) });
    await refreshKeyStates();
    $('deepseekKeyInput').value = '';
    $('qwenKeyInput').value = '';
    const model = $('modelSelect').value;
    await initConfig();
    fillModels(model);
    toast('✅ 密钥已保存，生成将优先使用你的 Key', 'ok');
  } catch (e) {
    toast(e.message, 'err', 3200);
  }
}

async function clearKey(provider) {
  if (!confirm(`确定清除已保存的 ${provider === 'qwen' ? '通义千问' : 'DeepSeek'} Key 吗？`)) return;
  try {
    await api('/api/keys', { method: 'POST', body: JSON.stringify({ provider, key: '' }) });
    await refreshKeyStates();
    await initConfig();
    toast('已清除', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------- 生成菜谱 ---------- */
const LOADING_TITLE = {
  banquet: '大厨正在设计宴席菜单…',
  simple: '大厨正在搭配快手简餐…',
  family: '大厨正在为你配菜…',
};

async function generate(reuseParams) {
  if (state.loading) return;
  const params = reuseParams || collectParams();
  state.lastParams = params;
  savePrefs();
  setLoading(true, LOADING_TITLE[params.mealType] || LOADING_TITLE.family);
  try {
    const plan = await api('/api/recipes/generate', { method: 'POST', body: JSON.stringify(params) });
    state.plan = plan;
    state.dayIndex = 0;
    state.checkedItems = new Set(readJSON(shopKeyOf(state.user?.username, plan), []));
    state.cooked = new Set(readJSON(cookKeyOf(state.user?.username, plan), []));
    state.startDate = '';
    state.done.clear();
    renderPlan();
    persistPlan();
    const sec = plan.meta?.elapsedMs ? `（${(plan.meta.elapsedMs / 1000).toFixed(1)}s）` : '';
    toast(plan.mock
      ? '已用演示数据生成（点右上角「🔑 我的密钥」启用大模型）'
      : `✨ 菜谱已生成${sec}，点击菜品可查看详细做法`, 'ok', 3000);
  } catch (e) {
    toast('生成失败：' + e.message, 'err', 4000);
  } finally {
    setLoading(false);
  }
}

function persistPlan() {
  if (state.plan) {
    writeJSON(planKeyOf(state.user?.username), {
      plan: state.plan, params: state.lastParams, dayIndex: state.dayIndex, startDate: state.startDate,
    });
  }
}

function restorePlan() {
  const saved = readJSON(planKeyOf(state.user?.username), null);
  if (!saved?.plan?.days?.length) return;
  state.plan = saved.plan;
  state.lastParams = saved.params || null;
  state.dayIndex = Math.min(saved.dayIndex || 0, saved.plan.days.length - 1);
  state.checkedItems = new Set(readJSON(shopKeyOf(state.user?.username, saved.plan), []));
  state.cooked = new Set(readJSON(cookKeyOf(state.user?.username, saved.plan), []));
  state.startDate = saved.startDate || '';
  renderPlan();
}

function persistChecked() {
  writeJSON(shopKeyOf(state.user?.username, state.plan), [...state.checkedItems]);
}

/* ---------- 渲染菜谱 ---------- */
function renderPlan() {
  const plan = state.plan;
  if (!plan) return;
  $('emptyState').classList.add('hidden');
  $('resultWrap').classList.remove('hidden');

  $('planTitle').textContent = plan.title || '定制菜单';
  $('planSummary').textContent = plan.summary || '';
  document.title = `${plan.title || 'AI 智能菜谱'} · AI 智能菜谱`;

  renderMeta(plan);
  renderTips(plan);

  // 天数 Tab
  const tabs = $('dayTabs');
  tabs.innerHTML = '';
  (plan.days || []).forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'day-tab' + (i === state.dayIndex ? ' active' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', i === state.dayIndex ? 'true' : 'false');
    b.textContent = d.label || (plan.days.length > 1 ? `第 ${d.day ?? i + 1} 天` : '当天菜单');
    b.addEventListener('click', () => { state.dayIndex = i; renderPlan(); persistPlan(); });
    tabs.appendChild(b);
  });
  tabs.classList.toggle('hidden', (plan.days || []).length < 2);

  renderMeals(plan);
  renderPrintArea(plan);
  renderShopping();
  updateCookBar();
  syncCookEntry();
}

/** 屏幕上只显示当前 Tab 的一天，打印时输出全部天数 */
function renderPrintArea(plan) {
  const box = $('printArea');
  box.innerHTML = '';
  for (const day of plan.days || []) {
    const h = document.createElement('div');
    h.className = 'print-day-title';
    h.textContent = day.label || `第 ${day.day} 天`;
    box.appendChild(h);
    for (const meal of day.meals || []) {
      const card = document.createElement('div');
      card.className = 'meal-card';
      const head = document.createElement('div');
      head.className = 'meal-head';
      const tag = document.createElement('span');
      tag.className = 'meal-type-tag';
      tag.textContent = meal.type || '';
      head.appendChild(tag);
      if (meal.theme) {
        const theme = document.createElement('span');
        theme.className = 'meal-theme';
        theme.textContent = meal.theme;
        head.appendChild(theme);
      }
      card.appendChild(head);
      if (meal.staple) {
        const staple = document.createElement('div');
        staple.className = 'meal-staple';
        staple.textContent = `🍚 主食：${meal.staple}`;
        card.appendChild(staple);
      }
      const grid = document.createElement('div');
      grid.className = 'dish-grid';
      for (const dish of meal.dishes || []) {
        const el = document.createElement('div');
        el.className = 'dish-card';
        const cat = document.createElement('span');
        cat.className = 'dish-cat';
        cat.textContent = dish.category || '菜品';
        const nm = document.createElement('div');
        nm.className = 'dish-name';
        nm.textContent = dish.name || '';
        const br = document.createElement('div');
        br.className = 'dish-brief';
        br.textContent = dish.brief || '';
        el.append(cat, nm, br);
        grid.appendChild(el);
      }
      card.appendChild(grid);
      box.appendChild(card);
    }
  }
}

function renderMeta(plan) {
  const box = $('planMeta');
  box.innerHTML = '';
  const m = plan.meta || {};
  const bits = [
    m.people && `👥 ${m.people} 人`,
    plan.days?.length && `📅 ${plan.days.length} 天`,
    m.mealTypeLabel && `🍽 ${m.mealTypeLabel}`,
    m.tastes?.length && `🌶 ${m.tastes.join('/')}`,
    m.ingredients?.length && `🥬 用了 ${(plan.usedFromPantry || []).length}/${m.ingredients.length} 样现有食材`,
    plan.fromHistory ? '🕐 历史回看' : m.model && `🤖 ${m.model}`,
    !plan.fromHistory && m.thinking && '🧠 深度思考',
    plan.mock && '🧪 演示数据',
  ].filter(Boolean);
  for (const b of bits) {
    const s = document.createElement('span');
    s.className = 'meta-chip';
    s.textContent = b;
    box.appendChild(s);
  }
}

function renderTips(plan) {
  const box = $('planTips');
  box.innerHTML = '';
  const tips = plan.tips || [];
  box.classList.toggle('hidden', !tips.length);
  if (!tips.length) return;
  const ul = document.createElement('ul');
  for (const t of tips) {
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

function renderMeals(plan) {
  const list = $('mealList');
  list.innerHTML = '';
  const day = (plan.days || [])[state.dayIndex];
  for (const meal of day?.meals || []) {
    const card = document.createElement('div');
    card.className = 'meal-card';

    const head = document.createElement('div');
    head.className = 'meal-head';
    const tag = document.createElement('span');
    tag.className = 'meal-type-tag';
    tag.textContent = meal.type || '';
    head.appendChild(tag);
    if (meal.theme) {
      const theme = document.createElement('span');
      theme.className = 'meal-theme';
      theme.textContent = meal.theme;
      head.appendChild(theme);
    }
    card.appendChild(head);

    if (meal.staple) {
      const staple = document.createElement('div');
      staple.className = 'meal-staple';
      staple.textContent = `🍚 主食：${meal.staple}`;
      card.appendChild(staple);
    }

    const grid = document.createElement('div');
    grid.className = 'dish-grid';
    for (const dish of meal.dishes || []) grid.appendChild(dishCard(dish, state.dayIndex));
    card.appendChild(grid);
    list.appendChild(card);
  }
}

const CAT_CLASS = {
  凉菜: 'cold', 荤菜: 'meat', 素菜: 'veg', 汤品: 'soup', 蒸菜: 'steam', 主食: 'staple', 甜点: 'sweet',
};

function dishCard(dish, dayIndex) {
  const el = document.createElement('div');
  el.className = 'dish-card';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `查看${dish.name}的详细做法`);

  const key = pickKey(dayIndex, dish.name);
  el.classList.toggle('picked', state.cooked.has(key));

  const topRow = document.createElement('div');
  topRow.className = 'dish-top';
  const cat = document.createElement('span');
  cat.className = `dish-cat cat-${CAT_CLASS[dish.category] || 'other'}`;
  cat.textContent = dish.category || '菜品';
  topRow.append(cat, cookToggle(key, el));

  const nameRow = document.createElement('div');
  nameRow.className = 'dish-name';
  const dn = document.createElement('span');
  dn.className = 'dn';
  dn.textContent = dish.name || '';
  const fbBox = document.createElement('span');
  fbBox.className = 'dish-fb';
  fbBox.appendChild(fbButton(dish.name, 'like'));
  fbBox.appendChild(fbButton(dish.name, 'dislike'));
  nameRow.append(dn, fbBox);

  const brief = document.createElement('div');
  brief.className = 'dish-brief';
  brief.textContent = dish.brief || '';

  el.append(topRow, nameRow, brief);
  el.addEventListener('click', (e) => {
    if (e.target.closest('.fb-btn') || e.target.closest('.cook-toggle')) return;
    showDetail(dish.name);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(dish.name); }
  });
  return el;
}

/**
 * 「本次要做」勾选。
 * 和 👍/👎 是两回事：那个记的是口味偏好，这个记的是「我真的做了」，
 * 只有确认后的菜才进「最近做过」，后续生成才会避开它。
 */
function cookToggle(key, card) {
  const label = document.createElement('label');
  label.className = 'cook-toggle';
  label.title = '勾选＝这道菜我这次要做';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = state.cooked.has(key);
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => {
    if (cb.checked) state.cooked.add(key);
    else state.cooked.delete(key);
    card.classList.toggle('picked', cb.checked);
    persistCooked();
    updateCookBar();
  });
  const txt = document.createElement('span');
  txt.textContent = '要做';
  label.append(cb, txt);
  return label;
}

function persistCooked() {
  writeJSON(cookKeyOf(state.user?.username, state.plan), [...state.cooked]);
}

function currentDayDishes() {
  const day = (state.plan?.days || [])[state.dayIndex];
  return (day?.meals || [])
    .flatMap((m) => (m.dishes || []).map((d) => d.name))
    .filter(Boolean)
    .map((name) => pickKey(state.dayIndex, name));
}

function updateCookBar() {
  const bar = $('cookBar');
  if (!state.plan) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  const n = state.cooked.size;
  $('cookCount').textContent = n ? `已选 ${n} 道` : '还没选菜';
  $('cookConfirmBtn').disabled = n === 0;

  const today = currentDayDishes();
  const allPicked = today.length > 0 && today.every((d) => state.cooked.has(d));
  $('cookAllBtn').textContent = allPicked ? '取消本天' : '全选本天';
}

function toggleWholeDay() {
  const today = currentDayDishes();
  if (!today.length) return;
  const allPicked = today.every((d) => state.cooked.has(d));
  today.forEach((d) => (allPicked ? state.cooked.delete(d) : state.cooked.add(d)));
  persistCooked();
  renderMeals(state.plan);
  updateCookBar();
}

function fbButton(dishName, act) {
  const btn = document.createElement('button');
  btn.className = 'fb-btn';
  btn.dataset.act = act;
  btn.title = act === 'like' ? '喜欢，以后多推荐类似' : '不喜欢，以后不再出现';
  btn.textContent = fbIcon(dishName, act);
  btn.classList.toggle('on', state.feedback.get(dishName) === act);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    sendFeedback(dishName, act);
  });
  return btn;
}

function fbIcon(dishName, act) {
  const cur = state.feedback.get(dishName);
  if (act === 'like') return cur === 'like' ? '💛' : '👍';
  return cur === 'dislike' ? '🚫' : '👎';
}

/** 反馈状态可能出现在多处（菜品卡片 + 详情弹窗），统一刷新 */
function refreshFbButtons(dishName) {
  document.querySelectorAll('.fb-btn').forEach((btn) => {
    const card = btn.closest('.dish-card, .detail-fb');
    const name = card?.querySelector('.dn, .dname')?.textContent || card?.dataset.dish;
    if (name !== dishName) return;
    btn.textContent = fbIcon(dishName, btn.dataset.act);
    btn.classList.toggle('on', state.feedback.get(dishName) === btn.dataset.act);
  });
}

async function sendFeedback(dish, action) {
  const cur = state.feedback.get(dish);
  const next = cur === action ? null : action;
  const payload = next ? action : action === 'like' ? 'unlike' : 'undislike';
  try {
    await api('/api/feedback', { method: 'POST', body: JSON.stringify({ dish, action: payload }) });
    if (next) state.feedback.set(dish, next); else state.feedback.delete(dish);
    refreshFbButtons(dish);
    toast(next === 'like' ? `已记住：喜欢「${dish}」`
      : next === 'dislike' ? `已记住：不喜欢「${dish}」，以后不再推荐`
        : '已取消反馈', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function syncFeedbackFromProfile() {
  try {
    const profile = await api('/api/memory');
    state.feedback.clear();
    (profile.likedDishes || []).forEach((d) => state.feedback.set(d, 'like'));
    (profile.dislikedDishes || []).forEach((d) => state.feedback.set(d, 'dislike'));
  } catch { /* 记忆读取失败不影响主流程 */ }
}

/* ---------- 采购清单 ---------- */
function renderShopping() {
  const wrap = $('shoppingList');
  wrap.innerHTML = '';
  // 带了现有食材时，清单里只有还得买的，标题要说清楚
  const fromPantry = Boolean(state.plan?.meta?.ingredients?.length);
  document.querySelector('.shopping-head h3').textContent = fromPantry ? '🛒 还需补买' : '🛒 采购清单';
  const items = state.plan?.shoppingList || [];
  if (!items.length) {
    wrap.innerHTML = '<p class="muted">本次生成没有返回采购清单。</p>';
    $('shopProgress').textContent = '';
    return;
  }

  const groups = new Map();
  for (const item of items) {
    const g = item.category || '其他';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(item);
  }

  for (const [name, list] of groups) {
    const box = document.createElement('div');
    box.className = 'shop-group';
    if (groups.size > 1 || name !== '其他') {
      const h = document.createElement('h4');
      h.textContent = name;
      box.appendChild(h);
    }
    const grid = document.createElement('div');
    grid.className = 'shopping-grid';
    for (const item of list) grid.appendChild(shopItem(item));
    box.appendChild(grid);
    wrap.appendChild(box);
  }
  updateShopProgress();
}

function shopItem(item) {
  const label = document.createElement('label');
  label.className = 'shop-item' + (state.checkedItems.has(item.name) ? ' done' : '');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = state.checkedItems.has(item.name);
  cb.addEventListener('change', () => {
    if (cb.checked) state.checkedItems.add(item.name);
    else state.checkedItems.delete(item.name);
    label.classList.toggle('done', cb.checked);
    persistChecked();
    updateShopProgress();
  });
  const nm = document.createElement('span');
  nm.className = 'shop-name';
  nm.textContent = item.name || '';
  const amt = document.createElement('b');
  amt.textContent = item.amount || '';
  label.append(cb, nm, amt);
  return label;
}

function updateShopProgress() {
  const total = (state.plan?.shoppingList || []).length;
  if (!total) return;
  const done = (state.plan.shoppingList || []).filter((i) => state.checkedItems.has(i.name)).length;
  $('shopProgress').textContent = `${done} / ${total} 已备齐`;
}

/* ---------- 复制 / 导出 / 打印 ---------- */
function planToText(plan, { markdown = false } = {}) {
  const h1 = markdown ? '# ' : '';
  const h2 = markdown ? '## ' : '';
  const h3 = markdown ? '### ' : '';
  const out = [`${h1}${plan.title || '定制菜单'}`];
  if (plan.summary) out.push('', plan.summary);
  const m = plan.meta || {};
  const metaLine = [m.people && `${m.people} 人`, plan.days?.length && `${plan.days.length} 天`, m.mealTypeLabel, m.tastes?.length && m.tastes.join('/')]
    .filter(Boolean).join(' · ');
  if (metaLine) out.push('', markdown ? `> ${metaLine}` : metaLine);

  for (const day of plan.days || []) {
    out.push('', `${h2}第 ${day.day} 天`);
    for (const meal of day.meals || []) {
      out.push('', `${h3}${meal.type}${meal.theme ? ` · ${meal.theme}` : ''}`);
      if (meal.staple) out.push(`${markdown ? '- ' : '  '}主食：${meal.staple}`);
      for (const d of meal.dishes || []) {
        out.push(`${markdown ? '- ' : '  '}【${d.category || '菜品'}】${d.name}${d.brief ? ` —— ${d.brief}` : ''}`);
      }
    }
  }

  if (plan.shoppingList?.length) {
    out.push('', `${h2}采购清单`);
    const groups = new Map();
    for (const it of plan.shoppingList) {
      const g = it.category || '其他';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    for (const [g, list] of groups) {
      out.push('', `${h3}${g}`);
      for (const it of list) out.push(`${markdown ? '- [ ] ' : '  '}${it.name}${it.amount ? ` · ${it.amount}` : ''}`);
    }
  }

  if (plan.tips?.length) {
    out.push('', `${h2}备餐建议`);
    for (const t of plan.tips) out.push(`${markdown ? '- ' : '  '}${t}`);
  }
  return out.join('\n');
}

async function copyPlan() {
  if (!state.plan) return;
  const text = planToText(state.plan);
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制整份菜单 📋', 'ok');
  } catch {
    // 非安全上下文时的兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? '已复制整份菜单 📋' : '复制失败，请手动选择文本', ok ? 'ok' : 'err');
  }
}

function download(filename, text, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPlan() {
  if (!state.plan) return;
  const safe = (state.plan.title || '菜单').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  download(`${safe}.md`, planToText(state.plan, { markdown: true }));
  toast('已导出 Markdown ⬇️', 'ok');
}

/* ---------- 菜品详情 ---------- */
function detailCacheKey(dish, people, params) {
  return `${dish}|${people}|${params.provider}|${params.model}|${params.thinking ? 'T' : ''}`;
}

/** 取某道菜的做法，命中缓存就直接返回（做菜界面汇总食材也复用它） */
async function fetchDetail(dishName) {
  const p = state.lastParams || collectParams();
  const people = state.plan?.meta?.people || p.people;
  const key = detailCacheKey(dishName, people, p);
  if (state.detailCache.has(key)) return state.detailCache.get(key);

  const detail = await api('/api/recipes/detail', {
    method: 'POST',
    body: JSON.stringify({
      dish: dishName,
      people,
      tastes: state.plan?.meta?.tastes || p.tastes,
      mealType: state.plan?.meta?.mealType || p.mealType,
      context: state.plan?.title || '',
      provider: p.provider,
      model: p.model,
      thinking: p.thinking,
    }),
  });
  state.detailCache.set(key, detail);
  return detail;
}

function isDetailCached(dishName) {
  const p = state.lastParams || collectParams();
  return state.detailCache.has(detailCacheKey(dishName, state.plan?.meta?.people || p.people, p));
}

async function showDetail(dishName) {
  const cached = isDetailCached(dishName);
  if (!cached) setLoading(true, `正在编写「${dishName}」的详细做法…`);
  try {
    renderDetail(await fetchDetail(dishName));
  } catch (e) {
    toast('获取详情失败：' + e.message, 'err', 3500);
  } finally {
    if (!cached) setLoading(false);
  }
}

function ingGrid(items) {
  const div = document.createElement('div');
  div.className = 'ing-list';
  for (const it of items || []) {
    const row = document.createElement('div');
    row.className = 'ing-item';
    const a = document.createElement('span');
    a.textContent = it.name || '';
    const b = document.createElement('span');
    b.textContent = it.amount || '';
    row.append(a, b);
    div.appendChild(row);
  }
  return div;
}

function renderDetail(d) {
  const body = $('detailBody');
  body.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'detail-head detail-fb';
  head.dataset.dish = d.name || '';
  const h2 = document.createElement('h2');
  h2.className = 'dname';
  h2.id = 'detailTitleRef';
  h2.textContent = d.name || '';
  const fb = document.createElement('span');
  fb.className = 'dish-fb';
  fb.appendChild(fbButton(d.name, 'like'));
  fb.appendChild(fbButton(d.name, 'dislike'));
  const titleRow = document.createElement('div');
  titleRow.className = 'detail-title-row';
  titleRow.append(h2, fb);
  const intro = document.createElement('p');
  intro.className = 'muted intro';
  intro.textContent = d.intro || '';
  head.append(titleRow, intro);
  body.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  [d.difficulty && `难度：${d.difficulty}`, d.time && `耗时：${d.time}`, d.servings && `${d.servings} 人份`, d.mock && '演示数据']
    .filter(Boolean)
    .forEach((t) => {
      const pill = document.createElement('span');
      pill.className = 'meta-pill';
      pill.textContent = t;
      meta.appendChild(pill);
    });
  body.appendChild(meta);

  const mkSection = (title, node) => {
    if (!node || !node.childNodes.length) return;
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    const h = document.createElement('h3');
    h.textContent = title;
    sec.append(h, node);
    body.appendChild(sec);
  };

  if (d.ingredients?.length) mkSection('🥬 食材', ingGrid(d.ingredients));
  if (d.seasoning?.length) mkSection('🧂 调料', ingGrid(d.seasoning));

  if (d.steps?.length) {
    const ol = document.createElement('ol');
    ol.className = 'step-list';
    d.steps.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = s;
      ol.appendChild(li);
    });
    mkSection('👨‍🍳 做法步骤', ol);
  }

  if (d.tips) {
    const tips = document.createElement('div');
    tips.className = 'tips-box';
    tips.textContent = '💡 ' + d.tips;
    body.appendChild(tips);
  }
  if (d.nutrition) {
    const nut = document.createElement('div');
    nut.className = 'nutrition-box';
    nut.textContent = '🥗 ' + d.nutrition;
    body.appendChild(nut);
  }

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'ghost-btn';
  copyBtn.textContent = '📋 复制做法';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(detailToText(d));
      toast('做法已复制 📋', 'ok');
    } catch {
      toast('复制失败，请手动选择文本', 'err');
    }
  });
  actions.appendChild(copyBtn);
  body.appendChild(actions);

  $('detailModal').classList.remove('hidden');
  $('detailModal').querySelector('.modal-card').scrollTop = 0;
}

function detailToText(d) {
  const lines = [d.name];
  if (d.intro) lines.push(d.intro);
  lines.push([d.difficulty && `难度：${d.difficulty}`, d.time && `耗时：${d.time}`, d.servings && `${d.servings} 人份`].filter(Boolean).join(' · '));
  if (d.ingredients?.length) lines.push('', '【食材】', ...d.ingredients.map((i) => `${i.name} ${i.amount}`));
  if (d.seasoning?.length) lines.push('', '【调料】', ...d.seasoning.map((i) => `${i.name} ${i.amount}`));
  if (d.steps?.length) lines.push('', '【做法】', ...d.steps.map((s, i) => `${i + 1}. ${s}`));
  if (d.tips) lines.push('', `【小贴士】${d.tips}`);
  if (d.nutrition) lines.push(`【营养】${d.nutrition}`);
  return lines.filter((l) => l !== undefined).join('\n');
}

/* ---------- 记忆面板 ---------- */
let memProfile = null;

async function openMemory() {
  try {
    memProfile = await api('/api/memory');
    fillMemoryForm();
    $('memoryModal').classList.remove('hidden');
  } catch (e) {
    toast('读取记忆失败：' + e.message, 'err');
  }
}

const TAG_ROW_LIMIT = 18;

function tagRow(label, arrKey, cls, expanded = false) {
  const row = document.createElement('div');
  row.className = 'tag-row';
  const lab = document.createElement('span');
  lab.className = 'tag-label';
  lab.textContent = label;
  row.appendChild(lab);

  const items = memProfile[arrKey] || [];
  if (!items.length) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = '暂无';
    row.appendChild(none);
    return row;
  }

  // 「最近做过」可能有几十条，默认只展示前若干个，避免面板被撑爆
  const shown = expanded ? items : items.slice(0, TAG_ROW_LIMIT);
  for (const item of shown) {
    const tag = document.createElement('span');
    tag.className = `tag ${cls}`;
    const tv = document.createElement('span');
    tv.className = 'tv';
    tv.textContent = item;
    const x = document.createElement('button');
    x.className = 'tag-x';
    x.title = '移除';
    x.textContent = '×';
    x.addEventListener('click', async () => {
      memProfile[arrKey] = memProfile[arrKey].filter((v) => v !== item);
      await saveMemory(true);
      if (arrKey === 'likedDishes' || arrKey === 'dislikedDishes') {
        state.feedback.delete(item);
        refreshFbButtons(item);
      }
      fillMemoryForm();
    });
    tag.append(tv, x);
    row.appendChild(tag);
  }

  if (items.length > shown.length) {
    const more = document.createElement('button');
    more.className = 'link-btn';
    more.textContent = `展开其余 ${items.length - shown.length} 项`;
    more.addEventListener('click', () => row.replaceWith(tagRow(label, arrKey, cls, true)));
    row.appendChild(more);
  }
  return row;
}

function fillMemoryForm() {
  if (!memProfile) return;
  $('memNickname').value = memProfile.nickname || '';
  $('memHousehold').value = memProfile.householdSize || 2;
  $('memTastePrefs').value = (memProfile.tastePrefs || []).join('、');
  $('memDislikedTastes').value = (memProfile.dislikedTastes || []).join('、');
  $('memAllergies').value = (memProfile.allergies || []).join('、');

  const box = $('memTags');
  box.innerHTML = '';
  box.appendChild(tagRow('👍 喜欢', 'likedDishes', 'like'));
  box.appendChild(tagRow('👎 不喜欢', 'dislikedDishes', 'dislike'));
  box.appendChild(tagRow('🕐 最近做过', 'recentDishes', 'recent'));

  renderHistoryList();
}

function renderHistoryList() {
  const ul = $('memHistory');
  ul.innerHTML = '';
  const history = memProfile.history || [];
  $('histClearBtn').classList.toggle('hidden', !history.length);
  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '还没有生成记录，去生成第一份菜谱吧～';
    ul.appendChild(li);
    return;
  }
  for (const h of history.slice(0, 20)) {
    const li = document.createElement('li');

    const main = document.createElement('button');
    main.className = 'hist-main' + (h.hasPlan === false ? ' archived' : '');
    main.title = h.hasPlan === false ? '这条记录较早，只保留了菜名摘要' : '点击回看这份菜单';
    const t = document.createElement('span');
    t.className = 'hist-title';
    t.textContent = h.title;
    const sub = document.createElement('small');
    sub.className = 'muted';
    sub.textContent = `${h.people} 人 × ${h.days} 天${h.mealType ? ' · ' + h.mealType : ''}${h.tastes?.length ? ' · ' + h.tastes.join('/') : ''}`;
    main.append(t, sub);
    main.addEventListener('click', () => loadHistory(h.id));

    const right = document.createElement('span');
    right.className = 'hist-right';
    const time = document.createElement('small');
    time.textContent = new Date(h.date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const del = document.createElement('button');
    del.className = 'tag-x';
    del.title = '删除这条记录';
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteHistory(h.id); });
    right.append(time, del);

    li.append(main, right);
    ul.appendChild(li);
  }
}

async function loadHistory(id) {
  try {
    const plan = await api('/api/history/' + id);
    state.plan = plan;
    state.dayIndex = 0;
    const form = collectParams();
    // 「换一批」应沿用这份历史菜单的条件，而不是左侧表单的当前值
    state.lastParams = {
      ...form,
      people: plan.meta?.people || form.people,
      days: plan.days?.length || form.days,
      mealType: plan.meta?.mealType || form.mealType,
      meals: plan.meta?.meals || form.meals,
      tastes: plan.meta?.tastes || [],
    };
    state.checkedItems = new Set(readJSON(shopKeyOf(state.user?.username, plan), []));
    // 优先用服务端记录的「当时确认做了哪些」，没有再退回本地草稿
    // 优先用服务端记录的按天勾选；老记录只有菜名，就退回本地草稿
    state.cooked = new Set(plan.picks?.length ? plan.picks : readJSON(cookKeyOf(state.user?.username, plan), []));
    state.startDate = plan.startDate || '';
    state.done = new Set(readJSON(doneKeyOf(state.user?.username, plan), []));
    renderPlan();
    persistPlan();
    $('memoryModal').classList.add('hidden');
    toast('已回看这份菜单 🕐', 'ok');
  } catch (e) {
    toast(e.message, 'warn', 3200);
  }
}

async function deleteHistory(id) {
  try {
    memProfile = await api('/api/history/' + id, { method: 'DELETE' });
    renderHistoryList();
    toast('已删除该记录', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function clearHistory() {
  if (!confirm('确定清空全部生成记录吗？此操作不可恢复。')) return;
  try {
    memProfile = await api('/api/history', { method: 'DELETE' });
    renderHistoryList();
    toast('已清空生成记录', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function saveMemory(silent) {
  const splitList = (s) => String(s || '').split(/[、,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
  const patch = {
    nickname: $('memNickname').value.trim(),
    householdSize: parseInt($('memHousehold').value) || 2,
    tastePrefs: splitList($('memTastePrefs').value),
    dislikedTastes: splitList($('memDislikedTastes').value),
    allergies: splitList($('memAllergies').value),
    likedDishes: memProfile?.likedDishes || [],
    dislikedDishes: memProfile?.dislikedDishes || [],
    recentDishes: memProfile?.recentDishes || [],
  };
  try {
    memProfile = await api('/api/memory', { method: 'POST', body: JSON.stringify(patch) });
    if (!silent) {
      toast('记忆已保存 ✅', 'ok');
      $('memoryModal').classList.add('hidden');
    }
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}

async function changePassword() {
  const oldPassword = $('pwOld').value;
  const newPassword = $('pwNew').value;
  if (!oldPassword || !newPassword) return toast('请填写当前密码与新密码', 'warn');
  try {
    await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
    $('pwOld').value = '';
    $('pwNew').value = '';
    toast('密码已更新，请重新登录', 'ok', 3000);
    setTimeout(clearSession, 800);
  } catch (e) {
    toast(e.message, 'err', 3200);
  }
}

/* ==================== 做菜界面 ==================== */

/** 某一天里「已勾选要做」的菜，按餐次分组 */
function cookDayMeals(dayIndex) {
  const day = (state.plan?.days || [])[dayIndex];
  if (!day) return [];
  return (day.meals || [])
    .map((m) => ({ ...m, dishes: (m.dishes || []).filter((d) => state.cooked.has(pickKey(dayIndex, d.name))) }))
    .filter((m) => m.dishes.length);
}

function cookDayDishes(dayIndex) {
  return cookDayMeals(dayIndex).flatMap((m) => m.dishes);
}

/** 打开「第 1 天从哪天开始」的日期弹窗 */
function openStartDatePicker() {
  if (!state.cooked.size) return toast('先勾选这次要做的菜', 'warn');
  $('startDateInput').value = state.startDate || todayKey();
  updateStartDatePreview();
  $('startDateModal').classList.remove('hidden');
}

function updateStartDatePreview() {
  const start = $('startDateInput').value || todayKey();
  const total = state.plan?.days?.length || 1;
  const last = addDays(start, total - 1);
  $('startDatePreview').textContent = total > 1
    ? `第 1 天 ${formatDate(start)}　→　第 ${total} 天 ${formatDate(last)}`
    : `就这一天：${formatDate(start)}`;
}

async function confirmStartDate() {
  const start = $('startDateInput').value;
  if (!start) return toast('请选择开始日期', 'warn');
  const btn = $('startDateConfirm');
  btn.disabled = true;
  try {
    await api('/api/cook', {
      method: 'POST',
      body: JSON.stringify({
        dishes: pickedNames(),          // 进「最近做过」的是去重后的菜名
        picks: [...state.cooked],       // 按天的原始勾选，回看时精确还原
        historyId: state.plan?.historyId || '',
        startDate: start,
      }),
    });
    state.startDate = start;
    persistPlan();
    $('startDateModal').classList.add('hidden');
    toast(`已记住这 ${state.cooked.size} 道菜，开做吧 🍳`, 'ok', 3000);
    enterCookMode();
  } catch (e) {
    toast(e.message, 'err', 3200);
  } finally {
    btn.disabled = false;
  }
}

function enterCookMode() {
  if (!state.plan || !state.startDate) return;
  state.done = new Set(readJSON(doneKeyOf(state.user?.username, state.plan), []));
  // 默认落到今天；今天不在这期菜单范围内就落到第 1 天
  const total = state.plan.days.length;
  const offset = Math.round(
    (new Date(todayKey() + 'T00:00:00') - new Date(state.startDate + 'T00:00:00')) / 86400000
  );
  state.cookDay = offset >= 0 && offset < total ? offset : 0;
  document.body.classList.add('cooking');
  $('cookView').classList.remove('hidden');
  document.querySelector('.layout').classList.add('hidden');
  renderCookView();
  window.scrollTo(0, 0);
}

function exitCookMode() {
  document.body.classList.remove('cooking');
  $('cookView').classList.add('hidden');
  document.querySelector('.layout').classList.remove('hidden');
  syncCookEntry();
}

/** 顶栏「去做菜」入口：确认过菜单才出现 */
function syncCookEntry() {
  const ready = Boolean(state.plan && state.cooked.size && state.startDate);
  $('cookModeBtn').classList.toggle('hidden', !ready);
}

function renderCookView() {
  const total = state.plan?.days?.length || 0;
  const dateKey = addDays(state.startDate, state.cookDay);
  const rel = relativeDay(dateKey);

  $('cookDateText').textContent = formatDate(dateKey);
  $('cookDayText').textContent = `第 ${state.cookDay + 1} 天 / 共 ${total} 天${rel ? '　·　' + rel : ''}`;
  $('cookPrevDay').disabled = state.cookDay <= 0;
  $('cookNextDay').disabled = state.cookDay >= total - 1;
  $('cookTodayBtn').classList.toggle('hidden', rel === '今天');

  const box = $('cookDishes');
  box.innerHTML = '';
  const meals = cookDayMeals(state.cookDay);

  if (!meals.length) {
    const empty = document.createElement('p');
    empty.className = 'cook-empty muted';
    empty.textContent = '这一天你没有勾选要做的菜。回菜单勾几道，或者翻到别的日期。';
    box.appendChild(empty);
  }

  for (const meal of meals) {
    const sec = document.createElement('div');
    sec.className = 'cook-meal';
    const h = document.createElement('div');
    h.className = 'cook-meal-head';
    const tag = document.createElement('span');
    tag.className = 'meal-type-tag';
    tag.textContent = meal.type || '';
    h.appendChild(tag);
    if (meal.staple) {
      const st = document.createElement('span');
      st.className = 'cook-staple';
      st.textContent = `🍚 ${meal.staple}`;
      h.appendChild(st);
    }
    sec.appendChild(h);

    for (const dish of meal.dishes) sec.appendChild(cookDishRow(dish));
    box.appendChild(sec);
  }
  renderCookProgress();
  resetCookIngredients();
}

function cookDishRow(dish) {
  const key = pickKey(state.cookDay, dish.name);
  const row = document.createElement('div');
  row.className = 'cook-dish' + (state.done.has(key) ? ' done' : '');

  const check = document.createElement('label');
  check.className = 'cook-check';
  check.title = '标记这道菜已经做完';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = state.done.has(key);
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => {
    if (cb.checked) state.done.add(key);
    else state.done.delete(key);
    row.classList.toggle('done', cb.checked);
    writeJSON(doneKeyOf(state.user?.username, state.plan), [...state.done]);
    renderCookProgress();
  });
  check.appendChild(cb);

  const main = document.createElement('button');
  main.className = 'cook-dish-main';
  main.title = '点开看完整做法';
  const nm = document.createElement('b');
  nm.textContent = dish.name;
  const meta = document.createElement('small');
  meta.className = 'muted';
  meta.textContent = [dish.category, dish.brief].filter(Boolean).join(' · ');
  main.append(nm, meta);
  main.addEventListener('click', () => showDetail(dish.name));

  const arrow = document.createElement('span');
  arrow.className = 'cook-arrow';
  arrow.textContent = '›';

  row.append(check, main, arrow);
  return row;
}

function renderCookProgress() {
  const dishes = cookDayDishes(state.cookDay);
  const done = dishes.filter((d) => state.done.has(pickKey(state.cookDay, d.name))).length;
  const pct = dishes.length ? Math.round((done / dishes.length) * 100) : 0;
  $('cookProgressFill').style.width = pct + '%';
  $('cookProgressText').textContent = dishes.length
    ? `${done} / ${dishes.length} 道已完成${done === dishes.length ? '　🎉 收工！' : ''}`
    : '今天没有安排';
}

/* ---------- 今日食材汇总 ---------- */

function resetCookIngredients() {
  const n = cookDayDishes(state.cookDay).length;
  $('cookIngBtn').disabled = n === 0;
  $('cookIngBtn').textContent = '汇总今日食材';
  $('cookIngBody').className = 'muted';
  $('cookIngBody').textContent = n
    ? `把今天这 ${n} 道菜的食材合并列出，做之前一次备齐。`
    : '今天没有安排。';
}

/** 单位归一：中英文写法统一，方便同类相加 */
const UNIT_ALIAS = {
  g: 'g', 克: 'g', 公克: 'g', kg: 'kg', 千克: 'kg', 公斤: 'kg',
  ml: 'ml', ML: 'ml', 毫升: 'ml', l: 'L', 升: 'L',
  个: '个', 只: '只', 根: '根', 瓣: '瓣', 条: '条', 片: '片',
  棵: '棵', 头: '头', 把: '把', 张: '张', 块: '块', 小撮: '小撮',
  朵: '朵', 粒: '粒', 颗: '颗', 枚: '枚', 段: '段', 支: '支',
  盒: '盒', 包: '包', 袋: '袋', 罐: '罐', 串: '串', 扎: '扎',
  汤匙: '汤匙', 大匙: '汤匙', 茶匙: '茶匙', 小匙: '茶匙', 勺: '勺',
};

const CN_NUM = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 「1/2」「1又1/2」「0.5」「半」「两」都要能读成数字 */
function parseNumber(text) {
  const s = String(text).trim();
  if (CN_NUM[s] !== undefined) return CN_NUM[s];
  const mixed = s.match(/^(\d+)\s*[又+]\s*(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const num = parseFloat(s);
  return Number.isFinite(num) ? num : null;
}

/** 计量单位（可精确相加）优先于模糊的匙勺 */
const MEASURED = new Set(['g', 'kg', 'ml', 'L']);
const COUNTABLE = new Set([
  '个', '只', '根', '瓣', '条', '片', '棵', '头', '把', '张', '块',
  '朵', '粒', '颗', '枚', '段', '支', '盒', '包', '袋', '罐', '串', '扎',
]);

/**
 * 把模型写的用量解析成 { num, unit }。
 * 真实返回长这样：「2个（约100克蛋液）」「1汤匙（约15克）」「1/4茶匙（约1克，用于蛋液）」
 * 规则：论个买的按个数记；匙勺这种没法相加，就取括号里换算好的克/毫升。
 */
function parseAmount(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const head = raw.match(/^([\d.]+(?:\s*[又+]?\s*\d+\s*\/\s*\d+)?|\d+\s*\/\s*\d+|[半一两二三四五六七八九十])\s*([^\s（(，,]*)/);
  const headNum = head ? parseNumber(head[1]) : null;
  const headUnit = head ? UNIT_ALIAS[head[2]] : null;

  // 可数或已是标准计量单位 → 直接用
  if (headNum !== null && headUnit && (COUNTABLE.has(headUnit) || MEASURED.has(headUnit))) {
    return { num: headNum, unit: headUnit };
  }
  // 匙/勺/撮之类：找括号里的「约 N 克 / 毫升」
  const paren = raw.match(/[（(][^）)]*?约?\s*([\d.]+(?:\s*\/\s*\d+)?)\s*(克|g|毫升|ml|ML)/i);
  if (paren) {
    const n = parseNumber(paren[1]);
    if (n !== null) return { num: n, unit: UNIT_ALIAS[paren[2]] || UNIT_ALIAS[paren[2].toLowerCase()] };
  }
  // 括号外的匙勺量，同单位之间也能相加
  if (headNum !== null && headUnit) return { num: headNum, unit: headUnit };
  return null;
}

const roundNum = (n) => Math.round(n * 100) / 100;

/** kg/L 太大时不换算，只在 g/ml 超过 1000 时提升单位，读起来更像采购量 */
function formatQty(num, unit) {
  if (unit === 'g' && num >= 1000) return `${roundNum(num / 1000)} kg`;
  if (unit === 'ml' && num >= 1000) return `${roundNum(num / 1000)} L`;
  return `${roundNum(num)} ${unit}`;
}

/**
 * 合并同一食材在多道菜里的用量。
 * 能解析的按单位分组相加；实在解析不了的（「适量」「少许」）去重后附在后面。
 */
function mergeAmounts(list) {
  const sums = new Map();
  const plain = [];
  for (const item of list) {
    const text = String(item || '').trim();
    if (!text) continue;
    const parsed = parseAmount(text);
    if (parsed) sums.set(parsed.unit, (sums.get(parsed.unit) || 0) + parsed.num);
    else plain.push(text);
  }

  const parts = [...sums.entries()].map(([unit, num]) => formatQty(num, unit));
  const extras = [...new Set(plain)];
  if (!parts.length && !extras.length) return '';
  if (!parts.length) return extras.slice(0, 2).join('、');
  // 数量已经算清楚了，「适量」这类补充最多带一条，避免把格子撑爆
  return parts.join(' + ') + (extras.length ? `（另${extras[0]}）` : '');
}

async function summarizeIngredients() {
  const dishes = cookDayDishes(state.cookDay);
  if (!dishes.length) return;
  const btn = $('cookIngBtn');
  const body = $('cookIngBody');
  btn.disabled = true;

  const bucket = new Map(); // 食材名 -> { amounts: [], kind }
  let failed = 0;
  for (let i = 0; i < dishes.length; i++) {
    btn.textContent = `汇总中 ${i + 1}/${dishes.length}…`;
    try {
      const detail = await fetchDetail(dishes[i].name);
      for (const [kind, items] of [['主料', detail.ingredients], ['调料', detail.seasoning]]) {
        for (const it of items || []) {
          if (!it.name) continue;
          const cur = bucket.get(it.name) || { amounts: [], kind };
          cur.amounts.push(it.amount);
          bucket.set(it.name, cur);
        }
      }
    } catch {
      failed += 1;
    }
  }

  body.className = '';
  body.innerHTML = '';
  if (!bucket.size) {
    body.className = 'muted';
    body.textContent = '没能取到食材信息，稍后再试。';
    resetCookIngredients();
    return;
  }

  for (const kind of ['主料', '调料']) {
    const items = [...bucket.entries()].filter(([, v]) => v.kind === kind);
    if (!items.length) continue;
    const h = document.createElement('h4');
    h.textContent = kind;
    const grid = document.createElement('div');
    grid.className = 'ing-grid';
    for (const [name, v] of items) {
      const cell = document.createElement('div');
      cell.className = 'ing-cell';
      const nm = document.createElement('span');
      nm.className = 'ing-n';
      nm.textContent = name;
      const amt = document.createElement('b');
      amt.className = 'ing-a';
      amt.textContent = mergeAmounts(v.amounts);
      // 原始写法留在 title 里，想核对时能看到每道菜各用多少
      cell.title = `${name}：${v.amounts.filter(Boolean).join(' / ')}`;
      cell.append(nm, amt);
      grid.appendChild(cell);
    }
    body.append(h, grid);
  }
  if (failed) {
    const warn = document.createElement('p');
    warn.className = 'muted';
    warn.textContent = `有 ${failed} 道菜没取到食材，已跳过。`;
    body.appendChild(warn);
  }
  btn.textContent = '重新汇总';
  btn.disabled = false;
}

/* ==================== 按食材找菜 ==================== */

const QUICK_INGREDIENTS = [
  '鸡蛋', '猪肉', '牛肉', '鸡肉', '虾', '鱼',
  '白菜', '青菜', '土豆', '番茄', '茄子', '青椒',
  '黄瓜', '洋葱', '豆腐', '香菇', '胡萝卜', '西兰花',
];

const ING_KEY = () => `ai_recipe_ing_${state.user?.username || 'anon'}`;

function initPantry() {
  // 常见食材快捷点选
  const quick = $('ingQuick');
  for (const name of QUICK_INGREDIENTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = name;
    b.addEventListener('click', () => addIngredient(name));
    quick.appendChild(b);
  }

  $('ingAddBtn').addEventListener('click', () => addIngredient($('ingInput').value));
  $('ingInput').addEventListener('keydown', (e) => {
    // 回车、逗号、顿号都算一次添加，符合中文输入习惯
    if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === '、') {
      e.preventDefault();
      addIngredient($('ingInput').value);
    }
  });

  const clamp = () => {
    const el = $('pantryPeople');
    el.value = Math.min(Math.max(parseInt(el.value) || 1, 1), 30);
  };
  $('pantryPeopleMinus').addEventListener('click', () => { $('pantryPeople').stepDown(); clamp(); });
  $('pantryPeoplePlus').addEventListener('click', () => { $('pantryPeople').stepUp(); clamp(); });
  $('pantryPeople').addEventListener('change', clamp);

  $('findBtn').addEventListener('click', findByIngredients);
  $('planFromPantryBtn').addEventListener('click', planFromPantry);

  const pd = $('pantryDays');
  const syncPantryDays = () => {
    $('pantryDaysLabel').textContent = pd.value;
    $('planDaysEcho').textContent = pd.value;
    pd.style.setProperty('--fill', ((pd.value - pd.min) / (pd.max - pd.min)) * 100 + '%');
  };
  pd.addEventListener('input', syncPantryDays);
  syncPantryDays();

  document.querySelectorAll('#pantrySlots .slot-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const on = btn.classList.contains('on');
      // 至少留一餐，否则排出来是空的
      if (on && pantryMeals().length === 1) return toast('至少要选一餐', 'warn');
      btn.classList.toggle('on', !on);
      btn.setAttribute('aria-pressed', String(!on));
    });
  });

  document.querySelectorAll('.mode-tab').forEach((t) => {
    t.addEventListener('click', () => switchMode(t.dataset.mode));
  });
}

function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('planForm').classList.toggle('hidden', mode !== 'plan');
  $('pantryForm').classList.toggle('hidden', mode !== 'pantry');

  // 两种模式的结果互斥显示，各自保留上次的内容
  const hasPlan = Boolean(state.plan);
  const hasPantry = Boolean(state.pantry);
  $('resultWrap').classList.toggle('hidden', mode !== 'plan' || !hasPlan);
  $('pantryWrap').classList.toggle('hidden', mode !== 'pantry' || !hasPantry);
  $('emptyState').classList.toggle('hidden', mode === 'plan' ? hasPlan : hasPantry);
  $('emptyState').querySelector('p').innerHTML = mode === 'pantry'
    ? '把冰箱里有的食材加进去，<br/>看看今天能做出什么菜'
    : '设置好人数、口味与类型，<br/>点击「开始生成」让 AI 大厨为你配一桌好菜';
  writeJSON(PREFS_KEY, { ...readJSON(PREFS_KEY, {}), mode });
}

function addIngredient(raw) {
  // 一次粘一串也能拆开
  const parts = String(raw || '').split(/[、,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return;
  let added = 0;
  for (const p of parts) {
    const name = p.slice(0, 20);
    if (state.ingredients.includes(name)) continue;
    if (state.ingredients.length >= 30) return toast('最多 30 样，够用了', 'warn');
    state.ingredients.push(name);
    added += 1;
  }
  $('ingInput').value = '';
  if (added) {
    writeJSON(ING_KEY(), state.ingredients);
    renderIngredients();
  }
}

function removeIngredient(name) {
  state.ingredients = state.ingredients.filter((x) => x !== name);
  writeJSON(ING_KEY(), state.ingredients);
  renderIngredients();
}

function renderIngredients() {
  const box = $('ingTags');
  box.innerHTML = '';
  if (!state.ingredients.length) {
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = '还没加食材';
    box.appendChild(hint);
  }
  for (const name of state.ingredients) {
    const tag = document.createElement('span');
    tag.className = 'ing-tag';
    const tv = document.createElement('span');
    tv.textContent = name;
    const x = document.createElement('button');
    x.className = 'tag-x';
    x.title = '移除';
    x.textContent = '×';
    x.addEventListener('click', () => removeIngredient(name));
    tag.append(tv, x);
    box.appendChild(tag);
  }
  // 快捷标签跟着高亮，避免重复点
  document.querySelectorAll('#ingQuick .chip').forEach((c) => {
    c.classList.toggle('on', state.ingredients.includes(c.textContent));
  });
  $('findBtn').disabled = state.ingredients.length === 0;
}

/** 按早→中→晚的固定顺序返回勾选的餐次 */
function pantryMeals() {
  return [...document.querySelectorAll('#pantrySlots .slot-btn.on')].map((b) => b.dataset.slot);
}

/**
 * 用现有食材排 N 天菜单。
 * 走的是 /recipes/generate（多传 ingredients），所以输出结构和「配菜单」完全一致，
 * 渲染、选菜、去做菜整条链路都能直接复用。
 */
async function planFromPantry() {
  if (state.loading) return;
  if (!state.ingredients.length) return toast('先加几样食材', 'warn');

  const days = parseInt($('pantryDays').value) || 1;
  setLoading(true, `正在用你的食材排 ${days} 天…`);
  try {
    const plan = await api('/api/recipes/generate', {
      method: 'POST',
      body: JSON.stringify({
        ingredients: state.ingredients,
        people: parseInt($('pantryPeople').value) || 2,
        days,
        meals: pantryMeals(),
        mealType: document.querySelector('.type-card.active')?.dataset.type || 'family',
        tastes: [...document.querySelectorAll('#tasteChips .chip.on')].map((c) => c.textContent),
        extra: $('pantryExtra').value.trim(),
        useMemory: $('useMemory').checked,
        provider: $('providerSelect').value,
        model: $('modelSelect').value,
        thinking: $('deepThinking').checked,
      }),
    });
    state.plan = plan;
    state.dayIndex = 0;
    state.cooked = new Set();
    state.startDate = '';
    state.done.clear();
    writeJSON(cookKeyOf(state.user?.username, plan), []);
    // 排出来的是标准菜单，切回配菜单视图复用整套渲染
    switchMode('plan');
    renderPlan();
    persistPlan();
    const left = plan.unusedFromPantry?.length;
    toast(left ? `排好了，还剩 ${left} 样没用上：${plan.unusedFromPantry.join('、')}` : '排好了，食材全都用上了 🎉',
      'ok', 3600);
  } catch (e) {
    toast('排不出来：' + e.message, 'err', 4000);
  } finally {
    setLoading(false);
  }
}

async function findByIngredients() {
  if (state.loading) return;
  if (!state.ingredients.length) return toast('先加几样食材', 'warn');

  setLoading(true, '正在翻你的冰箱…');
  try {
    const result = await api('/api/recipes/by-ingredients', {
      method: 'POST',
      body: JSON.stringify({
        ingredients: state.ingredients,
        people: parseInt($('pantryPeople').value) || 2,
        strict: $('strictMode').checked,
        extra: $('pantryExtra').value.trim(),
        tastes: [...document.querySelectorAll('#tasteChips .chip.on')].map((c) => c.textContent),
        useMemory: $('useMemory').checked,
        provider: $('providerSelect').value,
        model: $('modelSelect').value,
        thinking: $('deepThinking').checked,
      }),
    });
    state.pantry = result;
    renderPantry();
    toast(result.mock
      ? '已用演示数据匹配（配置 Key 后由大模型推荐）'
      : `找到 ${result.dishes.length} 道能做的菜`, 'ok');
  } catch (e) {
    toast('没找出来：' + e.message, 'err', 4000);
  } finally {
    setLoading(false);
  }
}

function renderPantry() {
  const r = state.pantry;
  if (!r) return;
  $('emptyState').classList.add('hidden');
  $('resultWrap').classList.add('hidden');
  $('pantryWrap').classList.remove('hidden');

  $('pantryTitle').textContent = r.title;
  $('pantrySummary').textContent = r.summary || '';

  const meta = $('pantryMeta');
  meta.innerHTML = '';
  const ready = r.dishes.filter((d) => d.ready).length;
  [
    `🥬 ${r.meta.ingredients.length} 样食材`,
    `🍽 ${r.dishes.length} 道可做`,
    ready ? `✅ ${ready} 道不用再买` : '',
    r.meta.strict ? '🔒 只用现有' : '',
    r.mock ? '🧪 演示数据' : '',
  ].filter(Boolean).forEach((t) => {
    const s = document.createElement('span');
    s.className = 'meta-chip';
    s.textContent = t;
    meta.appendChild(s);
  });

  // 没用上的食材单独提醒，这是用户最关心的「剩下的怎么办」
  const unused = $('pantryUnused');
  unused.classList.toggle('hidden', !r.unused.length);
  unused.textContent = r.unused.length ? `这几样没派上用场：${r.unused.join('、')}` : '';

  const tips = $('pantryTips');
  tips.innerHTML = '';
  tips.classList.toggle('hidden', !r.tips.length);
  if (r.tips.length) {
    const ul = document.createElement('ul');
    for (const t of r.tips) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    tips.appendChild(ul);
  }

  const list = $('pantryList');
  list.innerHTML = '';
  for (const d of r.dishes) list.appendChild(pantryCard(d));
}

function pantryCard(d) {
  const el = document.createElement('div');
  el.className = 'pantry-card' + (d.ready ? ' ready' : '');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `查看${d.name}的做法`);

  const head = document.createElement('div');
  head.className = 'pantry-head';
  const cat = document.createElement('span');
  cat.className = `dish-cat cat-${CAT_CLASS[d.category] || 'other'}`;
  cat.textContent = d.category;
  const badge = document.createElement('span');
  badge.className = 'ready-badge ' + (d.ready ? 'yes' : 'no');
  badge.textContent = d.ready ? '✅ 现在就能做' : `还差 ${d.missing.length} 样`;
  head.append(cat, badge);

  const name = document.createElement('div');
  name.className = 'pantry-name';
  name.textContent = d.name;

  const brief = document.createElement('div');
  brief.className = 'dish-brief';
  brief.textContent = d.brief || '';

  el.append(head, name, brief);

  if (d.uses.length) {
    const uses = document.createElement('div');
    uses.className = 'use-row';
    const lab = document.createElement('span');
    lab.className = 'use-label';
    lab.textContent = '用你的';
    uses.appendChild(lab);
    for (const u of d.uses) {
      const t = document.createElement('span');
      t.className = 'use-tag have';
      t.textContent = u;
      uses.appendChild(t);
    }
    el.appendChild(uses);
  }

  if (d.missing.length) {
    const miss = document.createElement('div');
    miss.className = 'use-row';
    const lab = document.createElement('span');
    lab.className = 'use-label';
    lab.textContent = '还需买';
    miss.appendChild(lab);
    for (const m of d.missing) {
      const t = document.createElement('span');
      t.className = 'use-tag need';
      t.textContent = m;
      miss.appendChild(t);
    }
    el.appendChild(miss);
  }

  const foot = document.createElement('div');
  foot.className = 'pantry-foot';
  [d.difficulty, d.time].filter(Boolean).forEach((x) => {
    const s = document.createElement('span');
    s.className = 'meta-pill';
    s.textContent = x;
    foot.appendChild(s);
  });
  const go = document.createElement('span');
  go.className = 'pantry-go';
  go.textContent = '看做法 ›';
  foot.appendChild(go);
  el.appendChild(foot);

  const open = () => showDetail(d.name);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return el;
}

/* ---------- 启动 ---------- */

boot();
