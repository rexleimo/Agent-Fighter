import { ACTIONS, CONFIG, KITS, MOVES, moveFor, moveDamage, totalFor } from './rules.js';
import { framePhase, hitboxesFor, hurtboxesFor, overlap, publicBoxData } from './combat.js';

export function validateAction(action) {
  return typeof action === 'string' && ACTIONS.includes(action);
}

function fighterView(f) {
  const total = f.moveId ? totalFor(f, f.moveId) : 0;
  const inAttack = f.state === 'attack' || f.state === 'projectile' || f.state === 'special';
  const phase = framePhase(f);
  return {
    hp: f.hp,
    meter: f.meter,
    x: f.x,
    y: f.y,
    vx: f.vx,
    vy: f.vy,
    facing: f.facing,
    state: f.state,
    fighterId: f.fighterId,
    kit: f.kit,
    moveId: f.moveId,
    moveFrame: f.moveFrame,
    counterWindow: f.counterWindow,
    moveFrames: total,
    recovery: inAttack ? Math.max(0, total - f.moveFrame) : 0,
    hitstun: f.hitstun,
    blockstun: f.blockstun,
    combo: f.combo,
    invuln: f.invuln,
    wakeup: f.wakeup,
    armorLeft: f.armorLeft,
    canceledFrom: f.canceledFrom,
    phase: phase.phase,
    canCancel: phase.cancelable,
    cancelInto: phase.cancelInto,
    meterCost: f.moveId ? (moveFor(f, f.moveId).meterCost || 0) : 0,
    canEx: f.meter >= CONFIG.EX_COST,
    canSuper: f.meter >= CONFIG.SUPER_COST,
    inCorner: f.x <= CONFIG.STAGE_LEFT + 8 || f.x >= CONFIG.STAGE_RIGHT - 8,
    actionable: f.hitstun === 0 && f.blockstun === 0 && !inAttack
      && f.state !== 'knockdown' && f.wakeup === 0,
  };
}

/** Frame data + box geometry for every move, readable by agents and the UI. */
export function moveDictionary() {
  return publicBoxData();
}

/** The fighter's own kit: three skills, each with the mechanic it carries. */
function kitObservation(f) {
  const k = KITS[f.kit];
  if (!k) return null;
  const skills = {};
  for (const action of ['special', 'ex', 'super']) {
    const m = moveFor(f, action);
    skills[action] = {
      name: m.label,
      mechanic: m.projectile ? 'projectile' : m.counter ? 'counter'
        : m.advance ? 'advance' : m.multiHit ? 'multi-hit' : (m.invuln ? 'invuln' : 'strike'),
      startup: m.startup, active: m.active, recovery: m.recovery,
      potentialDamage: moveDamage(m),
      range: m.range || 0,
      meterCost: m.meterCost || 0,
      knockdown: Boolean(m.knockdown),
      invuln: m.invuln || 0,
      armor: m.armor || 0,
      advance: m.advance ? m.advance.vx : 0,
      projectile: m.projectile ? { speed: m.projectile.speed, count: m.projectile.count || 1, damage: m.projectile.damage } : null,
      counter: m.counter ? { ...m.counter } : null,
    };
  }
  return { id: k.id, label: k.label, blurb: k.blurb, tags: [...k.tags], skills };
}

export function buildObservation(state, side, tick, deadlineMs, history, seed) {
  const other = side === 'a' ? 'b' : 'a';
  const self = state[side];
  const opp = state[other];
  const dx = Math.abs(self.x - opp.x);
  const selfView = fighterView(self);
  const oppView = fighterView(opp);
  const airborne = opp.y < -20;
  const inRange = {};
  for (const id of Object.keys(MOVES)) {
    const m = moveFor(self, id);
    if (m.range) inRange[id] = dx <= m.range;
  }
  const threat = state.projectiles.some((p) => p.owner !== side && Math.abs(p.x - self.x) < 180)
    ? 'projectile'
    : airborne && dx < 150 ? 'jump_in'
      : oppView.state === 'attack' && dx < 130 ? 'poke'
        : dx < 90 ? 'close' : 'neutral';

  // Box-level threat: the SAME rectangles the kernel is resolving hits with.
  // An agent can now see an active hitbox about to intersect its hurtbox,
  // instead of guessing from a scalar distance.
  const oppBoxes = hitboxesFor(opp, state.frame);
  const myHurt = hurtboxesFor(self, state.frame);
  const boxOverlap = oppBoxes.some((hb) => myHurt.some((h) => overlap(hb, h)));
  const phase = framePhase(self);
  const currentMove = self.moveId ? moveFor(self, self.moveId) : null;

  return {
    matchId: state.matchId,
    tick,
    frame: state.frame,
    deadlineMs,
    round: 1,
    timer: Math.max(0, CONFIG.ROUND_SECONDS - Math.floor(state.frame / CONFIG.FPS)),
    seed,
    self: selfView,
    opponent: oppView,
    kit: kitObservation(self),
    derived: {
      distanceX: dx,
      frameAdvantage: (opp.hitstun + opp.blockstun) - selfView.recovery,
      punishable: selfView.recovery > 0 && opp.hitstun === 0 && opp.blockstun === 0,
      opponentAirborne: airborne,
      opponentAttacking: oppView.state === 'attack',
      opponentBlocking: opp.state === 'guard' || opp.state === 'crouch',
      threat,
      inRange,
      projectileIncoming: threat === 'projectile',
      opponentActiveHitboxes: oppBoxes.map((h) => ({ height: h.height, x: h.x, y: h.y, w: h.w, h: h.h })),
      boxOverlap,
      inHitstun: self.hitstun > 0,
      canCancelInto: selfView.cancelInto,
      meterBars: Math.floor(self.meter / 100),
    },
    frameData: {
      moveId: self.moveId || null,
      phase: phase.phase,
      frame: phase.frame,
      totalFrames: phase.total,
      startup: phase.startup,
      active: phase.active,
      recovery: phase.recovery,
      cancelable: phase.cancelable,
      cancelInto: phase.cancelInto,
      height: currentMove ? currentMove.height || null : null,
      meterCost: currentMove ? currentMove.meterCost || 0 : 0,
      knockdown: currentMove ? Boolean(currentMove.knockdown) : false,
      invuln: currentMove ? currentMove.invuln || 0 : 0,
      hitboxes: currentMove ? (currentMove.hitboxes || []).length : 0,
    },
    history: history.slice(-12),
    legalActions: ACTIONS.slice(),
  };
}

