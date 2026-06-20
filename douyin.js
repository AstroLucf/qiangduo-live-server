// ============================================================
//  server/douyin.js · 抖音互动数据 → 游戏 support() 指令 的翻译层
//  ------------------------------------------------------------
//  把抖音推来的 礼物/点赞/评论/选队 回调，翻译成游戏能直接回放的
//  { side, key, count } 指令（key 与 src/main.js 的 GIFTS 一一对应）。
//  所有「抖音相关」的逻辑都集中在这里，客户端只当哑回放器。
// ============================================================
'use strict';
const crypto = require('crypto');

// —— 礼物 → GIFTS key 映射 ——
// GIFTS 键（见 src/main.js:14）：join/like/c666/wand/pill/donut/battery/mic/airdrop
// 【最可靠】按「礼物置顶」后拿到的 sec_gift_id 精确映射（沙盒里置顶后回填这张表）：
const GIFT_ID_TO_KEY = {
  // '<沙盒里置顶礼物的 sec_gift_id>': 'donut',
};
// 【兜底】按抖币价就近归档（取“价 ≤ 礼物价值”里的最高档）。
// ⚠ gift_value/diamond 的单位（抖币? 分?）待沙盒真实样例确认；置顶映射可彻底绕开此兜底。
const PRICE_TIERS = [
  [520, 'airdrop'], [299, 'mic'], [99, 'battery'],
  [52, 'donut'], [10, 'pill'], [1, 'wand'],
];
function giftToKey({ sec_gift_id, diamond }) {
  if (sec_gift_id && GIFT_ID_TO_KEY[sec_gift_id]) return GIFT_ID_TO_KEY[sec_gift_id];
  const v = Number(diamond) || 0;
  for (const [p, k] of PRICE_TIERS) if (v >= p) return k;
  return 'wand';                              // 最低档兜底
}

// —— 选边：记住每个用户选了哪队 ——（用户快捷选队能力的数据写这里）
const userSide = new Map();                   // sec_openid -> 'left' | 'right'
function setSide(openid, side) {
  if (openid && (side === 'left' || side === 'right')) userSide.set(openid, side);
}
function sideOf(openid, fallback) { return (openid && userSide.get(openid)) || fallback; }

// —— 验签 ——（占位：标准 HMAC 结构；具体拼接顺序/算法用控制台「签名调试工具」校准后定稿）
function verifySign(headers, rawBody, appSecret) {
  const sig = headers['x-signature'];
  if (!sig || !appSecret) return false;
  const nonce = headers['x-nonce-str'] || '';
  const ts = headers['x-timestamp'] || '';
  // TODO(校准)：以官方「签名调试工具」为准。此处先用 [nonce, ts, body] 拼接 + HMAC-SHA256 占位。
  const base = [nonce, ts, rawBody].join('\n');
  const calc = crypto.createHmac('sha256', appSecret).update(base).digest('hex');
  return calc === sig;
}

// —— 把一条互动回调翻译成 0~N 条 { side, key, count } 游戏指令 ——
// msgType 取 msg_type_str（live_gift / live_like / live_comment）；选队类型字符串待官方确认，
// 这里用内部约定 'team_select'，由回调路由 /cb/team 映射进来。
function translate(msgType, payload, defaultSide) {
  const openid = payload.sec_openid || payload.sec_open_id;
  switch (msgType) {
    case 'live_gift': {
      const side = sideOf(openid, defaultSide);
      if (side !== 'left' && side !== 'right') return [];
      const key = giftToKey({ sec_gift_id: payload.sec_gift_id, diamond: payload.gift_value || payload.diamond });
      const count = clampInt(payload.gift_num, 1, 20);     // 连击上限 20，防刷屏
      return [{ side, key, count, from: payload.nickname }];
    }
    case 'live_like': {                                     // 点赞=氛围，不按 like_num 放大（且低概率丢包）
      const side = sideOf(openid, defaultSide);
      if (side !== 'left' && side !== 'right') return [];
      return [{ side, key: 'like', count: 1, from: payload.nickname }];
    }
    case 'live_comment': {
      const side = sideOf(openid, defaultSide);
      if (side !== 'left' && side !== 'right') return [];
      return [{ side, key: 'c666', count: 1, from: payload.nickname }];
    }
    case 'team_select': {                                   // 选队：记边 + 一次「加入」永久推力
      const side = payload.side === 'left' || payload.side === 'right' ? payload.side : null;
      if (!side) return [];
      setSide(openid, side);
      return [{ side, key: 'join', count: 1, from: payload.nickname }];
    }
    default: return [];
  }
}

function clampInt(v, lo, hi) { v = parseInt(v, 10); if (!Number.isFinite(v)) v = lo; return Math.max(lo, Math.min(v, hi)); }

module.exports = { verifySign, translate, setSide, sideOf, giftToKey, GIFT_ID_TO_KEY };
