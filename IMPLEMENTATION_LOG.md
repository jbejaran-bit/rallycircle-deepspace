# IMPLEMENTATION_LOG.md — Tracks B + C applied (profiles, confirmed results, statistics)

**Date:** 2026-11-20. **Base:** `integration/rallycircle-muse-review` @ `2c2d24f`.
**Branch:** `feature/muse-profiles-results`. **Source:** staged package at
`~/workspace/deepspace-interview-prep/fullstack/track-bc-staging/` (APPLY.md
followed exactly; see below for the deviations/fixes the gate forced).

## 0. Baseline (fresh worktree, before applying)

- `node --test tests/rally.test.mjs` — **19/19 pass**
- `npx vitest run` — **103/103 pass** (note: the integration handoff's "51
  Vitest" figure is stale; the branch at `2c2d24f` actually carries 103)
- `npx tsc --noEmit` — clean (verified after applying; baseline was not
  re-run separately, but the branch was green per the integration docs)

## 1. What was applied

Copied verbatim from the staging package (15 new files + `docs/track-bc-contracts.md`),
replaced `src/lib/rally-score.ts` wholesale, and applied the APPLY.md §3–§6
edit blocks to `src/schemas.ts`, `src/actions/index.ts`,
`src/server/rally-command-room.ts` (5 edits: imports, sets/winner forwarding,
finalization hook on the final transition, `correctResult` branch, audit
writes after save), and `src/lib/rally-actions.ts` (client `correctResult`
union member). All edit blocks matched the base verbatim on first attempt.

One deviation from the staging layout: the repo has no `docs/` directory at
its root (docs live as `.md` files at the root), so `docs/` was created for
`docs/track-bc-contracts.md`.

## 2. Fixes the gate forced (all honest, recorded here)

### 2a. Compile errors (6) — fixed at apply time

1. `src/components/RallyScoreboard.tsx` — `resultLabels` had no entry for
   the new `'corrected'` status. Added `corrected: 'Corrected result'`.
2. `src/lib/profile.test.ts` — the `valid` fixture was `as const`, making
   `formats` readonly against mutable `ProfileInput`. Typed it
   `const valid: ProfileInput = {...}`.
3. `src/server/profile-actions.ts` — `tools.query<PlayerProfile>` violates
   the `ActionTools.query<T extends Record<string, unknown>>` constraint
   (no index signature). Changed to `tools.query<Record<string, unknown>>`;
   the existing cast to `StoredProfileRow[]` is unchanged.
4. `src/server/profile-permissions.test.ts` (2 sites) — SDK `canRead` types
   `userId: string`; the signed-out caller is `null` at runtime. Cast
   `null as unknown as string` with the existing explanatory comment kept.
5. `src/server/rally-command-room.ts` — `correctResult` was not routed to
   `applyScoreEdit`, so the fallthrough `applyAttendance` call failed to
   type-check. Added `|| command.operation === 'correctResult'` to the
   score-edit dispatch condition.
6. `src/server/result-finalization.ts` — imports pointed at `./profile.js`
   / `./match-stats.js`; the modules live in `../lib/`. Fixed both paths.

### 2b. Vitest failures (3 of 140) — two real bugs, one test-data bug

All three were caught by the new tests, not by inspection:

1. **`resultStatus` ordering (real bug, `src/lib/rally-score.ts`).** A
   corrected result with one approval reported `'corrected'` instead of
   `'confirmed'`. The `'corrected'` check ran before the approvals check.
   Fixed by reordering: `final` → `confirmed` (any approval) → `corrected`
   (zero approvals, previously corrected) → `proposed`. This matches the
   existing meaning of `'confirmed'` = partially confirmed (cf. the
   scoreboard label "Partially confirmed result"). Re-finalization still
   yields `'final'`; `reviewResult` still accepts `'corrected'`.
2. **Visibility sync skipped (real bug, `src/server/profile-actions.ts`).**
   `updateProfileAction` read `existing.data.visibility` AFTER
   `tools.update(...)` to decide whether to sync owned stats/results
   rows. The looked-up row object aliases live storage in the in-memory
   harness (mock `update` does `Object.assign(row.data, ...)`), so by
   decision time it already held the NEW value and the sync was skipped.
   In production, query responses are fresh deserialized objects, so the
   aliasing would not occur — but the code was fragile either way. Fixed
   by capturing `previousVisibility` BEFORE the update and comparing
   against that. Verified by the previously failing test plus the
   delete-profile privatization test.
3. **Test-data bug (`src/lib/rally-score-corrections.test.ts`).** The
   "three-set win for side 1" case `[[6,7],[7,6],[6,4]]` winner 1 only has
   side 1 winning ONE set (side 0 wins sets 2 and 3), contradicting the
   documented "winner won exactly two sets" rule. The validator was right;
   the fixture was wrong. Replaced with `[[6,7],[7,5],[4,6]]` winner 1
   (side 1 wins sets 1 and 3, all sets valid).

## 3. Verification (full gate, all executed on the committed tree)

- `npx tsc --noEmit` — **clean**
- `npx vitest run` — **140/140 pass, 23 files** (103 baseline + 37 new:
  profile 9, match-stats 5, rally-score-corrections 6, profile-actions 8,
  result-finalization 6, profile-permissions 3)
- `node --test tests/rally.test.mjs` — **19/19 pass** (no new Node test files)
- `npm run lint` — **clean**
- `npm run build` — **passes** (✓ built in ~10 s)
- `tests/profiles-results.spec.ts` — **not run**: two-account Playwright
  spec skips without `RALLYCIRCLE_TEST_ACCOUNTS=1`; no test accounts exist
  here and none were created. Its test bodies are placeholders pending the
  Codex profile UI (stated in the spec header). Two-account behaviour is
  **unverified**.

## 4. Applier risks from the staging log — disposition

- `records.query` `orderBy: 'finalizedAt'` in `getMatchHistory`
  (`src/server/profile-actions.ts:246`): the vitest mock harness implements
  ordering, so the tests pass, but **live RecordRoom support for ordering
  by a datetime column is unverified** — the verified precedent is ordering
  by `createdAt` in the command room. If the live room rejects it, fall
  back to ordering in the handler. Flagged for the authorized-environment
  check.
- JSON-column round-tripping (`formats` array, `sets`): covered by the
  mock harness only; live RecordRoom round-trip is **unverified** (the
  scoreboard's JSON `sets` column is the precedent, but confirm for these
  columns in the authorized environment).
- `getMatchHistory` parses `sets` with `JSON.parse` without a guard — a
  corrupt row would throw inside the action. Rows are written only by the
  command room, so corruption requires a storage fault; noted, not
  additionally guarded (same judgement as the staging author).

## 5. What this delivers

- **Track B:** `profiles` collection (display name ≤40, bio ≤280, formats,
  preferred area, self-reported level, visibility public/private); identity
  always the verified auth identity; private data never enters the
  collection; `visibilityField` + `read: 'published'` record-layer privacy;
  no profile = no public presence; coordinates rejected; idempotent
  re-save; visibility synced to owned stats/results rows; profile
  completeness metadata (0–100 in steps of 20 + missing fields) for Codex.
- **Track C:** `'corrected'` result state + host-only `correctResult`
  (final/disputed only, complete corrected scoreline validated); corrections
  reset approvals, bump revision, superseded outcome survives only in a
  `'corrected'` audit row; incremental per-format `playerStats`
  (provisional below 5 matches); `matchResults` (one row per player per
  finalized result); `resultAudits`; only finalized results count — disputed
  results never touch stats, practice never counts, singles/doubles strictly
  separate; idempotent finalization with reconcile repair.
- Typed contracts for Codex: `docs/track-bc-contracts.md`.

## 6. Known limitations / conflicts

- Two-account browser tests unverified (no accounts here).
- Live `orderBy` / JSON round-trip unverified (see §4).
- No rating engine here (Track D is separate); `selfReportedLevel` is
  labelled self-reported everywhere.
- `rally-command-room.ts` edits touch the same function other backend
  tracks extend (polls, notifications) — finalization hooks are the single
  call sites; do not duplicate stats logic into other modules.
- No conflict with Codex/Copilot frontend work (backend only; the one UI
  touch is the single `resultLabels` line in `RallyScoreboard.tsx`).
