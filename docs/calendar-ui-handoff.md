# Calendar and interface sprint handoff

Development branch: `feature/calendar-ui-polish-20261122`, based on approved release `5bd06f978753ef946aa4e31f7d037dab7f64f15d`. The separate worktree is `C:/Users/sonyb/OneDrive/Escritorio/rallycircle-calendar-ui`. The original approved checkout remains clean at its approved SHA. No deploy, merge, production configuration/data change, purchase, catalog invocation, OAuth consent or internship submission occurred.

The draft PR targets `review/rallycircle-final-handoff`, which points to the approved SHA. `main` is 113 commits behind that release, so targeting it would mix the release history into this focused sprint. The PR remains a draft; `release_in_progress` is not retried or changed.

## Implemented

- **Add to Google Calendar** opens a populated Google event draft: title, absolute start/end, viewing time zone, court/location, notes, format, level and invitation. The person selects Save in Google. RallyCircle never reports this link as a confirmed save.
- **Download .ics** is a separate secondary export. Cancelled sessions expose an eligible cancellation export and no Google create action. Host/confirmed-player eligibility remains unchanged.
- An OAuth direct-save adapter and UI are implemented behind `GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED = false`. Both the UI and adapter enforce the source flag. Only a provider-confirmed event id/status produces a saved message; ambiguous results do not retry automatically.
- The existing dark tennis/lime identity now extends to the landing. Rally headings, card hierarchy, detail metadata, dashboard, Courtboard/chat, navigation, controls, mobile reflow, focus and reduced-motion behavior are refined without new dependencies.
- All eight requested Jakub Krehel skills were installed locally, read and applied. [Interface evidence](interface-sprint.md) maps each skill to changes and measurements; `skills-lock.json` pins the installed source revision.

## Final local checks

Node `24.22.3`, npm `11.19.1`, installed DeepSpace `0.44.2`.

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `npm run type-check` | Passed |
| ESLint | `npm run lint` | Passed |
| Vitest | `npm run test:unit -- --reporter=dot --maxWorkers=2` | 447 passed, 48 files, 0 failures |
| Node tests | `node --test tests/rally.test.mjs tests/courts-games.test.mjs` | 35 passed, 0 failures |
| Production build | `npm run build` | Passed: worker/client and public prerender |
| Public Playwright | `npm run test:public -- --workers=1` | 38 passed, 0 failures |
| Local app Playwright | `npm run test:ui` | 11 passed, 0 failures |
| Whitespace | `git diff --check` | Passed |

The initial Vitest run passed 446/447 and timed out in the unchanged scheduling recovery test that writes 103 notifications. Its assertions passed in a focused 30-second run. That individual test now has a 30-second budget for slower runners; no assertion or runtime scheduling behavior was changed. The subsequent full suite passed all 447 tests. Expected notification failure-injection logs exercise recovery behavior and are not failing checks.

The local browser suite covers actual components at 320, 390, 768 and 1440px; populated Google popup target and real ICS download; cancellation; confirmed/rejected message drafts; waitlist join/leave; RSVP withdrawal/count updates; Courtboard keyboard movement; rally publication with host RSVP and chat linking; and empty/loading/error states. SDK services and action responses are explicitly mocked. Server command tests separately cover local creation, attendance serialization, capacity/waitlist promotion and authorization.

## Evidence and remaining limits

[Before/after screenshot gallery](screenshots/calendar-ui/README.md): 24 desktop/mobile PNGs covering landing, discovery, rally detail, dashboard, Courtboard and chat. Before uses approved Git source; after uses the feature branch, with identical deterministic fixtures. [Fixture reproduction](../tests/ui-fixtures/README.md) explains isolation and capture steps.

The native manual browser check stopped because the computer-use runtime could not identify Chrome's current URL confidently. Google's rendered editor, the manual Save step, live OAuth, actual provider response shape and charges remain **unverified**. The local popup test intercepts Google before any external request. Live authenticated multi-account delivery/synchronization, screen-reader speech, 200% browser zoom, translation/RTL and calendar-app import compatibility were not verified. These checks do not establish full WCAG conformance.

The session model has no stored court IANA time zone. Calendar links use the browser's zone, matching the existing session display, while UTC instants and elapsed durations stay invariant. Exports are one-time copies: later session edits/cancellations do not automatically update a Google event.

[Calendar integration requirements](calendar-integration.md) records the read-only catalog investigation. The observed price is **USD $0.013/request**, billed to the calling user's DeepSpace credits with the existing `google: { billing: 'user' }`. DeepSpace manages per-user OAuth; Calendar event write access is required. The exact consent scope URI and live confirmation envelope need approved testing. Recheck pricing, consent and duplicates before enabling the disabled source flag.
