// ============================================================
//  server/ranking.js · 用户战绩与排行榜（抖音直播玩法 服务端 OpenAPI 接入）
//  ------------------------------------------------------------
//  纯服务端上报，抖音「小摇杆」展示「本局榜 / 世界榜 / 我的面板」。
//  本模块封装：token 管理 + 8 个 OpenAPI 接口 + 按 open_id 累计战绩
//  + 对局(本局榜)编排 + 世界榜(跨场月榜)编排 + 世界榜定时刷新。
//
//  对外（被 index.js 调用）：
//    recordGift({openId, side, value, roomId})  收到礼物时累计该用户战绩
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
  if (r && r.err_no === 40004 && !_retried) { await getToken(true); return call(path, body, true); }
  if (r && r.err_no !== 0) log('⚠️', path, 'err_no=' + r.err_no, r.err_msg || '');
  return r;
}

// ---------- 战绩累计 ----------
// round: roomId -> { roundId, startTime, users:Map<openId,{score,side}> }
// world: openId -> { score, streak, lastWin }   （跨场累计；★ 进程内存，重启即丢，生产需落盘/KV，见联调清单）
const rounds = new Map();
const world = new Map();

function recordGift({ openId, side, value, roomId }) {
  if (!ENABLED || !openId) return;
  const v = Math.max(0, Number(value) || 0);
  // 本局累计
  let R = rounds.get(roomId);
  if (R) { const u = R.users.get(openId) || { score: 0, side }; u.score += v; u.side = side; R.users.set(openId, u); }
  // 世界累计
  const w = world.get(openId) || { score: 0, streak: 0, lastWin: false };
  w.score += v; world.set(openId, w);
}

// 排序取榜：[{openId, score, side}] desc，附 rank（>1000 封顶）
function rankList(map) {
  const arr = [...map.entries()].map(([openId, u]) => ({ openId, ...u })).sort((a, b) => b.score - a.score);
  arr.forEach((u, i) => { u.rank = Math.min(i + 1, RANK_CAP); });
  return arr;
}
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }
const nowSec = () => Math.floor(Date.now() / 1000);

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

// ---------- 本局榜编排 ----------
async function startRound(roomId) {
  if (!ENABLED || !roomId) return;
  const roundId = nowSec();                       // round_id 同房间内递增，用开局时间戳（文档建议）
  rounds.set(roomId, { roundId, startTime: roundId, users: new Map() });
  try {
    await call('round/sync_status', { app_id: APP_ID, anchor_open_id: ANCHOR_OPEN_ID, room_id: roomId, round_id: roundId, start_time: roundId, status: 1 });
    log('对局开始', roomId, '#' + roundId);
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
  const end = nowSec();
  const ranked = rankList(R.users);
  const userItems = ranked.map((u) => ({
    open_id: u.openId, rank: u.rank, score: u.score,
    round_result: roundResultOf(u.side, winnerSide),
    winning_points: u.score, winning_streak_count: 0,
  }));
  const groupResult = [
    { group_id: 'left', result: winnerSide === 'tie' ? 3 : (winnerSide === 'left' ? 1 : 2) },
    { group_id: 'right', result: winnerSide === 'tie' ? 3 : (winnerSide === 'right' ? 1 : 2) },
  ];
  try {
    // 1) 同步对局结束（带阵营结果）
    await call('round/sync_status', { app_id: APP_ID, anchor_open_id: ANCHOR_OPEN_ID, room_id: roomId, round_id: R.roundId, start_time: R.startTime, end_time: end, status: 2, group_result_list: groupResult });
    // 2) 个人数据区：全部参与者，分批 ≤50
    for (const part of chunk(userItems, USER_BATCH)) {
      await call('round/upload_user_result', { app_id: APP_ID, anchor_open_id: ANCHOR_OPEN_ID, room_id: roomId, round_id: R.roundId, user_list: part });
    }
    // 3) 榜单区：Top150（已排序）
    await call('round/upload_rank_list', { app_id: APP_ID, anchor_open_id: ANCHOR_OPEN_ID, room_id: roomId, round_id: R.roundId, rank_list: userItems.slice(0, RANK_TOP) });
    // 4) 标记完成 → 小摇杆「本局榜」展示
    await call('round/complete_upload_user_result', { app_id: APP_ID, anchor_open_id: ANCHOR_OPEN_ID, room_id: roomId, round_id: R.roundId, complete_time: nowSec() });
    log('对局结束上报完成', roomId, '#' + R.roundId, '参与', userItems.length, '胜方', winnerSide);
  } catch (e) { log('endRound 失败', e.message); }

  // 世界累计连胜（赢的一方 +1，输的清零）
  for (const u of ranked) {
    const w = world.get(u.openId); if (!w) continue;
    const win = winnerSide !== 'tie' && u.side === winnerSide;
    w.streak = win ? (w.streak || 0) + 1 : 0; w.lastWin = win;
  }
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
  try { await call('world_rank/set_valid_version', { app_id: APP_ID, is_online_version: IS_ONLINE, world_rank_version: v }); _curVer = v; log('世界榜生效版本', v); }
  catch (e) { log('setValidVersion 失败', e.message); }
}

let _worldBusy = false;
async function worldTick() {
  if (!ENABLED || _worldBusy || world.size === 0) return;
  _worldBusy = true;
  try {
    await worldEnsureVersion();
    const v = _curVer || worldVersion();
    const ranked = rankList(world);                // 世界 item：无 round_result/room/round
    const items = ranked.map((u) => ({ open_id: u.openId, rank: u.rank, score: u.score, winning_points: u.score, winning_streak_count: u.streak || 0 }));
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

module.exports = {
  enabled: ENABLED,
  recordGift, startRound, endRound, uploadUserGroup,
  worldEnsureVersion, worldTick, startWorldCron, stopWorldCron,
  _state: { rounds, world },     // 自测用
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
