// ============================================================
//  server/ranking.js · 用户战绩与排行榜（抖音直播玩法 服务端 OpenAPI 接入）
//  ------------------------------------------------------------
//  纯服务端上报，抖音「小摇杆」展示「本局榜 / 世界榜 / 我的面板」。
//  本模块封装：token 管理 + 8 个 OpenAPI 接口 + 按 open_id 累计战绩
//  + 对局(本局榜)编排 + 世界榜(跨场月榜)编排 + 世界榜定时刷新。
//
//  对外（被 index.js 调用）：
//    （战绩累计已移出本模块 → server/ledger.js，本模块只读它上报）
//    startRound(roomId)                          对局开始（同步开始状态）
//    endRound(roomId, winnerSide)                对局结束（排名→上报→完成）
//    startWorldCron() / stopWorldCron()          世界榜定时刷新（每30s）
//
//  鉴权链路（实测自文档）：
//    token: POST https://developer.toutiao.com/api/apps/v2/token
//           {appid, secret, grant_type:"client_credential"} → data.access_token (~2h)
//    业务: POST https://webcast.bytedance.com/api/gaming_con/<path>
//           头 content-type:application/json + X-Token:<token>，体 JSON，返回 {err_no,err_msg}
//
//  ⚠️ 联调前提（见文件尾「联调清单」）：启用 AppSecret、配 ANCHOR_OPEN_ID、
//     调试成员阶段 is_online_version=false，并核对 open_id 与礼物回调用户标识是否同源。
// ============================================================
'use strict';
const https = require('https');
const cfg = require('./config');
const ledger = require('./ledger');   // 玩法积分账本 = 唯一真源；本模块只把它上报给抖音平台

// ---- 配置（APPID/APPSECRET 来自 config；其余读环境变量）----
const APP_ID = cfg.APPID;                                   // tt62e91454fc8d46c610
const APP_SECRET = cfg.APPSECRET || '';                     // 启用 AppSecret 后填入（无则模块静默 no-op）
const IS_ONLINE = process.env.RANK_ONLINE === '1';          // 调试成员阶段=false；正式上线=true
const ANCHOR_OPEN_ID = process.env.ANCHOR_OPEN_ID || '';    // 主播 openid（对局接口必填）
const ENABLED = !!APP_SECRET;                               // 没配 secret 就不启用，避免拖垮回调主链路

const TOKEN_URL = 'https://developer.toutiao.com/api/apps/v2/token';
const API_HOST = 'webcast.bytedance.com';
const API_PATH = '/api/gaming_con/';
const RANK_TOP = 150;        // 榜单区上限 Top150
const USER_BATCH = 50;       // 个人数据区单批 ≤50
const RANK_CAP = 1000;       // rank 超 1000 固定传 1000（抖音端显示 999+）

function log(...a) { console.log('[rank]', ...a); }

// ---------- HTTPS POST JSON ----------
function postJSON(host, path, body, headers) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(new Error('bad json: ' + b.slice(0, 200))); } }); }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

// ---------- token（client_token，缓存，提前 60s 刷）----------
let _tok = { v: '', exp: 0 };
async function getToken(force) {
  const now = Date.now();
  if (!force && _tok.v && now < _tok.exp) return _tok.v;
  const r = await postJSON('developer.toutiao.com', '/api/apps/v2/token', { appid: APP_ID, secret: APP_SECRET, grant_type: 'client_credential' });
  const tok = r && r.data && r.data.access_token;
  if (!tok) throw new Error('token failed: ' + JSON.stringify(r).slice(0, 200));
  const ttl = ((r.data && r.data.expires_in) || 7200) * 1000;
  _tok = { v: tok, exp: now + ttl - 60000 };
  log('token 刷新，', Math.round(ttl / 1000), 's');
  return tok;
}

// ---------- 调 gaming_con（X-Token；err_no 40004 自动刷 token 重试一次）----------
async function call(path, body, _retried) {
  const token = await getToken();
  const r = await postJSON(API_HOST, API_PATH + path, body, { 'X-Token': token });
  // ★★字段名修正（2026-07-30 · 线上实测）：gaming_con 系列返回的是 {errcode,errmsg}，
  //   不是 {err_no,err_msg}。旧代码只读 err_no → 恒 undefined，造成两个后果：
  //     ① 40004「access token is expired」的自动重刷【从未触发过】，token 一过期该模块就全线哑火；
  //     ② 告警打成 "err_no=undefined"，看着像误报。
  //   我今天一度把告警条件收紧成 `err_no != null`，等于把真错误一起吞了 —— 那次判断是错的，此处纠正。
  //   现在两种字段名都兼容，err_no 优先（万一别的接口用这套）。
  const code = r ? (r.err_no != null ? r.err_no : r.errcode) : undefined;
  const emsg = r ? (r.err_msg || r.errmsg || '') : '';
  if (code === 40004 && !_retried) { log('token 过期，强刷后重试', path); await getToken(true); return call(path, body, true); }
  if (code != null && code !== 0) log('⚠️', path, 'err=' + code, emsg);
  return r;
}