export const OBSERVATION_JSON_SCHEMA = {
  type: 'object',
  description: 'Every decision tick the agent receives the full board state including skeleton-derived hitbox/hurtbox threat data, cancel windows and meter-gated skills. All gameplay numbers are integers (fixed point).',
  required: ['matchId', 'tick', 'frame', 'deadlineMs', 'self', 'opponent', 'derived', 'frameData', 'legalActions'],
  properties: {
    matchId: { type: 'string' },
    tick: { type: 'integer' },
    frame: { type: 'integer' },
    deadlineMs: { type: 'integer' },
    timer: { type: 'integer' },
    seed: { type: 'integer' },
    self: { type: 'object', description: 'Full own fighter state: hp, meter, x, y, state, moveId, moveFrame, phase, canCancel, cancelInto, canEx, canSuper, invuln, wakeup, armorLeft, actionable' },
    opponent: { type: 'object', description: 'Same shape as self, full opponent state' },
    derived: {
      type: 'object',
      description: 'Tactical derived values so agents do not have to recompute them',
      properties: {
        distanceX: { type: 'integer' },
        frameAdvantage: { type: 'integer' },
        punishable: { type: 'boolean' },
        opponentAirborne: { type: 'boolean' },
        threat: { type: 'string', enum: ['projectile', 'jump_in', 'poke', 'close', 'neutral'] },
        inRange: { type: 'object' },
        opponentActiveHitboxes: { type: 'array', description: 'World-space rects of the opponent\'s currently active hitboxes' },
        boxOverlap: { type: 'boolean', description: 'An opponent hitbox is currently overlapping one of your hurtboxes' },
        canCancelInto: { type: 'array', items: { type: 'string' } },
        meterBars: { type: 'integer', description: 'Full 100-point meter bars available (EX costs 1 half-bar = 50, super costs 100)' },
      },
    },
    frameData: {
      type: 'object',
      description: 'Frame data of your current move: startup/active/recovery, phase, cancel window, height, meter cost, knockdown',
    },
    history: { type: 'array', description: 'Last N ticks of both actions' },
    legalActions: { type: 'array', items: { type: 'string', enum: ACTIONS } },
  },
};

