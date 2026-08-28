const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 默认落在 src/data/db.json；设置 AI_RECIPE_DB 可指向别处（测试、多实例隔离）
const DB_FILE = process.env.AI_RECIPE_DB
  ? path.resolve(process.env.AI_RECIPE_DB)
  : path.join(__dirname, '..', 'data', 'db.json');
const DATA_DIR = path.dirname(DB_FILE);

/** 会话有效期：30 天 */
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** 历史记录最多保留条数 */
const HISTORY_LIMIT = 50;
/** 仅为最近 N 条历史保留完整菜单快照（避免 db.json 无限膨胀） */
const HISTORY_SNAPSHOT_LIMIT = 20;
/** 「最近做过」最多记忆的菜品数 */
const RECENT_LIMIT = 60;
/** 点赞 / 点踩 最多记忆的菜品数 */
const FEEDBACK_LIMIT = 30;

const PROVIDER_KEYS = ['deepseek', 'qwen'];

function emptyProfile() {
  return {
    nickname: '',
    householdSize: 2,
    tastePrefs: [],
    dislikedTastes: [],
    allergies: [],
    likedDishes: [],
    dislikedDishes: [],
    recentDishes: [],
    history: [],
    updatedAt: null,
  };
}

const DEFAULT_DB = { users: {}, sessions: {} };

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2), 'utf-8');
}

/** 补齐历史版本遗留数据缺失的字段，保证后续代码可以放心访问 */
function normalizeProfile(profile) {
  const p = Object.assign(emptyProfile(), profile || {});
  for (const k of ['tastePrefs', 'dislikedTastes', 'allergies', 'likedDishes', 'dislikedDishes', 'recentDishes']) {
    p[k] = Array.isArray(p[k]) ? p[k].filter(Boolean).map(String) : [];
  }
  p.history = Array.isArray(p.history) ? p.history : [];
  p.householdSize = Math.min(Math.max(parseInt(p.householdSize) || 2, 1), 30);
  p.nickname = String(p.nickname || '');
  return p;
}

function normalizeUser(user) {
  user.keys = user.keys && typeof user.keys === 'object' ? user.keys : {};
  for (const k of PROVIDER_KEYS) if (typeof user.keys[k] !== 'string') user.keys[k] = '';
  user.profile = normalizeProfile(user.profile);
  user.displayName = String(user.displayName || user.username || '');
  user.openid = typeof user.openid === 'string' ? user.openid : '';
  return user;
}

function load() {
  ensure();
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    db = null;
  }
  if (!db || typeof db !== 'object') db = JSON.parse(JSON.stringify(DEFAULT_DB));
  if (!db.users || typeof db.users !== 'object') db.users = {};
  if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
  delete db.profiles; // 早期版本的遗留字段
  for (const name of Object.keys(db.users)) normalizeUser(db.users[name]);
  return db;
}

function save(db) {
  ensure();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
  fs.renameSync(tmp, DB_FILE);
}