// ---------- 战绩来源 ----------
// ★2026-08-02 重构：本模块【不再自己攒账】，只负责把账上报给抖音平台。
//   数据全部读 server/ledger.js —— 那是玩法积分的唯一真源（客户端结算面板看到的也是它）。
//
//   为什么必须合并：旧代码这里有一本独立的 world/rounds，按【gift_value】累计；
//   而客户端按【pts】累计。真机 gift_value = 抖币×10，且这里压根不记点赞/评论 ——
//   于是同一个观众，小摇杆世界榜上的分是结算面板里的十几倍，两个数永远对不上。
//   现在统一到 ledger 的 pts 口径：主播、观众、平台三处看到的是同一个数。
//
//   rounds 只留【平台需要的对局元信息】（round_id / start_time / 该场主播），
//   参与者和分数临上报时从 ledger 现取。
const rounds = new Map();   // roomId -> { roundId, startTime, anchor }

// 持久化已随账本一起搬到 ledger.js（Redis hash `qd:acct`）。
// 旧的 `qd:world:month_*` 不再读写 —— 那是 gift_value 口径的老表，与新账本单位不同，
// 混用只会让名次错乱。内测期无真实数据，直接弃用；要清可 `/api/ledger/reset`。

function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }
const nowSec = () => Math.floor(Date.now() / 1000);

// 查某 open_id 的世界榜名次(1-based)；不在榜返回 0。入场视频档位靠它（前百分档播不同视频）。
// ★口径 = 账本的 total（总积分），与玩法里「世界榜」的定义、结算面板那个 tab 完全一致。
// ★不再受 ENABLED(APPSECRET) 门控：入场视频是玩法自己的表现，不该因为没配 secret 就整个失灵
//   —— 旧代码那个门控是因为名次算在上报模块里，属于历史耦合。
function worldRankOf(openId) { return ledger.rankOfTotal(openId); }

// 用户快捷选队②:上报观众阵营(gaming_con/round/upload_user_group_info·观众加入阵营时调)。
// group_id=side(left/right·与后台 Group_ID 一致);round_id 取当前对局(无则 nowSec 兜)。无 secret 静默降级。
async function uploadUserGroup(openId, groupId, roomId) {
  if (!ENABLED || !openId || (groupId !== 'left' && groupId !== 'right')) return;
  const R = roomId && rounds.get(roomId);
  const roundId = R ? R.roundId : nowSec();
  try {
    await call('round/upload_user_group_info', { app_id: APP_ID, open_id: openId, group_id: groupId, room_id: roomId || '', round_id: roundId });
  } catch (e) { log('uploadUserGroup 失败', e.message); }
}

// 诊断(临时·用完删):手动打三个 API 看真实 err_no —— 查 secret/权限/参数到底卡哪。不受 ENABLED 门控。
async function selfTestTeam(roomId, anchorOpenId) {
  const anchor = anchorOpenId || ANCHOR_OPEN_ID;
  const uid = anchorOpenId || 'selftest_user';    // upload 的 open_id 也用传入的真 openid
  const rid = nowSec();
  const out = { appSecretSet: !!APP_SECRET, enabled: ENABLED, anchor: anchor ? anchor.slice(0, 10) : '(空)', app_id: APP_ID, tokenHead: '' };
  try { const t = await getToken(); out.tokenHead = (t || '').slice(0, 12) + '…'; } catch (e) { out.tokenHead = 'TOKEN_ERR: ' + e.message; }
  try { const r = await call('round/sync_status', { app_id: APP_ID, anchor_open_id: anchor, room_id: roomId, round_id: rid, start_time: rid, status: 1 }); out.sync_start = JSON.stringify(r); }
  catch (e) { out.sync_start = 'ERR: ' + e.message; }
  try { const r = await call('round/upload_user_group_info', { app_id: APP_ID, open_id: uid, group_id: 'left', room_id: roomId, round_id: rid }); out.upload = JSON.stringify(r); }
  catch (e) { out.upload = 'ERR: ' + e.message; }
  try { const r = await call('round/sync_status', { app_id: APP_ID, anchor_open_id: anchor, room_id: roomId, round_id: rid, start_time: rid, end_time: nowSec(), status: 2, group_result_list: [{ group_id: 'left', result: 1 }, { group_id: 'right', result: 2 }] }); out.sync_end = JSON.stringify(r); }
  catch (e) { out.sync_end = 'ERR: ' + e.message; }
  return out;
}

