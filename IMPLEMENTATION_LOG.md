# Duplicate rally creation — fix log

**Target:** PR #22 `review/rallycircle-serialized-session-time` @ `e6ff2d9`
**Branch:** `feature/muse-pr22-dup-create-fixes` @ `49988c3` (3 commits off `e6ff2d9`)
**Authorization:** user 2026-11-21 00:52, overnight 10-hour backend reliability sprint (issues #23/#24).
**Method:** executable mock-harness/unit tests only; local simulation, never live auth, never production data.
Codex's branches untouched; nothing merged, deployed, or submitted; PR #21 untouched.

## 1. Verdicts per head

| Head | Verdict |
|---|---|
| PR #22 `e6ff2d9` | **CONFIRMED, FIXED** — two simultaneous identical `createRally` calls both succeeded as distinct sessions; fixed by routing creation through a per-user command room. |
| PR #20 `f492736` | **NOT APPLICABLE as framed** — `src/server/create-rally-action.ts` does not exist on `f492736` (`git show f492736:...` → file absent; the action was added by PR #22's single commit). On PR #20 sessions are created by **direct client writes** (`sessions` member `create: true` in that head's schema, and no `tools.create('sessions', …)` call exists in `src/`). Duplicates there are inherent to unsynchronized client writes — the defect only becomes fixable server-side once PR #22 closes direct creation, which is exactly what this fix builds on. No fix ported to PR #20. |

## 2. The defect (as found)

`createRallyAction` (`src/server/create-rally-action.ts`) validated the draft (zod-strict +
`validateSession`) and then called `tools.create('sessions', …)` directly — no command-room hop,
no per-user queue, no idempotency key, and no `uniqueOn` on `sessions`. Two concurrent identical
calls therefore both succeeded as distinct sessions. Reproduced test-first (see §4).

## 3. The fix

**Design: per-user command-room hop + exact-draft dedup.** `createRallyAction` now forwards the
validated draft to a dedicated room, `rally:<appId>:user:<userId>`, and the room's queue
serializes that host's creates. Inside the room, `applyCreateRallyCommand`:

1. re-validates the draft with `validateSession` (defense in depth — the room never trusts a
   caller; `parseCreateRallyCommand` shape-checks first so `validateSession` never sees a
   non-string field and cannot throw the F7-style `notes.length` TypeError);
2. queries open sessions for `{ hostId, startsAt, status: 'open' }` (limit 10);
3. returns the existing session when one **exactly matches the draft** (all of
   format/title/court/location/startsAt/durationMinutes/targetPlayers/capacity/level/notes);
4. otherwise creates the session (`status: 'open'`, `chatChannelId: ''`, `hostId` stamped by the
   record layer via `userBound`, exactly as `generateOccurrences` relies on).

Consequences, all covered by tests:

- **Double-submit / concurrent identical creates → one session.** The second call returns the
  first call's `recordId` with `success: true` (idempotent success, not an error).
- **Retry after a transient failure → one session.** A failed create writes nothing, so the
  retry creates; a further identical call returns the created session.
- **Retry after a lost response → the same session.** The create landed; the retry finds it.
- **Cancel then re-create with the identical draft → a new session.** Cancelled sessions never
  match (the query filters `status: 'open'`), so the host can re-create freely.
- **Distinct drafts still create distinct sessions** — different host, different time, or any
  differing detail (title, court, …) at the same time.
- **Series generation untouched.** It runs in the series room via `generateOccurrences` with
  deterministic occurrence ids; it never goes through `createRallyAction`. Regression test
  included (createSeries + generateOccurrences → 3 occurrences, 3 host RSVPs, re-run is a no-op).

**Marker (K01 forward-compatibility).** The action stamps `X-App-Action: 'true'` on its room
fetch, so the room's internal-action check (K01 fix, sibling branch `feature/muse-pr22-port-fixes`
@ `9c44dd4`) accepts the call after merge. Without the room binding the action **fails closed**
rather than creating directly — it never silently re-introduces the race. (On this base `e6ff2d9`
there is no marker check yet, so the new command inherits the same K01 caveat as every other
room command here: a forged direct room fetch could create sessions as any user. The port
branch's marker check closes it, and this action already stamps the marker — verified in the
trial merge, §6.)

