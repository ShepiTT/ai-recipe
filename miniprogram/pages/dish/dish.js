const app = getApp();
const api = require('../../utils/api');
const { toast } = require('../../utils/util');

// 同一道菜反复点开不重复请求模型（页面级缓存，退出小程序即失效）
const cache = new Map();

Page({
  data: {
    name: '',
    detail: null,
    loading: true,
    error: '',
  },

  onLoad(query) {
    const name = decodeURIComponent(query.name || '');
    this.setData({ name });
    wx.setNavigationBarTitle({ title: name || '做法' });
    this.load(name);
  },

  async load(name) {
    if (!name) return this.setData({ loading: false, error: '缺少菜名' });

    const plan = app.globalData.plan || {};
    const meta = plan.meta || {};
    const people = meta.people || 2;
    const key = `${name}|${people}`;

    if (cache.has(key)) {
      return this.setData({ detail: cache.get(key), loading: false });
    }

    this.setData({ loading: true, error: '' });
    try {
      const detail = await api.detail({
        dish: name,
        people,
        tastes: meta.tastes || [],
        mealType: meta.mealType || '',
        context: plan.title || '',
      });
      cache.set(key, detail);
      this.setData({ detail, loading: false });
    } catch (e) {
      this.setData({ loading: false, error: e.message });
    }
  },

  retry() { this.load(this.data.name); },

  async feedback(e) {
    const act = e.currentTarget.dataset.act;
    try {
      await api.feedback(this.data.name, act);
      toast(act === 'like' ? '已记住：喜欢这道' : '已记住：不喜欢这道');
    } catch (err) {
      toast(err.message);
    }
  },

  copyAll() {
    const d = this.data.detail;
    if (!d) return;
    const lines = [d.name, d.intro].filter(Boolean);
    if (d.ingredients && d.ingredients.length) {
      lines.push('', '【食材】', ...d.ingredients.map((i) => `${i.name} ${i.amount}`));
    }
    if (d.seasoning && d.seasoning.length) {
      lines.push('', '【调料】', ...d.seasoning.map((i) => `${i.name} ${i.amount}`));
    }
    if (d.steps && d.steps.length) {
      lines.push('', '【做法】', ...d.steps.map((s, i) => `${i + 1}. ${s}`));
    }
    if (d.tips) lines.push('', `【小贴士】${d.tips}`);
    wx.setClipboardData({ data: lines.join('\n') });
  },
});
