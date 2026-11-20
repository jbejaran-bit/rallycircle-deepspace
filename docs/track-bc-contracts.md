# Track B + C — Backend contracts (profiles, results, statistics)

Source branch (staged): `feature/muse-profiles-results`, base
`integration/rallycircle-muse-review` @ `2c2d24f`. For consolidation into
`RALLYCIRCLE_BACKEND_CONTRACTS.md`. All types are TypeScript; field types
below are the wire types.

## 1. Collections (new, additive — no existing collection changes)

### `profiles` — one public profile per player
| Field | Type | Notes |
|---|---|---|
| `userId` | `string`, userBound, immutable, required | Verified auth identity. Never client-supplied. |
| `displayName` | `string`, required, max 40 | Trimmed. |
| `bio` | `string`, default `''`, max 280 | |
| `formats` | JSON array of `'Singles' \| 'Doubles' \| 'Practice'` | Stored as a JSON column. |
| `preferredArea` | `string`, default `''`, max 100 | General area only, e.g. `"Pittsburgh, PA"`. Coordinates rejected. |
| `selfReportedLevel` | `'Unrated' \| 'Beginner' \| 'Intermediate' \| 'Advanced'`, default `'Unrated'` | **Self-reported, never a verified rating.** Label it as such in UI. |
| `visibility` | `'public' \| 'private'`, default `'public'` | Record-level privacy (see §4). |

`uniqueOn: ['userId']`, `ownerField: 'userId'`.
Permissions: `*` all false; `member` read `'published'`, create/update/delete
false; `admin` read true. All writes go through the `updateProfile` /
`deleteProfile` actions — direct client writes are closed for every role.

### `playerStats` — incremental per-player, per-format statistics
| Field | Type | Notes |
|---|---|---|
| `userId` | `string`, userBound, immutable, required | |
| `format` | `'singles' \| 'doubles'`, immutable, required | Never mixed. Practice has no row. |
| `wins` / `losses` / `matchesPlayed` | `number`, default `0` | From finalized results only. |
| `visibility` | `'public' \| 'private'`, default `'public'` | Mirrored from the profile at write time. |

`uniqueOn: ['userId', 'format']`, `ownerField: 'userId'`, `visibilityField`
`{ field: 'visibility', value: 'public' }`. Same permissions as `profiles`.
Written only by the RallyCommandRoom at finalization/correction time.

### `matchResults` — one row per player per finalized result
| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string`, immutable, required | |
| `userId` | `string`, userBound, immutable, required | |
| `format` | `'singles' \| 'doubles'`, immutable, required | |
| `won` | `number` (0/1) | |
| `sets` | JSON array of `[number, number]` | e.g. `[[6,4],[6,3]]` |
| `resultRevision` | `number`, required | The `matchScore` revision that finalized. |
| `finalizedAt` | `string` (ISO datetime) | |
| `visibility` | `'public' \| 'private'`, default `'public'` | Mirrored from the profile. |

`uniqueOn: ['sessionId', 'userId']`, `ownerField: 'userId'`,
`visibilityField` as above. Same permissions. Updated in place on
correction (new `resultRevision`); the superseded outcome survives only in
`resultAudits`.

### `resultAudits` — minimal audit trail
| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string`, immutable, required | |
| `userId` | `string`, userBound, immutable, required | The actor (approver/host). |
| `kind` | `'finalized' \| 'disputed' \| 'corrected'`, immutable, required | |
| `detail` | `string` (JSON, max 1000 chars) | `{ sets, winner, revision }` (+ previous outcome for `corrected`). |
| `resultRevision` | `number`, required | |

`ownerField: 'userId'`. Permissions: `member` read `true` (audit rows
describe sessions members can already read), create/update/delete false.

## 2. Result states (extends the existing workflow)

`resultStatus(matchScore)` returns: `in-progress` → `proposed` (winner,
no approvals) → `confirmed` (some approvals = **pending confirmation**) →
`final` (every recorded participant approved). `disputed` locks the result.
New: `corrected` — a previously finalized or disputed result the host
corrected; it awaits fresh approval from every participant before it can
finalize again.

New command: `correctResult` (via the existing `rallyCommand` action).
Host-only, only from `final` or `disputed`, with a complete corrected
scoreline (`sets`: 2–3 valid sets, winner won exactly 2; valid set =
6–0..6–4, 7–5, or 7–6). It resets approvals, clears the dispute flag,
bumps `revision`, increments `correctionCount`, and reverses the old
stats. Corrections never silently change confirmed history: the old
outcome is preserved in a `corrected` audit row.

## 3. Actions

All actions are `POST /api/actions/<name>` with a Bearer token; 401 without
one. The caller identity always comes from the verified token.

### `updateProfile`
Params (all validated server-side with zod):
```ts
{
  displayName: string,      // 1–40 chars, trimmed
  bio: string,              // ≤ 280 chars
  formats: ('Singles'|'Doubles'|'Practice')[],
  preferredArea: string,    // ≤ 100 chars, not coordinates
  selfReportedLevel: 'Unrated'|'Beginner'|'Intermediate'|'Advanced',
  visibility: 'public'|'private',
}
```
Success:
```ts
{ success: true, data: { recordId: string, unchanged: boolean, completeness: ProfileCompleteness } }
```
`unchanged: true` when an identical re-save is a no-op (idempotent).
Failure: `{ success: false, code: 'invalid_profile', error: string }` or
code `profile_unavailable`. Any `userId` in params is ignored.

### `deleteProfile`
Params: `{}`. Success: `{ success: true, data: { deleted: boolean } }`
(`deleted: false` when no profile existed — idempotent). Also marks the
caller's stats/results rows private. Failure code: `profile_unavailable`.

