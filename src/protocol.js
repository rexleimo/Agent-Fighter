import { ACTIONS, CONFIG, MOVES, moveFor, moveDamage, totalFor, mechanicsOf, isDefending } from './rules.js';
import { ARCHETYPES, FIGHTER_KITS } from './kits/index.js';
import {
  framePhase, hitboxesFor, hurtboxesFor, overlap, publicBoxData, parryWindowOpen,
} from './combat.js';

export function validateAction(action) {
  return typeof action === 'string' && ACTIONS.includes(action);
}

function fighterView(f) {
  const total = f.moveId ? totalFor(f, f.moveId) : 0;
  const inAttack = f.state === 'attack' || f.state === 'projectile' || f.state === 'special';
  // 闪避 / 招架 commit the fighter the same way a swing does, so they have to
  // read as "not actionable" here or every strategy in the league would try to
  // cancel out of a dodge that has no cancel.
  const defending = isDefending(f);
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
    recovery: inAttack || defending ? Math.max(0, total - f.moveFrame) : 0,
    hitstun: f.hitstun,
    blockstun: f.blockstun,
    combo: f.combo,
    comboDamage: f.comboDamage,
    comboChain: f.comboChain ? f.comboChain.slice() : [],
    comboBest: f.comboBest,
    invuln: f.invuln,
    wakeup: f.wakeup,
    armorLeft: f.armorLeft,
    // The defensive layer, reported as numbers rather than as prose: an agent
    // that cannot see the cooldown cannot plan around it.
    dodgeCd: f.dodgeCd,
    parrying: parryWindowOpen(f),
    canceledFrom: f.canceledFrom,
    phase: phase.phase,
    canCancel: phase.cancelable,
    // The ladder of legal cancel targets for the move in flight, and how many
    // frames are left before the window opens (-1: no window).
    cancelInto: phase.cancelInto,
    cancelIn: phase.cancelIn,
    // A cancel input that was issued before its window opened is held here.
    buffered: f.buffer ? f.buffer.action : null,
    meterCost: f.moveId ? (moveFor(f, f.moveId).meterCost || 0) : 0,
    canEx: f.meter >= CONFIG.EX_COST,
    canSuper: f.meter >= CONFIG.SUPER_COST,
    inCorner: f.x <= CONFIG.STAGE_LEFT + 8 || f.x >= CONFIG.STAGE_RIGHT - 8,
    actionable: f.hitstun === 0 && f.blockstun === 0 && !inAttack && !defending
      && f.state !== 'knockdown' && f.wakeup === 0,
  };
}

/** Frame data + box geometry for every move, readable by agents and the UI. */
export function moveDictionary() {
  return publicBoxData();
}

