# Tracks G + H — Implementation Log (APPLIED + VERIFIED)

**Status: APPLIED and VERIFIED in the worktree. Nothing merged, deployed,
or pushed to a live app.**
Baseline: `integration/rallycircle-muse-review` @
`2c2d24f93daf751108986a45cba1ccb5440044ec` (PR #12 head).
Branch: `feature/muse-polls-notifications`, worktree
`~/workspace/deepspace-interview-prep/fullstack/track-gh`.
Applied from the staged draft at
`~/workspace/deepspace-interview-prep/fullstack/track-gh-draft/` (PATCHES.md
P1–P9k), which itself was written against the on-disk `social-backend/`
copy at `2c2d24f`.

## 1. What was built

**Track G — scheduling polls + recurring sessions**
- `polls` / `pollVotes` collections: one poll per session ever
  (`uniqueOn: ['sessionId']`), approval-style votes (one record per
  poll/option/user, `uniqueOn` composite), server-maintained tally JSON
  recomputed from vote rows after every vote change. Poll ops serialised
  in the per-session command room; host-only create/cancel/finalize;
  voting restricted to host or RSVP (`going`/`maybe`) checked live.
  Finalize is host-only, re-validates the chosen time is still in the
  future, writes `session.startsAt` + `scheduleRevision += 1`, marks the
  poll finalized, and notifies RSVP holders with `schedule_changed`.
  **RSVPs are untouched by finalization (G08)** — participants are
  notified, not silently moved.
- `recurringSeries` collection: bounded series (count 2–12, interval
  1–4 weeks), explicit host-triggered generation (no background jobs),
  at most 12 ordinary sessions + host `going` RSVP each; `cancelSeries`
  cancels only future `open` instances and notifies their RSVP holders.
  `sessions` gains `seriesId` (default `''`) and `scheduleRevision`
  (default `0`); neither is member-writable.
- Calendar (G09): `buildCalendarEvent` gains `{ sequence?, method? }`;
  default output byte-identical to before; `sequence > 0` adds
  `SEQUENCE:<n>` (from `scheduleRevision`); `method: 'CANCEL'` emits
  `METHOD:CANCEL` + `STATUS:CANCELLED` with the same UID. The session
  view passes `scheduleRevision` and offers a cancellation `.ics`
  download for host / `going` users on cancelled sessions.

**Track H — in-app notifications**
- `notifications` / `notificationPreferences` collections: in-app only
  (no email/SMS/push). Types: `waitlist_promoted`, `session_cancelled`,
  `schedule_changed`, `poll_created`, `poll_finalized`,
  `result_confirmed`, `result_disputed`. Categories: essential
  (cancelled / schedule / promoted — cannot be opted out) vs `results` /
  `polls` (opt-out-able; absent preferences = all on).
- Emitter (`src/server/notifications.ts`): best-effort, never throws
  into the primary command (H15); deterministic idempotency keys with
  `uniqueOn: ['recipientId','idempotencyKey']` as backstop; retention
  cap 100 per user (prunes oldest beyond cap, at most 5 per emit).
- Wiring (all inside the command room, after the primary write
  succeeds): `fillVacancies` promotion → `waitlist_promoted`;
  host cancel → `session_cancelled` to RSVP holders (excluding host);
  `reviewResult` → `result_confirmed` when the result becomes final,
  `result_disputed` on dispute, to all recorded participants;
  `createPoll` → `poll_created`; `finalizePoll` → `schedule_changed`
  only (no separate `poll_finalized` notice).
- `notifications` action: `markRead` / `markAllRead` /
  `setPreferences`, all recipient-checked server-side (`recipientId ===
  userId`); `setPreferences` merges partial updates over stored values.

## 2. Deviations from the staged draft (all deliberate, recorded here)

1. **Type fixes (4):** `notification-actions.ts` casts now go through
   `unknown` (`found.data.record as unknown as …`,
   `existing.data as unknown as …`); `parseSeriesCommand` casts the
   template `as unknown as SeriesTemplate`; `applyCommand`'s fallthrough
   is now an explicit attendance-operation guard returning
   `failure('Invalid rally command.')` otherwise — TS could not narrow
   the widened `RallyCommand` union (the poll member carries
   `operation: 'castVote' | 'withdrawVote'`, which defeats discriminant
   narrowing) to `AttendanceCommand`.
2. **Track A D1 preserved in `fillVacancies`:** the draft's P8f rewrite
   dropped Track A's single retry of a failed waitlist-row delete. This
   branch keeps the retry (delete once, retry once, then return null),
   because Track A proved a transient delete failure otherwise blocks
   the caller's own command. The harness fault-injection flag became a
   counter (`interruptQueueCleanup(times = 1)`) and the pre-existing
   interrupted-promotion test was replaced with Track A's two-part
   version (single failure repaired in-command; double failure repaired
   by the next command). Track A's harness D2 fix (real `orderBy` /
   `createdAt` handling with monotonic stamps) was NOT ported — the
   harness here still relies on map insertion order for FIFO. The
   integration merge must take Track A's harness version, not this
   branch's, for the shared harness code.
