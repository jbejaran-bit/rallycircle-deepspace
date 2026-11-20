# RallyCircle engineering worklog

## Status — November 20, 2026

Stage 1, the real-time readiness experience, is implemented and its validation gates pass on isolated branch `feature/ready-to-play`, based on `d7c96ea`. The Stage 1 changes are ready to commit. Stage 2 and Stage 3 have not started. No production deployment, app identity change, data deletion, or internship submission was made.

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

### Remaining limitations and next stage

The confirmed-player count is intentionally not a hard capacity limit. Safely enforcing capacity or waitlist promotion needs an atomic server-side operation; this is reserved for Stage 3 only if the existing SDK supports it without unsafe client-side counting. Stage 2 will separately examine and test RSVP identity, session lifecycle, and host authorization without weakening existing schema rules.
