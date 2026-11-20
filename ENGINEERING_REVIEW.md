# RallyCircle engineering review

## Source and scope

The quality branch starts at `8fd8c2cfe08b2f1e766c92765ed7ab56740c003e`. The published Git refs and PR pages show that PR #2 is a draft against main, and PR #5 is a draft against PR #2. The published PR #5 head reviewed was `a72c6330b2cea447b6f0cc418a5de44c3d5ba7b2`. It was read and tested from a temporary source snapshot. The quality branch does not incorporate Courtboard or unpublished Copilot or Muse features. [PR #2](https://github.com/jbejaran-bit/rallycircle-deepspace/pull/2) · [PR #5](https://github.com/jbejaran-bit/rallycircle-deepspace/pull/5)

## Authorization evidence

| Boundary | Evidence | Remaining verification |
|---|---|---|
| Signed-out protected routes and action entry | Executed public Chromium tests and offline Hono tests. Missing bearer and missing verified identity are rejected separately. Invalid request bodies return 400 before command execution. | Exercise expired real sessions and the actual OAuth exchange. |
| RSVP identity and lifecycle | Executed the actual command-room code with test storage. It uses identity from action context, scopes lookup to the caller and session, and serializes RSVP and cancellation. Tests assert both operation orders, duplicate updates, and two-session isolation. | Real RecordRoom persistence and delivery while two accounts are connected. |
| Direct writes and withdrawal | Executed SDK RBAC helper checks for disabled RSVP create/update, own-only member delete, and blocked direct lifecycle-field changes. Schema inspection confirms immutable bound IDs and the composite unique key. | Verify the real SDK transport produces the same results. Decide how withdrawal should interact with a simultaneous in-flight update before adding capacity or waitlist semantics. |
| Lifecycle access | Executed command-room tests confirming that cancellation blocks new RSVPs and that non-hosts cannot cancel. Source inspection shows signed-in members can still see cancelled sessions and existing chat. | Confirm that retained chat and withdrawal behavior match the intended product policy. |
| Session creation validation | The normal form validates time, sizes, duration, target, and skill level. Source review shows ordinary members create sessions directly through RecordRoom. Schema ownership and allowed field names are enforced. Equivalent server-side time and business-range constraints were not established. | Align creation validation across clients before booking, rating, or capacity features rely on those values. |
| PR #5 Canvas | Executed nine existing tests for access lookup, room IDs, and mutation normalization. Source inspection shows the route authorizes before forwarding the connection, denies unknown or mismatched sessions, and grants viewer access after cancellation. Canvas writes recheck membership, and failed authorization lookups deny access. | Run the existing Canvas integration spec for snapshot isolation, two-account sync, and authorization after access changes. A separate local upgrade probe ended without a response, so it did not establish transport behavior. Per-write checks alone do not establish that an existing connection immediately stops receiving updates after withdrawal. Verify the desired passive-reader policy with the Courtboard owner. |

Test storage and offline authorization cases are local. No production accounts or data were used. Lower-level SDK and WebSocket behavior require authenticated runtime evidence.

## Accessibility review

- Public landing and the signed-out app were checked in Chromium. The mobile invite gate kept the encoded URL, exposed the sign-in heading, and offered a keyboard-operable return link. The mobile menu reports its expanded state. In the sampled 390 px viewport the document did not overflow, the menu showed a visible keyboard focus ring, and its target measured 32 by 32 CSS pixels.
- The shared slate palette produced 2.98:1 sign-in text contrast. The foreground change raised it to 6.12:1. A Chromium test verifies at least 4.5:1 for the navigation and protected-gate buttons in both available themes.
- Rallies and Courts rendered nested main landmarks under the existing app shell. The quality branch removes the inner landmarks. The court component renders a named list and usable booking/planning links without tiles. Its static markup test passed. Added browser assertions for the signed-in landmark and location denial require a live account.
- The session list now exposes a loading message to assistive technology and limits skeleton animation to users without a reduced-motion preference. The custom create-session modal still needs a focused keyboard pass for initial focus, trapping, Escape, and focus return. Reuse the existing Base UI Dialog when coordinating that fix with the session UX owner.
- Settings, authenticated account/navigation, full color contrast, and chat interactions still need a signed-in audit. Manually check focus indicators, control dimensions, and announcements when switching views or submitting a failed form. No whole-app accessibility compliance claim is made.

## Performance and reliability

On Node 24, a synthetic fixture of 800 sessions with 20 RSVPs each produced identical confirmed counts before and after indexing. Across seven timings per implementation the median went from 334.16 ms to 0.76 ms. The baseline mapped and scanned the full RSVP list for each session card. The new calculation groups the record envelopes once and inspects each relevant group. This measures the calculation, excluding React rendering, network delivery, and browser-interaction latency.

Vite reported 155.61 kB gzip for the production client entry before and after. The lazy Rallies chunk changed from 9.00 to 9.10 kB gzip, and the separate Leaflet chunk stayed at 43.33 kB gzip. The public browser suite verifies that the landing initiates neither auth fetches nor records WebSockets. Browser timing, layout shift, and profile data under live subscriptions remain unmeasured. Unit coverage verifies the one-reload guard for stale chunks and safe behavior when session storage denies writes.

## Provisional integration contracts

| Feature | Preserve or decide before integration |
|---|---|
| Scoreboard and match results | Keep the session record ID stable for existing URLs. Give matches their own identity when a session can contain multiple matches. Define participant roles and finalization, and decide what cancellation does to in-flight or finalized matches. |
| Capacity and waitlists | The target is a planning value. Define which states consume a spot. Enforce a cap and promotions in a single authoritative workflow that reconciles partial writes, handles retries, and prevents duplicate spots. Include withdrawal and cancellation in race tests. |
| Ratings | Require confirmed, eligible results. Track a unique application of each final result and define correction/reversal rules. Store rating history with provenance. |
| Profiles and social activity | The users schema limits ordinary record reads to self. Define explicit public fields and visibility rules for new profile projections. Keep identity keys separate from editable display names and avoid exposing email or private profile fields through activity, presence, or chat. |
| Geographic discovery | Current location sorting is browser-local. Define consent, visibility, granularity, and retention before sharing player location. Keep court coordinate ownership independent of user data. |
| Calendar export | Preserve an event identifier tied to the session, use explicit time-zone semantics, and establish how changes or cancellation update a previously exported event. Provider integrations require explicit consent. |
| Chat, Courtboard and video | Current chat is scoped by channel and visible to signed-in members. Give session-specific media its own explicit membership and lifecycle policy. Decide eligibility at connection time and revocation behavior for active transports. |

The forward-looking contracts are recommendations based on published RallyCircle schemas and the named backlog. They are provisional until the owning branches publish their implementation.
