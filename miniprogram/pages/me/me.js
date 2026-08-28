const app = getApp();
const api = require('../../utils/api');
const { toast, confirm } = require('../../utils/util');

Page({
  data: {
    user: null,
    initial: '',
    profile: null,
    summary: null,
    history: [],
    editing: false,
    form: { nickname: '', householdSize: 2, tastePrefs: '', dislikedTastes: '', allergies: '' },
  },

  async onShow() {
    const user = await app.ensureLogin();
    this.setData({ user, initial: user ? (user.displayName || '?').charAt(0) : '' });
    if (user) this.loadProfile();
  },

  async loadProfile() {
    try {
      const profile = await api.memory();
      const join = (a) => (a && a.length ? a.join('、') : '暂无');
      this.setData({
        profile,
        summary: {
          nickname: profile.nickname || '未设置',
          household: (profile.householdSize || 2) + ' 人',
          tastePrefs: join(profile.tastePrefs),
          allergies: join(profile.allergies),
          liked: join(profile.likedDishes),
          recent: join(profile.recentDishes),
        },
        history: (profile.history || []).slice(0, 20).map((h) => ({
          ...h,
          dateText: String(h.date || '').slice(0, 10),
        })),
        form: {
          nickname: profile.nickname || '',
          householdSize: profile.householdSize || 2,
          tastePrefs: (profile.tastePrefs || []).join('、'),
          dislikedTastes: (profile.dislikedTastes || []).join('、'),
          allergies: (profile.allergies || []).join('、'),
        },
      });
    } catch (e) {
      toast(e.message);
    }
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },

  toggleEdit() { this.setData({ editing: !this.data.editing }); },

  onField(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`form.${k}`]: e.detail.value });
  },

  async saveMemory() {
    const f = this.data.form;
    const split = (s) => String(s || '').split(/[、,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
    try {
      const profile = await api.saveMemory({
        nickname: f.nickname.trim(),
        householdSize: Number(f.householdSize) || 2,
        tastePrefs: split(f.tastePrefs),
        dislikedTastes: split(f.dislikedTastes),
        allergies: split(f.allergies),
      });
      this.setData({ profile, editing: false });
      toast('记忆已保存', 'success');
    } catch (e) {
      toast(e.message);
    }
  },

  /* ---------- 历史 ---------- */

  async openHistory(e) {
    const { id, hasplan } = e.currentTarget.dataset;
    if (hasplan === false) return toast('这条记录较早，只保留了菜名摘要');
    wx.showLoading({ title: '载入中…', mask: true });
    try {
      const plan = await api.historyDetail(id);
      app.savePlan(plan);
      app.savePicks(plan.picks || []);
      app.saveStartDate(plan.startDate || '');
      wx.navigateTo({ url: '/pages/plan/plan' });
    } catch (err) {
      toast(err.message);
    } finally {
      wx.hideLoading();
    }
  },

  async removeHistory(e) {
    const id = e.currentTarget.dataset.id;
    if (!await confirm('删除这条生成记录？')) return;
    try {
      await api.deleteHistory(id);
      this.loadProfile();
      toast('已删除');
    } catch (err) {
      toast(err.message);
    }
  },

  async clearHistory() {
    if (!await confirm('清空全部生成记录？此操作不可恢复。')) return;
    try {
      await api.clearHistory();
      this.loadProfile();
      toast('已清空');
    } catch (e) {
      toast(e.message);
    }
  },

  async signOut() {
    if (!await confirm('退出登录？本地的菜单和勾选也会清掉。')) return;
    app.signOut();
    this.setData({ user: null, profile: null, history: [] });
    toast('已退出');
  },
});
