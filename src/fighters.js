/**
 * Original fighter roster (16 fighters / 4 teams).
 *
 * IMPORTANT / copyright ----------------------------------------------------
 * None of these are KOF / SNK characters. A character's visual design is a
 * protected "work of fine art": Beijing Haidian District Court (2020) held
 * that KOF '97/'98 characters (Mai Shiranui, Choi Bounge, Chang Koehan,
 * Benimaru Nikaido) are protected works and awarded the SNK licensee 800k RMB
 * against a film that reused them. Renaming a character did not help; the
 * court also found unfair competition. See the public case note at
 * https://bjhdfy.bjcourt.gov.cn/article/detail/2020/06/id/5287618.shtml
 *
 * The "free KOF98 MUGEN packs" found online are NOT open-source assets. Their
 * own release pages state that the sprites/voices remain SNK property and
 * forbid commercial use; SFF/SND content is ripped from commercial ROMs.
 * Free to download != licensed. SNK runs a formal commercial IP licensing
 * programme (see snkchina.com.cn); there is no open-source KOF art release.
 *
 * Genuine CC0 fighting sprites DO exist (LuizMelo: Martial Hero / 2 / 3 on
 * itch.io, plus the derived Samurai pack) and may be used commercially with
 * no attribution. But they ship 8-9 animations at ~40 frames, 33x56 px,
 * while this engine has 15 actions and needs 30-60 animation sets per
 * fighter, each strictly aligned with server-authoritative hitbox frames.
 * They are viable as a later SKIN layer, not as M2 primary art.
 *
 * What IS free to reuse: game MECHANICS (frame data, cancels, meter,
 * hitboxes, 3-on-3 team structure, the character-select grid). Copyright
 * protects expression, not ideas. So we borrow the *shape* of the genre and
 * ship 100% original names, silhouettes, palettes and move names.
 *
 * Each fighter has an AI-generated original full-body illustration in
 * web/assets/art/<id>.png (alpha PNG, produced by scripts/matte.mjs). That
 * plate is not drawn as one sticker: scripts/rig-bake.mjs cuts it into six
 * body parts (back arm, back leg, torso, front leg, head, front arm) with a
 * pivot, a paint order and a rotation limit each, and web/rig.js turns every
 * part by the same angular delta the server applied to the neutral stance.
 * So the picture performs the move the kernel resolved, and the drawing stays
 * pixel-aligned with the hitboxes it is built from. Procedural Canvas
 * geometry remains only as a fallback: zero third-party art.
 *
 * M2 scope ------------------------------------------------------------------
 * Fighter identity flows through registration -> matchmaking -> observation
 * -> replay -> leaderboard -> renderer. Ranked rooms enforce a MIRROR matchup
 * (both sides same fighter) so a leaderboard compares strategy quality, not
 * character tier. Scrim/demo rooms allow mixed fighters. Per-character
 * frame-data differences belong to a separate character ladder (M3): mixing
 * tiers into the strategy ladder would invalidate ELO.
 */

import { MOVES, moveTotal } from './rules.js';

export const TEAMS = Object.freeze([
  { id: 'pyre', name: '炎征队', code: 'PYRE TEAM', motif: '近身压进 / 火焰', color: '#e2584d' },
  { id: 'tide', name: '潮汐队', code: 'TIDE TEAM', motif: '牵制波动 / 流水', color: '#3d8ee0' },
  { id: 'steel', name: '钢律队', code: 'STEEL TEAM', motif: '铁壁确反 / 大地', color: '#8b98a8' },
  { id: 'void', name: '虚数队', code: 'VOID TEAM', motif: '机动对空 / 光雷', color: '#9a6cf0' },
]);

