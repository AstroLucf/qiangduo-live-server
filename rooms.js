// ============================================================
//  server/rooms.js · 直播间隔离（一个主播 = 一个房间）
//  ------------------------------------------------------------
//  2026-08-05 加。起因：几个直播间同时开播时，A 房刷的礼物特效出现在所有房间，
//  而且【积分池、落座、结算也全在串】—— 服务端此前所有对局态都是进程级全局单份：
//    clients / eventSeq / recentEvents / roundPool / roundActive / userSide / enteredThisRound
//  特效串场只是最显眼的症状，钱串场才是致命的（A 房刷的钱被 B 房的人分走）。
//
//  ★房间的键是【主播 openid(anchor)】，不是 roomId ★
//    用户 2026-08-05 定：「所有的状态需要跟着主播走」。
//    roomId 每次开播都变，anchor 不变 —— 用 roomId 当键的话，主播重开一场底池就丢了。
//    抖音回调只带 roomId，所以要维护 roomId→anchor 索引（/start_game 时建立）。
//
//  ★什么放这里、什么不放★
//    放这里 = 【本房本局】的：SSE 连接、事件缓冲、积分池、落座、入场去重、局内分。
//    不放这里 = 【跨房累计】的：total/week/month/streak —— 那是世界榜口径，
//      本来就该全平台共享一份，留在 ledger.js 的全局账本里。
//    这两类此前混在同一个 Map 里，正是钱串场的根。
// ============================================================
'use strict';

const kv = require('./kv');            // 只用来落 roomId→anchor 索引，见 bindRoomId 的注释
const RID_KEY = 'qd:rid';              // Redis hash：field=roomId, value={a:anchor, t:写入时间}
const RID_TTL_MS = 7 * 24 * 3600 * 1000;   // 索引保留 7 天：一场直播的 roomId 活不了这么久，过期即清

const GC_MS = 5 * 60 * 60 * 1000;      // 空房回收：5 小时无活动（用户 2026-08-05 定）。底池已落盘，回收不丢钱。
const REPLAY_MAX = 256;                // 每房各自的断点续传环形缓冲（原来是全局一份，多房会互相挤掉）

const rooms = new Map();               // anchor -> Room
const byRoomId = new Map();            // roomId -> anchor（抖音回调只带 roomId）
const byToken = new Map();             // 启动 token -> anchor（SSE 建连只带 token）
// ★老包兜底（2026-08-05 修「积分池乱跳」）★
//   1.1.21 及更早的 exe 渲染层【不带 token】连 SSE。多房隔离上线后，这类连接只能退到
//   「最近一次开局的主播」——而服务端每 50s 主动掐断 SSE 让客户端重连，几个主播同开时
//   老包每重连一次就可能被换进另一个主播的房，积分池在几千/几万/十几万之间来回跳。
//   （实测：同一个老包客户端重连前后，收到的池值从 200000 变成 7000。）
//   用【来源地址】兜：同一台 exe 的 /start_game(主进程) 和 /events(渲染层) 出口 IP 相同，
//   比「全局最近开局」精确得多。⚠ 仍是启发式：同一出口 IP 的两个主播（同一工作室/CGNAT）
//   还是会撞。真正的解法是出新包带 token，这里只是让老包不至于乱跳。
const byAddr = new Map();              // 来源地址 -> anchor
// ★房间标签：编进 SSE 的 event id（`<tag>.<seq>`）★
//   老包重连时浏览器会把上一条 id 原样带回来（Last-Event-ID 头 / ?lastEventId=），
//   服务端据此就能认出「这条连接上次在哪个房」—— 不需要改客户端，是老包唯一确定性的身份来源。
//   （1.1.21 的 liveBridge 把 lastId 当字符串存、encodeURIComponent 带回，复合 id 能原样往返。）
const byTag = new Map();               // tag -> anchor
function tagOf(anchor) {
  const a = String(anchor || '');
  let h = 5381;
  for (let i = 0; i < a.length; i++) h = ((h * 33) ^ a.charCodeAt(i)) >>> 0;
  // 撞了就往后加序号，绝不让两个主播共用一个 tag —— 共用意味着把人送进别人的房。
  const base = h.toString(36);
  let t = base, n = 0;
  while (byTag.has(t) && byTag.get(t) !== a) { n++; t = base + '-' + n; }
  byTag.set(t, a);
  return t;
}
const anchorOfTag = (tag) => byTag.get(String(tag || '')) || '';

