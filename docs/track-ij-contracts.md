# Tracks I + J — Backend contracts for Codex

Branch: `feature/muse-groups-tournaments` off `integration/rallycircle-muse-review` @ `2c2d24f`.
Status: implemented and tested (see `IMPLEMENTATION_LOG.md`). No frontend work
is included; this document is the complete contract the Groups and
Tournaments UI needs.

All actions are called as `POST /api/actions/groups` or
`POST /api/actions/tournaments` with a JSON body `{ operation, ...params }`
and a Bearer token. Every response is `{ success: true, data }` or
`{ success: false, error }` with a human-readable `error` string. Identity
always comes from the verified token; a `userId` in params is only ever a
*target* (the member an admin removes, the player a host adds), never the
caller.

---

## Groups

### Collections (new)

| Collection | Key columns | Direct client writes |
| --- | --- | --- |
| `groups` | `name` (≤72, required), `description` (≤280, default `''`), `visibility` (`public` \| `private`, required), `hostId` (userBound), `status` (`open` \| `closed`, default `open`) | closed for every role |
| `groupMembers` | `groupId`, `userId` (userBound), `role` (`host` \| `admin` \| `member`), `uniqueOn: [groupId, userId]` | closed for every role |

`sessions` gains an additive `groupId` column (text, default `''`). It is
**not** in the member/admin `writableFields`: a client can never set it.
Only the `groups` action scopes a session to a group.

### Privacy model — read this before building the UI

RecordRoom row permissions cannot express "member of group X". So:

- A `public` group row is readable by any signed-in member (`read:
  'published'` on `visibilityField: 'visibility'`).
- A `private` group row is readable only by its owner (the host). Other
  members read it through `getGroup` / `listGroups`, which check
  membership server-side.
- `groupMembers` rows are member-readable only as `own`: **no member list
  is ever visible through direct record reads**. Use `listMembers`.
- **Group sessions are hidden from non-members by the UI and by the
  command room, not by record permissions.** `sessions` rows stay
  member-readable (the pre-existing design — sessions are public
  invitations). The command room refuses RSVP / waitlist operations on a
  group session from anyone who is not the host or a member
  (`'Only group members can respond to this session.'`), and `createGroupSession`
  is the only way to create one. The Groups UI must therefore:
  - never show a group session in Find Games / public lists to a
    non-member (filter on `groupId` + membership);
  - never let a non-member open a group session's detail view.
  A determined member could read the raw session row; that is the same
  exposure model as every other session in the app, and it is documented
  here rather than hidden.

### Operations — `groups` action

| operation | params | who | result / notes |
| --- | --- | --- | --- |
| `createGroup` | `name`, `description?`, `visibility` | any signed-in member | `{ recordId }` (group id). Caller becomes `host`. |
| `listGroups` | `limit?` (default 20, max 50), `beforeCreatedAt?` | any signed-in member | `{ groups: [{ recordId, data, role }], nextBeforeCreatedAt? }`. Public groups + groups the caller belongs to (private included only then). `role` is `host` \| `admin` \| `member` \| `null`. Newest first. `beforeCreatedAt` is the `nextBeforeCreatedAt` of the previous page; rows sharing a timestamp may repeat at a page boundary. |
| `getGroup` | `groupId` | public: anyone; private: member only | `{ recordId, group, role }`. Non-member on a private group: `'This group is private.'` |
| `joinGroup` | `groupId` | any signed-in member (group must be `open`) | `{ recordId }` (membership id). Idempotent: re-joining returns the existing membership. Refused at 200 members. |
| `leaveGroup` | `groupId` | member (not host) | `{ recordId: groupId }`. Idempotent. The host must transfer hosting first. Leaving withdraws the leaver's future RSVPs on group sessions (see below). |
| `listMembers` | `groupId`, `limit?`, `beforeCreatedAt?` | member only | `{ members: [{ recordId, userId, role }], nextBeforeCreatedAt? }`. Newest first. |
| `createGroupSession` | `groupId` + session fields (`format?`, `title`, `court`, `location`, `startsAt`, `durationMinutes`, `targetPlayers`, `capacity?`, `level`, `notes?`) | member of an `open` group | `{ recordId }` (session id). Same validation as a normal session (`validateSession`); the session is created with `groupId` set and the caller as host. |
| `promoteMember` | `groupId`, `userId` | host only | `{ recordId: groupId }`. Member → admin. |
| `removeMember` | `groupId`, `userId` | host or admin | `{ recordId: groupId }`. See removal semantics. The host cannot be removed. |
| `transferHost` | `groupId`, `userId` | host only | `{ recordId: groupId }`. Target must be a member/admin. Old host becomes `member`; `groups.hostId` moves with the role. |
| `closeGroup` | `groupId` | host only | `{ recordId: groupId }`. Idempotent. Blocks joins and new group sessions; existing sessions keep running. |

