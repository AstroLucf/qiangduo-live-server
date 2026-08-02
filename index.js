// ============================================================
//  server/index.js · 直播小玩法 本地服务端（零依赖 · 原生 http + SSE）
//  ------------------------------------------------------------
//  链路：抖音回调 /cb/* → 验签 → translate() → SSE 广播 /events
//        → 客户端 liveBridge 回放 PK_DEBUG.support()
//  本机自测（不依赖抖音）：
//        POST /mock/gift?side=left&key=donut&count=1
//  运行：node server/index.js   （或 cd server && npm start）
// ============================================================
'use strict';
const http = require('http');
const { URL } = require('url');
const cfg = require('./config');
const dy = require('./douyin');
const rank = require('./ranking');
const dyc = require('./douyincloud');     // 抖音云生产接入层（真机：内网回调 + WS 网关下行）
const kv = require('./kv');               // 世界榜持久化（诊断用，/health 里回显状态）
const ut = require('./userTeam');         // 「用户快捷选队」开发者侧接口（小摇杆点选阵营）
const pool = require('./pool');           // 积分池底池存档（按主播 openid 持久化到 Redis）
const ledger = require('./ledger');       // 观众积分账本（服务端真源：计分/结算/周月榜/连胜）

// ── 实例指纹：FaaS 会把服务复制成多个实例分摊流量。每个实例进程启动时生成唯一 ID。
//    连续刷 /health 若看到多个不同 instance → 多实例（这正是 SSE 0 端的根：连接与回调落不同实例）。
const INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const BOOT_AT = new Date().toISOString();
let sseSeen = 0;             // 本实例累计见过的 SSE 接入次数（跨实例不共享，仅本实例计数）

const clients = new Set();   // 当前 SSE 连接
let lastRoomId = '';         // 最近一次回调的 room_id（/round/* 缺省用它）
let currentRound = { id: 0, status: 2 };   // 当前对局（供「用户快捷选队」查询/选择阵营接口返回 round_id/round_status·1开始2结束）

// ── SSE 断点续传：抖音云网关对长连接约 60s 强制掐断 → EventSource 重连，
//    重连间隙内 broadcast 的礼物会丢。给每批事件编单调递增 seq + 环形缓冲，
//    客户端重连自动带 Last-Event-ID（SSE 原生），服务端补发缺口 → 间隙不丢。
//    ⚠ 缓冲是进程内存：补发依赖「SSE 连接与回调落同一实例」，故内测需把抖音云实例数设为 1
//      （或后续上 KV）。多实例需另解，见 douyincloud.js 的 WS 网关生产链路（不走 SSE，无此限）。
let eventSeq = 0;                    // 全局单调递增事件序号（= SSE id）
const recentEvents = [];             // 环形缓冲：[{ seq, frame }]，最近 REPLAY_MAX 条已广播事件
const REPLAY_MAX = 256;              // 容量：60s 内礼物远不及此；超出则最老的丢（极端积压才触顶）
const recentRawGifts = [];           // 诊断：最近原始礼物 [{sec_gift_id, gift_value, key, nick}]，供 /rawgifts 回填 GIFT_ID_TO_KEY

