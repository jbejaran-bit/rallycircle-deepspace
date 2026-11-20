# Track A — Stabilize and deeply verify the integrated release candidate

**Branch:** `feature/muse-track-a-stabilize`, base `integration/rallycircle-muse-review`
@ `2c2d24f93daf751108986a45cba1ccb5440044ec` (PR #12 head, stacked on PR #11).
**Worktree:** `~/workspace/deepspace-interview-prep/fullstack/track-a`
**Date:** 2026-11-20. No merge, deploy, app-ID change, production data, paid
service, or auth bypass. Nothing was pushed to a shared branch.

## A20 — Baseline gate (before any change)

Run at `2c2d24f`, Node v24.22.1, `deepspace@0.44.2`:

| Check | Result |
|---|---|
| `node --test tests/rally.test.mjs` | **19/19 pass** (docs claimed 19 — confirmed) |
| `npx vitest run` | **103/103 pass, 17 files** (docs claimed 51 — the actual suite is larger) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | passes |
| `DEEPSPACE_PORT=5187 npm run test:public` | **14/14 pass** (docs claimed 13 — actual is 14) |

One WebServer stack trace appears in the public-test output
(`src/server/http-routes.ts:177`, the `/api/auth/*` proxy): the Vite dev
server has no auth worker bound, so `authWorkerFetch` throws and the signed-out
check fails closed. Environmental, expected in offline runs, not a defect.
`npm run test:api` / `deepspace test run` need an authorized CLI session:
`deepspace auth whoami` was not attempted with credentials and no test accounts
exist here — recorded as unverified (A19).

## Defects found and fixed

### D1 (A02) — One transient queue-delete failure blocked the caller's own command
**File:** `src/server/rally-command-room.ts`, `fillVacancies()`.

Before: when a promotion saved its RSVP and the following waitlist-row delete
failed, `fillVacancies()` returned `null` immediately. Callers treat `null`
as "temporarily unavailable", so the *caller's own* unrelated RSVP/join
failed even though the promotion itself had succeeded; repair was deferred to
the next attendance command, and the stale row kept showing the promoted
player as "on the waitlist" in the UI until then.

After: the promotion step retries the delete once inside the same command
(the delete is idempotent — same known `recordId`). If the retry also fails,
the command still returns `null` and the next attendance command repairs the
row (`fillVacancies` skips a waitlisted user who already holds a `going`
RSVP, then deletes the stale row). No background job or timer was added —
the DO cannot support one.

**Tests:** updated the existing recovery test (single failure now repairs
in-command; outsider join sees the true state immediately) and added a
double-failure case (exhausts the retry; next command repairs; no duplicate
spot, no queue jumping).

### D2 (A03, harness fidelity) — The mock harness ignored `orderBy`/`limit`
**File:** `src/server/rally-command-room.test.ts` (`createHarness`).

Before: the harness's `records.query` for waitlists sliced by `limit` in Map
insertion order and ignored `orderBy`/`orderDir` entirely, so the FIFO test
passed vacuously even if the code asked for the wrong sort. The real
RecordRoom does honour `orderBy` (verified in the installed SDK,
`node_modules/deepspace/dist/worker.js:1755-1770, 2231-2234`: `orderBy`
`createdAt` maps to `_created_at`, unknown fields are refused).

After: the harness sorts by `createdAt` (asc/desc) and honours `limit` for
both `rsvps` and `waitlists`, stamps a monotonic `createdAt` on created rows,
and `interruptQueueCleanup()` now takes a failure count. The A03 test seeds
out-of-order stamps and proves promotion picks the earliest `createdAt`, and
that leaving + rejoining forfeits position.

No other code defects were found. The following behaviours were verified by
test and are **correct as designed** (documented, not changed):

- **Waitlist priority over new joiners (A01):** a withdrawal promotes the
  first waiter inside the same queue turn, so a concurrent new join that
  raced the withdrawal is honestly told the session is full. (An earlier
  draft of my test expected the joiner to win; the code is right, the test
  was wrong.)
- **No waitlist join while a spot is free (A03/A07):** `joinWaitlist`
  refuses with "A spot is available. Choose Going to join." — the honest
  answer, and it also means a test must fill the session before queueing.
- **Withdrawn participants still block finalization (A11):** finalization
  requires approval from every player recorded in `matchScore.teams`, even
  one who withdrew afterwards. The result fails closed (stays
  `confirmed`, never `final`, never stats-eligible). Waiving a withdrawn
  player's approval would need a `requiredApprovers` set computed from live
  RSVP state in both the server and the scoreboard UI, which would change
  finalization semantics in a stabilization track — recorded as a follow-up
  in `docs/track-a-contracts.md`, not implemented here.
- **Cancel is atomic for future participation (A05):** RSVP, waitlist join,
  score points, result review and match start are all rejected after
  cancellation; withdraw/leave-waitlist remain allowed as cleanup, and
  promotion never runs on a cancelled session.

## Tests added (all executed)

| File | New tests | What they cover |
|---|---|---|
| `src/server/rally-command-room.test.ts` | 14 new (11 in the Track A regression suite + updated recovery test + harness changes) | A01 5-way concurrent joins, withdraw/join races both orders, concurrent cancels, duplicate waitlist joins; A02 single/double delete failure; A03 createdAt-ordered promotion + rejoin-to-back; A04 RSVP retry + double withdraw idempotency; A05 cancel blocks RSVP/waitlist/score/review/start; A06 non-host going→maybe promotes only first waiter; A07 forged userId withdraw/waitlist/cancel; A08 `canRead` waitlist privacy + error messages name no other user; A09 10 concurrent score writes at one revision → exactly one winner, sequential fresh revisions; A10 malformed identities/revisions/teams + cross-session score edits; A11/A12 withdrawn-participant finalization + dispute locks stats; A15 legacy sessions; A17 command submission order |
| `src/lib/rally-score.test.ts` | 1 | A12 `isEligibleForStats`: only `final` results are eligible |
| `src/lib/rally-calendar.test.ts` | 3 | A13 UID stable across exports, DST spring-forward/fall-back absolute duration, zero-length → null |
| `src/server/court-discovery.test.ts` | 5 | A14 Overpass 500 → generic 502 (no leaked body), network failure → 502, geocode 429 → 502, geocode malformed → 502, geocode network failure → 502 |

New code (not tests): `isEligibleForStats()` in `src/lib/rally-score.ts`
(A12) — the single gate every future statistics/rating consumer must use;
currently no consumer exists, so no result affects any statistic today.

## A18 — Sensitive-data audit (read + tested)

- All command-room failure strings are generic (`'This session is
  unavailable.'`, `'This session is full. You can join the waitlist.'`,
  etc.) and contain no user IDs, tokens, or locations. Tested in A08: a
  full-session error names neither the host nor any confirmed player.
- The only `console.error` in server code is in
  `src/server/courtboard-access.ts:39,50` (`'Courtboard authorization lookup
  failed'` + HTTP status / caught error). The logged value is a status code
  or a fetch error, never a token or payload. Left as is.
- Court discovery never logs coordinates; the viewer’s coordinates go to the
  app’s own worker only and are never stored (see `court-discovery.ts`
  header comment).
- `/api/debug/*` is gated twice: `ALLOW_DEBUG_ROUTES === 'true'` plus an
  owner/admin role check (`src/server/http-routes.ts`, debug proxy).
- Waitlist rows are `read: 'own'` for members (`rally-schema.ts`); the UI
  queries only `{ sessionId, userId: <own id> }`. Verified with the SDK’s own
  `canRead` helper in the A08 test (own row readable, another user’s row
  not, anonymous not, admin yes).

## A19 — Authenticated test harness

The mock harness in `rally-command-room.test.ts` (`createHarness`) supports
distinct test identities and reproducible multi-user scenarios offline: it
drives the real `rallyCommandAction` + real `RallyCommandRoom` queue against
in-memory record storage, with fault injection (`interruptQueueCleanup(n)`).
To run the live two-account tests when accounts exist (per TESTING_GUIDE.md):

```sh
npx deepspace auth whoami
npx deepspace test accounts list --usable
npm run test:api
npm test -- tests/rally-collab.spec.ts
npm test -- tests/courtboard.spec.ts
```

Live items remain **unverified** here: two-account browser sync, real
RecordRoom enforcement of `read: 'own'`/direct-write denials, real DO
queue behaviour under eviction, live Overpass/Nominatim response shapes,
real calendar-client import. Nothing in this branch claims them.

## A17 — Real-time subscription consistency (offline level)

Tested at the level the offline harness supports: commands apply in
submission order through the serialized queue (A17 test), stale score
revisions are rejected (A09), and a read after a write reflects the write
(all harness tests read state from the same store). Live reconnect /
offline-change delivery needs the authorized runtime and is unverified.

## Final gate (after all changes)

Run at the branch tip, Node v24.22.1:

| Check | Result |
|---|---|
| `node --test tests/rally.test.mjs tests/courts-games.test.mjs` | **29/29 pass** (19 + 10) |
| `npx vitest run` | **126/126 pass, 17 files** (baseline 103 + 23 new) |
| `npx tsc --noEmit` | clean (one TS error in a new test helper fixed during the run — generic `byAge`) |
| `npm run lint` | clean |
| `npm run build` | passes |
| `DEEPSPACE_PORT=5190 npm run test:public` | **14/14 pass** (a first retry on port 5188 timed out waiting 60 s for the Vite server under concurrent load from sibling agents; the same suite passed on 5187 before changes and on 5190 after — environmental, not a code issue) |

## Commits

Small logical commits on `feature/muse-track-a-stabilize`; bundle +
per-commit patches preserved in `~/workspace/deepspace-interview-prep/fullstack/`.
