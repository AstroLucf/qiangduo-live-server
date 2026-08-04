// ============================================================
//  server/ledger.js · 观众积分账本（服务端真源）
//  ------------------------------------------------------------
//  用户 2026-08-02 指出：积分数据不能只存在主播那台电脑的 localStorage 里 ——
//  那是「这台机器」的存储，换机/重装/清缓存就没了，也没有任何人↔分数的权威归属。
//  积分是要按名次分钱给观众的，真源必须在服务端。
//
//  和 src/score.js 的关系（★别删客户端那本账★）：
//    · 服务端 = 真源。它直接从抖音回调流计分，主播的 exe 崩了/换了都不影响。
//    · 客户端 = ① 离线引擎：index.html 不带 ?live=1 时没有 LiveBridge，
//                 纯 demo / 右侧调试台 / preview-check 全靠它，删了这些全废；
//               ② 在线时的乐观镜像：先本地加、让 HUD 立刻跳，随后被服务端快照覆盖。
//    · 冲突规则：连得上服务端 → 服务端赢（applySnapshot 直接覆盖）。
//
//  与 ranking.js 的分工：
//    ranking.js 管【上报抖音平台】的战绩（本局榜/世界榜 API），口径是平台要的 gift_value；
//    本文件管【我们自己的玩法积分】（点赞/评论/礼物统一按 gifts.js 的 pts 计），
//    是结算面板、积分池、周月榜、连胜的依据。两者维度不同，不要合并。
// ============================================================
'use strict';
const kv = require('./kv');
const G = require('./gifts');
const pool = require('./pool');

// ── 规则系数：必须与 src/score.js 顶部常量逐项一致 ──
const POOL_RATE = 1;
const TOP3_PCT = [0.40, 0.20, 0.10];
const WIN_ALL_PCT = 0.30;
const LIKE_QUALIFY = 50;
const DEFEAT_BONUS_RATE = 0.2;
const INHERIT_RATE = 0.4;
const STREAK_LOSE = 0.5;
const STREAK_SPLIT = { 1: [1], 2: [0.6, 0.4], 3: [0.5, 0.3, 0.2] };

const ACCT_KEY = 'qd:acct';       // Redis hash：field = openId，value = JSON（只存跨局字段）
const META_KEY = '__meta__';      // 同一张 hash 里借一格存周/月戳，省一个 key

const accounts = new Map();       // openId -> 账户
let roundPool = 0;                // 本局积分池 = 底池 + 本局新打
let poolOpen = false;             // 本局是否还没结转（含义同 score.js 的 roundOpen）
let roundActive = false;          // 主播点了「开始」才计分：客户端在开始界面会丢弃所有事件，
                                  // 服务端不跟着门控就会比客户端多记一批（观众在封面期间的互动）
let anchor = '';                  // 当前主播 openid（底池按他存）
let hydrated = false;

function log(...a) { console.log('[ledger]', ...a); }
const weekKey = (d) => { d = d || new Date(); const t = new Date(d); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate(); };
const monthKey = (d) => { d = d || new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1); };

// ⚠ streak 和 winStreak 是两个东西，别合并：
//   streak    = 玩法的【连胜池分】——败方各失 50% 汇池、胜方前 3 按 50/30/20 瓜分，是可转移的分数；
//   winStreak = 平台要的【连胜次数】——赢一局 +1、输/平清零，上报 winning_streak_count 用。
//   旧代码里 ranking.js 自己维护后者、score.js 维护前者，两边都叫 streak，是混淆的源头。
function blank(openId) {
  return { openid: openId, name: '', avatar: '', total: 0, week: 0, month: 0, streak: 0, winStreak: 0, round: 0, fresh: 0, likes: 0, gifts: 0, side: null };
}
function acct(openId) {
  let a = accounts.get(openId);
  if (!a) { a = blank(openId); accounts.set(openId, a); }
  return a;
}

