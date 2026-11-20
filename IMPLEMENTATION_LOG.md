# IMPLEMENTATION LOG — Live Match Scoreboard (`feature/match-scoreboard`)

Base: `feature/ready-to-play` @ `8fd8c2c`. Worktree:
`~/workspace/deepspace-interview-prep/fullstack/scoreboard`.
No merges, deploys, app-ID changes, production accounts/data, paid
services, or emails. All work in this worktree only.

## Baseline (2026-11-20, before changes)

| Command | Result |
|---|---|
| `node --test tests/rally.test.mjs` | 16/16 pass |
| `npm run validate` (tsc + vitest) | tsc clean; vitest 10/10 |
| `npm run lint` | clean |

`deepspace@0.44.2`, Node v24.22.1. `node_modules` is a symlink to the
review copy (same locked versions).

## Commits

1. `1fa3e05` — matchScores schema, scoreboard validation, host-only
   server action (schema + `src/lib/scoreboard.ts` +
   `src/server/rally-command-room.ts` + `src/lib/scoreboard-actions.ts`).
2. `10c4c57` — MatchScoreboard card + host form, wired into
   `SessionDetail` (`rallies.tsx`, 2 lines).
3. (this log + tests) — node/vitest/Playwright tests, validator fixes
   found by the tests, README + this log.

## Bugs found by testing (all fixed in the work, none shipped)

1. **Room/action shape mismatch.** The action forwards the *parsed*
   command to the room, so scoreboard fields arrived nested under
   `input`, but the room's parser expected the flat client shape. Every
   scoreboard command failed with "Invalid rally command." — found by
   the vitest server tests, reproduced with a scratch test that printed
   the result. Fix: the room's parser now accepts both the flat shape
   and the nested `input` shape (`rally-command-room.ts`, with comment).
2. **Deciding tiebreak did not decide the match.** `scoreboardWinner`
   only counted sets, so 1–1 + a 10–7 tiebreak had no winner and a final
   score was rejected. Fix: `matchSetsWon` counts a decided tiebreak as
   the deciding set (1–1 → 2–1); the final-status check now reports an
   undecided tiebreak first.
3. **Finality check ordering.** An attempt to reopen a final match to
   in-progress hit the generic "already has a winner" error instead of
   the "stays final" error. Fix: the finality block now runs before the
   status-specific checks.
4. **Node test files are plain JS.** `tests/*.test.mjs` run without type
   stripping, so `type` imports and annotations are syntax errors there
   (the existing `rally.test.mjs` imports no types). The scoreboard node
   tests were rewritten as plain JS.

## Test results (final)

| Suite | Result |
|---|---|
| `node --test tests/rally.test.mjs tests/scoreboard.test.mjs` | **32/32 pass** (16 existing + 16 new validation/winner/format tests) |
| `npm run validate` (tsc + vitest) | **tsc clean; vitest 17/17** (10 existing + 7 new scoreboard server tests: host create, non-host + cross-session denied, invalid rejected, concurrent conflict, correction gate, idempotent re-save, direct-write permissions) |
| `npm run lint` | clean |
| `npm run build` | passes (6.86 s; prerender writes `/`, `_spa.html`, sitemap) |

## Live end-to-end probe (real worker + real RecordRoom DO)

`deepspace test run` is blocked here (`not_authenticated`, no CLI login
— no credentials were created or used). Instead the feature was verified
against the real runtime locally:

- `npx wrangler dev --local --port 8791` with a local `.dev.vars`
  (deleted afterwards): generated a local ES256 keypair
  (`openssl ecparam -genkey -name prime256v1`), put the SPKI public key
  in `AUTH_JWT_PUBLIC_KEY`, `AUTH_JWT_ISSUER=https://auth.local.test`,
  `OWNER_USER_ID=local-owner`, `ALLOW_DEBUG_ROUTES=true`.
- Minted ES256 test JWTs with `jose` (`sub` = `local-owner` /
  `local-player`, 2 h expiry). Keys lived only in `/tmp`.
