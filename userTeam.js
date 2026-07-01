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

// ③ 查询观众阵营数据（平台调·观众打开小摇杆时）：只查主动落座、不触发随机（没落座返回空串）。
function queryUserGroup(rawBody, round) {
  let body = {}; try { body = JSON.parse(rawBody || '{}'); } catch (_) {}
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
function userGroupPush(rawBody, round, broadcast) {
  let body = {}; try { body = JSON.parse(rawBody || '{}'); } catch (_) {}
  const openId = body.open_id || '';
  const want = normGroup(body.group_id);
  // 防御：只处理带有效阵营(group_id)的「观众选择阵营」。无 group_id 的事件——
  // 如误配到本地址的「观众进出房数据」——直接 ack、不落座，避免观众一进房就被随机拉队/刷屏。
  if (!want) {
    return { errcode: 0, errmsg: 'success', data: { round_id: round.id || 0, round_status: round.status || 2, group_id: dy.chosenSide(openId) || '' } };
  }
  const first = !dy.chosenSide(openId);
  const side = dy.lockSide(openId, want);                 // 首次→按选的落座并锁；已落座→归原队
  if ((side === 'left' || side === 'right') && typeof broadcast === 'function') {
    const user = { openid: openId, nickname: body.nickname || '', avatar: body.avatar_url || '' };
    broadcast([{ side, key: first ? 'join' : 'c666', count: 1, ...user }]);
  }
  return {
    errcode: 0, errmsg: 'success',
    data: { round_id: round.id || 0, round_status: round.status || 2, group_id: side || '' },
  };
}

// 观众进出房数据（专门接口·后续用于召集/老玩家识别/贡献梯度）：当前接收 + ack + 日志留存，
// 不产生游戏效果。字段以真机为准（open_id、是否弹幕玩法老玩家、直播贡献梯度、发起召集用户 openid 等）。
// TODO 后续：发起召集 openid → 触发召集效果；老玩家/高贡献 → 差异化欢迎横幅。
function audienceChange(rawBody) {
  let body = {}; try { body = JSON.parse(rawBody || '{}'); } catch (_) {}
  return { errcode: 0, errmsg: 'success', data: {} };
}

module.exports = { queryUserGroup, userGroupPush, audienceChange, normGroup };
