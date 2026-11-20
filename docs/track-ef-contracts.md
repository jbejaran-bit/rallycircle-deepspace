# Tracks E+F — Social graph & smart match discovery: backend contracts for Codex

Baseline: `integration/rallycircle-muse-review` @ `2c2d24f93daf751108986a45cba1ccb5440044ec`.
Branch: `feature/muse-social-matchmaking` (worktree `fullstack/track-ef`).
Status: implemented and tested locally; **not merged, not deployed**. Two-account
browser tests unverified (no test accounts in this environment).

## What this adds

- **Track E — friends/followers/community:** follow/unfollow, block/unblock,
  paginated followers/following, mutual follows, "played with" derived from real
  match records, a privacy-aware public activity feed, content reports, and
  server-side anti-spam limits.
- **Track F — smart match discovery:** per-user discovery preferences plus
  `discoverGames`, a ranked extension of the existing Find Games filter
  (`src/lib/find-games.ts`, unchanged). Find Games itself is **not replaced**.

## Files

| File | Contents |
| --- | --- |
| `src/schemas/social-schema.ts` | `follows`, `blocks`, `reports`, `discoveryPreferences` schemas |
| `src/lib/social.ts` | Pure logic: validation, encoding, pagination, played-with, feed, ranking, notification draft |
| `src/server/social-actions.ts` | 13 action handlers (see below) |
| `src/lib/social-actions.ts` | Typed client wrappers for all 13 actions |
| `src/schemas.ts` | Registers the four new schemas |
| `src/actions/index.ts` | Spreads `socialActions` next to `rallyCommand` |
| `src/lib/social.test.ts` | 14 Vitest tests (pure logic) |
| `src/server/social-actions.test.ts` | 22 Vitest tests (handlers, in-memory mock `ActionTools`) |
| `tests/social.test.mjs` | 7 Node headline tests |
| `scripts/social-bench.mjs` | Synthetic benchmark (F12) |

## Schemas (all member writes closed; server actions only)

All four collections have `member` create/update/delete **false**. Reads are
scoped per collection (see below). Columns are `number | text` only; JSON
arrays are stored as JSON text.

### `follows`
| Column | Type | Notes |
| --- | --- | --- |
| `followerId` | `userBound` | Verified caller id, stamped by the platform |
| `followeeId` | text | Target user id; `uniqueOn: [followerId, followeeId]` |

Member read: `true` (needed for public follower/following lists; a block hides
lists — see semantics). A follow row is a public relationship between two ids;
it never carries private data.

### `blocks`
| Column | Type | Notes |
| --- | --- | --- |
| `blockerId` | `userBound` | Verified caller id |
| `blockedId` | text | Blocked user id; `uniqueOn: [blockerId, blockedId]` |

Member read: `'own'` only. Block direction is never leaked: list endpoints
return `hidden: true` when either direction of a block exists, with no
indication of who blocked whom.

### `reports`
| Column | Type | Notes |
| --- | --- | --- |
| `reporterId` | `userBound` | Verified caller id |
| `targetType` | text | `user` \| `session` \| `content` |
| `targetId` | text, maxLength 200 | Reported entity id |
| `reason` | text, maxLength 500 | Free-text reason, required |
| `status` | text, default `open` | `open` \| `reviewed` \| `dismissed` |

Member read: `'own'` only. **No moderator tooling exists yet.** Reports are
stored, never actioned automatically. A moderator role and review UI are a
named follow-up; do not build moderation reads into the client until that
role is defined server-side.

### `discoveryPreferences`
| Column | Type | Notes |
| --- | --- | --- |
| `userId` | `userBound`, `uniqueOn: [userId]` | One row per user |
| `formats` | text | JSON array of `Singles` \| `Doubles` \| `Practice` (max 3, deduped) |
| `level` | text | `All levels` \| `Beginner` \| `Intermediate` \| `Advanced` |
| `area` | text, maxLength 100 | Free-text playing area (e.g. "Schenley") |
| `radiusMiles` | number | Integer 1–100 |
| `timeStart` / `timeEnd` | text | `HH:MM`, both or neither, start < end, no overnight windows |
| `days` | text | JSON array of 0–6 (Sunday = 0), deduped |

