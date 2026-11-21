# RALLYCIRCLE_BACKEND_CONTRACTS.md — Tracks G+H (polls, recurring sessions, notifications)

**Audience:** Codex (frontend). **Base:** `integration/rallycircle-muse-review`
@ `2c2d24f` + `feature/muse-polls-notifications` (this branch — applied
and verified in the worktree; see `IMPLEMENTATION_LOG.md`). All times are
ISO 8601 UTC instants. All writes go through server actions; direct client
writes to these collections are closed for every role.

## 1. Types

```ts
type PollStatus = 'open' | 'finalized' | 'cancelled'

interface PollOption { id: string; startsAt: string } // startsAt: ISO UTC instant

interface Poll {
  recordId: string
  data: {
    sessionId: string
    hostId: string
    options: PollOption[]            // JSON text in storage; 2–5 entries
    status: PollStatus
    finalizedOptionId: string        // '' until finalized
    tally: Record<string, number>    // optionId -> vote count; server-maintained
  }
  createdAt: string
}

interface PollVote {
  recordId: string
  data: { pollId: string; optionId: string; userId: string }
  createdAt: string
}

type SeriesStatus = 'active' | 'cancelled'

interface SeriesTemplate {
  format?: 'Singles' | 'Doubles' | 'Practice'
  title: string; court: string; location: string
  durationMinutes: 60 | 90 | 120 | 150
  targetPlayers: number              // 2–12
  capacity?: number                  // 2–12, immutable once set
  level: 'All levels' | 'Beginner' | 'Intermediate' | 'Advanced'
  notes: string
}

interface RecurringSeries {
  recordId: string
  data: {
    hostId: string
    template: SeriesTemplate          // JSON text in storage
    startStartsAt: string             // ISO UTC instant of occurrence 0
    intervalWeeks: number             // 1–4
    count: number                     // 2–12 (hard max)
    status: SeriesStatus
    generatedCount: number            // occurrences materialised so far
  }
  createdAt: string
}

type NotificationType =
  | 'waitlist_promoted' | 'session_cancelled' | 'schedule_changed'
  | 'poll_created' | 'poll_finalized' | 'result_confirmed' | 'result_disputed'

type NotificationCategory = 'essential' | 'results' | 'polls'
// essential: session_cancelled, schedule_changed, waitlist_promoted (cannot be opted out)
// results:   result_confirmed, result_disputed (opt-out-able)
// polls:     poll_created, poll_finalized (opt-out-able)

interface RallyNotification {
  recordId: string
  data: {
    recipientId: string
    type: NotificationType
    sessionId: string                 // '' when the notice has no session target
    title: string                     // <= 200 chars
    body: string                      // <= 500 chars
    link: string                      // relative path, e.g. '/rallies?session=<id>'; '' when none
    idempotencyKey: string
    readAt: string                    // '' = unread; ISO timestamp when read
  }
  createdAt: string
}

interface NotificationPreferences { results: boolean; polls: boolean } // default: both true
```

**Sessions gain two optional columns** (additive, no backfill; old sessions
read as `''` / `0`): `seriesId: string` (default `''`) and
`scheduleRevision: number` (default `0`, incremented only when the host
finalizes a poll time through the command room).

## 2. Actions

### 2.1 `rallyCommand` — poll operations (existing action, extended)

POST `/api/actions/rallyCommand` with a Bearer token. All poll operations
are serialised per session in `RallyCommandRoom`. Error responses are
`{ success: false, error: <string> }` with the exact strings below.

| Operation | Params | Who | Success | Errors |
|---|---|---|---|---|
| `createPoll` | `sessionId`, `options: PollOption[]` | session host only | `{ recordId: <pollId> }`; emits `poll_created` to RSVP holders | `'Only the session host can create a poll.'`, `'This session is not open for responses.'`, `'This session already has a poll.'` (one poll per session, ever), `'Propose at least 2 times.'` / `'Propose at most 5 times.'` / `'Each proposed time needs a unique id.'` / `'Each proposed time must be in the future.'` / `'Proposed times must be different.'` |
| `castVote` | `sessionId`, `pollId`, `optionId` | host or RSVP (`going`/`maybe`) on the session | `{ recordId: <voteId> }` (existing vote → same id, no duplicate) | `'This poll is not open for voting.'`, `'Only session participants can vote.'`, `'That time is not part of this poll.'` |
| `withdrawVote` | `sessionId`, `pollId`, `optionId` | the voter (any eligible participant; own vote only) | `{ recordId: <pollId> }` (idempotent: no vote → success) | `'This poll is closed.'` (when finalized) |
| `cancelPoll` | `sessionId`, `pollId` | session host only | `{ recordId: <pollId> }` | `'Only the session host can cancel the poll.'`, `'This poll is already closed.'` |
| `finalizePoll` | `sessionId`, `pollId`, `optionId` | session host only | `{ recordId: <sessionId> }`; session `startsAt` becomes the chosen instant, `scheduleRevision` +1; emits `schedule_changed` to RSVP holders; RSVPs unchanged | `'Only the session host can finalise a poll.'`, `'This poll is not open.'`, `'That time is not part of this poll.'`, `'The proposed time is no longer in the future.'`, `'This session is not open for responses.'` |

