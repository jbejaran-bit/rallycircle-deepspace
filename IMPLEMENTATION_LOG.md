# PR #22 Port Fixes — Implementation Log

**Target:** PR #22 `review/rallycircle-serialized-session-time` @ `e6ff2d9`
**Branch:** `feature/muse-pr22-port-fixes` (worktree `~/workspace/deepspace-interview-prep/fullstack/pr22-port-fixes`)
**Date:** 2026-11-21 ~06:15–06:30 EST
**Basis:** `~/workspace/deepspace-interview-prep/fullstack/pr22-reconcile/RECONCILE_PR22.md`
(7 defects still present on e6ff2d9) + the DO-resilience audit
(`fullstack/pr20-do-resilience/IMPLEMENTATION_LOG.md`, alarm/recovery code
identical in PR #20 and PR #22, verified by diff).
**Scope:** port ONLY defects that reproduce on e6ff2d9. No product code was
fixed without a failing test first; no Codex branch modified; no merge,
deploy, credential, production-data, or submission action. PR #21 untouched.
All tests are local mock-harness simulations — never production data, never
live auth.

## Baseline

Clean `e6ff2d9` in this worktree before any fix: **Vitest 235/235 (33 files)**,
matching the reconcile baseline. Final gate (this branch): **Vitest 275/275
(36 files), tsc clean, eslint clean, vite build passes, node --test 31/31**
(`tests/courts-games.test.mjs tests/rally.test.mjs`, the project's Node suite
form). `node --test tests/` (directory form) fails identically on pristine
e6ff2d9 — pre-existing quirk, not a regression.

## Fail-before evidence

Commit `6a7696c` (test-first, no product changes) added the repro suites.
On unfixed `e6ff2d9` exactly **11 tests failed**:

| File | Failures on unfixed e6ff2d9 |
|---|---|
| `src/server/pr22-port-fixes.test.ts` (8 tests) | K01, X4, F3-cancel, F6-poll, S5, F4 (6) — K01-legit and S8-residual pass (see §S8) |
| `src/server/pr22-do-resilience.test.ts` (14 tests, fixed form from `7b76e88`) | A1, A2, A3, E1 (4) |
| `src/lib/migration-compat.test.ts` (16 tests) | F7 (1) |

Note: the DO file in the audit worktree is the *reproduction* form (13 tests,
asserting the buggy behaviour — it passes on unfixed code by design). The
file committed here is the *fixed* form from the DO fix branch (`7b76e88`,
14 tests incl. A1b), so its 4 failures are the fail-before evidence.

## Per-defect verdicts and fixes

### 1. K01 — forged room fetch (N-03): FIXED (`bfe47a9`)

- **Repro:** `PR22-PORT K01` — direct `room.fetch` with forged `userId:'host'`
  cancel returned 200 and cancelled the session on unfixed code.
- **Fix (re-implemented against PR #22, not cherry-picked):** `RallyCommandRoom.fetch`
  now rejects POSTs to `/rally-command` and `/geocode` without
  `X-App-Action: 'true'` with 400, before queueing or parsing (geocode
  rejection reuses the existing `Invalid place name.` 400 so it is
  indistinguishable). All four in-app callers stamp the marker:
  `rallyCommandAction`, `schedulingAction`, the cross-room series-instance
  cancel inside `handle()`, and the court-discovery geocode caller.
- **Legitimate path verified:** `PR22-PORT K01-legit` — RSVP + cancel through
  `rallyCommandAction` still succeed after the check.
- Defense in depth only: no route exposes the DO today; the action's Bearer
  token remains the only auth boundary; the marker is not a secret.

### 2. X4 — syncOwnedVisibility 100-row cap: FIXED (`427c379`)

- **Repro:** `PR22-PORT X4` — flipping a profile to private left 20 of 120
  `matchResults` rows public.
- **Fix:** page with `offset` until a short page (page size 100), for both
  `playerStats` and `matchResults`. Adapted from security-branch `90e5ee1`;
  the query options are hoisted into a variable because the installed
  ActionTools declaration omits `offset` (same pattern `loadVerifiedResults`
  already uses).

### 3. F3-cancel — notifyRsvpHolders 100-row cap: FIXED (`4629633`)

- **Repro:** `PR22-PORT F3-cancel` — cancelling a 150-RSVP session sent 100
  `session_cancelled` notices instead of 150.
- **Fix:** shared `queryAllSessionRsvps` helper pages RSVP reads with offset
  for `notifyRsvpHolders` (cancel path). The poll-finalize path already pages
  via `recordPages` on PR #22 and is unchanged.

### 4. F6-poll — refreshPollTally limit:500: FIXED (`0e7e1a7`)

- **Repro:** `PR22-PORT F6-poll` — a 502-vote poll tallied 299/201 instead of
  301/201.
- **Fix:** page `pollVotes` with offset (page size 500, max 200 pages),
  deduplicating by recordId so a store that ignores `offset` cannot
  double-count or loop forever. Adapted from races-branch `c4e979c`.

### 5. S5 — stuck pendingResult blocks cancel: FIXED (`714c5d1`)

- **Repro:** `PR22-PORT S5` — after a failed final session write left
  `pendingResult` set, cancel returned failure; the session was frozen.
- **Fix:** cancel no longer refuses on `pendingResult`; the cancel write
  clears the marker (`pendingResult: ''`).
- **Residual (documented):** history rows a partial finalization already
  wrote stay in storage. On this architecture they are inert:
  `loadVerifiedResults` only counts rows whose session score is final at
  the same revision, and a cancelled session's score can never become
  final, so the rows remain as storage-level provenance and never count.
  (Cleaner than the PR #19 residual, where the rows counted a match whose
  session was cancelled.)

### 6. F7 — validateSession notes TypeError: FIXED (`6342d99`)

- **Repro:** migration-compat `an old session with no notes validates` —
  `TypeError: Cannot read properties of undefined (reading 'length')` at
  `src/lib/rally.ts:51`.
- **Fix:** `(input.notes ?? '').length`. One line, same as the review-branch fix.

### 7. F4 — correction hides history: FIXED (`d30c1c7`, + tsc follow-up `aa64403`)

- **Repro:** `PR22-PORT F4` — after host correction, history returned 0 entries
  (match vanished); stats 0/0/0.
- **Semantics decision (per issue #23): visible-pending — neither the review
  branch's keep-counting semantics nor PR #20's hide-entirely semantics.**
  A corrected match stays visible in history as `pending` (showing the
  corrected, unapproved outcome) until re-approval, and is excluded from
  verified statistics. Durable audit/provenance is preserved (rows kept in
  storage; the `'corrected'` audit row preserves the previous outcome).
  - Alternative considered and rejected: keep-counting (review branch) would
    let a superseded outcome keep affecting win rates after the host
    corrected it. Hide-entirely (status quo on PR #22) made the match
    disappear from a player's history.
  - If the owner prefers a different counting rule, the decision point is
    `loadVerifiedResults`' pending branch — a one-branch change.
- **Implementation:**
  - `src/lib/match-stats.ts`: `MatchResultRow.status: 'final' | 'pending'`
    and `MatchHistoryEntry.status` (required; fixtures updated).
    `summarizePlayerStats` counts final rows only. `buildMatchHistory`
    passes the status through.
  - `src/server/profile-actions.ts`: `loadVerifiedResults` gains
    `includePending`. A row superseded by a newer committed score revision
    (session exists, score parses, format valid, user on a team, current
    score has a winner) surfaces as `pending` with the current score's
    won/sets/revision when `includePending` is true. All other unverified
    states (disputed, partially approved, in-progress, missing session or
    score, `pendingResult` set) stay hidden, as before.
    `getMatchHistoryAction` loads with `includePending: true`;
    `getPlayerStatsAction` loads verified rows only.
  - `src/lib/track-bc-fixtures.ts`: `exampleHistory` entries gain
    `status: 'final'` (tsc follow-up, `aa64403`).
  - New unit tests in `src/lib/match-stats.test.ts`: pending rows never
    count in stats; pending entries stay visible with their status.

### 8. S8 residual — re-fetch guard: NO FIX (provably unreachable, proof tested)

- **Verdict:** the schema closure in `e6ff2d9` fully prevents the race; the
  re-fetch guard is NOT ported.
- **Proof (exhaustive `startsAt` write enumeration over product code, plus
  the passing `PR22-PORT S8-residual` test):**
  - Direct client writes: `startsAt` removed from member/admin
    `writableFields`; member/admin `create` on sessions is `false`
    (`checkFieldPermissions` denies it for both roles; `canCreate` false).
  - `editSeries` refuses to edit a published series (`generatedCount` or any
    existing instance → failure), so it cannot move an existing session.
  - `generateOccurrences` only CREATES new sessions (`records.create`);
    it never updates an existing session's `startsAt`.
  - `createRallyAction` only creates new sessions.
  - The only `records.update` on sessions carrying `startsAt` is
    `finalizePoll`'s own write — and finalizePoll commands for one session
    serialize through that session's room queue, so no other finalize can
    interleave between its read and write.
  - The test asserts (a) the schema denial, (b) editSeries on a published
    series fails and leaves the occurrence time unchanged, and (c) two
    concurrent finalizePoll commands serialize and converge exactly once
    (revision bumped once).
- **Caveat recorded:** the race returns if any future path re-opens direct
  `startsAt` writes. If that ever happens, port races-branch `a998f57`
  (re-fetch guard) at the same time. The DO-resilience E1 fix below is the
  safety net for the guard-firing case.

### 9. DO resilience — E1, A1/A2, A3: FIXED (`1a54203`, cherry-picked `9d67a0d`)

- The alarm/recovery code is identical in PR #20 (`f492736`) and PR #22
  (`e6ff2d9`) — verified by diff in the DO audit — so the fix commit from
  `feature/muse-pr20-do-resilience-fixes` applied cleanly with no conflicts.
- **E1:** when the edited-during-finalization guard fires, the poll is reset
  to `open` before returning the (unchanged) failure, so the host can cancel
  it and the session is unblocked; the next alarm tick clears the key. On
  PR #22 the guard's trigger (a direct time edit) is already unreachable
  via §8, so this is a safety net for the guard ever firing.
- **A1/A2:** recovery entries are stored as `{ command, attempts }`
  (legacy bare-command values read as `attempts: 0`); entries are dropped
  after `MAX_RECOVERY_ATTEMPTS = 10` failed alarm ticks (~5 min), and the
  alarm stops. Uninterpretable stored values are dropped rather than looped on.
- **A3:** `alarm()` best-effort re-arms on `recover()` throw, then rethrows
  so the platform's retries still apply.
- **Verified:** `src/server/pr22-do-resilience.test.ts` — on unfixed e6ff2d9
  exactly A1/A2/A3/E1 failed (10 passed); after this commit 14/14 pass,
  including A1b (transient replay failure still recovers below the budget).

## What was NOT ported (resolved on PR #22, verified by the reconciliation)

- F2/S10 (500-result stats cap), F5/S2 (cross-session lost update),
  D1/F6 (corrupt `sets`), F1/D-1 (generateOccurrences duplication), X1
  (cancelSeries silent drop) — all resolved by PR #20's architecture rewrite
  or PR #22's schema closure; no fix needed.
- K03 rate limiting and K05 bounded-body parsing remain absent (not in
  PR #19, not added by PR #20/#22). Flagged, not implemented — bigger
  behavioural changes, outside this port's scope.
- C1 contract fork (`'published'` in docs/header vs `false` in code for
  playerStats/matchResults member read) — decision still required, not
  unilaterally changed.

## Still open / known limitations

- `pendingResult`/poll-finalize liveness: no timeout on a stuck pending
  operation (alarm gives a retry path but no timeout).
- `finalizePoll` two-write window (session update lands before poll update;
  host can re-finalize, revision bumps once more; no rollback).
- Direct host `startsAt` edits bypass `scheduleRevision` — now impossible
  via any in-app route (see §8); the statement survives only as a
  schema-level fact.
- Live alarm behaviour, live RecordRoom enforcement, two-account flows, and
  migration against pre-existing production data remain unverified (no
  DeepSpace login / test accounts in this environment).
- `getPlayerStats` loads verified results with `limit: Infinity` (65 results
  → 65 session GETs, uncapped) — noted by the adversarial wave; capping
  would undercount, needs server-side aggregation. Not changed here.

## Commits (base e6ff2d9)

| Commit | Fix |
|---|---|
| `6a7696c` | Test-first reproductions (11 failing tests on unfixed code) |
| `bfe47a9` | K01 marker check + stamping in all 4 callers |
| `427c379` | X4 visibility paging |
| `4629633` | F3-cancel RSVP paging |
| `0e7e1a7` | F6-poll tally paging |
| `714c5d1` | S5 cancel clears pendingResult |
| `6342d99` | F7 notes guard |
| `d30c1c7` | F4 visible-pending semantics |
| `1a54203` | DO resilience (E1/A1/A2/A3, cherry-picked `9d67a0d`) |
| `aa64403` | tsc fixes from the F4 status field + port test file |

## Deliverables

- Branch: `feature/muse-pr22-port-fixes` (worktree above; tip `aa64403`)
- Bundle: `fullstack/pr22-port-fixes.bundle` (+ per-commit patches in
  `fullstack/pr22-port-fixes-patches/`)
- This log: `fullstack/pr22-port-fixes/IMPLEMENTATION_LOG.md`

---

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