3. **P9k stub fix:** the standalone `notification-actions.test.ts`
   stub did not emulate `userBound` stamping on
   `notificationPreferences` creates, so the second `setPreferences`
   call created a second row and the merge assertion read the stale
   first row. The stub now stamps the caller id per call (emulating the
   platform); no product code changed.
4. **P9a folded in:** the `RallyPoll` / `RallyPollVote` /
   `RecurringSeriesRecord` interfaces were exported at the P8b step
   instead of in a separate P9a edit.
5. Nothing from the draft was dropped: all P1–P9k blocks applied; every
   old-text block matched the base verbatim on first check.

## 3. Verification (all executed, 2026-11-20 ~22:00 EST)

| Check | Result |
|---|---|
| `node --test tests/rally.test.mjs tests/courts-games.test.mjs` | **29/29** (baseline, unchanged) |
| `npx vitest run` | **131/131, 22 files** (baseline 103 + 28 new) |
| New Vitest tests | polls 5, recurrence 4, rally-notifications 4, rally-calendar-sequence 4, notification-actions 1, command-room +10 (polls 4, series 2, notifications 4) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | passes (26.7s) |
| `npm run test:public` | **14/14** (public Chromium, 2.7m) |

The two pre-existing failures found during application were both
harness/test issues, not product bugs: the P9k stub stamping gap (§2.3)
and the interrupted-promotion expectation superseded by Track A D1
(§2.2). No product behaviour was changed to make a test pass.

## 4. What remains unverified

- **Live worker behaviour:** poll/series/notification flows against a
  real RecordRoom; `userBound` stamping on notification creates;
  `uniqueOn` enforcement on the new collections; `orderBy: 'createdAt'`
  on notification queries; JSON-in-text round trips through the real
  RecordRoom. All need an authorized developer session / test app.
- **Two-account browser tests:** not run — `npx deepspace auth whoami`
  → `not_authenticated`; no credentials created or used.
- **Real calendar-client import** of SEQUENCE / CANCEL `.ics`: not run
  (unit tests + the earlier independent `icalendar` parse of the base
  format only).
- **Additive migration against pre-existing data:** still needs
  validation in an authorized test environment before any release (no
  existing collection changed, but the integration handoff requires it).
- `npm run test:public`: **14/14** (public Chromium). The one WebServer
  stack trace in the output (`http-routes.ts`, the `/api/auth/*` proxy)
  is environmental — no auth worker is bound in Vite dev, so the
  signed-out check fails closed. Not a defect (same observation as
  Track A).

## 5. Known limitations (carried from DESIGN.md, unchanged)

- No background retry for notifications — a lost notification stays
  lost until the next event for that user. No durable outbox (out of
  scope before the submission deadline).
- Direct host `startsAt` edits bypass `scheduleRevision` (only
  command-room poll finalisation bumps it).
- Recurrence is fixed 7-day UTC intervals; a weekly 19:00-local series
  shifts wall-clock by an hour across a DST transition (the app stores
  no IANA timezone).
- One poll per session, ever; approval-style votes (Codex must render
  tallies, not a single-choice radio group).
- Series generation is an explicit host action, not automatic on series
  creation (two steps; the UI should chain them).
- `finalizePoll` two-write window: the session update lands before the
  poll update; if the poll update fails, the session keeps the new time
  and the poll stays open — the host can finalise again (same option;
  `scheduleRevision` bumps once more). No rollback.
- The command room's N-03 trust boundary is unchanged: the room trusts
  its body; only the action route authenticates.
- Emission cost: a host cancel of a 12-person session performs up to
  ~12 notification creates + 12 prune queries inside one serialised
  room invocation. Bounded, but the room is busy for that duration.

## 6. Publication

- Branch `feature/muse-polls-notifications` (worktree
  `~/workspace/deepspace-interview-prep/fullstack/track-gh`), commits
  listed in §7. Push attempted with existing auth only; if blocked, a
  verified git bundle at
  `~/workspace/deepspace-interview-prep/fullstack/track-gh.bundle` +
  per-commit patches. Draft PR target:
  `integration/rallycircle-muse-review`.
- Contracts for Codex: `docs/track-gh-contracts.md` in this branch.

## 7. Commits

(To be filled in after committing — see `git log`.)
