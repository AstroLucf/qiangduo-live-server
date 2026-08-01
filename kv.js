// ============================================================
//  server/kv.js · 极小 Redis 客户端（零依赖·只用 Node 内置 net）
//  ------------------------------------------------------------
//  为什么手写而不是 npm i redis：本服务是【零依赖】的，Dockerfile 只有 `COPY . .`、
//  没有 npm install。引一个包就得改构建、加构建期网络依赖、node_modules 进镜像。
//  我们只需要 AUTH / HGETALL / HSET / DEL / PING 五条命令，RESP2 协议本身很简单，
//  手写约 100 行就够，代价远小于动构建链。
//
//  连接信息由【抖音云自动注入环境变量】(官方文档：内网访问默认开启，地址/账号/密码
//  都会设置到服务的环境变量里)：REDIS_ADDRESS / REDIS_USERNAME / REDIS_PASSWORD。
//  → 代码里不出现任何密钥，也不用改部署配置。
//
//  ★没配 REDIS_ADDRESS 时整个模块降级为 no-op（所有操作返回 null/false）：
//    本地开发、以及 Redis 开通之前的线上环境，行为与改动前【完全一致】，不会因此挂掉。
// ============================================================
'use strict';
const net = require('net');

const ADDR = process.env.REDIS_ADDRESS || '';
const USER = process.env.REDIS_USERNAME || '';
const PASS = process.env.REDIS_PASSWORD || '';
const ENABLED = !!ADDR;

function log(...a) { console.log('[kv]', ...a); }

// ---------- RESP2 编码：命令一律用数组批量形式 ----------
function encode(args) {
  let s = '*' + args.length + '\r\n';
  for (const a of args) { const b = Buffer.from(String(a)); s += '$' + b.length + '\r\n' + b.toString('binary') + '\r\n'; }
  return Buffer.from(s, 'binary');
}

// ---------- RESP2 增量解析：TCP 会把一条回复切成多个 chunk，必须能「不够就等下次」 ----------
// 返回 [值, 消耗字节数] 或 null(数据不完整)。错误回复解析成 Error 对象（由调用方 reject）。
function parse(buf, i) {
  if (i >= buf.length) return null;
  const type = buf[i];
  const nl = buf.indexOf('\r\n', i, 'binary');
  if (nl < 0) return null;
  const head = buf.toString('binary', i + 1, nl);
  const after = nl + 2;
  if (type === 43) return [head, after - i];                       // '+' 简单字符串
  if (type === 45) return [new Error(head), after - i];            // '-' 错误
  if (type === 58) return [Number(head), after - i];               // ':' 整数
  if (type === 36) {                                               // '$' 批量字符串
    const n = Number(head);
    if (n === -1) return [null, after - i];
    if (after + n + 2 > buf.length) return null;
    return [buf.toString('utf8', after, after + n), after + n + 2 - i];
  }
  if (type === 42) {                                               // '*' 数组
    const n = Number(head);
    if (n === -1) return [null, after - i];
    const out = []; let p = after;
    for (let k = 0; k < n; k++) {
      const r = parse(buf, p);
      if (!r) return null;
      out.push(r[0]); p += r[1];
    }
    return [out, p - i];
  }
  return [null, after - i];                                        // 未知类型：跳过这一行
}

let sock = null, ready = false, buf = Buffer.alloc(0);
const waiting = [];          // 已发出、等回复的命令：{resolve,reject}
let retryAt = 0, retryMs = 1000;

function drop(err) {
  ready = false;
  if (sock) { try { sock.destroy(); } catch (_) {} sock = null; }
  buf = Buffer.alloc(0);
  while (waiting.length) waiting.shift().reject(err || new Error('redis closed'));
}

function connect() {
  if (!ENABLED || sock) return;
  const [host, port] = ADDR.includes(':') ? [ADDR.slice(0, ADDR.lastIndexOf(':')), +ADDR.slice(ADDR.lastIndexOf(':') + 1)] : [ADDR, 6379];
  sock = net.createConnection({ host, port });
  sock.setNoDelay(true);
  sock.on('connect', async () => {
    try {
      // 抖音云给的是带账号的 Redis（ACL）→ AUTH user pass；没账号则 AUTH pass
      if (PASS) await send(USER ? ['AUTH', USER, PASS] : ['AUTH', PASS], true);
      ready = true; retryMs = 1000;
      log('已连接', host + ':' + port);
    } catch (e) { log('AUTH 失败', e.message); drop(e); }
  });
  sock.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      const r = parse(buf, 0);
      if (!r) break;
      buf = buf.subarray(r[1]);
      const w = waiting.shift();
      if (!w) continue;
      r[0] instanceof Error ? w.reject(r[0]) : w.resolve(r[0]);
    }
  });
  sock.on('error', (e) => { log('连接出错', e.message); drop(e); });
  sock.on('close', () => { drop(); retryAt = Date.now() + retryMs; retryMs = Math.min(retryMs * 2, 30000); });
}

// duringAuth：AUTH 本身要在 ready=false 时发，其余命令必须等 ready
function send(args, duringAuth) {
  return new Promise((resolve, reject) => {
    if (!ENABLED) return resolve(null);
    if (!sock || (!ready && !duringAuth)) return reject(new Error('redis not ready'));
    waiting.push({ resolve, reject });
    sock.write(encode(args));
  });
}

// 定时重连（连不上不影响主链路，只是持久化暂时失效）
if (ENABLED) {
  connect();
  setInterval(() => { if (!sock && Date.now() >= retryAt) connect(); }, 1000).unref();
}

// ---------- 对外 API：全部「失败即返回兜底值」，绝不把异常抛进主链路 ----------
const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { log('操作失败', e.message); return fallback; } };

module.exports = {
  enabled: ENABLED,
  isReady: () => ready,
  // 取整张 hash → 普通对象；失败/未启用返回 null（调用方据此区分「空表」和「没读到」）
  hgetall: (key) => (ENABLED ? safe(async () => {
    const a = await send(['HGETALL', key]);
    if (!Array.isArray(a)) return {};
    const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
    return o;
  }, null) : Promise.resolve(null)),
  // pairs = [field, value, field, value, ...]；一次写多个字段
  hset: (key, pairs) => (ENABLED && pairs.length ? safe(() => send(['HSET', key, ...pairs]), null) : Promise.resolve(null)),
  hdel: (key, fields) => (ENABLED && fields.length ? safe(() => send(['HDEL', key, ...fields]), null) : Promise.resolve(null)),
  del: (key) => (ENABLED ? safe(() => send(['DEL', key]), null) : Promise.resolve(null)),
  ping: () => (ENABLED ? safe(() => send(['PING']), null) : Promise.resolve(null)),
};
