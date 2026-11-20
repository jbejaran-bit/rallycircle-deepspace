# RallyCircle practice answer key

## Interview questions

1. The session detail sends a typed `rsvp` command through `runRallyCommand`, which gets a current SDK token and posts JSON. The Hono route verifies identity and passes the verified `userId` to the handler. The handler picks a Durable Object keyed by app and session, and that object checks session state and looks up the current user's RSVP. The storage change is delivered to subscribed browsers and React recalculates attendance. The request body does not assign caller identity.
2. RSVP first can leave a retained historical RSVP when cancellation runs next. Cancellation first closes the session before the RSVP is written. The room serializes these commands per session. Direct self-withdrawal uses the RecordRoom delete path, outside that queue. The stored state and composite uniqueness constraint persist across process restarts. The promise queue itself is in memory. Separate RecordRoom tools do not provide a multi-record transaction.
3. The discriminated command union helps TypeScript callers form the operation and associated fields. The HTTP boundary checks the JSON envelope and the command parser checks fields, actions and status values. The client asks for sign-in on 401, preserves a domain rejection and reports a malformed response or service error clearly.
4. Court selection and browser location are local state. The map effect imports Leaflet dynamically and removes the map on cleanup. It ignores the import completion if disposed. Exercise rapid route exit and re-entry with delayed imports or assert cleanup with controlled library doubles in a component test. For the session list, the active ID comes from the URL while the counts derive from subscribed data.
5. Upgrade authorization protects the first snapshot. Per-write authorization rechecks eligibility that can change after the socket opens. Test initial denial, active access changes, and whether a former participant still receives later updates. Use an offline lookup test for the access policy and an authorized local multi-account test for transport. A successful upgrade authorization test alone does not prove ongoing passive read revocation.

## Debugging exercises

1. A 401 should request sign-in. A non-JSON 503 should produce a retry message. A nominally successful body missing a record ID should report an invalid response. Inspect the HTTP status and structured payload independently.
2. Track one record envelope per user and session. Use separate session IDs and assert both sessions after each transition. An accidental global filter, user-only key, or use of the selected session ID for every card should fail the cross-session test.
3. Playwright starts its Vite web server and polls `/api/auth/ok`. A rejected or unresolved auth call prevents the runner from reaching the test cases. Check the workerd log, auth binding, outbound reachability and CLI identity before changing test assertions. The offline `src/server/http-routes.test.ts` covers invitation redirect logic with an external auth fixture.

## Feature exercise

Use the already grouped records for the current card. Derive both counts from its own group, and retain going-only readiness. Test a group with going and tentative players, an unrelated session, and empty input. Prefer one pass over the group if computing both counts. Explain whether the chosen approach rescans groups when unrelated state changes. The existing tools `npm run validate`, `node --test tests/rally.test.mjs` and `npm run test:public` support the review.