/** 读取 → 修改 → 落盘 的统一封装，避免各处重复 load/save */
function mutate(fn) {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

/* ===== 密码与账号 ===== */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

/** 定长比较，避免通过响应时间侧信道推测密码哈希 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf-8');
  const bufB = Buffer.from(String(b), 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const USERNAME_RE = /^[a-z0-9_一-龥]{2,24}$/;

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function assertPassword(password) {
  const pw = String(password || '');
  if (pw.length < 4) throw new Error('密码至少 4 位');
  if (pw.length > 128) throw new Error('密码过长（最多 128 位）');
  return pw;
}

function createUser({ username, password }) {
  return mutate((db) => {
    const name = normalizeUsername(username);
    if (!USERNAME_RE.test(name)) throw new Error('用户名需为 2-24 位中文/字母/数字/下划线');
    const pw = assertPassword(password);
    if (db.users[name]) throw new Error('该用户名已被注册');

    const { salt, hash } = hashPassword(pw);
    db.users[name] = normalizeUser({
      username: name,
      displayName: String(username).trim(),
      passwordHash: hash,
      passwordSalt: salt,
      keys: {},
      profile: emptyProfile(),
      createdAt: new Date().toISOString(),
    });
    return publicUser(db.users[name]);
  });
}

function getUser(name) {
  const db = load();
  return db.users[normalizeUsername(name)] || null;
}

/* ===== 微信小程序用户 ===== */

/**
 * openid 里可能有大写字母和 - _，不能直接当用户名（用户名规则不允许），
 * 所以取哈希前 12 位生成一个稳定、合法且不可反推出 openid 的内部用户名。
 */
function wxUsernameOf(openid) {
  return 'wx_' + crypto.createHash('sha256').update(String(openid)).digest('hex').slice(0, 12);
}

function findByOpenid(openid) {
  if (!openid) return null;
  const db = load();
  return Object.values(db.users).find((u) => u.openid === openid) || null;
}

/**
 * 微信登录：openid 对应的用户不存在就建一个（无密码，只能靠 openid 登录）。
 * 返回 publicUser，与账号密码登录的返回结构一致，前端不用区分。
 */
function upsertWxUser(openid, { nickname } = {}) {
  if (!openid) throw new Error('缺少 openid');
  return mutate((db) => {
    let user = Object.values(db.users).find((u) => u.openid === openid);
    if (!user) {
      const name = wxUsernameOf(openid);
      user = normalizeUser({
        username: name,
        displayName: String(nickname || '微信用户').slice(0, 24),
        // 无密码：verifyUser 会因为没有 passwordSalt 直接返回 null，不存在被口令登录的可能
        passwordHash: '',
        passwordSalt: '',
        openid,
        keys: {},
        profile: emptyProfile(),
        createdAt: new Date().toISOString(),
      });
      db.users[name] = user;
    } else if (nickname && user.displayName === '微信用户') {
      user.displayName = String(nickname).slice(0, 24);
    }
    return publicUser(user);
  });
}

function verifyUser(name, password) {
  const user = getUser(name);
  if (!user || !user.passwordSalt) return null;
  const { hash } = hashPassword(password, user.passwordSalt);
  if (!safeEqual(hash, user.passwordHash)) return null;
  return publicUser(user);
}

function changePassword(name, oldPassword, newPassword) {
  const current = getUser(name);
  if (!current) throw new Error('用户不存在');
  const { hash } = hashPassword(oldPassword, current.passwordSalt);
  if (!safeEqual(hash, current.passwordHash)) throw new Error('原密码不正确');
  const pw = assertPassword(newPassword);
  return mutate((db) => {
    const user = db.users[normalizeUsername(name)];
    const next = hashPassword(pw);
    user.passwordHash = next.hash;
    user.passwordSalt = next.salt;
    // 改密后使所有旧会话失效
    for (const [t, s] of Object.entries(db.sessions)) {
      if (s.username === user.username) delete db.sessions[t];
    }
    return true;
  });
}

function maskKey(v) {
  if (!v) return '';
  return v.length > 10 ? `${v.slice(0, 4)}****${v.slice(-4)}` : '****';
}

/**
 * 对外的画像：历史里的完整菜单快照体积很大，列表接口只回摘要 + hasPlan 标记，
 * 需要完整菜单时再单独请求 /api/history/:id。
 */
function publicProfile(profile) {
  return {
    ...profile,
    history: (profile?.history || []).map(({ plan, ...rest }) => ({ ...rest, hasPlan: Boolean(plan) })),
  };
}

/** 对外安全的用户信息（不含密码哈希与明文 Key） */
function publicUser(user) {
  const keys = user.keys || {};
  return {
    username: user.username,
    displayName: user.displayName,
    hasKeys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, Boolean(v)])),
    maskedKeys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, maskKey(v)])),
    profile: publicProfile(user.profile),
    createdAt: user.createdAt,
  };
}

/* ===== 会话 ===== */
function isExpired(session) {
  const t = new Date(session?.createdAt || 0).getTime();
  return !t || Date.now() - t > SESSION_TTL_MS;
}

