// ============================================================
//  server/douyincloud.js · 抖音云「真机生产」接入层
//  ------------------------------------------------------------
//  生产模型(区别于 dev 的 /cb/* + SSE，见 index.js)：
//    抖音平台 ──内网专线──▶ /live_data_callback(单一回调) ──translate──▶
//    抖音云 WS 网关(/ws/live_interaction/push_data) ──▶ 主播玩法客户端
//  全部走抖音云内网：免域名备案、免 access_token、免 https（仅当服务部署在抖音云时这些 host 才解析）。
//
//  服务端需实现的 4 个接口（本层提供 handler，index.js 路由）：
//    POST /start_game        客户端开局 → 请求头拿 room/主播信息 → 开推送任务
//    POST /live_data_callback 抖音内网推互动数据(数组) → translate → WS 网关下行 + 战绩累计
//    GET|POST /websocket_callback 网关转发 客户端建连/断连/上行(x-tt-event-type)
//    POST /finish_game       一局结束 → 战绩结算上报
//
//  ⚠️ 客户端如何连 WS 网关收数据(Unity SDK / 自定义域名+get_conn_id)是另一块，见项目计划 B。
// ============================================================
'use strict';
const http = require('http');
const dy = require('./douyin');
const rank = require('./ranking');
const cfg = require('./config');

const APP_ID = cfg.APPID;
const OPENAPI_HOST = 'webcast-bytedance-com.openapi.dyc.ivolces.com';  // 内网专线 OpenAPI：免 token/https
const WS_GATEWAY = 'ws-push.dyc.ivolces.com';                          // 抖音云 WS 网关
// 开局要开启的推送任务类型（选队等进阶类型的 msg_type 待「用户快捷选队」文档确认后补）
const TASK_MSG_TYPES = ['live_gift', 'live_like', 'live_comment', 'live_fansclub'];
let lastAnchorOpenId = '';   // 最近开局主播 openid（token 置换得到，供下行/战绩用）

function log(...a) { console.log('[dyc]', ...a); }

// 内网 HTTP POST（无 https、无 access_token）。仅在抖音云内网可解析这些 host。
function postInternal(host, path, body, headers) {
  const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body || {}));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({ raw: b }); } }); }
    );
    req.on('error', reject); req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

// ── 下行：把一条玩法指令经 WS 网关推给主播客户端 ──
async function pushToClient(anchorOpenId, msgId, msgType, dataStr) {
  if (!anchorOpenId) return;
  try {
    const r = await postInternal(WS_GATEWAY, '/ws/live_interaction/push_data',
      { msg_id: String(msgId || Date.now()), msg_type: msgType, data: dataStr },
      { 'X-TT-WS-OPENIDS': JSON.stringify([anchorOpenId]) });
    if (r && r.err_no !== 0 && r.err_no !== undefined) log('⚠️ WS 下行 err_no=' + r.err_no, r.err_msg || '');
  } catch (e) { log('WS 下行异常', e.message); }
}

// ── 开启直播间推送任务（/start_game 时，按 msg_type 逐个开）──
async function startTasks(roomId) {
  for (const t of TASK_MSG_TYPES) {
    try {
      const r = await postInternal(OPENAPI_HOST, '/api/live_data/task/start', { roomid: roomId, appid: APP_ID, msg_type: t });
      log(t, r && r.err_no === 0 ? '任务开启 ✓' : ('开启失败 ' + JSON.stringify(r).slice(0, 120)));
    } catch (e) { log(t, '开启异常', e.message); }
  }
}

