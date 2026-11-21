# RallyCircle integration review

The branch combines PR #17 and PR #18 on their shared PR #16 stabilization base (`d7270b1`). It uses one command room, the existing scoreboard, one session collection, and both sets of feature schemas. Result notices come from the same review command that writes the audit trail.

| Scope | Review status |
| --- | --- |
| Existing court discovery, Find Games, session attendance, waitlists, chat, scoreboard, Courtboard | Stabilization baseline |
| Profiles, singles and doubles history, result correction, time polls, inbox and calendar exports | Integrated preview pending authenticated rehearsal and migration checks |
| Recurring series | Bounded backend and local tests. Player-facing setup and live validation are pending. |
| Rating, social graph, matchmaking, clubs, tournaments, advanced extensions, spectator video | Outside the integrated candidate |

## Recovery behavior

A score transition persists a pending operation on the session before touching history, audit rows, or stats. The same command can resume it after an interrupted write. The session saves the new score and clears the pending operation in one RecordRoom update. A stale correction revision and a competing command are rejected. Finalization upserts each participant's history row and rebuilds their summary from result rows. A correction removes the old contribution before players confirm the new score. Audit inserts use the session, transition kind, and revision as their replay key.

A poll records its selected option and enters `finalizing` before its schedule update. The host can retry that option. The calendar revision is preserved when the new time already landed. The poll reaches `finalized` after each queried participant's notification succeeds or is found by idempotency key.

## Release blockers

- DeepSpace CLI sign-in is unavailable. Upgrade a disposable legacy-data snapshot before release and verify the new optional session field and poll state, collection registration, unique keys, JSON round-trips and ordering. Rehearse with two authorized accounts and a nonparticipant. Local permission and fake RecordRoom tests do not establish live enforcement.
- The SDK writes multiple records independently. History, stats or audit rows can become visible during a pending score transition. A host may need to retry, and an interrupted operation has no background recovery. Simultaneous matches for one player can still race the stored statistics summary across session rooms. At 500 result rows the rebuild returns a retriable error until aggregation supports complete pagination. Verify or replace these paths before promoting results.
- Poll recovery relies on the host retrying and reads at most 100 current RSVPs. Direct schedule edits and series cancellation can occur outside the poll recovery flow. Test those interactions and recipient coverage in the authorized rehearsal. Score notices remain best-effort.
- Public browser tests and screenshots use signed-out Chromium. Signed-in layout, delivery, subscriptions and operator flows still require live rehearsals.

## Demo script

1. In a disposable app, sign in as the host and a second player in two browser contexts. Set the host profile to private in Account, save preferences, reload, and verify the second player cannot read private history. Repeat with a nonparticipant when checking writes.
2. Create a singles rally. Find it using Games and Courts, RSVP from the second browser, send a session message and verify it arrives. For waitlists, fill a capped session, join the queue as a third test player, and withdraw a confirmed RSVP.
3. Open a poll from the rally detail, select two future times, vote in the other browser, and change the vote. Confirm as host. Open the other player's notifications and mark the update as read. Download the calendar event and verify the event UID is unchanged while the schedule and sequence advance. Use a separate cancelled rally to demo the cancellation export.
4. Start the singles scoreboard, score through two sets, and confirm from both accounts. From Account, check the result and singles totals. Submit an authorized correction, verify the result returns to review, and confirm the new score from both accounts. Check the final history and return to the dashboard to verify upcoming activities.
