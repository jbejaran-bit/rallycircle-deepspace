# Live Match Scoreboard — feature README

Branch: `feature/match-scoreboard` (from `feature/ready-to-play` @ `8fd8c2c`).
Spec: [issue #6](https://github.com/jbejaran-bit/rallycircle-deepspace/issues/6).

## What it is

A scoreboard card inside the session detail. The host records the match
result; every signed-in participant sees it live. Scores are shared by the
host and are **not official or validated** by any sports organization — the
card says so on every render.

- Team A vs Team B (free names, 1–40 chars), singles/doubles is just the
  names the host types (e.g. "Alice / Bob").
- Match status: Not started / In progress / Final.
- Set-by-set game scores (up to 3 sets, completed sets only: 6–0…6–4, 7–5,
  7–6). No point-by-point engine in this MVP.
- Optional deciding **match tiebreak (first to 10, win by 2)**, kept
  distinct from game scores; only valid when the sets are split 1–1.
- Host-only editing, including explicit corrections of a final score.
- Results persist per session (not client-local) and survive reload.

## Data model

Collection `matchScores` (`src/schemas/scoreboard-schema.ts`), one record
per session (`uniqueOn: ['sessionId']`):

| Column | Type | Notes |
|---|---|---|
| `sessionId` | text, immutable | the session this board belongs to |
| `teamAName`, `teamBName` | text, maxLength 40 | |
| `status` | select: not_started / in_progress / final | |
| `sets` | text, JSON interpretation | `[{a,b}, …]` — SDK stringifies on write, parses on read |
| `matchTiebreak` | text, JSON interpretation | `{a,b}` or null |
| `version` | number | optimistic-concurrency token, starts at 1 |
| `updatedBy` | text | verified user id stamped by the server action |

`updatedAt` comes from the record itself. The model is versioned by
design: a future point-by-point mode can add a `points`/`games`
structure inside each set entry (and bump a format version) without
changing the collection or the write path.

Direct client writes are closed for **every** role (`create/update/delete:
false` for member and admin); members can read. All writes go through
the `rallyCommand` server action.

## Authorization & validation (server-side)

`src/server/rally-command-room.ts`, operation `scoreboard`, reusing the
existing per-session `RallyCommandRoom` Durable Object queue — so a
scoreboard write is serialised with RSVP/cancel commands for the same
session, and the check-then-write is atomic within that queue.

1. Session must exist; the caller must be the session's host
   (`session.hostId === userId`, where `userId` comes from the verified
   Bearer token — a forged `userId` in the body is ignored, same as RSVP).
2. Cancelled sessions reject scoreboard writes.
3. The write is validated by `validateScoreboardInput`
   (`src/lib/scoreboard.ts`, shared by the client form and the server):
   team-name lengths, set scores follow tennis rules, tiebreak only on a
   1–1 split and first-to-10/win-by-2, status transitions (a final match
   stays final; an in-progress match cannot already have a winner; a
   not-started match cannot have sets; a final match needs a winner).
4. A write to a session the caller does not host is rejected — the
   command is always scoped to the `sessionId` it names, and the host
   check uses that session's stored `hostId`. There is no way to address
   another session's board.

## Conflict policy

**Optimistic concurrency with a surfaced conflict — never a silent
overwrite.** Each write carries `expectedVersion` (the version the editor
read). The server compares it with the stored version inside the
serialised queue:

- Match → the write applies and `version` increments by 1.
- Mismatch → the server returns `Conflict: This score was updated by
  someone else…`. The client closes the editor, shows that message, and
  the live `useQuery` subscription already shows the latest score, so
  the host can review and save again.
- An identical re-save is an idempotent no-op: success, no version bump.

Two simultaneous edits therefore end with exactly one winner and one
explicit conflict error (verified live, see `IMPLEMENTATION_LOG.md`).

## Corrections

A final match can only be changed with the correction checkbox ticked
(client) and `correction: true` (server). Without it the server rejects
the change. A correction bumps `version` and re-stamps `updatedBy` /
`updatedAt`, so the audit trail is preserved. A final match cannot be
reopened to in-progress / not-started.

## UI

`src/components/MatchScoreboard.tsx`, rendered in `SessionDetail`
(`rallies.tsx`, two lines added). States: loading, empty ("No score
yet"), error, disconnected ("Reconnecting — the score shown may be out
of date", from presence), save-failure (inline error, form stays open),
conflict (notice + editor closes, latest score shown). The form is
labelled and keyboard-accessible (fieldset/legend for sets, `aria-label`
on every set/tiebreak input, `role="alert"` errors). Layout stacks on
mobile; number inputs use `inputMode="numeric"`.

## How to test locally

```sh
git worktree add /tmp/sb-check 8fd8c2c   # or use this branch
npm run validate        # tsc + vitest (17 tests, incl. 7 scoreboard server tests)
node --test tests/rally.test.mjs tests/scoreboard.test.mjs   # 32 tests
npm run lint && npm run build
```

Two-account browser test (needs two DeepSpace CLI test accounts):

```sh
npx deepspace test run tests/scoreboard.spec.ts
```

It covers the issue's acceptance list: host creates, participant sees
it live, host edits, participant sees the update without refresh,
non-host denied, invalid scores rejected, refresh preserves the score,
corrections saved, RSVP/chat regression.

A local end-to-end probe against `wrangler dev --local` with minted
ES256 test JWTs verified the real worker + real RecordRoom (22/22
checks: host create, persistence + JSON round-trip, non-host denied,
invalid rejected, concurrent conflict, correction, idempotent re-save,
tiebreak, RSVP regression, cross-session rejected). See
`IMPLEMENTATION_LOG.md` for the exact commands; it needs a local keypair
and `ALLOW_DEBUG_ROUTES=true` — nothing production.

## Known limitations

- No point-by-point scoring (by design for the MVP).
- No per-player stats, no "who won which set" beyond the scoreline.
- The two-account Playwright spec and real-browser screenshots are
  **unverified here** — they need `deepspace test run` with two CLI test
  accounts, which this environment does not have.
- Direct client-write denial is asserted via the SDK's permission
  helpers in vitest, not via a live RecordRoom write attempt (the live
  probe exercised the server-action path, which is the only write path
  the UI uses).
- The scoreboard form's "Add score" button is host-only in the UI; the
  server is the enforcement point, as with RSVP.
