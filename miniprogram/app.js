const api = require('./utils/api');
const { STORAGE } = require('./utils/config');

App({
  globalData: {
    user: null,
    config: null,
    plan: null,        // 当前菜单
    picks: [],         // 勾选要做的菜「第几天::菜名」
    startDate: '',     // 第 1 天对应的真实日期
  },

  onLaunch() {
    this.restore();
  },

  /** 从本地缓存恢复上次的菜单与勾选，冷启动也能直接进做菜界面 */
  restore() {
    try {
      this.globalData.plan = wx.getStorageSync(STORAGE.PLAN) || null;
      this.globalData.picks = wx.getStorageSync(STORAGE.PICKS) || [];
      this.globalData.startDate = wx.getStorageSync(STORAGE.START) || '';
    } catch (e) {
      console.warn('[restore]', e);
    }
  },

  savePlan(plan) {
    this.globalData.plan = plan;
    wx.setStorageSync(STORAGE.PLAN, plan);
  },

  savePicks(picks) {
    this.globalData.picks = picks;
    wx.setStorageSync(STORAGE.PICKS, picks);
  },

  saveStartDate(date) {
    this.globalData.startDate = date;
    wx.setStorageSync(STORAGE.START, date);
  },

  /**
   * 确保已登录。优先微信一键登录；服务端没配 AppID 时（503）
   * 回退到账号密码登录页，方便还没拿到 AppID 的开发阶段。
   */
  async ensureLogin() {
    if (this.globalData.user) return this.globalData.user;

    const cached = await api.me();
    if (cached) {
      this.globalData.user = cached;
      return cached;
    }
    try {
      const user = await api.loginByWeixin();
      this.globalData.user = user;
      return user;
    } catch (err) {
      if (/未配置/.test(err.message)) return null; // 交给调用方引导到账号登录
      throw err;
    }
  },

  signOut() {
    api.logout();
    this.globalData.user = null;
    [STORAGE.PLAN, STORAGE.PICKS, STORAGE.START, STORAGE.DONE].forEach((k) => wx.removeStorageSync(k));
    this.globalData.plan = null;
    this.globalData.picks = [];
    this.globalData.startDate = '';
  },
});
