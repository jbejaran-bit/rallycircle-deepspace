# Implementation log — Phases 3 + 4 (Nearby Courts, Find Games)

## Status: APPLIED AND VERIFIED 2026-11-20 (evening EST) — see "Verification (applied)" below

**Branch:** `feature/nearby-courts-find-games`, worktree `~/workspace/deepspace-interview-prep/fullstack/courts`, base `8fd8c2c`.
**Author of the staged draft:** subagent (courts/games), 2026-11-20 afternoon. **Applied + verified by:** subagent, 2026-11-20 evening, under the user's explicit approval to apply/build/test in isolated local worktrees only.

## Verification (applied) — actual evidence

All commands run in the worktree (`~/workspace/deepspace-interview-prep/fullstack/courts`), Node v24.22.1, `deepspace@0.44.2`, `node_modules` symlinked from `../review-ready-to-play/node_modules`.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **clean** (after the two fixes below) |
| `npx vitest run` | **59/59 pass, 8 files** (baseline 10 + 49 new: geo 14, osm 11, find-games 14, court-discovery 10, plus baseline files) |
| `node --test tests/rally.test.mjs tests/courts-games.test.mjs` | **26/26 pass** (baseline 16 + 10 new) |
| `npx eslint .` | **clean** |
| `npm run build` | **passes** (5.50 s; `games-*.js` and `courts-*.js` chunks emitted; prerender wrote `/`, `_spa.html`, `robots.txt`, `sitemap.xml`) |
| Live worker (`wrangler dev --local`, dummy `.dev.vars`, deleted afterwards) | `GET /api/courts/nearby` unauthenticated → **401 `{"error":"Sign in required"}`**; `GET /api/geocode` unauthenticated → **401**; bad Bearer token → **401**. This proves the real `resolveAuth` is wired to the new routes in `worker.ts`, not just the stubbed resolver in tests. `/courts` and `/games` → **200** (SPA shell). |
| Live Overpass smoke query (one small query, 5 km around Pittsburgh, identifying User-Agent) | **Timed out after 30 s with no response** (HTTP 000, 0 bytes) — the public instance was unresponsive at that moment, exactly the overload case the design anticipates. Not retried (policy: do not hammer). Real-response-shape parsing therefore remains **unverified**; mocked fixtures + defensive parsing are the evidence instead. |
| Playwright spec `tests/courts-games.spec.ts` | **Not run** — needs `deepspace test run` + test accounts; `deepspace auth whoami` → `not_authenticated`, no credentials used or created. |
| Screenshots | `docs/courts-desktop.png`, `docs/games-desktop.png`, `docs/courts-mobile.png` — all show the **sign-in gate** ("Sign in to continue — This page is only available to signed-in users"), not the feature UI, because there is no signed-in test user. They do prove: the app shell renders, the nav includes the new **Find Games** item, and the `courts-*.js` chunk loads (200 in the wrangler log). The two 500s in the browser console are `/api/auth/get-session` failing against the dummy `AUTH_WORKER_URL` (`example.invalid`) — an artifact of the dummy local env, not feature code. The feature UI itself (map, list, filters) is **visually unverified**. |

### Fixes made while applying (draft → working code)

