/**
 * RexAI image API client for the sprite pipeline.
 *
 * Async job protocol: POST /v1/images/generations -> 202 {id}, then poll
 * GET /v1/images/jobs/{id} until succeeded/failed. The key is read ONLY from
 * REXAI_API_KEY; it is never logged. Transient upstream failures (timeout /
 * 5xx / 429) resubmit up to maxAttempts; hard 4xx errors die immediately.
 * Every call exits within timeoutMs so a batch worker can never hang.
 */
import fs from 'node:fs';

const BASE = process.env.REXAI_BASE_URL || 'https://coding.rexai.top';
const POLL_MS = 4000;

function apiKey() {
  const key = process.env.REXAI_API_KEY;
  if (!key) throw new Error('REXAI_API_KEY is not set');
  return key;
}

function headers() {
  return { Authorization: 'Bearer ' + apiKey(), 'Content-Type': 'application/json' };
}

function imageDataUri(file) {
  const buf = fs.readFileSync(file);
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function submit({ model, prompt, image, size }) {
  const body = { model, prompt, n: 1, size };
  if (image) body.images = [imageDataUri(image)];
  const res = await fetch(BASE + '/v1/images/generations', {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('submit failed: HTTP ' + res.status + ' ' + text.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  const job = JSON.parse(text);
  if (!job.id) throw new Error('submit returned no job id: ' + text.slice(0, 200));
  return job.id;
}

async function pollOnce(id) {
  const res = await fetch(BASE + '/v1/images/jobs/' + id, { headers: headers() });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('poll failed: HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

function isTransient(job) {
  const msg = JSON.stringify(job.error || {});
  return /timeout|500|502|503|429|rate_limit|circuit|unavailable/i.test(msg);
}

async function resultBuffer(job) {
  const r = job.result || {};
  if (r.b64_json) return Buffer.from(r.b64_json, 'base64');
  if (r.url) {
    const res = await fetch(r.url);
    if (!res.ok) throw new Error('result download failed: HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('succeeded job carries no image payload');
}

/**
 * Generate one image. Returns { jobId, productId, buffer }.
 * onPoll(status, elapsedSec) is called for progress logging.
 */
export async function generateImage({
  model, prompt, image = null, size = '1024x1024',
  timeoutMs = 540000, maxAttempts = 3, onPoll = () => {},
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (Date.now() >= deadline) break;
    let jobId;
    try {
      jobId = await submit({ model, prompt, image, size });
    } catch (err) {
      lastError = err;
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      continue;
    }
    onPoll('submitted:' + jobId, 0);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let job;
      try {
        job = await pollOnce(jobId);
      } catch (err) {
        if (err.status && err.status < 500) throw err;
        continue; // transient poll error: keep waiting until the deadline
      }
      const elapsed = Math.round((timeoutMs - (deadline - Date.now())) / 1000);
      onPoll(job.status, elapsed);
      if (job.status === 'succeeded') {
        return { jobId, productId: job.product_id || model, buffer: await resultBuffer(job) };
      }
      if (job.status === 'failed') {
        lastError = new Error('job failed: ' + JSON.stringify(job.error || {}).slice(0, 300));
        if (isTransient(job)) break; // resubmit
        throw lastError;
      }
    }
  }
  throw lastError || new Error('generation timed out after ' + timeoutMs + 'ms');
}