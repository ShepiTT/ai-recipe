/**
 * 后端地址。
 *
 * ── 开发阶段（可以用 IP，不用域名）────────────────────────────
 *   DEV 填 http://公网IP:3000 或 http://localhost:3000
 *   开发者工具：详情 → 本地设置 → 勾「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」
 *   手机真机：微信打开开发版 → 右上角胶囊 → 开发调试 → 打开调试模式
 *
 * ── 正式上线（必须域名，没有例外）──────────────────────────────
 *   PROD 填 https://已备案域名（不能带端口、不能用 IP、必须 443）
 *   小程序后台「开发管理 → 开发设置 → 服务器域名 → request 合法域名」
 *   要配同一个域名，那个输入框只接受域名，填 IP 会直接报错。
 *   提审时微信在真实线上环境跑，配不了域名等于所有接口都失败，必被驳回。
 */

// 开发用：改成你阿里云服务器的公网 IP，本机调试就留 localhost
const DEV_URL = 'http://localhost:3000';

// 上线用：备案下来后填这里
const PROD_URL = 'https://your-domain.com';

// 上线前把这行改成 PROD_URL
const BASE_URL = DEV_URL;

/** 本地缓存的键名，集中管理避免各页面写错 */
const STORAGE = {
  TOKEN: 'ai_recipe_token',
  PREFS: 'ai_recipe_prefs',
  PLAN: 'ai_recipe_plan',
  PICKS: 'ai_recipe_picks',   // 勾选要做的菜，键是「第几天::菜名」
  DONE: 'ai_recipe_done',     // 做菜界面里已完成的菜
  START: 'ai_recipe_start',   // 第 1 天对应的真实日期
};

module.exports = { BASE_URL, DEV_URL, PROD_URL, STORAGE };
