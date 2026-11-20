# IMPLEMENTATION_LOG.md — Session capacity & waitlists

Branch: `feature/session-capacity-waitlist`, base `8fd8c2c` (PR #2 tip).
Worktree: `~/workspace/deepspace-interview-prep/fullstack/capacity`
(worktree created from the existing local copy
`review-ready-to-play` with `git worktree add … 8fd8c2c`; no repo
re-clone, `repo.git` untouched. `node_modules` is a symlink to the
review copy's install. No production identity, credentials, deploy,
merge, or push to shared branches.)

## Design verification (before writing code)

- `records.delete` and `records.deleteWhere` exist in the installed SDK
  (`node_modules/deepspace/dist/worker.js:2795, 2812`).
- `records.query` supports `orderBy`/`orderDir`, and query results
  carry `createdAt` (`worker.d.ts:1053-1054`, `RecordResult` with
  `createdAt`). The implementation still sorts waitlist rows in code
  (`sortWaitlistRows`, FIFO by `(createdAt, recordId)`) rather than
  relying on query ordering.
- `userBound` columns are stamped from the tool call's `userId` argument
  (`worker.js:1543-1545`) — this is why promotion creates the waiter's
  RSVP with that argument.
- `X-App-Action` tool calls are RBAC-off by design (`worker.js:2879`,
  "the app's own server-side code, which is already the trust boundary")
  — the command room can create/delete rows for other users; the
  `rallyCommand` action is the only auth boundary.
- Schemas are registered in `src/schemas.ts` (added `waitlistsSchema`
  there); `RecordData` includes `createdAt` (`index.d.ts:2199`).

## Commits

| commit | change |
|---|---|
| `a586b5f` | Route RSVP withdraw through the serialised rally command room (prerequisite; idempotent, valid on cancelled sessions) |
| `e578e68` | Additive schema: `capacityMode` / `maxPlayers` on sessions, new `waitlists` collection, `resolveCapacity` + FIFO helpers + client validation |
| `3f195e1` | Command room: capacity gate (`SESSION_FULL`), `joinWaitlist` / `leaveWaitlist`, automatic FIFO promotion, stale-row self-healing; 11 new command-room tests + schema assertions + 4 node tests |
| `24feba4` | UI: create-session capacity controls, `CapacityPanel`, full-state list badges |

## Test evidence (run in this worktree, Node v24.22.1, deepspace@0.44.2)

Baseline at `8fd8c2c` (before changes): `node --test` 16/16,
vitest 10/10, `tsc --noEmit` clean.

Final, after all four commits (2026-11-20 ~19:39 EST):

- `node --test tests/rally.test.mjs` — **20/20 pass** (16 baseline + 4
  capacity helper/validation tests).
- `npx vitest run` — **23/23 pass across 4 files** (10 baseline +
  2 withdraw + 11 capacity; command-room file alone 18/18).
- `npx tsc --noEmit` — clean.
- `npm run lint` (full `eslint .`) — clean.
- `npm run build` — passes (`✓ 857 modules transformed`, `✓ built in
  6.14s`; prerender build `✓ 2077 modules transformed`, `✓ built in
  5.25s`).
- Capacity cases covered: boundary (cap 2, third join gets
  `SESSION_FULL`), malformed stored cap treated as open (99 and 1),
  open-mode regression (5 going past a target of 4), idempotent
  join/leave, rejoin at the back, withdraw promotes only the earliest
  waiter, going→maybe promotes, cancel closes joins/RSVPs and leaves
  rows inert, 5-way concurrent joins (exactly 2 succeed, 3 get
  `SESSION_FULL`, no overbooking), stale-row self-healing, withdraw on a
  cancelled session.

Two environment notes, not code defects:

- The `tsc` run during commit 2 was interrupted by a service restart
  mid-command; the commit had not landed, the working tree was intact,
  and the commit was re-run cleanly afterwards (`e578e68`).
- The first `vitest` run after adding the capacity tests failed to
  parse (`}` expected) because the new `describe` block was missing its
  closing `})`; fixed, no test logic changed.

## Not verified

- **Two-account browser tests (`deepspace test run` / Playwright).**
  `npx deepspace auth whoami` in this environment returns
  `not_authenticated` ("Not logged in on production"), and no test
  accounts exist here. No credentials were used or created. The
  command-room behaviour is verified by the mock-harness vitest suite
  above (including the concurrent-join and promotion cases), but the
  live two-browser flow — create limited session, third player sees
  "Session full", withdraw promotes without refresh — has **not** been
  run. Javier should run it before demo day.
- **Live deployment.** Nothing was deployed; the build was verified
  locally only.
- **Merge with sibling branches.** See CAPACITY_README.md "Conflicts":
  `feature/match-scoreboard` will conflict textually in
  `rally-command-room.ts` / its test / `schemas.ts` / `rallies.tsx`;
  `feature/live-courtboard` likely merges cleanly.

## Credentials scan

No secrets added: `git diff 8fd8c2c...HEAD --stat` touches only the 9
files listed in CAPACITY_README.md (components, lib, pages, schemas,
server, tests). No `.env`, tokens, or keys in the diff.
