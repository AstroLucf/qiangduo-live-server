# 抢夺45分钟 · 直播小玩法服务端（本地开发版）

零依赖（Node 原生 `http` + SSE），把抖音推来的互动数据翻译成游戏指令，下发给客户端。

```
观众送礼 → 抖音 → POST /cb/gift (验签) → translate() → SSE /events → demo: PK_DEBUG.support()
```

## 跑起来

```bash
node server/index.js          # 或 cd server && npm start
```

默认 `:8787`。健康检查：`curl localhost:8787/health`

## 本机自测（step3，不依赖抖音）

1. 起服务端。
2. 浏览器开 demo，URL 加 `?live=1`：`index.html?live=1`（跨端口时 `&server=http://本机IP:8787`）。
3. 造一条礼物，看 demo 动：
   ```bash
   curl -X POST "localhost:8787/mock/gift?side=left&key=donut&count=1"   # 大壮 +甜甜圈
   curl -X POST "localhost:8787/mock/gift?side=right&key=airdrop&count=1" # 小美 +空投
   ```
   `key` 可选：join / like / c666 / wand / pill / donut / battery / mic / airdrop（见 src/main.js 的 GIFTS）。

## 接沙盒（step4，需配合控制台）

1. 起服务端 + 用内网穿透（cpolar/frp）给本机一个公网地址。
2. 控制台 > 开发配置：启用 AppSecret、加调试成员、把要入局的礼物**置顶**、把各数据「路径配置」填成
   `https://你的穿透域名/cb/gift`（like/comment/team 同理）。
3. 控制台 > 自查工具：设 roomID + 角色 → 推模拟礼物（`test:true`）。
4. 看服务端日志 + demo 反应；SDK 日志查询里核对。

## 上线前必做（TODO）

- [ ] **AppSecret**：控制台启用后用环境变量传，勿硬编：`DOUYIN_APPSECRET=xxx DEV_SKIP_SIGN=0 node server/index.js`
- [ ] **验签算法**：`douyin.js > verifySign` 现为占位，用控制台「签名调试工具」校准定稿。
- [x] ~~**礼物映射**~~：6 个付费礼物的真实 `sec_gift_id` 已全部回填 `douyin.js > GIFT_ID_TO_KEY`。
      2026-07-30 抖音云日志验证：battery / mic / pill / donut 四种真机回调全部精确命中，
      无一条 `[GIFT-UNMAPPED]` 告警。
- [x] ~~**gift_value 单位**~~：2026-07-30 真机样例定案 —— **gift_value = 抖币 × 10**
      （battery 99→990 / mic 299→2990 / pill 10→100 / donut 52→520）。真机带 sec_gift_id 走精确映射，
      不碰按价兜底那张表；**切勿**让真机数值漏到 PRICE_TIERS，990 会被判成 airdrop（审核雷）。
- [ ] **履约数据上报**：收到并处理后调抖音 ack 接口（去重 + 结算依据）。
- [ ] **选队类型字符串**：确认官方 msg_type 后对齐 `/cb/team` 映射。
- [ ] **access_token**：实现 2h 缓存刷新（启动任务/礼物置顶/履约 都要）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8787 | 端口 |
| `DOUYIN_APPID` | tt62e91454fc8d46c610 | 应用 AppID |
| `DOUYIN_APPSECRET` | (空) | 控制台启用后填 |
| `DEV_SKIP_SIGN` | 1 | 1=跳过验签(开发)，0=校验 |
| `DEFAULT_SIDE` | ignore | 选队未知时礼物归边：ignore/left/right |