### Member-removal semantics (I04)

Removing a member withdraws their RSVPs and waitlist entries on **future
open** group sessions (their spot is freed; waitlist promotion happens on
the next attendance command, the same repair-on-next-command pattern the
waitlist uses). Past sessions and already-recorded results are untouched.
No notification is emitted — the in-app notification system lives on a
separate branch and this action does not fabricate notification rows.

---

## Tournaments

v1 tournaments are **singles only** (2-player matches). No rating is ever
consulted; standings use only genuinely finalized results.

### Collections (new)

| Collection | Key columns | Direct client writes |
| --- | --- | --- |
| `tournaments` | `name` (≤72, required), `format` (`round-robin` \| `single-elimination`, required), `status` (`created` \| `in_progress` \| `completed` \| `cancelled`, default `created`), `hostId` (userBound), `maxPlayers` (number, required) | closed for every role |
| `tournamentPlayers` | `tournamentId`, `userId` (plain text — the *host* registers players, so it is not `userBound`), `seed` (1-based), `status` (`active` \| `withdrawn`, default `active`), `uniqueOn: [tournamentId, userId]` | closed for every role |
| `tournamentMatches` | `tournamentId`, `round` (1-based), `slot` (0-based), `playerIds` (JSON array of 1–2 user ids; 1 = bye), `sessionId` (default `''`), `status` (`pending` \| `scheduled` \| `final` \| `cancelled`, default `pending`), `winnerId` (default `''`), `uniqueOn: [tournamentId, round, slot]` | closed for every role |

### Fixture rules (deterministic — same input, same fixtures)

- **Round-robin** (circle method): 2–16 players. Every pair meets exactly
  once. With an odd count every round has exactly one bye (no match row
  for the bye); every player sits out exactly once.
- **Single elimination**: bracket is the next power of two; the top seeds
  receive byes first. Bracket positions follow standard seeding order
  (for 8: 1, 8, 4, 5, 2, 7, 3, 6), so the strongest seeds meet as late as
  possible and pairing round winners in slot order always reproduces the
  bracket. A bye is a match row with one player, status `final`,
  `winnerId` set, no session.
- **Seeds** are assigned in add order (1, 2, 3, …) at `addPlayer` time.
  Removing a player before start leaves a seed gap; fixtures sort by
  seed, so gaps are harmless.
- **Byes are free advances, never wins**: bye matches are excluded from
  standings.

### State machine

`created` → `in_progress` → `completed`; `cancelled` from `created` or
`in_progress` only (never from `completed`). Cancelling cancels pending /
scheduled matches and their sessions; finalized matches and their sessions
are untouched.

### Operations — `tournaments` action

