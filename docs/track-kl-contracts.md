# Tracks K + L — Backend contracts fragment

For consolidation into `RALLYCIRCLE_BACKEND_CONTRACTS.md`. Covers the
security/resilience hardening (K01–K08) and the safe extensions (L01–L15)
on the integrated release candidate. Field types for the underlying
records live in `src/schemas/extensions-schema.ts`,
`src/lib/extensions.ts`, and `src/server/extensions-actions.ts`.

## Transport and identity

- All extension actions are `POST /api/actions/<name>` with a Bearer JWT,
  registered in `src/actions/index.ts`. Identity is always the verified
  caller; a client-supplied `userId` in params is ignored everywhere.
- **Every action response carries `apiVersion: '1'`** (L14): success
  responses have it top-level (`{ success: true, data: {...}, apiVersion:
  '1' }` for `rallyCommand`; inside `data` for the extension actions, which
  return `ActionResult` data). Codex should check it before using a
  feature flag from `appStatus`.
- `appStatus` (L15) returns `{ features: { <flag>: boolean } }` for the
  capabilities actually present in this branch (waitlist, scoreboard,
  courtDiscovery, calendarExport, courtboard, sessionSearch,
  sessionTemplates, favoriteCourts, availabilityWindows, reminders,
  dataExport, matchAudits, matchNotes, chatModeration, waitlistPosition,
  duplicateDetection). No build commit is available at runtime, so none is
  reported. No secrets or internal state are ever returned.

## Track K checklist

