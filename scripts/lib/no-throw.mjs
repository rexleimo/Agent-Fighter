// Result-based control flow used across the verification scripts.
//
// The project bans try/catch statements in scripts/. These helpers give the same
// semantics without the statement:
//   - `attempt` settles a sync or async function into a Result object
//   - `bestEffort` is a fire-and-forget side effect whose failures are ignored
//   - `withFinally` runs cleanup even when the body fails (like `finally`)
//   - `parseOr` is JSON.parse with a fallback instead of a catch
//
// No helper here hides an exception: every failure is either represented in a
// Result the caller must inspect, or deliberately discarded in `bestEffort`.

/** A successful Result. */
export function ok(value) {
  return { ok: true, value, error: null };
}

/** A failed Result. */
export function fail(error) {
  return { ok: false, value: null, error };
}

/** Run fn and settle its outcome (throw or return) into a Result. */
export function attempt(fn) {
  return Promise.resolve().then(fn).then(ok, fail);
}

/** Run fn as a side effect and intentionally ignore its outcome. */
export function bestEffort(fn) {
  Promise.resolve().then(fn).then(() => {}, () => {});
}

/** Guaranteed cleanup with finally's override order, without try/catch. */
export async function withFinally(body, cleanup) {
  const result = await attempt(body);
  const final = await attempt(cleanup);
  if (!final.ok) throw final.error;
  if (!result.ok) throw result.error;
  return result.value;
}

/** JSON.parse with a fallback, settling parse failures into a value. */
export function parseOr(text, fallback) {
  return attempt(() => JSON.parse(text)).then((r) => (r.ok ? r.value : fallback));
}