function createSession(username) {
  return mutate((db) => {
    const token = crypto.randomBytes(24).toString('hex');
    for (const [t, s] of Object.entries(db.sessions)) {
      if (isExpired(s) || !db.users[s.username]) delete db.sessions[t];
    }
    db.sessions[token] = { username, createdAt: new Date().toISOString() };
    return token;
  });
}

function getSession(token) {
  if (!token) return null;
  const db = load();
  const session = db.sessions[token];
  if (!session) return null;
  if (isExpired(session)) {
    delete db.sessions[token];
    save(db);
    return null;
  }
  const user = db.users[session.username];
  if (!user) return null;
  return { token, username: user.username, user };
}

function deleteSession(token) {
  if (!token) return;
  const db = load();
  if (db.sessions[token]) {
    delete db.sessions[token];
    save(db);
  }
}

/* ===== 每用户 API Key ===== */
function setKey(name, provider, key) {
  return mutate((db) => {
    const user = db.users[normalizeUsername(name)];
    if (!user) throw new Error('用户不存在');
    if (!PROVIDER_KEYS.includes(provider)) throw new Error(`不支持的模型服务商: ${provider}`);
    user.keys[provider] = String(key || '').trim();
    return publicUser(user);
  });
}

function getRawKey(name, provider) {
  const user = getUser(name);
  return user?.keys?.[provider] || '';
}

/* ===== 个人画像（记忆） ===== */
function getProfile(name) {
  const user = getUser(name);
  return user ? user.profile : emptyProfile();
}

const LIST_FIELDS = ['tastePrefs', 'dislikedTastes', 'allergies', 'likedDishes', 'dislikedDishes', 'recentDishes'];

function updateProfile(patch, name) {
  return mutate((db) => {
    const user = db.users[normalizeUsername(name)];
    if (!user) throw new Error('用户不存在');
    const p = user.profile;
    if (patch.nickname !== undefined) p.nickname = String(patch.nickname).slice(0, 24);
    if (patch.displayName !== undefined) user.displayName = String(patch.displayName).slice(0, 24) || user.username;
    if (patch.householdSize !== undefined) {
      p.householdSize = Math.min(Math.max(parseInt(patch.householdSize) || 2, 1), 30);
    }
    for (const k of LIST_FIELDS) {
      if (Array.isArray(patch[k])) {
        p[k] = [...new Set(patch[k].filter(Boolean).map((x) => String(x).slice(0, 40)))].slice(0, 60);
      }
    }
    p.updatedAt = new Date().toISOString();
    return p;
  });
}

