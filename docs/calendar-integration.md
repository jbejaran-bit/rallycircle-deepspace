# Calendar integration review

Reviewed 2026-11-22 against the installed `deepspace@0.44.2` types, `deepspace integrations --help`, and the read-only catalog:

```text
node node_modules/deepspace/dist/cli.js integrations info google/calendar-create-event --json
GET https://api-worker.deep.space/api/integrations
```

No integration invocation, OAuth consent, event creation, purchase or production write was performed.

## Available by default

**Add to Google Calendar** opens Google's event editor in a new tab with the session title, UTC start/end instants, court/location, format, level, host notes and invitation URL. The person reviews the populated event and selects **Save** in Google Calendar. RallyCircle does not receive confirmation from this link and never says it saved the event. An existing Google sign-in may be required.

The session model stores an absolute ISO timestamp but no court IANA time zone. The link uses absolute UTC dates and `ctz` set to the viewer's browser time zone, matching the existing session display; an invalid zone falls back to UTC. Switching viewers' zones never changes the event instant or elapsed duration. Court time zones are not inferred from a location string.

**Download .ics** remains the secondary option for Apple Calendar, Outlook and other calendar apps. Both formats use shared validation and descriptions. Cancelled sessions have no Google create link; eligible players can still download the existing iCalendar cancellation with its stable UID and sequence. These are one-time exports, not a calendar subscription: subsequent changes or cancellations do not automatically update events added through Google’s editor.

Calendar actions retain the existing host/confirmed-player eligibility. Invalid or floating dates, nonpositive or nonfinite durations and unsafe invitation URLs produce no event. Notes are escaped in `.ics`; Google values are encoded with URLSearchParams.

## Direct OAuth save: implemented and disabled

`src/lib/calendar-feature-flags.ts` contains the source-only flag `GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED = false`. Both the UI and save/disconnect adapters check it. No environment variable, local-storage setting, query parameter or browser control enables it. Review and a code change are required before any live testing or billing. This is an application safeguard, not a new platform-wide authorization rule for the existing integration proxy.

The future direct flow calls `google/calendar-create-event` once per deliberate save, targets the signed-in person's primary calendar, sends RFC3339 UTC `start` and `end`, and includes title, description and location. It supplies no attendees, sets `sendUpdates: 'none'` and does not request a Meet link. No automatic create call runs on mount, after consent, or after a failed request. The button prevents concurrent saves and stays disabled after confirmation or an uncertain outcome. Reopening a session later is not an idempotent operation; the catalog exposes no idempotency key. Check the calendar before another save.

The catalog's `outputSchema` is `null`; the live success envelope has deliberately not been sampled. The adapter accepts only an event object with a nonempty id and Google's `status: 'confirmed'` (directly in data or in data.event). Every other success-shaped result remains unconfirmed. In particular, `data.requiresOAuth: true` with `authUrl` prompts connection and says no event has been saved. After consent the person returns and explicitly saves again. Transport/provider failures can follow an accepted write, so the UI asks the person to check Google and does not retry. Expired authorization offers an explicit disconnect; it explains that this removes the connection for all Google features in RallyCircle.

## OAuth permissions and costs before approval

- Keep `google: { billing: 'user' }` in `src/integrations.ts`. It is already configured correctly and was not changed. DeepSpace uses the caller's JWT subject for their tokens and credits. Developer billing would act on the owner's account and must not be used for this flow.
- DeepSpace manages the per-user Google consent, token storage and refresh. Its guide describes incremental Calendar events access plus `openid`, `userinfo.email` and `userinfo.profile` identity scopes. Google event insertion accepts `https://www.googleapis.com/auth/calendar.events` among its write-capable scopes. The catalog does not expose the exact requested scope URI, and we did not invoke it to obtain `requiresOAuth.scopes`; verify the actual consent scopes and any Google verification restrictions in approved live testing. RallyCircle adds no client secret or separate Google OAuth app configuration in this implementation.
- The catalog observed on 2026-11-22 lists **USD $0.013 per request** (`model: per_request`, `baseCost: 0.013`). This is DeepSpace's catalog base price, not a guarantee of future pricing or a measured final charge. The signed-in caller needs applicable DeepSpace credits. Recheck the catalog and approve live costs before enabling the flag; do not assume OAuth acquisition, retries or failed calls are exempt from billing.
- The default Google editor link and local `.ics` generation make no DeepSpace catalog call.
- Before enabling, verify actual provider confirmation shape, incremental consent/revocation, billing and duplicate behavior using a designated test account/calendar. Then review user-facing costs and any additional production spend controls.

## Verification

The targeted calendar suite contains **57 passing tests in 5 files**. It covers Google parameters, notes, invitation encoding, UTC conversion, different time zones, midnight rollover, both DST transitions (including repeated fall-back wall times), all four supported durations, invalid dates/durations/URLs, cancelled sessions, stable `.ics` identity/cancellations, disabled calls, mocked OAuth, billing failures, revoked authorization, uncertain provider outcomes, explicit disconnect and labels.

Real Google OAuth, direct-save responses, billing and updates to existing Google events remain untested. Opening the editor requires no paid integration call, and any browser inspection must stop before Save. Screen-reader speech and external calendar import compatibility require manual product verification.

## Sources

- [DeepSpace external APIs](https://docs.deep.space/guides/external-apis.md)
- [DeepSpace Google OAuth](https://docs.deep.space/guides/google-oauth.md)
- [DeepSpace integrations client](https://docs.deep.space/sdk-reference/client/integrations.md)
- [Read-only DeepSpace catalog](https://api-worker.deep.space/api/integrations)
- [Google event insertion permissions](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Google Calendar scope descriptions](https://developers.google.com/workspace/calendar/api/auth)