// ── 持久化 ──（只存跨局字段；fresh/likes/gifts/side 是局内的，丢了无所谓）
const _dirty = new Set();
let _flushT = null;
function markDirty(id) {
  if (!kv.enabled) return;
  _dirty.add(id);
  if (_flushT) return;
  // 攒 2s 批量写：礼物风暴一秒几十次，逐次写纯浪费（同 ranking.js 的做法）
  _flushT = setTimeout(() => { _flushT = null; flush().catch(() => {}); }, 2000);
  if (_flushT.unref) _flushT.unref();
}
function packed(a) { return JSON.stringify({ n: a.name, a: a.avatar, t: a.total, w: a.week, m: a.month, s: a.streak, ws: a.winStreak, r: a.round }); }
async function flush() {
  if (!kv.enabled || !_dirty.size) return;
  const ids = [..._dirty]; _dirty.clear();
  const pairs = [];
  for (const id of ids) { const a = accounts.get(id); if (a) pairs.push(id, packed(a)); }
  const gone = ids.filter((id) => !accounts.has(id));
  if (pairs.length) await kv.hset(ACCT_KEY, pairs);
  if (gone.length) await kv.hdel(ACCT_KEY, gone);
}

async function hydrate() {
  if (!kv.enabled) { hydrated = true; return; }
  const h = await kv.hgetall(ACCT_KEY);
  // 读不到就别置 hydrated —— 报 ready:false 让客户端退回本地，绝不能拿空表覆盖主播的账
  if (!h) { log('账本读取失败（Redis 未就绪？）→ 保持 ready:false'); return; }
  let meta = {};
  try { meta = JSON.parse(h[META_KEY] || '{}'); } catch (_) {}
  const wk = weekKey(), mk = monthKey();
  const wReset = meta.wk && meta.wk !== wk;      // 周榜每周一切
  const mReset = meta.mk && meta.mk !== mk;      // 月榜 + 连胜榜每月 1 号切
  let n = 0;
  for (const id in h) {
    if (id === META_KEY) continue;
    try {
      const v = JSON.parse(h[id]);
      const a = blank(id);
      a.name = v.n || ''; a.avatar = v.a || '';
      a.total = +v.t || 0; a.week = wReset ? 0 : (+v.w || 0);
      a.month = mReset ? 0 : (+v.m || 0); a.streak = mReset ? 0 : (+v.s || 0);
      a.winStreak = mReset ? 0 : (+v.ws || 0);      // 连胜次数与连胜池同周期（月）重置
      a.round = +v.r || 0;
      accounts.set(id, a); n++;
    } catch (_) {}
  }
  hydrated = true;
  log(`账本已从持久化恢复 ${n} 人` + (wReset ? ' · 周榜已重置' : '') + (mReset ? ' · 月榜/连胜已重置' : ''));
  const migrated = await migrateUnit(meta, n);    // 票 → 分（只跑一次，见下）
  // ⚠ 顺序不能反：必须【先 flush 落盘、后 stampMeta 打标记】。
  //   反过来的话，一旦 flush 失败（Redis 抖动/超时），META 已经写着 unit:'score'，
  //   而账本数据还是旧口径 —— 下次启动看到标记就跳过迁移，那批数据【永远】停在票口径，
  //   而且再没有任何机会补救。先落盘再打标记：flush 失败就不打标记，下次启动重试。
  if (wReset || mReset || migrated) { accounts.forEach((_, id) => _dirty.add(id)); await flush(); await stampMeta(); }
  else await stampMeta();
}
// ★存量单位迁移：票 → 分（2026-08-03 一次性）★
//   2026-08-03 之前账本按"票"记账（仙女棒=1、药丸=10…），展示层再 ×1000 变成分；
//   现在内部直接存分，存量必须整体 ×1000 才能和新数据同量纲，否则老用户的分会显得只有新用户的千分之一。
//   ★用 META 里的 unit 字段做幂等标记 —— 重启/重新部署/多次 hydrate 都只会乘一次。
//   ⚠ 不清账本是用户的明确决定：历史上点赞曾按 10 票(=1万分)记，那批虚高会被等比放大，属已知取舍。
//   ⚠ dev 和 prod 各有独立 Redis，各自迁一次；部署后在日志里找 [ledger] 单位迁移 那行确认。
//   ★底池不在这里迁★ —— 它是按主播 openid 分别存的、由 loadPool 在 /start_game 之后才读，
//     晚于 hydrate。在这里迁只会迁到一个还没载入的 0，随后被读回的旧值原样覆盖。
//     底池的迁移跟着记录走，在 pool.js 的 get() 里读一条迁一条（同样带 unit 标记，幂等）。
const UNIT_TAG = 'score';                        // 当前单位标记；换单位时改这个值即可再触发一次迁移
async function migrateUnit(meta, n) {
  if (!kv.enabled) return false;
  if (meta.unit === UNIT_TAG) return false;      // 已迁过 → 跳过
  const K = G.LEGACY_VOTE_TO_SCORE;              // 1000
  accounts.forEach((a) => {
    ['total', 'week', 'month', 'round', 'fresh', 'streak'].forEach((f) => {
      a[f] = Math.round((+a[f] || 0) * K);
    });
  });
  log(`单位迁移 票→分 ×${K}：${n} 人已换算（底池由 pool.js 各自迁）`);
  return true;
}
async function stampMeta() {
  if (!kv.enabled) return;
  await kv.hset(ACCT_KEY, [META_KEY, JSON.stringify({ wk: weekKey(), mk: monthKey(), unit: UNIT_TAG })]);
}
let _hydrating = null;
function ready() {
  if (hydrated) return Promise.resolve();
  if (!_hydrating) _hydrating = hydrate().catch(() => {}).then(() => { _hydrating = null; });
  return _hydrating;
}
const _boot = setTimeout(() => { hydrate().catch(() => {}); }, 800);
if (_boot.unref) _boot.unref();

