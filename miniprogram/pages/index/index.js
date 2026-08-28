const app = getApp();
const api = require('../../utils/api');
const { STORAGE } = require('../../utils/config');
const { toast } = require('../../utils/util');

const MEAL_TYPES = [
  { key: 'family', emoji: '🏠', name: '家宴', desc: '丰盛家常' },
  { key: 'banquet', emoji: '🎉', name: '宴席', desc: '正式讲究' },
  { key: 'simple', emoji: '🥢', name: '简餐', desc: '快手省时' },
];
const MEAL_SLOTS = [
  { key: 'breakfast', emoji: '🌅', name: '早餐' },
  { key: 'lunch', emoji: '☀️', name: '午餐' },
  { key: 'dinner', emoji: '🌙', name: '晚餐' },
];
const DEFAULT_TASTES = ['麻辣', '香辣', '清淡', '咸鲜', '偏甜', '酸辣', '蒜香', '酱香', '清蒸原味', '孜然', '咖喱', '酸甜'];

Page({
  data: {
    mealTypes: MEAL_TYPES,
    // WXML 表达式里不能调方法（indexOf 失效），选中态一律在 JS 里算好
    slotList: MEAL_SLOTS.map((s) => ({ ...s, on: s.key !== 'breakfast' })),
    tasteList: DEFAULT_TASTES.map((t) => ({ name: t, on: false })),

    people: 4,
    days: 3,
    mealType: 'family',
    meals: ['lunch', 'dinner'],
    pickedTastes: [],
    extra: '',
    useMemory: true,

    mockMode: false,
    loading: false,
    loadingText: '',
    needLogin: false,
  },

  onLoad() {
    this.restorePrefs();
  },

  async onShow() {
    const user = await app.ensureLogin();
    if (!user) return this.setData({ needLogin: true });
    this.setData({ needLogin: false });
    try {
      const cfg = await api.config();
      app.globalData.config = cfg;
      const names = (cfg.tastes && cfg.tastes.length) ? cfg.tastes : DEFAULT_TASTES;
      this.setData({
        mockMode: cfg.mockMode,
        tasteList: names.map((t) => ({ name: t, on: this.data.pickedTastes.indexOf(t) > -1 })),
      });
    } catch (e) {
      toast(e.message);
    }
  },

  /* ---------- 表单状态 ---------- */

  restorePrefs() {
    const p = wx.getStorageSync(STORAGE.PREFS);
    if (!p) return;
    this.setData({
      people: p.people || 4,
      days: p.days || 3,
      mealType: p.mealType || 'family',
      meals: (p.meals && p.meals.length) ? p.meals : ['lunch', 'dinner'],
      pickedTastes: p.pickedTastes || [],
      useMemory: p.useMemory !== false,
    }, () => this.syncFlags());
  },

  /** 把 meals / pickedTastes 的选中态同步到列表数据上 */
  syncFlags() {
    this.setData({
      slotList: this.data.slotList.map((s) => ({ ...s, on: this.data.meals.indexOf(s.key) > -1 })),
      tasteList: this.data.tasteList.map((t) => ({ ...t, on: this.data.pickedTastes.indexOf(t.name) > -1 })),
    });
  },

  savePrefs() {
    const { people, days, mealType, meals, pickedTastes, useMemory } = this.data;
    wx.setStorageSync(STORAGE.PREFS, { people, days, mealType, meals, pickedTastes, useMemory });
  },

  stepPeople(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const people = Math.min(Math.max(this.data.people + delta, 1), 30);
    this.setData({ people }, () => this.savePrefs());
  },

  onDays(e) {
    this.setData({ days: e.detail.value }, () => this.savePrefs());
  },

  pickType(e) {
    this.setData({ mealType: e.currentTarget.dataset.key }, () => this.savePrefs());
  },

  toggleMeal(e) {
    const key = e.currentTarget.dataset.key;
    const has = this.data.meals.includes(key);
    // 至少留一餐，否则生成出来是空的
    if (has && this.data.meals.length === 1) return toast('至少要选一餐');
    const meals = MEAL_SLOTS
      .map((s) => s.key)
      .filter((k) => (k === key ? !has : this.data.meals.includes(k)));
    this.setData({ meals }, () => { this.syncFlags(); this.savePrefs(); });
  },

  toggleTaste(e) {
    const t = e.currentTarget.dataset.taste;
    const picked = this.data.pickedTastes.includes(t)
      ? this.data.pickedTastes.filter((x) => x !== t)
      : [...this.data.pickedTastes, t].slice(0, 6);
    this.setData({ pickedTastes: picked }, () => { this.syncFlags(); this.savePrefs(); });
  },

  onExtra(e) { this.setData({ extra: e.detail.value }); },
  onMemory(e) { this.setData({ useMemory: e.detail.value }, () => this.savePrefs()); },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },

  /* ---------- 生成 ---------- */

  async generate() {
    if (this.data.loading) return;
    const { people, days, mealType, meals, pickedTastes, extra, useMemory } = this.data;

    const text = { banquet: '大厨正在设计宴席…', simple: '正在搭配快手简餐…' }[mealType] || '大厨正在为你配菜…';
    this.setData({ loading: true, loadingText: text });
    wx.showLoading({ title: '生成中…', mask: true });

    try {
      const plan = await api.generate({
        people, days, mealType, meals,
        tastes: pickedTastes,
        extra: extra.trim(),
        useMemory,
      });
      app.savePlan(plan);
      app.savePicks([]);          // 新菜单，清掉上一份的勾选
      app.saveStartDate('');
      wx.removeStorageSync(STORAGE.DONE);
      wx.navigateTo({ url: '/pages/plan/plan' });
    } catch (e) {
      wx.showModal({ title: '生成失败', content: e.message, showCancel: false });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },
});
