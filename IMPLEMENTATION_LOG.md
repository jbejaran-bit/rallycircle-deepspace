# PR #22 rate limiting (K03) + bounded-body parsing (K05) — port from Track K+L

**Target:** `review/rallycircle-serialized-session-time` @ `e6ff2d9` (PR #22)
**Branch:** `feature/muse-pr22-rate-limit-fixes` (this worktree, off `e6ff2d9`)
**Date:** 2026-11-21. Deadline Nov 23, 2026 11:59 PM ET.
**Scope:** port only. No Codex branch modified, nothing merged/deployed/submitted,
PR #21 untouched, no production use, no live verification (no DeepSpace login).

## 0. Baseline

- PR #22 native baseline on `e6ff2d9`: **Vitest 235/235 (33 files)**, tsc clean
  (verified in this worktree before any change).
- Source design: Track K+L, `feature/muse-security-extensions` @ `15951cb`
  (`fullstack/track-kl`), whose K03/K05 implementation and tests were read
  verbatim before porting. Limits and messages are K+L's, unchanged:
  attendance 30/min, score 120/min, cancel 5/min, fixed 60 s windows,
  in-memory on the DO; oversized body > 64 KB rejected before parsing;
  malformed JSON → generic 400; unexpected throw in the queued handler →
  generic "temporarily unavailable" with the queue continuing.

## 1. Pre-fix state on e6ff2d9 (reproduced, not assumed)

The adversarial audit measured on PR #20 `f492736`: **1000/1000 rapid RSVPs
succeeded in ~8.1 s, 3,000 record-room tool calls, 0 throttled**; **1 MB
bodies fully parsed and executed** (marked cancel in ~18–37 ms; invalid 1 MB
body parsed then 400 in ~15–71 ms). The K03/K05 surface of the room is the
same on PR #22: `f492736 → e6ff2d9` touches only the serialized-session-time
files, and inspection of `e6ff2d9`'s `RallyCommandRoom` confirms no limiter
exists and `handle()` reads the body with unbounded `await request.json()`.
The functional reproduction below was run on `e6ff2d9` itself (commit
`df5ffee`, test-first):

| Test (new file `src/server/pr22-rate-limit.test.ts`) | On unfixed `e6ff2d9` |
|---|---|
| RSVP flapping throttled at 30/min (K03) | **FAIL** — 31st RSVP succeeded |
| Cancels at 5/min, scores at 120/min (K03) | **FAIL** — 6th cancel / 121st score succeeded |
| Series commands per user + series id (K03) | **FAIL** — 30th generate succeeded |
| Counters reset on DO eviction (K03) | **FAIL** — no counters exist to reset |
| Malformed + oversized bodies → generic 400 (K05) | **FAIL** — 70 KB valid RSVP executed, RSVP created |
| Under-cap 60 KB body accepted (K05) | PASS (lock) |
| Record-room throw → generic failure, queue continues (K05) | **FAIL** — `room.fetch` rejected with the raw error |
| Storage throw in geocoding → 502 (K05) | **FAIL** — `room.fetch` rejected with the raw error |
| Legitimate commands at normal rates (K03/K05) | PASS (lock) |

**Fail-before: 7 failed / 2 passed.** After the fix (commit `6759087`):
**9/9 pass.**

## 2. What was ported (commit `6759087`, `src/server/rally-command-room.ts` only)

- `BodyTooLargeError, readBoundedBodyText` imported from `deepspace/worker`
  (already exported by the installed SDK — same version Track K+L used).
- `MAX_COMMAND_BODY_BYTES = 64 * 1024`, `RATE_LIMIT_WINDOW_MS = 60_000`,
  `RATE_LIMITS = { attendance: 30, score: 120, cancel: 5 }`, `rateLimitClass()`
  — verbatim from K+L.
- `RallyCommandRoom` gains `rateLimits` (in-memory map), an injectable
  `clock` constructor parameter (optional, defaults to `Date.now`; the
  platform constructs DOs with `(state, env)`), and `checkRateLimit()` —
  verbatim K+L logic.
- `fetch()`: geocode branch now `.catch(() => 502 { error: 'Place search is
  unavailable.' })`; the queued handler now `.catch(() => generic
  'temporarily unavailable')` so a throw answers instead of rejecting and
  the queue keeps processing. Both verbatim K+L.
- `handle()`: `request.json()` replaced with `readBoundedBodyText` +
  `JSON.parse`; `BodyTooLargeError` and `SyntaxError` both answer generic
  400 `'Invalid rally command request.'`. Rate-limit check runs after both
  parses and before dispatch, returning HTTP 200 with
  `failure('Too many requests. Try again shortly.')` — 200 is deliberate
  (K+L): the action maps any non-2xx room response to its generic
  "temporarily unavailable" failure, which would hide the message.

## 3. Adaptations from the K+L design (and why)

1. **Series commands are rate-limited per user + series id.** K+L predates
   the series paths: its room had no `parseSeriesCommand` and its limiter
   keyed only on `sessionId`. On PR #22 a series command carries `seriesId`,
   not `sessionId`. The check runs on the parsed series command with key
   `userId:seriesId:class`, placed after `parseSeriesCommand` so a null
   session parse can never be dereferenced — the exact K03×G+H interaction
   the integrated branch fixed (`feature/muse-integrated-all`, commit
   `bbfd8c5`) is not reintroduced. Verified by the series test: 1
   createSeries + 29 generateOccurrences fill the budget, the 30th
   generate is throttled, and a different series id has an independent
   budget.
2. **`cancelSeries` maps to the cancel class (5/min).** K+L's
   `rateLimitClass` only knew session operations. `cancelSeries` cancels
   sessions, so it shares the cancel budget; every other series operation
   maps to attendance (30/min), as in K+L's default branch.
3. **No X-App-Action marker check was added.** K03/K05 do not need it, and
   the PR #22 port branch (`feature/muse-pr22-port-fixes` @ `9c44dd4`)
   already adds the marker check on this head. Interaction, documented
   here rather than duplicated: without the marker check, a direct
   `room.fetch` with a forged `userId` could consume that user's budget
   (the limiter keys on the body's `userId`, and the action path is the
   only place the caller is Bearer-verified). The port branch's K01 fix
   closes that vector when the two branches are combined; K03 alone is
   still correct against the action path. Merge note: the marker check
   belongs in `fetch()` before the geocode branch, exactly as the port
   branch does it — do not add a second check inside `handle()`.
4. **`createSeries` abuse across fresh series ids is NOT throttled.**
   `schedulingAction` mints a fresh `seriesId` per `createSeries` call, so
   each creation lands in a fresh per-series room with a fresh budget. This
   is the same known limitation the integrated branch recorded; closing it
   needs a per-user cap in `schedulingAction` (or a shared room), which is
   outside K03's per-room design and was not invented here.
5. **The cross-room cancel callback is unchanged.** `cancelSeries` cancels
   instances by fetching each session room with operation `'cancel'`; each
   inner fetch is itself rate-limited as a cancel on its own session
   (5/min per user+session). A series with many instances does not trip
   this because each instance is a different session key.

## 4. Gate counts (final branch)

| Check | Result |
|---|---|
| Vitest | **244/244 (34 files)** — 235 baseline + 9 new |
| TypeScript (`npx tsc --noEmit`) | clean (exit 0) |
| ESLint (`npx eslint .`) | clean (exit 0) |
| Vite build (`npx vite build`) | passes (exit 0) |
| Node (`node --test tests/rally.test.mjs tests/courts-games.test.mjs`) | **31/31** |

## 5. Still open / not fixed

- **K01 marker check is not in this branch** — see §3.3. It lives on the
  sibling port branch; the two branches must be combined before the
  budget-exhaustion interaction is closed.
- **PR #22 duplicate rally creation** (adversarial finding: two simultaneous
  identical `createRally` calls both succeed) — not in K03/K05 scope; needs
  a per-user room hop or idempotency key in `createRallyAction`.
- **`getPlayerStats` unbounded scan** (`limit: Infinity` → one session GET
  per result) — needs server-side aggregation, not a limiter.
- **C1 contract fork** (`'published'` in docs/header vs `false` in code)
  — undecided, untouched here.
- **Live verification** — two-account flows, live RecordRoom enforcement,
  real-DO queue under eviction, live alarm behaviour, and migration
  against pre-existing data remain unverified (no DeepSpace login/test
  accounts in this environment). All evidence above is local mock-harness
  simulation.
- **Bundle caveat:** integrity-verified via `git bundle verify` (complete
  history, head matches the branch tip). **Not independently re-tested from
  a fresh clone** — the clone step was blocked by the runtime
  execution-risk flag, and per the safeguard it was not bypassed. The code
  the bundle carries is the same branch that passed the full gate
  (244/244) in its worktree.

## 6. Files

- `src/server/rally-command-room.ts` — the port (commit `6759087`).
- `src/server/pr22-rate-limit.test.ts` — 9 tests (commit `df5ffee`,
  fail-before 7/9; passing after `6759087`).
- This log (`IMPLEMENTATION_LOG.md`).
