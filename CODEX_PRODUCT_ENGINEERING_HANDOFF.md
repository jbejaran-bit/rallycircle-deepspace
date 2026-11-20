# RallyCircle product engineering handoff

Review branch `feature/codex-professional-product` starts at `2c2d24f93daf751108986a45cba1ccb5440044ec`. The Muse integration, Courtboard authorization, scoreboard, waitlists, and prior quality work are included by ancestry. GitHub refs had no separate Copilot redesign or later Muse backend implementation to integrate. [Review comparison](https://github.com/jbejaran-bit/rallycircle-deepspace/compare/integration/rallycircle-muse-review...feature/codex-professional-product?expand=1)

| Workstream | Status | Implementation and evidence | Remaining check |
|---|---|---|---|
| Landing, public help and navigation | Complete for public flows | `be660a1510bdffeea39b69669dbf36841a274dfd` adds original CSS court art, real product links, a prerendered privacy/help page, and responsive app navigation. Chromium tested 320 to 1440 px, CTA destinations, keyboard focus and the signed-out gate. | Authenticated navigation and real OAuth return. |
| Protected entry and OAuth return | Partial | `be660a1`, `8fae8d7`. New CTA destinations and court prefill survive a same-origin OAuth callback. Offline Hono tests cover the destination allowlist, cookie cleanup and existing opaque invite IDs. | Verify the real provider round trip in an authorized app. |
| Dashboard, personal agenda and matches | Partial | `be660a1`, `155908d2310be2f2a8e8c32afe1f911b11596641`, `8fae8d7`. Reads actual session, RSVP, waitlist and scoreboard records. Includes personal filters, local-week navigation, opponent names and finalized results. Offline tests cover account isolation, promotion state, local date boundaries and finalized totals. | Exercise first-use, returning player, empty and failure states against the live test records. |
| Rally form, share and calendar | Partial | `155908d`, `8fae8d7`, `55741863d797f89f670a07fc83776f34f5c8413c`. Focus-managed dialog, duplicate-submit guard, explicit local time zone, full invite-copy fallback and preserved eligible `.ics` downloads. Node tests cover invalid dates and the New York spring transition. | Run signed-in keyboard, publishing, calendar import and invite tests. |
| Discovery and court search | Partial | `8fae8d7`, `5574186`. Availability filter, personal waitlist labels, refreshed discovered-court lookup, request cancellation, keyboard tab navigation and retry without asking for location again. Offline tests cover capped availability, rounded coordinates and cancelling a request before fetch. | Validate authenticated Provider responses, retry and map/list behavior. |
| Account, chat and scoreboard | Partial | `155908d`, `8fae8d7`. Existing public display names and HTTPS photos with initials fallback, own-account details, clearer score presentation and confirmation before recording decisions. Offline rendering checks host, observer and participant controls. | Confirm profile data visibility, result votes, and latency across two sessions. Editable profiles and score correction remain open. |
| Live backend, migrations and future social engines | Blocked | Unchanged Muse contracts for capacity, waitlists, scoring, Courtboard and chat. No new schema fields, bindings or dependencies. The local DeepSpace CLI returned `not_authenticated`. | Validate the additive schema and end-to-end flows in an authorized test app. Coordinate new contracts before adding ratings, scheduling, notifications or social UI. |

## Verification

Passed TypeScript, lint, the production build, 117 Vitest tests, 31 Node tests and 22 public Chromium tests. `npm test` stopped before running the authenticated suite because the local CLI has no authorized session.

```sh
npm ci
npm run validate
npm run lint
node --test tests/*.test.mjs
npm run build
npm run test:public
npm test
```

Cloud Chromium used `DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`, writable `XDG_CONFIG_HOME`, and `WRANGLER_LOG_PATH` under `/tmp`. Vite prerendered `/` and `/privacy`. The production entry output increased from 155.73 kB gzip to about 159 kB gzip. This compares build artifacts and does not measure browser latency.

Public screenshots are saved under `/workspace/shared/rallycircle-product` as `landing-desktop.png`, `landing-tablet.png`, `landing-mobile.png`, and `dashboard-sign-in-mobile.png`. The dashboard screenshot shows its signed-out gate.

## Short demo

1. Open the landing page, choose **Find a game**, and show the correct sign-in gate. In an authorized test app, sign in and confirm the original destination returns.
2. Explore courts, choose a verified venue, and use **Plan a Rally Here**. Confirm the form prefills the venue and captures the start in the displayed time zone.
3. Publish a disposable rally, open the invitation with a second test account, RSVP, and download the calendar event.
4. Start a match, record a point, and check that it reaches both accounts. Open **My matches** and the weekly agenda. Cancel the disposable rally as host after the demo.

## Next five tasks

1. Validate OAuth, session creation, and schema registration with authorized SDK accounts.
2. Run a three-account waitlist promotion and a two-account scoreboard, result confirmation and Courtboard rehearsal.
3. Verify court-provider reachability and exercise denied location, timeout, retry, and map/list behavior.
4. Audit signed-in focus order and mobile layout, including the dialog, chat and match controls.
5. Integrate verified editable-profile and score-correction contracts once available, then rehearse the release with a known deployed revision.