Member read: `'own'` only. Preferences are the user's own record; only the
owner can read or write them (via the actions below). Malformed stored data
decodes to defaults — never crashes the caller.

## Actions (all in `src/server/social-actions.ts`)

Every action derives the caller from the verified Bearer token
(`tools.userId`); a client-supplied `userId` in params is **ignored**.
Every action returns `{ success: true, ... }` or
`{ success: false, error: string }`. No action writes to a collection the
caller could write to directly.

| Action | Params | Returns | Notes |
| --- | --- | --- | --- |
| `followUser` | `{ followeeId }` | `{ success, alreadyFollowing?, notification? }` | Idempotent; duplicate follow is a no-op returning the existing relationship. Rate limit 30/min; total cap 500 follows. Blocked in either direction → vague `'This player is not available.'` |
| `unfollowUser` | `{ followeeId }` | `{ success }` | Idempotent; unfollow of a non-relationship is a no-op success. Deletes the row. |
| `blockUser` | `{ userId }` | `{ success }` | Severs follows in both directions (`deleteWhere`). Self-block rejected. |
| `unblockUser` | `{ userId }` | `{ success }` | Idempotent. Does **not** restore severed follows. |
| `reportContent` | `{ targetType, targetId, reason }` | `{ success, reportId? }` | Cap 20/hour per reporter. Validated `targetType`, `targetId` ≤ 200, `reason` ≤ 500 and non-empty. |
| `getFollowers` | `{ userId, limit?, cursor? }` | `{ success, followers: { userId }[], nextCursor, hidden? }` | Cursor = `createdAt` of the last row; `limit` default 20, max 50. `hidden: true` across a block. |
| `getFollowing` | same | same shape | Same pagination and block semantics. |
| `getMutualFollows` | `{ userId }` | `{ success, mutual: { userId }[], hidden? }` | Intersection of both following lists (bounded: 200 each). `hidden: true` across a block. |
| `getPlayedWith` | `{ userId? }` | `{ success, playedWith: PlayedWithEntry[] }` | Defaults to the caller. See "Played with" below. |
| `getActivityFeed` | `{ followedOnly?, limit? }` | `{ success, events: ActivityEvent[] }` | `limit` default 50, max 100. See "Activity feed". |
| `saveDiscoveryPreferences` | `{ preferences }` | `{ success }` | Upsert of the caller's own row. Validated by `validatePreferences`. |
| `getDiscoveryPreferences` | `{}` | `{ success, preferences: DiscoveryPreferences \| null }` | `null` when never saved. |
| `discoverGames` | `{ strictLevel? }` | `{ success, games: RankedGame[], truncated? }` | Loads prefs + followed hosts + up to 200 open sessions + up to 500 RSVPs. `truncated: true` when a window is hit. |

```ts
interface PlayedWithEntry {
  userId: string
  sharedSessions: number      // sessions both attended (RSVP 'going')
  matchesTogether: number     // finalized matches on the same team
  matchesAgainst: number      // finalized matches on opposing teams
  lastPlayedAt: string | null // ISO timestamp of the most recent shared session
}
```

```ts
interface ActivityEvent {
  type: 'session-created' | 'match-finalized'
  sessionId: string
  hostId: string
  startsAt: string
  createdAt: string
}
```

```ts
interface DiscoveryPreferences {
  formats: ('Singles' | 'Doubles' | 'Practice')[]
  level: 'All levels' | 'Beginner' | 'Intermediate' | 'Advanced'
  area: string
  radiusMiles: number
  timeStart: string | null
  timeEnd: string | null
  days: number[] // 0 = Sunday
}
```

