// ============================================================
//  server/pool.js · 积分池「底池」的服务端存档
//  ------------------------------------------------------------
//  为什么必须放服务端（2026-08-02 用户指出）：
//    底池最初写在客户端 localStorage 里，那是【主播那台电脑】上的浏览器存储 ——
//    换电脑、重装、清缓存全没了，而且没有任何人↔分数的权威归属。
//    积分池是要真金白银分给观众的，真源只能在服务端。
//
//  存什么：按【主播 openid】一人一格（底池跟主播走，不跟直播间走 —— room_id 每次开播都变）。
//    { p: 当前积分池值, o: 是否还没结转, t: 最后更新时间 }
//    o(open) 的意义见 src/score.js 的 roundOpen：主播可能结算面板开着就关 exe，
//    那一局没走过结转 → 下次开播要补一次，否则底池带 100% 越滚越大。
//
//  拿不到主播 openid 时（exe 没走 /start_game、token 置换失败）落 'default' 这一格 ——
//  宁可全主播共用一格，也别整个功能失效。真机只要正常开局就拿得到。
//
//  Redis 没开通 → 退化成进程内存（重启即丢），行为不比改动前差，且绝不拖垮主链路。
// ============================================================
'use strict';
const kv = require('./kv');

const KEY = 'qd:pool';          // Redis hash：field = 主播 openid，value = JSON
const DEFAULT_ANCHOR = 'default';
const mem = new Map();          // anchor -> {p,o,t}；Redis 的本地镜像 + 无 Redis 时的兜底
let hydrated = false;

function log(...a) { console.log('[pool]', ...a); }
const norm = (a) => String(a || '').trim() || DEFAULT_ANCHOR;

// ★单位标记（2026-08-03）：底池随账本一起从「票」改成「分」，存量要 ×1000。
//   记录里的 `u` 字段就是这个标记；没有 u 的都是旧的票口径。
//   迁移在 hydrate() 里【开机一次性做完】并写回 Redis，不走懒迁 ——
//   懒迁会让 diag()/健康检查读到未换算的原值，跟游戏实际用的值对不上。
//   normUnit 仍留在 get() 里当兜底：滚动发布期间可能有旧实例写进新记录。
//   ⚠ 幂等全靠 u 字段，而 u 必须在 hydrate 解析时原样带进内存 —— 漏掉它，
//     每次重启都会再迁一次，底池会 ×1000 地涨。
const UNIT_TAG = 'score';
const LEGACY_VOTE_TO_SCORE = 1000;
function normUnit(v) {
  if (!v || v.u === UNIT_TAG) return v;
  return { ...v, p: Math.round((+v.p || 0) * LEGACY_VOTE_TO_SCORE), u: UNIT_TAG };
}