// 没有 anchor 时的兜底房：老版本 exe 不带 token、本地调试、自查工具都会落这里。
// 它们之间仍会互相串，但【不会污染真实主播的房间】—— 这是过渡期的隔离底线。
const DEFAULT_ANCHOR = '__default__';

function blank(anchor) {
  return {
    anchor,
    roomId: '',
    clients: new Set(),                // 该房的 SSE 连接
    eventSeq: 0,                       // 每房独立编号：客户端的 Last-Event-ID 是按房续传的
    recent: [],                        // [{seq, frame}]
    active: false,                     // 主播点了「开始」才计分
    pool: 0,                           // 本局积分池（含上一局结转来的底池）
    poolOpen: false,                   // 本局是否还没结转
    poolLoaded: false,                 // 底池是否已从存档成功读回；false 时禁止落盘（见 ledger.savePool）
    // exe（重新）启动过 → 下一次 /round/start 当【真开新局】处理（重读底池 + 清落座 + 清本局账）。
    // ⚠ 显式初始化成 false，别留 undefined：/round/start 的 freshRound 判据要拿它算，
    //   undefined 会让 `!room.active || room.needReload` 整体算成 undefined。
    needReload: false,
    // 落座锁（每局清）。value 是对象不是字符串：{ side:'left'|'right', how:'auto'|'pick' }
    //   how='auto' 系统随机给的(送礼哈希) → 还能被一次显式选队纠正
    //   how='pick' 观众自己指定的(弹幕1/2·原生选队·小摇杆) → 本局锁死
    // ⚠ how 寄生在 value 里是刻意的：clearRound 的 r.side.clear() 与 douyin.clearSides()
    //   都是整表 clear，how 跟着一起没。【别另开一张 explicit 表】——那要在这里建、
    //   在 clearRound 清、还要给 clearSides 加参数，而 douyincloud.js 那条只传了一个参数。
    side: new Map(),
    entered: new Set(),                // 本局已播过入场视频的 openId
    seen: new Set(),                   // 本局出现过的 openId（判首次）
    cooldown: new Map(),               // openId -> ts  入场视频跨局去抖
    // ── 加入粉丝团（2026-08-05）──
    // ★这两个【不随 clearRound 清】★ 语义是「这个主播这一场直播里，每人只播一次」，
    //   和同一个函数里被清的 side/entered/seen 行为相反 —— 清了就等于每开一局能再刷一次。
    //   跟着房间(主播 openid)走，所以观众在 A 主播房领过，去 B 主播房加 B 的团照样会播。
    fansSeen: new Set(),               // 本场已播过加团表现的 openId
    fansPending: new Map(),            // 加团时还没下场的人 openId -> user，等他落座再补发
    local: new Map(),                  // openId -> {fresh, round, likes, gifts, side}  局内账
    lastSeen: Date.now(),
    tag: '',                           // SSE event id 前缀，见 byTag 注释；在 get() 里补上
  };
}

function get(anchor) {
  const a = String(anchor || '').trim() || DEFAULT_ANCHOR;
  let r = rooms.get(a);
  if (!r) { r = blank(a); r.tag = tagOf(a); rooms.set(a, r); }
  r.lastSeen = Date.now();
  return r;
}