// ---------- 本局榜编排 ----------
async function startRound(roomId, anchorOpenId) {
  if (!ENABLED || !roomId) return;
  const anchor = anchorOpenId || ANCHOR_OPEN_ID;  // 当前对局主播 openid（start_game 用主播 token 动态换出）·env 仅兜底
  const roundId = nowSec();                       // round_id 同房间内递增，用开局时间戳（文档建议）
  rounds.set(roomId, { roundId, startTime: roundId, anchor });   // 只存元信息，参与者临上报时从 ledger 取
  try {
    await call('round/sync_status', { app_id: APP_ID, anchor_open_id: anchor, room_id: roomId, round_id: roundId, start_time: roundId, status: 1 });
    log('对局开始', roomId, '#' + roundId, '主播', (anchor || '(空)').slice(0, 8));
  } catch (e) { log('startRound 失败', e.message); }
}

// round_result: 1胜 2负 3平（winnerSide==='tie' 则全平）
function roundResultOf(side, winnerSide) {
  if (winnerSide === 'tie') return 3;
  return side === winnerSide ? 1 : 2;
}

async function endRound(roomId, winnerSide) {
  if (!ENABLED) return;
  const R = rounds.get(roomId);
  if (!R) { log('endRound: 无活动对局', roomId); return; }
  const anchor = R.anchor || ANCHOR_OPEN_ID;      // 用开局存的该场主播 openid·env 兜底
  const end = nowSec();
  // 本局参与者从账本现取（fresh = 本局贡献，pts 口径，与客户端结算面板同一个数）。
  // ★index.js 里 ledger.settle() 跑在本函数【之前】，所以 winStreak 已是本局结果，可直接上报。
  const ranked = ledger.roundList();
  const userItems = ranked.map((u) => ({
    open_id: u.openId, rank: u.rank, score: u.score,
    round_result: roundResultOf(u.side, winnerSide),
    winning_points: u.score, winning_streak_count: u.winStreak || 0,
  }));
  const groupResult = [
    { group_id: 'left', result: winnerSide === 'tie' ? 3 : (winnerSide === 'left' ? 1 : 2) },
    { group_id: 'right', result: winnerSide === 'tie' ? 3 : (winnerSide === 'right' ? 1 : 2) },
  ];
  try {
    // 1) 同步对局结束（带阵营结果）
    await call('round/sync_status', { app_id: APP_ID, anchor_open_id: anchor, room_id: roomId, round_id: R.roundId, start_time: R.startTime, end_time: end, status: 2, group_result_list: groupResult });
    // 2) 个人数据区：全部参与者，分批 ≤50
    for (const part of chunk(userItems, USER_BATCH)) {
      await call('round/upload_user_result', { app_id: APP_ID, anchor_open_id: anchor, room_id: roomId, round_id: R.roundId, user_list: part });
    }
    // 3) 榜单区：Top150（已排序）
    await call('round/upload_rank_list', { app_id: APP_ID, anchor_open_id: anchor, room_id: roomId, round_id: R.roundId, rank_list: userItems.slice(0, RANK_TOP) });
    // 4) 标记完成 → 小摇杆「本局榜」展示
    await call('round/complete_upload_user_result', { app_id: APP_ID, anchor_open_id: anchor, room_id: roomId, round_id: R.roundId, complete_time: nowSec() });
    log('对局结束上报完成', roomId, '#' + R.roundId, '参与', userItems.length, '胜方', winnerSide);
  } catch (e) { log('endRound 失败', e.message); }

  // 连胜次数已由 ledger.settle() 在结算时算好并落盘（原本这里再算一遍 = 两套连胜口径打架）。
  ledger.flush().catch(() => {});   // 局末立刻落一次，别等 2s 定时器（这会儿最容易被部署打断）
  rounds.delete(roomId);
  worldTick().catch(() => {});                     // 对局结束顺手刷一次世界榜
}