```ts
type DiscoveryReason =
  | 'level-match' | 'level-open' | 'level-gap'
  | 'format-match' | 'format-other'
  | 'nearby' | 'area-match'
  | 'time-match' | 'day-match'
  | 'needs-players' | 'target-reached' | 'session-full'
  | 'doubles-ready' | 'followed-host'

interface RankedGame extends AnnotatedGame { // AnnotatedGame: see src/lib/find-games.ts
  score: number
  reasons: DiscoveryReason[] // ordered by REASON_ORDER; render as labels, e.g. 'level-match' -> "Matches your level"
}
```

## Discovery ranking (`rankGames` in `src/lib/social.ts`)

Deterministic sort: score desc, `startsAt` asc, `recordId` asc. Points:

| Signal | Points | Reason |
| --- | --- | --- |
| Session level == preferred level | +40 | `level-match` |
| Session level is "All levels" | +15 | `level-open` |
| Two-step level gap (self-reported levels only) | −30 | `level-gap` |
| Format matches a preferred format | +30 | `format-match` |
| Format does not match | −10 | `format-other` |
| Known court within radius | +20 | `nearby` |
| Court/location text matches preferred area | +15 | `area-match` |
| Starts inside the time window | +10 | `time-match` |
| Starts on a preferred day | +5 | `day-match` |
| Needs players (`going < targetPlayers`) | +10 | `needs-players` |
| Target reached | +5 | `target-reached` |
| Session full | −15 | `session-full` |
| Doubles with ≥ 4 going | +10 | `doubles-ready` |
| Host is followed by the viewer | +10 | `followed-host` |

Rules that matter for the client:

- **One-step level gap is neutral** (no points, no reason). Only a two-step
  gap is demoted. With `strictLevel: true`, two-step-gap games are excluded
  entirely instead of demoted.
- **Skill data is self-reported only.** There is no verified rating in this
  base and the experimental Track D rating must never be used here.
- **Time windows are matched in UTC in v1** — the server does not know the
  viewer's IANA zone. Tell viewers to set the window in UTC, or store the
  viewer's zone in a follow-up (named in the log).
- **No distance is ever fabricated.** `distanceMiles` is `null` unless the
  session's court has known coordinates (from the existing court data); a
  game with unknown coordinates simply gets no `nearby` points.
- **Upcoming only.** Cancelled and past sessions are excluded before ranking.
  Capacity state comes from the integrated capacity/waitlist state
  (`going`/`targetPlayers`), not from a separate count.
- **Fallback when little is known:** with no preferences saved, ranking is
  driven by availability/capacity/doubles-readiness alone, which is the
  intended useful default.

## Played with (`derivePlayedWith`)

- Shared sessions: both users have an RSVP with status `going` on the same
  session. Cancelled sessions are excluded.
- Matches together/against: derived **only** from finalized results —
  `resultStatus()` must be `'final'` (winner set, every player approved).
  Disputed or unconfirmed results never count. Singles and doubles are both
  handled (doubles uses team membership).
- Blocked players are hidden from the result. Querying another user is
  allowed (it is derived from public match records), but blocked players are
  filtered out.

## Activity feed (`deriveActivityFeed`)

- Events are genuinely public only: `session-created` (open sessions) and
  `match-finalized`. Cancelled sessions never appear. No private-chat
  memberships or restricted sessions are ever exposed — there is no private
  session flag in this base; **if one is ever added, the feed must exclude
  private sessions** (TODO noted in code).
- `followedOnly: true` (default) shows only followed players' events.
  Blocked actors are excluded.
- Feed order is newest first by `createdAt`; same-session events keep
  insertion order (session-created before match-finalized).

## Block semantics (exact)

1. `blockUser` deletes follow rows in **both** directions. Unblocking does
   **not** restore them — both users must re-follow.