// ── 索引：把回调/连接认领到某个房 ──
// ★2026-08-07：roomId→anchor 这张索引【必须落盘】★
//   它是全服唯一一条「丢了就无法自愈」的状态：
//     · 抖音回调只带 roomId，认不出 anchor 就落兜底房（index.js 的 roomOfCb 没有第三级）；
//     · 而主播端只在 exe 启动那一刻发一次 /start_game（electron-main.js:150），
//       WS 重连、SSE 重连都【不会】重发 —— 服务端重启后没有任何路径会重建它。
//   抖音云 prod 实例会频繁回收，于是回收之后所有还在播的主播【全部塌进同一个兜底房】：
//   甲直播间观众刷的钱进共用底池、结算时分给乙直播间的观众，savePool 也只往兜底那格写。
//   本地实测（索引缺失态）：两个 roomId 的观众落进同一个 __default__，players=2、共用一个 pool。
//   ⚠ 只落这一张【小索引】，不要落落座表本身：
//     落座表高频写、量大，且丢了观众重喊一次 1/2 就补回来了；
//     这张索引每场直播只写一次，零高频开销，却挡住唯一一条会「钱串场」的路。
function bindRoomId(roomId, anchor) {
  if (!roomId) return;
  const a = String(anchor || '').trim() || DEFAULT_ANCHOR;
  byRoomId.set(String(roomId), a);
  // 兜底房不落盘：它本来就是「认不出主播」的收容所，存了反而会把错误固化下来
  if (a !== DEFAULT_ANCHOR) {
    kv.hset(RID_KEY, [String(roomId), JSON.stringify({ a, t: Date.now() })]).catch(() => {});
  }
}
// 启动时把索引读回来。与 pool.js 同节奏（延迟 800ms 等 kv 连上）。
// ⚠ 只补【内存里还没有的】：正在跑的绑定优先，绝不用旧存档覆盖当前这一场。
async function hydrateRid() {
  if (!kv.enabled) return;
  const h = await kv.hgetall(RID_KEY);
  if (!h) { console.log('[rooms] roomId 索引读取失败（Redis 未就绪？）→ 本次不恢复，回调会先落兜底房'); return; }
  const now = Date.now();
  const stale = [];
  let n = 0;
  for (const rid in h) {
    try {
      const v = JSON.parse(h[rid]);
      if (!v || !v.a) { stale.push(rid); continue; }
      if (now - (v.t || 0) > RID_TTL_MS) { stale.push(rid); continue; }   // 过期：一场直播的 roomId 活不了这么久
      if (!byRoomId.has(rid)) { byRoomId.set(rid, v.a); n++; }
    } catch (_) { stale.push(rid); }
  }
  if (stale.length) kv.hdel(RID_KEY, stale).catch(() => {});
  console.log(`[rooms] roomId→主播 索引已恢复 ${n} 条` + (stale.length ? `（顺带清理过期/损坏 ${stale.length} 条）` : ''));
}
const _ridBoot = setTimeout(() => { hydrateRid().catch(() => {}); }, 800);
if (_ridBoot.unref) _ridBoot.unref();
function bindToken(token, anchor) {
  if (!token) return;
  byToken.set(String(token), String(anchor || '').trim() || DEFAULT_ANCHOR);
}
function bindAddr(addr, anchor) {
  if (!addr) return;
  byAddr.set(String(addr), String(anchor || '').trim() || DEFAULT_ANCHOR);
}
const anchorOfAddr = (addr) => byAddr.get(String(addr || '')) || '';
// 回调进来：只有 roomId → 找主播。找不到（服务端重启过、exe 还没 /start_game）落兜底房。
// ⚠ 落兜底房不是"丢弃"：宁可先记着，也别让观众的钱凭空消失；主播重连后新数据会进正确的房。
function byRoom(roomId) {
  const a = byRoomId.get(String(roomId || ''));
  return get(a || DEFAULT_ANCHOR);
}
// SSE 建连：只有 token → 找主播。
function byTok(token) {
  const a = byToken.get(String(token || ''));
  return get(a || DEFAULT_ANCHOR);
}
const anchorOfRoomId = (roomId) => byRoomId.get(String(roomId || '')) || '';
const anchorOfToken = (token) => byToken.get(String(token || '')) || '';

