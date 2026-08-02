// ============================================================
//  server/gifts.js · 互动 → 积分(pts) 的唯一计分表
//  ------------------------------------------------------------
//  ★这张表必须和 src/main.js 的 GIFTS.pts 逐项一致★
//    改了任何一个数，两边一起改。两边不一致 = 主播看到的积分和服务端记的账对不上，
//    而账本是要按积分分钱给观众的。
//
//  ⚠️ 为什么不能沿用 ranking.js 里那个 gift_value：
//    真机回调的 gift_value = 抖币 × 10（电池 99 → 990，2026-07-30 实测定案），
//    而客户端 pts 用的是抖币价本身（电池 = 99）。旧的 recordGift 直接把 gift_value 当分记，
//    于是【服务端的世界榜分是客户端的 10 倍】，而且点赞/评论压根不记分。
//    两本账从来没对齐过 —— 搬账本之前必须先统一到这张表。
//
//  ⚠️ 按 key 计分而不是按 gift_value：key 是 douyin.js 用 sec_gift_id 精确映射出来的，
//    不受 gift_value 单位歧义影响（见 douyin.js 里那段审核事故注释）。
// ============================================================
'use strict';

// key 与 douyin.js translate() 的产出、src/main.js 的 GIFTS 一一对应
const PTS = {
  join: 1,        // 首次互动加入
  like: 10,       // 点赞（2026-08-02 用户定：1 → 10）
  c666: 10,       // 评论 666 / 纯 6 串：已并入点赞，分值必须与 like 相同
  wand: 1,        // 仙女棒 1 抖币
  pill: 10,       // 能力药丸 10
  donut: 52,      // 甜甜圈 52
  battery: 99,    // 能量电池 99
  mic: 299,       // 派对话筒 299
  airdrop: 520,   // 神秘空投 520
};

// 免费互动(点赞/评论/加入) vs 付费礼物 —— 决定结算「全员分成资格」走哪条通道。
// 与 src/main.js 里 `g.price > 0 ? 'gift' : 'like'` 同口径。
const PAID = { wand: 1, pill: 1, donut: 1, battery: 1, mic: 1, airdrop: 1 };

const ptsOf = (key) => PTS[key] || 0;
const isPaid = (key) => !!PAID[key];

module.exports = { PTS, ptsOf, isPaid };
