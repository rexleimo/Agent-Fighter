# Asset library contract (v1)

Single source of truth for how AFL stores, builds, validates and loads visual
assets. The browser, the build script, the rig baker and the verifiers must not
drift into four different path conventions.

The contract is deliberately boring: source art in, content-addressed
derivatives + one manifest out, stable legacy URLs during migration, graceful
fallback when anything is missing. No runtime npm dependency is allowed.

## 1. Directory layout

```text
assets/                               # inputs, NOT web-served
  catalog.json                        # pipeline config + license/origin
  source/
    plates/fighters/<id>.png          # original full-resolution alpha plate (16)
    plates/stage/stage_main.png       # original stage plate
    raw/                              # ImageGen originals; gitignored
  rig/<id>/override.json              # optional joint / part overrides
  compat/rig/<id>/rig.json            # frozen legacy rig schema (v1)
  compat/rig/<id>/mask.png            # frozen legacy ownership atlas

web/assets/                           # outputs, web-served
  manifest.json                       # generated canonical manifest
  build-info.json                     # generated diagnostics, non-canonical
  v/
    <id>/play-512.<hash12>.png        # canonical game sprite (fallback)
    <id>/play-512.<hash12>.webp       # optional smaller alternate
    <id>/card-480.<hash12>.png        # canonical gallery card
    <id>/card-480.<hash12>.webp
    stage_main/stage-1280.<hash12>.png
    stage_main/stage-1280.<hash12>.webp
    rig/<id>/rig.<hash12>.json        # compact rig schema 2
    rig/<id>/atlas.<hash12>.png       # padded part atlas (fallback)
    rig/<id>/atlas.<hash12>.webp      # optional smaller alternate
```

Rules:

- `web/assets/art/**` and `web/assets/rig/**` are **removed** in the migration.
  The server maps the old URLs to `assets/source` / `assets/compat` so a tab
  that loaded the old `app.js` keeps working.
- Every generated file is content-addressed (`<name>.<hash12>.<ext>`), so a
  deploy never overwrites a URL that a client may still be using.
- Every generated file has exactly one owner: `scripts/assets/build.mjs` for
  art/stage derivatives + manifest, `scripts/assets/rig.mjs` for rig atlases +
  `rig.json`.
- No file under `web/assets/v/` is hand-edited. `npm run assets:build`
  regenerates it; `npm run assets:check` fails on drift.
- `assets/catalog.json` is the only hand-authored pipeline config. Fighter ids
  and teams are derived from `src/fighters.js`; the catalog must not duplicate
  the roster.

## 2. Manifest

`web/assets/manifest.json` is generated and validated. It is the only asset
entry point for the browser. Stable legacy URLs remain for old clients, but the
app uses the manifest.

