// ============================================================
//  server/userTeam.js · 「用户快捷选队」开发者侧接口（小摇杆点选阵营）
//  ------------------------------------------------------------
//  官方能力：观众在小摇杆点选队按钮加入阵营（≠评论1/2·文档明确「点按钮平台不推评论指令」）。
//  开发者须提供 2 个接口（平台来调/来推），后台「开发配置」填这两个地址：
//    ③ 查询观众阵营数据  /api/query_user_group  (x-msg-type: user_group)
//       平台在观众打开小摇杆时调 → 返回该 open_id 当前阵营（round + group_id）。
//    ④ 观众选择阵营      /api/user_group_push   (x-msg-type: user_group_push)
//       观众点选队按钮 → 平台推来 → lockSide 落座 + 广播 join 到游戏 → 返回实际加入阵营。
//  阵营 group_id = 内部 side（**后台 Group_ID 必须配 left / right**·与 ranking.js:135 一致）。
//  ⚠ 验签(x-signature=排序header+body+secret 的 MD5→Base64)：文档要求校验，
//     内测先跳过(cfg.DEV_SKIP_SIGN·抖音云内网免验签)，上线补 verifyTeamSign。
// ============================================================
'use strict';
const dy = require('./douyin');

// 阵营ID 归一：后台 Group_ID 配 left/right；兼容平台可能传 1/2 或 大壮/小美。
function normGroup(g) {
  const s = String(g == null ? '' : g).trim();
  if (s === 'left' || s === 'right') return s;
  if (s === '1' || s === '大壮') return 'left';
  if (s === '2' || s === '小美') return 'right';
  return '';
}

// ★统一取包体（2026-07-30 加）：真机回调 raw 可能是【数组】[{...}] 也可能是对象 —— /cb/*、礼物回调、
//   observer audience_change 实测都是数组，audienceChange 已为此修过一次（见其上方注释）。
//   而 queryUserGroup/userGroupPush 原先直接 body.open_id，收到数组时会【全取空】：
//     · queryUserGroup → 永远返回"未加入阵营"
//     · userGroupPush  → 拿不到 group_id、走防御分支，观众点了选队按钮但永远不落座
//   最坑的是两者仍返回 errcode:0 → 平台侧看着成功、发版检查也过，真机上却没人能选队。
//   两种形状都吃下，彻底消掉这个静默失败。
function pickBody(rawBody, fallback) {
  try { const p = JSON.parse(rawBody || fallback || '{}'); return (Array.isArray(p) ? p[0] : p) || {}; }
  catch (_) { return {}; }
}

// ③ 查询观众阵营数据（平台调·观众打开小摇杆时）：只查主动落座、不触发随机（没落座返回空串）。
function queryUserGroup(rawBody, round) {
  const body = pickBody(rawBody);
  const side = dy.chosenSide(body.open_id || '');
  return {
    errcode: 0, errmsg: 'success',
    data: {
      round_id: round.id || 0,
      round_status: round.status || 2,        // 1=已开始 2=已结束
      user_group_status: side ? 1 : 0,        // 0=未加入 1=已加入
      group_id: side || '',                   // 阵营id·未加入空串
    },
  };
}

// ④ 观众选择阵营（平台推·观众点选队按钮）：lockSide 落座（首次按选的方向锁定·已落座归原队不换）
//    → 广播 join/c666 到游戏（首次=加入·永久推力+小火箭；已落座=加力）→ 返回实际加入阵营。
function userGroupPush(rawBody, round, broadcast, worldRankOf) {
  const body = pickBody(rawBody);
  const openId = body.open_id || body.openid || body.sec_openid || '';
  const want = normGroup(body.group_id);
  // 防御：只处理带有效阵营(group_id)的「观众选择阵营」。无 group_id 的事件——
  // 如误配到本地址的「观众进出房数据」——直接 ack、不落座，避免观众一进房就被随机拉队/刷屏。
  if (!want) {
    return { errcode: 0, errmsg: 'success', data: { round_id: round.id || 0, round_status: round.status || 2, group_id: dy.chosenSide(openId) || '' } };
  }
  // 小摇杆点按钮 = 最明确的显式意愿 → explicit=true，允许改队（同评论 1/2，见 douyin.js 的 lockSide）
  const prev = dy.chosenSide(openId);
  const side = dy.lockSide(openId, want, true);
  if ((side === 'left' || side === 'right') && typeof broadcast === 'function') {
    const user = { openid: openId, nickname: body.nickname || '', avatar: body.avatar_url || '' };
    const switched = !!prev && prev !== side;             // 换边了 → 客户端把他的小火箭挪过去
    broadcast([{ side, key: prev ? 'c666' : 'join', count: 1, switched, from: prev || '', ...user }]);
    // ★入场视频的【第二条】触发路径：小摇杆点选队按钮 = 最明确的"落座"动作。
    //   noteInteraction 与 /cb/* 共用 enteredThisRound，所以「先点按钮后送礼」不会重复播。
    //   isJoin = !prev：没落过座才是"进场"；已落座的人点按钮只是改队，不该再放一次入场视频。
    noteInteraction(user, broadcast, worldRankOf, false, !prev);
  }
  return {
    errcode: 0, errmsg: 'success',
    data: { round_id: round.id || 0, round_status: round.status || 2, group_id: side || '' },
  };
}

