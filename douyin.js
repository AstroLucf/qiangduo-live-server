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
// ★2026-08-05 多直播间隔离：落座表改成【由调用方注入】。
//   原来是模块级单份 Map —— 几个直播间同开时，观众在 A 房站左边，进 B 房还是左边，
//   而且 A 房 clearSides() 会把 B 房的落座一起清掉。
//   现在每个房间自带一份（见 rooms.js 的 room.side），调用时作为最后一个参数传进来。
//   ⚠ 不传 = 退回下面这份模块级兜底表：本地调试、自查工具、老版本 exe 都走它，
//     行为与改造前完全一致，所以这次改造对它们零影响。
// sec_openid -> { side:'left'|'right', how:'auto'|'pick' }（兜底表）
//   how = 这个座位【是怎么来的】：
//     'auto' 系统随机给的（送礼哈希落座，观众没表过态）—— 还能被一次显式选队纠正
//     'pick' 观众自己指定的（弹幕1/2 · 原生选队 · 小摇杆）—— 本局锁死，谁也改不动
//   ★2026-08-06 从裸字符串改成对象：落座表原来只存边、存不下「怎么落的座」，
//     那正是「先扣1再扣2能换队」这个 bug 的数据结构层根因。
//   how 寄生在 value 里是刻意的 —— 两条清表路（clearSides / rooms.clearRound 的 r.side.clear()）
//   都是整表 Map.clear()，how 跟着 value 一起没，新增清理点 = 0。
//   ⚠ 别改成「另开一张 explicit 表」：那要在 rooms.blank() 建、clearRound 清、clearSides 加参数，
//     而 douyincloud.js 那条 clearSides 只传了一个参数 —— 漏它 = 主播重开 exe 后观众整局选不了队。
const userSide = new Map();
const M = (sides) => (sides instanceof Map ? sides : userSide);
// 读座位对象。裸字符串（导出的 setSide 后门写进来的旧格式）一律当 'auto' ——
// 保守方向：最坏是「还能被纠正一次」，绝不会把人永久钉死在他没选过的队。
function seatOf(openid, sides) {
  const v = openid ? M(sides).get(openid) : null;
  if (!v) return null;
  return (typeof v === 'string') ? { side: v, how: 'auto' } : v;
}
function setSide(openid, side, sides, how) {
  if (openid && (side === 'left' || side === 'right')) {
    M(sides).set(openid, { side, how: how === 'pick' ? 'pick' : 'auto' });
  }
}
// 查该用户已落座的队；没落座返回 ''(纯探测,绝不触发随机落座)
// ★返回值仍是字符串 ''|'left'|'right' —— 全服务端读落座表只有这一条路
//   （translate 的三个只读门禁、sideOf、userTeam 的 queryUserGroup 都走它），
//   保住它的返回类型 = 下游零改动。
function chosenSide(openid, sides) { const s = seatOf(openid, sides); return (s && s.side) || ''; }
// 给一次互动定边：主动选过 → 那边；否则 DEFAULT_SIDE 指定 left/right → 固定；否则「随机落座」(哈希,没选队也参与、不丢弃)
function sideOf(openid, fallback, sides) {
  const chosen = chosenSide(openid, sides);
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
// —— 落座锁定 ——
// 【现行规则·2026-08-06】
//   · 观众【自己指定】的队（弹幕1/2 · 原生选队 · 小摇杆）→ 落座即【锁死本局】，之后谁也改不动。
//   · 仅剩的一条隐式落座（送礼哈希随机）→ 还能被【一次】显式选队纠正，纠正完随即升级为锁死。
//   · 已锁死的人再喊 1/2 → 不换队，但照常给【原队】加力（translate 产出 c666，不是丢弃）。
//   开局 clearSides() 清空 → 下一局重新拉队。匿名无身份 → 每次随机、不锁。
//   这是落座锁的服务端唯一真源（替代会直接覆盖的 setSide）。
//
// 【三次翻转的由来·别再来回改】
//   2026-06-29 ec6c1f3：真机吐槽「喊1选左后喊2切不到右」→ 一度放开。
//   2026-06-30 42b3bd5：次日推翻，定为「首次即定队、本局锁死不换」（防来回横跳刷两边推力）。
//   2026-08-03 f30f47f：用户报「弹幕扣1去了2」→ 开了「显式意愿可改队」的口子。
//     当时的真根因是：点赞会隐式随机落座，观众点过赞再扣「1」只会被退回原队。
//   2026-08-05 7f65a46：点赞和 666 改成「只读不写」，不再落座 —— ★上面那个根因就此消失★，
//     但「显式可改队」留着没收，副作用是「先扣1再扣2能换队」，而且触发面远不止 1/2：
//     LEFT_RE/RIGHT_RE 匹配面很宽，一句「帮小美」就能把人从大壮队拽走。
//   2026-08-06（本次）：收掉那个口子 —— 恢复 06-30 的决定，只保留「隐式→显式一次纠正」。
//     ⚠ 那一次纠正【必须保留】：hashSide 是确定性哈希，同一 openid 每局落同一边，
//       而点赞/666 已不能落座 —— 全禁的话，只靠送礼的观众会每一局都被钉在没选过的队、
//       毫无自救手段，最后错的是 ledger 按胜负方分钱。
//
// ⚠ explicit 只能由「观众主动指定阵营」的入口传 true。礼物传的是 DEFAULT_SIDE，
//   那不是意愿、是兜底，绝不能当显式——否则 DEFAULT_SIDE 一配就把所有人反复拽到同一边。
//   本函数【复用现有的 explicit 参数】推导 how，签名刻意不动：四条注入路
//   （douyin.js 的 live_gift/live_comment/team_select + userTeam.js 的小摇杆）一行都不用改，
//   漏改机会 = 0。
function lockSide(openid, prefer, explicit, sides) {
  const seat = seatOf(openid, sides);
  const wants = (prefer === 'left' || prefer === 'right');
  // ★唯一允许改边的情形：座位是系统随机给的(how==='auto') 且 观众这次明确指定了队。
  //   已经是 'pick' 的 → 无条件归原队，这就是「先扣1再扣2不换」。
  if (seat && !(explicit && wants && seat.how === 'auto')) return seat.side;
  const side = wants
    ? prefer                                                  // 评论1/2/原生选队/小摇杆：按方向落座
    : (openid ? hashSide(openid) : randSide());               // 送礼：有身份哈希随机、匿名当次随机
  // 显式指定 → 记 'pick' 并锁死。★同边也升级★：送礼恰好落对队、观众再扣「1」确认，
  //   同样要升级成 pick —— 否则他之后还能扣「2」换走，bug 原样复发。
  if (openid) setSide(openid, side, sides, (explicit && wants) ? 'pick' : 'auto');
  return side;
}
// 开局清空落座记录 —— 配合「每局重新拉队」：上一局的落座不跨局残留。
// ⚠ 只清【传进来的那一份】：不传才清兜底表。多房时清 A 房绝不能碰 B 房。
function clearSides(sides) { M(sides).clear(); }

// ── 加入粉丝团（2026-08-05）──────────────────────────────────────────
// 为什么做粉丝团而不是「关注」：关注事件我们【拿不到】——task/start 的 msg_type 是封闭四值
// (live_comment/live_gift/live_like/live_fansclub)，服务端 OpenAPI 没有关注查询，
// 我们的 Electron exe 也没有 tt.* runtime；而且《直播小玩法基础规范》「滥用关注行为」第2类
// （诱导关注后无需更深度操作即获虚拟奖品）是四级违规。粉丝团是平台唯一给了设计规范的同类能力。
// 门禁天然更强：推送里【没有退团事件】，退团花的灯牌钱不退、重加要再花一次。
const fansSeenFallback = new Set();      // 不传 fans 时的兜底（本地调试/自查工具/老调用）
const fansPendFallback = new Map();
const FSEEN = (f) => (f && f.seen instanceof Set ? f.seen : fansSeenFallback);
const FPEND = (f) => (f && f.pending instanceof Map ? f.pending : fansPendFallback);
// 对局是否进行中。★缺省 true★：不传 fans 的老调用/本地调试/自查工具行为不变。
const FACTIVE = (f) => (f && 'active' in f ? !!f.active : true);
const FANS_PENDING_MAX = 50;             // 挂起上限：防异常刷量把内存撑大

// 产出一条加团表现，并【消耗掉】他这一场的唯一名额。已发过 → null。
function fanJoinEv(u, side, fans) {
  const seen = FSEEN(fans);
  if (!u.openid || seen.has(u.openid)) return null;
  seen.add(u.openid);
  return { side, key: 'fanjoin', count: 1, ...u };
}
// 他加团时还没下场 → 当时挂起了一条；现在他落座了，把那条补上。
// ★挂在「产出 join 的那几个分支」上，而不是在 index.js 里做：/cb/* 和内网专线
//   liveDataCallback 是两条注入路，写在 translate 里两条都覆盖（震动特效那次就是只改了一条）。
function flushPendingFan(evs, u, side, fans) {
  if (!FACTIVE(fans)) return evs;          // 还没开局 / 正在结算 → 继续挂着，别在客户端会丢弃的时刻发
  const pend = FPEND(fans);
  if (!u.openid || !pend.has(u.openid)) return evs;
  pend.delete(u.openid);
  const ev = fanJoinEv(u, side, fans);
  return ev ? evs.concat([ev]) : evs;
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
// ★sides = 该直播间自己的落座表（rooms.js 的 room.side）。不传 → 用模块级兜底表（本地/自查工具/老包）。
function translate(msgType, payload, defaultSide, sides, fans) {
  const u = userOf(payload);
  switch (msgType) {
    case 'live_gift': {
      const first = !chosenSide(u.openid, sides);            // 落座前判断是否首次互动
      const side = lockSide(u.openid, defaultSide, false, sides);   // 首次→落座并锁(随机/DEFAULT);已落座→归原队
      if (side !== 'left' && side !== 'right') return [];
      const key = giftToKey({ sec_gift_id: payload.sec_gift_id, diamond: payload.gift_value || payload.diamond });
      const count = clampInt(payload.gift_num, 1, 20);     // 连击上限 20，防刷屏
      const giftEv = { side, key, count, ...u };
      // 首次互动=正式加入(join 永久推力+入场小火箭)，再叠加本次礼物特效；之后只发礼物
      const evs = first ? [{ side, key: 'join', count: 1, ...u }, giftEv] : [giftEv];
      return first ? flushPendingFan(evs, u, side, fans) : evs;   // 之前加过团但没下场 → 现在补发
    }
    case 'live_like': {
      // ★2026-08-05 用户定：点赞【不再下场】★
      //   原来首次点赞会 lockSide 随机落座并发 join（永久推力+入场小火箭）——
      //   于是路人随手一个赞就被拽进某一队、场上多一枚火箭，观众自己都不知道自己下了场。
      //   现在只 chosenSide【读】已落座的队，不写：没下过场的人点赞 → 0 事件，不落座、不计分、不出火箭。
      //   ⚠ 用 chosenSide 不是 lockSide —— lockSide 会写落座表，那正是"下场"本身。
      const side = chosenSide(u.openid, sides);
      if (side !== 'left' && side !== 'right') return [];   // 没下场 → 这个赞不进游戏
      // ★2026-08-04 起按【真实点赞数】下发（原来无条件 count:1，把平台报的 like_num 整个丢掉了）。
      //   客户端已改成「屏幕容量固定 + 0.5s 环形桶配额」渲染：来 10 个还是 1000 个，
      //   同屏恒定 LIKE.cap 个、流速恒定 —— 所以放开数量【不会】变成更多 DOM/解码器。
      //   ⚠ 光改这里不够：ledger.record() 原本【完全无视 count】，只在 [push] 日志里打出来，
      //     所以 count=30 和 count=1 记的分一模一样。2026-08-04 已同步改 record()
      //     按 count 计分（仅免费互动；付费礼物连击维持只记一次）。改动量要两边一起看。
      //   上限 30 是防单次回调异常值，不是防刷屏；客户端 liveBridge 视觉回放另有 20 的上限，
      //   两者不必相等 —— 积分以服务端为准，回放上限只影响推力/特效。
      const n = clampInt(payload.like_num, 1, 30);
      return [{ side, key: 'like', count: n, ...u }];
    }
    case 'live_comment': {
      const intent = commentIntent(commentText(payload));
      if (intent === 'left' || intent === 'right') {         // 1/2 = 显式意愿 → 首次落座 / 已落座也允许改队
        const prev = chosenSide(u.openid, sides);             // 改队前在哪边（''=没落座过）
        const side = lockSide(u.openid, intent, true, sides); // explicit=true → 观众说了算
        const switched = !!prev && prev !== side;             // 真的换边了 → 让客户端把他的小火箭挪过去
        const evs = [{ side, key: prev ? 'c666' : 'join', count: 1, switched, from: prev || '', ...u }];
        return prev ? evs : flushPendingFan(evs, u, side, fans);   // 首次落座 → 补发挂起的加团表现
      }
      if (intent === 'cheer') {
        // ★2026-08-05 用户定：除 1/2 以外的弹幕【一律不下场】★（666/6/66 同点赞处理）
        //   与点赞同一条理由：喊个 666 不等于表态选队，不该被随机拽进某一队。
        //   已下场的人喊 666 照常归原队加力；没下场的 → 0 事件。
        const side = chosenSide(u.openid, sides);
        if (side !== 'left' && side !== 'right') return [];
        return [{ side, key: 'c666', count: 1, ...u }];
      }
      return [];                                             // 其余评论(闲聊)→ 不落座、不下发
    }
    // ★加入粉丝团 → 一条甜甜圈级别的【纯视觉】表现（零积分、零推力、不进积分池）★
    case 'live_fansclub': {
      // L0 只认加团。fansclub_reason_type：1=升级、2=加团。
      //   ⚠ 升级可以【反复发生】（等级能一直升），接了它就等于自己开了一条无限发放通道。
      //     字段取不到也丢 —— 宁可不播，也绝不能把升级当加团。真机字段名以 [cb] raw 日志为准。
      const reason = Number(payload.fansclub_reason_type ?? payload.reason_type ?? payload.fansclubReasonType);
      if (reason !== 2) return [];
      // L1 无身份无法门禁，直接丢（同 ledger.record 对匿名的处理）
      if (!u.openid) return [];
      // L3 一人一场只发一次。★先判重再判别的★——平台明说 msg_id 可能重复推、fail_data 回查
      //    还会重放，那些重复的 openid 一定已经在 fansSeen 里，openid 级门禁天然全吞掉，
      //    不需要再建一张 msg_id 表。
      if (FSEEN(fans).has(u.openid)) return [];
      // L2 只读落座表定边，【绝不 lockSide】：加团不是选队表态，写落座表等于把人拽下场，
      //    与 2026-08-05 定的「点赞/666 不下场」同一条纪律。
      const side = chosenSide(u.openid, sides);
      // 两种情况都先挂起、★不消耗名额★，等他（下一局）首次落座时由 flushPendingFan 补发：
      //   ① 还没下场 —— 没有队，甜甜圈横幅不知道该出在哪一边；
      //   ② 主播还没点开始 / 正在结算 —— 客户端此时会整体丢弃视觉（liveBridge 开局门控 +
      //      main.js 的 roundLive 门禁），这会儿发了他一眼都看不到，名额却白白烧掉。
      if (!FACTIVE(fans) || (side !== 'left' && side !== 'right')) {
        const pend = FPEND(fans);
        if (pend.size < FANS_PENDING_MAX) pend.set(u.openid, u);
        return [];
      }
      const ev = fanJoinEv(u, side, fans);
      return ev ? [ev] : [];
    }
    case 'team_select': {                                   // 原生选队 = 显式意愿：首次落座 / 已落座也允许改队
      const raw = sideFromTeam(payload);
      if (!raw) return [];
      const prev = chosenSide(u.openid, sides);
      const side = lockSide(u.openid, raw, true, sides);    // explicit=true，同评论 1/2
      const switched = !!prev && prev !== side;
      const evs = [{ side, key: prev ? 'c666' : 'join', count: 1, switched, from: prev || '', ...u }];
      return prev ? evs : flushPendingFan(evs, u, side, fans);
    }
    default: return [];
  }
}

function clampInt(v, lo, hi) { v = parseInt(v, 10); if (!Number.isFinite(v)) v = lo; return Math.max(lo, Math.min(v, hi)); }

module.exports = { verifySign, translate, setSide, sideOf, chosenSide, lockSide, clearSides, giftToKey, GIFT_ID_TO_KEY, userOf };