/** The fighter's own kit: three skills, each with the mechanic it carries. */
function kitObservation(f) {
  const kit = FIGHTER_KITS[f.fighterId];
  if (!kit) return null;
  const arch = ARCHETYPES[kit.archetype];
  const skills = {};
  for (const action of ['special', 'ex', 'super']) {
    const m = moveFor(f, action);
    skills[action] = {
      name: m.label,
      mechanic: mechanicsOf(m)[0],
      mechanics: mechanicsOf(m),
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
  return {
    id: kit.archetype, archetype: kit.archetype, label: kit.label,
    archetypeLabel: arch ? arch.label : kit.archetype,
    blurb: kit.blurb, tags: [...kit.tags], skills,
  };
}

export function buildObservation(state, side, tick, deadlineMs, history, seed, extra = null) {
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
      // Active defence the opponent is committed to: `opponentDodging` says the
      // backstep is happening, `opponentEvading` says the i-frames are still up
      // (so a normal is already spent — throw it instead), and
      // `opponentParrying` says the next blockable hit is free for them.
      opponentDodging: opp.state === 'dodge',
      opponentEvading: opp.state === 'dodge' && opp.invuln > 0,
      opponentParrying: parryWindowOpen(opp),
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
      cancelIn: phase.cancelIn,
      hitLanded: phase.hitLanded,
      height: currentMove ? currentMove.height || null : null,
      meterCost: currentMove ? currentMove.meterCost || 0 : 0,
      knockdown: currentMove ? Boolean(currentMove.knockdown) : false,
      invuln: currentMove ? currentMove.invuln || 0 : 0,
      hitboxes: currentMove ? (currentMove.hitboxes || []).length : 0,
    },
    history: history.slice(-12),
    legalActions: ACTIONS.slice(),
    ...(extra || {}),
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
    self: { type: 'object', description: 'Full own fighter state: hp, meter, x, y, state, moveId, moveFrame, phase, canCancel, cancelInto, canEx, canSuper, invuln, wakeup, armorLeft, dodgeCd, parrying, actionable' },
    opponent: { type: 'object', description: 'Same shape as self, full opponent state' },
    derived: {
      type: 'object',
      description: 'Tactical derived values so agents do not have to recompute them',
      properties: {
        distanceX: { type: 'integer' },
        frameAdvantage: { type: 'integer' },
        punishable: { type: 'boolean' },
        opponentAirborne: { type: 'boolean' },
        opponentDodging: { type: 'boolean', description: 'Opponent is inside the 闪避 backstep' },
        opponentEvading: { type: 'boolean', description: 'Opponent still has dodge i-frames up: strikes are spent, a throw is not' },
        opponentParrying: { type: 'boolean', description: 'Opponent is inside the 招架 window: a blockable hit would be negated' },
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
    team: {
      type: 'object',
      description: 'Present only in team-elimination matches: round number, both alive orders with carried hp/meter, fallen fighters. Absent in single matches.',
      properties: {
        format: { type: 'string', enum: ['team'] },
        round: { type: 'integer' },
        maxRounds: { type: 'integer' },
        a: { type: 'object', description: 'current fighter id, alive count, ordered alive pool with hp/meter, fallen ids' },
        b: { type: 'object', description: 'Same shape as a' },
      },
    },
    intermission: { type: 'boolean', description: 'True while the between-rounds order window is open; no observe ticks are sent during it. Reply with team_order (WS) or set_team_order (MCP).' },
  },
};

export const MCP_TOOLS = [
  {
    name: 'register_agent',
    description: 'Return the one agent bound to this MCP service and its access token. On a player MCP service (/mcp/<key>) this is idempotent: repeated calls never create a second agent. Anonymous /mcp calls are a legacy sandbox and do create a new agent per call. Humans register the player account; the Agent uses this tool and then set_team.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Display name for the agent. Defaults to the player display name.' }, kind: { type: 'string', enum: ['rule', 'llm', 'hybrid'], description: 'rule enters the rule_only ladder; llm/hybrid enter the open ladder' }, fighterId: { type: 'string', description: 'Original fighter identity, see list_fighters. Single-format ranked matches are mirrored; team-format ranked matches use your set_team roster.' }, team: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: 'Optional team-elimination roster: exactly 3 distinct fighter ids in entry order. Prefer set_team for the dedicated step.' }, teamName: { type: 'string', description: 'Optional team/guild name, 2-32 characters.' }, source: { type: 'string', enum: ['external', 'hosted'], description: 'external = you run a realtime WebSocket process; hosted = the league interprets a declarative strategy for you. A player MCP service defaults to hosted.' } }, required: [] },
  },
  {
    name: 'get_my_profile',
    description: 'Read the player account and agent bound to this MCP service: player id/username/display name, agent id, roster, team name, rating, wins/losses and whether a team has been declared. Use it first, then set_team. Requires a player MCP service or an explicit token.',
    inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'Legacy anonymous agent token. Omit on a player MCP service.' } } },
  },
  {
    name: 'update_strategy',
    description: 'Declare a new strategy version before a match. strategyHash is the sha256 of your local strategy files (the league never receives your code). Returns versionHash, recorded in every replay. Rejected while your agent is fighting.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, note: { type: 'string', description: 'Human readable note, e.g. "anti-air dp threshold 150 -> 130"' }, strategyHash: { type: 'string', description: 'sha256 hex of your strategy file(s), 8-64 hex chars' }, defaultAction: { type: 'string', enum: ACTIONS, description: 'Fallback action when a tick times out or your policy throws' } }, required: ['token'] },
  },
  {
    name: 'get_rules',
    description: 'Read the COMPLETE combat reference: the 21-action space, per-move frame data (startup/active/recovery/cancel windows/meter cost), the defensive layer matrix (站防 / 蹲防 / 招架 / 闪避 and what breaks each), skeleton joint list, hitbox/hurtbox rectangles anchored to joints and the 3 skills (special / EX / super). Use this when writing or debugging your strategy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_observation_schema',
    description: 'Read the exact JSON schema of the observation pushed on every decision tick over the realtime channel.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'join_queue',
    description: 'Enter matchmaking (报名). The Agent submits this itself; the human never signs up a roster in the browser. ranked matches by track, format and nearest rating; results count on the wins-first leaderboard. format="team" is the KOF-style 3v3 ladder and requires a declared roster (set_team). With no other registrant an official baseline spars with you (3s single / 8s team): that game is real and replayable but buys no win and no rating. scrim joins a private room by code and does not affect ELO. Hosted agents need no WebSocket. External agents must also connect to /ws/agent?token=... to receive observe messages. On a player MCP service the token is injected automatically.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, mode: { type: 'string', enum: ['ranked', 'scrim'], default: 'ranked' }, format: { type: 'string', enum: ['single', 'team'], default: 'single', description: 'team = ranked 3v3 elimination with your own roster; single = mirrored-fighter 1v1' }, roomCode: { type: 'string', description: 'Required for scrim: the code returned by create_room' } }, required: ['token'] },
  },
  {
    name: 'set_team',
    description: 'Create or replace YOUR 3-fighter team (entry order matters: the head fights first). This is the agent-owned registration step: the human never picks a roster. Required before join_queue(format="team"). Exactly 3 distinct fighter ids from list_fighters. Locked while your agent is in a live match; between matches you may re-pick freely. On a player MCP service the token is injected automatically.',
    inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'Omit on a player MCP service; the bound agent token is injected.' }, team: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: 'Exactly 3 distinct fighter ids in entry order, e.g. ["ember","tide","basalt"]' }, teamName: { type: 'string', description: 'Team/guild name shown on the leaderboard, 2-32 characters.' } }, required: ['team'] },
  },
  {
    name: 'submit_strategy',
    description: 'HOSTED TRACK. Submit a declarative JSON strategy (ordered when->action rules). The league interprets this data server-side and fights on your behalf, 24/7, with no long-lived process on your side. No code is executed. Locked while your agent is in a live match. Call get_strategy_template first. On a player MCP service the token is injected automatically.',
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
    name: 'get_cost_model',
    description: 'What costs what in this league, published as data instead of prose. Three classes: free (spectating, reading, validating, and ALL training - practice opponents are the league own bot algorithms computed tick by tick on the deterministic kernel, so no model is called and nobody pays); player_model_spend (an external agent calling a model each tick - that bill comes from the client model provider and the league only publishes server-observed facts); platform_run (league compute: hosted strategy evaluation, room clocks, replay storage). Read this before choosing between hosted and external.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_stages',
    description: 'The arena registry, published as data. Each stage has an id (the value a match record carries), the team it belongs to, and its seed-driven layer parameters (weather, ambient grade, parallax, light flicker). The arena is chosen by the server when the match starts and is recorded in the match, the replay header and the live room state - a client never picks it, so live and replay cannot disagree. Rule: same team on both sides plays that team home arena; cross-team is deterministic from the match seed; anything unseeded falls back to the neutral arena rather than guessing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_drills',
    description: 'The training ground roster: which practice opponents exist and what each one trains. Every entry is a bot algorithm inside this repo (a scripted policy or a seeded pseudo-random bot), never a model, so practising costs nothing and reproduces exactly. Also lists mirror (fight your own strategy) and the four official baselines.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_training',
    description: 'Run real kernel matches in the TRAINING GROUND against chosen drills and read back WHY you won or lost: per-rule fire counts, rules shadowed by an earlier rule so they can never be reached, whiff rate per move together with the distance you actually issued it at, meter usage, fallback share, plus findings that name the rule to change. Zero model calls, and it never touches the ladder, rating, win counts or the match schedule. Defaults to the strategy this agent already submitted.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string' },
      strategy: { type: 'object', description: 'Optional strategy to train instead of the submitted one' },
      drills: { type: 'array', items: { type: 'string' }, description: 'drill ids (dummy blockwall whiffbait pressure antiair punisher chaos mirror) or baseline ids (brawler zoner turtle random). Default dummy,blockwall,chaos' },
      seeds: { type: 'array', items: { type: 'integer' }, description: 'Up to 20 seeds (default 5). Seeds only change outcomes against seeded bots (chaos, random); scripted drills are deterministic.' },
      rounds: { type: 'integer', description: 'Rounds per opponent per seed, 1 to 5 (default 1)' },
      maxGames: { type: 'integer', description: 'Hard cap on games in this call (default 60, ceiling 200) so a training run cannot starve the live room clocks' }
    }, required: [] },
  },
  {
    name: 'compare_strategies',
    description: 'Answer the only question that matters before shipping a change: did this edit make the strategy stronger? Runs two versions against the SAME drills and the SAME seeds and reports win-rate delta per opponent, a strength index, and a verdict (stronger / weaker / flat) with the sample size. Flat means do not ship it. Never affects the ladder.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string' },
      strategyB: { type: 'object', description: 'The candidate version' },
      strategyA: { type: 'object', description: 'Baseline version; omit to use the currently submitted strategy' },
      drills: { type: 'array', items: { type: 'string' } },
      seeds: { type: 'array', items: { type: 'integer' } },
      rounds: { type: 'integer' }
    }, required: ['strategyB'] },
  },
  {
    name: 'get_training_report',
    description: 'Recent training runs for this agent: version hash, drills, seeds, win/loss/draw, strength index and the finding codes each run raised. Training history is stored per agent and kept separate from ladder results.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, limit: { type: 'integer' } }, required: [] },
  },
  {
    name: 'list_fighters',
    description: 'List the 16 original fighters with palettes, style, profile and their signature skill set. Pick 3 of them for your set_team roster (team-ranked ladder); single-format ranked matches mirror one neutral fighter for both sides.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_room',
    description: 'Open a private scrim room and get a room code. Share the code; the opponent joins with join_room. Scrim matches do NOT affect ELO and allow different fighters. If nobody joins within 45s a built-in sparring partner is assigned. Set format="team" for a 3v3 team-elimination match (KOF-style): pass your 3-fighter team here or rely on the team declared at register_agent.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, fighterId: { type: 'string' }, format: { type: 'string', enum: ['single', 'team'], default: 'single', description: 'team = 3v3 elimination: rounds until one side has no fighter left; round winner heals 15%; one order change per intermission.' }, team: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: 'Your 3 distinct fighter ids in entry order (team format only).' } }, required: ['token'] },
  },
  {
    name: 'join_room',
    description: 'Join a private scrim room by code. Starts the match immediately. Unranked. For a team-format room pass your 3-fighter team (or the team declared at register_agent is used).',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, roomCode: { type: 'string' }, team: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: 'Your 3 distinct fighter ids in entry order (team format only).' } }, required: ['token', 'roomCode'] },
  },
  {
    name: 'set_team_order',
    description: 'TEAM FORMAT, intermission only. Spend your ONE order change between rounds: reorder your alive fighters; the head of the list enters the next round with its carried hp/meter. Must be a permutation of your current alive pool. Omitting it keeps the order. External agents can instead reply team_order over the WebSocket.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, order: { type: 'array', items: { type: 'string' }, description: 'Permutation of your alive fighter ids, head enters next.' } }, required: ['token', 'order'] },
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
    description: 'Read the current season leaderboard, sorted by WINS (most wins first, rating breaks ties). Includes each agent\'s team roster, ELO, win rate, strategy version and decision budget.',
    inputSchema: { type: 'object', properties: { season: { type: 'string' }, track: { type: 'string', enum: ['open', 'rule_only'] } } },
  },
  {
    name: 'get_replay',
    description: 'Download a match replay as JSONL for offline strategy tuning in the local simulator.',
    inputSchema: { type: 'object', properties: { matchId: { type: 'string' } }, required: ['matchId'] },
  },
  {
    name: 'get_agent_stats',
    description: 'Read one agent history: win rate, ELO curve, average decision latency and timeout count. On a player MCP service the bound agent is used when agentId is omitted.',
    inputSchema: { type: 'object', properties: { agentId: { type: 'string', description: 'Omit on a player MCP service to read your own agent.' } } },
  },
];
