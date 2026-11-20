# Tracks E+F — Implementation log

Date: 2026-11-20 (evening, EST)
Branch: `feature/muse-social-matchmaking`
Base: `integration/rallycircle-muse-review` @ `2c2d24f93daf751108986a45cba1ccb5440044ec` (PR #12 head)
Worktree: `~/workspace/deepspace-interview-prep/fullstack/track-ef`
Scope: friends/followers/community (E01–E15) + smart match discovery/matchmaking (F01–F15).
Backend only. No profile collection created; no dependence on the parallel
Track B+C agent's unmerged work. Nothing merged, deployed, or submitted.

## What was built

### Schemas — `src/schemas/social-schema.ts`
Four new collections, all with member create/update/delete **false**
(server actions only). Registered in `src/schemas.ts`.

- `follows`: `followerId` (userBound) + `followeeId`, `uniqueOn` both.
  Member read `true` (public relationship between two ids; no private data).
- `blocks`: `blockerId` (userBound) + `blockedId`, `uniqueOn` both.
  Member read `'own'` only.
- `reports`: `reporterId` (userBound), `targetType` (`user|session|content`),
  `targetId` (maxLength 200), `reason` (maxLength 500), `status`
  (`open|reviewed|dismissed`, default `open`). Member read `'own'` only.
  **No moderator tooling exists yet; reports are stored, never actioned.**
- `discoveryPreferences`: `userId` (userBound, `uniqueOn`), `formats` /
  `days` as JSON text, `level`, `area` (maxLength 100), `radiusMiles`
  (1–100), `timeStart`/`timeEnd` (`HH:MM`, both-or-neither, start < end,
  no overnight). Member read `'own'` only.

### Pure logic — `src/lib/social.ts`
- `validatePreferences` / `decodePreferences` / `encodePreferences`:
  malformed stored data degrades to defaults, never throws.
- `pageByCreatedAt`: bounded newest-first pagination, `LIST_PAGE_WINDOW`
  = 200, cursor = `createdAt` of the last row.
- `derivePlayedWith`: shared sessions from RSVP `going` + finalized
  matches only (`resultStatus() === 'final'`); disputed/unconfirmed
  results never count; cancelled sessions excluded.
- `deriveActivityFeed`: public events only (`session-created`,
  `match-finalized`); cancelled excluded; blocked actors excluded;
  followed-only default. TODO noted: exclude private sessions if a
  private flag is ever added.
- `rankGames`: deterministic ranking (score desc, `startsAt` asc,
  `recordId` asc) with reason codes per result. Scoring: level-match +40,
  level-open +15, two-step level gap −30 (one-step gap neutral;
  `strictLevel` excludes two-step gaps), format-match +30 / format-other
  −10, nearby +20, area-match +15, time-match +10, day-match +5,
  needs-players +10, target-reached +5, session-full −15, doubles-ready
  +10 (going ≥ 4), followed-host +10. Time windows matched in **UTC** in
  v1 — documented limitation. Distance never fabricated (`null` when the
  court has no known coordinates).
- `buildFollowNotification`: pure draft payload for Track H; never
  persisted here (no notifications collection in this base).

### Server actions — `src/server/social-actions.ts` (13 actions)
Registered in `src/actions/index.ts` alongside `rallyCommand`. Every
handler derives the caller from the verified Bearer token; a
client-supplied `userId` in params is ignored.

- `followUser` (idempotent; 30/min rate limit; 500 total cap; duplicate-race
  re-read; returns the notification draft), `unfollowUser` (idempotent,
  deletes the row), `blockUser` (severs follows both directions via
  `deleteWhere`; vague `'This player is not available.'` error),
  `unblockUser` (idempotent; does not restore severed follows),
  `reportContent` (20/hour cap), `getFollowers` / `getFollowing` (cursor
  pagination, default 20 / max 50, `hidden: true` across a block),
  `getMutualFollows` (intersection, bounded 200 each),
  `getPlayedWith` (self or other; blocked players hidden),
  `getActivityFeed` (followed-only default; default 50 / max 100),
  `saveDiscoveryPreferences` / `getDiscoveryPreferences` (own record only),
  `discoverGames` (loads prefs + followed hosts + up to 200 open sessions
  + up to 500 RSVPs; `truncated` flag when a window is hit).
- Fail-closed: a failed `findOne` returns `undefined` so handlers treat
  query failure as "not found" rather than assuming a relationship exists.

### Client wrappers — `src/lib/social-actions.ts`
Typed wrappers for all 13 actions (`callSocialAction` with `getAuthToken`,
401 handling).

### Tests
- `src/lib/social.test.ts` — 14 tests (pure logic).
- `src/server/social-actions.test.ts` — 22 tests with an in-memory mock
  `ActionTools` harness (emulates userBound stamping, uniqueOn duplicate
  rejection, equality `where`, orderBy/limit, `deleteWhere`).
- `tests/social.test.mjs` — 7 Node headline tests.
- `scripts/social-bench.mjs` — synthetic benchmark (F12).

## Bugs found and fixed during this track (test errors, not shipped code)

1. Feed same-session event order follows insertion order
   (session-created before match-finalized) — test expectation corrected.
2. Level-gap demotion is −30 relative (matched score − 70), not
   absolute-negative — test expectation corrected.
3. Harness `seedSession` ignored its `recordId` argument — fixed to insert
   with the given id + optional createdAt.
4. Harness clock was faked to 2030 while handlers rate-limit against real
   `Date.now()` — fixed: harness clock tracks real time; total-cap seeds
   use createdAt `2020-01-01` so the per-minute limit does not fire first.
5. The 30/min rate-limit "recovery" step could not work via the harness
   clock (`advance()` cannot move real `Date.now()`). Split into two
   tests: rejection via live follows, recovery via 30 pre-aged seeds
   (createdAt = now − 61 s). The unused `advance` helper was removed.
6. `tsc` errors fixed: `tools.query<T>`/`tools.get<T>` generics take the
   **row data type**, not `QueryActionData<T>`/`GetActionData<T>` (SDK
   `ActionTools` in `deepspace@0.44.2`); `canUpdate`/`canDelete` take a
   record object, not `'own'`; `prefs.radiusMiles` possibly-undefined
   narrowing; `nextCursor: string | null` vs `string | undefined`.
7. Node test file fixes: Node's type stripper rejects inline `type`
   imports and `as const` / `as never` casts in `.mjs` files — removed
   them (values only). Also fixed a wrong test expectation: a one-step
   level gap is intentionally neutral (no `level-gap` reason); the test
   now uses a two-step gap.
8. `src/lib/social.ts` imports switched from `.js` to `.ts` extensions
   (matching `find-games.ts`) so Node's type-stripping runner can load it.

## Verification (full gate, 2026-11-20 ~22:04 EST)

| Check | Result |
| --- | --- |
| `node --test tests/*.test.mjs` | **36 passed, 0 failed** (baseline 29 + 7 new social tests) |
| `npx vitest run` | **139 passed, 0 failed** (19 files; baseline 103 + 36 new: 14 + 22) |
| `npx tsc --noEmit` | clean |
| `npx eslint .` | exit 0, no findings |
| `npm run build` (vite) | exit 0 |

Note: bare `node --test` (no path) also picks up `src/**/*.test.ts`
vitest files and fails on them — that is not the repo's gate; the gate
is `node --test tests/*.test.mjs`, as in the baseline.

## Performance (F12) — synthetic benchmark, `node scripts/social-bench.mjs`

Fixtures: 500 sessions, 1500 RSVPs, 480 open games. 20 runs each.

| Function | Median | p90 |
| --- | --- | --- |
| `rankGames` (480 games, prefs) | 8.85 ms | 67.29 ms |
| `derivePlayedWith` (500 sessions, 1500 RSVPs) | 0.47 ms | 3.21 ms |
| `deriveActivityFeed` (500 sessions, 40 followed) | 0.39 ms | 1.72 ms |

These are **synthetic in-memory timings only**, not production latency.
Server-side record queries add DO round-trips (bounded windows: 200
sessions / 500 RSVPs per `discoverGames` call). The rankGames p90 is
inflated by first-run JIT warmup; the median is the meaningful figure.

## E/F checklist coverage

- E01/E02 follow/unfollow keyed by verified identity, idempotent — done.
- E03 paginated lists (cursor, max 50) — done.
- E04 mutual follows — done (intersection, bounded).
- E05 played-with from actual match records — done (finalized only).
- E06/E07 public-only activity feed, followed-player visibility — done.
- E08 block semantics (documented in contracts doc) — done.
- E09 reporting, reporter-only reads, no moderator tooling yet — done.
- E10 anti-spam limits (30/min follows, 500 total, 20/hour reports) — done.
- E11 no private chat memberships / restricted sessions in public
  surfaces — done (and TODO noted for a future private-session flag).
- E12 bounded lists everywhere — done.
- E13 notification hook for Track H (draft only, nothing persisted) — done.
- E14 retention/deletion semantics + account-deletion boundary — done
  (documented; cascade itself needs an account-deletion flow).
- E15 integration tests (mutual actions, blocking, privacy, duplicates)
  — done (22 handler tests + 14 pure-logic tests).
- F01 structured preferences, self-reported only — done.
- F02/F10 ranking with reason codes + deterministic sort + fallback — done.
- F03/F04 skill compatibility on self-reported levels only; Track D
  rating never used — done.
- F05/F06 time matching on real dates/windows; geography on public court
  locations only — done (UTC limitation documented).
- F07/F08/F09 upcoming-only, capacity awareness, doubles readiness — done.
- F11 never fabricate nearby data — done (`distanceMiles: null` default).
- F12 performance measured — done (see above).
- F13 preferences are the owner's own record — done (documented).
- F14 typed discovery contracts for Codex — done (`docs/track-ef-contracts.md`).
- F15 tests: unknown locations, duplicate sessions, stale RSVP states,
  radius boundaries, unavailable external court data (mocked) — covered
  by the handler/pure-logic suites: unknown locations (distance null,
  no `nearby`), duplicate sessions (idempotent follow / deduped
  preferences), stale RSVPs (cancelled/past excluded), radius boundaries
  (1–100 validation; `nearby` only within radius). External court data
  is not fetched by this feature — court locations come from the existing
  integrated court data, so there is no external-court failure mode here.

## What remains unverified

- **Two-account browser tests**: `deepspace test run` needs test
  accounts; none exist in this environment. Handler behaviour is verified
  only via the in-memory mock harness.
- **Live worker / runtime verification**: no deploy was performed
  (forbidden by the mission). The actions have never run against a real
  Durable Object; the mock harness emulates the documented `ActionTools`
  contract, but platform-specific behaviour (userBound stamping,
  `deleteWhere` limits, uniqueOn enforcement) is taken from the SDK types
  and docs, not observed live.
- **Push / draft PR**: attempted 2026-11-20 ~22:08 EST — **blocked**.
  `git push -u origin feature/muse-social-matchmaking` failed with
  `fatal: could not read Username for 'https://github.com': No such
  device or address` (no GitHub credentials in this environment; no new
  credentials were set up). No draft PR exists. Preserved instead:
  verified Git bundle `fullstack/track-ef.bundle` (`git bundle verify`
  → "is okay"; head is the `feature/muse-social-matchmaking` tip,
  requires base `2c2d24f`) and per-commit
  patches in `fullstack/track-ef-patches/` (0001–0006). To publish:
  `git push origin feature/muse-social-matchmaking` from a machine with
  credentials, then open a draft PR targeting
  `integration/rallycircle-muse-review` (NOT main).
- **Integration with Track B+C profiles and Track H notifications**:
  both are parallel unmerged branches. The seams are documented in
  `docs/track-ef-contracts.md`; no code depends on them.

## Limitations / conflicts

- No profile collection: display names degrade to user ids.
- No notifications collection: follow notifications are drafts for
  Track H.
- Time windows match in UTC (v1).
- Discovery is bounded (200 sessions / 500 RSVPs, `truncated` flag).
- `getPlayedWith` for another user is allowed by design (public match
  records); gate it in the handler if product wants self-only.
- Level data is self-reported; never present it as verified skill.
- The `discoverGames` handler reads sessions with `status: 'open'` and
  RSVPs in bounded windows; a very large community would see `truncated`
  results until discovery pagination lands.
- No conflicts with the base: `find-games.ts` is untouched; only
  `src/schemas.ts` and `src/actions/index.ts` gained additive registrations.
