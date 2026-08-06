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

const R = require('./rooms');
// ★2026-08-05 多直播间隔离：账本拆两层★
//   accounts（本文件）= 【跨房累计】name/avatar/total/week/month/streak/winStreak —— 世界榜口径，全平台一份。
//   room.local（rooms.js）= 【本房本局】fresh/round/likes/gifts/side + 积分池 + roundActive。
//   此前两类混在同一个 Map、且积分池/对局态是进程级全局单值 —— 几个直播间同开时，
//   A 房刷的礼物涨到 B 房的池子里、结算把别房的观众也算进来分钱。这是钱串场的根。
const accounts = new Map();       // openId -> 跨房账户
let hydrated = false;

// ★入场特效名次 = 全平台【一份】冻结榜（2026-08-05 用户定）★
//   用户原话：「榜单应该是共享的，每个主播共享的，譬如说 A 在榜单上是第 2 名，
//   那么它去到哪一个直播间都需要播放第 2 名的入场特效，而不是说第一局不播」
//   —— 所以它【不能】挂在 room 上。之前是 room.rankSnap（每个主播各存一份、各自在自己
//   settle 时刷新），同一个观众在甲房和乙房会被认成不同名次，新主播房里还谁都不播。
//   数据源 accounts 本来就是跨房全局的，拧的只是快照这一层。
//
//   刷新时机（用户选的 A 方案）：
//     · hydrate 成功后【立刻】建一份 —— 这条专治「第一局不播」：服务端一起来就有榜，
//       不用等谁打完一局。（并行会话把快照落盘到每个主播记录里也是为了治这个，
//       根因解决后那套就多余了，见 loadPool 里的说明。）
//     · 任意主播 settle 之后刷新 —— 多个主播同时在播时，谁结算都往同一本账里加自己那份，
//       不是互相覆盖，所以「A 在看排名时 B 结算了」不会打架，只是榜更新了。
//   ⚠ hydrated 之前【绝不】建榜：那时 accounts 还没从 Redis 读回来，
//     排出来的是一份残缺榜，会让本该榜一的人播成榜五十。宁可这一小会儿不播。
//
//   ★★ 档位 = 三个榜里【名次最靠前】的那个（2026-08-05 用户定）★★
//   用户原话：「哪个排名靠前，就播放哪个动画」，并给了三个例子：
//       月榜3  周榜20        → 播 3（月榜）
//       月榜20 周榜3         → 播 3（周榜）
//       总分榜2 周榜月榜都3   → 播 2（总分榜）
//   即：名次 = min(周榜名次, 月榜名次, 总分榜名次)，数值越小越靠前。
//   ⚠ 某个榜【没上榜】的人不参与那个榜的比较 —— ranked(metric) 已经把该指标 =0 的人过滤掉了，
//     所以周榜清零后（每周一）大家只靠月榜/总分榜争档位，不会被"周榜第 0 名"这种鬼值拉下去。
//   ⚠ 三个榜都没有（total=0，纯新观众）→ 查不到 → 名次 0 → 不播。这条是设计如此，
//     和「首局不播」不是一回事，别一起改掉。
const ENTRY_METRICS = ['total', 'week', 'month'];   // 参与"取最靠前"的三个榜
let worldSnap = null;
function refreshWorldSnap(why) {
  if (!hydrated) return null;                    // 账本还没读回来 → 不建（宁可不播也别播错档）
  const m = new Map();
  ENTRY_METRICS.forEach((metric) => {
    ranked(metric).forEach((u) => {
      const prev = m.get(u.openId);
      if (prev === undefined || u.rank < prev) m.set(u.openId, u.rank);   // 取最小 = 最靠前
    });
  });
  worldSnap = m;
  log(`入场名次榜已刷新 ${m.size} 人（${why}·三榜取最靠前 ${ENTRY_METRICS.join('/')}）`);
  return m;
}

function log(...a) { console.log('[ledger]', ...a); }
const weekKey = (d) => { d = d || new Date(); const t = new Date(d); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate(); };
const monthKey = (d) => { d = d || new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1); };