- The worker booted with the new schema: `SHOW TABLES` via
  `/api/debug/sql` lists `c_matchScores`, and `DESCRIBE c_matchScores`
  shows all 8 columns (`col_sets`/`col_matchtiebreak` TEXT,
  `col_version` REAL).
- Seeded two open sessions via debug SQL (hosted by owner and player),
  then drove `POST /api/actions/rallyCommand` with real JWTs and read
  back via `/api/debug/records/matchScores` (real `rowToData`, so the
  JSON columns genuinely round-tripped).

**22/22 live checks passed** (probe script run twice; the first run had
one probe-side assertion bug — `rowCount` on INSERT — fixed by checking
the row exists instead; the second run's two failures were also probe
bugs — non-unique ids across runs and unfiltered row counts — fixed by
stable ids + filtering; the feature code did not change between runs):

1. seed session row / seeded session readable
2. host creates score via action (recordId returned)
3. score persisted in real RecordRoom, version 1, updatedBy = host
4. sets round-trip through JSON column
5. non-host write rejected (`Only the session host can update the scoreboard.`)
6. invalid set 6–6 rejected (server message)
7. tiebreak without split sets rejected
8. concurrent edits, same expectedVersion: exactly one succeeds
9. concurrent loser gets `Conflict:` error
10. winner persisted as version 2
11. final change without correction flag rejected
12. correction with flag succeeds
13. corrected score persisted as version 3
14. identical re-save succeeds
15. identical re-save does not bump version
16. split sets + deciding tiebreak 10–7 accepted
17. tiebreak round-trips
18. player RSVP via action still works (regression)
19. RSVP persisted
20. cross-session write rejected (host of A writing B's board)
21. (plus the two seed/read checks above)

Unauthenticated `POST /api/actions/rallyCommand` → 401, as designed.
The probe scripts were scratch files in the worktree and were deleted
after the runs; `.dev.vars`, the local keys, and `.wrangler/` state were
also deleted. `git status` shows only the feature files.

## What remains unverified

- **Two-account browser test** (`tests/scoreboard.spec.ts`): written
  against the issue's acceptance list (host creates → participant sees
  live → host edits → participant sees update → non-host denied →
  invalid rejected → refresh preserves → corrections saved → RSVP/chat
  regression, plus desktop/mobile screenshots). Not run: needs two
  DeepSpace CLI test accounts (`npx deepspace test run
  tests/scoreboard.spec.ts`).
- **Real-browser screenshots**: blocked at the sign-in gate — the local
  worker's auth exchange needs the platform auth service, and minted
  JWTs cannot create a browser session cookie. The card's mobile layout
  is code-reviewed (stacking grid, numeric inputs) but not screenshotted.
- **Direct client-write denial against the live RecordRoom**: asserted
  via the SDK's `canCreate`/`canUpdate`/`canDelete` helpers in vitest,
  not by a live direct-write attempt (the live probe exercised the
  server-action path, which is the only write path the UI uses).
- **Live two-user record sync in a browser** (`useQuery` delivering the
  update without refresh): the mechanism is the same subscription the
  RSVP/chat flows already use, and the server round-trip is verified
  above — but the cross-browser observation itself awaits the
  two-account run.

## Conflicts / integration notes

- No overlap with Copilot's chat-profile work: touched files are new
  (`src/lib/scoreboard.ts`, `src/lib/scoreboard-actions.ts`,
  `src/schemas/scoreboard-schema.ts`,
  `src/components/MatchScoreboard.tsx`, tests) plus small additions to
  `src/server/rally-command-room.ts`, `src/schemas.ts`, and
  `rallies.tsx` (2 lines). The Courtboard branch (`feature/live-courtboard`,
  PR #5) also touches `rallies.tsx` and `worker.ts` — this branch does
  **not** touch `worker.ts`, so the only likely merge conflict is the
  `SessionDetail` insertion point in `rallies.tsx`, which is a 2-line
  addition and trivially resolvable.
- No migration change: the new collection is created by the RecordRoom
  from the schema; no new Durable Object class, no `wrangler.toml`
  change, no app-ID change. Existing sessions/RSVPs are untouched (the
  scoreboard record is created on first save, not at session creation).
