/**
 * Shared constants and cross-renderer art state for the stage renderer.
 * Extracted verbatim from the legacy stage.js; `ART` stays module-scoped so
 * every renderer instance sees the same loaded images/rigs.
 */
export const GROUND = 440;
export const COLOR_A = '#35d6a4';
export const COLOR_B = '#5b8cff';
export const ACTION_LABEL = {
  idle: '待机', walk_f: '前走', walk_b: '后撤', jump: '跳跃', crouch: '蹲防', block: '站防', throw: '投技',
  lp: '轻拳', mp: '中拳', hp: '重拳', lk: '轻脚', mk: '中脚', hk: '重脚', dp: '升龙', fireball: '波动',
  dash: '前冲', special: '专属技', ex: 'EX 强化', super: '超必杀', dodge: '闪避', parry: '招架',
};
export const EVENT_LABEL = {
  hit: '命中', block: '防御', spawn: '发出波动', ko: 'KO', time_up: '时间到',
  cancel: '取消连段', super_start: '超必杀发动', armor: '霸体吸收', wakeup: '起身',
  move_start: '出招', hitstop: '命中停顿', evade: '闪避成功', parry: '招架成功',
};
export const PHASE_LABEL = { startup: '起手', active: '判定', recovery: '收招', none: '可行动' };
export const REASON_LABEL = { ko: 'KO', time_up: '时间到', elimination: '全队淘汰' };

export const ART = {
  images: Object.create(null),
  rigs: Object.create(null),
  rigPending: new Set(),
  // Keyed by stage id. A single slot would mean the arena currently in RAM is
  // whatever the last match happened to use.
  stages: Object.create(null),
  stage: null,
  failed: new Set(),
  wanted: new Set(),
};