// ⚠ streak 和 winStreak 是两个东西，别合并：
//   streak    = 玩法的【连胜池分】——败方各失 50% 汇池、胜方前 3 按 50/30/20 瓜分，是可转移的分数；
//   winStreak = 平台要的【连胜次数】——赢一局 +1、输/平清零，上报 winning_streak_count 用。
//   旧代码里 ranking.js 自己维护后者、score.js 维护前者，两边都叫 streak，是混淆的源头。
function blank(openId) {
  // ⚠ 只放【跨房】字段。fresh/round/likes/gifts/side 属本房本局，在 rooms.js 的 room.local 里。
  return { openid: openId, name: '', avatar: '', total: 0, week: 0, month: 0, streak: 0, winStreak: 0 };
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
// r(round) 已移出：它是【本房本局】的分，跟着房间走、由 pool.js 按主播持久化。
function packed(a) { return JSON.stringify({ n: a.name, a: a.avatar, t: a.total, w: a.week, m: a.month, s: a.streak, ws: a.winStreak }); }
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
  // ⚠ 没有 Redis（纯本地/离线）也要走一次建榜：否则启动那次 freeze 被这个提前 return 跳过，
  //   只能等 rankOfTotal 懒建。行为差别不大，但「启动就有榜」这条要在两条路上都成立。
  if (!kv.enabled) { hydrated = true; refreshWorldSnap('启动·无Redis'); return; }
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
  refreshWorldSnap('启动');   // ★服务端一起来就有榜 —— 这条专治「第一局不播」
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
    ['total', 'week', 'month', 'streak'].forEach((f) => {   // round/fresh 已移出跨房账，不在这迁
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
function record(room, ev) {
  if (!room || !room.active) return 0;                       // 主播还没点开始 → 客户端也丢弃，两边一致
  const id = ev && ev.openid;
  if (!id) return 0;                                // 匿名互动无法归属到人，不进账本（客户端同理只做视觉）
  const unit = G.ptsOf(ev.key);
  if (!unit) return 0;
  // ★count 一律生效，付费礼物也不例外（2026-08-04 用户定：「付费礼物计分一定不能落下」）：
  //   · 点赞：douyin.js 按平台报的 like_num 下发 count；gifts.js 的口径是「100 次点赞 = 一根仙女棒」，
  //     不按次数记这条口径直接不成立。
  //   · 付费礼物连击(gift_num)：观众送 5 连击甜甜圈是【真花了 5 份钱】，只记 1 份就是少记。
  //     ⚠ 原先"连击只记一次"是防灌爆奖励池的老决策，已被推翻 —— 别再改回去。
  //     防灌爆改由上游把关：douyin.js 的 clampInt(gift_num,1,20) + 下面这道 30 的兜底。
  //   ⚠ 本函数此前完全无视 count（只在 [push] 日志里打出来），douyin.js 那边却按"多出来的会进积分"
  //     写了注释 —— 两边对不上过一轮。现在以本函数为准。
  const n = Math.max(1, Math.min(parseInt(ev.count, 10) || 1, 30));
  const pts = unit * n;
  const a = acct(id);                               // 跨房账（世界榜口径）
  const l = R.local(room, id);                      // 本房局内账
  if (ev.nickname) a.name = ev.nickname;            // 昵称/头像以最新一次为准
  if (ev.avatar) a.avatar = ev.avatar;
  // ★阵容【跟着最新一条事件走】，不在这里再锁一次（2026-08-05 修）★
  //   原来是 `if (!l.side)` —— 本局第一次定了就不改。那是 2026-08-03「显式意愿可改队」之前的口径，
  //   改了之后就成了错的：观众先送礼被随机落座到 2、再扣「1」明确改到 1 队，
  //   douyin.js 的落座表、客户端的火箭/推力/仙女棒【全都】搬到了 1 队，只有这本账还记着 2 ——
  //   于是结算时他被当成 2 队的人分钱（1 队赢了他拿败方待遇）。这是钱算错，不是显示错。
  //   ⚠ 落座锁的真源只有一处：douyin.js 的 lockSide（隐式落座锁死本局、显式意愿允许改队）。
  //     ev.side 已经是它的输出，这里再锁一遍就是两套口径打架。别再加回 !l.side。
  if (ev.side === 'left' || ev.side === 'right') l.side = ev.side;
  l.fresh += pts; l.round += pts;                   // ← 本房本局
  a.week += pts; a.month += pts; a.total += pts;    // ← 跨房累计
  // 计数也按真实次数走：全员分成资格是「刷过礼物 或 点赞 > LIKE_QUALIFY(50)」，
  // 只 +1 的话点赞那条门槛几乎摸不到；礼物笔数同理，5 连击就是 5 笔。
  if (G.isPaid(ev.key)) l.gifts += n; else l.likes += n;
  room.pool += pts;
  room.poolOpen = true;
  markDirty(id);
  return pts;
}

// ── 对局生命周期 ──
function startRound(room, anchorOpenId, freshRound) {
  // ⚠ 绝不就地改写 room.anchor：房间的身份是 rooms 的【Map 键】，改这里键不会跟着变，
  //   会造出「兜底房顶着真实主播的名字」和「同一 anchor 两个 room 对象」。调用方负责取对房。
  //   只在房还没有身份时补一次（正常不会发生），不一致就告警，别静默走下去。
  if (anchorOpenId && anchorOpenId !== room.anchor) {
    if (!room.anchor || room.anchor === R.DEFAULT_ANCHOR) room.anchor = anchorOpenId;
    else log(`⚠️ anchor 不一致：房=${String(room.anchor).slice(0, 10)}… 传入=${String(anchorOpenId).slice(0, 10)}… → 以房为准`);
  }
  room.active = true;
  // ★freshRound === false 才跳过清局内账（2026-08-06）★
  //   clearRound 清的是 fresh/likes/gifts/side + 落座表 + 入场去重 —— 局中被重复调一次
  //   就等于把观众本局刷的分全抹成 0，而底池里那笔钱还在（loadPool 早就守住了），
  //   结算时他一分拿不到、钱分给别人。实测 6000 → 0。
  //   判据由调用方(index.js 的 /round/start)算好传进来，与它守 loadPool 用的是【同一个】，
  //   两处必须同源：只守一处完全无效，因为这里和那里各清一遍落座表。
  //   ⚠ 不传（老调用 / 自查工具 / 本地脚本）→ 照旧清，行为与改造前完全一致。
  if (freshRound !== false) R.clearRound(room);
  else log(`/round/start 重复调用 → 跳过 clearRound，保住本局账（${room.local.size} 人）`);
  savePool(room);
}
// 结算：完全照搬 src/score.js 的 settle()，逐条对齐（改任何一条两边一起改）
function settle(room, winnerSide) {
  room.active = false;
  // ★合成视图：把【跨房账 a】和【本房局内账 l】拼成一个临时对象，
  //   下面那一大段结算数学（前3/全员分成/鼓励分/击败加成/连胜池）就【一行都不用改】，
  //   算完再按字段归属写回两边。改数学最容易出错，这样把风险隔离在拼装和写回两头。
  const players = [...room.local.entries()].filter(([, l]) => l.side).map(([id, l]) => {
    const a = acct(id);
    return { openid: id, name: a.name, avatar: a.avatar, side: l.side,
             fresh: l.fresh, round: l.round, likes: l.likes, gifts: l.gifts,
             total: a.total, week: a.week, month: a.month,
             streak: a.streak, winStreak: a.winStreak, _a: a, _l: l };
  });
  const winners = players.filter((u) => u.side === winnerSide).sort((a, b) => b.fresh - a.fresh);
  const losers = players.filter((u) => u.side !== winnerSide);
  const byRound = players.slice().sort((a, b) => b.fresh - a.fresh);
  const poolVal = Math.round(room.pool * POOL_RATE);
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
    // ★写回：按字段归属拆回两边 —— 局内进 room.local，跨房进 accounts。漏一处就是数据不落盘。
    u._l.round = u.round; u._l.fresh = u.fresh; u._l.likes = u.likes; u._l.gifts = u.gifts;
    u._a.week = u.week; u._a.month = u.month; u._a.total = u.total;
    u._a.streak = u.streak; u._a.winStreak = u.winStreak;
    markDirty(u.openid);
  });
  flush().catch(() => {});
  // ★结算完（奖励已入 total）刷新【全平台那一份】榜 —— 不再各房各存一份。
  //   多主播并发时谁结算都只是往同一本账里加自己那局的结果，不存在互相覆盖。
  refreshWorldSnap('结算 ' + String(room.anchor).slice(0, 10) + '…');
  savePool(room);
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
function nextRound(room) {
  room.local.forEach((l) => {
    l.round = Math.round(l.round * INHERIT_RATE);   // 本局分带走 40%
    l.fresh = 0; l.likes = 0; l.gifts = 0; l.side = null;
  });
  room.pool = Math.round(room.pool * INHERIT_RATE); // 积分池留 40% 当下一局底池
  room.poolOpen = false;
  room.active = false;
  flush().catch(() => {});
  savePool(room);
  return room.pool;
}

// ── 底池借用 pool.js 存（按主播 openid），启动时读回来 ──
// 底池 + 每人的本局分，都按【主播 openid】落盘（用户 2026-08-05：所有状态跟着主播走）
// ★没成功读回过就绝不落盘（2026-08-05 修「积分池变成几千」）★
//   pool.js 在 Redis 读失败时【故意】保持 ready:false —— 它自己都不知道底池是多少。
//   而 loadPool 遇到 ready:false 会直接 return，紧接着 startRound 却无条件调本函数，
//   于是把新房的 room.pool（0）写进存档，主播攒了很多局的底池当场清零，
//   下一局只能从 0 按每人下场 +1000 累起来 —— 屏幕上就是「几千积分」。
//   底池是要分给观众的钱：宁可这一局不落盘（重启丢本局涨幅），也不能拿一个我们并不知道的值覆盖存档。
//   ⚠ 跳过时必须打日志，别静默 —— 静默丢盘比写错更难查。
function savePool(room) {
  if (!room.poolLoaded) { log('⚠️ 底池尚未成功读回，跳过落盘（防止把存档覆盖成 0）· anchor=' + String(room.anchor).slice(0, 10) + '…'); return; }
  // 不再传 rankSnap：入场名次榜已改成全平台一份，不按主播落盘（见 refreshWorldSnap）
  pool.set(room.anchor, room.pool, room.poolOpen, room.local).catch(() => {});
}
async function loadPool(room, anchorOpenId) {
  // ⚠ 绝不就地改写 room.anchor：房间的身份是 rooms 的【Map 键】，改这里键不会跟着变，
  //   会造出「兜底房顶着真实主播的名字」和「同一 anchor 两个 room 对象」。调用方负责取对房。
  //   只在房还没有身份时补一次（正常不会发生），不一致就告警，别静默走下去。
  if (anchorOpenId && anchorOpenId !== room.anchor) {
    if (!room.anchor || room.anchor === R.DEFAULT_ANCHOR) room.anchor = anchorOpenId;
    else log(`⚠️ anchor 不一致：房=${String(room.anchor).slice(0, 10)}… 传入=${String(anchorOpenId).slice(0, 10)}… → 以房为准`);
  }
  await pool.ready();
  const p = pool.get(room.anchor);
  if (!p.ready) return room.pool;      // 读不到就别动 room.pool，也别让 savePool 拿它去覆盖存档
  room.poolLoaded = true;              // 只有真读回来过，之后才允许落盘（见 savePool）
  // ★入场名次榜不再按主播落盘（2026-08-05 改成全平台一份）★
  //   原来这里会从【这个主播的】存档里恢复 room.rankSnap —— 那是为了治「重启后特效哑掉」。
  //   现在 hydrate 成功就立刻建一份全局榜（见 refreshWorldSnap），根因没了，这套也就不需要了。
  //   存量记录里残留的 rs 字段无人读取，下次 set 时自然被覆盖掉。

  room.pool = p.pool;
  // 每人的本局分也跟着主播恢复（跨重启/换机都在）
  if (p.rounds) for (const id in p.rounds) R.local(room, id).round = +p.rounds[id] || 0;
  // 上一局没结转（主播结算面板开着就关了 exe / 崩了）→ 现在补一次，否则底池带 100% 越滚越大。
  // ⚠ 必须和 nextRound() 打【同一个折】：只折底池不折每人 round 的话，主播崩过一次，
  //   观众带进新局的分是 100% 而池子只有 40% —— 结算时按人头分出去的会超过池子该有的量。
  if (p.open) {
    room.pool = Math.round(room.pool * INHERIT_RATE);
    room.local.forEach((l) => { l.round = Math.round((l.round || 0) * INHERIT_RATE); });
    room.poolOpen = false; savePool(room);
  } else room.poolOpen = false;
  return room.pool;
}

// ── 给客户端的快照 ──
// 只送用得上的人：本局参与者（fresh>0 或已落座）+ 总榜前 SNAP_TOP，避免观众上万时把 SSE 撑爆。
const SNAP_TOP = 150;
// 四榜(总/周/月/连胜)各取前 SNAP_TOP 后的并集大小警戒线：超了只打日志、不截断 ——
// 静默截断会让某个榜的尾部凭空少人，比体积大更难查。
const UNION_CAP = 300;
// 下发给【这个房间】的快照：本房参战者（局内分）+ 总榜前 N（跨房分，给世界榜 tab 用）
function snapshot(room) {
  const seen = new Set(), list = [];
  const put = (id, l) => {
    if (seen.has(id)) return; seen.add(id);
    const a = acct(id);
    list.push({ openid: id, name: a.name, avatar: a.avatar,
                total: a.total, week: a.week, month: a.month, streak: a.streak,
                round: l ? l.round : 0, fresh: l ? l.fresh : 0,
                likes: l ? l.likes : 0, gifts: l ? l.gifts : 0, side: l ? l.side : null });
  };
  room.local.forEach((l, id) => { if (l.fresh > 0 || l.side) put(id, l); });   // 本房参战者优先
  // ★四个榜各补各的前 N（2026-08-05 修「周榜月榜和本局榜单积分不同步」）★
  //   原来只补【总榜前 SNAP_TOP】，而客户端有四个 tab：本局/周榜/月榜/连胜榜，
  //   它们都只能在这份名单里排序 —— 于是「本周刷了很多、但历史总积分排 150 名开外」的观众
  //   在周榜上【一行都不出现】，客户端那个周榜其实是「总榜前 150 这个子集内按周分排序」。
  //   而只要他在本房互动一次又会突然冒出来 → 同一个人在开打前/开打后是两份周榜。
  //   ⚠ 四个指标的头部通常高度重叠（大 R 各榜都在前面），并集远小于 4×；
  //     真实体积打进日志（下面 UNION_CAP），别静默膨胀也别静默截断。
  const fill = (metric) => [...accounts.values()]
    .filter((a) => a[metric] > 0)
    .sort((x, y) => y[metric] - x[metric])
    .slice(0, SNAP_TOP)
    .forEach((a) => put(a.openid, room.local.get(a.openid)));
  ['total', 'week', 'month', 'streak'].forEach(fill);
  if (list.length > UNION_CAP) {
    log(`⚠️ 快照名单 ${list.length} 人（>${UNION_CAP}）—— 四榜并集偏大，SSE 体积需要关注`);
  }
  return { type: 'ledger', ready: hydrated, pool: room.pool, poolOpen: room.poolOpen, active: room.active, users: list };
}
// ── 只读排行（ranking.js 上报给抖音平台时读这里，不再自己攒一本账）──
// ⚠ 名次口径三条，别混：
//   本局榜 = fresh（本局贡献）  · 平台世界榜 = month（月榜，与 world_rank_version=month_YYYYMM 同周期）
//   入场视频档位 = total（总积分）—— 玩法里「世界榜」的定义就是总积分，结算面板那个 tab 也是它。
const RANK_CAP = 1000;   // 名次超 1000 固定报 1000（抖音端显示 999+），与 ranking.js 同口径
// 跨房榜（世界榜/月榜）：只看 accounts
function ranked(metric) {
  return [...accounts.values()]
    .filter((a) => a[metric] > 0)
    .sort((x, y) => y[metric] - x[metric])
    .map((a, i) => ({ openId: a.openid, score: a[metric], winStreak: a.winStreak || 0, rank: Math.min(i + 1, RANK_CAP) }));
}
// 本局榜：只看【这个房间】的局内分。上报本局战绩用它，绝不能拿跨房分去报。
function roundList(room) {
  if (!room) return [];
  return [...room.local.entries()]
    .filter(([, l]) => l.fresh > 0)
    .sort((x, y) => y[1].fresh - x[1].fresh)
    .map(([id, l], i) => ({ openId: id, score: l.fresh, side: l.side,
                            winStreak: (accounts.get(id) || {}).winStreak || 0,
                            rank: Math.min(i + 1, RANK_CAP) }));
}
function worldList() { return ranked('month'); }
// 入场视频的名次：读【全平台一份】的冻结榜 worldSnap（启动即建 + 任意主播 settle 刷新）。
// ⚠ 不是「按局冻结」了：任意主播结算都会刷同一份全局榜 —— A 房局中，B 房一结算 A 房观众的档位也可能变。
//   仍然成立的是「本局刚打的分不立刻升档」（要等某次 settle）。
// 口径 = 周榜/月榜/总分榜三者里【最靠前】的那个名次（见 refreshWorldSnap 上方的说明）：
//   ① 三个榜都没上（total=0）→ 0，不播；② 按排序序位给名次，同分也落不同档
//   （不像旧的严格 `>` 计数那样把同分全并成「榜一」→ 一堆人共用同一条入场视频）。

// 查某人的【入场视频名次】(1-based)，不在榜返回 0（没积分不上榜 —— 用户确认这条是对的）。
// ⚠ 原名 rankOfTotal 已废弃：2026-08-05 改成三榜取最靠前之后，那个名字会骗人
//   （返回的不再是"总分榜名次"）。本项目栽在"名字/口径对不上"上不止一次，所以直接改名。
//   下面仍导出 rankOfTotal 作别名，避免撞到并行会话在途的调用点。
// ⚠ 第二个参数 room 已废弃：名次是全平台共享的，跟哪个直播间无关。
function entryRankOf(openId, _roomDeprecated) {
  if (!openId) return 0;
  // 还没建过榜（hydrate 刚好慢一步）→ 补建一次，别让开播头几秒白白不播
  const snap = worldSnap || refreshWorldSnap('懒建');
  if (!snap) return 0;                            // 账本没就绪 → 不播（不是"没积分"，是"还不知道"）
  return snap.get(openId) || 0;
}
function peek(limit) {
  return ranked('total').slice(0, Math.max(1, Math.min(+limit || 20, 150)))
    .map((u) => ({ open_id: u.openId, rank: u.rank, score: u.score }));
}

function diag() { return { accounts: accounts.size, hydrated, worldSnap: worldSnap ? worldSnap.size : 0, rooms: R.diag() }; }
async function reset(prefix) {
  const hit = [...accounts.keys()].filter((id) => !prefix || id.startsWith(prefix));
  hit.forEach((id) => accounts.delete(id));
  if (kv.enabled && hit.length) await kv.hdel(ACCT_KEY, hit);
  return { removed: hit.length, left: accounts.size };
}

module.exports = {
  record, startRound, settle, nextRound, snapshot, loadPool, ready, diag, reset, flush, INHERIT_RATE,
  roundList, worldList, entryRankOf, rankOfTotal: entryRankOf, peek, size: () => accounts.size,   // rankOfTotal 是旧名别名，见 entryRankOf 上方
};
