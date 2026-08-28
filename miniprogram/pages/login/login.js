const app = getApp();
const api = require('../../utils/api');
const { toast } = require('../../utils/util');

Page({
  data: {
    wxAvailable: true,   // 服务端配了 AppID/AppSecret 才能一键登录
    mode: 'login',       // login | register
    username: '',
    password: '',
    busy: false,
    error: '',
  },

  onLoad() {
    // 先探一下服务端有没有配微信登录，没配就直接显示账号登录
    api.config().catch(() => null).then((cfg) => {
      if (cfg && cfg.wxLogin === false) this.setData({ wxAvailable: false });
    });
  },

  /* ---------- 微信一键登录 ---------- */

  async loginWeixin() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const user = await api.loginByWeixin();
      app.globalData.user = user;
      toast('登录成功', 'success');
      wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/index/index' }) });
    } catch (e) {
      // 服务端没配 AppID 时切到账号登录，别把用户堵死
      const noConfig = /未配置/.test(e.message);
      this.setData({ wxAvailable: !noConfig, error: e.message });
    } finally {
      this.setData({ busy: false });
    }
  },

  /* ---------- 账号密码（开发阶段 / 与网页版共用） ---------- */

  onUsername(e) { this.setData({ username: e.detail.value }); },
  onPassword(e) { this.setData({ password: e.detail.value }); },
  switchMode(e) { this.setData({ mode: e.currentTarget.dataset.mode, error: '' }); },

  async submit() {
    const { username, password, mode, busy } = this.data;
    if (busy) return;
    if (!username || !password) return this.setData({ error: '请填写用户名和密码' });

    this.setData({ busy: true, error: '' });
    try {
      const user = await api.loginByPassword(username.trim(), password, mode);
      app.globalData.user = user;
      toast(mode === 'login' ? '登录成功' : '注册成功', 'success');
      wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/index/index' }) });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ busy: false });
    }
  },
});
