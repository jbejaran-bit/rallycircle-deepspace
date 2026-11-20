# Live Courtboard worklog

## Status

The work is isolated on `feature/live-courtboard`, created from verified
commit `8fd8c2c`. The server access gate and Live Courtboard are implemented
and have passed local validation, including two-account browser tests. Nothing
has been pushed, merged, deployed, or submitted.

## What changed

Each RallyCircle session now has a responsive doubles court with four optional
player markers: A1, A2, B1, and B2. Players can add and remove markers, drag
them with a pointer or touch, and move a focused marker with arrow keys or
accessible direction buttons. The marker positions stay inside the court.
Labels are large enough to read on a phone, and the touch hit area is larger
than the visible marker. Every label gets a stable ID within its session room,
so simultaneous attempts to add A1 converge on one shared marker.

The board is shown only after the signed-in user is confirmed as the session
host or an RSVP participant. The client check keeps the ordinary UI clear; the
server repeats the authorization check, so a client cannot get board contents
or write by bypassing React.

## How synchronization works

`LiveCourtboard` calls DeepSpace's `useCanvas` with a deterministic room ID
containing the app ID and Rally session ID. DeepSpace routes that room to the
existing `CANVAS_ROOMS` binding. `CanvasRoom` stores shapes in its Yjs-backed
Durable Object, broadcasts marker changes to connected users, and restores
shapes when a browser reconnects. No new dependency, binding, or migration was
added.

The SDK's add and delete operations are reflected back through the room. A
move is different: `moveShape` returns `void` and does not echo the move to its
owning browser. The UI therefore shows the initiator's movement as a local
preview, not a confirmed save. Another browser receives the shared position;
reloading the first browser proves that the stored room snapshot contains it.

## Server-side access and write checks

The `/ws/canvas/:docId` route verifies the JWT, checks the session host or RSVP
against server-side records, and rejects invalid or nonmember access before
forwarding to CanvasRoom. Open-session hosts and RSVP participants can edit.
Participants can reconnect to a cancelled session as viewers.

CanvasRoom normally retains a connection's write role for its lifetime.
`AppCanvasRoom` now rechecks the current session and RSVP before every
Canvas write. A cancelled session gets the SDK's read-only error response;
withdrawn or otherwise unauthorized users have their write rejected and
connection closed. Failed authorization lookups fail closed. The server also
normalizes adds to one of the four supported labels and fixed marker size,
clamps move coordinates, and rejects unsupported shape edits. This keeps
simultaneous adds and client-supplied shape data within the board's model. The
checks add a small Records lookup for each marker write, rather than polling
while a board is idle.

## Files changed

- `src/components/LiveCourtboard.tsx` — session gate, court drawing, marker
  controls, responsive touch/keyboard interaction, reconnect and preview
  status.
- `src/pages/(app)/(protected)/rallies.tsx` — mounts the board in session
  details and supplies the signed-in user, session, and RSVP state.
- `src/lib/courtboard.ts` — shared marker positions, court dimensions, room ID
  parsing, and finite-position clamping.
- `src/lib/courtboard.test.ts` — room scoping and coordinate boundary tests.
- `worker.ts` — rechecks membership for each server-side Canvas mutation.
- `tests/courtboard.spec.ts` — two-user authorization, real-time, persistence,
  mobile pointer, keyboard, removal, cancellation, and room-isolation test.

The WebSocket security gate was committed separately as `96e4d79`; the
Live Courtboard UI, server enforcement, and E2E coverage are the next isolated
stage on the same feature branch.

## Verification

- Baseline before changes: `npm run validate` (10 tests), `npm run lint`, and
  `npm run build` passed.
- Security stage: validation passed (17 tests), lint passed, and the
  production build passed.
- Current unit and type validation: `npm run validate` passed, 19 tests.
- Current lint: `npm run lint` passed.
- Current production build: `npm run build` passed.
- Two-account local Playwright test passed. It observed an anonymous Canvas
  WebSocket rejection (HTTP 401 and the socket did not open), a signed-in
  nonparticipant rejection (HTTP 403 and the socket did not open), host and
  participant edits syncing between browsers, touch-style dragging, keyboard
  movement, persisted state after reload, marker deletion, two simultaneous
  adds converging to one marker, different session rooms, and read-only
  behavior after cancellation.
- The test also kept a previously authorized WebSocket open through
  cancellation and attempted a Canvas add. The server returned the SDK's
  `core.error` write-denied response, and the other browser did not receive the
  marker.
- Screenshots are saved to `test-results/courtboard-desktop.png` and
  `test-results/courtboard-mobile.png`.

The browser runner logged `Yjs was already imported` during both Rally and
Courtboard E2E runs. The tests passed, but this SDK/runtime warning was not
silenced or investigated as part of this feature.

## Remaining risks and follow-up

- Canvas move messages do not provide an acknowledgement to the sender. A
  local preview can remain visible until the sender receives another update or
  reloads; the UI labels this limitation instead of claiming a confirmed save.
- Marker writes perform a server-side Records lookup. This is safe for the
  current low-frequency drag-on-release interaction, but should be measured if
  the board later sends continuous movement updates.
- The test simulates a touch pointer event at a mobile viewport; it is not a
  physical-device test.
- The Yjs warning should be traced before treating it as resolved.
- The feature has not been deployed. Do not describe it as live.
