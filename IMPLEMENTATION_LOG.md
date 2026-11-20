# Implementation log — calendar export + backend fixes

Branch: `feature/calendar-export-backend-fixes`, from `8fd8c2c`.
Status: APPLIED and verified — see "Verification run" below.

## Evidence gathered before writing (read-only)

- `maxLength` server enforcement verified in the installed SDK:
  `node_modules/deepspace/dist/schema.d.ts` declares `maxLength?: number`
  ("Maximum text length in UTF-16 code units, enforced before persistence")
  and `dist/worker.js:1577-1585` rejects over-long text on create and update
  (updates skip untouched fields).
- `records.delete` is the internal tool name behind `tools.remove`
  (`src/server/action-routes.ts` maps `remove` to `records.delete`).
- Numeric/date server validation has no SDK primitive: `select` options are
  not validated server-side (`coerceValue`, `worker.js:550-575`). Not fixed.
- `writableFields` cannot be narrowed: the SDK applies it to creates as well
  as updates (NEW_BRANCH_REVIEW N-01). Not attempted.
- Each Phase 6 fix was checked against the base branch before being written:
  R-09, withdraw bypass, R-03 chat silence, R-06, R-08, R-17a, R-07, N-08,
  N-03, R-15 all match the code at 8fd8c2c as cited in ENGINEERING_REVIEW.md
  / IMPROVEMENT_PRIORITIES.md.

## Application notes

- Applied from `~/workspace/deepspace-interview-prep/fullstack/PHASE5-6_IMPLEMENTATION.md`
  (the staged package; the superseded `calendar-fixes.patch` unified diff was
  NOT used). Every search/replace block matched the base verbatim on first
  attempt — no block needed reconciliation.
- One pre-existing fact confirmed during application: `CalendarDays` was
  already imported in `rallies.tsx` (used for the session time display), so
  the new Add to Calendar button needed no new import.
- No other deviations from the package.

## Verification run

Run 2026-11-20 in `~/workspace/deepspace-interview-prep/fullstack/calendar-fixes`
(branch `feature/calendar-export-backend-fixes`, base `8fd8c2c`, Node v24.22.1,
`deepspace@0.44.2`, `node_modules` symlinked from `review-ready-to-play`):

- `node --test tests/rally.test.mjs tests/ics.test.mjs tests/polls.test.mjs` — **32/32 pass**
  (16 baseline + 11 new .ics + 5 new polls).
- `npx vitest run` — **15/15 pass across 4 files** (10 baseline + 5 new
  command-room tests: schema maxLength, withdraw own-row + idempotent,
  withdraw on cancelled session, withdraw racing an RSVP update, structured
  failure when the room is unreachable).
- `npx tsc --noEmit` — clean (exit 0).
- `npm run lint` — clean.
- `npm run build` — passes (vite build 12.15s, prerender wrote 1 page).
- **.ics independent round-trip:** generated a sample file with `buildSessionIcs`
  (DST fall-back day, emoji title, commas/semicolons/backslashes/newlines in
  notes) and parsed it back with the independent Python `icalendar` library
  (installed in an isolated venv at `/tmp/ics-venv`, not in the repo):
  DTSTART 2026-11-01T06:30Z and DTEND 2026-11-01T08:00Z exact, summary/location
  unescaped correctly, description contains the notes with real newlines,
  UID `session-1@rallycircle`, URL correct, every physical line ≤ 75 octets.
  All assertions passed. Sample kept at `/tmp/sample.ics` (ephemeral).
- `git status` — only the intended files changed (5 modified, 6 new);
  no credentials; `dist/` is gitignored.
- Withdraw race and chat-retry paths are covered at unit/integration level
  by the new vitest tests (race test asserts ≤ 1 row and one consistent
  terminal state; unreachable-room test asserts the structured failure).
  The chat retry reusing one channel id is a UI path — covered by code
  inspection (retry calls only `putConfirmed` with the stored channel id,
  never `createChannel`); a live fault-injection check still needs a
  running app with two accounts.

## What remains unverified

- Import of a generated .ics into a real calendar client (Google/Apple/
  Outlook) — the file parses cleanly with an independent RFC 5545 parser,
  but no real client import was performed.
- Live two-account checks: withdraw race against a real Durable Object,
  forced chat-channel failure + retry reusing one channel, cancelled-chat
  read-only in the browser, .ics download click in the UI.
- `deepspace test run` (api/e2e suites) — needs SDK test accounts; not
  attempted here, same as prior reviews.
