# RallyCircle submission readiness

RallyCircle helps tennis players publish a practice session, share it, coordinate attendance and messages, and find one of three Pittsburgh courts. The booking handoff takes players to the city's RecDesk. Availability and permits remain with the city.

## Architecture

- React and Vite render a prerendered landing page and a lazy-loaded signed-in app. DeepSpace OAuth provides Google and GitHub login. The invite redirect stores a bounded same-origin session ID in a short-lived HttpOnly cookie and clears it at callback.
- DeepSpace RecordRoom Durable Objects store sessions, RSVPs, users, and SDK messaging collections in SQLite. Queries drive live attendance and session views. Chat uses SDK channels and presence uses a session-scoped room.
- Collection permissions control direct record writes. The session and RSVP schemas bind the identity fields to the caller. RSVP create/update and session cancellation go through a Hono action route using verified bearer identity. An app-action tool has elevated record access, so the command room explicitly checks session state and host ownership.
- The per-session Durable Object serializes RSVP and cancellation commands for one session. The composite `uniqueOn` protects one RSVP per user per session. Withdrawal uses a separate ownership-checked delete. These guarantees do not imply a multi-record transaction across session creation, the initial RSVP, and chat setup.
- Confirmed mutations await server acceptance and expose rejected writes. Session creation can succeed while the initial RSVP or chat setup fails. The action client now handles expired auth and malformed gateway responses, and stale lazy chunks can trigger one guarded reload.

## Evidence and decisions

TypeScript, lint, the production build, offline tests, and public Chromium smoke passed on the quality branch. Fixtures test command ordering and caller scoping. Live persistence, multi-account collaboration, authenticated accessibility interactions, and Canvas transport still need an authorized runtime. The user-facing target is advisory. Chat is configured for signed-in members. See the testing guide and engineering review for evidence and remaining contract decisions.

## Release status

The user reports that DeepSpace acknowledged the release appears stuck on its side and offered additional time if needed. The underlying cause and current deployment revision remain unconfirmed. The stated deadline is November 23, 2026 at 11:59 PM Eastern. Confirm any revised deadline directly with DeepSpace.

Ready to Play and Courtboard remain draft branches on GitHub. Validate the actual deployment revision and rehearse the demo on the intended origin before submitting. The quality work did not deploy or submit the exercise.

[PR #2](https://github.com/jbejaran-bit/rallycircle-deepspace/pull/2) · [PR #5](https://github.com/jbejaran-bit/rallycircle-deepspace/pull/5)