```json
{
  "schemaVersion": 1,
  "pipeline": "afl-assets-v1",
  "revision": "sha256:9f2c…",
  "minClient": 1,
  "budgets": {
    "liveViewBytes": 1500000,
    "galleryViewBytes": 2500000,
    "libraryBytes": 8000000
  },
  "assets": [
    {
      "id": "ember",
      "kind": "fighter-plate",
      "fighterId": "ember",
      "team": "pyre",
      "order": 10,
      "preload": "active",
      "license": {
        "spdx": "LicenseRef-Original-AI",
        "origin": "ai-generated-original",
        "author": "Agent Fighting League",
        "commercialUse": true,
        "attributionRequired": false
      },
      "variants": [
        {
          "id": "play-512",
          "role": "play",
          "path": "/assets/v/ember/play-512.4f2a9c1d8b3e.png",
          "alternate": "/assets/v/ember/play-512.4f2a9c1d8b3e.webp",
          "width": 403, "height": 512, "bytes": 231000,
          "alternateBytes": 44000,
          "mediaType": "image/png",
          "alpha": true,
          "sha256": "9a7c…"
        },
        {
          "id": "card-480",
          "role": "card",
          "path": "/assets/v/ember/card-480.91c0a3b5d7e2.png",
          "alternate": "/assets/v/ember/card-480.91c0a3b5d7e2.webp",
          "width": 378, "height": 480, "bytes": 186000,
          "alternateBytes": 52000,
          "mediaType": "image/png",
          "alpha": true,
          "sha256": "77d1…"
        }
      ],
      "rig": {
        "schemaVersion": 2,
        "data": "/assets/v/rig/ember/rig.0c8e6f0a1c44.json",
        "atlas": "/assets/v/rig/ember/atlas.2b8e6f0a1c44.png",
        "atlasAlternate": "/assets/v/rig/ember/atlas.2b8e6f0a1c44.webp",
        "width": 512, "height": 640,
        "bytes": 260000, "alternateBytes": 90000,
        "parts": ["armB", "legB", "torso", "legF", "head", "armF"],
        "figureHeight": 503
      }
    },
    {
      "id": "stage_main",
      "kind": "stage-plate",
      "order": 0,
      "preload": "critical",
      "license": { "spdx": "LicenseRef-Original-AI", "origin": "ai-generated-original", "commercialUse": true, "attributionRequired": false },
      "variants": [
        {
          "id": "stage-1280",
          "role": "stage",
          "path": "/assets/v/stage_main/stage-1280.3d9a7b1e2c44.png",
          "alternate": "/assets/v/stage_main/stage-1280.3d9a7b1e2c44.webp",
          "width": 1280, "height": 853, "bytes": 2200000,
          "alternateBytes": 183000,
          "mediaType": "image/png",
          "alpha": false,
          "sha256": "…"
        }
      ]
    }
  ]
}
```

Field rules:

- `path` is canonical PNG; `alternate` is an optional WebP sibling produced when
  `cwebp` exists. Both are content-addressed and immutable. The app prefers the
  alternate and falls back to `path` on error.
- `width`/`height` are the decoded pixel dimensions of the canonical file.
  `bytes`/`alternateBytes` are file sizes on disk.
- `preload`: `critical` (server injects a `<link rel=preload>`), `active`
  (client preloads the two current fighters), `lazy` (gallery IO), `never`.
- `revision` is `sha256` of canonical JSON with `revision` removed. No
  timestamps in the manifest; `build-info.json` carries generatedAt/Node/zlib
  info for debugging.
- Every asset must have `license` + `origin`. A missing/forbidden license fails
  the build. All current art is original AI-generated art owned by the project.
- `budgets` are enforced by `assets:verify`, not advisory.

Hashing:

- Every generated file gets a full SHA-256; the filename uses the first 12 hex.
- `revision` is computed over canonical JSON (sorted keys, no whitespace).
- A change to source art, pipeline version, or a fighter id changes the
  revision and every affected filename.

## 3. Derivative sizes

| Variant | Target | Why |
| :--- | :--- | :--- |
| `play-512` | height **512 px** | In-game height is 204 CSS px; 512 covers 2.5× DPR. |
| `card-480` | height **480 px** | Gallery card ~300 CSS px wide; 2× portrait. |
| `stage-1280` | width **1280 px** | Canvas 960×420 displayed at 1440 px; good weight/quality. |
| `rig` | figure height **≤ 512 px** | Same in-game scale as `play-512`; atlas is baked at target size. |

Encoding:

1. Resize with an alpha-aware box filter (premultiplied alpha) in
   `scripts/lib/imageops.mjs`.
2. Encode canonical PNG with adaptive row filtering + `zlib.deflateSync(level:9)`
   (extend `scripts/lib/png.mjs`; deterministic).
3. If `cwebp` exists, write a WebP sibling (`-q 82 -alpha_q 90` for alpha,
   `-q 82` for the stage). The canonical PNG is always written.
