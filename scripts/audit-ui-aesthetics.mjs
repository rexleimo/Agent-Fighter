#!/usr/bin/env node
/**
 * UI aesthetic audit via Jev (TypeSafe System One).
 *
 * Scores a page screenshot on "mainstream human aesthetic" fit using Jev's
 * composite-scoring pattern: several narrow Score questions + one audience
 * Choice, all sent in a single request. Weights live here in code, so the
 * result is inspectable and tunable without re-prompting the model.
 *
 * The score is a directional signal, not truth — validate it against your own
 * examples before using it as an automated gate (see docs/ui-aesthetic-audit.md).
 *
 * Usage:
 *   TYPESAFE_API_KEY=... node scripts/audit-ui-aesthetics.mjs \
 *     --screenshot ./shot.png [--out ./audit.json] [--gate 0.6] [--context "..."]
 *   TYPESAFE_API_KEY=... node scripts/audit-ui-aesthetics.mjs \
 *     --capture http://localhost:5173/lobby [--out ./audit.json]
 *
 * Proxy: set HTTPS_PROXY / https_proxy, or on macOS the Wi-Fi system proxy is
 * auto-detected. Override with --proxy. Node 24 uses NODE_USE_ENV_PROXY=1.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Node resolves proxy env vars at startup, after imports. Detect the proxy in
// this parent process and re-launch once with NODE_USE_ENV_PROXY=1 + HTTPS_PROXY
// set, so auto-detection works without the caller remembering any flag.
const API_URL = 'https://api.typesafe.ai/v1/systemone';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function detectProxy(override) {
  if (override) return override;
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return null; // env already provided
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('networksetup', ['-getsecurewebproxy', 'Wi-Fi'], { encoding: 'utf8' });
      const enabled = /Enabled:\s*Yes/i.test(out);
      const server = (out.match(/Server:\s*(\S+)/) || [])[1];
      const port = (out.match(/Port:\s*(\S+)/) || [])[1];
      if (enabled && server && port) return `http://${server}:${port}`;
    } catch { /* no networksetup / no service — fall through */ }
  }
  return null;
}