function addHistory(entry, name) {
  return mutate((db) => {
    const user = db.users[normalizeUsername(name)];
    if (!user) throw new Error('用户不存在');
    const p = user.profile;
    const id = `h_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    p.history.unshift({
      id,
      date: new Date().toISOString(),
      title: entry.title || '未命名菜谱',
      people: entry.people,
      days: entry.days,
      mealType: entry.mealType || '',
      mealTypeKey: entry.mealTypeKey || '',
      tastes: entry.tastes || [],
      dishes: entry.dishes || [],
      cooked: [],
      plan: entry.plan || null,
    });
    p.history = p.history.slice(0, HISTORY_LIMIT);
    // 只为最近若干条保留完整菜单快照，更早的退化为摘要
    p.history.forEach((h, i) => { if (i >= HISTORY_SNAPSHOT_LIMIT) h.plan = null; });

    // 注意：这里刻意不写 recentDishes。
    // 「生成过」不等于「做过」—— 用户在结果里勾选了哪几道，才由 markCooked 写进记忆，
    // 否则一份七天菜单会把几十道没做过的菜标成「最近做过」，反而把后续推荐全避开了。
    p.householdSize = entry.people || p.householdSize;
    p.updatedAt = new Date().toISOString();
    return { id, profile: p };
  });
}

/** 只接受 YYYY-MM-DD，挡掉带时分秒或格式不对的输入 */
function isDateOnly(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

/**
 * 记录用户「这次真正做了哪些菜」。
 * dishes 会置顶写入 recentDishes（后续生成据此避免重复）；
 * 传了 historyId 就把选择覆盖回那条历史，回看时能还原勾选状态。
 */
function markCooked({ dishes, picks, historyId, startDate }, name) {
  return mutate((db) => {
    const user = db.users[normalizeUsername(name)];
    if (!user) throw new Error('用户不存在');
    const p = user.profile;
    const picked = [...new Set((Array.isArray(dishes) ? dishes : [])
      .filter(Boolean).map((x) => String(x).slice(0, 40)))].slice(0, 60);

    if (historyId) {
      const entry = p.history.find((h) => h.id === historyId);
      if (entry) {
        entry.cooked = picked;
        // picks 是「第几天::菜名」，回看时能精确还原是哪天勾的
        if (Array.isArray(picks)) {
          entry.picks = [...new Set(picks.filter(Boolean).map((x) => String(x).slice(0, 60)))].slice(0, 200);
        }
        // 「第 1 天」锚定到哪一天，做菜界面据此把相对天数换算成真实日期
        if (isDateOnly(startDate)) entry.startDate = startDate;
      }
    }
    // recentDishes 只增不减：做过就是做过，要撤销请在记忆面板里单独移除
    const seen = new Set(p.recentDishes);
    for (const dish of picked) {
      if (!seen.has(dish)) {
        p.recentDishes.unshift(dish);
        seen.add(dish);
      }
    }
    p.recentDishes = p.recentDishes.slice(0, RECENT_LIMIT);
    p.updatedAt = new Date().toISOString();
    return p;
  });
}

function getHistoryEntry(id, name) {
  return (getProfile(name).history || []).find((h) => h.id === id) || null;
}

function deleteHistory(id, name) {
  return mutate((db) => {
    const user = db.users[normalizeUsername(name)];
    if (!user) throw new Error('用户不存在');
    const p = user.profile;
    const before = p.history.length;
    p.history = p.history.filter((h) => h.id !== id);
    if (p.history.length === before) throw new Error('记录不存在');
    p.updatedAt = new Date().toISOString();
    return p;
  });
}

function clearHistory(name) {
  return mutate((db) => {
    const user = db.users[normalizeUsername(name)];
    if (!user) throw new Error('用户不存在');
    user.profile.history = [];
    user.profile.updatedAt = new Date().toISOString();
    return user.profile;
  });
}

function feedback({ dish, action }, name) {
  return mutate((db) => {
    const user = db.users[normalizeUsername(name)];
    if (!user) throw new Error('用户不存在');
    const p = user.profile;
    const move = (fromArr, toArr) => {
      p[fromArr] = p[fromArr].filter((d) => d !== dish);
      p[toArr] = [dish, ...p[toArr].filter((d) => d !== dish)].slice(0, FEEDBACK_LIMIT);
    };
    if (action === 'like') move('dislikedDishes', 'likedDishes');
    else if (action === 'dislike') move('likedDishes', 'dislikedDishes');
    else if (action === 'unlike' || action === 'undislike') {
      p.likedDishes = p.likedDishes.filter((d) => d !== dish);
      p.dislikedDishes = p.dislikedDishes.filter((d) => d !== dish);
    } else {
      throw new Error(`未知的反馈类型: ${action}`);
    }
    p.updatedAt = new Date().toISOString();
    return p;
  });
}

module.exports = {
  DB_FILE, PROVIDER_KEYS, SESSION_TTL_MS,
  load, save,
  emptyProfile, normalizeProfile,
  createUser, getUser, verifyUser, publicUser, publicProfile, changePassword,
  findByOpenid, upsertWxUser, wxUsernameOf,
  createSession, getSession, deleteSession,
  setKey, getRawKey, maskKey, isDateOnly,
  getProfile, updateProfile,
  addHistory, markCooked, getHistoryEntry, deleteHistory, clearHistory,
  feedback,
};
