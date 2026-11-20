# Session Capacity & Waitlists — feature README

Branch: `feature/session-capacity-waitlist` (base `feature/ready-to-play` @ `8fd8c2c`)
Status: implemented, tested locally, **not merged, not deployed**.

## What it does

A host can now create a session with **Limited** participation: a hard cap
on confirmed (`going`) RSVPs, enforced on the server. When the cap is
reached, further players are offered the **waitlist** instead of an RSVP.
When a confirmed player withdraws or switches to `maybe`, the earliest
waitlisted player is **promoted automatically, FIFO**, inside the same
server-side operation that freed the spot.

Open participation (the default) behaves exactly as before: the target
player count stays a planning goal, not a cap.

## Policy (one explicit policy)

**Automatic FIFO promotion, no offer window.** The per-session Durable
Object has no timers, so there is no expiry or accept/decline step. A
promoted player who no longer wants the spot simply withdraws, freeing it
for the next person in line. Trade-off, stated plainly: promotion can
surprise a player who joined the waitlist hours ago and changed their
mind — the cost of declining is one tap on Withdraw, and the spot is
immediately re-offered. An offer-window variant would need a scheduler
(the DO cannot wake itself) and is deliberately out of scope.

Other policy decisions:

- `maybe` RSVPs never consume a spot, even on a full session.
- The host's own RSVP at creation counts as the first spot.
- Joining the waitlist is an explicit choice after an honest failure:
  the server returns a `SESSION_FULL:` error and the UI offers "Join
  waitlist". There is no silent auto-waitlisting.
- Leaving the waitlist is always allowed, including on a cancelled
  session. Rejoining puts you at the back.
- Waitlist rows on a cancelled session are left inert — never promoted,
  never deleted by the server. (Deleting them would destroy the record
  of who was waiting; they are small and harmless.)
- A user who is confirmed is never also on the waitlist: a successful
  `going` RSVP deletes any of their waitlist rows, and the promotion
  loop drops stale rows for already-confirmed users.

## Data model (additive, no migration, no app-ID change)

Sessions gain two columns (`src/schemas/rally-schema.ts`):

- `capacityMode`: `select ['open', 'limited']`, default `'open'`
- `maxPlayers`: `number`, default `0` (= no cap)

Both are in `sessionMemberWritableFields` — `writableFields` applies to
creates as well as updates, so the create path must be allowed to send
them (same constraint as the original nine fields; see the PR #2 review,
N-01). Old sessions store neither field and resolve as open
participation: **nothing is silently converted to a cap.**

New collection `waitlists` (`waitlistsSchema`, registered in
`src/schemas.ts`):

| column | |
|---|---|
| `sessionId` | text, required, immutable |
| `userId` | text, `userBound`, immutable |

`uniqueOn: ['sessionId', 'userId']`, `ownerField: 'userId'`. Member
`create`/`update` are `false` (command room only, exactly like `rsvps`);
member `delete: 'own'` is a backstop so a user can always leave a
waitlist. Member `read: true` so every participant sees the waitlist
state (positions are shown by name-count only — the UI shows "2 waiting",
and a user sees only their own position number).