4. If `cwebp` is missing, omit the alternate and log
   `alternates: unavailable`; the manifest and canonical PNG set are unchanged.
   This keeps Linux/CI builds deterministic and dependency-free.
5. The committed WebP siblings mean a machine without `cwebp` can serve and
   validate the current build.

## 4. Rig schema 2

`web/assets/v/rig/<id>/rig.<hash>.json`:

```json
{
  "schemaVersion": 2,
  "id": "ember",
  "sourceSha256": "…",
  "bakeHeight": 512,
  "atlas": {
    "path": "/assets/v/rig/ember/atlas.2b8e6f0a1c44.png",
    "alternate": "/assets/v/rig/ember/atlas.2b8e6f0a1c44.webp",
    "width": 512, "height": 640
  },
  "figureHeight": 503,
  "serverHeight": 192,
  "plateScale": 2.6198,
  "box": { "w": 398, "h": 503 },
  "joints": { "root": [256, 350], "hip": [256, 330], "...": [] },
  "parts": [
    {
      "id": "armF",
      "z": 5,
      "pivot": "shoulderF",
      "rect": { "x": 260, "y": 40, "w": 150, "h": 210 },
      "px": 42, "py": 70,
      "ax": 120, "ay": -210,
      "restAngle": -0.42,
      "drive": ["shoulderF", "elbowF"],
      "follow": ["handF"],
      "followK": 0.15,
      "spin": 1.0,
      "clamp": 1.1,
      "seam": 6
    }
  ]
}
```

Rules:

- `rect` is the atlas crop (including the padded seam halo).
- `px`/`py` are the pivot relative to `rect` top-left, in atlas pixels.
- `ax`/`ay` are the pivot relative to the figure root, in atlas pixels.
- `figureHeight` is the opaque silhouette height in atlas pixels; the renderer
  scales with `H / figureHeight`.
- `plateScale = figureHeight / 192` converts server joint deltas to atlas px.
- `seam` is the halo width in atlas px. The renderer draws the halo behind the
  exact part and fades it in as the part rotates.
- New builds always emit schema 2. The renderer keeps the schema 1 mask
  compositor only for `assets/compat` fallback.

## 5. Runtime loading

- Fetch `manifest.json` once at boot (`cache: 'no-cache'`).
- Live view loads manifest, stage, and the two active fighters' `play` +
  rig data + rig atlas. It must **not** load the other 14 fighters.
- When the active room changes, load only fighters that are not cached. Keep an
  LRU cap (8 plates / 8 rigs) so demo rotation does not grow memory unbounded.
- Gallery loads `card` images only after the `fighters` view becomes active,
  using `IntersectionObserver` + `loading="lazy"` + `decoding="async"`.
- `img.decode()` after load avoids a paint jank on the first frame.
- Fallback chain:
  1. preferred manifest variant (WebP alternate if available);
  2. canonical PNG variant;
  3. legacy `/assets/art/<id>.png` / `/assets/rig/<id>/rig.json` + `mask.png`;
  4. whole plate (no rig);
  5. procedural geometry.
- No image failure may throw into the render loop; record it in `ART.failed`.

## 6. Server delivery

| URL | Cache-Control | Notes |
| :--- | :--- | :--- |
| `/` , `/index.html` | `no-cache` + ETag | injected critical preloads |
| `/assets/manifest.json` | `no-cache` + ETag | gzip |
| `/assets/v/**` | `public, max-age=31536000, immutable` | content-addressed; unknown paths 404 |
| `/assets/art/<id>.png` | `public, max-age=3600, must-revalidate` | legacy alias to source plate |
| `/assets/art/stage_main.png` | same | legacy alias |
| `/assets/rig/<id>/rig.json` | same | frozen compat schema |
| `/assets/rig/<id>/mask.png` | same | frozen compat mask |
| `/api/*` | `no-store` | unchanged |

Implementation:

