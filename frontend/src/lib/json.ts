/**
 * JSON parsing without try/catch.
 *
 * A synchronous throw from `JSON.parse` is turned into a typed result by
 * deferring the call into a promise chain, so callers get an explicit
 * `{ ok, value | error }` outcome instead of an exception.
 */
export type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function parseJson(text: string, fallbackError = 'JSON 解析失败'): Promise<JsonResult> {
  return Promise.resolve()
    .then((): JsonResult => ({ ok: true, value: JSON.parse(text) as unknown }))
    .catch((error: unknown): JsonResult => ({
      ok: false,
      error: error instanceof Error ? error.message : fallbackError,
    }));
}