// 启动时把整张表读回内存：GET /pool 要同步返回，不能每次都等一趟 Redis 往返。
async function hydrate() {
  if (!kv.enabled) { hydrated = true; return; }
  const h = await kv.hgetall(KEY);
  // ★读失败【绝不】置 hydrated：否则 get() 会报 ready:true 并返回空池，
  //   客户端信了就把主播攒了很多局的底池当成 0 覆盖掉 —— 这是最贵的一种错。
  if (!h) { log('底池读取失败（Redis 未就绪？）→ 保持 ready:false，客户端会退回本机缓存'); return; }
  let n = 0;
  const migrated = [];
  for (const a in h) {
    try {
      const v = JSON.parse(h[a]);
      // ⚠ u（单位标记）必须原样带进内存 —— 漏掉它，下次重启会把已经迁过的记录当成旧的【再迁一次】，
      //   底池每重启一次 ×1000。这条是 2026-08-03 实测抓到的，别再改回只取 p/o/t。
      const rec = normUnit({ p: +v.p || 0, o: !!v.o, t: v.t || 0, u: v.u });
      mem.set(a, rec); n++;
      if (rec.u !== v.u) migrated.push(a);            // 本次刚换算的，要写回 Redis
    } catch (_) {}
  }
  hydrated = true;
  log(`底池已从持久化恢复 ${n} 位主播` + (n ? '：' + [...mem.entries()].map(([a, v]) => a.slice(0, 8) + '…=' + v.p).join(' ') : ''));
  // ★开机就把存量单位迁完（票→分 ×1000），而不是等 get() 懒迁：
  //   懒迁会让 diag()/健康检查读到未换算的原值，跟游戏实际用的值对不上 —— 诊断口说谎比 bug 本身更贵。
  if (migrated.length && kv.enabled) {
    const pairs = [];
    migrated.forEach((a) => pairs.push(a, JSON.stringify(mem.get(a))));
    try {
      await kv.hset(KEY, pairs);
      log(`底池单位迁移 票→分 ×${LEGACY_VOTE_TO_SCORE} 完成 ${migrated.length} 位：` +
        migrated.map((a) => a.slice(0, 8) + '…=' + mem.get(a).p).join(' '));
    } catch (e) { log('⚠️ 底池单位迁移写回失败，下次启动会重试：' + e.message); }
  }
}
// 客户端开局第一件事就是 GET /pool，很可能【早于】下面那次延迟 hydrate。
// ready() 保证：没读回来之前先读一次（并发只走一趟），读不到就如实报 ready:false。
let _hydrating = null;
function ready() {
  if (hydrated) return Promise.resolve();
  if (!_hydrating) _hydrating = hydrate().catch(() => {}).then(() => { _hydrating = null; });
  return _hydrating;
}
const _boot = setTimeout(hydrate, 800);   // 与 ranking 的 hydrateWorld 同节奏：等 kv 连上再读
if (_boot.unref) _boot.unref();

function get(anchor) {
  const a = norm(anchor);
  const raw = mem.get(a) || mem.get(DEFAULT_ANCHOR) || { p: 0, o: false, t: 0, u: UNIT_TAG };
  const v = normUnit(raw);
  if (v !== raw) {                                   // 旧口径 → 就地换算并回写，只发生一次
    mem.set(a, v);
    if (kv.enabled) kv.hset(KEY, [a, JSON.stringify(v)]).catch(() => {});
    log(`底池单位迁移 票→分 ×${LEGACY_VOTE_TO_SCORE}：${a.slice(0, 8)}… → ${v.p}`);
  }
  return { anchor: a, pool: Math.max(0, Math.round(v.p || 0)), open: !!v.o, at: v.t || 0, ready: hydrated };
}

// 客户端每局结转后（以及局中低频心跳）推上来。写内存 + 落 Redis，失败不抛。
async function set(anchor, pool, open) {
  const a = norm(anchor);
  const v = { p: Math.max(0, Math.round(+pool || 0)), o: !!open, t: Date.now(), u: UNIT_TAG };
  mem.set(a, v);
  if (kv.enabled) await kv.hset(KEY, [a, JSON.stringify(v)]);
  return get(a);
}

// 运维：清某个主播（或全部）的底池。前缀空串 = 清全部。
async function reset(prefix) {
  const hit = [...mem.keys()].filter((a) => !prefix || a.startsWith(prefix));
  hit.forEach((a) => mem.delete(a));
  if (kv.enabled && hit.length) await kv.hdel(KEY, hit);
  return { removed: hit.length, anchors: hit };
}

// ⚠ 报的必须是【游戏实际会用到的值】：过一遍 normUnit，否则诊断口显示的是未换算的原值，
//   跟 get() 返回的对不上 —— 2026-08-03 就差点照着它误判「迁移没生效」。
function diag() {
  return { anchors: mem.size, hydrated, kv: kv.enabled, unit: UNIT_TAG,
    list: [...mem.entries()].map(([a, v]) => { const n = normUnit(v); return { anchor: a, pool: n.p, open: n.o, migrated: n !== v }; }) };
}

module.exports = { get, set, reset, diag, hydrate, ready };
