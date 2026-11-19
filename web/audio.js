/* global window, fetch */
/**
 * Fight audio — sample-based with a procedural fallback.
 *
 * Primary sounds are short, trimmed hit samples from Kenney's "Impact Sounds"
 * (CC0 / public domain — see web/sfx/LICENSE.md). They give real foley "meat"
 * that pure oscillator synthesis can't match. A combo climbs in pitch by
 * raising the sample playbackRate a semitone per hit; damage picks a light /
 * medium / heavy variant. Damage variants and a few hits are chosen at random
 * so a flurry never sounds machine-gunned.
 *
 * If a sample can't be fetched/decoded (offline, missing asset), the cue falls
 * back to the original Web Audio synthesis, so audio never goes silent just
 * because an asset failed. Sound is ON by default; browsers still keep an
 * AudioContext suspended until a real user gesture, so the first click/keypress
 * resumes it and fetches the samples (see armDefaultAudio).
 */
let audio = null;
let enabled = true;
let master = null;   // limiter -> destination
let drive = null;    // saturation bus -> master (synth fallback only)
let samples = null;  // { key: AudioBuffer[] } once loaded
let loading = false;

const SFX = {
  light: ['/sfx/punch_medium_0.ogg', '/sfx/punch_medium_1.ogg', '/sfx/punch_medium_2.ogg'],
  medium: ['/sfx/punch_medium_0.ogg', '/sfx/punch_medium_2.ogg', '/sfx/punch_medium_1.ogg'],
  heavy: ['/sfx/punch_heavy_0.ogg', '/sfx/punch_heavy_1.ogg', '/sfx/punch_heavy_2.ogg'],
  block: ['/sfx/block_0.ogg'],
  parry: ['/sfx/parry_0.ogg'],
};

function context() {
  if (audio) return audio;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  audio = new Ctor();
  if (audio.createDynamicsCompressor) {
    const comp = audio.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 10;
    comp.ratio.value = 8;
    comp.attack.value = 0.001;
    comp.release.value = 0.1;
    comp.connect(audio.destination);
    master = comp;
  } else {
    master = audio.destination;
  }
  if (audio.createWaveShaper) {
    const shaper = audio.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 2.6) / Math.tanh(2.6);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    shaper.connect(master);
    drive = shaper;
  } else {
    drive = master;
  }
  return audio;
}

/** Fetch + decode all samples once. Failures leave a key empty (synth fallback). */
async function loadSamples() {
  if (samples || loading) return;
  loading = true;
  const ctx = context();
  if (!ctx || !ctx.decodeAudioData) { loading = false; return; }
  const out = {};
  const jobs = [];
  for (const [key, urls] of Object.entries(SFX)) {
    out[key] = [];
    for (const url of urls) {
      jobs.push(
        fetch(url)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((buf) => (buf ? new Promise((res) => ctx.decodeAudioData(buf, res, () => null)) : null))
          .then((decoded) => { if (decoded) out[key].push(decoded); })
          .catch(() => {}),
      );
    }
  }
  await Promise.all(jobs);
  samples = out;
  loading = false;
}

export function isEnabled() {
  return enabled;
}

export function setEnabled(value) {
  enabled = Boolean(value);
  if (enabled) {
    const ctx = context();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    loadSamples();
  }
  return enabled;
}

/** Sound is on by default, but browsers block AudioContext until a user
 *  gesture. Arm a one-shot bootstrap so the first interaction starts audio and
 *  fetches the foley samples — the toggle does not have to be touched. If the
 *  user switched sound off before that first gesture, stay off. */
function armDefaultAudio() {
  if (typeof window === 'undefined') return;
  const start = () => {
    window.removeEventListener('pointerdown', start);
    window.removeEventListener('keydown', start);
    if (!enabled) return;
    const ctx = context();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    loadSamples();
  };
  window.addEventListener('pointerdown', start, { once: true });
  window.addEventListener('keydown', start, { once: true });
}
armDefaultAudio();

/** Play a decoded sample. Returns false if unavailable so the caller can fall back.
 *  `offset` skips the foley's lead-in so the audible impact (not the file start)
 *  lands exactly on the visual hit frame — otherwise sounds lag the punch 1-2
 *  frames. A short gain envelope trims the long foley to a tight fighting hit. */
function sample(key, at, rate, peak, tail = 0.13, offset = 0) {
  const arr = samples?.[key];
  if (!arr || !arr.length) return false;
  const ctx = audio;
  const buf = arr[Math.floor(Math.random() * arr.length)];
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const gain = ctx.createGain();
  const p = Math.max(0.0002, peak);
  gain.gain.setValueAtTime(p, at);
  gain.gain.setValueAtTime(p, at + tail * 0.55);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + tail);
  gain.connect(master);
  src.connect(gain);
  // Start `offset` seconds into the buffer (source time), so the transient peak
  // is heard at `at`, aligned with the frame the hit is drawn on.
  src.start(at, offset / rate);
  src.stop(at + tail + 0.02);
  return true;
}

