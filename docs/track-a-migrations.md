# Track A — Additive schema migration checklist

**Scope:** sessions, RSVPs, match scores, waitlist records on the integrated
release candidate (`2c2d24f`). **No migration was run here** (no production,
no test app upgrade performed). This checklist is for the authorized
environment before any rollout.

## What changed in the schema (this branch: nothing)

Track A adds **no schema change**. The only production-code change is the
in-command retry of the waitlist delete in `fillVacancies`
(`src/server/rally-command-room.ts`); all other changes are tests, a pure
helper (`isEligibleForStats`), and docs. The schema below is the integrated
state at `2c2d24f`, listed so the rollout can be checked field by field.

## Current additive fields (all optional, all defaulted)

| Collection | Field | Type | Default / absence behaviour | Backfill needed? |
|---|---|---|---|---|
| `sessions` | `format` | select Singles/Doubles/Practice | absent → `undefined`; match start is rejected until the host sets it via the member-writable field; readiness falls back to target-based inference | No |
| `sessions` | `capacity` | number, immutable | absent → unlimited (open participation); `validCapacity` 2–12 enforced on new values; an invalid stored value fails RSVP commands with "invalid capacity" (fails closed) | No |
| `sessions` | `matchScore` | text (JSON) | absent → no scoreboard; `readMatchScore` returns `null` on absent or unparseable JSON | No |
| `sessions` | `title`/`court`/`location`/`notes` | text, `maxLength` 72/100/100/400 | enforced server-side on create/update; a pre-existing over-long row fails its next update (none should exist — the UI always capped these) | Check live data for over-long rows before deploying |
| `waitlists` | whole collection | `sessionId` + `userId` (`userBound`, `uniqueOn`) | new collection; no rows exist for old sessions | No |

## Pre-rollout checks (authorized test app)

1. Deploy the worker + client together; confirm `deepspace.migrations.json`
   still declares the same bindings and no migration IDs changed (app ID and
   bindings are unchanged in this branch).
2. Create a fresh session and an old-style session (fields omitted) in the
   test app; verify RSVP, waitlist join, cancel, score start, and calendar
   download all behave (the A15 test covers this offline).
3. Verify SQLite schema upgrade against pre-existing test records: open a
   session created before `format`/`capacity`/`matchScore` existed and
   confirm it reads, RSVPs, and cancels without error.
4. Confirm `waitlists` collection registration and rollout ordering with the
   new client and worker (per MUSE_INTEGRATION_REVIEW.md).
5. Confirm no over-long `title`/`court`/`location`/`notes` rows exist in live
   data (see above); if any exist, shorten them before rollout or accept
   that their next update will be rejected.
6. Run the two-account checks in TESTING_GUIDE.md: join, full-session third
   account, withdrawal promotion, live score across two browsers, refresh,
   result confirmation.

## Rollback

All Track A changes are additive and behaviour-preserving except the D1
retry (strictly more resilient). Rolling back the worker to `2c2d24f` is
safe: no stored data depends on the new code (no new fields, no new
collection, no format change to `matchScore` JSON). Waitlist rows created
while the new code ran remain valid under the old code (the old code repairs
stale rows on the next command).
