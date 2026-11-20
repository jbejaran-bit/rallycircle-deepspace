# Track A — Backend contracts fragment

For consolidation into `RALLYCIRCLE_BACKEND_CONTRACTS.md`. Covers the
stabilized behaviour only (RSVP / waitlist / scoring / calendar / court
discovery on the integrated release candidate). Field types for the
underlying records live in `src/schemas/rally-schema.ts`,
`src/lib/rally.ts`, and `src/lib/rally-score.ts`.

## Transport and identity

- All attendance and scoring writes go through the `rallyCommand` server
  action (`POST /api/actions/rallyCommand`, Bearer JWT required) into the
  per-session `RallyCommandRoom` Durable Object. Identity is always the
  verified caller; a client-supplied `userId` in the command body is
  ignored. Direct client writes to `rsvps` / `waitlists` are closed for
  every role (`create: false, update: false, delete: false`); direct member
  writes to `sessions.matchScore` and `sessions.status` are rejected by
  field permissions.
- Commands are serialized per session in submission order. Concurrent
  commands for one session are applied in the order the room receives
  them; the last queued write wins for a single user's RSVP.
- The action returns `{ success: true, data: { recordId } }` or
  `{ success: false, error: <stable string> }`. The room being unreachable
  returns the structured failure `'The session service is temporarily
  unavailable. Try again.'` (HTTP 200 with `success: false` from the
  action; the action route itself returns 401 for a missing/invalid token).

## Error codes (exact strings returned by the command room)

| Error | Meaning | Retryable by the client? |
|---|---|---|
| `'This session is unavailable.'` | Session record missing/unreadable | No (re-fetch the session) |
| `'This session is not open for responses.'` | RSVP/waitlist on a non-open session | No |
| `'This session is closed.'` | Score edit on a non-open session | No |
| `'Only the session host can cancel it.'` | Non-host cancel | No |
| `'Only an open session can be cancelled.'` | Cancel on a non-open, non-cancelled session | No |
| `'Only the session host can edit the score.'` | Non-host score write | No |
| `'This session has an invalid capacity.'` | Stored capacity fails `validCapacity` (2–12 int) | No — host/admin must fix the stored value |
| `'This session is full. You can join the waitlist.'` | `going` RSVP at capacity | Yes — join the waitlist instead |
| `'A spot is available. Choose Going to join.'` | Waitlist join while a spot is free | Yes — RSVP `going` instead |
| `'This session has no waitlist.'` | Waitlist join on an uncapped session | No |
| `'You are already confirmed for this session.'` | Waitlist join while `going` | No |
| `'The waitlist is temporarily unavailable. Try again.'` | Queue repair failed inside this command | Yes — retry the same command |
| `'Available places could not be checked. Try again.'` | Same, on the RSVP path | Yes — retry |
| `'Your RSVP could not be saved.'` / `'Your RSVP could not be withdrawn.'` / `'You could not join the waitlist.'` / `'You could not leave the waitlist.'` / `'Your existing RSVP could not be checked.'` / `'Your waitlist entry could not be checked.'` | Storage failure at that step | Yes — retry (all are idempotent) |
| `'The score changed. Check the latest score before trying again.'` | Stale score revision (optimistic concurrency) | Yes — re-read the score, then retry with the new revision |
| `'There is no active scoreboard.'` | Score point with no match / after a winner | No |
| `'This session already has a scoreboard.'` | Second `startMatch` | No |
| `'Choose distinct players for each side in the session format.'` | Bad teams for the session format | No — fix the selection |
| `'Every player must have a confirmed RSVP for this session.'` | Match player without a `going` RSVP | No — player must RSVP `going` first |
| `'This result is closed or unavailable for your review.'` | Review of a non-proposed/confirmed result, by a non-participant, or a duplicate review | No |
| `'The score could not be saved.'` / `'The session could not be cancelled.'` | Storage failure on the final write | Yes — retry |

No error string contains a user ID, token, location, or another user's data.

## Idempotency semantics

- **RSVP:** repeating the same RSVP returns the same `recordId`; one row
  per (session, user) is enforced by `uniqueOn` plus the serialized queue.
- **Withdraw / leaveWaitlist:** succeed even when no row exists (no-op).
- **JoinWaitlist:** returns the existing row's `recordId` when already queued.
- **Cancel:** re-cancelling an already cancelled session succeeds.
- **Score point:** keyed by `revision`; a retry with the same revision
  after success fails with `'The score changed…'` (the point was already
  applied once — never double-counted). An identical re-save is not a
  score operation and has no score endpoint.