// ── token → 直播间信息（非 SDK/Electron 路径用）──
// 直播伴侣以 -token 启动 exe，token 30 分钟有效；内网调用免 access_token。
// 公网等价接口 https://webcast.bytedance.com/api/webcastmate/info（需 x-token 头）。
// ⚠ room_id 是 19 位大整数，JSON.parse 会丢精度 → 从原始响应正则取字符串。
function getLiveInfo(token) {
  return new Promise((resolve) => {
    if (!token) return resolve(null);
    const data = Buffer.from(JSON.stringify({ token }));
    const req = http.request(
      { host: OPENAPI_HOST, path: '/api/webcastmate/info', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        const m = b.match(/"room_id"\s*:\s*"?(\d+)"?/);                 // 大整数取字符串，绕开精度丢失
        let info = {}; try { info = ((JSON.parse(b).data) || {}).info || {}; } catch (_) {}
        resolve({ roomId: m ? m[1] : '', anchorOpenId: info.anchor_open_id || '', avatarUrl: info.avatar_url || '', nickName: info.nick_name || '' });
      }); });
    req.on('error', () => resolve(null)); req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

// ── handler: /start_game（客户端开局）──
// SDK 路径：room/主播信息在请求头（callContainer 内网注入）。
// 非 SDK(Electron) 路径：请求头没有 → 用 body.token 调「直播信息」置换 room/主播。
async function startGame(headers, body) {
  const ctx = {
    appId: headers['x-tt-appid'] || APP_ID,
    roomId: headers['x-room-id'] || '',
    anchorOpenId: headers['x-anchor-openid'] || '',
    avatarUrl: headers['x-avatar-url'] || '',
    nickName: headers['x-nick-name'] || '',
  };
  if (!ctx.roomId && body && body.token) {
    const info = await getLiveInfo(body.token);
    if (info && info.roomId) {
      ctx.roomId = info.roomId;
      ctx.anchorOpenId = info.anchorOpenId || ctx.anchorOpenId;
      ctx.avatarUrl = info.avatarUrl || ctx.avatarUrl;
      ctx.nickName = info.nickName || ctx.nickName;
      log('token 置换 ✓ room=' + ctx.roomId + ' 主播=' + ctx.nickName);
    } else log('token 置换失败（端点/有效期？）');
  }
  log('开局', ctx.roomId, ctx.nickName);
  if (ctx.anchorOpenId) lastAnchorOpenId = ctx.anchorOpenId;     // 供下行 pushToClient / 战绩用
  if (ctx.roomId) await startTasks(ctx.roomId);
  if (ctx.roomId) rank.startRound(ctx.roomId);          // 本局榜：开局
  return ctx;
}

// ── handler: /live_data_callback（抖音内网推互动数据，body 为数组）──
// 头 x-msg-type + X-Anchor-OpenID；逐条 translate → WS 下行 → 战绩累计。
async function liveDataCallback(headers, rawBody) {
  const msgType = headers['x-msg-type'] || '';
  // ⚠ 抖音内网回调头不一定带主播 openid（多为 x-roomid 等）→ 回退用开局 /start_game token 置换存的 lastAnchorOpenId。
  // 否则 pushToClient 拿不到 openid 会直接 return、不下行 → 礼物翻译成功(applied>0)但游戏全没反应。
  const anchorOpenId = headers['x-anchor-openid'] || lastAnchorOpenId;
  let items; try { items = JSON.parse(rawBody || '[]'); } catch (_) { items = []; }
  if (!Array.isArray(items)) items = [items];
  log('收到回调 type=' + msgType + ' 条数=' + items.length +
      ' anchor=' + (headers['x-anchor-openid'] ? '头携带' : (lastAnchorOpenId ? '回退开局存的' : '⚠️空(下行会丢,exe 没开过局?)')));
  for (const item of items) {
    const events = dy.translate(msgType, item, cfg.DEFAULT_SIDE);     // → [{side,key,count}]
    if (events.length) {
      log('→ 翻译', JSON.stringify(events), '下行至', anchorOpenId ? (anchorOpenId.slice(0, 10) + '…') : '⚠️无openid(不下行)');
      await pushToClient(anchorOpenId, item.msg_id, msgType, JSON.stringify(events));
    } else {
      log('→ 翻译为空 type=' + msgType + ' gift_id=' + (item.sec_gift_id || '-') + ' val=' + (item.gift_value || item.diamond || '-') + '(礼物没置顶映射? 或未选队且 DEFAULT_SIDE=ignore?)');
    }
    // 战绩累计（礼物驱动每用户分）
    if (msgType === 'live_gift') {
      const openId = item.sec_openid || item.sec_open_id;
      rank.recordGift({ openId, side: dy.sideOf(openId, cfg.DEFAULT_SIDE), value: item.gift_value || item.diamond, roomId: item.room_id || '' });
    }
  }
  return items.length;
}

// ── handler: /websocket_callback（网关转发 客户端建连/断连/上行）──
function websocketCallback(headers, rawBody) {
  const ev = headers['x-tt-event-type'];
  const openId = headers['x-tt-openid'] || '';
  if (ev === 'connect') log('客户端建连', openId);
  else if (ev === 'disconnect') log('客户端断连', openId);
  else if (ev === 'uplink') log('客户端上行', openId, (rawBody || '').slice(0, 120));
  return ev || 'unknown';
}

// ── handler: /finish_game（一局结束 → 战绩结算）──
async function finishGame(headers, rawBody) {
  let body = {}; try { body = JSON.parse(rawBody || '{}'); } catch (_) {}
  const roomId = headers['x-room-id'] || body.room_id || '';
  const winner = body.winner === 'left' || body.winner === 'right' ? body.winner : 'tie';
  log('结束对局', roomId, '胜方', winner);
  if (roomId) await rank.endRound(roomId, winner);     // 本局榜上报 + 触发世界榜
  return { roomId, winner };
}

// 取 websocket 连接ID（客户端建连前用；服务端内网调网关，token 透传以绑定直播间信息）
// 网关响应 {err_no,err_msg,data:"{\"conn_id\":\"...\"}"}（data 是 JSON 字符串，需二次 parse）
async function getConnId(token) {
  try {
    const r = await postInternal(WS_GATEWAY, '/ws/get_conn_id',
      { service_id: process.env.PK_SERVICE_ID || '1m3ugms2xb6sj', env_id: process.env.PK_ENV_ID || 'env-EHxqcRUgjW', token: token || '' });
    if (r && r.data) { const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; return d.conn_id || ''; }
    return '';
  } catch (e) { log('getConnId 异常', e.message); return ''; }
}

module.exports = { startGame, liveDataCallback, websocketCallback, finishGame, pushToClient, startTasks, getConnId, getLiveInfo, getAnchorOpenId: () => lastAnchorOpenId };