- `src/assets.js` loads/validates the manifest at boot, exposes
  `variant(id, role)`, `rig(id)`, `criticalPreloadTags()`, `isHashedPath()`,
  and falls back to `{ ok:false }` legacy mode if the manifest is missing.
- `serveStatic` adds: `Content-Length`, ETag + `If-None-Match` → 304, HEAD,
  `X-Content-Type-Options: nosniff`, gzip for text, hashed-path validation,
  and explicit legacy prefix maps.
- `GET /api/assets` returns the manifest; `/api/state` gains
  `assets: { manifest, revision, schemaVersion }` (additive).
- `src/fighters.js` keeps `art: '/assets/art/<id>.png'` for compatibility and
  adds `artVariants` (play/card) when the manifest is available.

## 7. Validation gates

`npm run assets:verify` is static and server-free. It must pass before
`verify`.

| Gate | Check |
| :--- | :--- |
| Manifest schema | `schemaVersion`, `revision`, required fields, unique ids, valid roles/preload, path shape |
| Completeness | Every catalog/fighter has assets; every asset has a source; every fighter has a rig |
| Source integrity | Source exists, bytes/sha256/dimensions match |
| Variant integrity | File exists, bytes/sha256 match, PNG magic/dimensions, media type |
| Alpha policy | Fighter art: >2% non-transparent and ≥90% border transparent; stage ≥99.9% opaque |
| Rig joints | Finite, inside `[0,w]×[0,h]`, root present, drive/follow refs exist |
| Rig crops | Rect inside atlas, pivot within 0.2×figureHeight of crop, unique z, non-empty parts |
| Part coverage | Atlas rects don't overlap, gutter ≥2px, every silhouette pixel owned once |
| Orphans | Every file under `web/assets/v/` referenced by current/previous manifest or a recognized alternate |
| Budgets | `liveViewBytes <= 1.5MB`, `galleryViewBytes <= 2.5MB`, `libraryBytes <= 8MB` |
| License/origin | Allowlisted SPDX/origin; no SNK/KOF/MUGEN markers in asset metadata |
| Legacy compat | `/assets/art/<id>.png`, `/assets/rig/<id>/rig.json`, `mask.png` resolve |
| Determinism | Rebuild to temp dir; compare manifest + file hashes |

`npm run assets:check` runs the build with `--check` (no writes) and compares
the computed manifest to the committed one. `npm run assets:build` writes
atomically and keeps `manifest.prev.json` for rollback.

## 8. Build commands

```bash
npm run assets:build    # node scripts/assets/build.mjs
npm run assets:check    # build --check (no writes)
npm run assets:verify   # static QA gates
npm run assets:clean    # explicit destructive clean of web/assets/v
npm run rig:bake        # compatibility shim -> assets:build --rig-only
```

`npm run verify` runs `assets:verify` before the existing 22 end-to-end checks.
`npm run verify:art` becomes manifest-driven and is updated to expect only the
two active fighters on Live, all 16 cards after the gallery view opens, and
correct cache headers.

## 9. Migration / rollback

Phase A (this work):

1. Move originals to `assets/source/plates/{fighters,stage}`.
2. Freeze old rig JSON + masks into `assets/compat/rig/<id>/`.
3. Add catalog/build/manifest/derivatives.
4. Add server legacy routes; keep `src/fighters.js` `art` unchanged.
5. Ship new `asset-store.js`, `app.js`, `rig.js`; old clients keep working.

Phase B (later): remove `web/assets/art` and `web/assets/rig` trees, keep
compat routes for at least two releases.

Rollback: restore `manifest.prev.json` + previous hashed files (kept by
`--prune`); no kernel change. `assets:clean` is never part of deploy/rollback.

## 10. Non-goals

- No sprite-sheet animation, no new art generation, no restyling.
- No image CDN or external optimizer service.
- No change to the deterministic combat kernel or hitbox data.
- No forced WebP: PNG is the guaranteed artifact; WebP is an optional sibling.