// ── 计分：每条翻译好的事件调一次（不是每个 count 调一次，与客户端「连击只第一次计分」对齐）──
function record(ev) {
  if (!roundActive) return 0;                       // 主播还没点开始 → 客户端也丢弃，两边一致
  const id = ev && ev.openid;
  if (!id) return 0;                                // 匿名互动无法归属到人，不进账本（客户端同理只做视觉）
  const unit = G.ptsOf(ev.key);
  if (!unit) return 0;
  // ★count 只对【免费互动】生效（2026-08-04）：
  //   · 点赞：douyin.js 按平台报的 like_num 下发 count，而 gifts.js 的设计口径是
  //     「100 次点赞 = 一根仙女棒」—— 不按次数记，观众点一万下也只算一次，那条口径直接不成立。
  //   · 付费礼物：连击(gift_num)【维持只记一次】，这是既有的防灌爆奖励池决策，别顺手改掉；
  //     要改是产品口径变更，得单独拍板。
  //   ⚠ 本函数此前完全无视 count（只在 [push] 日志里打出来），douyin.js 那边却按"多出来的会进积分"
  //     写了注释 —— 两边对不上。现在以本函数为准。
  const n = G.isPaid(ev.key) ? 1 : Math.max(1, Math.min(parseInt(ev.count, 10) || 1, 30));
  const pts = unit * n;
  const a = acct(id);
  if (ev.nickname) a.name = ev.nickname;            // 昵称/头像以最新一次为准
  if (ev.avatar) a.avatar = ev.avatar;
  if (!a.side && (ev.side === 'left' || ev.side === 'right')) a.side = ev.side;   // 落座锁：本局第一次定了就不改
  a.fresh += pts; a.round += pts; a.week += pts; a.month += pts; a.total += pts;
  // 计数也按真实次数走：全员分成资格是「点赞 > LIKE_QUALIFY(50)」，只 +1 的话这条门槛几乎摸不到
  if (G.isPaid(ev.key)) a.gifts += 1; else a.likes += n;
  roundPool += pts;
  poolOpen = true;
  markDirty(id);
  return pts;
}