### `getPlayerStats`
Params: `{ userId: string }`. Success (public or owner):
```ts
{
  success: true,
  data: {
    userId: string, public: true,
    profile: { displayName, bio, formats, preferredArea, selfReportedLevel, visibility } | null,
    completeness: ProfileCompleteness,
    stats: { singles: PlayerStatsSummary, doubles: PlayerStatsSummary },
  }
}
```
Private profile, other caller: `{ success: true, data: { userId, public: false } }`
(no stats, no profile). Failure codes: `invalid_user`, `stats_unavailable`.

```ts
interface PlayerStatsSummary {
  userId: string; format: 'singles' | 'doubles';
  wins: number; losses: number; matchesPlayed: number;
  winRate: number | null;          // null when 0 matches
  provisional: boolean;            // true when matchesPlayed < 5
  visibility: 'public' | 'private';
}
interface ProfileCompleteness { percent: number; missing: string[]; complete: boolean }
```
`percent` is 0–100 in steps of 20 (five fields: displayName, bio, formats,
preferredArea, selfReportedLevel). `missing` lists unfilled field keys for
onboarding UX.

### `getMatchHistory`
Params: `{ userId: string, limit?: number }` (default 20, clamped 1–50).
Success:
```ts
{ success: true, data: { userId: string, public: boolean, entries: MatchHistoryEntry[] } }
interface MatchHistoryEntry {
  sessionId: string; format: 'singles' | 'doubles'; won: boolean;
  sets: Array<[number, number]>; finalizedAt: string; resultRevision: number;
}
```
Entries are newest-first, finalized results only. Private profile, other
caller: `{ public: false, entries: [] }`. Failure codes: `invalid_user`,
`history_unavailable`.

## 4. Privacy model (what the SDK does and does not support)

Verified against `deepspace@0.44.2` (`dist/worker.js`):
- `read: 'published'` + `visibilityField: { field: 'visibility', value: 'public' }`
  = owner OR rows whose visibility is `'public'`. This is a real,
  record-layer control: a private profile/stats/results row is unreadable
  to other members even through direct record reads.
- There is **no per-field read permission** — permission checks are
  per record. Separation is therefore structural: private account data
  (email, etc.) stays in `users` (read `'own'`) and is never copied into
  `profiles`; every field in `profiles` is public-by-design.
- No profile record = no public presence (third state).
- Honest boundary: session records themselves are member-readable by
  design, so a match score visible inside a session a member can read is
  not hidden by making a profile private. What privacy *does* hide is the
  profile itself, the stats summaries, and the match-history listing
  (both at the action layer and, for stats/results rows, at the record
  layer via mirrored `visibility`).
- Geography: `preferredArea` is a general area name only. Coordinates,
  street addresses, and residential addresses are rejected by validation.
  Exact device coordinates are never stored.

## 5. Statistics rules (for Codex display copy)

- Only **finalized** results count (every recorded participant approved).
  Disputed results never count. Practice matches never count.
- Singles and doubles are separate; never combine them in one record.
- `provisional: true` below 5 matches — display as "provisional" and do
  not present the record as established.
- `selfReportedLevel` is self-reported. Never present it as a verified
  rating, and never present win/loss records as a rating.
- Stats are maintained incrementally at finalization time (no full-table
  scans in the hot path). A repair pass (`reconcilePlayerStats`) recomputes
  one player's row from their `matchResults` rows if a partial failure ever
  leaves them inconsistent.

## 6. Subscriptions (real-time behaviour)

- `profiles`, `playerStats`, `matchResults`, `resultAudits` are ordinary
  DeepSpace record collections: Codex reads them with the standard
  `useQuery` subscription; updates propagate live to subscribed clients.
  The `matchScore` JSON column on `sessions` already carries the live
  result state (`resultStatus`, approvals, dispute flag, correction count).
- Frontend states to handle: profile missing (onboarding prompt),
  profile private (viewer sees "private" placeholder, no stats),
  result `proposed` / `confirmed` (awaiting approvals) / `disputed`
  (locked, show dispute state) / `corrected` (awaiting fresh approvals) /
  `final` (stats applied).
- No new WebSocket routes. No new Durable Object.

## 7. Error codes (stable)

| Code | Meaning |
|---|---|
| `invalid_profile` | Profile input failed validation (message names the problem). |
| `profile_unavailable` | The profile could not be read/saved/deleted (transient — retry). |
| `invalid_user` | Missing/over-long player id in a read action. |
| `stats_unavailable` / `history_unavailable` | The stats/history query failed (transient — retry). |
| (rallyCommand errors, unchanged) | e.g. `'Only the session host can edit the score.'`, `'The score changed. Check the latest score before trying again.'`, `'This result is closed or unavailable for your review.'` |

## 8. Migration requirements

- Additive only: four new collections, no existing collection changed, no
  backfill, no app-ID change, no new Durable Object or binding.
- Existing sessions, RSVPs, match scores, and waitlist records are
  untouched. Legacy sessions without a `format` contribute no statistics
  (format `null` → skipped); their scores still finalize exactly as before.
- Old `matchScore` JSON without `correctionCount` still parses: the field
  has a zod default of `0`.
- Registration required (see APPLY.md): add the four schemas to
  `src/schemas.ts` and the four actions to `src/actions/index.ts`; extend
  `rally-command-room.ts` with the `correctResult` branch and the
  finalization hooks.

## 9. Fixtures

`src/lib/track-bc-fixtures.ts` exports typed examples:
`exampleProfile`, `examplePrivateProfile`, `exampleProfileCompleteness`,
`exampleSinglesStats`, `exampleDoublesStats`, `exampleHistory`,
`examplePlayerStatsResponse`, `examplePrivateStatsResponse`,
`exampleMatchHistoryResponse`. Copy verbatim for UI development.
