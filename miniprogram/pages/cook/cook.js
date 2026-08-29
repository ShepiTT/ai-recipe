const app = getApp();
const api = require('../../utils/api');
const { STORAGE } = require('../../utils/config');
const { pickKey, todayKey, addDays, formatDate, diffDays, relativeDay, toast } = require('../../utils/util');

Page({
  data: {
    // 「我就想做某道菜」：不走菜单，直接输菜名看做法
    dishName: '',
    recentDishes: [],

    ready: false,       // 有菜单且已确认过开始日期
    total: 0,
    cookDay: 0,
    dateText: '',
    dayText: '',
    isToday: false,
    canPrev: false,
    canNext: false,

    meals: [],          // 当天已勾选的菜，按餐次分组
    done: [],
    doneCount: 0,
    dishCount: 0,
    percent: 0,

    ingLoading: false,
    ingLoaded: false,
    ingGroups: [],
    ingHint: '',
  },

  onShow() {
    this.setData({ recentDishes: wx.getStorageSync(STORAGE.RECENT_DISH) || [] });
    const { plan, picks, startDate } = app.globalData;
    if (!plan || !picks.length || !startDate) {
      return this.setData({ ready: false });
    }
    const total = (plan.days || []).length;
    // 默认落到今天；今天不在这期菜单范围内就落到第 1 天
    const offset = diffDays(todayKey(), startDate);
    this.setData({
      ready: true,
      total,
      cookDay: offset >= 0 && offset < total ? offset : 0,
      done: wx.getStorageSync(STORAGE.DONE) || [],
    }, () => this.render());
  },

  render() {
    const { plan, picks, startDate } = app.globalData;
    const { cookDay, done, total } = this.data;
    const dateKey = addDays(startDate, cookDay);
    const rel = relativeDay(dateKey);

    const day = (plan.days || [])[cookDay];
    const meals = (day ? day.meals || [] : [])
      .map((m) => ({
        ...m,
        dishes: (m.dishes || [])
          .filter((d) => picks.includes(pickKey(cookDay, d.name)))
          .map((d) => ({ ...d, done: done.includes(pickKey(cookDay, d.name)) })),
      }))
      .filter((m) => m.dishes.length);

    const all = meals.flatMap((m) => m.dishes);
    const doneCount = all.filter((d) => d.done).length;

    this.setData({
      meals,
      dateText: formatDate(dateKey),
      dayText: `第 ${cookDay + 1} 天 / 共 ${total} 天${rel ? '　·　' + rel : ''}`,
      isToday: rel === '今天',
      canPrev: cookDay > 0,
      canNext: cookDay < total - 1,
      dishCount: all.length,
      doneCount,
      percent: all.length ? Math.round((doneCount / all.length) * 100) : 0,
      // 换了一天就要重新汇总，之前那天的食材不作数
      ingLoaded: false,
      ingGroups: [],
      ingHint: all.length ? `把今天这 ${all.length} 道菜的食材合并列出，做之前一次备齐。` : '今天没有安排。',
    });
  },

  prevDay() {
    if (!this.data.canPrev) return;
    this.setData({ cookDay: this.data.cookDay - 1 }, () => this.render());
  },

  nextDay() {
    if (!this.data.canNext) return;
    this.setData({ cookDay: this.data.cookDay + 1 }, () => this.render());
  },

  backToToday() {
    const offset = diffDays(todayKey(), app.globalData.startDate);
    if (offset < 0 || offset >= this.data.total) return toast('今天不在这份菜单的日期范围内');
    this.setData({ cookDay: offset }, () => this.render());
  },

  toggleDone(e) {
    const name = e.currentTarget.dataset.name;
    const key = pickKey(this.data.cookDay, name);
    const done = this.data.done.includes(key)
      ? this.data.done.filter((k) => k !== key)
      : [...this.data.done, key];
    wx.setStorageSync(STORAGE.DONE, done);
    this.setData({ done }, () => this.render());
  },

  openDish(e) {
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({ url: `/pages/dish/dish?name=${encodeURIComponent(name)}` });
  },

  /* ---------- 直接做某道菜 ---------- */

  onDishName(e) { this.setData({ dishName: e.detail.value }); },

  /** 查过的菜名记在本地，下次点一下就能再看 */
  rememberDish(name) {
    const list = [name, ...(wx.getStorageSync(STORAGE.RECENT_DISH) || []).filter((x) => x !== name)].slice(0, 12);
    wx.setStorageSync(STORAGE.RECENT_DISH, list);
    this.setData({ recentDishes: list });
  },

  cookNamed() {
    const name = this.data.dishName.trim();
    if (!name) return toast('先输入菜名');
    this.rememberDish(name);
    this.setData({ dishName: '' });
    wx.navigateTo({ url: `/pages/dish/dish?name=${encodeURIComponent(name)}` });
  },

  openRecent(e) {
    const name = e.currentTarget.dataset.name;
    this.rememberDish(name);
    wx.navigateTo({ url: `/pages/dish/dish?name=${encodeURIComponent(name)}` });
  },

  removeRecent(e) {
    const name = e.currentTarget.dataset.name;
    const list = (wx.getStorageSync(STORAGE.RECENT_DISH) || []).filter((x) => x !== name);
    wx.setStorageSync(STORAGE.RECENT_DISH, list);
    this.setData({ recentDishes: list });
  },

  goPlan() { wx.navigateTo({ url: '/pages/plan/plan' }); },
  goIndex() { wx.switchTab({ url: '/pages/index/index' }); },

  /* ---------- 今日食材汇总 ---------- */

  /**
   * 逐道菜取做法再合并食材。做成手动触发而不是进页面就拉，
   * 是因为真实模式下每道菜都要调一次模型，不该在用户没要的时候花钱。
   */
  async summarize() {
    const dishes = this.data.meals.flatMap((m) => m.dishes);
    if (!dishes.length || this.data.ingLoading) return;

    const people = (app.globalData.plan.meta || {}).people || 2;
    this.setData({ ingLoading: true });

    const bucket = new Map();
    let failed = 0;
    for (let i = 0; i < dishes.length; i++) {
      this.setData({ ingHint: `汇总中 ${i + 1}/${dishes.length}…` });
      try {
        const d = await api.detail({ dish: dishes[i].name, people });
        for (const [kind, items] of [['主料', d.ingredients], ['调料', d.seasoning]]) {
          for (const it of items || []) {
            if (!it.name) continue;
            const cur = bucket.get(it.name) || { amounts: [], kind };
            cur.amounts.push(it.amount);
            bucket.set(it.name, cur);
          }
        }
      } catch (e) {
        failed += 1;
      }
    }

    const groups = ['主料', '调料']
      .map((kind) => ({
        kind,
        items: [...bucket.entries()]
          .filter(([, v]) => v.kind === kind)
          .map(([name, v]) => ({ name, amount: mergeAmounts(v.amounts) })),
      }))
      .filter((g) => g.items.length);

    this.setData({
      ingLoading: false,
      ingLoaded: true,
      ingGroups: groups,
      ingHint: failed ? `有 ${failed} 道菜没取到食材，已跳过。` : '',
    });
  },
});