| operation | params | who | result / notes |
| --- | --- | --- | --- |
| `createTournament` | `name`, `format`, `maxPlayers?` (2–16, default 16) | any signed-in member (becomes host) | `{ recordId }` |
| `addPlayer` | `tournamentId`, `userId` | host, while `created` | `{ recordId }` (player row). Idempotent; restoring a withdrawn player re-activates them. Refused at `maxPlayers`. |
| `removePlayer` | `tournamentId`, `userId` | host, while `created` | `{ recordId: tournamentId }`. Idempotent (no-op when absent). Deletes the row. |
| `startTournament` | `tournamentId` | host, while `created`, ≥2 active players | `{ recordId }`. Generates fixtures: round-robin creates **all** rounds up front; single elimination creates round 1 only. Status → `in_progress`. Retrying after a partial failure is safe (deterministic match ids). |
| `scheduleMatch` | `tournamentId`, `round`, `slot`, `court`, `location`, `startsAt`, `durationMinutes` | host, while `in_progress` | `{ recordId }` (session id). Creates an ordinary Singles session (capacity 2, target 2, `All levels`) titled `<tournament name> — Round <n>` and links it to the match (`status: scheduled`). Idempotent: re-scheduling returns the existing session id. A bye match cannot be scheduled. |
| `advanceRound` | `tournamentId`, `round` | host, single elimination only, while `in_progress` | `{ recordId }`. Requires **every** match in `round` to be `final` (syncs from sessions first). Creates the next round from winners in slot order. Refused on the final round — sync to complete instead. No-op if the next round already exists. |
| `syncTournament` | `tournamentId` | host, while `in_progress` | `{ recordId, status, finalized }`. Reads each scheduled match's session scoreboard; a match becomes `final` only when its result is genuinely finalized (`resultStatus() === 'final'`). Disputed results stay `scheduled` and never touch standings. Completes the tournament only when the **full** fixture count is final (round-robin: n(n−1)/2 played matches; single elimination: n−1) — syncing after round 1 of a knockout does not complete it. |
| `cancelTournament` | `tournamentId` | host, unless `completed` | `{ recordId }`. Idempotent. |
| `getTournament` | `tournamentId` | any signed-in member | `{ recordId, tournament, players: [{ recordId, userId, seed, status }], matches: [{ recordId, round, slot, playerIds, sessionId, status, winnerId }], standings }` |
| `getStandings` | `tournamentId` | any signed-in member | `{ tournamentId, standings }` |

### Standings

Computed server-side from **finalized results only** (matches whose
session scoreboard is `final`). Each row:

```ts
{
  userId: string
  played: number      // finalized matches only; byes excluded
  wins: number
  losses: number
  setsWon: number
  setsLost: number
  gamesWon: number
  gamesLost: number
}
```

Sort order: wins desc, then set difference desc, then game difference
desc, then player id ascending (deterministic, never random).

### How a tournament match is played (UI flow)

1. Host calls `scheduleMatch` → session created.
2. Both players RSVP `going` on the session (normal flow; group rules do
   not apply — tournament sessions are public sessions).
3. Host calls the normal `rallyCommand` `startMatch` with the two players,
   then scores points; players approve the result with `reviewResult`.
4. Host calls `syncTournament` → the match becomes `final` and standings
   update. For single elimination, host then calls `advanceRound`.
5. The UI should show a match as "awaiting result" while `scheduled`,
   "disputed — needs review" when its session result is disputed
   (detectable: the session's scoreboard has `disputed: true`; the match
   stays `scheduled`), and final once `status === 'final'`.

### Known limitations

- Tournaments are singles only in v1; doubles tournaments are not
  supported (the standings function handles team results, but
  `scheduleMatch` always creates a Singles session).
- No self-registration: only the host adds players. No waitlist for a
  full tournament (the host gets `'This tournament is full.'`).
- `syncTournament` is host-only and explicit — there is no background
  job that notices a finalized result. The UI should call it after a
  result is approved, or offer a "refresh" action.
- Match sessions are ordinary public sessions: any member can see them
  in Find Games. A tournament-only visibility mode does not exist yet.
- Withdrawing a player mid-tournament is not supported (players can
  only be removed while `created`). A withdrawn player's future matches
  stay `pending` and block `advanceRound`/`syncTournament` completion;
  the host's remedy today is `cancelTournament`.