// 观众进出房数据（专门接口）：进场时若该观众在**世界榜前一百** → 广播 {type:'rankEnter',rank} 到游戏，
// 客户端按名次分档播入场视频（1~5 各一条 / 6-10 / 11-20 / 21-30 / 31-50 / 51-100 共用·见 main.js RANK_ENTER_TIERS）。
// 非前百/查不到名次 → 只 ack 不播。2026-07-31 由前十扩到前百（用户换了素材文件夹）。
// 字段以真机为准（open_id、是否弹幕玩法老玩家、直播贡献梯度、发起召集用户 openid 等）。
// TODO 后续：发起召集 openid → 触发召集效果；老玩家/高贡献 → 差异化欢迎横幅。
const RANK_ENTER_MAX = 100;                   // 触发上限：世界榜前 100 名进场才播（客户端 main.js 同名常量兜底同一个数）
const rankEnterCooldown = new Map();          // openid -> lastMs（同一上榜观众 60s 内反复进场，只显示第一次动画）
const RANK_ENTER_COOLDOWN_MS = 60000;         // 60s 去抖
// 🔧 测试开关：env RANK_ENTER_TEST=<1-100> → 每个进场观众都强制当该名次触发入场视频（免真送礼凑榜、免 60s 去抖）。
//    测完把这个环境变量删掉即恢复"真·世界榜前百才播"。0/未设 = 关闭。
const RANK_ENTER_TEST = parseInt(process.env.RANK_ENTER_TEST || '0', 10);
function audienceChange(rawBody, broadcast, worldRankOf) {
  // ⚠ 真机回调 raw 是数组 [{...}]（同 /cb/* 与礼物回调）→ 必须取 [0]！直接 body.open_id 会全取空、永不触发。
  let items; try { const p = JSON.parse(rawBody || '[]'); items = Array.isArray(p) ? p : [p]; } catch (_) { items = []; }
  const body = items[0] || {};
  const openId = body.open_id || body.openid || body.sec_openid || '';
  // 只处理「进场」：字段名以真机为准，容错 action/event/type 里含 enter/in；缺字段则默认按进场处理。
  const act = String(body.action || body.event || body.event_type || body.type || '').toLowerCase();
  const isEnter = !act || /enter|join|in\b|come/.test(act);
  if (openId && isEnter && typeof broadcast === 'function' && typeof worldRankOf === 'function') {
    const testMode = RANK_ENTER_TEST >= 1 && RANK_ENTER_TEST <= RANK_ENTER_MAX;
    const rank = testMode ? RANK_ENTER_TEST : worldRankOf(openId);   // 测试开关开 → 强制名次；否则真查世界榜
    // 诊断：每个进场者的世界榜名次一眼可见（未上榜/非前百/触发 都打出来，方便排查为啥不播）
    console.log(`[room→] 进场 openid=${String(openId).slice(0, 10)}… 名次=${rank || '未上榜(需先送礼累计)'}${testMode ? '(测试强制)' : ''} ${rank >= 1 && rank <= RANK_ENTER_MAX ? '→ 触发榜' + rank + '入场视频' : '(非前百·不播)'}`);
    if (rank >= 1 && rank <= RANK_ENTER_MAX) {
      const now = Date.now();
      const last = rankEnterCooldown.get(openId) || 0;
      if (testMode || now - last > RANK_ENTER_COOLDOWN_MS) {   // 测试模式跳过去抖；正式态 60s 内同一人只第一次播
        rankEnterCooldown.set(openId, now);
        broadcast([{ type: 'rankEnter', rank, openid: openId, nickname: body.nickname || '', avatar: body.avatar_url || body.avatar || '' }]);
      } else {
        console.log(`[room→] openid=${String(openId).slice(0, 10)}… 60s 内已播过，去抖跳过`);
      }
    }
  }
  return { errcode: 0, errmsg: 'success', data: {} };
}

