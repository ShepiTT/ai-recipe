/* ---------- 日期（只到天，不含时分） ---------- */

/** 本地时区的 YYYY-MM-DD。不要用 toISOString，那是 UTC，会差一天 */
function toDateKey(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const todayKey = () => toDateKey(new Date());

function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return toDateKey(dt);
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function formatDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${y}年${m}月${d}日 ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`;
}

function diffDays(a, b) {
  const t = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  return Math.round((t(a) - t(b)) / 86400000);
}

/** 今天 / 明天 / 昨天，不在范围内返回空串 */
function relativeDay(dateKey) {
  return { '-1': '昨天', 0: '今天', 1: '明天', 2: '后天' }[diffDays(dateKey, todayKey())] || '';
}

/* ---------- 选菜键 ---------- */

/** 同一道菜可能出现在多天，勾选必须按天归属，否则勾第 1 天会让第 3 天也亮 */
const pickKey = (day, name) => `${day}::${name}`;
const pickedNames = (picks) => [...new Set(picks.map((k) => k.slice(k.indexOf('::') + 2)))];

/* ---------- 提示 ---------- */

const toast = (title, icon = 'none') => wx.showToast({ title, icon, duration: 2200 });

function confirm(content, title = '确认') {
  return new Promise((resolve) => {
    wx.showModal({ title, content, success: (r) => resolve(r.confirm), fail: () => resolve(false) });
  });
}

module.exports = {
  toDateKey, todayKey, addDays, formatDate, diffDays, relativeDay,
  pickKey, pickedNames,
  toast, confirm,
};
