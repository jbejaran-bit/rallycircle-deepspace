# Live Courtboard worklog

## Status

The security gate is implemented and locally unit-tested in the isolated
`feature/live-courtboard` worktree, based on `8fd8c2c`. The court interface,
multi-user browser test, screenshots, and a real local WebSocket negative test
are still unfinished. Nothing has been deployed or merged.

## Security decision

DeepSpace Canvas checks a user's role before accepting shape writes, but it
sends the current shape snapshot to viewers and permits anonymous connections
when the route receives no token. A room ID separates Durable Object state; it
does not grant session access.

The Canvas route now requires a JWT verified by `verifyJwt`. Before forwarding
the connection, it looks up the requested Rally session and checks the
verified user ID against the host ID or an RSVP for that session. Open-session
hosts and RSVP participants get the `member` Canvas role. They can still read a
cancelled session's board, but only with the `viewer` role. Missing sessions and
nonparticipants are denied; failed internal lookups fail closed.

The room ID is deterministic and includes the app and session IDs. There is no
new Durable Object binding or migration. The existing Canvas server still
enforces writes; this route adds the missing authentication and per-session
read boundary.

## SDK behavior and tradeoffs

`useCanvas` provides persisted shapes and synchronization through CanvasRoom.
Its mutations return `void`: add/delete round-trip through the server, while
move/update are broadcast to other peers and require an explicit local preview.
The UI must not describe a local move as server-confirmed until another
connected client or a subsequent room snapshot confirms it.

References: [Canvas](https://docs.deep.space/guides/canvas.md),
[worker auth](https://docs.deep.space/sdk-reference/worker/auth.md),
[room classes](https://docs.deep.space/sdk-reference/worker/rooms.md), and
[server actions](https://docs.deep.space/guides/server-actions.md).

## Verification so far

- Baseline before changes: `npm run validate` (10 tests), `npm run lint`, and
  `npm run build` passed.
- Security stage: `npm run validate` passed (17 tests), lint passed, and the
  production build passed.
- New unit checks cover app/session room-ID parsing, host and participant
  authorization, read-only access for cancelled sessions, fail-closed lookup
  errors, and a missing-token request returning 401 before room access.
- The 401 check exercises the Hono route locally, not a browser WebSocket
  handshake. The two-account unauthorized-room test is still required.
- `npm ci` reported one low-severity dependency audit finding; dependencies
  were not changed and `npm audit fix` was not run.

## Remaining work

Build the responsive court UI, add/remove and move four labeled markers, add
keyboard and touch controls, verify two-user synchronization and reload
restoration, and test that anonymous and nonmember WebSocket connections are
rejected against local services. Capture desktop/mobile evidence, update this
log with confirmed results, run all requested checks, and commit only passing
work.