**Files changed**

- `src/server/rally-command-room.ts` — `CreateRallyCommand` type, `parseCreateRallyCommand`,
  `applyCreateRallyCommand` + `sameRallyDraft`, routing in `handle()` (third parse path after
  `parseCommand` / `parseSeriesCommand`).
- `src/server/create-rally-action.ts` — room hop instead of `tools.create`; result-shape
  validation mirroring `rallyCommandAction`; fail-closed without the room binding.
- `src/server/create-rally-action.test.ts` — rewritten: asserts the action forwards the validated
  draft to the per-user room with the marker header, never calls `tools.create`, rejects invalid
  drafts before any room call, and fails closed without the binding.
- `src/server/pr22-adv-serial.test.ts` — ported from the adversarial worktree
  (`fullstack/pr22-adv-serial`, where it was untracked) with 7a flipped from DUPLICATE-CONFIRMED
  to fixed behaviour, plus new 7e tests. Harness gains a `recurringSeries` store (hostId stamped
  from the caller, matching the real RecordRoom's `userBound` behaviour), a
  `setFailNextSessionCreate` fault injector, and a `scheduleCommand` helper.

## 4. Test evidence (fail-before / pass-after)

Test-first commit `bdc00ba` (tests only, against unfixed `e6ff2d9`):
`src/server/pr22-adv-serial.test.ts` — **4 failed / 9 passed**. The 4 failures are exactly the
dedup tests: `two simultaneous identical creates return the same session`, `ten rapid sequential
identical creates make exactly one session`, `a retry after a successful create returns the same
session (lost-response retry)`, `a retry after a transient write failure creates exactly one
session` (fails on its third-call assertion: the identical call after a successful retry created
a second session). All 9 guards passed before the fix (cancel/re-create, distinct drafts, series
regression, 7b/7c/7d).

Fix commit `070f778`: all 13 serial tests pass; the four touched files pass 66/66
(serial 13 + create-rally-action 7 + scheduling 19 + command-room 27).

**Full gate on the branch:** Vitest **249/249 (34 files)** — baseline 235 + 13 serial + 1 new
create-rally-action test; **tsc clean; eslint clean** (touched files); **vite build passes**;
**node --test 31/31** (`tests/courts-games.test.mjs`, `tests/rally.test.mjs`).

## 5. Rejected alternatives

- **Deterministic recordId (`rally-<hash(hostId, startsAt, draft)>`) + get-on-duplicate.** The real
  SDK's `records.create` does use a plain `INSERT` (`node_modules/deepspace/dist/worker.js:1675`),
  so a duplicate explicit id would fail at the SQL layer — but the design is worse: a
  cancel-then-re-create would collide with the cancelled record's id and need a fallback id,
  which re-introduces a race in exactly that path; and a retry would surface a duplicate *error*
  the client must interpret instead of the existing session. The room hop returns the session
  and handles cancel/re-create naturally.
- **Host + startsAt-only dedup (any open session at that time blocks creation).** Rejected as a
  product decision this task does not authorize: a host might legitimately run two simultaneous
  sessions at different courts. Exact-draft matching fixes the reported defect (identical calls)
  with the smallest behaviour change; the host+time variant is recorded here if the product
  later wants it.
- **`uniqueOn` on `sessions`.** There is no `(hostId, startsAt)`-style key that expresses
  "identical draft" — `uniqueOn` is per-field equality, and sessions have no such column. A
  synthetic key column would be a schema change with migration implications; the room check is
  smaller and keeps the dedup rule in code where the draft comparison lives.

## 6. Trial merge with the sibling PR #22 branches — combinable with one test-only fix

Trial-merged in a scratch worktree (removed afterwards; reproducible from this tip):
`feature/muse-pr22-port-fixes` @ `9c44dd4` merged **cleanly**, then
`feature/muse-pr22-rate-limit-fixes` @ `b66d8eb` merged with **2 trivial conflicts**, both
adjacent-line insertions, resolved by union:

- `rally-command-room.ts` imports: keep both the `validateSession` import (this branch) and the
  `BodyTooLargeError`/`readBoundedBodyText` import (rate-limit branch).
- `RallyCommandRoom.fetch()`: keep the port branch's K01 marker check first, then the
  rate-limit branch's geocode `.catch()` (502) and handler `.catch()` (generic failure).
- `IMPLEMENTATION_LOG.md` add/add: concatenated both logs.
- The `handle()` region merged without conflict: this branch's `createCommand` parse line and
  the rate-limit branch's K03 checks coexist (the K03 checks only cover session and series
  commands; `createRally` commands are not rate-limited — see §7).

