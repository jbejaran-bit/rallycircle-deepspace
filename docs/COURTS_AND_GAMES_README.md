# Nearby Courts & Find Games — data sources, attribution, rate limits, privacy

## Data sources

### Tennis courts: OpenStreetMap via the Overpass API

- **Endpoint (server-side only):** `POST https://overpass-api.de/api/interpreter`
- **Query:** tennis pitches around a point —
  `[out:json][timeout:25];(nwr["leisure"="pitch"]["sport"~"tennis"](around:<radius_m>,<lat>,<lng>););out center;`
  (`nwr` = nodes, ways, relations; `out center` gives ways/relations a
  representative coordinate.)
- **License:** OpenStreetMap data is © OpenStreetMap contributors, under
  the Open Database License (ODbL). Attribution is shown in the app
  ("Court data © OpenStreetMap contributors") and on every map tile layer
  (the Leaflet attribution already present in the Pittsburgh page).
  See <https://www.openstreetmap.org/copyright>.
- **Coverage limitations (real, not theoretical):** OpenStreetMap is
  volunteer-mapped. Coverage varies hugely by city: a well-mapped city
  may list every public court; a sparse area may list none, or list
  courts with no name, no surface, and no lighting/access tags. The app
  shows "No courts mapped nearby" in that case and offers the Pittsburgh
  fallback — it never fabricates a court. Attributes (surface, lights,
  public access, indoor/outdoor) are shown **only when the OSM tags
  actually carry them** (`surface`, `lit`, `access`, `indoor`).
- **No availability data.** OpenStreetMap does not know whether a court
  is free. The app never claims availability. The only booking links in
  the app are the pre-existing City of Pittsburgh RecDesk links for the
  three Pittsburgh courts, which are labelled as the authority for
  booking. No booking service is scraped.

### Place search: OpenStreetMap Nominatim

- **Endpoint (server-side only):** `GET https://nominatim.openstreetmap.org/search?q=…&format=jsonv2&limit=5&addressdetails=0`
- **Purpose:** turn a manually typed place name ("Boston, MA") into
  coordinates for the court search, when the user declines location
  permission or wants to search elsewhere.
- **Attribution:** Nominatim results are OpenStreetMap data (same ODbL
  attribution as above).

### Fallback: City of Pittsburgh courts

- Three hard-coded courts (Schenley Oval, Highland Park, Frick Park Clay)
  from the City's "Courts and Rinks" dataset, with RecDesk booking links.
  Unchanged from the existing finder. These are the fallback when
  discovery returns nothing or fails.

### Alternative sources considered (not used)

- **Google Places API:** reliable and complete, but requires an API key,
  billing, and a paid service — out of scope (no purchases, no new
  credentials).
- **Self-hosted Overpass/Nominatim:** the right move at scale, but
  operational overhead this app does not need yet; the server-side cache
  keeps public-instance usage far below policy limits.
- **Regional OSM extracts + osmium filtering:** better for bulk/offline
  use; unnecessary for on-demand radius searches.

## Rate limits and how the app stays inside them

### Overpass (main public instance, overpass-api.de)

Published guidance (OpenStreetMap wiki / Overpass user manual, checked
2026-11-20):

- One-off use: <10,000 queries/day and <1 GB downloaded/day is safe.
- Regular app use: divide those numbers by 100 (<100 queries/day,
  <10 MB/day) — usage counts across **all** users of the app.
- Identify the app with a `User-Agent` or `Referer` header.
- Cache and rate-limit calls; on HTTP 429/406, pause 30 s before a new
  request.
- The public instance is frequently overloaded; do not expect high
  reliability.

App behaviour:

- **Server-side only, with a 10-minute TTL cache** (50 entries max,
  coordinates rounded to ~100 m so nearby pans share a hit). Identical
  searches within 10 minutes cost zero upstream calls.
- **Tight queries:** radius-capped (max 50 km), `timeout:25`, results
  capped at 100 courts per search.
- **Identifying headers** on every upstream request
  (`RallyCircle/0.0.1 (…github.com/jbejaran-bit/rallycircle-deepspace)`).
- **No retry on 429/406/503:** the server returns 502 and the UI tells
  the user to wait and try again.
- If usage ever approaches the regular-use guidance, the next step is a
  self-hosted Overpass instance or a commercial provider — not more
  calls to the public one.

### Nominatim (nominatim.openstreetmap.org)

Published usage policy (operations.osmfoundation.org/policies/nominatim,
checked 2026-11-20):

- **Absolute maximum 1 request per second**, summed over the whole
  application and all its users.
- A valid `User-Agent` (or `Referer`) identifying the application —
  stock library user-agents do not comply.
- No autocomplete, no bulk geocoding, cache results.
- Attribution required.

App behaviour:

- **Server-side only, submit-triggered search** (button/Enter), never
  per keystroke.