| Item | What | Verification |
|---|---|---|
| K01 | Command room rejects fetches without the `X-App-Action: 'true'` internal marker; the action and the geocode caller send it. The marker is defense in depth, NOT the auth boundary (the action's Bearer verification is). A direct `room.fetch` with a forged `userId` and no marker is rejected (the exact N-03 probe). | **Verified by test** (`rally-command-room.test.ts`, K01) |
| K02 | `userId`/`sessionId` length-capped (200) in `parseCommand`; `sessions.chatChannelId` maxLength 200; `sessions.matchScore` maxLength 4000 (server-written JSON, ~2x headroom). All other session text columns already had server-side maxLength (72/100/100/400). Unknown operations, bad enums and out-of-range revisions were already rejected by `parseCommand` + zod. | **Verified by test** (K02) + **code trace** (schema audit) |
| K03 | Per-user, per-session rate limits in the command room: attendance 30/min, score 120/min, cancel 5/min, fixed 60 s windows, in-memory on the DO instance. Exceeding returns `'Too many requests. Try again shortly.'` (HTTP 200 so the action passes the message through). Malformed commands never consume budget. | **Verified by test** (K03: caps trigger, other users unaffected, window resets) |
| K04 | Sensitive-data audit: no server error string contains a user id, token, location, or another user's data; courtboard lookup failures now log the SDK's bounded `loggableError` (8 KB, truncated) instead of the raw error object; `/api/debug/*` is doubly gated (`ALLOW_DEBUG_ROUTES === 'true'` + admin role); the action route logs only the action name + caller id (attribution, server logs only). | **Code trace** (grep of `src/server`, `src/ai/chat-routes.ts`, `worker.ts`) |
| K05 | Malformed JSON → generic 400; oversized body (>64 KB) → generic 400 before parsing; an unexpected throw inside the queued handler (e.g. record room unreachable) → generic `'The session service is temporarily unavailable. Try again.'` and the queue keeps processing the next command; geocode throws → generic 502. No stack trace or internal detail ever leaves the room. | **Verified by test** (K05: malformed, oversized, throwing record room + queue continues) |
| K06 | Courtboard: anonymous handshake fails (token required at the route); authenticated cross-session access denied; per-message re-authorization present in `AppCanvasRoom.onMessage`; cancelled boards read-only (`viewer`). The stale pre-PR #5 security spec now carries an addendum (docs/COURTBOARD_SECURITY.md). | **Verified by test** (cross-session, unknown session, per-call re-evaluation) for the access function; **live two-account handshake unverified** (no test accounts) |
| K07 | Court discovery / geocode review: Overpass + Nominatim hosts are constants; the Nominatim query is URL-encoded via `URLSearchParams`; no user-controlled URL is ever fetched; both upstreams have a 20 s abort timeout; Nominatim is paced ≥1.1 s app-wide; upstream failures map to generic 502s with no body leaked. | **Code trace** (`src/lib/osm.ts`, `src/server/court-discovery.ts`) |
| K08 | Security regression tests for K01/K02/K03/K05/K06 (10 new tests in `rally-command-room.test.ts` + `courtboard-access.test.ts`). | **Verified by test** (see log) |

## Rate limits (K03)

| Class | Operations | Budget |
|---|---|---|
| attendance | `rsvp`, `withdraw`, `joinWaitlist`, `leaveWaitlist` | 30 / user / session / 60 s |
| score | `startMatch`, `scorePoint`, `reviewResult` | 120 / user / session / 60 s |
| cancel | `cancel` | 5 / user / session / 60 s |

Counters are in-memory on the DO instance: object eviction resets them.
That is acceptable for abuse mitigation; authentication does not depend
on them.

## New error strings (exact)

| Error | Meaning | Retryable? |
|---|---|---|
| `'Too many requests. Try again shortly.'` | Rate limit hit (K03) | Yes — after the window |
| `'Invalid rally command.'` | Unparseable command (unknown op, bad enum, over-long ids) | No |
| `'Invalid rally command request.'` | Malformed/oversized body, missing internal marker, wrong path/method | No |
| `'The session service is temporarily unavailable. Try again.'` | Record room unreachable or unexpected room failure | Yes |

All other command-room error strings are unchanged (see Track A contracts).

## Extension actions (L)

All actions take a JSON object in `params` and return
`{ success: true, data: {..., apiVersion: '1'} }` or
`{ success: false, error: <stable string> }`. Identity is always the
verified caller.

| Action | Params | Returns | Auth / caps |
|---|---|---|---|
| `searchSessions` (L01) | `q?`, `format?` (`any`/`singles`/`doubles`/`practice`), `level?`, `fromDate?`/`toDate?` (`YYYY-MM-DD`), `showCancelled?`, `showPast?`, `limit?` (1–50, default 20) | `{ sessions: [{recordId, title, court, location, startsAt, format, level, status}], truncated }` | Any signed-in user. Bounded 200-row scan; cancelled/past excluded by default; sorted by start time. |
| `saveSessionTemplate` (L02) | `template` (or the fields flat): `format`, `court`, `location`, `durationMinutes` (60/90/120/150), `targetPlayers` (2–12), `capacity?` (2–12), `level`, `notes` (≤400), `timeOfDay` (`HH:MM` or `''`) | `{ recordId }` | Own records only; max 20 per user. |
| `listSessionTemplates` | — | `{ templates: [{recordId, ...fields}] }` | Own records only, newest first. |
| `deleteSessionTemplate` | `recordId` | `{ deleted: boolean }` | Own records only; missing → `deleted: false` (idempotent); another user's → failure, no ownership leak. |
| `saveFavoriteCourt` (L03) | `court`: `placeId` (`osm:<node\|way\|relation>/<id>` only), `name`, `lat`, `lng`, `locality?` | `{ recordId, alreadySaved }` | Own records only; max 50; repeat save returns the existing id. |
| `listFavoriteCourts` | — | `{ courts }` | Own records only. |
| `removeFavoriteCourt` | `recordId` | `{ removed: boolean }` | Own records only; missing → `removed: false`. |
| `addAvailabilityWindow` (L04) | `window`: `dayOfWeek` (0–6), `startMinutes`, `endMinutes` (end > start) | `{ recordId, alreadyExists }` | Own records only; max 14; repeat add returns the existing id. Ranking signal only — never verified attendance. |
| `listAvailabilityWindows` | — | `{ windows }` | Own records only. |
| `removeAvailabilityWindow` | `recordId` | `{ removed: boolean }` | Own records only. |
| `upcomingReminders` (L05) | — | `{ reminders: [{sessionId, title, court, location, startsAt, minutesUntilStart}], truncated }` | Own `going` RSVPs, open sessions starting within 24 h. Computed at read time; no records, no cron. |
| `exportMyData` (L06) | — | `{ sessions, rsvps, waitlist, results, templates, favoriteCourts, availabilityWindows, matchNotes, truncated }` | Own records only. `results` are finalized matches only (disputed/unfinalized never exported as results). |
| `myMatchAudits` (L07) | — | `{ audits: [{sessionId, title, status, winner, approvals, disputed, revision}], truncated }` | Only sessions where the caller is a recorded participant. |
| `addMatchNote` (L08) | `sessionId`, `note` (1–280 chars) | `{ recordId }` | Host only; only on finalized matches; max 50 notes per session. |
| `listMatchNotes` | `sessionId` | `{ notes }` | Participants only (host or `going`/`maybe` RSVP). |
| `pinChatMessage` / `removeChatMessage` (L09) | `channelId`, `messageId` | `{ recordId, alreadyApplied }` | Host only (resolved via the session's `chatChannelId`). Overlay rows; SDK chat messages are never mutated. |
| `clearChatModeration` | `channelId`, `messageId`, `action` (`pinned`/`removed`) | `{ cleared: boolean }` | Host only. |
| `listChatModeration` | `channelId` | `{ moderation: [{recordId, messageId, action, actorId}] }` | Participants only. |
| `waitlistPosition` (L10) | `sessionId` | `{ queued: boolean, position: number \| null }` | Any signed-in user; returns **only the caller's own** 1-based position. Queue length and other users' positions are never exposed. |
| `findDuplicateSession` (L12) | `court`, `location`, `startsAt` | `{ duplicate: boolean, sessionId?, title? }` | Own open sessions only. **Advisory**: session creation is a direct client write, so the server cannot block it — the client shows the warning and the host may proceed explicitly. |
| `appStatus` (L15) | — | `{ features: { <flag>: boolean }, apiVersion }` | Any signed-in user. |

## New collections

All five close direct client reads/writes for every role; the actions
above are the only access path.

| Collection | Key columns | Notes |
|---|---|---|
| `sessionTemplates` | `userId` (userBound, owner), `format`, `court` (≤100), `location` (≤100), `durationMinutes`, `targetPlayers`, `capacity?`, `level`, `notes` (≤400), `timeOfDay` (`HH:MM`/`''`) | L02 |
| `favoriteCourts` | `userId` (userBound, owner), `placeId` (`osm:*`, unique with `userId`), `name` (≤200), `lat`, `lng`, `locality` (≤200) | L03 |
| `availabilityWindows` | `userId` (userBound, owner), `dayOfWeek` (0–6), `startMinutes`, `endMinutes` | L04, unique on (`userId`, `dayOfWeek`, `startMinutes`) |
| `matchNotes` | `sessionId`, `authorId` (userBound, owner), `note` (≤280) | L08 |
| `chatModeration` | `channelId`, `messageId`, `action` (`pinned`/`removed`), `actorId` (userBound, owner) | L09, unique on (`channelId`, `messageId`, `action`) |

## What was NOT done (L, explicit)

- **L11 capacity history — not applicable.** `capacity` is an immutable
  column by design, so a capacity change can never happen; there is
  nothing to record. If capacity ever becomes mutable, add an audit row
  at that point.
- **L13 soft-delete — verified, no change needed.** Cancelled sessions
  keep their records and are excluded from discovery by default
  (`filterGames` in `src/lib/find-games.ts`, `searchSessions` here);
  `showCancelled: true` opts back in.
- **L09 scope note:** pin/remove are overlay records, not SDK message
  mutations. The client must apply them when rendering chat (hide
  `removed`, surface `pinned`). If a message id is unknown to the chat,
  the row is inert — the host action does not validate message existence
  against the SDK chat store.

## Known limitations

- Rate-limit counters reset on DO eviction (K03); abuse mitigation only.
- The internal marker (K01) is not a secret and not authentication: it
  only stops a future route from accidentally exposing the DO. The
  action's Bearer verification remains the only auth boundary.
- `matchScore` maxLength 4000 assumes player ids ≤200 chars (enforced by
  the score schema) — ~2x headroom over the worst case.
- Extension list actions return at most 50 rows; scans cap at 200 rows
  with `truncated: true` when the cap is hit.
- `searchSessions` orders by `startsAt` at the RecordRoom level; if the
  live room rejects ordering by a datetime column, fall back to
  in-handler ordering (same caveat as Track B+C's `orderBy: 'finalizedAt'`).
- Live RecordRoom behaviour for the five new collections (`uniqueOn`
  enforcement, `orderBy: 'createdAt'`) is mock-harness only; needs an
  authorized test environment before release.

## Integration notes (for the merge)

- This branch is off `2c2d24f` and does **not** include Track A's D1
  waitlist-delete retry or its harness `orderBy`/`createdAt` fix, nor
  Track G+H's `fillVacancies` changes. The merge must take Track A's
  version of `fillVacancies` and its harness, then re-apply this
  branch's `rally-command-room.ts` changes (marker check, rate limiter,
  bounded body) on top — they touch different parts of the same file and
  the same test harness, which this branch extended with an injectable
  clock, `recordFetchThrows`, and room exposure. Do not drop either
  side's harness changes.
- The `docs/COURTBOARD_SECURITY.md` addendum lives in the prep area
  (`~/workspace/deepspace-interview-prep/docs/`), not in this branch.
