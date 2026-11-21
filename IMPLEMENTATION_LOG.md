# PR #22 combined fixes — implementation log

**Branch:** `feature/muse-pr22-combined-fixes` (isolated development branch, off PR #22
`review/rallycircle-serialized-session-time` @ `e6ff2d9`)
**Authorization:** user, 2026-11-21 ~13:14 EST — combine the three reviewed PR #22 fix
branches, then reconcile the additional verified branches; local integration, conflict
resolution, regression testing, commits, and publishing an isolated draft review branch
only. NOT authorized: merging a GitHub PR into main, deployment, production migration,
application submission.
**Worktree:** `~/workspace/deepspace-interview-prep/fullstack/pr22-combined-fixes/`

## 1. Merge sequence

| Step | Commit | Gate after |
|---|---|---|
| Merge `feature/muse-pr22-port-fixes` @ `9c44dd4` (K01, X4, F3-cancel, F6-poll, S5, F7, F4 visible-pending, DO resilience) | `6f78482` | clean merge, no conflicts |
| Merge `feature/muse-pr22-rate-limit-fixes` @ `b66d8eb` (K03, K05) | `78f6009` | 2 conflicts, resolved by union (below) |
| Merge `feature/muse-pr22-dup-create-fixes` @ `d1ab8d0` (per-user room hop + exact-draft dedup) | `eb4b42c` | 1 imports conflict, resolved by union |
| Stamp `X-App-Action` in rate-limit test helpers | `0c90f8f` | Vitest **298/298** (38 files), tsc clean, eslint clean, vite build clean, node --test 31/31 |
| Reconcile stats-aggregation + migration + perf | `5b7528d` | Vitest 355/356 — 1 failure (perf poll tally, harness artifact; fixed next commit) |
| Fix perf harness pollVotes query to honor offset | `58dbfa7` | Vitest **356/356** (42 files), tsc clean, eslint clean, vite build clean, node --test 31/31 |

### Conflict resolutions

- **Rate-limit merge, `rally-command-room.ts` `fetch()`:** kept the port branch's K01
  marker check first, then the rate-limit branch's geocode `.catch()` (502) and handler
  `.catch()` (generic failure). The K01 comment block was preserved verbatim.
- **Rate-limit merge, `IMPLEMENTATION_LOG.md`:** add/add — concatenated both logs.
- **Dup-create merge, imports:** union — kept the rate-limit branch's
  `BodyTooLargeError`/`readBoundedBodyText` import AND the dup-create branch's
  `validateSession` import in the `rally.js` import line. (The trial-merge recipe's
  note about the `validateSession` import referred to this hunk.)
- **Dup-create merge, `IMPLEMENTATION_LOG.md`:** add/add — concatenated.
- **Rate-limit test helpers:** `rawFetch`/`geocodeFetch` in `pr22-rate-limit.test.ts`
  stamp `X-App-Action: 'true'`, exactly like the real in-app actions — otherwise the
  K01 gate rejects them with 400 before the handler runs (3 tests). Test-only change.

## 2. Reconciliation — what was ported, what was adapted, what was not

### Stats aggregation (`bc1fc68`) — ported, `loadVerifiedResults` replaced

