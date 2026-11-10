#!/usr/bin/env node
/** Explicit destructive clean of generated asset output. Never run on deploy. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ASSETS = path.join(ROOT, 'web', 'assets');
for (const target of ['v', 'manifest.json', 'manifest.prev.json', 'build-info.json']) {
  fs.rmSync(path.join(ASSETS, target), { recursive: true, force: true });
}
console.log('[assets:clean] removed web/assets/v + manifest files');
