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
// 2026-06-21 沙盒自查工具实抓的真实 sec_gift_id（精确映射，免受 gift_value 单位歧义影响）：
const GIFT_ID_TO_KEY = {
  'n1/Dg1905sj1FyoBlQBvmbaDZFBNaKuKZH6zxHkv8Lg5x2cRfrKUTb8gzMs=': 'wand',    // 仙女棒 1抖币
  '28rYzVFNyXEXFC8HI+f/WG+I7a6lfl3OyZZjUS+CVuwCgYZrPrUdytGHu0c=': 'pill',    // 能力药丸 10抖币
  'PJ0FFeaDzXUreuUBZH6Hs+b56Jh0tQjrq0bIrrlZmv13GSAL9Q1hf59fjGk=': 'donut',   // 甜甜圈 52抖币
  'YbLESoUj053FWVYPWUNOAtp4FYnb+/eZbyrLi7ndArVFz14rivgxf0cFrKs=': 'mic',     // 派对话筒 299抖币
  'pGLo7HKNk1i4djkicmJXf6iWEyd+pfPBjbsHmd3WcX0Ierm2UdnRR7UINvI=': 'airdrop', // 神秘空投 520抖币
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
// 查该用户【主动选过】的队(评论1/2 · 原生选队)；没选过返回 ''(纯探测,绝不触发随机落座)
function chosenSide(openid) { return (openid && userSide.get(openid)) || ''; }
// 给一次互动定边：主动选过 → 那边；否则 DEFAULT_SIDE 指定 left/right → 固定；否则「随机落座」(哈希,没选队也参与、不丢弃)
function sideOf(openid, fallback) {
  const chosen = chosenSide(openid);
  if (chosen) return chosen;
  if (fallback === 'left' || fallback === 'right') return fallback;
  return hashSide(openid);
}
// 随机落座：按 openid 哈希定边 —— 同一观众恒定一边(礼物不会一会左一会右)、整体两边均匀,
// 且无内存依赖(FaaS 多实例天然一致,绕开内存 userSide 跨实例不共享的坑)。
function hashSide(openid) {
  const s = String(openid || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h & 1) ? 'right' : 'left';
}

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

// —— 用户身份：真机回调字段名以 index.js 的 [cb] raw 日志为准；这里跨「多候选名 + 一层嵌套」尽量容错命中。
// 抓到一条真机样例后，把命中的真实字段名补到对应数组首位即可精确锁定。
// 原样透传给客户端，用于「真实昵称提示 + 小火箭真实头像 + 按 openid 去重」。
function deepPick(payload, keys) {
  const nests = [payload, payload.user, payload.data, payload.sender, payload.from_user, payload.user_info, payload.userInfo];
  for (const o of nests) {
    if (!o || typeof o !== 'object') continue;
    for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  }
  return '';
}
// 抖音头像常是嵌套对象 {url_list:[url,…]} 或 {url:…}，不是扁平字符串。
// deepPick 命中 avatar_thumb 会返回整个对象 → 客户端 avatar 变 [object Object]、渲染失败 →
// 这就是真机「永远不显示真实头像」的头号坑。pickUrl 把真实 URL 抠出来。
function pickUrl(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return pickUrl(v[0]);
  if (typeof v === 'object') return pickUrl(v.url_list || v.urlList || v.url || v.uri || v.avatar_thumb || v.avatar || '');
  return '';
}
function userOf(payload) {
  return {
    openid:   deepPick(payload, ['sec_openid', 'sec_open_id', 'open_id', 'openid', 'openId', 'sec_uid', 'user_id', 'uid']),
    nickname: deepPick(payload, ['nickname', 'nick_name', 'nickName', 'nick', 'user_name', 'userName', 'name']),
    // 先扁平字符串字段、再抖音标准嵌套字段(avatar_thumb.url_list[0]…)，统一过 pickUrl 抠出真实 URL
    avatar:   pickUrl(deepPick(payload, ['avatar_url', 'avatarUrl', 'head_url', 'headUrl', 'head_img', 'avatar_thumb', 'avatar', 'avatar_medium', 'avatar_large', 'head'])),
  };
}
// 评论内容也跨多候选字段名取（真机字段名以 raw 日志为准）
function commentText(payload) {
  return deepPick(payload, ['content', 'comment', 'text', 'msg', 'message', 'comment_text', 'commentText']);
}

// —— 评论选队：观众发含关键词的评论即选边（大壮=left / 小美=right）——
// 关键词按运营可调；纯数字「1/2」沿用 index.html 原设计（弹幕 1 帮大壮、2 帮小美）。
const TEAM_WORDS = {
  left: ['1', '大壮', '壮', '帮大壮', '左'],
  right: ['2', '小美', '美', '帮小美', '右'],
};
function sideFromComment(content) {
  const s = String(content || '').trim();
  if (!s) return null;
  const hitL = TEAM_WORDS.left.some((w) => s === w || s.includes(w));
  const hitR = TEAM_WORDS.right.some((w) => s === w || s.includes(w));
  if (hitL && !hitR) return 'left';
  if (hitR && !hitL) return 'right';
  return null;                                   // 都含/都不含 → 不当选队，按普通评论加力
}

// —— 原生「用户选队」回调 /cb/team 的阵营字段：真机字段名/值待一条样例锁定（同 sec_gift_id 流程），
// 先做多字段名 + 多值容错；锁定后把真实字段/值补进来即可精确命中。
function normalizeSide(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (['left', 'l', '1', 'red', '红', '红方', '大壮', '左'].includes(s)) return 'left';
  if (['right', 'r', '2', 'blue', '蓝', '蓝方', '小美', '右'].includes(s)) return 'right';
  return null;
}
function sideFromTeam(payload) {
  const raw = payload.side ?? payload.team ?? payload.camp ?? payload.team_id
    ?? payload.group ?? payload.group_id ?? payload.party ?? payload.faction;
  return normalizeSide(raw);
}

// —— 把一条互动回调翻译成 0~N 条 { side, key, count, openid, nickname, avatar } 游戏指令 ——
// msgType 取 msg_type_str（live_gift / live_like / live_comment）；选队类型字符串待官方确认，
// 这里用内部约定 'team_select'，由回调路由 /cb/team 映射进来。
function translate(msgType, payload, defaultSide) {
  const u = userOf(payload);
  switch (msgType) {
    case 'live_gift': {
      const side = sideOf(u.openid, defaultSide);
      if (side !== 'left' && side !== 'right') return [];
      const key = giftToKey({ sec_gift_id: payload.sec_gift_id, diamond: payload.gift_value || payload.diamond });
      const count = clampInt(payload.gift_num, 1, 20);     // 连击上限 20，防刷屏
      return [{ side, key, count, ...u }];
    }
    case 'live_like': {                                     // 点赞=氛围，不按 like_num 放大（且低概率丢包）
      const side = sideOf(u.openid, defaultSide);
      if (side !== 'left' && side !== 'right') return [];
      return [{ side, key: 'like', count: 1, ...u }];
    }
    case 'live_comment': {
      const picked = sideFromComment(commentText(payload));  // 评论选队：含「1/大壮」→左、「2/小美」→右
      const prev = chosenSide(u.openid);                     // 之前【主动选过】的队（空=没选过；不触发随机落座）
      if (picked && !prev) {                                 // 【仅首次】选队 → 加入（永久推力 + 入场火箭）
        setSide(u.openid, picked);
        return [{ side: picked, key: 'join', count: 1, ...u }];
      }
      // 已选过队后：再喊 1/2 或任何评论 → 都算给【已锁定的队】普通加力(c666)；不重复加入、不切队、不给对面刷力
      const side = prev || sideOf(u.openid, defaultSide);
      if (side !== 'left' && side !== 'right') return [];
      return [{ side, key: 'c666', count: 1, ...u }];
    }
    case 'team_select': {                                   // 原生选队：仅首次记边 + 一次「加入」；重复点忽略
      const side = sideFromTeam(payload);
      if (!side) return [];
      if (chosenSide(u.openid)) return [];                  // 已选过队 → 忽略重复选队（不重复刷永久推力）
      setSide(u.openid, side);
      return [{ side, key: 'join', count: 1, ...u }];
    }
    default: return [];
  }
}

function clampInt(v, lo, hi) { v = parseInt(v, 10); if (!Number.isFinite(v)) v = lo; return Math.max(lo, Math.min(v, hi)); }

module.exports = { verifySign, translate, setSide, sideOf, chosenSide, giftToKey, GIFT_ID_TO_KEY, userOf };