if (process.env.NODE_USE_ENV_PROXY !== '1') {
  const override = process.argv.includes('--proxy')
    ? process.argv[process.argv.indexOf('--proxy') + 1]
    : null;
  const proxy = detectProxy(override);
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1' };
  if (proxy) { env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy; }
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
  process.exit(r.status ?? 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Judgment design (port of the verified audit) — change weights here, not in prompts.
const SCORE_QUESTIONS = {
  text_readability: {
    weight: 0.25,
    instructions: 'For an ordinary non-technical user, how easy is it to read the text in `screenshot`?',
    criteria: [
      'Text is tiny, low-contrast or cramped; most people would squint or skip it.',
      'Main text is readable but secondary labels/captions are small or faint.',
      'Most text is comfortable; only fine print is small.',
      'Text sizes and contrast are comfortable for a general audience throughout.',
    ],
  },
  visual_warmth: {
    weight: 0.25,
    instructions: 'How warm, welcoming and approachable does `screenshot` feel to a general audience?',
    criteria: [
      'Cold and austere, like a terminal or engineering console.',
      'Mostly cold/dark with only faint signs of visual warmth.',
      'Neutral and clean, with some approachable elements.',
      'Warm, inviting and friendly to a broad, non-technical audience.',
    ],
  },
  modern_feel: {
    weight: 0.15,
    instructions: 'Does `screenshot` look contemporary and current rather than dated?',
    criteria: [
      'Looks dated, like an old legacy interface.',
      'Mix of dated and current cues.',
      'Looks current, like a modern product.',
      'Looks cutting-edge and design-forward.',
    ],
  },
  color_harmony: {
    weight: 0.15,
    instructions: 'How harmonious and consistent is the color use in `screenshot`?',
    criteria: [
      'Clashing or inconsistent colors; hard to look at.',
      'A few inconsistencies or one accent overused.',
      'Consistent and pleasant, one clear accent, no jarring colors.',
      'Exemplary, disciplined palette that feels intentional throughout.',
    ],
  },
  layout_clarity: {
    weight: 0.20,
    instructions: 'How clear is the visual hierarchy and layout of `screenshot` for a first-time visitor?',
    criteria: [
      'Confusing; a newcomer would not know where to look or what to do.',
      'Serviceable but flat; important items do not stand out well.',
      'Clear hierarchy; a newcomer can scan and find the main action.',
      'Excellent hierarchy; the primary action is immediately obvious.',
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function prepareImage(inputPath, workdir) {
  if (!existsSync(inputPath)) throw new Error(`Screenshot not found: ${inputPath}`);
  const out = join(workdir, 'shot.png');
  // Normalize to PNG, longest side <= 1568 (also upscales tiny images above Jev's 280px floor).
  execFileSync('sips', ['-s', 'format', 'png', '-Z', '1568', inputPath, '--out', out], { stdio: 'pipe' });
  const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out], { encoding: 'utf8' });
  const w = Number((dims.match(/pixelWidth:\s*(\d+)/) || [])[1]);
  const h = Number((dims.match(/pixelHeight:\s*(\d+)/) || [])[1]);
  if (!w || !h || Math.min(w, h) < 280 || w * h > 2_458_624) {
    throw new Error(`Image out of Jev limits: ${w}x${h} (need each side 280-1568, area <= 2458624)`);
  }
  return { data: readFileSync(out).toString('base64'), w, h };
}

function captureUrl(url, workdir) {
  const out = join(workdir, 'captured.png');
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1440,960', '--virtual-time-budget=5000',
    `--screenshot=${out}`, url,
  ], { stdio: 'pipe', timeout: 60_000 });
  if (!existsSync(out)) throw new Error(`Chrome did not produce a screenshot for ${url}`);
  return out;
}

function buildBody(imageB64, context) {
  const ref = randomUUID();
  const questions = {};
  for (const [id, q] of Object.entries(SCORE_QUESTIONS)) {
    questions[id] = { type: 'score', instructions: q.instructions, criteria: q.criteria };
  }
  questions.audience = {
    type: 'choice',
    instructions: 'Which audience does the visual style in `screenshot` fit best?',
    criteria: {
      developers_technical: 'Developers and technical users.',
      general_consumers: 'Broad mainstream / general non-technical consumers.',
      gaming_esports: 'Gaming and esports fans.',
      enterprise_business: 'Enterprise / business professionals.',
    },
  };
  questions.empty_state_penalty = {
    type: 'noul',
    instructions: 'This screenshot may show an empty or loading data state. That missing data, rather than the visual design itself, would cause a general viewer to rate the page poorly.',
  };
  return {
    model: 'jev-latest',
    state: {
      screenshot: ref,
      context: context || 'A web UI page. Judge the visual design (color, typography, spacing, layout, hierarchy), not any missing data.',
    },
    assets: { [ref]: { type: 'image', format: 'png', data_base64: imageB64 } },
    questions,
  };
}

async function callJev(body) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
          'Content-Type': 'application/json',
          'TypeSafe-Danger-Zone-Images': 'true',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 451) throw new Error('Jev unavailable in your region (451). Configure a proxy via HTTPS_PROXY or --proxy.');
        if (res.status === 401 || res.status === 403) throw new Error('Jev auth failed (401/403). Check TYPESAFE_API_KEY.');
        throw new Error(`Jev request failed (${res.status}): ${text.slice(0, 300)}`);
      }
      return res.json();
    } catch (err) {
      // Retry only transient transport errors (proxy resets/timeouts), not auth/region errors.
      if (/ECONNRESET|ETIMEDOUT|UND_ERR|fetch failed/.test(err.message) && attempt < 3) {
        console.error(`  transport error (attempt ${attempt}/3): ${err.message} — retrying`);
        lastErr = err;
        await new Promise((r) => setTimeout(r, 700 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function computeResult(raw) {
  const a = raw.answers;
  const dims = {};
  let composite = 0;
  for (const [id, q] of Object.entries(SCORE_QUESTIONS)) {
    const ans = a[id];
    const norm = ans.score / (q.criteria.length - 1);
    dims[id] = { score: ans.score, normalized: Number(norm.toFixed(3)), confidence: ans.confidence, weight: q.weight };
    composite += q.weight * norm;
  }
  return {
    model: raw.model,
    composite: Number(composite.toFixed(3)),
    dimensions: dims,
    audience: a.audience,
    emptyStatePenalty: a.empty_state_penalty?.noul,
    usage: raw.usage,
  };
}

function printReport(result) {
  console.log('\n=== UI aesthetic audit (Jev) ===');
  console.log(`model: ${result.model}\n`);
  for (const [id, d] of Object.entries(result.dimensions)) {
    console.log(`  ${id.padEnd(18)} ${d.score.toFixed(2)}/${SCORE_QUESTIONS[id].criteria.length - 1}  norm=${d.normalized.toFixed(2)}  conf=${d.confidence.toFixed(2)}  w=${d.weight}`);
  }
  console.log(`\n  COMPOSITE (mainstream aesthetic) = ${result.composite}  (0..1)`);
  const aud = result.audience;
  console.log(`  best-fit audience = ${aud.choice} (conf ${aud.confidence.toFixed(2)})`);
  console.log('    ' + Object.entries(aud.probabilities).map(([k, v]) => `${k}:${v.toFixed(2)}`).join('  '));
  console.log(`  empty-state penalty (noul) = ${result.emptyStatePenalty}`);
  console.log(`  tokens: in=${result.usage?.input_tokens ?? '?'} out=${result.usage?.output_tokens ?? '?'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set.');
  const screenshot = args.screenshot && args.screenshot !== true ? args.screenshot : null;
  const capture = args.capture && args.capture !== true ? args.capture : null;
  if (!screenshot && !capture) throw new Error('Provide --screenshot <path> or --capture <url>.');

  if (process.env.HTTPS_PROXY) console.log(`Using proxy: ${process.env.HTTPS_PROXY}`);

  const workdir = mkdtempSync(join(tmpdir(), 'afl-audit-'));
  try {
    const imgPath = capture ? captureUrl(capture, workdir) : screenshot;
    const { data, w, h } = prepareImage(imgPath, workdir);
    console.log(`Image: ${w}x${h}, base64 ${(data.length / 1024).toFixed(0)} KB`);

    const raw = await callJev(buildBody(data, args.context && args.context !== true ? args.context : null));
    const result = computeResult(raw);
    printReport(result);

    if (args.out && args.out !== true) {
      const outPath = resolve(args.out);
      writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
      console.log(`\nWrote ${outPath}`);
    }

    if (args.gate && args.gate !== true) {
      const threshold = Number(args.gate);
      if (Number.isNaN(threshold)) throw new Error(`--gate must be a number, got ${args.gate}`);
      const pass = result.composite >= threshold;
      console.log(`\nGATE ${threshold}: ${pass ? 'PASS' : 'FAIL'} (composite ${result.composite})`);
      process.exitCode = pass ? 0 : 1;
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nAudit failed: ${err.message}`);
  if (err.cause) console.error(`  cause: ${err.cause.code || err.cause.message || err.cause}`);
  process.exitCode = 1;
});