1. **`src/server/court-discovery.test.ts` — tsc errors (4 sites).** `fetchFn.mock.calls[0] as [string, RequestInit]` is rejected by this tsconfig (`calls[0]` types as `[]`). Changed to `as unknown as [string, RequestInit]` (the `Response`-returning handler branch in `court-discovery.ts` itself passed tsc — draft risk #1 was only the test casts).
2. **`src/server/court-discovery.test.ts` — 2 failing assertions.** The tests asserted the raw `init.body` string contains `around:10000,40.44,-79.95`, but the body is URL-encoded (`around%3A10000%2C...`). Fixed by decoding first: `new URLSearchParams(String(init.body)).get('data')`. Implementation was correct; the test was asserting against the encoded form.
3. **`src/lib/find-games.test.ts` — 2 failing assertions (same root cause).** Fixture `s6` used the helper's default court `'Schenley Park'`, which legitimately matches the known Schenley court — so the "excludes sessions without known coordinates" test saw `['s1','s6']` instead of `['s1']`. Fixed the fixture, not the implementation: `s6` is now `court: 'Riverside Courts', location: 'Lawrenceville'` (a text-only location matching no known court and no area filter in the suite).
4. **`src/lib/find-games.ts` + `tsconfig.json` — node `--test` import failure.** `find-games.ts` imported `'./geo'` (extensionless, bundler style). Node's native TS runner cannot resolve extensionless relative imports, so `tests/courts-games.test.mjs` failed with `ERR_MODULE_NOT_FOUND`. `.js` extension satisfies tsc but Node does not remap `.js` → `.ts` under type stripping; `.ts` extension satisfies Node but tsc rejects it unless `allowImportingTsExtensions` is enabled. Fix: `import ... from './geo.ts'` **and** one line in `tsconfig.json`: `"allowImportingTsExtensions": true` (permitted because the config already sets `"noEmit": true`; it only *allows* `.ts` imports, no existing import is affected; `vite build` is unaffected). After this, tsc, vitest, node `--test`, eslint, and build are all green.

### Draft risks #1–#6, resolved

1. tsc `Response`-branch: **resolved** — passes; only the test casts needed fixing (fix 1 above).
2. `getAuthToken` authorising the new routes: **partially resolved** — the client uses the same `getAuthToken()` as `rally-actions.ts` and the server uses the same `resolveAuth`; the live 401 probes prove the real resolver gates the routes. An end-to-end signed-in call is still unverified (no test accounts).
3. Live Overpass response shape: **still unverified** — the one smoke query timed out (see above).
4. Leaflet rendering in dev: **unverified visually** — the courts chunk loads (200) and the prerender/build pass, but the map itself has not been seen rendered (auth gate blocks it).
5. Module-scope `sessionStorage` in `games.tsx` under prerender: **resolved** — `prerender.test.ts` passes (2/2) and `npm run build`'s prerender step succeeds; the try/catch guard holds.
6. Playwright spec assumptions: **unverified** — spec not run (see above).

## What actually happened, in order (draft stage, unchanged)

**Date:** 2026-11-20, afternoon EST. **Author:** subagent (courts/games).
**Base:** `feature/ready-to-play` at `8fd8c2c` (read from the on-disk
`../base-8fd8c2c` worktree; plain file viewing only).

## What actually happened, in order

1. **Read the base.** `AGENTS.md`, `package.json` (leaflet ^1.9.4 already
   present, no new deps needed), `src/schemas/rally-schema.ts` (sessions
   text-only location; member read; RSVP server-enforced),
   `src/lib/courts.ts` + `src/pages/(app)/(protected)/courts.tsx` (the
   Pittsburgh finder already exists at `8fd8c2c` — three courts, Leaflet
   map, one-shot geolocation sort, `?court=<id>` prefill),
   `src/pages/(app)/(protected)/rallies.tsx` (session list/detail, RSVP,
   chat, `validateSession`), `src/lib/rally.ts`, `src/lib/rally-actions.ts`
   (Bearer auth via `getAuthToken()`), `src/server/http-routes.ts` +
   `worker.ts` (Hono registration order; new API routes go after
   `registerActionRoutes`), `vitest.config.ts` + `tests/rally.test.mjs`
   (test conventions: vitest for `src/**`, `node --test` for
   `tests/*.test.mjs` importing TS directly).
2. **Attempted `git fetch origin feat/court-map`. BLOCKED.** The fetch
   result failed an execution-risk check. Per the runtime notice, no
   git/package-manager commands were run on that content afterwards: no
   checkout, no diff, no worktree, no build, no test. The Pittsburgh
   finder was read from the base worktree instead (it is already there).
   No worktree `fullstack/courts` was created; no branch, commit, push,
   draft PR, or bundle exists.
3. **Researched data sources via web search** (2026-11-20):
   - Overpass API (wiki.openstreetmap.org/wiki/Overpass_API;
     dev.overpass-api.de/overpass-doc/en/preface/commons.html): main
     instance `https://overpass-api.de/api/interpreter`; <10,000
     queries/day + <1 GB/day one-off, ÷100 for regular app use;
     identifying User-Agent/Referer; cache + rate-limit; 429/406 → pause
     30 s; public instance overloaded, reliability not guaranteed.
   - Nominatim usage policy
     (operations.osmfoundation.org/policies/nominatim): absolute max
     1 req/s app-wide, identifying User-Agent required, no autocomplete,
     cache results, no bulk.
   - No live queries were sent to either endpoint from this session.
4. **Wrote the draft** in `fullstack/courts-draft/` (this folder), laid
   out with target worktree paths. See `README.md` for the file map and
   `DESIGN.md` for decisions.

## Evidence — and its limits (draft stage; superseded for the applied work)

- **Evidence that exists:** the files in this folder (written, not
  executed); the two cited usage policies (fetched 2026-11-20, URLs in
  `docs/COURTS_AND_GAMES_README.md`); the base code read (file paths
  above, all in the pre-existing `base-8fd8c2c` worktree).
- **Evidence that did NOT exist at draft time:** no test runs (no `node --test`, no
  vitest, no `tsc`, no eslint, no `vite build` — all blocked by the
  notice, since running them would execute repository content); no dev
  server; no screenshots; no Playwright run; no live Overpass/Nominatim
  response observed; no git history for this work.
- **After applying (2026-11-20 evening):** the full gate was run — see
  "Verification (applied)" at the top of this log. The draft-stage
  "do not claim" note no longer applies to the suites that ran green;
  the items still unverified are listed in that section (live
  Overpass/Nominatim response shapes, Playwright spec, visual
  rendering of the feature UI, signed-in end-to-end calls).

## Files written (all staged, unapplied)

- `src/lib/geo.ts` + `geo.test.ts` — haversine, validation, radius clamp, formatting.
- `src/lib/location.ts` — one-shot geolocation wrapper (no watch, no persistence).
- `src/lib/osm.ts` + `osm.test.ts` — Overpass query builder + response parser; Nominatim parser.
- `src/lib/courts.ts` — replacement: same 3 Pittsburgh courts, `distanceMiles` re-implemented on `geo.ts`, plus `findKnownCourtForSession`.
- `src/lib/find-games.ts` + `find-games.test.ts` — pure session filter/annotation.
- `src/lib/court-discovery-client.ts` — authed client for the two new endpoints.
- `src/server/court-discovery.ts` + `court-discovery.test.ts` — authenticated server adapter, TTL cache, Nominatim pacing.
- `src/pages/(app)/(protected)/courts.tsx` — replacement: Nearby (OSM) + Pittsburgh tabs.
- `src/pages/(app)/(protected)/games.tsx` — new Find Games page.
- `src/nav.ts` — replacement: adds Find Games.
- `tests/courts-games.test.mjs` — `node --test` headline coverage.
- `tests/courts-games.spec.ts` — Playwright smoke spec (written, **not run**).
- `PATCHES.md` — exact edits for `worker.ts` + `rallies.tsx`.
- `DESIGN.md`, `docs/COURTS_AND_GAMES_README.md`, `README.md`, this log.

## Known risks / things to verify first after applying

1. `tsc` strictness: `court-discovery.ts` returns a `Response` from a
   Hono handler in one branch (`if (error instanceof Response) return error`)
   and uses `as never`/`as unknown as` casts in the test — confirm the
   project's `tsconfig` accepts them; the existing `http-routes.test.ts`
   uses the same style, so it should.
2. `getAuthToken` import in the client lib: used exactly as in
   `rally-actions.ts` — confirm at runtime that the token authorises the
   new routes the same way (the server uses the same `resolveAuth`).
3. Live Overpass response shape: parsers tolerate missing `elements`,
   missing coordinates, and missing tags — but run one real query after
   applying and compare against the fixtures in the tests.
4. Leaflet CSS: `courts.tsx` already imports `leaflet/dist/leaflet.css`;
   the new map reuses the same dynamic-import pattern — confirm the map
   renders in `deepspace dev` (no dev server was started here).
5. `sessionStorage` in `games.tsx` runs at module scope
   (`KNOWN_COURTS` is built at import): in SSR/prerender this would
   throw — `loadDiscoveredCourts` is wrapped in try/catch (a `ReferenceError`
   for `sessionStorage` is caught), but confirm the prerender test still
   passes (`prerender.test.ts` is part of the vitest gate).
6. The Playwright spec assumes a signed-in test user can reach `/courts`
   and `/games` directly; adjust selectors if Copilot's auth/layout work
   changes the shell.

## Conflicts

- None with Copilot's work: no chat-profile, design-system, or landing
  files touched. The only shared files edited are `courts.tsx`
  (replacement, Pittsburgh section preserved verbatim),
  `src/lib/courts.ts` (same data, `distanceMiles` re-implemented),
  `src/nav.ts` (one line added), `worker.ts` + `rallies.tsx` (small
  additive patches in `PATCHES.md`). If Copilot has changed `courts.tsx`
  or `nav.ts` on their branch, the replacement files need a three-way
  merge — the Pittsburgh section must be preserved, not overwritten.
- No conflict with the scoreboard/capacity/calendar phases: no shared
  schema or server files beyond the additive route registration.
