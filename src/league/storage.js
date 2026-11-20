/**
 * League disk boundary. Every read that used to swallow an error now returns
 * an explicit Result / empty default; no exception handling is needed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonResult } from '../json-result.js';

export function statOrNull(file) {
  return fs.statSync(file, { throwIfNoEntry: false });
}

export function readLeagueState(file) {
  const st = statOrNull(file);
  if (!st || !st.isFile()) return { ok: false };
  const parsed = parseJsonResult(fs.readFileSync(file, 'utf8'));
  if (!parsed.ok) return { ok: false };
  const raw = parsed.value;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.agents)) return { ok: false };
  return { ok: true, value: raw };
}

export function deleteIfExists(file) {
  const st = statOrNull(file);
  if (!st || !st.isFile()) return false;
  fs.unlinkSync(file);
  return true;
}

export function listJsonl(dir) {
  const st = statOrNull(dir);
  if (!st || !st.isDirectory()) return { ok: false, entries: [] };
  const entries = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      const fileStat = statOrNull(full);
      const mtimeMs = fileStat ? fileStat.mtimeMs : 0;
      return { full, name: f, id: f.slice(0, -'.jsonl'.length), mtimeMs };
    });
  return { ok: true, entries };
}

export function fileSizeOrZero(file) {
  const st = statOrNull(file);
  return st ? st.size : 0;
}

export function readTrainingRuns(file) {
  const st = statOrNull(file);
  if (!st || !st.isFile()) return [];
  const parsed = parseJsonResult(fs.readFileSync(file, 'utf8'));
  if (!parsed.ok || !parsed.value || !Array.isArray(parsed.value.runs)) return [];
  return parsed.value.runs;
}