/* ---------- 用量合并 ---------- */

const UNIT_ALIAS = {
  g: 'g', 克: 'g', kg: 'kg', 千克: 'kg', 公斤: 'kg',
  ml: 'ml', ML: 'ml', 毫升: 'ml', 升: 'L',
  个: '个', 只: '只', 根: '根', 瓣: '瓣', 条: '条', 片: '片', 棵: '棵', 头: '头',
  把: '把', 张: '张', 块: '块', 朵: '朵', 粒: '粒', 颗: '颗', 枚: '枚', 段: '段',
  盒: '盒', 包: '包', 袋: '袋', 罐: '罐', 小撮: '小撮',
  汤匙: '汤匙', 大匙: '汤匙', 茶匙: '茶匙', 小匙: '茶匙', 勺: '勺',
};
const CN_NUM = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const MEASURED = new Set(['g', 'kg', 'ml', 'L']);
const COUNTABLE = new Set(['个', '只', '根', '瓣', '条', '片', '棵', '头', '把', '张', '块', '朵', '粒', '颗', '枚', '段', '盒', '包', '袋', '罐']);

function parseNumber(text) {
  const s = String(text).trim();
  if (CN_NUM[s] !== undefined) return CN_NUM[s];
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 模型写的用量长这样：「2个（约100克蛋液）」「1汤匙（约15克）」。
 * 论个买的按个数记；匙勺没法相加，就取括号里换算好的克/毫升。
 */
function parseAmount(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const head = raw.match(/^([\d.]+|\d+\s*\/\s*\d+|[半一两二三四五六七八九十])\s*([^\s（(，,]*)/);
  const headNum = head ? parseNumber(head[1]) : null;
  const headUnit = head ? UNIT_ALIAS[head[2]] : null;
  if (headNum !== null && headUnit && (COUNTABLE.has(headUnit) || MEASURED.has(headUnit))) {
    return { num: headNum, unit: headUnit };
  }
  const paren = raw.match(/[（(][^）)]*?约?\s*([\d.]+(?:\s*\/\s*\d+)?)\s*(克|g|毫升|ml|ML)/i);
  if (paren) {
    const n = parseNumber(paren[1]);
    if (n !== null) return { num: n, unit: UNIT_ALIAS[paren[2]] || UNIT_ALIAS[paren[2].toLowerCase()] };
  }
  if (headNum !== null && headUnit) return { num: headNum, unit: headUnit };
  return null;
}

const roundNum = (n) => Math.round(n * 100) / 100;

function formatQty(num, unit) {
  if (unit === 'g' && num >= 1000) return `${roundNum(num / 1000)} kg`;
  if (unit === 'ml' && num >= 1000) return `${roundNum(num / 1000)} L`;
  return `${roundNum(num)} ${unit}`;
}

function mergeAmounts(list) {
  const sums = new Map();
  const plain = [];
  for (const item of list) {
    const text = String(item || '').trim();
    if (!text) continue;
    const p = parseAmount(text);
    if (p) sums.set(p.unit, (sums.get(p.unit) || 0) + p.num);
    else plain.push(text);
  }
  const parts = [...sums.entries()].map(([unit, num]) => formatQty(num, unit));
  const extras = [...new Set(plain)];
  if (!parts.length && !extras.length) return '';
  if (!parts.length) return extras.slice(0, 2).join('、');
  return parts.join(' + ') + (extras.length ? `（另${extras[0]}）` : '');
}
