/**
 * Static resource serving: hashed assets, legacy aliases, the SPA shell and
 * the public read-only source subtrees. Extracted verbatim from server.js so
 * response headers, cache policies, ETag/gzip behaviour and 404/503 bodies
 * remain byte-for-byte compatible.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  assetsRoot, criticalPreloadTags, isHashedAssetPath, legacyAssetPath,
} from '../assets.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// Client-side routes served by the React app. The game assets and the
// read-only docs/sdk trees below keep their own prefixes.
const SPA_ROUTES = new Set(['/lobby', '/fighters', '/board', '/replay', '/connect', '/account', '/me', '/guide', '/training', '/library', '/setup']);

// Public, read-only subtrees served from the project root. Everything else
// comes from web/. Each subtree is resolved against its own directory so
// /docs/../data/league.json cannot leak tokens.
const ROOT_DIRS = (root) => ({
  '/sdk/': path.join(root, 'sdk'),
  // Read-only game source. The pose lab (web/rig-lab.html) imports the same
  // skeleton code the kernel uses, so the preview cannot drift from the game.
  '/src/': path.join(root, 'src'),
  '/docs/': path.join(root, 'docs'),
  '/examples/': path.join(root, 'examples'),
  '/skills/': path.join(root, 'skills'),
});

const GZIP_CACHE = new Map();
const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.svg']);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=3600, must-revalidate';

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('404');
}

function canGzip(req, type) {
  return /^(text\/|application\/json|image\/svg)/i.test(type)
    && String(req.headers['accept-encoding'] || '').includes('gzip');
}

function sendBuffer(req, res, buf, { type, cache, etag }) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': cache,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let body = buf;
  if (canGzip(req, type) && buf.length > 512) {
    const key = etag + ':' + buf.length;
    body = GZIP_CACHE.get(key);
    if (!body) {
      body = zlib.gzipSync(buf, { level: 9 });
      if (GZIP_CACHE.size > 200) GZIP_CACHE.clear();
      GZIP_CACHE.set(key, body);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end(); else res.end(body);
}

function serveFile(req, res, file, { cache = 'no-cache' } = {}) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) { notFound(res); return; }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  if (TEXT_EXT.has(ext)) {
    sendBuffer(req, res, fs.readFileSync(file), { type, cache, etag });
    return;
  }
  const headers = {
    'Content-Type': type,
    'Cache-Control': cache,
    'Content-Length': stat.size,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

export function createStaticServer(ctx) {
  const { ROOT, WEB_DIR, WEB_DIST, WEB_DIST_INDEX } = ctx;
  const dirs = ROOT_DIRS(ROOT);

  function serveIndex(req, res) {
    if (!fs.existsSync(WEB_DIST_INDEX)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('web/dist is missing. Run `pnpm build:web` (or `npm start`, which builds first).');
      return;
    }
    const html = fs.readFileSync(WEB_DIST_INDEX, 'utf8').replace('<!--ASSET_PRELOAD-->', criticalPreloadTags());
    const buf = Buffer.from(html);
    const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
    sendBuffer(req, res, buf, { type: 'text/html; charset=utf-8', cache: 'no-cache', etag });
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/assets/manifest.json') {
      serveFile(req, res, path.join(assetsRoot(), 'manifest.json'), { cache: 'no-cache' });
      return;
    }
    if (pathname === '/assets/sprites.json') {
      serveFile(req, res, path.join(assetsRoot(), 'sprites.json'), { cache: 'no-cache' });
      return;
    }
    if (pathname.startsWith('/assets/v/')) {
      if (!isHashedAssetPath(pathname)) { notFound(res); return; }
      const file = path.resolve(assetsRoot(), pathname.slice('/assets/'.length));
      if (!file.startsWith(assetsRoot() + path.sep)) { notFound(res); return; }
      serveFile(req, res, file, { cache: IMMUTABLE });
      return;
    }
    if (pathname.startsWith('/assets/')) {
      const legacy = legacyAssetPath(pathname);
      if (legacy) { serveFile(req, res, legacy, { cache: REVALIDATE }); return; }
      notFound(res);
      return;
    }
    if (pathname.startsWith('/app/')) {
      const appRoot = path.join(WEB_DIST, 'app');
      const file = path.resolve(appRoot, pathname.slice('/app/'.length));
      if (!file.startsWith(appRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        notFound(res);
        return;
      }
      serveFile(req, res, file, { cache: IMMUTABLE });
      return;
    }
    if (pathname === '/' || pathname === '/index.html' || SPA_ROUTES.has(pathname) || pathname.startsWith('/me/')) {
      serveIndex(req, res);
      return;
    }
    const prefix = Object.keys(dirs).find((p) => pathname.startsWith(p));
    const baseDir = prefix ? dirs[prefix] : WEB_DIR;
    const rel = prefix ? pathname.slice(prefix.length) : pathname.replace(/^\/+/, '');
    const file = path.resolve(baseDir, rel);
    if (!file.startsWith(baseDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      notFound(res);
      return;
    }
    serveFile(req, res, file, { cache: 'no-cache' });
  }

  return { serveStatic };
}
