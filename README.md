# RallyCircle

RallyCircle helps tennis players organize practice sessions. A host publishes a session and shares a direct link. Players can RSVP, see the group update live, and use the session chat to coordinate.

## Court finder

The Courts tab maps three Pittsburgh tennis venues. Players can optionally sort by straight-line distance using their browser location, open the official Pittsburgh RecDesk booking portal in a new tab, and start a Rally with the selected court already filled in. RecDesk supplies permit availability and completes bookings. RallyCircle does not infer walk-on occupancy or create a reservation.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Court locations are based on the [City of Pittsburgh Courts and Rinks dataset](https://data.wprdc.org/dataset/city-of-pittsburgh-courts).

## DeepSpace features

| Feature | What RallyCircle uses it for |
| --- | --- |
| Authentication | Sign in with GitHub or Google to open the session board. |
| Synced records | Save sessions and RSVPs in SQLite-backed Durable Objects and update both browsers through record subscriptions. |
| Channel messaging | Give each session a separate group conversation using the built-in messaging schemas and subscription hook. |
| Presence | Show how many distinct users are viewing a session. |

The target group size helps players plan. Each account gets one RSVP per session through the database uniqueness rule. Sessions and chat are visible to signed-in members. Host cancellation is a record update. If chat setup fails, the session remains available for RSVPs. Input limits and session-state checks at the UI are distinct from the server's identity, permission and uniqueness checks.

## Local setup

Use Node 24 and npm 11.6 or newer.

```sh
npm ci
npm run validate
npm run lint
node --test tests/rally.test.mjs
```

For a first-time deploy, sign in to DeepSpace and confirm the account with `npx deepspace auth whoami`. Run `npx deepspace app init` to register the app and write its app ID into `wrangler.toml`. Set the GitHub origin before deploying so DeepSpace records GitHub as the source. Commit and push the registered configuration. Keep `.dev.vars`, CLI login state and test credentials out of Git.

```sh
npm run build
npx deepspace test run
npx deepspace test run tests/rally-collab.spec.ts
npx deepspace deploy
```

The collaboration test needs two usable SDK test accounts. Use `npx deepspace test accounts list --usable` to check the local account pool. See the [DeepSpace testing guide](https://docs.deep.space/guides/testing) if it has fewer than two accounts. Set the absolute `DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH` when using system Chromium. By default Playwright runs a local server. To check the production URL, set `RALLYCIRCLE_TEST_URL` to the confirmed deployment and run `npx playwright test -c tests/playwright.config.ts tests/rally-collab.spec.ts`. The test creates a clearly labeled session and cancels it at the end.

## Code map

- `src/pages/(app)/(protected)/rallies.tsx` contains session creation, attendance, chat and link navigation.
- `src/schemas/rally-schema.ts` defines data and access rules.
- `src/server/http-routes.ts` carries the selected session through the platform OAuth redirect.
- `tests/rally-collab.spec.ts` checks mobile invite access, RSVP updates, presence and chat across two accounts.
