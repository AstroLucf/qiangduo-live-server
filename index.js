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

const clients = new Set();   // 当前 SSE 连接

function broadcast(events) {
  if (!events || !events.length) return;
  const frame = `data: ${JSON.stringify(events)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch (_) {} }
  console.log(`[push] ${events.map((e) => `${e.side}:${e.key}×${e.count}`).join('  ')}  → ${clients.size} 端`);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }

// 回调路由 → msg_type_str
const MSGTYPE = { gift: 'live_gift', like: 'live_like', comment: 'live_comment', team: 'team_select' };

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
    return json(res, 200, { ok: true, clients: clients.size, appid: cfg.APPID, skipSign: cfg.DEV_SKIP_SIGN, defaultSide: cfg.DEFAULT_SIDE });
  }

  // SSE：客户端订阅下行数值
  if (path === '/events' && req.method === 'GET') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); console.log(`[sse] 断开 (剩 ${clients.size})`); });
    console.log(`[sse] 接入 (共 ${clients.size})`);
    return;
  }

  // 抖音互动回调：/cb/gift /cb/like /cb/comment /cb/team
  if (path.startsWith('/cb/') && req.method === 'POST') {
    const msgType = MSGTYPE[path.slice(4)];
    if (!msgType) return json(res, 404, { ok: false, err: 'unknown callback' });
    const raw = await readBody(req);
    if (!cfg.DEV_SKIP_SIGN && !dy.verifySign(req.headers, raw, cfg.APPSECRET)) {
      return json(res, 401, { ok: false, err: 'bad signature' });
    }
    let payload; try { payload = JSON.parse(raw || '{}'); } catch (_) { payload = {}; }
    const events = dy.translate(msgType, payload, cfg.DEFAULT_SIDE);
    broadcast(events);
    // TODO(联调)：收到并处理成功后，调抖音「履约数据上报」做 ack（去重 + 结算依据）。
    return json(res, 200, { ok: true, applied: events.length });
  }

  // 本机 mock（step3 自测）：POST /mock/gift?side=left&key=donut&count=1
  if (path === '/mock/gift' && req.method === 'POST') {
    const side = u.searchParams.get('side') || 'left';
    const key = u.searchParams.get('key') || 'donut';
    const count = Math.max(1, Math.min(parseInt(u.searchParams.get('count') || '1', 10), 20));
    broadcast([{ side, key, count, from: 'mock' }]);
    return json(res, 200, { ok: true, side, key, count });
  }

  json(res, 404, { ok: false, err: 'not found' });
});

server.listen(cfg.PORT, () => {
  console.log('────────────────────────────────────────');
  console.log(`直播小玩法 本地服务端  ::${cfg.PORT}`);
  console.log(`  SSE   GET  /events`);
  console.log(`  回调  POST /cb/{gift,like,comment,team}`);
  console.log(`  自测  POST /mock/gift?side=left&key=donut&count=1`);
  console.log(`  健康  GET  /health        (跳过验签=${cfg.DEV_SKIP_SIGN})`);
  console.log('────────────────────────────────────────');
});