- **Process-wide pacing:** geocode requests are spaced ≥1.1 s apart
  through a promise chain, plus a 10-minute cache for identical queries.
- **Identifying `User-Agent`** on every request; results capped at 5.

## Privacy

- **Location is opt-in and one-shot.** The browser's geolocation is
  requested only when the user taps "Find courts near me" / "Use my
  location", via `getCurrentPosition` — never `watchPosition`, never on
  page load, never in the background.
- **Coordinates are never saved.** They live in page state for the
  current view. They are sent to RallyCircle's own worker (to run the
  server-side search) and nowhere else. They are never written to a
  DeepSpace record, a cookie, `localStorage`, or a log. (Discovered
  *court* coordinates are stashed in `sessionStorage` for the current tab
  so Find Games can offer distances for them; that is court data, not
  user location, and it disappears when the tab closes.)
- **No participant tracking.** Find Games uses only public court/session
  locations and the viewer's own one-shot location. No other user's
  device coordinates are involved, and no home or private location is
  exposed through discovery.
- **No geocoding of sessions.** A session's text location is never sent
  to Nominatim. Sessions whose court has no known coordinates simply
  have no distance; they are not located by guessing.
- **Third parties see coordinates, not identity.** Overpass receives a
  lat/lng + radius (that is the query) with no user id, no token, and no
  account information.

## How to test locally (branch `feature/nearby-courts-find-games`, base `8fd8c2c`)

Prerequisites: the worktree at `feature/nearby-courts-find-games` on
`8fd8c2c`, `node_modules` symlinked, no deploy, no production account.

```sh
# 1. Full gate (must all pass)
node --test tests/rally.test.mjs tests/courts-games.test.mjs
npx vitest run
npx tsc --noEmit
npx eslint .
npm run build

# 2. Local dev server (needs DeepSpace CLI login; the author cannot do this here)
npx deepspace dev start
# Open /courts → "Courts near me" → allow location (or deny it and use
# place search with "Boston, MA") → radius 10 km → expect a map + list
# sorted by distance, details only where tagged, directions + "Plan a
# Rally here" prefilling /rallies.
# Open /games → filter by area/level/format/date → open a session → RSVP
# through the existing flow.

# 3. Two-account browser tests (needs `deepspace test run`)
npx deepspace test run   # runs tests/courts-games.spec.ts (route-intercepted, no live OSM)
```

### What the automated tests cover (without any live API)

- Haversine distances against known city pairs (Pittsburgh courts,
  NYC–LA, antipodes); invalid coordinates rejected; radius clamping.
- Overpass parsing: nodes/ways/relations, missing coordinates skipped,
  duplicates removed, malformed payloads throw, empty results are `[]`.
- Nominatim parsing: bad coordinates skipped, non-array payload throws.
- Find Games filters: area/level/format/date combinations, cancelled +
  past excluded by default and included on request, distance only where
  coordinates are known, no fabricated distances.
- Server adapter (vitest, mocked `fetch`): 401 without auth, 400 bad
  coordinates, parsed courts + attribution, cache hit on repeat (fetch
  called once), radius clamping, upstream 429 → 502, malformed upstream
  → 502, geocode validation + caching.
- Playwright (not run here): map/list consistency, permission denial →
  manual search, network failure → Pittsburgh fallback, empty states.

### Known unverified items (updated 2026-11-20 evening, after applying)

- The full gate **has now been run** and is green: `node --test` 26/26,
  vitest 59/59, `tsc` clean, eslint clean, `vite build` passes (see
  `IMPLEMENTATION_LOG.md` for exact evidence). The Playwright spec has
  still **not** been run — it needs `deepspace test run` + test accounts
  (`deepspace auth whoami` → `not_authenticated` here).
- Live Overpass/Nominatim behaviour (real response shapes, latency,
  rate-limit responses) has not been observed from this worker: one
  small smoke query to Overpass timed out after 30 s with no response
  (public instance overloaded at that moment) and was not retried. The
  parsers are defensive against malformed payloads and are covered by
  mocked tests, but a live smoke test against the real endpoints
  remains the first thing to do once a signed-in dev server is available.
- Screenshots exist (`docs/courts-desktop.png`, `docs/games-desktop.png`,
  `docs/courts-mobile.png`) but show the sign-in gate, not the feature
  UI — there is no signed-in test user here. They prove the shell
  renders, the Find Games nav item is present, and the courts chunk
  loads. Visual verification of the map, list, and filters still needs
  a signed-in session.
- A signed-in end-to-end call to `/api/courts/nearby` / `/api/geocode`
  (valid JWT → real upstream data) has not been observed. The
  unauthenticated and bad-token paths are runtime-verified (401) against
  a local `wrangler dev` worker; the handler logic itself is covered by
  vitest with a stubbed resolver and mocked fetch.