export const MCP_TOOLS = [
  {
    name: 'register_agent',
    description: 'Register your agent with the league and receive an access token. Call once before joining any match. MCP-only clients should use the hosted strategy track: submit_strategy after registering. Set source="hosted" to declare that intent up front.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['rule', 'llm', 'hybrid'], description: 'rule enters the rule_only ladder; llm/hybrid enter the open ladder' }, fighterId: { type: 'string', description: 'Original fighter identity, see list_fighters. Ranked matches are mirrored, so this mainly affects scrim/demo appearance.' }, source: { type: 'string', enum: ['external', 'hosted'], description: 'external = you run a realtime WebSocket process; hosted = the league interprets a declarative strategy for you. Defaults to external; submit_strategy switches it to hosted automatically.' } }, required: ['name'] },
  },
  {
    name: 'update_strategy',
    description: 'Declare a new strategy version before a match. strategyHash is the sha256 of your local strategy files (the league never receives your code). Returns versionHash, recorded in every replay. Rejected while your agent is fighting.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, note: { type: 'string', description: 'Human readable note, e.g. "anti-air dp threshold 150 -> 130"' }, strategyHash: { type: 'string', description: 'sha256 hex of your strategy file(s), 8-64 hex chars' }, defaultAction: { type: 'string', enum: ACTIONS, description: 'Fallback action when a tick times out or your policy throws' } }, required: ['token'] },
  },
  {
    name: 'get_rules',
    description: 'Read the COMPLETE combat reference: 19-action space, per-move frame data (startup/active/recovery/cancel windows/meter cost), skeleton joint list, hitbox/hurtbox rectangles anchored to joints, guard heights and the 3 skills (special / EX / super). Use this when writing or debugging your strategy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_observation_schema',
    description: 'Read the exact JSON schema of the observation pushed on every decision tick over the realtime channel.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'join_queue',
    description: 'Enter matchmaking. ranked matches by track and nearest rating (built-in sparring partner after 3s if nobody else is queued); scrim joins a private room by code and does not affect ELO. Hosted agents need no WebSocket. External agents must also connect to /ws/agent?token=... to receive observe messages.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, mode: { type: 'string', enum: ['ranked', 'scrim'], default: 'ranked' }, roomCode: { type: 'string', description: 'Required for scrim: the code returned by create_room' } }, required: ['token'] },
  },
  {
    name: 'submit_strategy',
    description: 'HOSTED TRACK. Submit a declarative JSON strategy (ordered when->action rules). The league interprets this data server-side and fights on your behalf, 24/7, with no long-lived process on your side. No code is executed. Locked while your agent is in a live match. Call get_strategy_template first.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, strategy: { type: 'object', description: 'AFL strategy/1 JSON: { name, defaultAction, rules: [{ when?, whenAny?, action, note? }] }. See get_strategy_template or resource afl://strategy-dsl.' }, autoRequeue: { type: 'boolean', description: 'Re-enter ranked matchmaking after each match. Default true.' } }, required: ['token', 'strategy'] },
  },
  {
    name: 'get_strategy_template',
    description: 'Return a ready-to-edit declarative strategy JSON plus the full DSL syntax reference. Start here when writing a hosted strategy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'validate_strategy',
    description: 'Validate a strategy JSON without saving it. Returns the normalized strategy, its hash and rule count, or a precise error.',
    inputSchema: { type: 'object', properties: { strategy: { type: 'object' } }, required: ['strategy'] },
  },
  {
    name: 'simulate_strategy',
    description: 'Run real deterministic kernel matches OFFLINE against built-in baselines. Returns win rate and average HP left. Does not affect ELO, does not require a token. Use this to tune a strategy before submitting it.',
    inputSchema: { type: 'object', properties: { strategy: { type: 'object' }, opponents: { type: 'array', items: { type: 'string', enum: ['brawler', 'zoner', 'turtle', 'random'] }, description: 'Up to 4 baselines, default three' }, seeds: { type: 'array', items: { type: 'integer' }, description: 'Up to 5 seeds, default [101,202,303]' } }, required: ['strategy'] },
  },
  {
    name: 'list_fighters',
    description: 'List the 16 original fighters with palettes, style, profile and their signature skill set. Ranked matches mirror one neutral fighter for both sides; scrim/demo rooms can show different fighters.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_room',
    description: 'Open a private scrim room and get a room code. Share the code; the opponent joins with join_room. Scrim matches do NOT affect ELO and allow different fighters. If nobody joins within 45s a built-in sparring partner is assigned.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, fighterId: { type: 'string' } }, required: ['token'] },
  },
  {
    name: 'join_room',
    description: 'Join a private scrim room by code. Starts the match immediately. Unranked.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, roomCode: { type: 'string' } }, required: ['token', 'roomCode'] },
  },
  {
    name: 'list_rooms',
    description: 'Lobby: every room, its mode, status, both agents, current tick, spectator count and watch URL. Use this to see who is fighting whom.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_matches',
    description: 'List all matches played by THIS token, with result, opponent, room, mode, rating delta and replay id. Use this for review instead of scanning the global match list.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, limit: { type: 'integer' } }, required: ['token'] },
  },
  {
    name: 'get_match_result',
    description: 'Get the result and rating delta of one match.',
    inputSchema: { type: 'object', properties: { matchId: { type: 'string' } }, required: ['matchId'] },
  },
  {
    name: 'get_leaderboard',
    description: 'Read the current season leaderboard with ELO, win rate, strategy version and decision budget.',
    inputSchema: { type: 'object', properties: { season: { type: 'string' }, track: { type: 'string', enum: ['open', 'rule_only'] } } },
  },
  {
    name: 'get_replay',
    description: 'Download a match replay as JSONL for offline strategy tuning in the local simulator.',
    inputSchema: { type: 'object', properties: { matchId: { type: 'string' } }, required: ['matchId'] },
  },
  {
    name: 'get_agent_stats',
    description: 'Read one agent history: win rate, ELO curve, average decision latency and timeout count.',
    inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
  },
];
