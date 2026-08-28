const app = getApp();
const api = require('../../utils/api');
const { STORAGE } = require('../../utils/config');
const { toast } = require('../../utils/util');

const QUICK = [
  '鸡蛋', '猪肉', '牛肉', '鸡肉', '虾', '鱼',
  '白菜', '青菜', '土豆', '番茄', '茄子', '青椒',
  '黄瓜', '洋葱', '豆腐', '香菇', '胡萝卜', '西兰花',
];

const MEAL_SLOTS = [
  { key: 'breakfast', emoji: '🌅', name: '早餐' },
  { key: 'lunch', emoji: '☀️', name: '午餐' },
  { key: 'dinner', emoji: '🌙', name: '晚餐' },
];

Page({
  data: {
    // WXML 里不能调方法，选中态一律在 JS 算好
    quickList: QUICK.map((name) => ({ name, on: false })),
    slotList: MEAL_SLOTS.map((s) => ({ ...s, on: s.key !== 'breakfast' })),

    ingredients: [],
    input: '',
    people: 2,
    extra: '',
    strict: false,
    days: 2,

    result: null,     // 「能做什么菜」的结果
    loading: false,
    needLogin: false,
  },

  onLoad() {
    const saved = wx.getStorageSync(STORAGE.ING) || [];
    this.setData({ ingredients: saved }, () => this.syncQuick());
  },

  async onShow() {
    const user = await app.ensureLogin();
    this.setData({ needLogin: !user });
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },

  /* ---------- 食材 ---------- */

  onInput(e) { this.setData({ input: e.detail.value }); },

  addFromInput() { this.addIngredients(this.data.input); },

  addQuick(e) { this.addIngredients(e.currentTarget.dataset.name); },

  /** 一次粘一串也能拆开，符合中文输入习惯 */
  addIngredients(raw) {
    const parts = String(raw || '').split(/[、,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;

    const list = [...this.data.ingredients];
    for (const p of parts) {
      const name = p.slice(0, 20);
      if (list.includes(name)) continue;
      if (list.length >= 30) { toast('最多 30 样，够用了'); break; }
      list.push(name);
    }
    this.persist(list, { input: '' });
  },

  removeIngredient(e) {
    const name = e.currentTarget.dataset.name;
    this.persist(this.data.ingredients.filter((x) => x !== name));
  },

  clearAll() {
    this.persist([]);
  },

  persist(list, extra = {}) {
    wx.setStorageSync(STORAGE.ING, list);
    this.setData({ ingredients: list, ...extra }, () => this.syncQuick());
  },

  /** 已加的食材在快捷区高亮，避免重复点 */
  syncQuick() {
    this.setData({
      quickList: this.data.quickList.map((q) => ({ ...q, on: this.data.ingredients.indexOf(q.name) > -1 })),
    });
  },

  /* ---------- 其它表单 ---------- */

  stepPeople(e) {
    const d = Number(e.currentTarget.dataset.delta);
    this.setData({ people: Math.min(Math.max(this.data.people + d, 1), 30) });
  },

  onExtra(e) { this.setData({ extra: e.detail.value }); },
  onStrict(e) { this.setData({ strict: e.detail.value }); },
  onDays(e) { this.setData({ days: e.detail.value }); },

  toggleSlot(e) {
    const key = e.currentTarget.dataset.key;
    const cur = this.data.slotList;
    const on = cur.find((s) => s.key === key).on;
    // 至少留一餐，否则排出来是空的
    if (on && cur.filter((s) => s.on).length === 1) return toast('至少要选一餐');
    this.setData({ slotList: cur.map((s) => (s.key === key ? { ...s, on: !on } : s)) });
  },

  pickedMeals() {
    return this.data.slotList.filter((s) => s.on).map((s) => s.key);
  },

  /* ---------- 看看能做什么菜 ---------- */

  async find() {
    if (this.data.loading) return;
    if (!this.data.ingredients.length) return toast('先加几样食材');

    this.setData({ loading: true });
    wx.showLoading({ title: '正在翻你的冰箱…', mask: true });
    try {
      const r = await api.byIngredients({
        ingredients: this.data.ingredients,
        people: this.data.people,
        strict: this.data.strict,
        extra: this.data.extra.trim(),
      });
      this.setData({
        result: {
          ...r,
          readyCount: r.dishes.filter((d) => d.ready).length,
          unusedText: r.unused.length ? r.unused.join('、') : '',
        },
      });
      wx.pageScrollTo({ selector: '.result-head', duration: 300 });
    } catch (e) {
      wx.showModal({ title: '没找出来', content: e.message, showCancel: false });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  /* ---------- 用这些食材排 N 天 ---------- */

  /**
   * 走 /recipes/generate（多传 ingredients），输出结构和「配菜」完全一致，
   * 所以菜单页、选菜、去做菜整条链路都能直接复用。
   */
  async planDays() {
    if (this.data.loading) return;
    if (!this.data.ingredients.length) return toast('先加几样食材');

    this.setData({ loading: true });
    wx.showLoading({ title: `正在排 ${this.data.days} 天…`, mask: true });
    try {
      const plan = await api.generate({
        ingredients: this.data.ingredients,
        people: this.data.people,
        days: this.data.days,
        meals: this.pickedMeals(),
        extra: this.data.extra.trim(),
      });
      app.savePlan(plan);
      app.savePicks([]);       // 新菜单，清掉上一份的勾选
      app.saveStartDate('');
      wx.removeStorageSync(STORAGE.DONE);

      const left = (plan.unusedFromPantry || []).length;
      toast(left ? `排好了，还剩 ${left} 样没用上` : '排好了，食材全都用上了 🎉');
      wx.navigateTo({ url: '/pages/plan/plan' });
    } catch (e) {
      wx.showModal({ title: '排不出来', content: e.message, showCancel: false });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  openDish(e) {
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({ url: `/pages/dish/dish?name=${encodeURIComponent(name)}` });
  },
});