// ── 局内账（本房本局，不跨房）──
function local(r, openId) {
  let u = r.local.get(openId);
  if (!u) { u = { fresh: 0, round: 0, likes: 0, gifts: 0, side: null }; r.local.set(openId, u); }
  return u;
}
function clearRound(r) {                 // 开新局：清局内，不动积分池（底池要留）
  r.local.forEach((u) => { u.fresh = 0; u.likes = 0; u.gifts = 0; u.side = null; });
  r.side.clear(); r.entered.clear(); r.seen.clear();
  // ⚠ 故意不清 fansSeen / fansPending：加团是「一场直播一次」，不是「一局一次」。
  //   清了的话主播开一局观众就能再看一次表现，门禁形同虚设（退团重加要再花钱，但表现不该重复）。
}

// ── SSE ──
function addClient(r, res) { r.clients.add(res); }
function delClient(r, res) { r.clients.delete(res); }

// 只发本房。返回实际送达的连接数（0 = 主播没连着，正常，别当错误）。
function push(r, events) {
  if (!events || !events.length) return 0;
  const seq = ++r.eventSeq;
  const frame = `id: ${r.tag}.${seq}\ndata: ${JSON.stringify(events)}\n\n`;   // 带房间标签：老包重连靠它认房
  r.recent.push({ seq, frame });
  if (r.recent.length > REPLAY_MAX) r.recent.shift();
  let n = 0;
  for (const res of r.clients) { try { res.write(frame); n++; } catch (_) {} }
  r.lastSeen = Date.now();
  return n;
}
// 断点续传：只补本房漏掉的（原来是全局缓冲，多房时会把别人的事件补给你）
function replay(r, lastId) {
  if (!(lastId > 0)) return [];
  return r.recent.filter((e) => e.seq > lastId);
}

// ── 回收 ──
// 5 小时无活动 → 丢掉房间态。底池/跨房累计分都在 Redis，回收只丢"本局"这类短命数据。
function gc(now) {
  const t = now || Date.now();
  let n = 0;
  for (const [a, r] of rooms) {
    if (a === DEFAULT_ANCHOR) continue;              // 兜底房常驻
    if (r.clients.size) { r.lastSeen = t; continue; } // 还连着就不算空
    if (t - r.lastSeen < GC_MS) continue;
    rooms.delete(a); n++;
    for (const [rid, an] of byRoomId) if (an === a) byRoomId.delete(rid);
    for (const [tk, an] of byToken) if (an === a) byToken.delete(tk);
    for (const [ad, an] of byAddr) if (an === a) byAddr.delete(ad);
    for (const [tg, an] of byTag) if (an === a) byTag.delete(tg);
  }
  if (n) console.log(`[rooms] 回收 ${n} 个空房（${GC_MS / 3600000}h 无活动）· 剩 ${rooms.size}`);
  return n;
}
const _gcT = setInterval(() => gc(), 10 * 60 * 1000);
if (_gcT.unref) _gcT.unref();

function diag() {
  return {
    count: rooms.size,
    list: [...rooms.values()].map((r) => ({
      anchor: r.anchor === DEFAULT_ANCHOR ? r.anchor : r.anchor.slice(0, 12) + '…',
      roomId: r.roomId, clients: r.clients.size, active: r.active,
      pool: r.pool, players: r.local.size, seq: r.eventSeq,
      poolLoaded: !!r.poolLoaded,
      idleMin: Math.round((Date.now() - r.lastSeen) / 60000),
    })),
  };
}

module.exports = {
  DEFAULT_ANCHOR, GC_MS,
  get, bindRoomId, bindToken, bindAddr, byRoom, byTok, anchorOfRoomId, anchorOfToken, anchorOfAddr, anchorOfTag,
  local, clearRound, addClient, delClient, push, replay, gc, diag,
  all: () => [...rooms.values()],
};
