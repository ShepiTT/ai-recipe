const app = getApp();
const api = require('../../utils/api');
const { STORAGE } = require('../../utils/config');
const { pickKey, pickedNames, todayKey, addDays, formatDate, toast } = require('../../utils/util');

Page({
  data: {
    plan: null,
    dayIndex: 0,
    dayTabs: [],
    meals: [],          // 当天餐次，dishes 里带 picked 标记
    picks: [],
    pickCount: 0,
    shopGroups: [],
    allPickedToday: false,

    datePicking: false,
    startDate: '',
    datePreview: '',
  },

  onShow() {
    const plan = app.globalData.plan;
    if (!plan) {
      this.setData({ plan: null });
      return;
    }
    this.setData({
      plan,
      picks: app.globalData.picks || [],
      dayTabs: (plan.days || []).map((d, i) => d.label || (plan.days.length > 1 ? `第 ${d.day || i + 1} 天` : '当天')),
      shopGroups: this.groupShopping(plan.shoppingList || []),
    }, () => this.renderDay());
  },

  groupShopping(list) {
    const map = new Map();
    for (const item of list) {
      const g = item.category || '其他';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(item);
    }
    return [...map.entries()].map(([name, items]) => ({ name, items }));
  },

  /** 把当天餐次里的菜标上是否已勾选，WXML 里就不用做复杂判断 */
  renderDay() {
    const { plan, dayIndex, picks } = this.data;
    const day = (plan.days || [])[dayIndex];
    const meals = (day ? day.meals || [] : []).map((m) => ({
      ...m,
      dishes: (m.dishes || []).map((d) => ({ ...d, picked: picks.includes(pickKey(dayIndex, d.name)) })),
    }));
    const todayKeys = meals.flatMap((m) => m.dishes.map((d) => pickKey(dayIndex, d.name)));
    this.setData({
      meals,
      pickCount: picks.length,
      allPickedToday: todayKeys.length > 0 && todayKeys.every((k) => picks.includes(k)),
    });
  },

  switchDay(e) {
    this.setData({ dayIndex: Number(e.currentTarget.dataset.i) }, () => this.renderDay());
  },

  /* ---------- 选菜 ---------- */

  togglePick(e) {
    const name = e.currentTarget.dataset.name;
    const key = pickKey(this.data.dayIndex, name);
    const picks = this.data.picks.includes(key)
      ? this.data.picks.filter((k) => k !== key)
      : [...this.data.picks, key];
    app.savePicks(picks);
    this.setData({ picks }, () => this.renderDay());
  },

  toggleWholeDay() {
    const { plan, dayIndex, picks, allPickedToday } = this.data;
    const day = (plan.days || [])[dayIndex];
    const keys = (day ? day.meals || [] : [])
      .flatMap((m) => (m.dishes || []).map((d) => pickKey(dayIndex, d.name)));
    const next = allPickedToday
      ? picks.filter((k) => !keys.includes(k))
      : [...new Set([...picks, ...keys])];
    app.savePicks(next);
    this.setData({ picks: next }, () => this.renderDay());
  },

  openDish(e) {
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({ url: `/pages/dish/dish?name=${encodeURIComponent(name)}` });
  },

  async feedback(e) {
    const { name, act } = e.currentTarget.dataset;
    try {
      await api.feedback(name, act);
      toast(act === 'like' ? `已记住：喜欢「${name}」` : `已记住：不喜欢「${name}」`);
    } catch (err) {
      toast(err.message);
    }
  },

  /* ---------- 确认去做菜 ---------- */

  openDatePicker() {
    if (!this.data.picks.length) return toast('先勾选这次要做的菜');
    const start = app.globalData.startDate || todayKey();
    this.setData({ datePicking: true, startDate: start }, () => this.updatePreview());
  },

  closeDatePicker() { this.setData({ datePicking: false }); },
  stopTap() {},

  onDateChange(e) {
    this.setData({ startDate: e.detail.value }, () => this.updatePreview());
  },

  quickDate(e) {
    const offset = Number(e.currentTarget.dataset.offset);
    this.setData({ startDate: addDays(todayKey(), offset) }, () => this.updatePreview());
  },

  updatePreview() {
    const total = (this.data.plan.days || []).length || 1;
    const start = this.data.startDate;
    this.setData({
      datePreview: total > 1
        ? `第 1 天 ${formatDate(start)}　→　第 ${total} 天 ${formatDate(addDays(start, total - 1))}`
        : `就这一天：${formatDate(start)}`,
    });
  },

  async confirmCook() {
    const { picks, startDate, plan } = this.data;
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      await api.cook({
        dishes: pickedNames(picks),   // 进「最近做过」的是去重后的菜名
        picks,                        // 按天的原始勾选，回看时精确还原
        historyId: plan.historyId || '',
        startDate,
      });
      app.saveStartDate(startDate);
      wx.removeStorageSync(STORAGE.DONE);
      this.setData({ datePicking: false });
      wx.switchTab({ url: '/pages/cook/cook' });
    } catch (e) {
      wx.showModal({ title: '保存失败', content: e.message, showCancel: false });
    } finally {
      wx.hideLoading();
    }
  },

  goIndex() { wx.switchTab({ url: '/pages/index/index' }); },
});
