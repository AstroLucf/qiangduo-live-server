// ============================================================
//  server/config.js · 运行配置（从环境变量读，缺省给开发默认）
//  ------------------------------------------------------------
//  ⚠ AppSecret 不要硬编进仓库：用环境变量传，例：
//     DOUYIN_APPSECRET=xxxx DEV_SKIP_SIGN=0 node server/index.js
// ============================================================
'use strict';
module.exports = {
  PORT: parseInt(process.env.PORT || '8787', 10),

  // 应用身份（控制台 > 开发配置）
  APPID: process.env.DOUYIN_APPID || 'tt62e91454fc8d46c610',   // 抢夺：45分钟
  APPSECRET: process.env.DOUYIN_APPSECRET || '',               // 控制台「启用 AppSecret」后用 env 传入

  // 开发期跳过验签：先用本机 mock / 自查工具(test 数据) 把链路跑通；
  // 正式联调把它置 0，并在 douyin.js 里用「签名调试工具」校准验签算法。
  DEV_SKIP_SIGN: (process.env.DEV_SKIP_SIGN || '1') === '1',

  // 选队数据未知时，礼物默认归哪边：'ignore'(丢弃) / 'left' / 'right'。
  // 正式期观众都会先「选队」，应保持 ignore；本机自测可临时设 left/right。
  DEFAULT_SIDE: process.env.DEFAULT_SIDE || 'ignore',

  // 开发期同源托管游戏文件 + 沙盒测试台（SERVE_STATIC=1）。
  // 开启后浏览器/Electron 开 http://localhost:8787/index.html?live=1 即同源连 SSE，
  // 规避 file://→localhost 的 PNA/跨域；/test 是可视化测试台。云端不设此 env，故 / 仍是健康探针、不暴露测试台。
  SERVE_STATIC: process.env.SERVE_STATIC === '1',
};
