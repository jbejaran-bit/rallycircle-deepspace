# Tracks K + L — Implementation log

**Branch:** `feature/muse-security-extensions`, base
`integration/rallycircle-muse-review` @
`2c2d24f93daf751108986a45cba1ccb5440044ec` (PR #12 head).
**Worktree:** `~/workspace/deepspace-interview-prep/fullstack/track-kl`
**Date:** 2026-11-20. No merge, deploy, app-ID change, production data,
paid service, or auth bypass. Nothing was pushed to a shared branch.

## Baseline gate (before any change)

Run at `2c2d24f`, Node v24.22.1, `deepspace@0.44.2`:

| Check | Result |
|---|---|
| `node --test tests/rally.test.mjs tests/courts-games.test.mjs` | **29/29 pass** |
| `npx vitest run` | **103/103 pass, 17 files** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | passes |

## Commits

| Commit | Content |
|---|---|
| `a6f0b71` | Track K core: command-room marker (K01), id length caps + schema maxLength (K02), rate limiter (K03), bounded body + queue survival (K05), bounded courtboard logging (K04), `apiVersion` (L14) |
| `a77ec2f` | K06 courtboard re-verification tests + stale security-spec addendum (prep-area doc, not in branch) |
| `473cad0` | Track L extensions: schemas, pure lib, 22 server actions, registration, 35 tests |
| (this commit) | Contracts fragment + this log |

## K04 — Sensitive-data audit (extension of Track A's A18)

Grepped `src/server`, `src/ai/chat-routes.ts`, `worker.ts` for
`console.*` and for `fetch(` with user-controlled URLs:

- `src/server/action-routes.ts:59` — `console.info` with the action name
  + caller id. Server-log attribution, intentional; no token, no payload.
  Left as is.
- `src/server/courtboard-access.ts:39,50` — the `console.error` on the
  catch path logged the raw caught error object. Changed to the SDK's
  `loggableError` (bounded, 8 KB truncated) — same pattern the SDK itself
  uses in `chat-routes.ts`. The status-code log on line 39 was already
  safe.
- `src/ai/chat-routes.ts` — warnings/errors use `loggableError` (SDK,
  truncated); the `chatId`/`userId` in warn lines are server-log
  attribution, never returned to another user.
- Client-side `console.warn/error` in components (court map, main) are
  browser-console only, not server logs.
- `/api/debug/*` verified doubly gated: `ALLOW_DEBUG_ROUTES === 'true'`
  plus an owner/admin role check (`http-routes.ts:192-210`).
- No server error string returns a user id, token, location, or another
  user's data (command-room strings re-checked; extension action strings
  written the same way — ownership failures say "unavailable", never
  whose record it is).

## K07 — Court discovery / geocode review (code trace)

- Overpass + Nominatim hosts are module constants (`OVERPASS_ENDPOINT`,
  `NOMINATIM_ENDPOINT` in `src/lib/osm.ts`); the Nominatim query is built
  with `URLSearchParams` (encoded, no injection); no user-controlled URL
  is ever fetched.
- Both upstreams use `AbortSignal.timeout(20_000)`; Nominatim is paced
  ≥1.1 s app-wide (DO-backed in production, promise chain in-process);
  upstream failures map to generic 502s with no body leaked; no retry
  against a throttling provider.
- The only other server `fetch` calls are platform bindings (`ASSETS`,
  `apiWorkerFetch`) and the internal RecordRoom/DO fetches with fixed
  `https://internal/...` URLs.

## K06 — Courtboard re-verification

- Anonymous handshake: the `/ws/canvas/:docId` route requires a token
  (401 without one) — route code in `realtime-routes.ts`, unchanged by
  this track, re-read and confirmed.
- Cross-session: new tests prove `getRallyCanvasAccess` denies a user
  whose RSVP belongs to another session, and denies unknown session ids.
- Per-message re-authorization: `AppCanvasRoom.onMessage` (`worker.ts`)
  re-runs the access check before every write mutation; the new test
  proves the access function itself re-evaluates on every call (mutating
  the RSVP set between calls flips the verdict — no cached verdict).
- `docs/COURTBOARD_SECURITY.md` (prep area) gained an addendum marking
  the pre-PR #5 verdicts stale.

## Fixes the gate forced

- `tsc`: `tools.query<T>`/`tools.get<T>` require `T extends
  Record<string, unknown>`; `RallySession`/`RallyRSVP` have no index
  signature. Fixed with intersection aliases (`SessionRow`/`RsvpRow`)
  in `extensions-actions.ts` — no shared-type change. (Track B+C hit the
  same constraint on their branch.)
- `tsc`: `'hostId' in session` narrowing in the courtboard test helper
  did not exclude the `Record` union member. Fixed with an explicit
  `isSingleSession` type predicate.

## Tests added (all executed)

| File | New tests | What they cover |
|---|---|---|
| `src/server/rally-command-room.test.ts` | 7 | K01 marker rejection (+ marked fetch reaches handler), K02 over-long ids, K03 attendance cap 30 + independence + window reset, K03 cancel cap 5 + score cap 120, K05 malformed/oversized bodies, K05 throwing record room + queue continues, L14 apiVersion on success/failure |
| `src/server/courtboard-access.test.ts` | 3 | K06 cross-session denial, unknown-session denial, per-call re-evaluation |
| `src/lib/extensions.test.ts` | 15 | Template/favourite/availability/note validators, search filters + sort + truncation, duplicate detection, reminders window |
| `src/server/extensions-actions.test.ts` | 20 | Schema permission closure, search, templates CRUD + cap + ownership, favourites idempotent + ownership, availability, reminders, export own-only + finalized-only, audits participant-only, notes host-only + finalized-only, chat moderation host-only + idempotent + clear, waitlist position own-only, duplicate advisory, appStatus |

## Final gate (at the branch tip)

| Check | Result |
|---|---|
| `node --test tests/rally.test.mjs tests/courts-games.test.mjs` | **29/29 pass** |
| `npx vitest run` | **148/148 pass, 19 files** (baseline 103 + 45 new) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | passes |
| `DEEPSPACE_PORT=5191 npm run test:public` | **14/14 pass** |

## What remains unverified

- Live two-account browser sync / WebSocket handshake, real RecordRoom
  enforcement of the new collections' `uniqueOn`/`orderBy`, real-DO
  queue behaviour under eviction, live Overpass/Nominatim response
  shapes, real calendar-client import — all need the authorized
  runtime/test accounts that don't exist here (`deepspace test run` /
  `test:api` not attempted with credentials).
- Rate-limit counters reset on DO eviction (documented limitation).
- The internal marker (K01) is not a secret; a caller that can already
  fetch the DO directly and knows the marker can still send a forged
  `userId`. No route exposes the DO, so this remains defense in depth —
  the action's Bearer verification is the auth boundary.

## Integration notes

- This branch does **not** include Track A's D1 waitlist-delete retry or
  its harness `orderBy`/`createdAt` fix, nor Track G+H's
  `fillVacancies` changes. The merge must take Track A's version of
  `fillVacancies` and its harness, then re-apply this branch's
  `rally-command-room.ts` changes on top. Both branches extended the same
  test harness (`rally-command-room.test.ts`); neither side's harness
  changes may be dropped.
- The `docs/COURTBOARD_SECURITY.md` addendum lives in the prep area
  (`~/workspace/deepspace-interview-prep/docs/`), not in this branch.