// ---- Procedural fallback (kept from the pre-sample synthesizer) ----
function env(ctx, node, at, attack, decay, peak, dest) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  node.connect(gain);
  gain.connect(dest || master);
}
function body(ctx, type, from, to, at, decay, peak, dest) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, from), at);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + decay);
  env(ctx, osc, at, 0.002, decay, peak, dest);
  osc.start(at); osc.stop(at + decay + 0.03);
}
function burst(ctx, at, duration, peak, fromHz, toHz, q = 1, dest) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const w = 1 - i / length;
    data[i] = (Math.random() * 2 - 1) * w * w;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = q;
  band.frequency.setValueAtTime(Math.max(40, fromHz), at);
  band.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), at + duration);
  src.connect(band);
  env(ctx, band, at, 0.001, duration, peak, dest);
  src.start(at);
}

function synthHit(ctx, at, weight, rise, combo) {
  const bus = drive;
  body(ctx, 'sine', 135 * rise, 44, at, 0.085 * weight, 0.17 * weight, bus);
  burst(ctx, at, 0.014, 0.13 * weight, 3600 * rise, 900, 0.8, bus);
  body(ctx, 'triangle', 280 * rise, 105, at, 0.055, 0.075 * weight, bus);
  burst(ctx, at, 0.05, 0.055 * weight, 900 * rise, 260, 1.5 + (1.45 - weight), bus);
  if (weight > 1.05) body(ctx, 'sine', 96, 40, at + 0.016, 0.1, 0.06 * weight, bus);
  if (combo >= 2) body(ctx, 'square', 1040 * rise, 780 * rise, at + 0.006, 0.02, bus);
}

/** Play one semantic cue. `event` is the full server event when available. */
export function play(kind, event = null) {
  if (!enabled) return;
  const ctx = context();
  if (!ctx || ctx.state !== 'running') return;
  const at = ctx.currentTime + 0.001;
  switch (kind) {
    case 'hit': {
      const damage = Number(event?.damage) || 60;
      const combo = Math.max(1, Number(event?.combo) || 1);
      const weight = Math.min(1.45, Math.max(0.5, damage / 110));
      const rise = Math.pow(2, Math.min(combo - 1, 12) / 12); // semitone per combo hit
      const tier = damage < 60 ? 'light' : damage < 110 ? 'medium' : 'heavy';
      const peak = Math.min(0.9, 0.5 + 0.22 * weight);
      // Skip each sample's lead-in so its impact peak lands on the visual frame.
      const leadIn = tier === 'heavy' ? 0.028 : 0.018;
      // Sample first; a faint sub thump adds chest weight under the foley.
      const ok = sample(tier, at, rise, peak, 0.11 + 0.05 * weight, leadIn);
      if (ok && ctx.createOscillator) body(ctx, 'sine', 120, 48, at, 0.07, 0.06 * weight, drive);
      if (!ok) synthHit(ctx, at, weight, rise, combo);
      break;
    }
    case 'block':
      if (!sample('block', at, 0.95 + Math.random() * 0.1, 0.6, 0.1)) {
        burst(ctx, at, 0.05, 0.045, 3400, 1400, 2.4, drive);
        body(ctx, 'square', 460, 300, at, 0.05, 0.024, drive);
      }
      break;
    case 'parry':
      if (!sample('parry', at, 1.05, 0.7, 0.28)) {
        body(ctx, 'square', 1300, 900, at, 0.07, 0.045, drive);
        body(ctx, 'sine', 1950, 1500, at + 0.012, 0.1, 0.03, drive);
      }
      break;
    case 'counter':
    case 'armor':
      if (!sample('heavy', at, 0.9, 0.6)) {
        body(ctx, 'sawtooth', 240, 110, at, 0.18, 0.055, drive);
        burst(ctx, at, 0.12, 0.05, 900, 300, 1.2, drive);
      }
      break;
    case 'ko':
      if (!sample('heavy', at, 0.82, 0.85)) {
        body(ctx, 'sine', 130, 32, at, 0.95, 0.16, drive);
        burst(ctx, at, 0.55, 0.1, 800, 110, 0.9, drive);
      }
      break;
    case 'move_start': {
      const move = event?.move;
      if (['lp', 'mp', 'hp', 'lk', 'mk', 'hk'].includes(move)) {
        burst(ctx, at, 0.045, 0.013, 2200 + Math.random() * 900, 700, 0.7);
      }
      break;
    }
    case 'evade':
      burst(ctx, at, 0.16, 0.026, 1100, 400, 0.7);
      body(ctx, 'sine', 540, 190, at, 0.12, 0.02);
      break;
    case 'super_start':
      body(ctx, 'sawtooth', 180, 760, at, 0.45, 0.05, drive);
      body(ctx, 'sine', 90, 380, at + 0.05, 0.4, 0.05, drive);
      burst(ctx, at, 0.4, 0.02, 400, 2400, 0.8, drive);
      break;
    case 'wakeup':
      body(ctx, 'triangle', 520, 520, at, 0.05, 0.02);
      break;
    case 'cancel':
      body(ctx, 'triangle', 640, 980, at, 0.09, 0.028);
      break;
    default:
      break;
  }
}