Validation: `maxPlayers` must be 2–12 when limited (client
`validateSession` + server `resolveCapacity`). A malformed stored value
is possible because host session edits still go through a direct record
write with no server-side range validation (PR #2 review, N-02): the
command room **treats a malformed cap as open participation** rather
than clamping it to a cap the host never set. Documented limitation,
tested (`rally-command-room.test.ts`: `maxPlayers: 99` and `1` both
behave as open).

## Concurrency argument

The existing `RallyCommandRoom` already serialises every command for one
session onto a single in-memory promise queue keyed
`rally:<appId>:<sessionId>`. This feature extends that pattern instead of
replacing it. Inside one queue turn, the RSVP handler reads the session,
counts `going` RSVPs, and creates the new RSVP — so two concurrent joins
cannot both see a free spot. The test `never overbooks under five
concurrent joins` proves it: cap 2, five simultaneous `going` commands,
exactly 2 succeed and 3 get `SESSION_FULL`.

Withdraw is a prerequisite that landed first (commit `a586b5f`): it used
to bypass the room via direct `removeConfirmed`, which could race an
in-flight RSVP update. It now goes through the room, so a withdraw and
the promotion it triggers happen in one serialised turn — no interleaving
command can observe a freed spot before the earliest waiter claims it.

Promotion ordering per iteration: **create the promoted RSVP first,
then delete the waitlist row**. If the delete fails, the user temporarily
holds both rows; the next promotion pass sees they already hold a `going`
RSVP and drops the stale row instead of promoting them twice (tested
with a seeded stale row). Each loop iteration strictly increases the
going count or removes a waitlist row (or returns), so the loop always
terminates.

One subtlety worth knowing for the interview: the promoted RSVP is
created with the tool call's `userId` argument set to the waiter, because
the SDK stamps `userBound` columns from that argument
(`node_modules/deepspace/dist/worker.js:1543-1545`). The command room
runs with `X-App-Action`, which is RBAC-off by design ("the app's own
server-side code, which is already the trust boundary"), so this is the
trusted server acting — never client code, which cannot create RSVP or
waitlist rows at all.

## Commands (all via the existing `rallyCommand` action)

| operation | behaviour |
|---|---|
| `rsvp` | As before, plus: `going` on a full limited session fails with `SESSION_FULL: …`; `going` clears the caller's waitlist row; `going → maybe` promotes the next waiter. |
| `withdraw` | Deletes only the caller's own RSVP; idempotent; valid on a cancelled session; promotes on a freed `going` spot. |
| `joinWaitlist` | Idempotent (existing row → same `recordId`). Refused while spots are free, when already confirmed, or on an open/cancelled session. |
| `leaveWaitlist` | Idempotent (no row → success). Valid on a cancelled session. |
| `cancel` | Unchanged. |

The `SESSION_FULL:` prefix is the structured FULL signal: the action
result carries only an error string, so the client detects it with
`error.startsWith('SESSION_FULL')` (`isSessionFullError` in
`src/lib/rally-actions.ts`) and strips the prefix for display
(`commandErrorMessage`).

## UI

- `CreateSession`: Open / Limited toggle (default Open) + 2–12
  max-players select shown only for Limited; the planning-goal copy now
  reflects the chosen mode.
- `CapacityPanel` (`src/components/capacity-panel.tsx`, new): rendered
  only for limited sessions, directly under the readiness panel. Shows
  `going / max` spots filled, waiting count, the caller's 1-based FIFO
  position ("You are #2 on the waitlist"), Join/Leave waitlist buttons,
  and the promotion promise. A `SESSION_FULL` failure from "I'm in"
  highlights the waitlist offer.
- Session list cards show `Full · N waiting` for capped sessions.
- `ReadinessPanel` is untouched; the capacity panel sits below it and
  corrects the "extra players can still join" copy for limited sessions.

## How to test locally

```sh
git worktree add /tmp/capacity-test 8fd8c2c   # or use this worktree
cd <worktree>
node --test tests/rally.test.mjs   # 20/20
npx vitest run                     # 23/23
npx tsc --noEmit && npm run lint && npm run build
```

Live two-account check (needs DeepSpace test accounts, not available in
this environment — see IMPLEMENTATION_LOG.md): create a limited session
with max 2, RSVP as host + one player, try a third account (expect
"Session full" + Join waitlist), withdraw as the second player (expect
the waiter promoted to Going without a refresh).

## Known limitations

1. **No promotion notification.** A promoted player finds out by seeing
   their RSVP flip to Going (live) — there is no push/email/in-app
   notice. Acceptable for the exercise; a notification hook would slot
   into `promoteWaiters`.
2. **Malformed stored caps read as open** (see Data model). The UI only
   ever offers 2–12, so this only bites if a host edits the record
   outside the UI.
3. **No offer window** (see Policy).
4. **Cancelled-session waitlist rows are inert, not deleted.** They are
   visible to members via the `waitlists` read permission; the UI only
   ever shows counts and the caller's own position.
5. **The command room trusts its request body** (PR #2 review, N-03):
   unchanged by this feature. Only `rallyCommandAction` calls it, with
   a verified `userId`. The promotion path creates rows for other users
   *inside* that trusted boundary — do not expose the room via a route.

## Conflicts with sibling branches (checked 2026-11-20)

- **`feature/match-scoreboard` (Phase 1, sibling worktree): definite
  conflict.** It modifies `src/server/rally-command-room.ts` (+142),
  `src/server/rally-command-room.test.ts`, `src/schemas.ts`, and
  `rallies.tsx`. Both branches extend the `RallyCommand` union and
  `applyCommand`; merging needs a manual union of the two command sets
  (they are independent operations — no semantic clash, just text).
  Integrate by taking both sets of operations and both sets of tests.
- **`origin/feature/live-courtboard` (PR #5): likely clean.** It touches
  `rallies.tsx` (+10: an import and a `<LiveCourtboard/>` render in
  `SessionDetail`), plus `realtime-routes.ts` / `worker.ts` which this
  branch does not touch. Verify at merge time.
- **`feature/video-feasibility`: no overlap** (new files only).
- Copilot's chat-profile work was not touched; `rallies.tsx` changes
  here are confined to CreateSession, SessionDetail props, and the
  session list.
