# Track D — Implementation log (APPLIED)

## Status

**APPLIED AND VERIFIED.** Branch `feature/muse-rating`, base
`integration/rallycircle-muse-review` @ `2c2d24f`, worktree
`~/workspace/deepspace-interview-prep/fullstack/track-d`.

A previous attempt staged this package but stopped before applying because a
runtime execution-risk check flagged the `git worktree add` step. The user
has since explicitly authorized this work (mission Safety Restrictions:
create isolated worktrees, implement and test new features, commit
development code, save Git bundles, push review branches through existing
authorized access — all within isolated local development worktrees only).
This apply step ran inside that authorization. No deploy, merge, app-ID
change, production accounts/data, paid services, or Codex/Copilot frontend
work was touched.

## What was applied

From `~/workspace/deepspace-interview-prep/fullstack/track-d-draft/`:

1. Pure engine `src/lib/rating.ts` + `src/lib/rating.test.ts` (19 Vitest
   tests) + `tests/rating.test.mjs` (8 Node tests) — copied verbatim.
2. Store layer `src/server/rating-records.ts` + `src/server/rating-records.test.ts`
   (9 Vitest tests) — copied verbatim.
3. `docs/RATING_SPEC.md` + `docs/track-d-contracts.md` — copied verbatim
   (the base has no `docs/` directory, so it was created).
4. `PATCHES.md` step 1 — schema registration in `src/schemas.ts` (two new
   additive collections, no existing collection changed).
5. `PATCHES.md` step 2 — rating trigger in `src/server/rally-command-room.ts`,
   adapted to the code as it stands: after the session `matchScore` update
   succeeds in `applyScoreEdit`, a `reviewResult` that makes the result
   final calls `applyRatingsForFinalResult` (best-effort, try/catch +
   error-logging; a rating failure can never fail the review). Runs inside
   the same serialized command-room invocation.
6. Two new trigger tests in `src/server/rally-command-room.test.ts` plus
   harness support for the `playerRatings`/`ratingChanges` collections
   (query/create/update) and a `failRatingWrites()` fault-injection hook.

## Grounding verified against the base (not assumed)

- `resultStatus()` is `'final'` only with a winner and every player approved
  (`src/lib/rally-score.ts`); `reviewResult()` enforces participant-only
  review with no duplicate approvals — verified by reading, and by the
  pre-existing finalization test.
- Scores live as JSON in `sessions.matchScore`; formats
  `Singles/Doubles/Practice`; all score writes go through the serialized
  per-session command room with identity from the verified action user.
- No statistics module, no ratings, and no finalized-results query API
  existed in the base — `finalizedResultsFromSessions` is the minimal read
  helper (shared dependency for Track C).
- Schema columns are number|text only (provisional stored as 0/1,
  opponentIds as JSON text) — matches the installed SDK's `schema.d.ts`.
- The room's record tool forwards the per-call userId via `X-User-Id` with
  `X-App-Action`, structurally identical to `RatingRecordTool`, so the
  applier's per-player `records.create` calls stamp `userBound` playerId
  columns the same way the existing promotion path does.

## Verification (all executed — exact counts)

Baseline before applying (worktree, commit `2c2d24f`):
- `node --test tests/*.test.mjs` — **29/29**
- `npx vitest run` — **103/103** (17 files)
- `npx tsc --noEmit` — clean

After applying (branch `feature/muse-rating`):
- `node --test tests/*.test.mjs` — **37/37** (29 baseline + 8 new rating)
- `npx vitest run` — **133/133** (19 files: 103 baseline + 19 engine +
  9 store + 2 new trigger tests)
- `npx tsc --noEmit` — clean
- `npm run lint` — clean
- `npm run build` — passes

Hand-computed examples verified by the tests (not by trust):
- Equal new players: +20 / −20 (K 40 × 0.5).
- 1220 beats 1400: +30 / −30 (E ≈ 0.262).
- 1600 beats 1200 (K 24): +2 / −2.
- Doubles team means 1225 vs 1275: Ana +21, Dan +24.
- Four straight wins vs the same opponent: +20, +18, +16, then K halved
  → +7; final rating 1261.
- Reversal after a second match: 1238 − 20 = 1218 (not 1200).

## Fixes/changes made while applying

- None to the staged engine or store code: all draft files copied verbatim
  and passed on first run.
- `docs/` directory did not exist in the base; created it for the spec and
  contracts.
- The trigger sketch from `PATCHES.md` was adapted (not pasted blindly):
  the success path in `applyScoreEdit` was restructured to an early return
  on failure, then the best-effort rating call, then the success return.
  The sketch's `tool`/`systemUserId` notes were verified against the
  actual `RecordTool` type and the room's `X-App-Action` plumbing.
- Harness extension (mock `playerRatings`/`ratingChanges`) was new work
  needed for the trigger tests; the draft's expected counts did not include
  the 2 trigger tests.

## What remains unverified

- **Two-account tests:** `npx deepspace auth whoami` → `not_authenticated`
  in this environment; no credentials were created or used. A live
  two-account finalization → rating update observation needs test accounts.
- **Live direct-write denial** for the rating collections (asserted via the
  schema permissions in code, not a live direct-write attempt).
- **Additive migration against pre-existing data:** the two new collections
  change no existing collection, but an actual upgrade against live data
  still needs validation in an authorized test environment before any
  release (per the integration handoff).
- **No correction workflow exists in the base**, so `reverseRatingEffect`
  is defined and unit-tested but has no caller yet (Track C).

## Known limitations (also in docs/RATING_SPEC.md)

- Repeat-opponent counting reads at most the 100 most recent change
  records per player; a player with >100 rated matches in a format may
  undercount repeats (K dampening only — never a rating error).
- `finalizedResultsFromSessions` scans session records; fine at current
  scale, needs indexing if volume grows (Track C).
- Ratings are experimental and never authoritative in the release
  candidate; every `playerRatings` row carries `status: 'experimental'`.
- Residual collusion risk is stated honestly in the spec; mitigations are
  repeat-opponent K dampening, provisional labelling, and confirmed-RSVP
  participation only.

## Publication

Push attempted only with existing auth; if blocked, the branch is preserved
as a verified git bundle at
`~/workspace/deepspace-interview-prep/fullstack/track-d.bundle` plus
per-commit patches. Draft PR target: `integration/rallycircle-muse-review`.