// ---------- 世界榜编排（月榜）----------
// world_rank_version 用「month_YYYYMM」。换月时 setValidVersion 切新版本。
function worldVersion(d) { d = d || new Date(); return 'month_' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0'); }
let _curVer = '';
async function worldEnsureVersion() {
  if (!ENABLED) return;
  const v = worldVersion();
  if (v === _curVer) return;
  // ★只有真成功才认（2026-07-30 修）：旧写法不看返回值就 _curVer=v 并打「生效版本」，
  //   接口报错也显示成功，且 _curVer 被记住 → 后续永不重试。我上次正是被这行误导 ——
  //   看到「⚠️ 告警下一行紧跟着生效版本」就判定告警是误报，其实是告警对、这行在说谎。
  try {
    const r = await call('world_rank/set_valid_version', { app_id: APP_ID, is_online_version: IS_ONLINE, world_rank_version: v });
    const code = r ? (r.err_no != null ? r.err_no : r.errcode) : undefined;
    if (code != null && code !== 0) { log('世界榜生效版本【失败】', v, 'err=' + code); return; }
    _curVer = v; log('世界榜生效版本', v);
  } catch (e) { log('setValidVersion 失败', e.message); }
}

let _worldBusy = false;
async function worldTick() {
  if (!ENABLED || _worldBusy || ledger.size() === 0) return;
  _worldBusy = true;
  try {
    await worldEnsureVersion();
    const v = _curVer || worldVersion();
    // ★平台世界榜按【月分】排：world_rank_version 是 month_YYYYMM，跨月自然换榜，
    //   和账本 month 字段同周期。（入场视频档位用的是 total，两者定义不同，见 worldRankOf）
    const ranked = ledger.worldList();             // 世界 item：无 round_result/room/round
    const items = ranked.map((u) => ({ open_id: u.openId, rank: u.rank, score: u.score, winning_points: u.score, winning_streak_count: u.winStreak || 0 }));
    // 榜单区 Top150（qps 5/s，建议 30s 一次）
    await call('world_rank/upload_rank_list', { app_id: APP_ID, is_online_version: IS_ONLINE, world_rank_version: v, rank_list: items.slice(0, RANK_TOP) });
    // 个人数据区：前 1000 名（准实时），分批 ≤50
    for (const part of chunk(items.slice(0, RANK_CAP), USER_BATCH)) {
      await call('world_rank/upload_user_result', { app_id: APP_ID, is_online_version: IS_ONLINE, world_rank_version: v, user_list: part });
    }
  } catch (e) { log('worldTick 失败', e.message); }
  finally { _worldBusy = false; }
}

let _cron = null;
function startWorldCron(ms) {
  if (!ENABLED || _cron) return;
  _cron = setInterval(() => worldTick().catch(() => {}), ms || 30000);   // 文档建议 30s 刷 Top150
  log('世界榜定时刷新启动 (' + Math.round((ms || 30000) / 1000) + 's)');
}
function stopWorldCron() { if (_cron) { clearInterval(_cron); _cron = null; } }

// 运维：清世界榜内存。prefix 非空 → 只删 openId 以它开头的（定点清联调假号，保住真实累计）；
// 空 → 全清。返回 {removed, left, samples}。
// ★为什么需要它（2026-08-01）：world 是进程内存，联调时打的测试假号会一直占着榜前排，
//   真实观众名次被挤到后面、入场视频档位就不对。以前只能靠「重新部署一次」冲掉——
//   而部署要登控制台，登录态一掉就卡死。有了这条，一行 curl 定点清，不惊动线上。
// 清榜/查榜都转给账本（同一本账，别再开第二个入口）。
const resetWorld = (prefix) => ledger.reset(prefix);
const worldPeek = (limit) => ledger.peek(limit);

module.exports = {
  enabled: ENABLED,
  startRound, endRound, uploadUserGroup, selfTestTeam,
  worldEnsureVersion, worldTick, startWorldCron, stopWorldCron, worldRankOf,
  resetWorld, worldPeek,
  _state: { rounds },     // 自测用
};

// ============================================================
//  联调清单（提审/真机开播前逐项核对）
//  1. 启用 AppSecret（开发配置页），并把 secret 配到服务端环境变量 APPSECRET。
//  2. 配 ANCHOR_OPEN_ID（主播 openid）；调试成员阶段 RANK_ONLINE 不设(=false)。
//  3. ★ 核对 open_id：本模块用礼物回调里的用户标识(sec_openid)当 open_id 上报，
//     需在自查工具/真机首条数据确认它与战绩接口要求的 open_id 同源（不同则需换字段/转换）。
//  4. ★ 世界榜 world Map 为进程内存，抖音云实例重启即丢 → 生产需落盘/接 KV/DB 做跨重启持久化。
//  5. round_id 同房间内须递增（本模块用开局秒级时间戳，满足）。
//  6. winning_points/winning_streak_count 当前为「本局分/世界连胜」，按运营口径可再调。
// ============================================================
