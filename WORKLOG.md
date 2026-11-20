# RallyCircle engineering worklog

## Status — November 20, 2026

Stage 1 is committed as `3b9455f` on isolated branch `feature/ready-to-play`, based on `d7c96ea`. Stage 2 is complete and its listed validation gates pass. Stage 3 was evaluated but not implemented: the target remains a planning goal, not a capacity limit. No production deployment, app identity change, data deletion, or internship submission was made.

Publication is blocked: pushing `feature/ready-to-play` to the existing GitHub remote returned HTTP 403 (`sonybej-art` lacks write permission). The two tested stage commits remain local; no pull request was created.

## Stage 1 — Real-time readiness experience

### What changed and why

The session detail now has a compact “Ready to play” panel. It shows confirmed `going` RSVPs against the session target, a progress bar, the number still needed, and when four players are confirmed, “Doubles ready!”. If the target is reached before four players, it says how many more are needed for doubles. The target stays a planning goal, not a capacity limit.

The count comes only from the `rsvps` collection subscription. The UI does not increment a count locally when someone clicks. DeepSpace broadcasts accepted record changes to subscribers, so another signed-in browser sees a join or withdrawal from server-confirmed room state. RSVP buttons are unavailable while RSVP data is loading, unavailable on a cancelled session, or when the mutation collection is not ready. A failed confirmed mutation remains visible as an error instead of being presented as a successful update.

Cancelled sessions show a closed-response message rather than a readiness claim. RSVP query loading and failure states are explicit, and the progress panel adapts to narrow screens.

### Files changed

- `src/lib/rally.ts` — added the pure readiness summary, including the target gap and the four-player doubles threshold.
- `src/pages/(app)/(protected)/rallies.tsx` — added the readiness panel, query states, and RSVP gating.
- `tests/rally.test.mjs` — covered one-player-needed, doubles-ready, larger targets, and a reached target below doubles size.
- `tests/rally-collab.spec.ts` — asserted live counts in both signed-in browser contexts after a join and withdrawal, checked cancellation, and saved desktop/mobile panel screenshots.

### How the DeepSpace pieces fit together

`useQuery('rsvps')` subscribes to the app's record room. We count only `going` rows for the selected session. RSVP mutations use the existing confirmed mutation methods; these wait for the room's acknowledgement, while the visible count still comes from the subscription rather than a local optimistic value. Schema permissions and `uniqueOn` remain unchanged. The existing `usePresenceRoom` and messaging channel code are untouched.

### Verification

- `npm run validate` — TypeScript check passed; Vitest: 5 tests passed.
- `node --test tests/rally.test.mjs` — 16 tests passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `deepspace test run e2e` — 13 local Playwright tests passed.
- `deepspace test run tests/rally-collab.spec.ts` — 1 local test passed after the final cancellation assertions. It used the two available SDK test accounts and real local DeepSpace services, not mocks. Both browsers observed the count change after the second account joined and withdrew.
- Screenshots from that test: `test-results/ready-to-play-desktop.png` and `test-results/ready-to-play-mobile.png` (ignored by Git, generated from the real two-account local test).

The two-account test used a target of three, so the real browser state verified `2 / 3 confirmed` and “One more player needed”; after withdrawal it verified `1 / 3 confirmed`. The “Doubles ready!” calculation at four confirmed players is covered by a unit test, not a four-user browser session: only two usable SDK test accounts were available. The write-error UI path uses the existing confirmed-mutation rejection handling, but a rejected RSVP was not induced in this stage.

### Integration catalog review

The installed DeepSpace CLI catalog was queried with `deepspace integrations list`. The app currently makes no catalog integration calls. `src/integrations.ts` contains billing configuration for `google` and `composio`; configuration alone does not mean either is used. Authentication, synced records, RBAC, messaging, and presence here are built-in DeepSpace SDK capabilities, not catalog integrations.

`google/calendar-create-event` could let a player add a session to their own calendar, but it requires per-user OAuth consent and is not necessary for the current coordination loop. `email/send` could support reminders, but would add notification preferences, cost, and delivery/error handling. The catalog listing did not surface a tennis-court availability or booking endpoint; generic geocoding or weather would not establish court availability. No integration was added because none is needed to make this readiness feature correct.

### Stage 1 limitations