export const FIGHTERS = Object.freeze([
  // ── 炎征队 ──────────────────────────────────────────────────────────────
  {
    id: 'ember', name: '赤霄', code: 'EMBER', title: '焰腕', style: '贴身强攻', team: 'pyre',
    tagline: '把距离压到一臂之内，再不让他站起来。',
    palette: { base: '#e2584d', shade: '#7d2229', light: '#ff9d72', accent: '#ffd08a', aura: 'rgba(255,120,72,.20)' },
    build: { scale: 1.0, shoulder: 1.12, torso: 1.06, head: 0.96, limb: 1.02, bulk: 1.1 },
    gear: { head: 'crest', shoulder: 'plate', back: 'banner', weapon: 'gauntlet' },
    signature: { name: '炎冲', shape: 'burst' },
    profile: { reach: 2, speed: 4, power: 5, guard: 2 },
    bio: '以拳压进、用升龙封住跳入的近身型。适合喜欢读对手出招习惯的策略。',
  },
  {
    id: 'cinder', name: '烬羽', code: 'CINDER', title: '焰爪', style: '空战压制', team: 'pyre',
    tagline: '落地之前，我已经打完三下了。',
    palette: { base: '#f0783c', shade: '#8a3518', light: '#ffbf85', accent: '#fff0b8', aura: 'rgba(255,150,70,.20)' },
    build: { scale: 0.96, shoulder: 0.9, torso: 0.92, head: 1.02, limb: 1.12, bulk: 0.84 },
    gear: { head: 'crest', shoulder: 'cloth', back: 'wing', weapon: 'blade' },
    signature: { name: '焚羽', shape: 'crescent' },
    profile: { reach: 3, speed: 5, power: 3, guard: 2 },
    bio: '靠跳跃切入与空中连段的压制型。适合写「对手可行动窗口」与起跳时机的策略。',
  },
  {
    id: 'pyre', name: '燎原', code: 'PYRE', title: '焚阵', style: '中距压进', team: 'pyre',
    tagline: '先烧掉你的退路，再谈进攻。',
    palette: { base: '#d3483f', shade: '#6d1d24', light: '#ff8f7a', accent: '#ffd9a0', aura: 'rgba(240,90,70,.18)' },
    build: { scale: 1.02, shoulder: 1.08, torso: 1.04, head: 0.98, limb: 1.0, bulk: 1.06 },
    gear: { head: 'crest', shoulder: 'plate', back: 'banner', weapon: 'staff' },
    signature: { name: '燎野', shape: 'wave' },
    profile: { reach: 4, speed: 3, power: 4, guard: 3 },
    bio: '用持续推进封走位的阵地型。适合写距离阈值与版边压迫的策略。',
  },
  {
    id: 'slag', name: '熔骸', code: 'SLAG', title: '铁浆', style: '重击反击', team: 'pyre',
    tagline: '慢是慢，但你只有一次机会挡对。',
    palette: { base: '#a8543b', shade: '#4a241c', light: '#e89b6c', accent: '#ffc26b', aura: 'rgba(210,110,60,.18)' },
    build: { scale: 1.07, shoulder: 1.26, torso: 1.18, head: 0.87, limb: 0.95, bulk: 1.34 },
    gear: { head: 'horn', shoulder: 'spike', back: 'none', weapon: 'gauntlet' },
    signature: { name: '熔铸', shape: 'shard' },
    profile: { reach: 3, speed: 2, power: 5, guard: 4 },
    bio: '高伤害、慢启动的反击型。适合写「对手收招帧够不够我出重招」的策略。',
  },

  // ── 潮汐队 ──────────────────────────────────────────────────────────────
  {
    id: 'tide', name: '沧澜', code: 'TIDE', title: '潮手', style: '波动牵制', team: 'tide',
    tagline: '不让你靠近，本身就是一种进攻。',
    palette: { base: '#3d8ee0', shade: '#194a86', light: '#8fd6ff', accent: '#d5f2ff', aura: 'rgba(80,170,255,.20)' },
    build: { scale: 1.0, shoulder: 0.95, torso: 0.98, head: 1.0, limb: 1.05, bulk: 0.94 },
    gear: { head: 'hood', shoulder: 'cloth', back: 'cape', weapon: 'none' },
    signature: { name: '沧波', shape: 'wave' },
    profile: { reach: 5, speed: 3, power: 3, guard: 3 },
    bio: '靠飞行道具控制中远距离的牵制型。适合写距离管理与节奏切换的策略。',
  },
  {
    id: 'mist', name: '雾隐', code: 'MIST', title: '匿流', style: '下段骚扰', team: 'tide',
    tagline: '你防上段的时候，我在下面。',
    palette: { base: '#4bb6c4', shade: '#1d5c6b', light: '#a9f0f2', accent: '#eaffff', aura: 'rgba(90,210,220,.18)' },
    build: { scale: 0.94, shoulder: 0.86, torso: 0.9, head: 0.98, limb: 1.1, bulk: 0.82 },
    gear: { head: 'hood', shoulder: 'cloth', back: 'cape', weapon: 'blade' },
    signature: { name: '潜汐', shape: 'crescent' },
    profile: { reach: 3, speed: 5, power: 2, guard: 3 },
    bio: '用下段与移动骗防的骚扰型。适合写对手防御习惯建模的策略。',
  },
  {
    id: 'coral', name: '珊瑚', code: 'CORAL', title: '礁守', style: '反制防御', team: 'tide',
    tagline: '浪打完，礁石还在。',
    palette: { base: '#e08aa6', shade: '#7a3a58', light: '#ffc6d6', accent: '#fff0e0', aura: 'rgba(240,150,180,.16)' },
    build: { scale: 1.01, shoulder: 1.16, torso: 1.1, head: 0.94, limb: 0.98, bulk: 1.18 },
    gear: { head: 'visor', shoulder: 'plate', back: 'none', weapon: 'none' },
    signature: { name: '礁环', shape: 'ring' },
    profile: { reach: 2, speed: 2, power: 3, guard: 5 },
    bio: '以格挡与确反为核心的防守型。适合写帧优势与 blockstun 判定的策略。',
  },
  {
    id: 'abyss', name: '溟渊', code: 'ABYSS', title: '深压', style: '远距投技', team: 'tide',
    tagline: '别退了，版边就在你身后。',
    palette: { base: '#2f6f9e', shade: '#12304f', light: '#79b9de', accent: '#cfe9ff', aura: 'rgba(50,120,190,.20)' },
    build: { scale: 1.04, shoulder: 1.1, torso: 1.08, head: 0.96, limb: 1.02, bulk: 1.16 },
    gear: { head: 'hood', shoulder: 'spike', back: 'cape', weapon: 'gauntlet' },
    signature: { name: '归渊', shape: 'ring' },
    profile: { reach: 4, speed: 2, power: 4, guard: 4 },
    bio: '把对手逼到版边再用投技收尾的压制型。适合写 inCorner 与投技时机的策略。',
  },

  // ── 钢律队 ──────────────────────────────────────────────────────────────
  {
    id: 'basalt', name: '玄岩', code: 'BASALT', title: '磐守', style: '铁壁反击', team: 'steel',
    tagline: '你先出手，我才出手。',
    palette: { base: '#8b98a8', shade: '#3d4a5a', light: '#d3dde8', accent: '#e9c079', aura: 'rgba(160,180,200,.16)' },
    build: { scale: 1.02, shoulder: 1.24, torso: 1.14, head: 0.9, limb: 0.96, bulk: 1.3 },
    gear: { head: 'visor', shoulder: 'plate', back: 'none', weapon: 'none' },
    signature: { name: '断岳', shape: 'shard' },
    profile: { reach: 2, speed: 2, power: 4, guard: 5 },
    bio: '高防御、等收招确反的防守型。适合写「帧优势 + 确反」判定的策略。',
  },
  {
    id: 'quartz', name: '晶衡', code: 'QUARTZ', title: '均衡', style: '全能基准', team: 'steel',
    tagline: '没有短板，所以只看写策略的人。',
    palette: { base: '#c8d6e2', shade: '#5a7288', light: '#ffffff', accent: '#8fe6ff', aura: 'rgba(190,220,240,.16)' },
    build: { scale: 1.0, shoulder: 1.0, torso: 1.0, head: 1.0, limb: 1.0, bulk: 1.0 },
    gear: { head: 'visor', shoulder: 'plate', back: 'none', weapon: 'none' },
    signature: { name: '棱镜', shape: 'shard' },
    profile: { reach: 3, speed: 3, power: 3, guard: 3 },
    bio: '排位默认角色：各项居中，保证榜单比较的是策略而不是角色强度。',
  },
  {
    id: 'forge', name: '铸星', code: 'FORGE', title: '重锤', style: '重击压制', team: 'steel',
    tagline: '一拳换一拳，你亏。',
    palette: { base: '#d9a441', shade: '#7a4d15', light: '#ffdd8c', accent: '#fff3d0', aura: 'rgba(240,180,70,.18)' },
    build: { scale: 1.06, shoulder: 1.2, torso: 1.16, head: 0.88, limb: 0.98, bulk: 1.28 },
    gear: { head: 'horn', shoulder: 'spike', back: 'none', weapon: 'gauntlet' },
    signature: { name: '陨铸', shape: 'burst' },
    profile: { reach: 4, speed: 2, power: 5, guard: 3 },
    bio: '慢启动、高伤害的压制型。适合写「帧优势够不够出重招」的策略。',
  },
  {
    id: 'girder', name: '衡梁', code: 'GIRDER', title: '架构', style: '中距控制', team: 'steel',
    tagline: '把整块场地切成我能算的格子。',
    palette: { base: '#7d8f7a', shade: '#374a3c', light: '#c2d9b6', accent: '#e8e2a8', aura: 'rgba(140,180,140,.16)' },
    build: { scale: 1.03, shoulder: 1.06, torso: 1.02, head: 0.98, limb: 1.06, bulk: 1.04 },
    gear: { head: 'visor', shoulder: 'plate', back: 'none', weapon: 'staff' },
    signature: { name: '定梁', shape: 'shard' },
    profile: { reach: 4, speed: 3, power: 3, guard: 4 },
    bio: '用长手长脚维持中距离的控场型。适合写 inRange 判定与招式射程表的策略。',
  },

  // ── 虚数队 ──────────────────────────────────────────────────────────────
  {
    id: 'volt', name: '霆枢', code: 'VOLT', title: '雷枢', style: '对空制压', team: 'void',
    tagline: '天空归我管。',
    palette: { base: '#9a6cf0', shade: '#4b2b93', light: '#d9b8ff', accent: '#fff0a8', aura: 'rgba(160,110,255,.20)' },
    build: { scale: 1.01, shoulder: 1.04, torso: 1.0, head: 1.06, limb: 1.0, bulk: 0.98 },
    gear: { head: 'halo', shoulder: 'spike', back: 'none', weapon: 'staff' },
    signature: { name: '雷牙', shape: 'bolt' },
    profile: { reach: 3, speed: 3, power: 4, guard: 3 },
    bio: '专治跳入与空中的对空型。适合写威胁分类与升龙时机判定的策略。',
  },
  {
    id: 'gale', name: '疾风', code: 'GALE', title: '迅影', style: '高速游击', team: 'void',
    tagline: '你看到的是我上一拍站的地方。',
    palette: { base: '#3fc79b', shade: '#176b57', light: '#a6f5d4', accent: '#e6fff3', aura: 'rgba(70,220,170,.18)' },
    build: { scale: 0.95, shoulder: 0.86, torso: 0.9, head: 0.96, limb: 1.14, bulk: 0.8 },
    gear: { head: 'crest', shoulder: 'cloth', back: 'wing', weapon: 'blade' },
    signature: { name: '裂空', shape: 'crescent' },
    profile: { reach: 3, speed: 5, power: 2, guard: 2 },
    bio: '靠移动与下段骚扰拉扯的机动型。适合写位置博弈与进退判定的策略。',
  },
  {
    id: 'noct', name: '夜锷', code: 'NOCT', title: '影刃', style: '贴身投技', team: 'void',
    tagline: '防御越稳，破绽越大。',
    palette: { base: '#4a5bb8', shade: '#1f2a63', light: '#9aa8ff', accent: '#e4e9ff', aura: 'rgba(90,110,230,.18)' },
    build: { scale: 0.98, shoulder: 0.92, torso: 0.94, head: 1.02, limb: 1.06, bulk: 0.9 },
    gear: { head: 'hood', shoulder: 'cloth', back: 'cape', weapon: 'blade' },
    signature: { name: '影缚', shape: 'ring' },
    profile: { reach: 2, speed: 4, power: 3, guard: 3 },
    bio: '用投技惩罚过度防御的近身型。适合写对手行为建模与骗防策略。',
  },
  {
    id: 'prism', name: '棱隙', code: 'PRISM', title: '折光', style: '迷惑游击', team: 'void',
    tagline: '你读到的那条历史，是我留给你读的。',
    palette: { base: '#b26ce0', shade: '#582b83', light: '#eec4ff', accent: '#b8f4ff', aura: 'rgba(190,120,240,.20)' },
    build: { scale: 0.97, shoulder: 0.92, torso: 0.94, head: 1.04, limb: 1.08, bulk: 0.88 },
    gear: { head: 'halo', shoulder: 'cloth', back: 'wing', weapon: 'blade' },
    signature: { name: '折射', shape: 'shard' },
    profile: { reach: 3, speed: 4, power: 3, guard: 3 },
    bio: '靠节奏欺骗与历史动作误导的游击型。适合读 observation.history 做行为预测的策略。',
  },
]);