// ── 对局生命周期 ──
function startRound(anchorOpenId) {
  if (anchorOpenId) anchor = anchorOpenId;
  roundActive = true;
  accounts.forEach((a) => { a.fresh = 0; a.likes = 0; a.gifts = 0; a.side = null; });
  savePool();
}
// 结算：完全照搬 src/score.js 的 settle()，逐条对齐（改任何一条两边一起改）
function settle(winnerSide) {
  roundActive = false;
  const players = [...accounts.values()].filter((u) => u.side);
  const winners = players.filter((u) => u.side === winnerSide).sort((a, b) => b.fresh - a.fresh);
  const losers = players.filter((u) => u.side !== winnerSide);
  const byRound = players.slice().sort((a, b) => b.fresh - a.fresh);
  const poolVal = Math.round(roundPool * POOL_RATE);
  const bonus = {};
  const add = (u, amt) => { bonus[u.openid] = (bonus[u.openid] || 0) + amt; };

  winners.slice(0, 3).forEach((u, i) => add(u, poolVal * TOP3_PCT[i]));                      // ① 胜方前 3
  const qualify = winners.filter((u) => u.gifts > 0 || u.likes > LIKE_QUALIFY);              // ② 胜方全员分成
  const perShare = qualify.length ? poolVal * WIN_ALL_PCT / qualify.length : 0;
  qualify.forEach((u) => add(u, perShare));
  const enc = new Set();                                                                     // ③ 败方进前 3 的鼓励分
  byRound.slice(0, 3).filter((u) => u.side !== winnerSide).forEach((u) => { add(u, perShare); enc.add(u.openid); });
  const loserSum = losers.reduce((s, u) => s + u.fresh, 0);                                   // ④ 击败加成
  const winnerSum = winners.reduce((s, u) => s + u.fresh, 0);
  if (loserSum > 0 && winnerSum > 0) {
    const bp = loserSum * DEFEAT_BONUS_RATE;
    winners.forEach((u) => add(u, bp * u.fresh / winnerSum));
  }
  let streakPool = 0;                                                                        // ⑤ 连胜池
  const delta = {};
  losers.forEach((u) => { const lose = Math.round(u.streak * STREAK_LOSE); u.streak -= lose; delta[u.openid] = -lose; streakPool += lose; });
  const topN = winners.slice(0, 3);
  const split = STREAK_SPLIT[Math.min(topN.length, 3)] || [];
  topN.forEach((u, i) => { const gain = Math.round(streakPool * (split[i] || 0)); u.streak += gain; delta[u.openid] = (delta[u.openid] || 0) + gain; });

  players.forEach((u) => {                                                                   // 奖励入账
    const b = Math.round(bonus[u.openid] || 0);
    u._bonus = b;
    if (b) { u.round += b; u.week += b; u.month += b; u.total += b; }
    // ⑥ 连胜【次数】（平台 winning_streak_count 用，与上面的连胜池分无关）：赢 +1，输/平清零
    u.winStreak = (winnerSide !== 'tie' && u.side === winnerSide) ? (u.winStreak || 0) + 1 : 0;
    markDirty(u.openid);
  });
  flush().catch(() => {});
  savePool();
  return {
    winnerSide, pool: poolVal, streakPool, perShare: Math.round(perShare),
    rows: byRound.map((u) => ({
      openid: u.openid, name: u.name, avatar: u.avatar,
      fresh: u.fresh, round: u.round, total: u.total, week: u.week, month: u.month, streak: u.streak,
      bonus: u._bonus || 0, streakDelta: delta[u.openid] || 0,
      win: u.side === winnerSide, enc: enc.has(u.openid),
    })),
  };
}
// 结转：积分池留 INHERIT_RATE 当下一局底池，各人 round 同比例带走
function nextRound() {
  accounts.forEach((a) => {
    a.round = Math.round(a.round * INHERIT_RATE);
    a.fresh = 0; a.likes = 0; a.gifts = 0; a.side = null;
    delete a._bonus;
    markDirty(a.openid);
  });
  roundPool = Math.round(roundPool * INHERIT_RATE);
  poolOpen = false;
  roundActive = false;
  flush().catch(() => {});
  savePool();
  return roundPool;
}