2. While a block exists in either direction: neither user can follow the
   other; `getFollowers` / `getFollowing` / `getMutualFollows` return
   `{ hidden: true }` (empty lists, no direction leaked); the blocked
   player's activity is hidden from the blocker's feed and vice versa;
   `getPlayedWith` filters blocked players out.
3. Follow attempts across a block fail with the vague message
   `'This player is not available.'` — never `'You are blocked'` or
   `'You blocked this player'`.
4. Reports are unaffected by blocks (a blocked user can still be reported).

## Anti-spam limits (server-side, E10)

- Follow: 30 new follows per rolling minute per user; 500 total follows per
  user. Unfollow is not rate-limited (it is a deletion).
- Reports: 20 per hour per reporter.
- All list endpoints are bounded (`limit` defaults 20/50, max 50/100);
  `discoverGames` is bounded to 200 sessions / 500 RSVPs with a `truncated`
  flag. No unbounded social query exists in this feature.

## Notifications seam (E13, for Track H)

There is **no notifications collection in this base** — nothing is persisted
here. `followUser` returns a `notification` draft built by the pure function
`buildFollowNotification(followerId, followeeId, now)` in `src/lib/social.ts`:

```ts
interface FollowNotificationDraft {
  type: 'follow'
  recipientId: string   // the followed user
  actorId: string       // the follower
  deepLink: string      // `/players/<actorId>`
  createdAt: string     // ISO
}
```

Track H should persist this draft through the real notification mechanism
when it lands, keyed by `recipientId`. Do **not** invent a notifications
collection in this branch. Unfollow does not emit a notification.

## Profile seam (do NOT depend on Track B+C)

There is **no profile collection in this base**. Wherever the client needs a
display name, resolve it against the profile store if it exists and degrade
to the bare user id when it does not. The server never fabricates a display
name. `getPlayedWith`, feed events, and follower lists all return user ids
only.

## Data retention (E14)

- Unfollow deletes the follow row (hard delete via `tools.remove`).
- Block/unblock: block rows persist until `unblockUser` deletes them; the
  follow rows a block severed are **not** recoverable.
- Reports persist until a moderator deletes them (no moderator tooling yet).
- Preferences persist as the user's own row until overwritten or deleted
  (no delete endpoint in v1 — add one if the client needs "clear
  preferences"; overwriting with defaults is the current equivalent).
- **Account deletion boundary:** no account-deletion flow exists in this
  base. When one is built, it must cascade-delete the user's `follows`
  (both directions), `blocks` (both directions), `reports` (as reporter),
  and `discoveryPreferences` rows. This feature does not implement it.

## Client wrappers (`src/lib/social-actions.ts`)

Typed wrappers around `callAction` for all 13 actions, with `getAuthToken`
and 401 handling. Use these from the UI; do not call the action endpoints
by hand. Example:

```ts
import { followUser, discoverGames, getDiscoveryPreferences } from '@/lib/social-actions'

const res = await followUser('user-123')
if (!res.success) showToast(res.error)

const games = await discoverGames({ strictLevel: false })
```

## Known limitations / follow-ups

1. Time windows match in UTC (v1). Store the viewer's IANA zone as a
   follow-up if the client needs local-time matching.
2. Discovery is bounded (200 sessions / 500 RSVPs); `truncated: true`
   signals a partial result. Pagination of discovery results is a follow-up.
3. No moderator tooling: reports are stored, not actioned.
4. No notifications collection: follow notifications are drafts for Track H.
5. No profile collection: display names degrade to user ids.
6. No two-account runtime verification (no test accounts); handler behaviour
   is verified with the in-memory mock `ActionTools` harness in
   `src/server/social-actions.test.ts`.
7. `getPlayedWith` for another user is allowed by design (public match
   records); if product wants it self-only, gate it in the handler — the
   pure function needs no change.
8. Level data is self-reported; never present it as verified skill.
