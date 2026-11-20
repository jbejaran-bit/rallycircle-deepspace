# RallyCircle interview practice

Work on a disposable branch. Use offline tests first and only run live tests in an authorized test environment. Treat this as a learning guide and describe your own contributions accurately.

## Architecture map

| Layer | Start here |
|---|---|
| Entry and route loading | `src/main.tsx`, `src/stale-chunk-recovery.ts`, `src/pages/index.tsx` |
| Auth bootstrap and gating | `src/pages/(app)/_layout.tsx`, `src/pages/(app)/(protected)/_layout.tsx`, `src/server/http-routes.ts` |
| Session UI and typed contracts | `src/pages/(app)/(protected)/rallies.tsx`, `src/lib/rally.ts`, `src/schemas/rally-schema.ts` |
| RSVP transport and server | `src/lib/rally-actions.ts`, `src/server/action-routes.ts`, `src/server/rally-command-room.ts` |
| Worker, sockets and storage | `worker.ts`, `src/server/realtime-routes.ts`, `wrangler.toml` |
| Coverage by boundary | `src/server/rally-command-room.test.ts`, `tests/rally.test.mjs`, `tests/public-navigation.spec.ts`, `tests/rally-collab.spec.ts` |

## Interview questions

1. Trace a participant clicking **I’m in** through the TypeScript command type, Hono route, Durable Objects, and the other player's browser. Identify what decides which user the command acts for.
2. Two requests arrive together, one cancelling a session and one RSVPing. What happens in both orders? How do direct withdrawal, process restart, and the database uniqueness constraint change the reasoning?
3. Explain which types protect client callers at compile time and which checks the runtime still needs when parsing JSON. What does the UI observe when the command returns a 401, a domain rejection, or a malformed gateway response?
4. Where do React state and effects enter the court and session screens? How would you test that the map is cleaned up on navigation or an old asynchronous load does not change the new screen?
5. On the Courtboard draft, compare checks at WebSocket upgrade with checks on incoming messages. What would you verify when a connected player withdraws, and where would each test run?

## Debugging exercises

### 1. A published-looking command returns a generic error

In a disposable copy of the client test, feed `runRallyCommand` three responses, a JSON 401, a plain-text 503 and a JSON body containing `success: true` without a record ID. Write down what the user sees and set breakpoints at the branch that handles each case. Give a 90-second explanation distinguishing authentication, service failure and invalid responses.

### 2. Both players see the wrong count

In a disposable copy of the Node attendance tests, create two open sessions and one user with an RSVP in each. Include another user in one of the sessions. Write the expected counts after changing one response and withdrawing the other, then exercise the grouped records and attendance code. Introduce a one-line scoping regression and verify your test detects it.

### 3. The API suite shows no tests after a minute

Start with the API browser config on a local runtime that lacks an authorized DeepSpace dev session. Preserve the original logs and exit code. Determine which process did start, which readiness URL was checked, and whether an app assertion ran. Identify one offline check that still exercises the affected app handler.

## Feature-modification exercise

Add a tentative RSVP count to each list card, leaving confirmed readiness and the existing sort order intact. It should update when a participant changes their response, keep the counts isolated per session, and show sensible output when nobody has responded. Add one deterministic regression test and explain the cost of your implementation when the community list grows.

## Study plan

1. Spend 35 minutes drawing the RSVP request and subscription paths. Explain the three enforcement layers without notes.
2. Spend 35 minutes on the debugging exercises, starting with the API readiness diagnosis. Read the answer key after attempting each problem.
3. Spend 45 minutes implementing the card count in isolation, then run the offline and public checks.
4. Spend 20 minutes rehearsing the two-browser demo and the difference between source, tests and deployed behavior.
5. Spend 15 minutes reviewing the Canvas draft boundary and naming a test you would add with a working authorized runtime.