export const DEFAULT_FIGHTER = 'quartz';

const BY_ID = new Map(FIGHTERS.map((f) => [f.id, f]));
const TEAM_BY_ID = new Map(TEAMS.map((t) => [t.id, t]));

export function getFighter(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_FIGHTER);
}

export function isValidFighter(id) {
  return BY_ID.has(id);
}

export function getTeam(id) {
  return TEAM_BY_ID.get(id) || null;
}

/**
 * Three meter-aware skills per fighter. Frame data is SHARED by the whole
 * roster (ranked is a mirror match, so ELO measures strategy, not tiers);
 * what differs per character is the signature name, VFX shape and colour.
 * The names are original, like every character here.
 */
export function skillSet(f) {
  const sig = f.signature || { name: '技', shape: 'shard' };
  const names = { special: sig.name, ex: 'EX · ' + sig.name, super: '奥义 · ' + sig.name };
  return ['special', 'ex', 'super'].map((id) => {
    const m = MOVES[id];
    return {
      id, name: names[id], label: m.label, shape: sig.shape,
      vfx: m.vfx === 'signature' ? sig.shape : (m.vfx || sig.shape),
      cost: m.meterCost || 0,
      startup: m.startup, active: m.active, recovery: m.recovery,
      totalFrames: moveTotal(id), damage: m.damage,
      hitboxes: (m.hitboxes || []).length,
      multiHit: Boolean(m.multiHit), knockdown: Boolean(m.knockdown),
      invuln: m.invuln || 0, armor: m.armor || 0,
      cancelInto: m.cancelInto || [],
    };
  });
}