Result before the test fix: **295/298, tsc clean** — the 3 failures were all in
`pr22-rate-limit.test.ts`, all caused by the port branch's marker check: that file's `rawFetch`
/ `geocodeFetch` helpers call `room.fetch` directly **without** the `X-App-Action` header, so
the marker gate rejected them with 400 before the handler ran (`accepts a legitimate
large-but-under-cap body`, `returns a generic failure and keeps the queue moving when the record
room throws`, `answers a storage throw in geocoding with 502`). Stamping the marker in those two
test helpers (trial-worktree-only change) makes the full suite green: **Vitest 298/298, tsc
clean, eslint clean** on the touched files. The required follow-up when the three branches are
combined is that one-line test-harness fix in `pr22-rate-limit.test.ts` — no product change.
Trial-merge commit (scratch worktree, removed): `aa4de3a`.

## 7. Still open / not fixed

1. **K03 does not cover creation.** The rate-limit branch's `checkRateLimit` only runs for
   session and series commands; `createRally` commands are unthrottled. Mitigated in practice:
   creates are serialized per user through the per-user room queue (a flood from one user
   self-serializes through a query + create per call), but a deliberate creation flood is still
   possible. If a per-user creation cap is wanted, it belongs in `applyCreateRallyCommand`
   (e.g. count open sessions created in the window) or in the K03 classifier — a product
   decision, not taken here.
2. **K01 caveat on this base** (§3): the new command is directly invocable by a forged room
   fetch until the port branch's marker check lands. The action already stamps the marker.
3. **Live verification unverified** — real-DO queue behaviour under eviction, live RecordRoom
   query semantics (`where` on multiple fields), two-account flows, migration against
   pre-existing data (no DeepSpace login/test accounts in this environment). All evidence here
   is local mock-harness simulation.
4. **`getPlayerStats` unbounded scan (`limit: Infinity`)** — pre-existing, out of scope.
5. **C1 contract fork** — undecided, out of scope.
6. **Bundle caveat:** integrity-verified via `git bundle verify`, but **not independently
   re-tested from a fresh clone** — see §8.

## 8. Deliverables

- Branch: `feature/muse-pr22-dup-create-fixes` @ `49988c3`
  (commits `bdc00ba` tests-first, `070f778` fix, `49988c3` log)
- Bundle: `fullstack/pr22-dup-create-fixes.bundle` — SHA-256
  `1286cdf9cf7eebd32aa28d8ff64c070b8166b3ae87c8a4bbbdb06cac030e7e32`,
  `git bundle verify`: OK, complete history, head `49988c3`.
- Per-commit patches: `fullstack/pr22-dup-create-fixes-patches/` (0001–0004, including this log).
- This log: `fullstack/pr22-dup-create-fixes/IMPLEMENTATION_LOG.md`

Nothing was merged, deployed, pushed, or submitted; PR #21 untouched; no production data or
credentials touched.
