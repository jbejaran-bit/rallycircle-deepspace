# Release hardening review

The review branch starts at PR #19. It preserves the existing scoring engine, record schemas, and scheduling command path.

| Status | Scope |
| --- | --- |
| Locally verified | TypeScript, lint, build, public navigation and responsive layout, SDK permission helpers, poll and result fault injection, and recurring-series action tests |
| Verified in an authorized DeepSpace runtime | Pending access to a disposable test app and authorized test accounts |
| Integrated and awaiting runtime verification | Private profiles, committed history and statistics, result correction and audit, poll and result alarms, calendar, inbox, recurring drafts and publication |
| Experimental | Ratings, social graph, matchmaking, clubs, tournaments, advanced extensions, spectator video |

## Reliability and migration

The committed scoreboard is the source of truth. The player index is written before score commit and read only through actions that check the committed score, revision, participation, and pending status. The legacy statistics collection remains registered for existing data. Player-facing totals no longer read or write a shared counter. Pagination follows the RecordRoom continuation and was exercised past 500 rows. Changes across different sessions are eventually visible and the reads do not take a cross-session snapshot.

Repairs use a Durable Object alarm armed before the pending record update. An alarm checks the durable state and resumes only a matching operation. A poll sends schedule notices with stable deduplication keys and follows all RSVP pages. Series cancellation checks for pending transitions and routes each cancellation through that session's command room. Series publication reuses existing occurrences and host RSVPs after a failed write. The edit workflow supports unpublished drafts.

Before release, use a disposable copy of legacy records to verify the three optional poll columns, guarded projection reads, score and template JSON round trips, Durable Object alarms on actual Worker restarts, and cross-account polling and notification delivery. The CLI returned `not_authenticated`; no test credentials were available. The failure cases run in deterministic in-memory RecordRoom harnesses.

Remaining boundaries include concurrent direct session edits outside the command room and mutable RSVP membership across notification pages. The poll compares known times and revisions and preserves a detected conflicting edit. It has no SDK compare-and-swap across the session and poll, so simultaneous direct writes and a conflict during notification delivery still require live rehearsal. Older interrupted operations without a saved alarm need their original retry. Score notices remain best effort. Large verified histories use one scoreboard lookup per indexed session. Series intervals are fixed UTC intervals and can shift in local time at daylight saving transitions. Series without linked chat channels use the existing session behavior.

## Interview demo

1. Open the public landing page and use the keyboard skip link. Show Find Games, Courts, and the mobile dashboard entry.
2. In a disposable test app, sign in as two players. Save a private profile, create a rally, RSVP, and exchange a message. Use a third account for a waitlist promotion rehearsal.
3. Propose alternate times, vote, and confirm as host. Check the same calendar event UID with a newer sequence, then open the participant's private notice and mark it read.
4. Score a match, confirm from both accounts, and compare the scoreboard with Account history. Correct the result as host, confirm the new revision, and open Result activity.
5. Open Recurring rallies, draft a series from a hosted session, edit it, publish the bounded occurrences, and cancel its future sessions.