export function publicFighters() {
  return FIGHTERS.map((f) => {
    const t = TEAM_BY_ID.get(f.team);
    return {
      id: f.id, name: f.name, code: f.code, title: f.title, style: f.style,
      team: f.team, teamName: t ? t.name : '', teamCode: t ? t.code : '', teamColor: t ? t.color : '#8b98a8', teamMotif: t ? t.motif : '',
      tagline: f.tagline, palette: f.palette, signature: f.signature,
      skills: skillSet(f),
      profile: f.profile, bio: f.bio, build: f.build, gear: f.gear,
      art: '/assets/art/' + f.id + '.png',
    };
  });
}

/** Grouped roster for the character-select style gallery. */
export function publicTeams() {
  return TEAMS.map((t) => ({
    id: t.id, name: t.name, code: t.code, motif: t.motif, color: t.color,
    fighters: FIGHTERS.filter((f) => f.team === t.id).map((f) => ({
      id: f.id, name: f.name, code: f.code, style: f.style, signature: f.signature,
    })),
  }));
}

export function fighterBrief(id) {
  const f = getFighter(id);
  const t = TEAM_BY_ID.get(f.team);
  return {
    id: f.id, name: f.name, code: f.code, title: f.title, style: f.style,
    palette: f.palette, signature: f.signature, skills: skillSet(f),
    team: f.team, teamName: t ? t.name : '',
  };
}