Rules Codex must render: **approval voting** — a player may vote for
several options; show per-option counts from `poll.tally`, never voter
names (individual votes are private: `pollVotes` reads are owner-only).
One poll per session, ever. Finalising never deletes or changes RSVPs.

### 2.2 `scheduling` — recurring series (new action)

POST `/api/actions/scheduling` with a Bearer token. Serialised per series
in `RallyCommandRoom`.

| Operation | Params | Who | Success | Errors |
|---|---|---|---|---|
| `createSeries` | `template: SeriesTemplate`, `startStartsAt`, `intervalWeeks`, `count` | any signed-in host (creates own series) | `{ recordId: <seriesId> }` | template validation errors from `validateSession` (title/court/location lengths, duration, target, capacity, level), `'Choose a future start time.'`, `'A series has 2–12 occurrences.'`, `'Repeat every 1–4 weeks.'` |
| `generateOccurrences` | `seriesId` | series host only | `{ recordId: <seriesId> }`; creates ordinary sessions (with `seriesId`) + host `going` RSVP for each remaining occurrence | `'Only the series host can generate sessions.'`, `'This series is not active.'`, `'All occurrences have already been generated.'` |
| `cancelSeries` | `seriesId` | series host only | `{ recordId: <seriesId> }`; series → `cancelled`; every future `open` instance is cancelled; their RSVP holders get `session_cancelled` | `'Only the series host can cancel the series.'`, `'This series is already cancelled.'` |

Occurrences are fixed 7-day UTC intervals (`start + i · 7 · intervalWeeks`
days). A weekly 19:00-local series shifts wall-clock by an hour across a
DST transition — the app stores no IANA timezone; render the stored UTC
instant in the viewer's locale. Individual instances are ordinary sessions:
cancel/edit one instance never touches the series.

### 2.3 `notifications` — inbox actions (new action)

POST `/api/actions/notifications` with a Bearer token. Every operation
verifies `recipientId === caller` server-side.

| Operation | Params | Success | Errors |
|---|---|---|---|
| `markRead` | `recordId` | `{ recordId }` (already-read → success) | `'Notification not found.'`, `'You can only update your own notifications.'` |
| `markAllRead` | — | `{ recordId: <caller>, count: <number> }` (count = newly marked) | — |
| `setPreferences` | `preferences: { results?: boolean, polls?: boolean }` | `{ recordId: <prefsId> }` | `'Invalid notification preferences.'` |

## 3. Subscriptions (real-time)

All three collections are ordinary DeepSpace records; use the existing
subscription mechanism (`useQuery`):

```ts
useQuery<Poll>('polls', { where: { sessionId } })                 // options + tally + status; live
useQuery<PollVote>('pollVotes', { where: { pollId, userId } })    // own votes only
useQuery<RallyNotification>('notifications', { where: { recipientId: userId }, orderBy: 'createdAt', orderDir: 'desc' })
useQuery<RecurringSeries>('recurringSeries', { where: { hostId: userId } }) // own series; member read is true
```

Unread count is client-derived: records with `readAt === ''`. Poll tallies
update live because the room rewrites `poll.tally` on every vote change.
Notification delivery is at-least-once emission with idempotent keys =
effectively-once per event; a failed emission is logged server-side and
never fails the primary command (RSVP/cancel/score still succeeds).

## 4. Calendar (`.ics`) — updates and cancellations

`buildCalendarEvent(session, invitation, now?, { sequence?, method? })`:
- Default: identical output to today (no `SEQUENCE`, no `METHOD`).
- `sequence: session.scheduleRevision` (when `> 0`): `SEQUENCE:<n>` in
  `VEVENT`. The revision increments only on command-room poll
  finalisation; direct host edits of `startsAt` do not bump it.
- `method: 'CANCEL'` (cancelled sessions only): `METHOD:CANCEL`,
  `STATUS:CANCELLED`, same `UID` (the invitation URL), `SEQUENCE` as
  above. Download the cancellation file from the cancelled session view
  (host / `going` users).
- `UID` never changes for a session: it is the invitation URL, so an
  updated file is an update, not a new event.

## 5. Migration requirements

Additive only, no backfill, no app-ID change:
- `sessions`: optional `seriesId` (text, default `''`) and
  `scheduleRevision` (number, default `0`). Neither is member-writable.
- New collections: `polls`, `pollVotes`, `notifications`,
  `notificationPreferences`, `recurringSeries` (see §1). Register in
  `src/schemas.ts`. Validate the additive upgrade against pre-existing
  test records in an authorized test app before release (SDK documents
  additive migration support; a real upgrade run is still required).
- Retention: notifications are capped at 100 per user (server prunes the
  oldest beyond the cap, at most 5 per emit). No migration needed for
  existing sessions/RSVPs/scores/waitlists.

## 6. Error-code summary

All failures are `{ success: false, error: <exact string> }` from the
tables above (no numeric codes in this draft; the strings are the
contract). Unauthenticated action calls return HTTP 401; unknown actions
404; malformed params 400. The command room returning 5xx surfaces as
`'The session service is temporarily unavailable. Try again.'`.