The confirmed-player count is intentionally not a hard capacity limit. Stage 2 separately strengthens RSVP identity, session lifecycle, and host authorization below.

## Stage 2 — Server-side RSVP and session enforcement

### What changed and why

Before this stage, the browser hid RSVP controls for cancelled sessions, but a signed-in client could still attempt a direct record write. DeepSpace's `select` column interpretation is not server-side enum validation, so it also could not make cancellation terminal by itself.

Members can no longer create or update RSVP records directly. Instead, the authenticated `rallyCommand` action passes the verified caller ID to a per-session `RallyCommandRoom`. The room checks that the session exists and is open, then creates or updates only that caller's RSVP. `uniqueOn: ['sessionId', 'userId']` remains in place as a second server-side duplicate guard.

Session `status` is no longer writable through the normal record API. The same command room handles cancellation, checks that the caller is the recorded host, and permits only the `open` to `cancelled` transition. There is no reopen operation. A member can still withdraw their own RSVP using the existing ownership-checked delete permission.

The command room serializes RSVP and cancellation commands for the same session. This avoids a check-then-write race between those app operations while keeping different sessions independent. A retry is safe: an existing RSVP is updated rather than duplicated, and a repeated host cancellation succeeds without reopening anything.

### Files changed

- `src/schemas/rally-schema.ts` — restricts session fields with `writableFields` and denies direct member/admin RSVP create or update.
- `src/server/rally-command-room.ts` — implements the authenticated action and per-session command queue, checks session state and host identity, and uses the RecordRoom tools for accepted writes.
- `src/actions/index.ts` — registers the `rallyCommand` server action.
- `worker.ts` and `wrangler.toml` — declare the command Durable Object binding and additive `v2` migration; existing RecordRoom data and app identity are unchanged.
- `src/lib/rally-actions.ts` and `src/pages/(app)/(protected)/rallies.tsx` — route RSVP changes and cancellation through the server action and surface failures.
- `src/server/rally-command-room.test.ts` — tests server-side session checks, spoofed IDs, role restrictions, cancellation, duplicate requests, and command ordering.
- `tests/api.spec.ts` and `tests/rally-collab.spec.ts` — test unauthenticated calls, two-account live updates, unauthorized cancellation, missing/cancelled sessions, forged caller fields, duplicate concurrent writes, and concurrent updates.
- `WORKLOG.md` — records this stage and the Stage 3 decision.

### How the DeepSpace pieces fit together

The Hono action route verifies the caller's Bearer token and supplies the verified subject as `userId`; the action ignores any `userId` in the request body. It first checks that the session exists, then routes the operation to `RALLY_COMMAND_ROOMS` keyed by app and session. The Durable Object serializes commands for that session and uses the RecordRoom tools API for each accepted write. The RecordRoom still enforces `userBound`, `ownerField`, `writableFields`, and the composite `uniqueOn` constraint. Its accepted changes are broadcast to the existing `useQuery` subscriptions.

### Verification

- `npm run validate` — TypeScript passed; Vitest: 10 tests passed.
- `npm run lint` — passed.
- `npm run build` — passed; the generated Wrangler configuration includes the new command-room binding and additive migration.
- `npx deepspace test run tests/api.spec.ts` — 4 local API tests passed, including the unauthenticated action rejection.
- `npx deepspace test run e2e` — 14 local Playwright tests passed. The two-account collaboration test exercised real local DeepSpace services; no production URL was used.
- `node --test tests/rally.test.mjs` — 16 Stage 1 helper tests passed.
- The desktop and mobile screenshots were refreshed from the local two-account test at `test-results/ready-to-play-desktop.png` and `test-results/ready-to-play-mobile.png`.

### Limits and Stage 3 decision

The session target remains advisory; there is no capacity cap or waitlist. In the installed `deepspace@0.44.2`, `ActionTools` exposes individual `get`, `query`, `create`, and `update` calls, not a multi-record transaction or compare-and-swap. The custom room safely serializes the single-record RSVP/cancel commands, but it does not make multiple RecordRoom writes crash-atomic. A capacity waitlist would need to coordinate RSVP withdrawal and promotion as a multi-record operation, so implementing it here would add recovery and partial-write risk. Stage 3 is therefore intentionally not implemented.
