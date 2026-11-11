/**
 * RexAI image API client for the sprite pipeline.
 *
 * Async job protocol: POST /v1/images/generations -> 202 {id}, then poll
 * GET /v1/images/jobs/{id} until succeeded/failed. The key is read ONLY from
 * REXAI_API_KEY; it is never logged. A 5xx/429 answer from the submit call
 * resubmits up to maxAttempts because the server refused, so nothing was
 * created; a submit that never answered dies with its intent spelled out,
 * because retrying it pays for the image twice. Hard 4xx errors die
 * immediately. Every request is bounded by REQUEST_MS, so a stalled socket
 * cannot outlive timeoutMs and a batch worker can never hang.
 */
import fs from 'node:fs';

const BASE = process.env.REXAI_BASE_URL || 'https://coding.rexai.top';
const POLL_MS = 4000;
// A stalled socket must never outlive the job budget: fetch() has no default
// timeout, and a batch worker blocked on one request ignores its deadline.
const REQUEST_MS = Number(process.env.REXAI_REQUEST_MS || 45000);
const DOWNLOAD_MS = 120000;

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
    signal: AbortSignal.timeout(REQUEST_MS),
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
  const res = await fetch(BASE + '/v1/images/jobs/' + id, {
    headers: headers(), signal: AbortSignal.timeout(REQUEST_MS),
  });
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
    const res = await fetch(r.url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
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
      // A submit that never answered may still have created a job upstream,
      // and resubmitting pays for the image twice. Only a clean HTTP 5xx/429
      // (the server refused, so nothing was created) is safe to retry.
      lastError = err;
      if (err.status === 429 || (err.status && err.status >= 500)) continue;
      if (!err.status) {
        throw new Error('submit did not complete (' + err.name + ': ' + err.message
          + '); the job may exist upstream — check by id before resubmitting');
      }
      throw err;
    }
    onPoll('submitted:' + jobId, 0);
    let pollFails = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let job;
      try {
        job = await pollOnce(jobId);
        pollFails = 0;
      } catch (err) {
        if (err.status && err.status < 500) throw err;
        // A stalled link used to be invisible here: the worker kept waiting and
        // the log went silent. Say so, but keep the job and its budget.
        if (++pollFails % 15 === 1) {
          onPoll('poll-error:' + (err.name || 'http ' + err.status) + ' x' + pollFails,
            Math.round((timeoutMs - (deadline - Date.now())) / 1000));
        }
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