// ============================================================================
// 你的「skill / 策略」本体 —— 整个 Agent 里唯一需要反复修改的文件。
//
// 契约：同步纯函数 (observation) => action 字符串
//   · 输入：服务端每 100ms 推一次的全盘结构化状态（双方数据都在里面）
//   · 输出：ACTIONS 白名单里的一条动作；一拍只许回一条
//   · 必须同步返回，且远快于 100ms。想用 LLM 请看 ../llm-agent/
//   · 站点不执行这个文件。它在你自己的进程里跑，站点只收到 action。
//
// 改这里的判断逻辑，或改 strategy.config.json 里的阈值，就是在「调优 Agent」。
// 改完先 `npm test` 离线自测，再 `npm start` 上场，最后看回放验证强弱。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const config = JSON.parse(fs.readFileSync(path.join(HERE, 'strategy.config.json'), 'utf8'));

// 站点认可的合法动作全集。返回其它字符串会被服务端替换成 defaultAction。
export const ACTIONS = [
  'idle', 'walk_f', 'walk_b', 'jump', 'crouch',
  'lp', 'mp', 'hp', 'lk', 'mk', 'hk',
  'dp', 'fireball', 'block', 'throw',
];

function legal(action, fallback) {
  return ACTIONS.includes(action) ? action : fallback;
}

export function strategy(obs) {
  const self = obs.self;
  const d = obs.derived;
  const c = config;
  const fallback = c.timeoutFallback;

  // 1. 被打出硬直 / 防御硬直：此时任何输入都不生效，老实防御。
  if (self.hitstun > 0 || self.blockstun > 0) return 'block';

  // 2. 连段：自己的招已经命中且进入可取消窗口，对手还在受创 → 追一记重拳。
  if (self.canCancel && obs.opponent.hitstun > 0) return legal(c.comboFollowUp, 'hp');

  // 3. 对面波动已经飞到附近：防御优先，别硬换血。
  if (d.projectileIncoming) return 'block';

  // 4. 对手跳入：升龙对空（自带 3 帧无敌，是本作最稳的反跳入手段）。
  if (d.threat === 'jump_in' && d.distanceX < c.antiAirDistance && d.inRange.dp) return 'dp';

  // 5. 远距离：用波动牵制，逼对手先动。
  if (d.distanceX > c.fireballMinDistance) return 'fireball';

  // 6. 中距离：走进自己的有效射程，不要在中距离空挥。
  if (d.distanceX > c.walkInDistance) return 'walk_f';

  // 7. 贴身：优先重拳（伤害 110），够不到再用中拳（启动更快）。
  if (d.inRange[c.preferredClose]) return legal(c.preferredClose, 'hp');
  if (d.inRange[c.preferredPoke]) return legal(c.preferredPoke, 'mp');

  // 8. 兜底：轻拳试探，避免站在原地挨打。
  return legal(fallback, 'block');
}

export default strategy;