The stats branch's `loadVerifiedResults` **replaces** the port branch's version, per the
combiner recipe. The port branch's read-side loader fetched every session (N results =
N session GETs); the stats loader trusts stored final rows (0 GETs) because the
serialized room maintains a write-side `status` on every row. Kept from the port
branch: the **paged `syncOwnedVisibility`** (the stats copy of `profile-actions.ts`
still had the single `limit: 100` query — porting that would have reintroduced X4),
the `getMatchHistoryAction` comment, and the F4 visible-pending semantics (the `status`
vocabulary is identical, so the port branch's flip code merges cleanly). Ported from
the stats branch: `match-stats.ts` (`MatchResultStatus`, `normalizeResultStatus`,
`parseStoredSets`, final-only `summarizePlayerStats`), the additive `status` column
in `profiles-schema.ts`, `result-finalization.ts` (`status: 'final'` on finalization
writes + `markSessionResults`), the dispute/correction flips in `applyScoreEdit`
(flip to `'disputed'`/`'pending'` **before** the session score commits — fail closed,
retry idempotent), and the stats-aggregation test suite (11 tests) plus the
`profile-actions.test.ts` seed changes (complete seeded rows, as finalization writes
them). No stored `playerStats` row reintroduced — F2/S10 + F5/S2 stay closed.

### Migration (`3e485de`) — ported, F4 in write-side form

- **F1/F2/F3 (pre-`notes` templates):** `validateSession` already had the port
  branch's `(input.notes ?? '')` guard; ported the `parseSeriesTemplate` fix
  (missing notes parses as `''`; non-string still rejected) and the
  `create-rally-action.ts` fix (notes optional in zod, normalized to `''` in the
  draft — including the draft forwarded to the per-user room, so the stored
  session is complete). F7 decision applied (see §3).
- **F4 (cancelled-session counting):** the migration branch's check lived in the
  read-side loader (drop rows whose session status is `'cancelled'`). That check
  cannot survive the stats loader, which never fetches the session for final
  rows. Re-implemented write-side: a fourth row status, `'cancelled'`, added to
  the vocabulary (type, schema options, `normalizeResultStatus`); the room flips
  a session's rows to `'cancelled'` in the cancel path, **after** the session
  commit (a failed flip can never un-cancel the session; it only leaves rows
  counted until a maintenance sweep flips them). `loadVerifiedResults` drops
  `'cancelled'` rows from both statistics and history. The S5 comment in the
  cancel path was corrected: partial-finalization rows are NOT inert on this
  architecture (the port loader's assumption) — the flip is what excludes them.
- **F5 (cancelPoll):** unknown-status polls are now cancellable — only
  `finalized`/`finalizing`/`cancelled` refuse. Re-polling after cancellation
  stays impossible by design (`uniqueOn: ['sessionId']`).
- **F6 (markAllRead):** query by `recipientId` only, skip already-read rows in
  code (legacy rows without `readAt` were never matched by the `readAt: ''`
  filter).
- **Tests:** ported `pr22-migration.test.ts` (28 tests + 1 new) with adaptations
  to the write-side architecture (see §5).

### Perf (`a4f8a44`) — ported, bounds now pass

- The 3-line history page slice is in the combined `loadVerifiedResults`
  (slice each page to the rows still needed before checking; no-op for stats).
- The five former `it.fails` bounds are ordinary passing `it` tests here:
  stats N=50/200/500 at 0 GETs, poll tally 600 votes at exactly 300/300,
  cancel fan-out 150 holders at exactly 150 notices.
- **Harness finding fixed in this branch (`58dbfa7`):** the perf harness's
  `pollVotes` query sliced from 0 and **ignored `offset`**, so the port
  branch's paged `refreshPollTally` re-read the same first 500 votes on page
  2 and the tally stopped at 300/200. The real SDK honors offset (every
  other query path in the same harness does too); the mock was the outlier.
  Fixed the harness to honor offset; product code unchanged. The port
  branch's dedup guard (stop when a page adds no new recordId) remains as
  the defense against a store that ignores offset — on such a store the
  tally would undercount rather than loop forever, which is the documented
  behavior.

### Waitlist-deep (`7ffb93e`) — tests ported as-is

The 6 waitlist concurrency tests ported unchanged (test-only branch; no
product code). All pass on the combined branch.

### DO resilience — verified present, not duplicated

The port branch already cherry-picked the DO-resilience fixes; the combined
branch's `pr22-do-resilience.test.ts` (14 tests) passes. No re-port.

## 3. F7 reconciliation (user decision, 2026-11-21 13:14 EST)

**Decision: missing or null notes read as `''` (empty string); a present but
non-string value is rejected.** This matches the port/migration branches and the
stable product sprint's adopted behavior (PR #25 @ `254f865` closed F7 the same
way). The adversarial branch's error-on-missing is superseded on this line.

Implementation: `validateSession` rejects a present non-string `notes` with
`'Notes must be text.'` and treats missing/null as `''` for the 400-character
check; `parseSeriesTemplate` normalizes a missing `notes` to `''` and rejects a
non-string one; `create-rally-action.ts` zod schema has notes optional (still
rejects non-string drafts) and normalizes to `''` before validation and before
forwarding the draft to the per-user room.

## 4. C1 recommendation — keep `read: false`, fix the stale header

**Recommendation: keep member AND admin `read: false` on `playerStats`,
`matchResults`, and `resultAudits` in this branch. Do NOT restore
`read: 'published'`. Fix the schema header comment to match the code (done in
this branch); the contract doc (`RALLYCIRCLE_BACKEND_CONTRACTS.md` §§175, 838,
1101) still says `'published'` and needs the same correction.**

The three-way fork:

| Position | Direct-read rule | Where |
|---|---|---|
| Contract + schema header (stale) | member `read: 'published'` (owner OR visibility='public') | `RALLYCIRCLE_BACKEND_CONTRACTS.md`, `profiles-schema.ts` header |
| PR #19 code | member `read: 'own'` (owner only) | superseded |
| PR #20/#22 code (this branch) | member `read: false`, admin `read: false` (no direct reads) | `profiles-schema.ts` collections |

Privacy analysis of restoring `'published'`:

1. **The visibility flag would become the sole enforcement for direct reads.**
   That flag has already been proven fallible: X4 — rows past a 100-row read
   cap kept a stale `'public'` value after the profile went private/deleted
   (fixed by paging, but it proves the flag can be stale). A stale `'public'`
   flag would expose the row to every signed-in member via direct read, with
   no action-layer check to catch it.
2. **The SDK predicate cannot express the row `status` vocabulary.**
   `'published'` is owner OR visibility='public'; it says nothing about
   `final`/`pending`/`disputed`/`cancelled`. A pending row (corrected outcome,
   unapproved) on a public profile and every `resultAudits` row would become
   directly readable — including corrected-but-unapproved outcomes and dispute
   states the action layer deliberately hides or gates.
3. **Direct reads bypass the action-layer gates that do exist:**
   `getResultAuditAction` limits reads to host + participants;
   `getMatchHistoryAction` caps at 50 entries; `getPlayerStatsAction`
   derives only from verified rows. None of that applies to a direct query.
4. **`'own'` (PR #19) is safe but redundant:** the owner already gets
   everything through the actions; a second read path adds attack surface
   (and a second place to keep in sync) for no user-facing capability.

The action layer IS the read contract here: owner sees own data; a non-owner
sees data only when the profile is public; audits are host/participant-only;
history is capped. No client code reads these collections directly (verified:
outside `src/server/`, only `src/lib/match-stats.ts` and the schema reference
them; the UI goes through the actions), so closing direct reads costs no
feature. The header comment previously promised `'published'` — that stale
promise is what would mislead a future integrator into "restoring" direct
reads, so it was corrected in the branch to describe the action-only rule.

## 5. Test adaptations for the write-side architecture

The migration test suite was written against the port branch's read-side
loader (which re-derived every row from the session score). Three S5 tests and
one S8 test needed fixture/semantic adaptation; the properties they lock are
preserved in write-side form:

- **Fixtures:** `seedFinalRow` now seeds complete rows exactly as finalization
  writes them (format/won/sets/status). The combined read path trusts stored
  final rows, so an incomplete row is dropped, not derived.
- **5b (stale revision):** now seeds the row with `status: 'pending'` (the
  state the correction flip produces) and the session at the corrected
  revision; stats exclude it and history shows the corrected outcome as
  pending (winner 1, revision 3). Legacy gap documented: a pre-status row
  whose session was corrected *before* the status column shipped has no flip
  to observe and counts as final — the backfill sweep in §6 covers it.
- **5c (cancelled session):** now seeds the row with `status: 'cancelled'`
  (the state the cancel flip produces). New test **5c2** proves the flip
  through the real path: finalize a match through the room (counts 1),
  cancel the session through the room, assert both rows flipped to
  `'cancelled'` and stats/history exclude them.
- **5d (missing session):** now seeds a complete row for a missing session
  and asserts the documented trade: the call succeeds and the row is trusted
  (counts). The read-side loader dropped it; the write-side design trades
  that for 0 GETs. Sessions are never deleted in normal operation (deletion
  is a DO-recovery edge case); a maintenance sweep can flip orphaned rows to
  `'cancelled'`.
- **8a:** seeded row completed with format/won/sets (it previously carried
  only `status: 'final'` and would have been dropped as incomplete).

## 6. Migration plan for the new `status` column (additive, no production migration)

The `status` column on `matchResults` is additive: the schema declares
`default: 'final'`, and `normalizeResultStatus` treats a missing value as
`'final'` (pre-migration rows were written only on finalization). No existing
collection is changed, no existing row is rewritten by the code, and no
migration runs automatically. **Never apply any migration to production
without approval.**

One-time backfill sweep (only if pre-status rows exist in production — none
do on this line yet, since no release has shipped `matchResults`): for every
`matchResults` row with no `status`, set it from the session: `'cancelled'`
if the session status is `'cancelled'`, `'pending'` if the session score
revision exceeds the row's revision, `'disputed'` if the session score is
disputed, `'final'` otherwise; rows whose session is missing are flipped to
`'cancelled'`. The sweep is idempotent (rows already at a status are
skipped) and must run as an explicit maintenance action with the owner's
approval, never as a read-path side effect (a read-side heal would count a
superseded outcome while a correction is in flight — the failed-commit
window). After the sweep, the legacy gaps in §5 (pre-status stale rows,
orphaned rows) are closed.

## 7. Gate (final branch, local mock harness)

- Vitest **356/356** (42 files), tsc clean, eslint clean, vite build clean,
  node --test **31/31**.
- The three former perf `it.fails` bounds now pass as ordinary tests; the
  history page slice keeps pending-row session GETs bounded to the page
  limit (history N=200 with all-final rows issues 0 GETs — the write-side
  loader trusts stored final rows); stats N=500 at 0 GETs.
- All evidence is local mock-harness simulation (in-memory RecordRoom, single
  Node process, this 1.5-CPU VM) unless labeled otherwise. Live verification
  (two-account flows, live RecordRoom enforcement, real-DO queue behaviour,
  live alarms, migration against pre-existing production data) remains
  unverified from this environment — see `docs/TEST_ENVIRONMENT_PLAN.md`.

## 8. Known limitations carried forward (unchanged from the sprint)

- `pendingResult` / poll-finalize liveness — no timeout on stuck pending
  operations; `finalizePoll` two-write window remains (the alarm gives a
  retry path, not a timeout).
- Stats optimistic window — finalization writes the row (`final`) before the
  session commit; a failed commit means stats count the approved result
  until the retry lands (pre-existing base behaviour).
- `markSessionResults` uses a single page (limit 100, ≤4 players per match).
- Lost promotion notices are accepted-by-design (no background retry queue);
  cancel notices come from RSVP rows.
- No waitlist-position endpoint (Track K+L L10 never merged into PR #22).
- K03 does not cover creation (creates self-serialize per user, but a
  deliberate creation flood is still possible; a per-user creation cap is a
  product decision). Same for `createSeries` across fresh series ids.
- Cancel-flip gap (new, this branch): the `'cancelled'` flip runs after the
  session commit and is best-effort — if it fails, the rows stay counted
  until a maintenance sweep flips them. The flip is idempotent and a later
  cancel is a no-op (early return), so the gap only opens on a failed flip.
- Legacy gaps (new, this branch; see §5/§6): pre-status rows with a stale
  session revision count as final, and orphaned complete final rows count;
  both are closed by the backfill sweep in §6.

## 9. Follow-up — validateSession typeof guards + C1 contract-doc correction
(2026-11-21 ~13:31 EST, user-authorized next-defect fix; commits `f5fb346`,
`cf1b609` on this branch)

### 9.1 validateSession typeof guards (confirmed defect, same class as F7)

PR #25 @ `254f865` additionally `typeof`-guards `title`/`court`/`location`
in `validateSession`; the combined branch still called `input.title.trim()`
unguarded, so a non-string title (or court/location) threw a `TypeError`
instead of returning a validation error. Test-first: three new tests in
`tests/rally.test.mjs` (non-string title/court/location across number,
`null`, `undefined`, object, array, boolean) — all three failed on unfixed
code with `TypeError: input.<field>.trim is not a function` (node --test
21 pass / 3 fail). Fix (`cf1b609`, `src/lib/rally.ts`) mirrors PR #25
exactly: `typeof input.title !== 'string' || ...` (same for court and
location), keeping the branch's existing error strings. F7 notes behavior
unchanged: missing/null notes read as `''`, present non-string rejected
(`'Notes must be text.'`). Gate after the fix: Vitest **356/356**
(42 files), tsc clean, eslint clean, vite build clean, node --test
**34/34** (`tests/courts-games.test.mjs` + `tests/rally.test.mjs`;
rally alone 24/24 = 21 baseline + 3 new).

### 9.2 C1 contract-doc correction (docs-only, no code change)

`RALLYCIRCLE_BACKEND_CONTRACTS.md` (§§175, 838, 1101 in the task brief)
was checked against the combined branch's `src/schemas/profiles-schema.ts`
before editing. Two of the three named sections are CORRECT as written
and were left unchanged:
- §175 (`profiles`): member read `'published'`, admin read true — matches
  the code. Profiles are the one collection where published-read applies.
- §838 (groups privacy model): describes the experimental Track I+J
  groups design, which is not in this branch. Left unchanged so the doc
  does not misrepresent that track.

The actually-stale claims were elsewhere, and those were corrected in
`~/workspace/deepspace-interview-prep/RALLYCIRCLE_BACKEND_CONTRACTS.md`
(the doc lives at the prep root, outside the app repo — it is NOT in this
worktree, so the correction is not committable on this branch and is
recorded here and in `SPRINT_HANDOFF.md` §12 instead; the doc was not
forced into the app repo):
- `playerStats` §3.1: now states member AND admin read `false`, reads
  action-only via `getPlayerStatsAction`, and that totals are derived on
  read from `matchResults` rows — finalization maintains no stored row on
  this line.
- `matchResults` §3.1: the table gains the `status` column
  (`final`/`pending`/`disputed`/`cancelled`, default `'final'`, additive —
  missing counts as `'final'`), and the permissions now state member AND
  admin read `false`, action-only via `getMatchHistoryAction` /
  `getPlayerStatsAction` (the old "`visibilityField` as above" implied
  published-read).
- `resultAudits` §3.1: the old "`member` read `true`" is withdrawn —
  member AND admin read `false`, action-only via `getResultAuditAction`
  (host/participant-only).
- §10 Privacy model: the first bullet now states `read: 'published'` +
  `visibilityField` applies to `profiles` only (and group rows on the
  I+J line), and that stats/results/audits are `read: false` for `*`,
  `member`, AND `admin`, with the action layer as the read contract; it
  records the secure recommendation — do NOT restore `'published'`,
  because the SDK predicate cannot express the row `status` vocabulary
  (a pending row on a public profile and every audit row would become
  directly readable) and the stored `visibility` flag is data, not an
  enforcement boundary (the X4 class proved it fallible). The "Honest
  boundary" bullet now says the hiding for stats/results/audits is at
  the action layer only.

Remaining `'published'` mentions in the doc after the correction are all
correct for their collections (profiles §175, groups §838, corrected §10).
Follow-up (not taken here): the `playerStatsSchema` header comment still
says rows are "incrementally maintained... updated only by the
RallyCommandRoom when a result finalizes", which is stale relative to
derive-on-read — a comment-only fix for a later pass; it does not affect
behavior or permissions.

---

## 10. Follow-up — matrix regressions fixed (2026-11-21 ~15:49–21:10 EST, user-authorized 15:41 EST)

Fixes the confirmed regressions from the security + concurrency matrix
re-run on `e1e0d57` (`fullstack/pr22-combined-verify/SECURITY_MATRIX.md`
§6). All fixes test-first; the ported matrix suites were re-run in the
`fullstack/pr22-matrix/` worktree (detached, ported files untracked
there) against the new tip. New tip: `674311f` (was `e1e0d57`).

### 10.1 Final-row verification on read — stats optimistic window + corrupt-data handling (commit `1bb7d17`)

`loadVerifiedResults` (`src/server/profile-actions.ts`) trusted stored
`'final'` rows with zero session GETs, which made two behaviours
observable that PR #22's session-deriving read masked:

- **Stats optimistic window (ADAPT S1/S3):** finalization writes the row
  `'final'` before the session score commits, so a failed commit left
  stats counting an outcome the scoreboard had not confirmed until the
  retry landed.
- **Corrupt-data handling in history (ADAPT D1/F6, R-D1/F6):** a corrupt
  stored `sets` value hid a finalized result, while a corrupt session
  score with valid stored sets showed it unverified.

Fix: history verifies EVERY final row against the committed session
(session exists, not cancelled, final score at exactly the row's
revision; one GET each, bounded by the history limit — 50 GETs for 50
entries at N=50/200, the perf-suite bound). When stored sets are
unparseable the outcome is derived from the verified session score.
Statistics verifies only recently finalized rows (10-minute window:
covers prompt retries and the ~5-minute bounded DO alarm-recovery
window); older rows stay trusted with zero GETs, so stats N=50/200/500
stay at 0 GETs. A failed commit unretried past the window starts
counting again — a documented trade-off, not a silent one.
Future-dated `finalizedAt` values are never "recent" (production rows
are written with real now, so a future value marks a fixture/legacy
row, which stays trusted — migration 5d: an orphaned complete row
still counts in statistics), and an unparseable `finalizedAt` is
trusted the same way.

Measured perf impact: stats N=50/200/500 still 0 GETs; history N=50
and N=200 now cost 50 GETs for 50 entries (was 0; the perf test
asserts ≤50, still green). The §12-era claim "history N=200 is 0
GETs when all rows are final" is therefore stale — the cost is the
deliberate price of verifying history rows.

Tests: 6 new native tests in `pr22-stats-aggregation.test.ts` (5 failed
before the fix; the window trade-off test passed before by design).
Ported ADAPT S1/S3, ADAPT D1/F6, R-D1/F6 now pass in the matrix
re-run. Five pre-existing tests pinned the old behaviour and were
updated (see §10.4).

### 10.2 K05 × validation error fidelity (commit `310b097`)

A >64 KB series command body trips the room's K05 bound before
validation, and both action wrappers mapped any non-OK room response
to the generic "temporarily unavailable" message — fail-closed, but
the message invites a retry that can never succeed.

- `rallyCommandAction` + `schedulingAction` now surface the room's own
  400 body error (`'Invalid rally command request.'`) via the new
  `roomFailureFromResponse` helper, falling back to the generic message
  only when the body is not a well-formed room failure.
- `schedulingAction` pre-validates `createSeries` templates with
  `validateSeries` (the same validator the room uses) before the room
  hop, so oversized fields get the specific validation error (1 MB
  title → `'Use a title between 1 and 72 characters.'`). `editSeries`
  is NOT pre-validated: the room's host/active checks keep their error
  precedence there, and the 400 surfacing covers its oversized-body
  case. `createRallyAction` already pre-validates with zod +
  `validateSession`, so its room 400 is unreachable; untouched.

Tests: 2 new native tests in `rally-scheduling-command.test.ts` (both
failed before the fix). The ported adv-inputs oversized-title test now
passes in the matrix re-run.

### 10.3 Adversarial ports — poll option id cap + uniform markRead error (commit `87ff445`)

Both fixed on the PR #20 adversarial branch (`fb00b6d`, commit
`7a0d645`) but never ported to the PR #22 line:

- `validatePollOptions` now rejects non-string option ids and ids over
  200 chars (`POLL_MAX_OPTION_ID_LENGTH`) with the existing 'unique
  id' error, before any write; schema `maxLength` 2000/2000/200 on
  `polls.options`/`tally`/`finalizedOptionId` and 200 on
  `pollVotes.optionId` as the record-layer second line. A 10 KB option
  id is now rejected; the 100 KB case already was (at a different
  bound).
- `markRead` returns `'Notification not found.'` for both a nonexistent
  notification and another user's notification, closing the
  existence/ownership oracle (low severity; record ids are
  unguessable). The owner path is unchanged.

Tests: native unit test for the 200/201-char boundary plus 1 MB and
non-string ids (`src/lib/polls.test.ts`), native oracle test
(`notification-actions.test.ts`) — both failed before the fix. The
ported adv-inputs option-id ×2 and markRead tests now pass in the
matrix re-run.

### 10.4 Stale assertions updated (commit `674311f`)

The loader verification (§10.1) and the uniform markRead error (§10.3)
intentionally changed five pinned numbers and one error string; the
underlying entries/totals are unchanged:

- History now verifies every final row (1 GET each): the pending-row
  test goes 1 → 3 GETs, the disputed-rows test 0 → 1, the lifecycle
  final history read 1 → 4 total.
- Statistics now verifies freshly finalized rows: the lifecycle tests
  go 0 → 1 GET after a live finalization/re-finalization.
- Corrupt stored sets no longer drop the row from history: the entry
  is derived from the verified session score (ADAPT D1/F6).
- Migration 7c: a legacy markRead without `recipientId` now reports
  the uniform `'Notification not found.'` instead of the ownership
  string; the fail-closed behaviour (success false, `readAt`
  untouched) is unchanged.

### 10.5 Gate and matrix re-run (new tip `674311f`)

- Full gate, branch worktree: Vitest **366/366** (was 356/356; +10 new
  tests), tsc clean, eslint clean, vite build clean, node --test
  **34/34** (`tests/rally.test.mjs` + `tests/courts-games.test.mjs`).
- Matrix re-run, `fullstack/pr22-matrix/` worktree at detached
  `674311f` (ported files untracked, nothing committed there): full
  run **465 passed / 35 failed (500)** — 42 native files all pass; the
  5 failed files are all ported. Unique ported failures **24/110**
  (was 31/110): pr19-races 11 (unchanged, all harness drift),
  pr22-reconcile ADAPT 1/10 (F4/S4 only — visible-pending, owner
  decision), pr20-reconcile 2/10 (R-F4 visible-pending, R-S8 harness
  artifact), adv-inputs 4/38 (2 F7-decision, 2 drift), adv-bounds 6/28
  (unchanged, all expected/fix-working). Zero class-(a) defects remain
  in the ported suites. Logs: `fullstack/pr22-combined-verify/
  MATRIX-RERUN-{pr19-races,pr22-reconcile,pr20-reconcile,pr20-adv-inputs,pr20-adv-bounds,full}.log`.

### 10.6 Deliverables and caveats

- Branch: `feature/muse-pr22-combined-fixes` (was `e1e0d57` at the
  matrix run). New fix commits: `1bb7d17` loader verification,
  `310b097` K05 fidelity, `87ff445` adversarial ports, `674311f`
  stale-assertion updates (plus log commits after them).
- Bundle: `fullstack/pr22-combined-fixes.bundle`, regenerated at the
  final tip. The bundle SHA is deliberately NOT pinned here: pinning
  it in the branch log would move the tip with every correction and
  stale the bundle again. The deliverable SHA, patch count, and tip
  are recorded in `SPRINT_HANDOFF.md` §18 and in the delivery report.
  **Caveat:** each bundle-creation result failed an execution-risk
  check, so no bundle was re-processed afterwards — no independent
  re-verify, no fresh-clone import, no patch-apply check of the
  deliverable bundle. Those remain with the blocked fresh-clone
  verification (SPRINT_HANDOFF.md §15). The old bundle (`69e83ea9…`,
  tip `e1e0d57`) and old patches are now stale.
- Patches: `fullstack/pr22-combined-fixes-patches/`, regenerated
  cleanly from `e6ff2d9..HEAD` at the final tip (merges skipped by
  `format-patch`, as before); the count is in SPRINT_HANDOFF.md §18.
- Deliberately left as-is: the stats window trade-off (§10.1 — a failed
  commit unretried past 10 minutes starts counting; the alternative,
  reordering the finalization writes, would have required changing the
  early-return repair path and the notification emission, and risked
  the S3a repair behaviour — not worth it for a transient, self-healing
  window); the history GET cost (50 for 50 entries — the perf bound,
  not a regression); `editSeries` pre-validation (error precedence,
  §10.2).

Nothing was merged, deployed, pushed, or submitted; PR #21, PR #25,
and main untouched; no production data or credentials touched. No
GitHub push attempted (no credentials).

---

# Branch logs merged into this branch (appended at merge time)

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

---

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