// ── 底池借用 pool.js 存（按主播 openid），启动时读回来 ──
function savePool() { pool.set(anchor, roundPool, poolOpen).catch(() => {}); }
async function loadPool(anchorOpenId) {
  if (anchorOpenId) anchor = anchorOpenId;
  await pool.ready();
  const p = pool.get(anchor);
  if (!p.ready) return roundPool;
  roundPool = p.pool;
  // 上一局没结转（主播结算面板开着就关了 exe / 崩了）→ 现在补一次，否则底池带 100% 越滚越大
  if (p.open) { roundPool = Math.round(roundPool * INHERIT_RATE); poolOpen = false; savePool(); }
  else poolOpen = false;
  return roundPool;
}

// ── 给客户端的快照 ──
// 只送用得上的人：本局参与者（fresh>0 或已落座）+ 总榜前 SNAP_TOP，避免观众上万时把 SSE 撑爆。
const SNAP_TOP = 150;
function snapshot() {
  const all = [...accounts.values()];
  const inRound = all.filter((a) => a.fresh > 0 || a.side);
  const top = all.slice().sort((x, y) => y.total - x.total).slice(0, SNAP_TOP);
  const seen = new Set(), list = [];
  for (const a of inRound.concat(top)) {
    if (seen.has(a.openid)) continue;
    seen.add(a.openid);
    list.push({ openid: a.openid, name: a.name, avatar: a.avatar, total: a.total, week: a.week, month: a.month, streak: a.streak, round: a.round, fresh: a.fresh, likes: a.likes, gifts: a.gifts, side: a.side });
  }
  return { type: 'ledger', ready: hydrated, pool: roundPool, poolOpen, active: roundActive, users: list };
}
// ── 只读排行（ranking.js 上报给抖音平台时读这里，不再自己攒一本账）──
// ⚠ 名次口径三条，别混：
//   本局榜 = fresh（本局贡献）  · 平台世界榜 = month（月榜，与 world_rank_version=month_YYYYMM 同周期）
//   入场视频档位 = total（总积分）—— 玩法里「世界榜」的定义就是总积分，结算面板那个 tab 也是它。
const RANK_CAP = 1000;   // 名次超 1000 固定报 1000（抖音端显示 999+），与 ranking.js 同口径
function ranked(metric) {
  return [...accounts.values()]
    .filter((a) => a[metric] > 0)
    .sort((x, y) => y[metric] - x[metric])
    .map((a, i) => ({ openId: a.openid, score: a[metric], side: a.side, winStreak: a.winStreak || 0, rank: Math.min(i + 1, RANK_CAP) }));
}
function roundList() { return ranked('fresh'); }
function worldList() { return ranked('month'); }
// 某人在总积分榜的名次（1-based）；不在榜返回 0。入场视频档位靠它。
function rankOfTotal(openId) {
  if (!openId) return 0;
  const a = accounts.get(openId);
  if (!a || !a.total) return 0;
  let n = 1;
  for (const o of accounts.values()) if (o.total > a.total) n++;
  return n;
}
function peek(limit) {
  return ranked('total').slice(0, Math.max(1, Math.min(+limit || 20, 150)))
    .map((u) => ({ open_id: u.openId, rank: u.rank, score: u.score }));
}

function diag() { return { accounts: accounts.size, pool: roundPool, poolOpen, active: roundActive, hydrated, anchor: anchor ? anchor.slice(0, 10) + '…' : '(未开局)' }; }
async function reset(prefix) {
  const hit = [...accounts.keys()].filter((id) => !prefix || id.startsWith(prefix));
  hit.forEach((id) => accounts.delete(id));
  if (kv.enabled && hit.length) await kv.hdel(ACCT_KEY, hit);
  return { removed: hit.length, left: accounts.size };
}

module.exports = {
  record, startRound, settle, nextRound, snapshot, loadPool, ready, diag, reset, flush, INHERIT_RATE,
  roundList, worldList, rankOfTotal, peek, size: () => accounts.size,
};
