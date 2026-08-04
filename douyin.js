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
  'IkkadLfz7O/a5UR45p/OOCCG6ewAWVbsuzR/Z+v1v76CBU+mTG/wPjqdpfg=': 'battery', // 能量电池 99抖币（2026-07-02 后台礼物表补齐，修「电池→空投」审核驳回）
};
// 【兜底·仅无 sec_gift_id 时】按抖币价就近归档。用于自查/沙盒工具（送干净 gift_value、不带 sec_gift_id）。
// ⚠ gift_value/diamond 的单位（抖币? 分?）在真机不可信 → 真机一律不走这条（见 giftToKey 分流）。
// ★2026-07-30 真机样例已拿到（抖音云日志·test:true 的 live_gift 回调），单位问题就此定案：
//     真机 gift_value = 抖币 × 10   —— battery 99→990 / mic 299→2990 / pill 10→100 / donut 52→520
//   所以【绝对不能】把真机的 gift_value 拿来跟下面这张表比：990 会撞上 [520,'airdrop']，
//   一个 99 抖币的电池被判成 520 抖币的空投 —— 正是"按不可信数值放大成大礼物"的审核雷。
//   现在 giftToKey 的分流已经挡住了这条路（真机带 sec_gift_id → 精确映射；带了但没命中 → 保守落 wand），
//   这张表只服务于"压根不带 sec_gift_id"的自查/沙盒场景，那里的 gift_value 是干净抖币值。
//   ⚠ 改 giftToKey 的分流逻辑时务必重读这段：一旦让真机数据漏到这张表，就是审核事故。
const PRICE_TIERS = [
  [520, 'airdrop'], [299, 'mic'], [99, 'battery'],
  [52, 'donut'], [10, 'pill'], [1, 'wand'],
];
function giftToKey({ sec_gift_id, diamond }) {
  if (sec_gift_id && GIFT_ID_TO_KEY[sec_gift_id]) return GIFT_ID_TO_KEY[sec_gift_id];
  // 真机带 sec_gift_id 却没命中 = 未登记礼物（6 个付费礼物已全部精确映射，正常到不了这）。
  // 保守兜底：只落最低档 wand + 响亮告警，绝不按不可信的 gift_value 放大成大礼物（审核雷）。
  if (sec_gift_id) {
    console.warn(`[GIFT-UNMAPPED] sec_gift_id=${sec_gift_id} gift_value=${diamond} → 保守兜底 wand（未登记礼物!请补进 GIFT_ID_TO_KEY）`);
    return 'wand';
  }
  // 无 sec_gift_id（自查/沙盒按 gift_value 模拟送）→ 干净数值可靠，走按价兜底。
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
// 匿名(无 openid)落座：当次随机，无法追踪到人 → 不锁、每次重算。
function randSide() { return Math.random() < 0.5 ? 'right' : 'left'; }
// —— 落座锁定(2026-06-30) ——
// 规则：首次互动即【落座并锁死本局】——评论1/2按方向、其余(礼物/点赞/666)随机定边；
// 之后该用户【任何】互动都归这一队、本局内永不改(再喊别的队也不换)。
// 开局 clearSides() 清空 → 下一局重新拉队。匿名无身份 → 每次随机、不锁。
// 这是「随机落座与1/2选队地位相同、一旦落座不得修改」的服务端唯一真源(替代会覆盖的 setSide)。
// ★2026-08-03 改（用户报「弹幕扣1去了2」）：显式意愿可以改队，隐式落座才锁死。
//   原来 prefer 参数被整个忽略 —— 观众只要在扣「1」之前点过一次赞，就已被 hashSide 随机落座，
//   之后再明确扣「1」只会被退回原队。表现就是「我明明扣了1，却被分到小美队」。
//   现在分两类：
//     · 隐式落座（礼物/点赞/666）→ 一旦落座本局不再变（防同一个人来回横跳刷两边推力）
//     · 显式意愿（评论1/2 · 原生选队 · 小摇杆选队）→ 允许改队，观众说了算
//   ⚠ explicit 只能由「观众主动指定阵营」的入口传 true。礼物/点赞传的是 DEFAULT_SIDE，
//     那不是意愿、是兜底，绝不能当显式——否则 DEFAULT_SIDE 一配就把所有人反复拽到同一边。
function lockSide(openid, prefer, explicit) {
  const chosen = chosenSide(openid);
  const wants = (prefer === 'left' || prefer === 'right');
  if (chosen && !(explicit && wants)) return chosen;           // 已落座且非显式改队 → 归原队
  const side = (prefer === 'left' || prefer === 'right')
    ? prefer                                                  // 评论1/2/原生选队：按方向落座
    : (openid ? hashSide(openid) : randSide());               // 礼物/点赞/666：有身份哈希随机、匿名当次随机
  if (openid) setSide(openid, side);                          // 有身份才能锁(匿名无法追踪到人)
  return side;
}
// 开局清空落座记录 —— 配合「每局重新拉队」：上一局的落座不跨局残留。
function clearSides() { userSide.clear(); }

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

// —— 评论意图 ——
//  · 「1/大壮」「2/小美」严格命中 → 'left'/'right'：定向落座(可切队)
//  · 含「666」或【纯 6 串】(6/66/6666…) → 'cheer'：加油(效果同点赞,见 main.js 的 GIFT_ALIAS)
//  · 其余评论(闲聊)→ null：不落座、不下发
// ★2026-08-03 放宽（用户报「扣2没下场」）：原来是【严格相等】匹配四个词，
//   全角「２」、emoji「2️⃣」、「选2」「2号」「我选2」「2！」全部不认 → 直接丢弃、观众以为自己选了队。
//   现在先归一化再用【锚定正则】匹配：既收掉这些写法，又不会被「2333」「11月」这类误伤
//   （锚定 ^…$ 保证整条弹幕就是选队意图，不是含字就算）。
//   ⚠ 别改成 s.includes('1')：那会把「11点了」「第1名」全判成选队，是本来要避免的坑。
function normComment(content) {
  return String(content || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角数字 ２→2
    .replace(/[️⃣‍]/g, '')                                               // emoji 变体选择符 / keycap / 零宽连接
    .replace(/[\s　]+/g, '')                                                        // 空格(含全角)
    .replace(/[!！.。,，、~～?？:：;；\-—_]/g, '')                                       // 常见标点
    .toLowerCase();
}
// 前缀=可选的动词（我选/投/支持/帮/加入/pick），后缀=可选的量词（号/队/边/方/组）
const LEFT_RE = /^(?:我?选|投|支持|帮|加入|pick)?(?:1|一|大壮|左)(?:号|队|边|方|组)?$/;
const RIGHT_RE = /^(?:我?选|投|支持|帮|加入|pick)?(?:2|二|小美|右)(?:号|队|边|方|组)?$/;
function commentIntent(content) {
  const s = normComment(content);
  if (!s) return null;
  if (LEFT_RE.test(s)) return 'left';
  if (RIGHT_RE.test(s)) return 'right';
  // 「666」子串 已覆盖 666/6666…/牛666啊；再补【纯 6 串】收掉直播间同样高频的「6」「66」。
  // ⚠ 必须放在 LEFT/RIGHT 之后：那两组是严格相等匹配，'1'/'2' 不会被这条抢走。
  if (s.includes('666') || /^6+$/.test(s)) return 'cheer';
  return null;
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
      const first = !chosenSide(u.openid);                  // 落座前判断是否首次互动
      const side = lockSide(u.openid, defaultSide);          // 首次→落座并锁(随机/DEFAULT);已落座→归原队
      if (side !== 'left' && side !== 'right') return [];
      const key = giftToKey({ sec_gift_id: payload.sec_gift_id, diamond: payload.gift_value || payload.diamond });
      const count = clampInt(payload.gift_num, 1, 20);     // 连击上限 20，防刷屏
      const giftEv = { side, key, count, ...u };
      // 首次互动=正式加入(join 永久推力+入场小火箭)，再叠加本次礼物特效；之后只发礼物
      return first ? [{ side, key: 'join', count: 1, ...u }, giftEv] : [giftEv];
    }
    case 'live_like': {                                     // 点赞=氛围，不按 like_num 放大（且低概率丢包）
      const first = !chosenSide(u.openid);
      const side = lockSide(u.openid, defaultSide);          // 首次→落座并锁;已落座→归原队
      if (side !== 'left' && side !== 'right') return [];
      return [{ side, key: first ? 'join' : 'like', count: 1, ...u }];  // 首次=正式加入(join);之后=点赞氛围
    }
    case 'live_comment': {
      const intent = commentIntent(commentText(payload));
      if (intent === 'left' || intent === 'right') {         // 1/2 = 显式意愿 → 首次落座 / 已落座也允许改队
        const prev = chosenSide(u.openid);                   // 改队前在哪边（''=没落座过）
        const side = lockSide(u.openid, intent, true);        // explicit=true → 观众说了算
        const switched = !!prev && prev !== side;             // 真的换边了 → 让客户端把他的小火箭挪过去
        return [{ side, key: prev ? 'c666' : 'join', count: 1, switched, from: prev || '', ...u }];
      }
      if (intent === 'cheer') {                              // 666 → 落座锁定：首次随机落座并【加入】;已落座归原队加力
        const first = !chosenSide(u.openid);
        const side = lockSide(u.openid, defaultSide);
        return [{ side, key: first ? 'join' : 'c666', count: 1, ...u }];  // 首次→加入(永久推力);已落座→加力
      }
      return [];                                             // 其余评论(闲聊)→ 不落座、不下发
    }
    case 'team_select': {                                   // 原生选队 = 显式意愿：首次落座 / 已落座也允许改队
      const raw = sideFromTeam(payload);
      if (!raw) return [];
      const prev = chosenSide(u.openid);
      const side = lockSide(u.openid, raw, true);            // explicit=true，同评论 1/2
      const switched = !!prev && prev !== side;
      return [{ side, key: prev ? 'c666' : 'join', count: 1, switched, from: prev || '', ...u }];
    }
    default: return [];
  }
}

function clampInt(v, lo, hi) { v = parseInt(v, 10); if (!Number.isFinite(v)) v = lo; return Math.max(lo, Math.min(v, hi)); }

module.exports = { verifySign, translate, setSide, sideOf, chosenSide, lockSide, clearSides, giftToKey, GIFT_ID_TO_KEY, userOf };