// ============================================================
//  落座即触发入场视频（2026-08-01 · 替代平台「观众进出房」回调）
//  ------------------------------------------------------------
//  🔴 为什么不用 audienceChange：实测平台【从不推送】观众进出房数据。
//     能力已开通（基础能力页·开关已开）、抖音云回调路径已注册、开发配置已绑定 —— 三层全通，
//     但抖音云日志检索近 7 天真实调用 = 0（唯一 1 条是自己打的部署探针）。
//     同窗口 40 条 like/gift 事件全部正常到达 → 不是链路问题，是这个回调平台就是不发。
//  ✅ 改挂在「落座」这一刻。本游戏里落座有【两条】路径，都确证会响，缺一不可：
//       ① 小摇杆点选队按钮 → /api/user_group_push   （近 7 天 66 条·活跃）
//       ② 任何首次互动     → /api/cb/{like,comment,gift}（同窗口 40 条·活跃）
//     只接 ① 会漏掉不点按钮直接送礼的人；只接 ② 会漏掉点了按钮就安静看的人。
//  语义 = 每局每人最多播一次（enteredThisRound 每局清），叠加 60s 跨局去抖做保险。
// ============================================================
const enteredThisRound = new Set();           // 本局已【真的播过】入场的 openid
const seenThisRound = new Set();              // 本局出现过的 openid（判首次 + 防日志刷屏）
function resetRoundEnter() { enteredThisRound.clear(); seenThisRound.clear(); }

// isGift=true 表示本次互动是送礼（会改变世界榜名次）→ 需要重新查名次。
function noteInteraction(user, broadcast, worldRankOf, isGift, isJoin) {
  const openId = user && (user.openid || user.open_id || user.sec_openid);
  if (!openId || typeof broadcast !== 'function' || typeof worldRankOf !== 'function') return;
  if (enteredThisRound.has(openId)) return;   // 本局已播过 → 后续互动不再触发
  const first = !seenThisRound.has(openId);
  seenThisRound.add(openId);
  // ★2026-08-04 改判据：由「本局首次出现」改成「本次是落座(join)」。
  //   旧判据 `!first && !isGift` 的坑（用户报「返回重开后落座没入场特效、刷礼物才播」）：
  //     first 只表示"这一局第一次见到这个 openid"，而任何一条互动都会把他记进 seenThisRound
  //     —— 包括闲聊评论（见 index.js 那个已修的 userOf 回退）和点赞。
  //     于是「先打了句字/点了个赞 → 再扣1落座」的人，落座时 first 已经是 false、又不是送礼，
  //     直接 return，入场视频不播；等他后来刷了个礼物才被 isGift 放行，特效迟到一大截。
  //   新判据只认两件事：
  //     · isJoin —— translate 产出 join 事件 = 观众正式进场，这才是入场视频该播的时刻
  //     · isGift —— 世界榜按送礼累计，名次可能刚变，要重查（无名次的人送礼后可能就上榜了）
  //   点赞/666/闲聊一律不查：既不是落座、也不改名次，查了纯属浪费（worldRankOf 要全表排序）。
  if (!isJoin && !isGift) return;
  const testMode = RANK_ENTER_TEST >= 1 && RANK_ENTER_TEST <= RANK_ENTER_MAX;
  const rank = testMode ? RANK_ENTER_TEST : worldRankOf(openId);
  const now = Date.now();
  const cooling = !testMode && now - (rankEnterCooldown.get(openId) || 0) <= RANK_ENTER_COOLDOWN_MS;
  const ok = rank >= 1 && rank <= RANK_ENTER_MAX && !cooling;
  // ★先把结论算出来再打日志：别写成「打完『→ 触发』再 return」——那样日志会谎报触发（2026-08-01 自测抓到）。
  const verdict = !(rank >= 1 && rank <= RANK_ENTER_MAX) ? '(未上榜·不播·送礼后会再查)'
                : cooling ? `(榜${rank}·但 ${Math.round(RANK_ENTER_COOLDOWN_MS / 1000)}s 内已播过·跳过)`
                : `→ 触发榜${rank}入场视频`;
  if (first || ok || cooling) {   // 无名次的后续送礼不再刷屏，只在首次/有结果时打
    console.log(`[enter] 落座 openid=${String(openId).slice(0, 10)}… 名次=${rank || '未上榜(世界榜=送礼累计·本实例重启后清零)'}${testMode ? '(测试强制)' : ''} ${verdict}`);
  }
  if (!ok) return;
  // ★★记账放在【确认要播之后】：早期版本无条件 add，导致「先点赞(无名次)后送礼(有名次了)」的人
  //   在点赞那一下就被记死、这一局永远播不出来 —— 而这恰恰是最常见的真实路径。
  enteredThisRound.add(openId);
  rankEnterCooldown.set(openId, now);
  broadcast([{ type: 'rankEnter', rank, openid: openId, nickname: user.nickname || '', avatar: user.avatar || user.avatar_url || '' }]);
}

module.exports = { queryUserGroup, userGroupPush, audienceChange, normGroup, noteInteraction, resetRoundEnter };
