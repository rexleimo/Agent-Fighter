/**
 * JSON decoding as a Result instead of a thrown exception.
 *
 * `JSON.parse` throws on malformed input. Call sites that accept client- or
 * file-supplied text need that failure as a value, but may not use try/catch.
 * This is a small, strict recursive-descent decoder with the same accepted
 * grammar (RFC 8259) and the same value semantics, returning
 * `{ ok: true, value }` or `{ ok: false, error }`.
 */

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const MAX_DEPTH = 200;

/** Leading whitespace accepted by JSON: space, tab, LF, CR only. */
function isWhitespace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

export function parseJsonResult(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const length = src.length;
  let i = 0;
  let failed = false;

  function fail() {
    failed = true;
    return undefined; // undefined is never a valid JSON value, so it is a safe sentinel
  }

  function skipWhitespace() {
    while (i < length && isWhitespace(src.charCodeAt(i))) i += 1;
  }

  function readString() {
    if (src[i] !== '"') return fail();
    i += 1;
    let out = '';
    while (i < length) {
      const code = src.charCodeAt(i);
      if (code === 0x22) { i += 1; return out; }
      if (code === 0x5c) {
        i += 1;
        if (i >= length) return fail();
        const esc = src[i];
        i += 1;
        if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === 'u') {
          if (i + 4 > length) return fail();
          const hex = src.slice(i, i + 4);
          if (!HEX4.test(hex)) return fail();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else return fail();
        continue;
      }
      if (code < 0x20) return fail(); // raw control characters are not JSON
      out += src[i];
      i += 1;
    }
    return fail();
  }

  function readNumber() {
    const match = NUMBER.exec(src.slice(i));
    if (!match || match.index !== 0) return fail();
    i += match[0].length;
    return Number(match[0]);
  }

  function readValue(depth) {
    if (depth > MAX_DEPTH) return fail();
    skipWhitespace();
    if (i >= length) return fail();
    const c = src[i];
    if (c === '"') return readString();
    if (c === '{') return readObject(depth);
    if (c === '[') return readArray(depth);
    if (c === 't') {
      if (!src.startsWith('true', i)) return fail();
      i += 4;
      return true;
    }
    if (c === 'f') {
      if (!src.startsWith('false', i)) return fail();
      i += 5;
      return false;
    }
    if (c === 'n') {
      if (!src.startsWith('null', i)) return fail();
      i += 4;
      return null;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return readNumber();
    return fail();
  }

  function readObject(depth) {
    i += 1; // '{'
    const out = {};
    skipWhitespace();
    if (src[i] === '}') { i += 1; return out; }
    while (i < length) {
      const key = readString();
      if (failed) return undefined;
      skipWhitespace();
      if (src[i] !== ':') return fail();
      i += 1;
      const value = readValue(depth + 1);
      if (failed) return undefined;
      // defineProperty keeps "__proto__" as an own data key, exactly like JSON.parse.
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      skipWhitespace();
      if (src[i] === ',') { i += 1; skipWhitespace(); continue; }
      if (src[i] === '}') { i += 1; return out; }
      return fail();
    }
    return fail();
  }

  function readArray(depth) {
    i += 1; // '['
    const out = [];
    skipWhitespace();
    if (src[i] === ']') { i += 1; return out; }
    while (i < length) {
      const value = readValue(depth + 1);
      if (failed) return undefined;
      out.push(value);
      skipWhitespace();
      if (src[i] === ',') { i += 1; skipWhitespace(); continue; }
      if (src[i] === ']') { i += 1; return out; }
      return fail();
    }
    return fail();
  }

  const value = readValue(0);
  if (failed) return { ok: false, error: new SyntaxError('Unexpected token in JSON at position ' + i) };
  skipWhitespace();
  if (i !== length) return { ok: false, error: new SyntaxError('Unexpected token in JSON at position ' + i) };
  return { ok: true, value };
}
