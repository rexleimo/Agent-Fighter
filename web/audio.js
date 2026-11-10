/**
 * Tiny procedural fight announcer. No audio files, no external assets.
 *
 * Browsers block AudioContext until a user gesture, so this starts disabled
 * and only creates/resumes the context from the sound toggle. Every cue is a
 * short oscillator/noise envelope, mixed quietly enough to sit under speech.
 */
let audio = null;
let enabled = false;

function context() {
  if (audio) return audio;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  audio = new Ctor();
  return audio;
}

export function isEnabled() {
  return enabled;
}

export function setEnabled(value) {
  enabled = Boolean(value);
  if (enabled) {
    const ctx = context();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  return enabled;
}

function env(ctx, node, at, attack, hold, release, peak = 0.08) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.setValueAtTime(peak, at + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  node.connect(gain);
  gain.connect(ctx.destination);
  return gain;
}

function tone(ctx, type, from, to, at, duration, peak = 0.06) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + duration);
  env(ctx, osc, at, 0.008, duration * 0.25, duration * 0.75, peak);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

function noise(ctx, at, duration, peak = 0.06, filter = 900) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const biquad = ctx.createBiquadFilter();
  biquad.type = 'bandpass';
  biquad.frequency.value = filter;
  biquad.Q.value = 0.8;
  src.connect(biquad);
  env(ctx, biquad, at, 0.004, duration * 0.2, duration * 0.8, peak);
  src.start(at);
}

/** Play one semantic cue. Safe to call on every frame; no-op when disabled. */
export function play(kind) {
  if (!enabled) return;
  const ctx = context();
  if (!ctx || ctx.state !== 'running') return;
  const at = ctx.currentTime + 0.001;
  switch (kind) {
    case 'hit':
      noise(ctx, at, 0.12, 0.08, 1200);
      tone(ctx, 'sine', 150, 60, at, 0.12, 0.08);
      break;
    case 'block':
      noise(ctx, at, 0.06, 0.035, 2600);
      tone(ctx, 'square', 420, 300, at, 0.05, 0.025);
      break;
    case 'counter':
    case 'armor':
      tone(ctx, 'sawtooth', 220, 110, at, 0.18, 0.06);
      noise(ctx, at, 0.1, 0.05, 700);
      break;
    case 'super_start':
      tone(ctx, 'sawtooth', 180, 720, at, 0.45, 0.05);
      tone(ctx, 'sine', 90, 360, at + 0.05, 0.4, 0.05);
      break;
    case 'ko':
      tone(ctx, 'sine', 110, 35, at, 0.9, 0.13);
      noise(ctx, at, 0.5, 0.09, 500);
      break;
    case 'wakeup':
      tone(ctx, 'triangle', 520, 520, at, 0.05, 0.02);
      break;
    case 'cancel':
      tone(ctx, 'triangle', 640, 960, at, 0.09, 0.03);
      break;
    default:
      break;
  }
}