// ── 开发期同源静态托管 + 沙盒测试台（cfg.SERVE_STATIC=1；云端不开，故 / 仍是健康探针）──
const fs = require('fs');
const pathMod = require('path');
const STATIC_ROOT = pathMod.join(__dirname, '..');      // 游戏文件在 server 的上一级
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
function serveStatic(reqPath, res) {
  const rel = decodeURIComponent(reqPath).replace(/^\/+/, '') || 'index.html';
  const full = pathMod.join(STATIC_ROOT, rel);
  if (!full.startsWith(STATIC_ROOT)) return json(res, 403, { ok: false, err: 'forbidden' });   // 防目录穿越
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { ok: false, err: 'not found' });
    cors(res);
    res.writeHead(200, { 'Content-Type': MIME[pathMod.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

// 可视化沙盒测试台：模拟观众「选队+送礼/点赞/评论」走完整服务端管线，配合游戏标签实时看反应
const TEST_PANEL = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>沙盒测试台 · 抢夺45分钟</title>
<style>
body{background:#15171c;color:#e8e8ea;font:14px/1.6 system-ui,-apple-system,sans-serif;margin:0;padding:18px}
h1{font-size:17px;margin:0 0 4px}.hint{color:#9aa0a6;font-size:12px;margin:0 0 16px}.hint b{color:#cdd2d8}
.cols{display:flex;gap:14px;flex-wrap:wrap}
.col{flex:1;min-width:230px;background:#1e2128;border:1px solid #2a2e37;border-radius:12px;padding:14px}
.col h2{font-size:14px;margin:0 0 10px}.L h2{color:#ff7a59}.R h2{color:#5b9bff}
button{display:block;width:100%;margin:7px 0;padding:10px;border:0;border-radius:8px;background:#2b2f38;color:#e8e8ea;font-size:13px;cursor:pointer;transition:background .12s}
button:hover{background:#3a3f4a}.g{background:#33271e}.g:hover{background:#46362a}
.misc{display:flex;gap:8px;margin-top:6px}.misc button{margin:0}
#log{margin-top:16px;background:#0e1014;border:1px solid #23262d;border-radius:8px;padding:10px;height:150px;overflow:auto;font:12px/1.7 ui-monospace,monospace;color:#86d98a}
</style></head><body>
<h1>🎮 沙盒测试台 · 抢夺45分钟</h1>
<p class="hint">另开标签打开 <b>/index.html?live=1</b>（游戏），点下方按钮 → 模拟抖音观众走完整服务端管线（回调→翻译→SSE→游戏）。每次轮换一名观众（带<b>真实昵称+头像</b>），首次互动自动发“<b>1/2</b>”<b>评论选队</b>；<b>重复点同名观众</b>验证“小火箭不重复生成”。</p>
<div class="cols">
 <div class="col L"><h2>帮大壮（左）</h2>
  <button class="g" data-side="left" data-v="1">仙女棒 ×1</button><button class="g" data-side="left" data-v="10">药丸 ×10</button><button class="g" data-side="left" data-v="52">甜甜圈 ×52</button><button class="g" data-side="left" data-v="99">电池 ×99</button><button class="g" data-side="left" data-v="299">话筒 ×299</button><button class="g" data-side="left" data-v="520">🪂 空投 ×520</button>
  <div class="misc"><button data-side="left" data-act="team">原生选队</button><button data-side="left" data-act="like">点赞</button><button data-side="left" data-act="comment">评论666</button></div></div>
 <div class="col R"><h2>帮小美（右）</h2>
  <button class="g" data-side="right" data-v="1">仙女棒 ×1</button><button class="g" data-side="right" data-v="10">药丸 ×10</button><button class="g" data-side="right" data-v="52">甜甜圈 ×52</button><button class="g" data-side="right" data-v="99">电池 ×99</button><button class="g" data-side="right" data-v="299">话筒 ×299</button><button class="g" data-side="right" data-v="520">🪂 空投 ×520</button>
  <div class="misc"><button data-side="right" data-act="team">原生选队</button><button data-side="right" data-act="like">点赞</button><button data-side="right" data-act="comment">评论666</button></div></div>
</div>
<div id="log"></div>
<script>
var NAMES={left:['大壮真爱粉','打工人老李','二郎腿哥','吃瓜群众','复读机'],right:['小美贴贴','学委同桌','奶茶续命','榜一大姐','摸鱼怪']};
var seq={left:0,right:0},chosen={};
function logln(m){var d=document.createElement('div');d.textContent=new Date().toLocaleTimeString()+'  '+m;var L=document.getElementById('log');L.insertBefore(d,L.firstChild);}
function post(p,b){return fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();}).catch(function(e){return {err:String(e)};});}
function pick(side){var i=seq[side]++%NAMES[side].length;return {uid:'u_'+side+'_'+i,name:NAMES[side][i]};}
function ava(uid){return 'https://api.dicebear.com/9.x/thumbs/png?seed='+encodeURIComponent(uid)+'&size=80';}
function ensure(u,side){if(chosen[u.uid])return Promise.resolve();chosen[u.uid]=side;return post('/cb/comment',{sec_openid:u.uid,content:side==='left'?'1':'2',nickname:u.name,avatar_url:ava(u.uid)}).then(function(){logln('🏳️ '+u.name+' 发“'+(side==='left'?'1':'2')+'” 加入'+(side==='left'?'大壮':'小美')+'队');});}
function gift(side,v){var u=pick(side);ensure(u,side).then(function(){return post('/cb/gift',{sec_openid:u.uid,gift_value:v,gift_num:1,nickname:u.name,avatar_url:ava(u.uid)});}).then(function(r){logln('🎁 '+u.name+' 送 价值'+v+' → applied:'+(r&&r.applied!==undefined?r.applied:'?'));});}
function misc(side,act){var u=pick(side);ensure(u,side).then(function(){return post('/cb/'+act,{sec_openid:u.uid,content:act==='comment'?'666':'',nickname:u.name,avatar_url:ava(u.uid)});}).then(function(r){logln((act==='like'?'👍 ':'💬 ')+u.name+' → applied:'+(r&&r.applied!==undefined?r.applied:'?'));});}
function teamRaw(side){var u=pick(side);chosen[u.uid]=side;return post('/cb/team',{sec_openid:u.uid,side:side,nickname:u.name,avatar_url:ava(u.uid)}).then(function(r){logln('🎮 原生选队 '+u.name+' → '+(side==='left'?'大壮':'小美')+' applied:'+(r&&r.applied!==undefined?r.applied:'?'));});}
Array.prototype.forEach.call(document.querySelectorAll('button'),function(b){b.onclick=function(){var s=b.getAttribute('data-side'),v=b.getAttribute('data-v'),act=b.getAttribute('data-act');if(v)gift(s,parseInt(v,10));else if(act==='team')teamRaw(s);else misc(s,act);};});
logln('就绪 — 点按钮，看游戏标签实时反应（同名观众重复点 → 小火箭不应重复生成）');
</script></body></html>`;

function broadcast(events) {
  if (!events || !events.length) return;
  // 用户快捷选队②:观众加入阵营(首次落座=join)时上报阵营给平台。评论/礼物/小摇杆选队 各入口统一在此上报。
  for (const e of events) { if (e.key === 'join' && e.openid && (e.side === 'left' || e.side === 'right')) rank.uploadUserGroup(e.openid, e.side, lastRoomId); }
  const seq = ++eventSeq;
  const frame = `id: ${seq}\ndata: ${JSON.stringify(events)}\n\n`;   // 带 SSE id → 客户端记住进度，断连重连可续传
  recentEvents.push({ seq, frame });
  if (recentEvents.length > REPLAY_MAX) recentEvents.shift();        // 环形：超容量丢最老
  for (const res of clients) { try { res.write(frame); } catch (_) {} }
  console.log(`[push] #${seq} ${events.map((e) => (e.type ? `${e.type}(${e.users ? e.users.length + '人·池' + e.pool : ''})` : `${e.side}:${e.key}×${e.count}`)).join('  ')}  → ${clients.size} 端`);
}

// ── 账本快照下行 ──
// 走的是同一条 SSE，不另开通道：礼物事件已经在这条线上，快照跟着走天然同步、零额外延迟。
// 节流 1.5s：礼物风暴时一秒几十条互动，每条都推整本账等于自己 DDoS 自己；
// 而积分池/榜单本来就是"看个大概"的显示，1.5s 完全够。开局/结算/结转 走 now=true 立刻推。
const LEDGER_PUSH_MS = 1500;
let _ledgerT = null, _ledgerPending = false;
function pushLedger(now) {
  if (!clients.size) return;                     // 没人连着就别算快照（snapshot 要排序整表）
  if (now) { clearTimeout(_ledgerT); _ledgerT = null; _ledgerPending = false; return broadcast([ledger.snapshot()]); }
  if (_ledgerT) { _ledgerPending = true; return; }
  broadcast([ledger.snapshot()]);
  _ledgerT = setTimeout(() => { _ledgerT = null; if (_ledgerPending) { _ledgerPending = false; pushLedger(); } }, LEDGER_PUSH_MS);
  if (_ledgerT.unref) _ledgerT.unref();
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }

// 回调路由 → msg_type_str
// 粉丝团[必接]：经典-角力品类要求绑定回调，但本游戏不消费粉丝团数据 →
// 登记进来只为让 /cb/fansclub 被 200 ack（translate 命中 default 返回 []，无游戏效果），避免 404。
const MSGTYPE = { gift: 'live_gift', like: 'live_like', comment: 'live_comment', team: 'team_select', fansclub: 'live_fansclub' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${cfg.PORT}`);
  // 抖音云外网只放行 /api/*：剥掉可选的 /api 前缀，使 /cb/gift 与 /api/cb/gift 等价（本地/云端同一套代码）
  const path = u.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  // 根路径：抖音云就绪探针可能 GET / 期望 2xx（别落到 404）
  if (path === '/' && req.method === 'GET') {
    return json(res, 200, { ok: true, service: 'qiangduo-live', clients: clients.size });
  }

  // 健康检查
  if (path === '/health') {
    // giftMap：部署校验用——重新部署后 curl /api/health，giftMap.battery=true 且 keys=6 = 新代码已上线（电池已精确映射）。
    const gm = dy.GIFT_ID_TO_KEY || {};
    // 把全表的 key 都列出来（原先只回 keys 数量 + battery 布尔，看不出少了哪一个）。
    // 6 个礼物一眼点名：wand/pill/donut/battery/mic/airdrop 谁 false 就是线上跑的表缺谁。
    const has = (k) => Object.values(gm).includes(k);
    const giftMap = {
      rev: '2026-08-02-giftmap-full', keys: Object.keys(gm).length,
      wand: has('wand'), pill: has('pill'), donut: has('donut'),
      battery: has('battery'), mic: has('mic'), airdrop: has('airdrop'),
    };
    // kv：世界榜持久化是否真的接上了（开通 Redis 后一眼确认，不用翻日志）
    return json(res, 200, { ok: true, instance: INSTANCE_ID, bootAt: BOOT_AT, clients: clients.size, sseSeen, appid: cfg.APPID, skipSign: cfg.DEV_SKIP_SIGN, defaultSide: cfg.DEFAULT_SIDE, giftMap, kv: kv.diag(), pool: pool.diag(), ledger: ledger.diag() });
  }

  // 诊断：最近广播的事件（自查工具/真机推送后，看服务端翻译+广播了什么——即使没有游戏连着也能看）。
  if (path === '/recent') {
    const recent = recentEvents.slice(-40).map((e) => {
      let events = []; try { const m = e.frame.match(/data: (.+)/); if (m) events = JSON.parse(m[1]); } catch (_) {}
      return { seq: e.seq, events };
    });
    return json(res, 200, { ok: true, instance: INSTANCE_ID, eventSeq, buffered: recentEvents.length, clients: clients.size, recent });
  }

  // 诊断：最近原始礼物身份（送一次礼物后开此网址，直接读 sec_gift_id 回填 douyin.js 的 GIFT_ID_TO_KEY）。
  // 用途：审核抓「能量电池→空投」这类漏配 → 送一个电池 → 这里找 gift_value=99 那条 → 复制 sec_gift_id。
  if (path === '/rawgifts') {
    return json(res, 200, {
      ok: true, instance: INSTANCE_ID,
      hint: '先看 mapped：false = 未登记礼物(已兜底成无效果的 wand)，复制 sec_gift_id 回填 douyin.js GIFT_ID_TO_KEY；' +
            '整条都找不到 = 平台没推该礼物 → 查 /api/failgifts，仍为空则是「玩法礼物配置没随包体过审」',
      gifts: recentRawGifts.slice(-30),
    });
  }

  // 诊断：拉抖音「推送失败数据」做补偿/定责。GET /api/failgifts?room=<roomid>&page=1&type=live_gift
  //   · 有数据 → 平台推过但没送达我们（网络/我方 5xx），payload 可直接补跑；
  //   · 空 且 /rawgifts 也没有该礼物 → 平台压根没推 = 该礼物不在当前生效的玩法礼物配置里。
  //   room 不传则用最近一次回调的 room_id。本地跑必然 reachable 失败（内网 host 只在抖音云解析）。
  if (path === '/failgifts') {
    const room = u.searchParams.get('room') || lastRoomId;
    const r = await dyc.failData(room, u.searchParams.get('type') || 'live_gift',
      parseInt(u.searchParams.get('page') || '1', 10), parseInt(u.searchParams.get('size') || '100', 10));
    return json(res, 200, { ok: true, room, resp: r });
  }

  // SSE：客户端订阅下行数值
  if (path === '/events' && req.method === 'GET') {
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',   // 禁反代缓冲：网关攒帧会让 SSE 卡顿
    });
    res.write('retry: 1500\n\n');                            // 重连延迟 3s→1.5s：掐断后更快恢复
    res.write(': connected\n\n');
    // 断点续传：重连时客户端自动带 Last-Event-ID（首连为空）→ 补发断连间隙漏掉的事件。
    // 整段同步执行（无 await）→ 补发与 add 在同一事件循环 tick 内原子完成，不与 broadcast 竞态。
    const lastId = parseInt(req.headers['last-event-id'] || u.searchParams.get('lastEventId') || '0', 10);
    if (lastId > 0) {
      const miss = recentEvents.filter((e) => e.seq > lastId);
      for (const e of miss) { try { res.write(e.frame); } catch (_) {} }
      if (miss.length) console.log(`[sse] 重连补发 ${miss.length} 条 (Last-Event-ID=${lastId})`);
    }
    clients.add(res); sseSeen++;
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
    // 主动 50s 优雅关闭：早于网关 ~60s 强制掐断，让客户端在可控时机收正常 EOF 后按 retry 重连，
    // 间隙更短更稳；配合上面的补发 → 跨重连零丢失。
    const cycle = setTimeout(() => { try { res.end(); } catch (_) {} }, 50000);
    req.on('close', () => { clearInterval(ping); clearTimeout(cycle); clients.delete(res); console.log(`[sse] 断开 (剩 ${clients.size})`); });
    console.log(`[sse] 接入 (共 ${clients.size})`);
    return;
  }

  // 抖音互动回调：/cb/gift /cb/like /cb/comment /cb/team
  if (path.startsWith('/cb/') && req.method === 'POST') {
    const msgType = MSGTYPE[path.slice(4)];
    if (!msgType) return json(res, 404, { ok: false, err: 'unknown callback' });
    const raw = await readBody(req);
    // 沙盒期抓字段：完整打印抖音推来的原始头+体，用首条真实样例锁 douyin.js 的 GIFT_ID_TO_KEY。上生产前收掉这行。
    console.log(`[cb] ${msgType}  x-msg-type=${req.headers['x-msg-type'] || '-'}  x-roomid=${req.headers['x-roomid'] || '-'}  x-signature=${req.headers['x-signature'] ? 'present' : '-'}  raw=${raw}`);
    // ★2026-07-30 临时诊断：把【所有 x-* 头】原样打一遍，找合法的 anchor_open_id。
    //   背景：发版检查要三个对局 API 的"成功调用记录"，而 sync_status 必填 anchor_open_id。
    //   自查工具的「用户 openID」(19位纯数字 UID) 实测被判「参数 anchor_open_id 不合法」，
    //   真主播 openid 目前只能靠 /start_game 的 token 置换拿 —— 但那需要直播伴侣启动 exe。
    //   如果平台在回调头里就带了主播身份(如 x-anchor-openid)，就能省掉整个开播环节。
    //   ⚠ 联调完删掉这行：它会把全部请求头打进日志。
    console.log(`[cb-hdr] ${msgType} ` + JSON.stringify(
      Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-')))));
    if (!cfg.DEV_SKIP_SIGN && !dy.verifySign(req.headers, raw, cfg.APPSECRET)) {
      return json(res, 401, { ok: false, err: 'bad signature' });
    }
    // ⚠ 抖音回调 raw 是数组 [{...}]（可能多条），不是单对象！之前直接把数组丢给 translate →
    //   payload.content/avatar_url/sec_openid 全取不到（数据在 [0] 里）→ 评论"1/2"不识别为选队、
    //   头像空、整批"0 事件被丢弃"。改为逐条 translate（与 douyincloud.js 生产路径一致）。
    let items; try { const p = JSON.parse(raw || '[]'); items = Array.isArray(p) ? p : [p]; } catch (_) { items = []; }
    const roomId = req.headers['x-roomid'] || (items[0] && items[0].room_id) || '';
    if (roomId) lastRoomId = roomId;
    let events = [];
    for (const item of items) {
      const evs = dy.translate(msgType, item, cfg.DEFAULT_SIDE);
      // 诊断：(空!)=该字段没取到
      if (evs[0]) console.log(`[cb→] side=${evs[0].side} key=${evs[0].key} openid=${evs[0].openid || '(空!)'} avatar=${evs[0].avatar ? '有' : '(空!)'} nick=${evs[0].nickname || '(空)'}`);
      else console.log(`[cb→] ${msgType} → 0 事件（未选队 / 字段取空被丢弃）`);
      events = events.concat(evs);
      // ★玩法积分入账（服务端真源）：按 gifts.js 的 pts 记，与客户端 GIFTS.pts 同口径。
      //   逐条 translate 结果记一次 —— 连击的 count 不重复计分，与客户端 `scoring: i===0` 对齐。
      //   ⚠ 必须在 noteInteraction【之前】：入场视频要按名次分档，而名次现在由账本算，
      //     先记账他才有名次。旧代码这条顺序是靠 recordGift 保证的，换真源后同样要守住。
      for (const ev of evs) ledger.record(ev);
      if (msgType === 'live_gift') {
        // 诊断：记原始礼物身份 → /rawgifts 一键读 sec_gift_id 回填映射表（尤其审核抓的漏配礼物）
        // ★mapped 必看：false = 这个 sec_gift_id 不在 GIFT_ID_TO_KEY 里，giftToKey 兜底成了 wand。
        //   而仙女棒自 2026-07-29 起是【纯升级道具】——没推力、没特效 —— 于是"未登记礼物"的表现
        //   就是【观众花了钱、游戏毫无反应】，与"平台压根没推"肉眼无法区分。这个标记就是用来区分的。
        recentRawGifts.push({
          at: new Date().toISOString().slice(11, 19),
          sec_gift_id: item.sec_gift_id || '',
          gift_value: item.gift_value ?? item.diamond ?? null,
          // ★key 必须直接由 sec_gift_id 反查，不能取 evs[0].key ——
          //   首次互动的观众，translate 会在礼物事件【前面】插一条 join，evs[0] 恒为 'join'，
          //   于是"新观众送的话筒"在这里显示成 join，看起来像话筒没到，实际是记错了。
          key: evs.length ? dy.giftToKey({ sec_gift_id: item.sec_gift_id, diamond: item.gift_value || item.diamond }) : '(丢弃)',
          mapped: !!(item.sec_gift_id && (dy.GIFT_ID_TO_KEY || {})[item.sec_gift_id]),
          nick: (evs[0] && evs[0].nickname) || dy.userOf(item).nickname || '',
        });
        if (recentRawGifts.length > 30) recentRawGifts.shift();
      }
      // ★入场视频触发（2026-08-01）：放在【记账之后】——首次互动就是送礼的新观众，
      //   要先把这一单计进账本，他才有名次；放前面的话第一次送礼的人永远播不出来。
      //   身份取 evs[0]（translate 已做 7 嵌套×8 字段名容错），没翻译出事件则回退 dy.userOf。
      ut.noteInteraction(evs[0] || dy.userOf(item), broadcast, rank.worldRankOf, msgType === 'live_gift');
    }
    broadcast(events);
    pushLedger();
    // TODO(联调)：收到并处理成功后，调抖音「履约数据上报」做 ack（去重 + 结算依据）。
    return json(res, 200, { ok: true, applied: events.length });
  }

  // 对局生命周期：客户端在「开始/KO」时调用，驱动本局榜/世界榜战绩上报。
  // 缺 room_id 时用最近回调的 room（生产由玩法启动参数带 room_id 更准）。
  if ((path === '/round/start' || path === '/round/end') && req.method === 'POST') {
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    const roomId = body.room_id || lastRoomId;
    if (path === '/round/start') {
      dy.clearSides(); ut.resetRoundEnter(); rank.startRound(roomId, dyc.getAnchorOpenId());
      await ledger.loadPool(dyc.getAnchorOpenId());   // 先把底池读回来，再开局（顺序不能反：开局会 savePool）
      ledger.startRound(dyc.getAnchorOpenId());
      currentRound = { id: currentRound.id + 1, status: 1 };
      pushLedger(true);
      return json(res, 200, { ok: true, roomId, roundId: currentRound.id, pool: ledger.snapshot().pool });
    }
    const winner = body.winner === 'left' || body.winner === 'right' ? body.winner : 'tie';
    // ★结算在服务端算：客户端拿这份结果直接渲染，两边不会各算各的。
    //   连不上服务端（纯 demo）时客户端仍用自己那套算 —— 见 src/score.js 的 settle。
    // ⚠ 必须跑在 rank.endRound【之前】：上报给平台的 winning_streak_count 要的是本局结算【之后】
    //   的连胜次数，而它是在 settle 里算的。顺序反了会永远少上报一局。
    const result = ledger.settle(winner);
    rank.endRound(roomId, winner);
    currentRound.status = 2;
    pushLedger(true);
    return json(res, 200, { ok: true, roomId, winner, settle: result });
  }
  // 结转：客户端点结算面板「返回」时调 —— 积分池留 40% 当下一局底池
  if (path === '/round/next' && req.method === 'POST') {
    const p = ledger.nextRound();
    pushLedger(true);
    return json(res, 200, { ok: true, pool: p });
  }

  // ── 抖音云生产接入（真机）：4 接口，与上面 dev 的 /cb/*+SSE 并存 ──
  if (path === '/start_game' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}   // Electron 路径带 {token}
    return json(res, 200, { ok: true, data: await dyc.startGame(req.headers, body) });
  }
  if (path === '/live_data_callback' && req.method === 'POST') {
    const raw = await readBody(req);
    return json(res, 200, { ok: true, applied: await dyc.liveDataCallback(req.headers, raw) });
  }
  if (path === '/websocket_callback') {                       // 网关转发：connect 用 GET、uplink 用 POST
    const raw = req.method === 'POST' ? await readBody(req) : '';
    return json(res, 200, { ok: true, event: dyc.websocketCallback(req.headers, raw) });
  }
  if (path === '/finish_game' && req.method === 'POST') {
    const raw = await readBody(req);
    return json(res, 200, { ok: true, ...(await dyc.finishGame(req.headers, raw)) });
  }
  if (path === '/ws_conn' && req.method === 'POST') {        // 客户端取 WS 连接ID（服务端内网调网关 get_conn_id）
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    return json(res, 200, { ok: true, conn_id: await dyc.getConnId(body.token) });
  }
  // 「用户快捷选队」开发者侧 2 接口（后台「开发配置」填这两个地址·小摇杆点选阵营）：
  //   ③ 平台查询观众阵营（观众打开小摇杆时·x-msg-type: user_group）→ 返回该 open_id 当前阵营
  if (path === '/query_user_group' && req.method === 'POST') {
    return json(res, 200, ut.queryUserGroup(await readBody(req), currentRound));
  }
  //   ④ 观众点选队按钮（平台推·x-msg-type: user_group_push）→ lockSide 落座 + 广播到游戏 → 返回实际阵营
  if (path === '/user_group_push' && req.method === 'POST') {
    const out = ut.userGroupPush(await readBody(req), currentRound, broadcast, rank.worldRankOf);
    console.log(`[team] 观众选队 → ${JSON.stringify(out.data)}`);
    return json(res, 200, out);
  }
  // 观众进出房数据（专门接口）：世界榜前十观众进场 → 广播 rankEnter → 客户端播对应名次入场视频
  if (path === '/audience_change' && req.method === 'POST') {
    const raw = await readBody(req);
    console.log(`[room] 观众进出房 ${(raw || '').slice(0, 160)}`);
    return json(res, 200, ut.audienceChange(raw, broadcast, rank.worldRankOf));
  }
  // 运维：看/清 世界榜内存（world 是进程内存，联调假号会占榜前排把真实观众挤下去）。
  //   GET  /api/world            → 看前 N 名（?limit=20）
  //   POST /api/world/reset      → 清；body {prefix:"_000E2E"} 定点清，不传 prefix = 全清
  //   ★鉴权：body.token 或头 x-admin-token 必须等于 APPSECRET；没配 APPSECRET 则整个端点关闭。
  //     别做成裸开——它能抹掉线上榜单数据。
  if (path === '/world' && req.method === 'GET') {
    return json(res, 200, { ok: true, list: rank.worldPeek(u.searchParams.get('limit')) });
  }
  if (path === '/world/reset' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    const tok = req.headers['x-admin-token'] || body.token || '';
    if (!cfg.APPSECRET || tok !== cfg.APPSECRET) {
      console.warn('[world] 清榜被拒（token 不符或未配 APPSECRET）');
      return json(res, 403, { ok: false, err: 'forbidden' });
    }
    const r = rank.resetWorld(body.prefix || '');
    console.log(`[world] 清榜 prefix=${body.prefix || '(全清)'} removed=${r.removed} left=${r.left}`);
    return json(res, 200, { ok: true, ...r });
  }
  // ── 积分池底池（服务端存档，见 pool.js）──
  //   GET  /api/pool             → {pool, open, anchor}；客户端开局时拉，服务端值【压过】本机 localStorage
  //   POST /api/pool {pool,open} → 客户端结转后推上来（局中也有 3s 防抖心跳，防中途崩丢池子）
  //   主播身份由服务端自己认（/start_game 置换出来的 anchorOpenId），客户端不传、也伪造不了。
  if (path === '/pool' && req.method === 'GET') {
    await pool.ready();     // 别在还没从 Redis 读回来时就答复 —— 客户端会拿 ready:false 之外的空池覆盖本地
    return json(res, 200, { ok: true, ...pool.get(dyc.getAnchorOpenId()) });
  }
  if (path === '/pool' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    if (body.pool == null) return json(res, 400, { ok: false, err: 'pool required' });
    const r = await pool.set(dyc.getAnchorOpenId(), body.pool, body.open);
    console.log(`[pool] 存档 anchor=${r.anchor.slice(0, 10)}… pool=${r.pool} open=${r.open}`);
    return json(res, 200, { ok: true, ...r });
  }
  // 运维：清底池。鉴权同 /world/reset —— 它能抹掉主播攒了很多局的池子，不许裸开。
  if (path === '/pool/reset' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    const tok = req.headers['x-admin-token'] || body.token || '';
    if (!cfg.APPSECRET || tok !== cfg.APPSECRET) return json(res, 403, { ok: false, err: 'forbidden' });
    const r = await pool.reset(body.prefix || '');
    console.log(`[pool] 清底池 prefix=${body.prefix || '(全清)'} removed=${r.removed}`);
    return json(res, 200, { ok: true, ...r });
  }
  // ── 玩法积分账本（server/ledger.js）──
  //   GET  /api/ledger          → 整份快照（客户端断线兜底 + 人工查账）
  //   POST /api/ledger/reset    → 清账（同 /world/reset 鉴权；联调假号用 prefix 定点清）
  if (path === '/ledger' && req.method === 'GET') {
    await ledger.ready();
    return json(res, 200, { ok: true, ...ledger.snapshot() });
  }
  if (path === '/ledger/reset' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    const tok = req.headers['x-admin-token'] || body.token || '';
    if (!cfg.APPSECRET || tok !== cfg.APPSECRET) return json(res, 403, { ok: false, err: 'forbidden' });
    const r = await ledger.reset(body.prefix || '');
    console.log(`[ledger] 清账 prefix=${body.prefix || '(全清)'} removed=${r.removed} left=${r.left}`);
    return json(res, 200, { ok: true, ...r });
  }
  // 诊断(临时):手动打选队三 API 看真实 err_no。GET /api/selftest_team?anchor=<主播openid>
  if (path === '/selftest_team') {
    return json(res, 200, { ok: true, test: await rank.selfTestTeam(u.searchParams.get('room') || '1100000000000000888', u.searchParams.get('anchor') || '') });
  }
  // 能力自检：确认「服务在抖音云内网 + WS/OpenAPI 能力开没开」。GET 先看可达性；POST {token} 看能力 err_no。
  if (path === '/selfcheck') {
    let token = u.searchParams.get('token') || '';
    if (!token && req.method === 'POST') { try { token = (JSON.parse((await readBody(req)) || '{}')).token || ''; } catch (_) {} }
    return json(res, 200, { ok: true, check: await dyc.selfCheck(token, u.searchParams.get('env') || '', u.searchParams.get('service') || '') });
  }

  // 本机 mock（step3 自测）：POST /mock/gift?side=left&key=donut&count=1
  // ★必须 ALLOW_MOCK=1 才放行（2026-07-30）：它能凭空造礼物、直接左右直播胜负。
  //   关闭时返回 404 而不是 403 —— 不对外承认这个接口存在，少一个被试探的目标。
  if (path === '/mock/gift' && req.method === 'POST' && !cfg.ALLOW_MOCK) {
    console.warn('[MOCK-BLOCKED] 有人请求 /mock/gift 但 ALLOW_MOCK 未开 →', req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
    return json(res, 404, { ok: false, err: 'not found' });
  }
  if (path === '/mock/gift' && req.method === 'POST') {
    const side = u.searchParams.get('side') || 'left';
    const key = u.searchParams.get('key') || 'donut';
    const count = Math.max(1, Math.min(parseInt(u.searchParams.get('count') || '1', 10), 20));
    broadcast([{ side, key, count, from: 'mock' }]);
    return json(res, 200, { ok: true, side, key, count });
  }

  // 开发期：沙盒测试台 + 同源静态托管（cfg.SERVE_STATIC=1 时；GET / 已被健康探针处理在前）
  if (cfg.SERVE_STATIC && req.method === 'GET') {
    if (path === '/test') { cors(res); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(TEST_PANEL); }
    return serveStatic(path, res);
  }

  json(res, 404, { ok: false, err: 'not found' });
});

server.listen(cfg.PORT, () => {
  console.log('────────────────────────────────────────');
  console.log(`直播小玩法 本地服务端  ::${cfg.PORT}`);
  console.log(`  SSE   GET  /events`);
  console.log(`  回调  POST /cb/{gift,like,comment,team}`);
  console.log(cfg.ALLOW_MOCK
    ? `  自测  POST /mock/gift?side=left&key=donut&count=1   ⚠ 已开放(ALLOW_MOCK=1)·公网可达时勿开`
    : `  自测  /mock/gift 已关闭 → 需要时 ALLOW_MOCK=1 node server/index.js`);
  console.log(`  对局  POST /round/{start,end}    (本局榜/世界榜战绩上报)`);
  console.log(`  健康  GET  /health        (跳过验签=${cfg.DEV_SKIP_SIGN})`);
  console.log(`  战绩  ${rank.enabled ? '已启用 (AppSecret 已配, 世界榜30s定时刷新)' : '未启用 (配 DOUYIN_APPSECRET 环境变量后生效)'}`);
  if (cfg.SERVE_STATIC) {
    console.log('  ──── 可视化测试（同源托管已开）────');
    console.log(`  游戏  http://localhost:${cfg.PORT}/index.html?live=1`);
    console.log(`  测试台 http://localhost:${cfg.PORT}/test`);
  }
  console.log('────────────────────────────────────────');
  if (rank.enabled) { rank.startWorldCron(); rank.worldEnsureVersion().catch(() => {}); }
});
