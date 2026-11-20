# Tracks I + J — Implementation log

Branch: `feature/muse-groups-tournaments` off `integration/rallycircle-muse-review` @ `2c2d24f`.
Worktree: `~/workspace/deepspace-interview-prep/fullstack/track-ij`.
Contracts for Codex: `docs/track-ij-contracts.md`.

## Baseline (verified before any change)

- `node --test tests/rally.test.mjs tests/courts-games.test.mjs` — **29/29**
- `npx vitest run` — **103/103, 17 files**
- `tsc --noEmit`, `npm run lint`, `npm run build` — clean / clean / passes

## What was built

### Track I — Groups / clubs

- `src/lib/groups.ts` — pure validation + role helpers + pagination cursor.
- `src/schemas/groups-schema.ts` — `groups` (visibilityField + `read:
  'published'`: public rows readable by any member, private rows by the
  host only) and `groupMembers` (`read: 'own'`, `uniqueOn:
  [groupId, userId]`). Direct client writes closed for every role on both.
- `src/server/group-actions.ts` — the `groups` action (11 operations:
  create/list/get/join/leave/listMembers/createGroupSession/promote/
  remove/transfer/close). All checks run against the verified auth
  identity; `tools.*` are RBAC-off so ownership is checked by hand.
- `src/schemas/rally-schema.ts` — additive `groupId` column on sessions
  (default `''`), deliberately NOT in member/admin `writableFields`.
- `src/server/rally-command-room.ts` — group-session RSVP gate in
  `applyAttendance`: non-members get `'Only group members can respond to
  this session.'`; the host counts as a member; `withdraw` /
  `leaveWaitlist` stay open so a removed member can always clean up.

### Track J — Tournaments / leagues (singles only, v1)

- `src/lib/tournaments.ts` — pure deterministic fixture generation
  (circle-method round-robin; standard-seeding single elimination with
  `seedingOrder`), bracket progression (`nextRoundPairings`), and
  standings from finalized results only (wins → set diff → game diff →
  player id).
- `src/schemas/tournaments-schema.ts` — `tournaments`,
  `tournamentPlayers`, `tournamentMatches` (`uniqueOn: [tournamentId,
  round, slot]`). Direct client writes closed for every role.
- `src/server/tournament-actions.ts` — the `tournaments` action (11
  operations: create/add/remove/start/schedule/advance/sync/cancel/
  get/getStandings). Matches are ordinary Singles sessions scored through
  the existing scoreboard flow; `syncTournament` derives winners only
  from genuinely finalized results.

### Shared

- `src/schemas.ts` — registers the five new collections.
- `src/actions/index.ts` — registers `groups` and `tournaments`.
- `src/server/action-test-harness.ts` — in-memory mock `ActionTools`
  (userBound stamping, deterministic-id upsert, equality `where`,
  `orderBy`/`limit`, bounded `deleteWhere`, monotonic `createdAt`).

## Verification — full gate, all executed

- `node --test tests/rally.test.mjs tests/courts-games.test.mjs` — **29/29**
- `npx vitest run` — **148/148, 21 files** (103 baseline + 45 new)
  - `src/lib/groups.test.ts` — 7
  - `src/lib/tournaments.test.ts` — 17 (incl. seeding order)
  - `src/server/group-actions.test.ts` — 12
  - `src/server/tournament-actions.test.ts` — 8
  - `src/server/rally-command-room.test.ts` — 12 (was 11; +1 group-gate test)
- `npx tsc --noEmit` — clean
- `npm run lint` — clean
- `npm run build` — passes
- `npm run test:public` — **14/14** (public Chromium)

## Bugs the tests caught (all fixed in the branch)

1. **Mock record-id collision (harness):** the mock's id counter was
   per-tools-instance, so a second action call reused ids and overwrote
   the host's membership row. Fixed with a module-level counter.
2. **Missing schema defaults in the mock:** the mock does not apply
   column defaults, so `group.status` read as `undefined` and joins were
   refused as "closed". Fixed by normalizing defaulted columns on load
   (`status ?? 'open'` / `'created'` / `'pending'` / `'active'`) — this
   is also safer in production for rows predating a column.
3. **Pagination cursor excluded its own record:** the `beforeCreatedAt`
   cursor pointed at the first unreturned row, but the skip condition
   excluded it. Fixed to an inclusive cursor (skip only strictly newer
   rows); the `beforeRecordId` tiebreak was removed because the SDK
   query exposes a single `orderBy` and cannot order ties
   deterministically. Rows sharing a millisecond timestamp may repeat
   at a page boundary; documented in the contracts.
4. **Single-elimination bracket put the top seeds together (real design
   bug):** the first-round generator emitted all byes first, so pairing
   winners in slot order matched seed 1 against seed 2 in round 2.
   Fixed with standard seeding order (for 8: 1, 8, 4, 5, 2, 7, 3, 6) so
   byes sit in their proper bracket positions.
5. **Premature tournament completion (real bug):** `syncTournament`
   completed the tournament when every *existing* match was final — in
   single elimination the next round does not exist until `advanceRound`
   creates it, so syncing after round 1 would have completed the
   tournament. Fixed by requiring the full fixture count (round-robin
   n(n−1)/2; single elimination n−1).
6. **Standings test expectation wrong, not the code:** two tied players
   rank by game difference before player id, per the documented
   tiebreakers; the test was corrected.

## What remains unverified / limitations

- **Live RecordRoom behaviour:** `visibilityField` + `read: 'published'`
  on groups, `read: 'own'` on groupMembers, `uniqueOn` enforcement on
  the new collections, deterministic-id upsert semantics on
  `records.create`, `orderBy: 'createdAt'` on the new collections, and
  JSON-in-text round trips — all mock-harness only. Needs an authorized
  developer session / test app.
- **Two-account tests:** `npx deepspace auth whoami` → `not_authenticated`;
  no credentials created or used. No Playwright spec was added for these
  tracks (the existing two-account specs need accounts that do not exist
  here); group/tournament flows have no browser coverage yet.
- **Additive migration against pre-existing data** still needs validation
  in an authorized test environment before any release (no existing
  collection changed except the additive `groupId` column on sessions).
- **Group-session privacy is action-layer + UI, not record-layer:**
  RecordRoom permissions cannot express "member of group X" (the SDK's
  own messaging schemas note the same limit). A determined member could
  read a group session's raw row; non-members are blocked from RSVP and
  the UI must hide group sessions from them. Documented in the contracts.
- **No notification on member removal / tournament events:** the in-app
  notification system lives on a separate branch; this action emits none.
- **Mid-tournament withdrawal is not supported:** players can only be
  removed while `created`. A withdrawn player's future matches stay
  `pending` and block completion; the host's remedy today is
  `cancelTournament`.
- **Tournaments are singles only** in v1; no self-registration; no
  tournament waitlist; `syncTournament` is host-only and explicit (no
  background job).
- **Conflicts:** none with Codex/Copilot frontend work (backend only; no
  UI files touched). `rally-command-room.ts` gains one membership check
  in `applyAttendance`; other backend tracks extending the same file
  (polls, notifications) must keep that gate. The `groups` /
  `tournaments` action names are new and do not collide with existing
  actions.