- **Result review:** one review per participant; a second review by the
  same participant fails. Approvals and disputes are append-only on the
  stored score JSON.
- **Waitlist promotion:** creating the promoted RSVP happens before deleting
  the queue row; a failed delete is retried once in-command, and a repeated
  failure is repaired by the next attendance command without consuming a
  second place or letting anyone jump the queue.

## Waitlist rules

- Capacity is optional and immutable once set (`capacity` is an immutable
  column). Absent capacity means unlimited; old sessions are unaffected.
- `maybe` never consumes a spot. The host's auto-RSVP counts as the first spot.
- Promotion is automatic FIFO by waitlist `createdAt` (ties broken by
  `recordId`), runs inside the same serialized queue turn that frees the
  spot (withdrawal of a `going` RSVP, or `going` → `maybe`), and has no
  offer window (the DO has no timers). A promoted player who no longer
  wants the spot withdraws, freeing it for the next waiter.
- Leaving and rejoining forfeits queue position (new row, new `createdAt`).
- Waitlisted players are **not** shown to other members: `waitlists` rows
  are `read: 'own'` for members; the UI queries only the caller's own row.
  Queue length is never exposed; only the session's going count and
  capacity are public to participants.
- Host cancellation closes the waitlist: no new joins, no promotions, rows
  left inert (never deleted automatically).

## Scoring and result confirmation

- `startMatch` requires the host, distinct players matching the session
  format (Singles 1v1, Doubles 2v2), and a `going` RSVP for every player.
- Points are awarded with optimistic concurrency (`revision` must match the
  stored score; stale writes are rejected, never silently overwritten).
- Result states: `in-progress` → `proposed` (winner decided, no approvals)
  → `confirmed` (some approvals) → `final` (every recorded participant
  approved). `disputed` locks the result: no further approvals, no further
  scoring. A disputed or non-final result is **never** eligible for match
  statistics or ratings — see `isEligibleForStats()` in
  `src/lib/rally-score.ts`, the single gate future consumers must use.
- **Known limitation (fails closed):** a participant who withdraws after
  the match starts is still a required approver, so the result can stay
  unfinalized if they never approve. A future change could waive approval
  for players without a current `going` RSVP, but that changes finalization
  semantics and must be designed with the scoreboard UI (which also
  computes `resultStatus` from the stored score) — not done in Track A.

## Calendar export

- `buildCalendarEvent(session, invitationUrl, now)` returns an RFC 5545
  `.ics` document or `null` (cancelled session, invalid/unusable times,
  non-positive duration). Times are UTC (`DTSTART`/`DTEND` in `Z` form);
  sessions store absolute instants, so DST transitions cannot shift an
  event. `UID` is the invitation URL, stable across exports; `DTSTAMP`
  follows the export time. Text is escaped (`\,` `\;` `\\` `\n`) and lines
  are folded at 75 octets without splitting UTF-8 characters; unpaired
  surrogates are replaced with U+FFFD.
- The download is shown only to the host or a `going` participant of an
  open session (UI gate in `SessionDetail`); the builder itself does not
  check eligibility. Exported events receive no later updates.

## Court discovery

- `GET /api/courts/nearby?lat&lng&radiusKm` and `GET /api/geocode?q=`
  require sign-in (401 otherwise). Radius is clamped to 1–50 km.
  Responses are cached 10 minutes (50 entries); Nominatim is paced
  ≥1.1 s app-wide via the shared geocoder DO in production.
- Upstream failures map to 502 with a generic message (no upstream body
  leaked): 429/406/503 → "busy, try again later"; other failures →
  "unavailable, browse the Pittsburgh courts". Malformed upstream payloads
  → 502. No retry is attempted against a throttling provider.
- Coordinates are rounded to 3 decimal places in cache keys; the viewer's
  coordinates are never stored, logged, or written to a record.

## Real-time subscription behaviour

- Record subscriptions (`useQuery`) deliver the latest committed state on
  reconnect; a client that was offline sees the current state on resubscribe.
  Stale score writes are rejected server-side by revision, so an offline
  client's queued edit surfaces a conflict instead of overwriting.
- Courtboard WebSocket access is per-session and re-authorized per message
  (see `src/server/courtboard-access.ts`); revocation (withdrawal,
  cancellation) is enforced on the next message, and cancelled boards are
  read-only (`viewer` role).
- Live two-account delivery, reconnect timing, and real-DO queue behaviour
  under eviction are **unverified** in this environment (no test accounts).
